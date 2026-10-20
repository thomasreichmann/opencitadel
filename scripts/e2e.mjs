#!/usr/bin/env node
/**
 * End-to-end smoke test: a real citadel-master, a real citadel-host supervising the fake game
 * (packages/host/src/testing/fake-game.ts, which speaks RCON, A2S and the bridge protocol), the
 * welcome plugin and a content package published through the registry, and citadel-browser
 * joining with content sync. Everything runs on 127.0.0.1 in a temp dir; nothing touches a real
 * Deadlock install, and `join --print` never launches Steam.
 *
 * Run after `pnpm build`:  node scripts/e2e.mjs
 */

import { spawn, spawnSync, execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { testing } from '../packages/host/dist/index.js';

const execFileP = promisify(execFile);
const repo = resolve(import.meta.dirname, '..');
const cli = {
  master: join(repo, 'packages/master/dist/cli.js'),
  host: join(repo, 'packages/host/dist/cli.js'),
  pkg: join(repo, 'packages/host/dist/pkg-cli.js'),
  browser: join(repo, 'packages/client/dist/cli.js'),
};

const tmp = mkdtempSync(join(tmpdir(), 'opencitadel-e2e-'));
const children = [];
const cleanups = [];
let failed = false;

function step(name) {
  process.stdout.write(`\n▸ ${name}\n`);
}
function ok(msg) {
  process.stdout.write(`  ✓ ${msg}\n`);
}
function check(cond, msg) {
  if (!cond) throw new Error(`check failed: ${msg}`);
  ok(msg);
}

async function run(script, args, env = {}) {
  const { stdout } = await execFileP(process.execPath, [script, ...args], { env: { ...process.env, ...env }, timeout: 60_000 });
  return stdout;
}

/** Like run, but resolves with the exit code instead of throwing on a non-zero one. */
async function runCode(script, args, env = {}) {
  try {
    return { code: 0, out: await run(script, args, env) };
  } catch (err) {
    return { code: err.code ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

function background(name, script, args, env = {}) {
  const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const out = { text: '' };
  child.stdout.on('data', (d) => (out.text += d));
  child.stderr.on('data', (d) => (out.text += d));
  children.push({ name, child, out });
  return { child, out };
}

async function until(what, fn, timeoutMs = 20_000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
}

/**
 * Stands in for GitHub Actions' OIDC provider: serves a JWKS at `/.well-known/jwks` and the token
 * endpoint a runner calls (ACTIONS_ID_TOKEN_REQUEST_URL), minting RS256 tokens with GitHub's claims.
 */
async function startFakeGitHubOidc(claims) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'e2e-key';
  const requestToken = randomBytes(16).toString('hex');
  const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/.well-known/jwks') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] }));
    }
    if (url.pathname === '/token' && req.headers.authorization === `bearer ${requestToken}`) {
      const now = Math.floor(Date.now() / 1000);
      const payload = { ...claims, iss: issuer, aud: url.searchParams.get('audience'), iat: now, nbf: now - 5, exp: now + 300 };
      const signingInput = `${b64url({ alg: 'RS256', typ: 'JWT', kid })}.${b64url(payload)}`;
      const signature = cryptoSign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url');
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ value: `${signingInput}.${signature}` }));
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const issuer = `http://127.0.0.1:${server.address().port}`;
  return { issuer, requestUrl: `${issuer}/token?api-version=2.0`, requestToken, close: () => server.close() };
}

async function json(url, init) {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${url} → ${res.status} ${JSON.stringify(body)}`);
  return body;
}

try {
  const [masterPort, gamePort, bridgePort] = [await testing.freePort(), await testing.freePort(), await testing.freePort()];
  const master = `http://127.0.0.1:${masterPort}`;

  step('master server');
  const gh = await startFakeGitHubOidc({
    sub: 'repo:example/e2e-arena:environment:release',
    repository: 'example/e2e-arena',
    repository_id: '424242',
    repository_owner: 'example',
    job_workflow_ref: 'example/e2e-arena/.github/workflows/release.yml@refs/tags/v1.1.0',
    workflow_ref: 'example/e2e-arena/.github/workflows/release.yml@refs/tags/v1.1.0',
    ref: 'refs/tags/v1.1.0',
    sha: 'c0ffee0000000000000000000000000000000000',
    run_id: '987654321',
    run_attempt: '1',
    environment: 'release',
    actor: 'e2e-bot',
    event_name: 'push',
  });
  cleanups.push(gh.close);
  background('master', cli.master, ['serve', '--host', '127.0.0.1', '--port', String(masterPort), '--data', join(tmp, 'master'), '--allow-private'], {
    OPENCITADEL_GITHUB_OIDC_ISSUER: gh.issuer,
  });
  await until('master /healthz', async () => (await fetch(`${master}/healthz`)).ok);
  const { apiKey } = await json(`${master}/v1/accounts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'e2e-community' }) });
  check(apiKey?.startsWith('ock_'), 'account created with an ock_ key');
  check((await (await fetch(master)).text()).includes('<html'), 'web browser served at /');

  step('host setup');
  const serverGame = join(tmp, 'server-game');
  const clientGame = join(tmp, 'client-game');
  await testing.createFakeInstall(serverGame);
  await testing.createFakeInstall(clientGame);
  const serverDir = join(tmp, 'server');
  mkdirSync(serverDir);
  await run(cli.host, ['--dir', serverDir, 'init', '--name', 'E2E Arena', '--game-path', serverGame, '--master', master]);
  const configPath = join(serverDir, 'server.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  Object.assign(config, { region: 'eu-west', country: 'DE', tags: ['e2e', 'casual'], publicAddress: `127.0.0.1:${gamePort}` });
  Object.assign(config.game, { wrapper: [process.execPath, testing.FAKE_GAME_SCRIPT, '--fake-bridge'], port: gamePort });
  Object.assign(config.bridge, { port: bridgePort });
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  await run(cli.host, ['--dir', serverDir, 'register', '--api-key', apiKey]);
  check(JSON.parse(readFileSync(configPath, 'utf8')).master.token?.startsWith('ocs_'), 'registered; server token stored');

  step('signing key + signed publish');
  // The author's signing key lives in its own home dir, never the real ~/.opencitadel.
  const authorEnv = { OPENCITADEL_HOME: join(tmp, 'author-home') };
  const keygen = await run(cli.host, ['--dir', serverDir, 'plugin', 'keygen'], authorEnv);
  const keyId = /\b[0-9A-F]{16}\b/.exec(keygen)?.[0];
  check(keyId, `signing key generated (${keyId})`);
  await run(cli.host, ['--dir', serverDir, 'plugin', 'key', 'register', '--api-key', apiKey], authorEnv);
  await run(cli.host, ['--dir', serverDir, 'plugin', 'publish', join(repo, 'plugins/welcome'), '--api-key', apiKey], authorEnv);
  const welcomeInfo = await json(`${master}/v1/plugins/welcome/0.1.0`);
  check(welcomeInfo.signature?.keyId === keyId, 'registry verified and stored the signature');
  const minisig = await (await fetch(`${master}/v1/plugins/welcome/0.1.0/package.minisig`)).text();
  check(minisig.startsWith('untrusted comment:') && minisig.includes('trusted comment: opencitadel package welcome@0.1.0'), '.minisig served with an OpenCitadel trusted comment');

  step('publish + install plugins');
  const contentPkg = join(tmp, 'arena-pkg');
  mkdirSync(join(contentPkg, 'maps'), { recursive: true });
  const vpk = Buffer.concat([Buffer.from([0x34, 0x12, 0xaa, 0x55]), randomBytes(4096)]);
  writeFileSync(join(contentPkg, 'maps', 'e2e_arena.vpk'), vpk);
  writeFileSync(
    join(contentPkg, 'plugin.json'),
    JSON.stringify({ id: 'e2e-arena', name: 'E2E Arena', version: '1.0.0', kind: 'content', maps: ['e2e_arena'], content: [{ file: 'maps/e2e_arena.vpk', client: true }] }),
  );
  await run(cli.host, ['--dir', serverDir, 'plugin', 'publish', contentPkg, '--api-key', apiKey], authorEnv);
  const registry = await json(`${master}/v1/plugins`);
  check(registry.plugins.map((p) => p.id).sort().join() === 'e2e-arena,welcome', 'registry lists welcome + e2e-arena');
  const installWelcome = await run(cli.host, ['--dir', serverDir, 'plugin', 'install', 'welcome']);
  check(installWelcome.includes(`signed by ${keyId}`), 'host verified the signature and pinned the key');
  await run(cli.host, ['--dir', serverDir, 'plugin', 'install', 'e2e-arena']);
  check(existsSync(join(serverGame, 'game/citadel/maps/e2e_arena.vpk')), 'content map installed into the server game');
  check(JSON.parse(readFileSync(join(serverDir, '.opencitadel/trust.json'), 'utf8')).welcome !== undefined, 'trust.json pins welcome');
  check(JSON.parse(readFileSync(configPath, 'utf8')).plugins.welcome.sandbox === true, 'the installed host plugin is sandboxed by default');
  await run(cli.host, ['--dir', serverDir, 'plugin', 'lock']);
  const lock = JSON.parse(readFileSync(join(serverDir, 'plugins.lock.json'), 'utf8'));
  check(JSON.stringify(lock).includes('welcome') && JSON.stringify(lock).includes('e2e-arena'), 'plugins.lock.json records the installed set');

  step('advisories');
  await json(`${master}/v1/plugins/e2e-arena/advisories`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ severity: 'high', title: 'Arena map crashes servers', affected: '<1.0.1', fixedIn: '1.0.1' }),
  });
  const audit = await runCode(cli.host, ['--dir', serverDir, 'plugin', 'audit']);
  check(audit.code === 1 && audit.out.includes('Arena map crashes servers'), 'plugin audit flags the affected version and exits 1');

  step('publishing from CI (trusted publishing)');
  await run(cli.host, ['--dir', serverDir, 'plugin', 'trusted-publisher', 'add', 'e2e-arena', '--repo', 'example/e2e-arena', '--workflow', 'release.yml', '--environment', 'release', '--require', '--api-key', apiKey]);
  ok('owner linked example/e2e-arena release.yml to e2e-arena and required trusted publishing');
  const manifest = JSON.parse(readFileSync(join(contentPkg, 'plugin.json'), 'utf8'));
  writeFileSync(join(contentPkg, 'plugin.json'), JSON.stringify({ ...manifest, version: '1.1.0' }));
  // What the release workflow runs: no API key, the signing key inline as a secret, GitHub's token endpoint in the env.
  const signingKeyJson = readFileSync(join(authorEnv.OPENCITADEL_HOME, 'signing', `${keyId}.key`), 'utf8');
  const ciEnv = {
    OPENCITADEL_MASTER: master,
    OPENCITADEL_HOME: join(tmp, 'ci-home'),
    OPENCITADEL_SIGNING_KEY: signingKeyJson,
    ACTIONS_ID_TOKEN_REQUEST_URL: gh.requestUrl,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: gh.requestToken,
  };
  const ciOut = await run(cli.host, ['--dir', serverDir, 'plugin', 'publish', contentPkg, '--oidc'], ciEnv);
  check(!ciOut.includes(gh.requestToken) && !ciOut.includes('ocp_'), 'CI output never prints tokens');
  const ciVersion = await json(`${master}/v1/plugins/e2e-arena/1.1.0`);
  check(ciVersion.provenance?.repository === 'example/e2e-arena' && ciVersion.provenance.sha.startsWith('c0ffee'), 'the version records verified provenance (repo + commit)');
  check(ciVersion.provenance?.url?.endsWith('/actions/runs/987654321'), 'provenance links to the workflow run');
  check(ciVersion.signature?.keyId === keyId, 'the CI publish is signed with the publisher key');
  writeFileSync(join(contentPkg, 'plugin.json'), JSON.stringify({ ...manifest, version: '1.2.0' }));
  const keyPublish = await runCode(cli.host, ['--dir', serverDir, 'plugin', 'publish', contentPkg, '--api-key', apiKey], authorEnv);
  check(keyPublish.code !== 0 && /trusted publish/i.test(keyPublish.out), 'an API key can no longer publish a plugin that requires trusted publishing');
  writeFileSync(join(contentPkg, 'plugin.json'), JSON.stringify(manifest));

  step('Deadworks FastDL + citadel-pkg');
  const sha16 = createHash('sha256').update(vpk).digest('hex').slice(0, 16);
  const zst = Buffer.from(await (await fetch(`${master}/fastdl/maps/e2e_arena_${sha16}.vpk.zst`)).arrayBuffer());
  check(zst.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd])), 'FastDL serves a zstd frame in the Deadworks layout');
  const zstd = spawnSync('zstd', ['-d', '-c', '-q'], { input: zst, maxBuffer: 64 * 1024 * 1024 });
  if (zstd.status === 0) check(zstd.stdout.equals(vpk), 'the reference zstd decodes it to the original VPK');
  else ok('(zstd CLI not installed; skipped decoding check)');
  const pkgGame = join(tmp, 'deadworks-game');
  await testing.createFakeInstall(pkgGame, { deadworks: true });
  const pkgInstall = await run(cli.pkg, ['--game', pkgGame, '--registry', master, 'install', 'e2e-arena']);
  check(existsSync(join(pkgGame, 'game/citadel/maps/e2e_arena.vpk')), 'citadel-pkg installed the map into a Deadworks server');
  check(pkgInstall.includes(`signed by ${keyId}`), 'citadel-pkg verified the publisher signature');
  const pkgHost = await runCode(cli.pkg, ['--game', pkgGame, '--registry', master, 'install', 'welcome']);
  check(pkgHost.code !== 0, 'citadel-pkg refuses host plugins');
  const withPlugins = JSON.parse(readFileSync(configPath, 'utf8'));
  withPlugins.plugins.welcome.config = { delaySeconds: 0, message: 'Welcome to {server}, {name}!' };
  writeFileSync(configPath, JSON.stringify(withPlugins, null, 2));

  step('host start (fake game + bridge)');
  const host = background('host', cli.host, ['--dir', serverDir, 'start']);
  const listed = await until('server listed with SteamID and a player', async () => {
    const { servers } = await json(`${master}/v1/servers`);
    const s = servers.find((x) => x.name === 'E2E Arena');
    return s?.connect.steamId && s.players > 0 && s.verified ? s : undefined;
  }, 30_000);
  check(/^\[A:1:\d+:\d+\]$/.test(listed.connect.steamId), `listed with SDR SteamID ${listed.connect.steamId}`);
  check(listed.verified, 'verified by the master over A2S');
  check(listed.region === 'eu-west' && listed.tags.includes('e2e'), 'region and tags from server.json');
  const detail = await json(`${master}/v1/servers/${listed.id}`);
  check(detail.plugins.some((p) => p.id === 'welcome') && detail.plugins.some((p) => p.id === 'e2e-arena'), 'detail lists installed plugins');
  const item = detail.content.find((c) => c.name === 'e2e_arena');
  check(item?.kind === 'map' && item.sha256 === createHash('sha256').update(vpk).digest('hex'), 'detail advertises the map with its sha256');
  check(detail.playerList.length > 0 && detail.playerList.every((p) => p.name === ''), 'player names are kept private by default');
  await until('welcome plugin greeting via the bridge', async () => /\[Private to \d+\]: Welcome to E2E Arena, PlayerOne!/.test(host.out.text));
  ok('welcome plugin greeted a player privately through the bridge');
  await until('!help chat command answered', async () => /\[Private to \d+\]: Commands: /.test(host.out.text));
  ok('a player\'s "!help" in chat was answered by the plugin runtime');
  const rconOut = await run(cli.host, ['--dir', serverDir, 'rcon', 'status']);
  check(rconOut.includes('E2E Arena'), 'citadel-host rcon status works against the running server');

  step('citadel-browser');
  const clientEnv = { OPENCITADEL_HOME: join(tmp, 'client-home'), OPENCITADEL_MASTER: master };
  const list = JSON.parse(await run(cli.browser, ['list', '--json'], clientEnv));
  const rows = Array.isArray(list) ? list : list.servers;
  check(rows.some((s) => s.id === listed.id), 'list --json shows the server');
  const info = await run(cli.browser, ['info', listed.id], clientEnv);
  check(info.includes('E2E Arena') && info.includes('e2e_arena'), 'info shows the server and its required content');
  const joined = await run(cli.browser, ['join', listed.id, '--print', '--game', clientGame], clientEnv);
  check(joined.includes('steam://'), 'join --print produced a steam:// URL');
  const installedMap = join(clientGame, 'game/citadel/maps/e2e_arena.vpk');
  check(existsSync(installedMap) && readFileSync(installedMap).equals(vpk), 'content synced into the player game and verified');
  const ui = background('browser-ui', cli.browser, ['ui', '--no-open', '--port', String(await testing.freePort())], clientEnv);
  const uiUrl = await until('local UI url', async () => /http:\/\/(?:127\.0\.0\.1|localhost):\d+/.exec(ui.out.text)?.[0]);
  const localInfo = await json(`${uiUrl}/local/info`);
  check(localInfo.ok === true, 'local UI answers /local/info (local mode)');
  ui.child.kill('SIGTERM');

  step('Deadworks compatibility');
  const dw = await json(`${master}/api/servers/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Deadworks Box', port: 27067, max_players: 12 }) });
  await json(`${master}/api/servers/${dw.id}/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${dw.token}` },
    body: JSON.stringify({ name: 'Deadworks Box', version: 'v0.6.1', port: 27067, player_count: 2, max_players: 12, map: 'dl_streets', game_mode: 'Normal', players: [], mods: [{ name: 'Deathmatch', type: 'plugin', version: '1.0.0' }], content_addons: [], extra_maps: [] }),
  });
  const { servers: all } = await json(`${master}/v1/servers`);
  check(all.some((s) => s.name === 'Deadworks Box' && s.source === 'deadworks'), 'Deadworks heartbeat appears in the native list');
  const dwList = await json(`${master}/api/servers`);
  check(dwList.servers.some((s) => s.name === 'Deadworks Box' && s.raw_address === '127.0.0.1:27067'), 'and in the Deadworks-shaped list');

  step('graceful stop');
  host.child.kill('SIGINT');
  await until('host exit', async () => host.child.exitCode !== null, 20_000);
  const after = await json(`${master}/v1/servers`);
  check(!after.servers.some((s) => s.id === listed.id), 'server delisted after stop');
  process.stdout.write('\nAll end-to-end checks passed.\n');
} catch (err) {
  failed = true;
  process.stderr.write(`\n✖ ${err.message}\n`);
  for (const { name, out } of children) process.stderr.write(`\n--- ${name} output (tail) ---\n${out.text.split('\n').slice(-40).join('\n')}\n`);
} finally {
  for (const { child } of children) if (child.exitCode === null) child.kill('SIGKILL');
  for (const fn of cleanups) fn();
  if (!process.env.KEEP_E2E) rmSync(tmp, { recursive: true, force: true });
  else process.stdout.write(`(kept ${tmp})\n`);
  process.exit(failed ? 1 : 0);
}
