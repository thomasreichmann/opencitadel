import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { generateSigningKey, verifySignature } from '@opencitadel/protocol';
import { parseHostConfig, type HostConfig } from '../config.js';
import { runPackageCli } from './cli.js';
import { FAKE_PUBLISH_TOKEN, makePackage, startFakeRegistry } from './fake-registry.js';
import { findSigningKey, INLINE_KEY_LABEL } from './keys.js';
import { PUBLISH_COMMAND } from './scaffold.js';
import { tempServerDir } from './testing.js';

const hostPkg = (id: string, version: string) => makePackage({ id, name: id, version, kind: 'host', main: 'index.mjs' }, { 'index.mjs': 'export default { setup() {} };' });

/** Stands in for GitHub's ACTIONS_ID_TOKEN_REQUEST_URL endpoint. */
async function fakeGithubTokenEndpoint(value = 'github-oidc-jwt') {
  const requests: Array<{ url: string; authorization?: string }> = [];
  const server: Server = createServer((req, res) => {
    requests.push({ url: req.url!, authorization: req.headers.authorization });
    if (req.headers.authorization !== 'bearer actions-request-token') {
      res.writeHead(403).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ value }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { requestUrl: `${base}/_apis/token?api-version=2.0`, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function cliHarness(serverDir: string, registryUrl: string, env: NodeJS.ProcessEnv) {
  const out: string[] = [];
  const ctx = {
    serverDir,
    config: parseHostConfig({ master: { url: registryUrl } }),
    saveConfig: async (_c: HostConfig) => {},
    print: (l: string) => void out.push(l),
    env,
  };
  return {
    out,
    text: () => out.join('\n'),
    run: async (...argv: string[]) => {
      out.length = 0;
      return runPackageCli(argv, ctx);
    },
  };
}

test('OPENCITADEL_SIGNING_KEY may hold the key itself (CI secrets)', async () => {
  const plain = generateSigningKey();
  const found = await findSigningKey(undefined, { OPENCITADEL_SIGNING_KEY: `\n  ${JSON.stringify(plain.secret)}\n` });
  assert.equal(found?.file, INLINE_KEY_LABEL);
  assert.equal(found?.secret.keyId, plain.publicKey.keyId);

  // A broken inline key fails without echoing what was in the variable.
  const secretish = '{"format":"opencitadel-ed25519-secret-v1","pkcs8":"TOP-SECRET-MATERIAL"';
  await assert.rejects(findSigningKey(undefined, { OPENCITADEL_SIGNING_KEY: secretish }), (err: Error) => {
    assert.match(err.message, /OPENCITADEL_SIGNING_KEY holds JSON but not a usable signing key/);
    assert.ok(!err.message.includes('TOP-SECRET'));
    return true;
  });

  // --key still wins over the variable.
  const tmp = tempServerDir();
  try {
    const other = generateSigningKey();
    writeFileSync(join(tmp.dir, 'other.key'), JSON.stringify(other.secret));
    const chosen = await findSigningKey(join(tmp.dir, 'other.key'), { OPENCITADEL_SIGNING_KEY: JSON.stringify(plain.secret) });
    assert.equal(chosen?.secret.keyId, other.publicKey.keyId);
  } finally {
    await tmp.cleanup();
  }
});

test('publishing from GitHub Actions: OIDC token → publish token → signed upload with provenance', async () => {
  const tmp = tempServerDir();
  const key = generateSigningKey('ci-passphrase');
  const reg = await startFakeRegistry({
    oidcAudience: 'opencitadel-test',
    keys: [{ keyId: key.publicKey.keyId, publicKey: key.publicKey.publicKey, addedAt: '2026-10-01T00:00:00Z' }],
    trustedPublishers: { alpha: [{ id: 'tp1', pluginId: 'alpha', provider: 'github', repository: 'author/alpha-plugin', workflow: 'release.yml', addedAt: '' }] },
  });
  const gh = await fakeGithubTokenEndpoint();
  const env = {
    OPENCITADEL_HOME: join(tmp.dir, 'home'),
    ACTIONS_ID_TOKEN_REQUEST_URL: gh.requestUrl,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'actions-request-token',
    OPENCITADEL_SIGNING_KEY: JSON.stringify(key.secret),
    OPENCITADEL_SIGNING_PASSPHRASE: 'ci-passphrase',
  };
  const cli = cliHarness(tmp.dir, reg.url, env);
  try {
    const tgz = join(tmp.dir, 'alpha-1.0.0.tgz');
    writeFileSync(tgz, hostPkg('alpha', '1.0.0'));
    // No --api-key and no --oidc: inside Actions, trusted publishing is the default.
    assert.equal(await cli.run('publish', tgz), 0, cli.text());

    assert.equal(gh.requests.length, 1);
    assert.equal(gh.requests[0]!.url, '/_apis/token?api-version=2.0&audience=opencitadel-test', 'audience appended to an existing query');
    assert.deepEqual(reg.state.oidcTokens, ['github-oidc-jwt']);
    assert.equal(reg.state.publishedWith['alpha@1.0.0'], 'trusted', 'uploaded with the ocp_ token, not an account key');
    const sig = reg.state.publishedSignatures['alpha@1.0.0'];
    assert.ok(sig, 'still signed');
    assert.equal(verifySignature(readFileSync(tgz), sig!, [key.publicKey]).keyId, key.publicKey.keyId);

    const text = cli.text();
    assert.match(text, /Trusted publishing: .* accepted this workflow for alpha/);
    assert.match(text, new RegExp(`signed by ${key.publicKey.keyId}`));
    assert.match(text, /provenance: author\/alpha-plugin@0123456 \(release\.yml, run 987\) https:\/\/github\.com\/author\/alpha-plugin\/actions\/runs\/987/);
    for (const secret of [FAKE_PUBLISH_TOKEN, 'github-oidc-jwt', 'actions-request-token', 'ci-passphrase']) assert.ok(!text.includes(secret), `never prints ${secret}`);

    // info and an install show where the version was built.
    assert.equal(await cli.run('info', 'alpha'), 0, cli.text());
    assert.match(cli.text(), /1\.0\.0 .* built by author\/alpha-plugin@0123456 \(release\.yml, run 987\)/);
    const server = tempServerDir();
    try {
      const installer = cliHarness(server.dir, reg.url, {});
      assert.equal(await installer.run('install', 'alpha'), 0, installer.text());
      assert.equal(await installer.run('list'), 0, installer.text());
      assert.match(installer.text(), /alpha\s+1\.0\.0\s+host\s+enabled\s+signed [0-9A-F]{16}\s+author\/alpha-plugin@0123456 \(release\.yml\)/);
    } finally {
      await server.cleanup();
    }
  } finally {
    await gh.close();
    await reg.close();
    await tmp.cleanup();
  }
});

test('trusted publishing explains what is wrong', async () => {
  const tmp = tempServerDir();
  const gh = await fakeGithubTokenEndpoint();
  const reg = await startFakeRegistry({ oidcAudience: 'aud', trustedPublishers: { alpha: [{ id: 'tp1', pluginId: 'alpha', provider: 'github', repository: 'a/b', workflow: 'release.yml', addedAt: '' }] } });
  const unsupported = await startFakeRegistry();
  const actions = { ACTIONS_ID_TOKEN_REQUEST_URL: gh.requestUrl, ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'actions-request-token', OPENCITADEL_HOME: join(tmp.dir, 'home') };
  try {
    const tgz = join(tmp.dir, 'alpha-1.0.0.tgz');
    writeFileSync(tgz, hostPkg('alpha', '1.0.0'));
    const beta = join(tmp.dir, 'beta-1.0.0.tgz');
    writeFileSync(beta, hostPkg('beta', '1.0.0'));

    const local = cliHarness(tmp.dir, reg.url, { OPENCITADEL_HOME: join(tmp.dir, 'home') });
    assert.equal(await local.run('publish', tgz), 2, 'no key and not in Actions');
    assert.match(local.text(), /--oidc for trusted publishing/);
    assert.equal(await local.run('publish', tgz, '--oidc'), 1);
    assert.match(local.text(), /ACTIONS_ID_TOKEN_REQUEST_URL .* not set.*id-token: write/);

    assert.equal(await cliHarness(tmp.dir, unsupported.url, actions).run('publish', tgz, '--no-sign'), 1);
    const noOidc = cliHarness(tmp.dir, unsupported.url, actions);
    await noOidc.run('publish', tgz, '--no-sign');
    assert.match(noOidc.text(), /does not support trusted publishing/);

    const wrongToken = await fakeGithubTokenEndpoint('some-other-repo-token');
    try {
      const cli = cliHarness(tmp.dir, reg.url, { ...actions, ACTIONS_ID_TOKEN_REQUEST_URL: wrongToken.requestUrl });
      assert.equal(await cli.run('publish', tgz, '--no-sign'), 1);
      assert.match(cli.text(), /no trusted publisher matches repository author\/other-repo/, 'the registry\'s 401 reason is passed through');
    } finally {
      await wrongToken.close();
    }

    const cli = cliHarness(tmp.dir, reg.url, actions);
    assert.equal(await cli.run('publish', beta, '--no-sign'), 1);
    assert.match(cli.text(), /trusted publisher for alpha, not beta/);
    assert.equal(reg.state.publishedWith['beta@1.0.0'], undefined, 'nothing uploaded');

    const denied = cliHarness(tmp.dir, reg.url, { ...actions, ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'wrong' });
    assert.equal(await denied.run('publish', tgz, '--no-sign'), 1);
    assert.match(denied.text(), /refused the OIDC token request \(HTTP 403\).*id-token: write/);
  } finally {
    await gh.close();
    await reg.close();
    await unsupported.close();
    await tmp.cleanup();
  }
});

test('trusted-publisher add, list, require and remove', async () => {
  const tmp = tempServerDir();
  const reg = await startFakeRegistry();
  const cli = cliHarness(tmp.dir, reg.url, { OPENCITADEL_HOME: join(tmp.dir, 'home') });
  try {
    assert.equal(await cli.run('trusted-publisher', 'add', 'alpha', '--repo', 'author/alpha-plugin', '--workflow', 'release.yml'), 2, 'needs an account key');
    assert.equal(await cli.run('trusted-publisher', 'add', 'alpha', '--repo', 'not a repo', '--workflow', 'release.yml', '--api-key', 'ock_test'), 1);
    assert.match(cli.text(), /repository: has an invalid format/);

    assert.equal(
      await cli.run('trusted-publisher', 'add', 'alpha', '--repo', 'author/alpha-plugin', '--workflow', 'release.yml', '--environment', 'release', '--ref', 'refs/tags/v*', '--require', '--api-key', 'ock_test'),
      0,
      cli.text(),
    );
    assert.deepEqual(
      reg.state.trustedPublishers.alpha!.map(({ repository, workflow, environment, ref }) => ({ repository, workflow, environment, ref })),
      [{ repository: 'author/alpha-plugin', workflow: 'release.yml', environment: 'release', ref: 'refs/tags/v*' }],
    );
    assert.deepEqual(reg.state.settings.alpha, { requireTrustedPublishing: true });
    const added = cli.text();
    assert.match(added, /workflow:\s+\.github\/workflows\/release\.yml/);
    assert.match(added, /id-token: write/);
    assert.match(added, /environment: release/);
    assert.ok(added.includes(PUBLISH_COMMAND), 'prints the publish step');

    assert.equal(await cli.run('trusted-publisher', 'list', 'alpha', '--api-key', 'ock_test'), 0);
    assert.match(cli.text(), /^tp1$/m);
    assert.match(cli.text(), /repository:\s+author\/alpha-plugin/);

    // With trusted publishing required, the account key can no longer publish.
    const tgz = join(tmp.dir, 'alpha-1.0.0.tgz');
    writeFileSync(tgz, hostPkg('alpha', '1.0.0'));
    assert.equal(await cli.run('publish', tgz, '--api-key', 'ock_test', '--no-sign'), 1);
    assert.match(cli.text(), /only accepts versions from its trusted publishers/);

    assert.equal(await cli.run('trusted-publisher', 'require', 'alpha', '--off', '--api-key', 'ock_test'), 0);
    assert.deepEqual(reg.state.settings.alpha, { requireTrustedPublishing: false });
    assert.equal(await cli.run('trusted-publisher', 'remove', 'alpha', 'tp1', '--api-key', 'ock_test'), 0);
    assert.deepEqual(reg.state.trustedPublishers.alpha, []);
    assert.equal(await cli.run('trusted-publisher', 'list', 'alpha', '--api-key', 'ock_test'), 0);
    assert.match(cli.text(), /has no trusted publishers/);
  } finally {
    await reg.close();
    await tmp.cleanup();
  }
});

test('plugin new scaffolds a release workflow for trusted publishing', async () => {
  const tmp = tempServerDir();
  const reg = await startFakeRegistry();
  const cli = cliHarness(tmp.dir, reg.url, {});
  try {
    for (const kind of ['host', 'deadworks', 'content']) {
      const dir = join(tmp.dir, `my-${kind}-plugin`);
      assert.equal(await cli.run('new', dir, '--kind', kind), 0, cli.text());
      assert.match(cli.text(), /\.github\/workflows\/release\.yml/);
      const wf = readFileSync(join(dir, '.github', 'workflows', 'release.yml'), 'utf8');
      assert.match(wf, /tags: \['v\*'\]/);
      assert.match(wf, /environment: release/);
      assert.match(wf, /permissions:\n {6}contents: read\n {6}id-token: write/);
      assert.ok(wf.includes(`run: ${PUBLISH_COMMAND}`));
      assert.match(wf, /OPENCITADEL_SIGNING_KEY: \$\{\{ secrets\.OPENCITADEL_SIGNING_KEY \}\}/);
      assert.match(wf, /OPENCITADEL_MASTER: \$\{\{ vars\.OPENCITADEL_MASTER \}\}/);
      assert.match(wf, new RegExp(`trusted-publisher add my-${kind}-plugin --repo`));
      if (kind === 'host') assert.match(wf, /npm run build --if-present/);
    }
    assert.match(PUBLISH_COMMAND, /^npx --yes --package=@opencitadel\/host@\d+\.\d+ citadel-host plugin publish \. --oidc$/);
  } finally {
    await reg.close();
    await tmp.cleanup();
  }
});
