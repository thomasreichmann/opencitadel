#!/usr/bin/env node
/**
 * citadel-host — run a Deadlock community server, list it on an OpenCitadel master, and manage
 * its plugins. Run `citadel-host help` for usage.
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { findDeadlockInstall, gameLayout, isDeadlockInstall } from '@opencitadel/gamefiles';
import { ACCOUNT_KEY_PREFIX } from '@opencitadel/protocol';
import { checkAdvisories, createPluginHost, installedListing, runPluginCli } from './plugins/index.js';
import { defaultHostConfig, hostPaths, loadHostConfig, parseHostConfig, saveHostConfig, type HostConfig } from './config.js';
import { attachHostConsole } from './console.js';
import { gameinfoStatus, patchGameinfo, resolveGameRoot, unpatchGameinfo } from './game.js';
import { addLogSink, createLogger, fileSink } from './logger.js';
import { RconClient } from './rcon.js';
import { isProcessAlive, readStateFile } from './state.js';
import { Supervisor } from './supervisor.js';
import { HOST_VERSION } from './version.js';

const USAGE = `citadel-host ${HOST_VERSION} — run and list a Deadlock community server

Usage: citadel-host [--dir <server dir>] <command> [options]

Commands:
  init [--name <name>] [--game-path <dir>] [--master <url>] [--force]
                              create server.json in the server directory
  register --api-key <ock_…> [--master <url>] [--force]
                              register this server on a master (stores its id and token)
  start [--quiet]             run the server in the foreground (type "help" at its console)
  status [--json]             show the state of a running server
  rcon <command…>             run one console command over RCON
  gameinfo status|patch|unpatch
                              inspect or change the gameinfo.gi edits hosting needs
  plugin <subcommand> …       search, install and manage plugins (citadel-host plugin help)
  version

The server directory defaults to the current directory.`;

const print = (text: string) => process.stdout.write(text + '\n');

class UsageError extends Error {}

function extractDir(argv: string[]): { dir: string; rest: string[] } {
  const rest: string[] = [];
  let dir = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--dir') {
      const v = argv[++i];
      if (!v) throw new UsageError('--dir needs a path');
      dir = v;
    } else if (a.startsWith('--dir=')) dir = a.slice(6);
    else rest.push(a);
  }
  return { dir: resolve(dir), rest };
}

function isWsl(): boolean {
  try {
    return process.platform === 'linux' && /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

async function cmdInit(dir: string, args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { name: { type: 'string' }, 'game-path': { type: 'string' }, master: { type: 'string' }, force: { type: 'boolean' } },
    strict: true,
  });
  const paths = hostPaths(dir);
  if (existsSync(paths.config) && !values.force) throw new UsageError(`${paths.config} already exists (use --force to overwrite it)`);
  const config = defaultHostConfig();
  if (values.name) config.name = values.name;
  if (values.master) config.master.url = values.master.replace(/\/+$/, '');
  const gamePath = values['game-path'] ?? findDeadlockInstall();
  if (gamePath) {
    if (!isDeadlockInstall(gamePath)) throw new UsageError(`${gamePath} is not a Deadlock install`);
    config.game.path = gamePath;
  }
  // Deadlock has no Linux server build; outside WSL (which runs .exe files natively) use Wine.
  if (process.platform === 'linux' && !isWsl()) config.game.wrapper = ['wine'];
  const validated = parseHostConfig(config);
  await mkdir(paths.stateDir, { recursive: true });
  await saveHostConfig(dir, validated);
  print(`Created ${paths.config}`);
  print(gamePath ? `Deadlock install: ${gamePath}` : 'Deadlock install: not found — set game.path in server.json');
  print(`RCON password generated. Master: ${validated.master.url}`);
  print('\nNext:\n  citadel-host register --api-key ock_… [--master <url>]   # to appear in the server browser\n  citadel-host start');
  return 0;
}

async function cmdRegister(dir: string, args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { 'api-key': { type: 'string' }, master: { type: 'string' }, force: { type: 'boolean' } }, strict: true });
  const config = await loadHostConfig(dir);
  const apiKey = values['api-key'] ?? process.env.OPENCITADEL_API_KEY;
  if (!apiKey) throw new UsageError('register needs --api-key (or OPENCITADEL_API_KEY); create an account on the master to get one');
  if (!apiKey.startsWith(ACCOUNT_KEY_PREFIX)) print(`warning: account keys normally start with "${ACCOUNT_KEY_PREFIX}"`);
  if (config.master.serverId && !values.force) {
    throw new UsageError(`Already registered as ${config.master.serverId}. Use --force to register a new server id.`);
  }
  const url = (values.master ?? config.master.url).replace(/\/+$/, '');
  const res = await fetch(`${url}/v1/servers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ name: config.name }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as { server?: { id?: string }; token?: string; error?: { message?: string } };
  if (!res.ok || !body.server?.id || !body.token) {
    throw new Error(`Registration failed: HTTP ${res.status}${body.error?.message ? ` — ${body.error.message}` : ''}`);
  }
  config.master = { ...config.master, url, serverId: body.server.id, token: body.token, listed: true };
  await saveHostConfig(dir, config);
  print(`Registered "${config.name}" as ${body.server.id} on ${url}. The token is saved in server.json.`);
  return 0;
}

async function cmdStart(dir: string, args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { quiet: { type: 'boolean' } }, strict: true });
  const config = await loadHostConfig(dir);
  const gameRoot = resolveGameRoot(config);
  const layout = gameLayout(gameRoot);
  const exe = config.game.executable === 'deadworks' ? layout.deadworksExe : layout.exe;
  if (!existsSync(exe)) {
    throw new Error(
      config.game.executable === 'deadworks'
        ? `${exe} not found. Install Deadworks into the game folder or set game.executable to "deadlock".`
        : `${exe} not found.`,
    );
  }
  addLogSink(fileSink(join(hostPaths(dir).logsDir, 'host.log')).sink);
  // Warn about installed versions with security advisories; never delays or blocks the start.
  void checkAdvisories(dir, config, createLogger('advisories'));

  const sup = new Supervisor({ serverDir: dir, config, gameRoot, createPluginHost, installedListing });
  if (!values.quiet) sup.on('line', (line) => process.stdout.write(`[game] ${line}\n`));

  return new Promise<number>((resolveExit) => {
    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) {
        print('Forcing exit.');
        process.exit(1);
      }
      shuttingDown = true;
      print('Stopping the server…');
      sup.stop().then(
        () => resolveExit(0),
        (err) => {
          print(`error while stopping: ${(err as Error).message}`);
          resolveExit(1);
        },
      );
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    attachHostConsole(sup, process.stdin, print, shutdown);
    sup.start().catch((err) => {
      print(`error: ${(err as Error).message}`);
      void sup.stop().finally(() => resolveExit(1));
    });
  });
}

async function cmdStatus(dir: string, args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { json: { type: 'boolean' } }, strict: true });
  const st = await readStateFile(hostPaths(dir).stateFile);
  if (!st) {
    print('No state yet: the server has not been started from this directory.');
    return 1;
  }
  const alive = isProcessAlive(st.pid);
  if (values.json) {
    print(JSON.stringify({ ...st, hostAlive: alive }, null, 2));
    return alive ? 0 : 1;
  }
  const humans = st.players.filter((p) => !p.bot);
  print(`${st.hostname}`);
  print(`  phase:   ${alive ? st.phase : `not running (last state ${st.phase} at ${st.updatedAt})`}`);
  print(`  map:     ${st.map ?? '-'}`);
  print(`  steamid: ${st.steamId ?? '-'}${st.steamId ? `   (connect ${st.steamId})` : ''}`);
  if (st.address) print(`  address: ${st.address}`);
  print(`  players: ${humans.length}/${st.maxPlayers}${humans.length ? ' — ' + humans.map((p) => p.name).join(', ') : ''}`);
  print(`  sources: ${Object.entries(st.sources).filter(([, on]) => on).map(([k]) => k).join(', ') || 'none'}`);
  return alive ? 0 : 1;
}

async function cmdRcon(dir: string, args: string[]): Promise<number> {
  const command = args.join(' ').trim();
  if (!command) throw new UsageError('usage: citadel-host rcon <command…>');
  const config = await loadHostConfig(dir);
  if (!config.rcon.enabled || !config.rcon.password) throw new UsageError('RCON is disabled in server.json');
  const client = new RconClient({ host: '127.0.0.1', port: config.game.port, password: config.rcon.password });
  client.on('error', () => {});
  try {
    await client.connect();
    const out = await client.command(command);
    if (out.trim()) print(out.trimEnd());
    return 0;
  } finally {
    client.close();
  }
}

async function configOrDefault(dir: string): Promise<HostConfig> {
  return existsSync(hostPaths(dir).config) ? loadHostConfig(dir) : parseHostConfig({});
}

async function cmdGameinfo(dir: string, args: string[]): Promise<number> {
  const [sub = 'status'] = args;
  const layout = gameLayout(resolveGameRoot(await configOrDefault(dir)));
  switch (sub) {
    case 'status': {
      const s = await gameinfoStatus(layout);
      print(layout.gameinfo);
      print(`  dedicated hosting edits: ${s.dedicatedReady ? 'present' : `missing (${s.dedicatedMissing.join(', ')})`}`);
      print(`  server content path:     ${s.serverContentMounted ? 'mounted' : 'not mounted'}`);
      print(`  player content path:     ${s.contentMounted ? 'mounted (citadel-browser)' : 'not mounted'}`);
      print(`  lines edited by OpenCitadel: ${s.ourEdits}`);
      return s.dedicatedReady ? 0 : 1;
    }
    case 'patch':
      print((await patchGameinfo(layout)) ? `Patched ${layout.gameinfo} (backup: gameinfo.gi.opencitadel.bak).` : 'Already patched.');
      return 0;
    case 'unpatch':
      print((await unpatchGameinfo(layout)) ? `Removed OpenCitadel edits from ${layout.gameinfo}.` : 'Nothing to remove.');
      return 0;
    default:
      throw new UsageError('usage: citadel-host gameinfo status|patch|unpatch');
  }
}

async function cmdPlugin(dir: string, args: string[]): Promise<number> {
  // Authoring commands (new, pack, sign, publish, trusted-publisher) run from a plugin repo or
  // CI checkout that has no server.json; server-side commands still find it when present.
  const config = await configOrDefault(dir);
  let gameRoot: string | undefined;
  try {
    gameRoot = resolveGameRoot(config);
  } catch {
    gameRoot = undefined;
  }
  return runPluginCli(args, { serverDir: dir, config, saveConfig: (c) => saveHostConfig(dir, c), gameRoot, print });
}

async function main(argv: string[]): Promise<number> {
  const { dir, rest } = extractDir(argv);
  const [cmd, ...args] = rest;
  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      print(USAGE);
      return 0;
    case 'version':
    case '--version':
      print(HOST_VERSION);
      return 0;
    case 'init':
      return cmdInit(dir, args);
    case 'register':
      return cmdRegister(dir, args);
    case 'start':
      return cmdStart(dir, args);
    case 'status':
      return cmdStatus(dir, args);
    case 'rcon':
      return cmdRcon(dir, args);
    case 'gameinfo':
      return cmdGameinfo(dir, args);
    case 'plugin':
    case 'plugins':
      return cmdPlugin(dir, args);
    default:
      throw new UsageError(`Unknown command "${cmd}". Run citadel-host help.`);
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    if (err instanceof UsageError || (err as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) process.exit(2);
    process.exit(1);
  },
);
