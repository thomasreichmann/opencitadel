import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePublicKey, parseSecretKeyFile, verifySignature } from '@opencitadel/protocol';
import { parseHostConfig, type HostConfig } from '../config.js';
import { runPackageCli } from './cli.js';
import { makePackage, startFakeRegistry } from './fake-registry.js';
import { createSigningKey, findSigningKey } from './keys.js';
import { tempServerDir } from './testing.js';

const hostPkg = (id: string, version: string) => makePackage({ id, name: id, version, kind: 'host', main: 'index.mjs' }, { 'index.mjs': 'export default { setup() {} };' });

test('keygen writes a 0600 key and a .pub; discovery order and ambiguity', async () => {
  const tmp = tempServerDir();
  const env = { OPENCITADEL_HOME: join(tmp.dir, 'home') };
  try {
    assert.equal(await findSigningKey(undefined, env), undefined);
    const a = await createSigningKey(undefined, env);
    assert.equal(statSync(a.keyFile).mode & 0o777, 0o600);
    assert.equal(parsePublicKey(readFileSync(a.publicKeyFile, 'utf8')).keyId, a.publicKey.keyId);
    assert.equal((await findSigningKey(undefined, env))!.secret.keyId, a.publicKey.keyId);
    await assert.rejects(createSigningKey(a.keyFile, env), /already exists/);

    const b = await createSigningKey(undefined, env);
    await assert.rejects(findSigningKey(undefined, env), /Several signing keys/);
    assert.equal((await findSigningKey(b.keyFile, env))!.secret.keyId, b.publicKey.keyId, '--key wins');
    assert.equal((await findSigningKey(undefined, { ...env, OPENCITADEL_SIGNING_KEY: a.keyFile }))!.secret.keyId, a.publicKey.keyId, 'then the env var');

    const locked = await createSigningKey(join(tmp.dir, 'locked.key'), { ...env, OPENCITADEL_SIGNING_PASSPHRASE: 'pw' });
    assert.equal(locked.encrypted, true);
    assert.equal(parseSecretKeyFile(readFileSync(locked.keyFile, 'utf8')).encrypted, true);
  } finally {
    await tmp.cleanup();
  }
});

test('CLI: keygen, key register, sign, and signed publish the registry can verify', async () => {
  const tmp = tempServerDir();
  const reg = await startFakeRegistry();
  const env = { OPENCITADEL_HOME: join(tmp.dir, 'home') };
  const out: string[] = [];
  const ctx = {
    serverDir: tmp.dir,
    config: parseHostConfig({ master: { url: reg.url } }),
    saveConfig: async (_c: HostConfig) => {},
    print: (l: string) => void out.push(l),
    env,
  };
  const run = async (...argv: string[]) => {
    out.length = 0;
    return runPackageCli(argv, ctx);
  };
  try {
    // Without a key: publish goes out unsigned, with a warning.
    const tgz = join(tmp.dir, 'alpha-1.0.0.tgz');
    writeFileSync(tgz, hostPkg('alpha', '1.0.0'));
    assert.equal(await run('publish', tgz, '--api-key', 'ock_test'), 0);
    assert.match(out.join('\n'), /no signing key found, publishing UNSIGNED/);
    assert.equal(reg.state.publishedSignatures['alpha@1.0.0'], undefined);

    assert.equal(await run('keygen'), 0);
    const keyId = /Created signing key ([0-9A-F]{16})/.exec(out[0]!)![1]!;
    assert.match(out.join('\n'), /not encrypted/);

    assert.equal(await run('key', 'register'), 2, 'needs an api key');
    assert.equal(await run('key', 'register', '--api-key', 'ock_test', '--label', 'laptop'), 0);
    assert.deepEqual(reg.state.keys.map((k) => [k.keyId, k.label]), [[keyId, 'laptop']]);

    assert.equal(await run('sign', tgz), 0);
    const sig = readFileSync(`${tgz}.minisig`, 'utf8');
    const verified = verifySignature(readFileSync(tgz), sig, [reg.state.keys[0]!.publicKey]);
    assert.match(verified.trustedComment, /^opencitadel package alpha@1\.0\.0 sha256:[0-9a-f]{64} timestamp:\d+$/);

    const tgz2 = join(tmp.dir, 'alpha-1.1.0.tgz');
    writeFileSync(tgz2, hostPkg('alpha', '1.1.0'));
    assert.equal(await run('publish', tgz2, '--api-key', 'ock_test'), 0);
    assert.match(out.join('\n'), new RegExp(`signed by ${keyId}`));
    assert.ok(reg.state.publishedSignatures['alpha@1.1.0'], 'signature header sent and accepted');

    const tgz3 = join(tmp.dir, 'alpha-1.2.0.tgz');
    writeFileSync(tgz3, hostPkg('alpha', '1.2.0'));
    assert.equal(await run('publish', tgz3, '--api-key', 'ock_test', '--no-sign'), 0);
    assert.equal(reg.state.publishedSignatures['alpha@1.2.0'], undefined);

    // The published, signed version installs and pins on a fresh server.
    const server = tempServerDir();
    try {
      const install = await runPackageCli(['install', 'alpha@1.1.0'], { ...ctx, serverDir: server.dir, print: (l) => void out.push(l) });
      assert.equal(install, 0);
      assert.match(out.join('\n'), new RegExp(`signed by ${keyId} \\(pinned on first use\\)`));
      assert.match(out.join('\n'), /WebAssembly sandbox/);
    } finally {
      await server.cleanup();
    }
  } finally {
    await reg.close();
    await tmp.cleanup();
  }
});
