import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatPublicKeyFile, generateSigningKey, signData, type SecretKeyFile, type SigningKeyInfo } from '@opencitadel/protocol';
import { parseHostConfig } from '../config.js';
import { installFromFile, installFromRegistry, sha256, type InstallOptions } from './install.js';
import { readInstalled } from './installed.js';
import { makePackage, startFakeRegistry } from './fake-registry.js';
import { signPackage } from './pack.js';
import { RegistryClient } from './registry.js';
import { tempServerDir } from './testing.js';
import { readTrust } from './trust.js';
import { readManifest } from './install.js';
import { unpackTarGz } from '@opencitadel/protocol';

const hostPkg = (id: string, version: string, extra: Record<string, unknown> = {}) =>
  makePackage({ id, name: id, version, kind: 'host', main: 'index.mjs', ...extra }, { 'index.mjs': `export default { setup() {} }; // ${id}@${version}` });

const sign = (archive: Buffer, secret: SecretKeyFile) => signPackage(archive, readManifest(unpackTarGz(archive)), secret);

const keyInfo = (k: ReturnType<typeof generateSigningKey>, revokedAt?: string): SigningKeyInfo => ({
  keyId: k.publicKey.keyId,
  publicKey: k.publicKey.publicKey,
  addedAt: '2026-10-01T00:00:00Z',
  ...(revokedAt ? { revokedAt } : {}),
});

function options(dir: string, url: string, extra: Partial<InstallOptions> = {}): InstallOptions {
  return { serverDir: dir, registry: new RegistryClient(url), security: parseHostConfig({}).security, ...extra };
}

test('signed install pins the key; tampered, unknown and revoked signatures are refused', async () => {
  const tmp = tempServerDir();
  const k1 = generateSigningKey();
  const stranger = generateSigningKey();
  const revoked = generateSigningKey();
  const good = hostPkg('alpha', '1.0.0');
  const tampered = hostPkg('beta', '1.0.0');
  const reg = await startFakeRegistry({
    keys: [keyInfo(k1), keyInfo(revoked, '2026-10-10T00:00:00Z')],
    packages: {
      alpha: { '1.0.0': { archive: good, signature: sign(good, k1.secret) } },
      // A valid signature, but over different bytes than the archive served.
      beta: { '1.0.0': { archive: tampered, signature: sign(hostPkg('beta', '1.0.0', { description: 'original' }), k1.secret) } },
      gamma: { '1.0.0': { archive: hostPkg('gamma', '1.0.0'), signature: sign(hostPkg('gamma', '1.0.0'), stranger.secret) } },
      delta: { '1.0.0': { archive: hostPkg('delta', '1.0.0'), signature: sign(hostPkg('delta', '1.0.0'), revoked.secret) } },
    },
  });
  try {
    const [outcome] = await installFromRegistry('alpha', options(tmp.dir, reg.url));
    assert.equal(outcome!.trust!.signed, true);
    assert.equal(outcome!.trust!.status, `signed by ${k1.publicKey.keyId} (pinned on first use)`);
    assert.equal((await readInstalled(tmp.dir)).alpha!.signature!.keyId, k1.publicKey.keyId);
    const trust = await readTrust(tmp.dir);
    assert.deepEqual(trust.alpha!.keys.map((k) => [k.keyId, k.publicKey, k.how]), [[k1.publicKey.keyId, k1.publicKey.publicKey, 'first-use']]);

    await assert.rejects(installFromRegistry('beta', options(tmp.dir, reg.url)), /does not match the package contents/);
    await assert.rejects(installFromRegistry('gamma', options(tmp.dir, reg.url)), /no public key for it is known/);
    await assert.rejects(installFromRegistry('delta', options(tmp.dir, reg.url)), /publisher revoked/);
    const index = await readInstalled(tmp.dir);
    assert.deepEqual(Object.keys(index), ['alpha']);
    assert.ok(!existsSync(join(tmp.dir, '.opencitadel', 'plugins', 'beta')));
  } finally {
    await reg.close();
    await tmp.cleanup();
  }
});

test('key change is refused until --accept-new-key; signed→unsigned needs --allow-unsigned', async () => {
  const tmp = tempServerDir();
  const k1 = generateSigningKey();
  const k2 = generateSigningKey();
  const v1 = hostPkg('alpha', '1.0.0');
  const v2 = hostPkg('alpha', '2.0.0');
  const v3 = hostPkg('alpha', '3.0.0');
  const reg = await startFakeRegistry({
    keys: [keyInfo(k1), keyInfo(k2)],
    packages: { alpha: { '1.0.0': { archive: v1, signature: sign(v1, k1.secret) }, '2.0.0': { archive: v2, signature: sign(v2, k2.secret) }, '3.0.0': { archive: v3 } } },
  });
  try {
    await installFromRegistry('alpha@1.0.0', options(tmp.dir, reg.url));
    await assert.rejects(installFromRegistry('alpha@2.0.0', options(tmp.dir, reg.url)), new RegExp(`now signed by ${k2.publicKey.keyId}, but it is pinned to ${k1.publicKey.keyId}`));
    assert.equal((await readInstalled(tmp.dir)).alpha!.version, '1.0.0');

    const [accepted] = await installFromRegistry('alpha@2.0.0', options(tmp.dir, reg.url, { acceptNewKey: true }));
    assert.match(accepted!.trust!.status, /new key accepted/);
    assert.deepEqual((await readTrust(tmp.dir)).alpha!.keys.map((k) => k.keyId), [k2.publicKey.keyId], 're-pinned to the new key only');

    await assert.rejects(installFromRegistry('alpha@3.0.0', options(tmp.dir, reg.url)), /was signed by .* before, but this version is not signed/);
    const [unsigned] = await installFromRegistry('alpha@3.0.0', options(tmp.dir, reg.url, { allowUnsigned: true }));
    assert.equal(unsigned!.trust!.signed, false);
    assert.equal((await readInstalled(tmp.dir)).alpha!.signature, undefined);
    assert.deepEqual((await readTrust(tmp.dir)).alpha!.keys.map((k) => k.keyId), [k2.publicKey.keyId], 'pins survive an unsigned install');
  } finally {
    await reg.close();
    await tmp.cleanup();
  }
});

test('a compromised registry cannot swap the key behind a pinned key id', async () => {
  const tmp = tempServerDir();
  const real = generateSigningKey();
  const v1 = hostPkg('alpha', '1.0.0');
  const reg = await startFakeRegistry({ keys: [keyInfo(real)], packages: { alpha: { '1.0.0': { archive: v1, signature: sign(v1, real.secret) } } } });
  try {
    await installFromRegistry('alpha', options(tmp.dir, reg.url));
    // The attacker mints a key that claims the same key id and replaces the publisher's key.
    const evil = generateSigningKey();
    const forged = { ...evil.secret, keyId: real.publicKey.keyId };
    const raw = Buffer.from(evil.publicKey.publicKey, 'base64');
    Buffer.from(real.publicKey.publicKey, 'base64').copy(raw, 2, 2, 10);
    forged.publicKey = raw.toString('base64');
    const v2 = hostPkg('alpha', '2.0.0');
    reg.state.keys = [{ keyId: real.publicKey.keyId, publicKey: forged.publicKey, addedAt: '2026-10-02T00:00:00Z' }];
    reg.state.packages.alpha!['2.0.0'] = { archive: v2, signature: sign(v2, forged) };
    await assert.rejects(installFromRegistry('alpha@2.0.0', options(tmp.dir, reg.url)), /does not match the package contents/);
    assert.equal((await readInstalled(tmp.dir)).alpha!.version, '1.0.0');
  } finally {
    await reg.close();
    await tmp.cleanup();
  }
});

test('requireSignatures and trustedKeys policies, including dependencies', async () => {
  const tmp = tempServerDir();
  const k1 = generateSigningKey();
  const k2 = generateSigningKey();
  const lib = hostPkg('lib', '1.0.0');
  const app = hostPkg('app', '1.0.0', { dependencies: { lib: '^1.0.0' } });
  const other = hostPkg('other', '1.0.0');
  const reg = await startFakeRegistry({
    keys: [keyInfo(k1), keyInfo(k2)],
    packages: { lib: { '1.0.0': { archive: lib } }, app: { '1.0.0': { archive: app, signature: sign(app, k1.secret) } }, other: { '1.0.0': { archive: other, signature: sign(other, k1.secret) } } },
  });
  try {
    const strict = parseHostConfig({ security: { requireSignatures: true } }).security;
    await assert.rejects(installFromRegistry('app', options(tmp.dir, reg.url, { security: strict })), /lib is not signed, and security.requireSignatures is on/);
    assert.deepEqual(await readInstalled(tmp.dir), {}, 'nothing installed when a dependency fails verification');

    const anyK1 = parseHostConfig({ security: { trustedKeys: { '*': [k1.publicKey.keyId] } } }).security;
    await assert.rejects(installFromRegistry('app', options(tmp.dir, reg.url, { security: anyK1 })), /lib is not signed, but security.trustedKeys lists keys/);
    const [libOutcome, appOutcome] = await installFromRegistry('app', options(tmp.dir, reg.url, { security: anyK1, allowUnsigned: true }));
    assert.equal(libOutcome!.trust!.signed, false);
    assert.equal(appOutcome!.trust!.status, `signed by ${k1.publicKey.keyId} (trusted key from server config)`);

    const onlyK2 = parseHostConfig({ security: { trustedKeys: { other: [k2.publicKey.keyId] } } }).security;
    await assert.rejects(installFromRegistry('other', options(tmp.dir, reg.url, { security: onlyK2 })), /security.trustedKeys does not allow/);
  } finally {
    await reg.close();
    await tmp.cleanup();
  }
});

test('local .tgz with a sibling .minisig verifies against --key-file or the publisher', async () => {
  const tmp = tempServerDir();
  const k = generateSigningKey();
  const archive = hostPkg('local-one', '1.0.0');
  const file = join(tmp.dir, 'local-one-1.0.0.tgz');
  writeFileSync(file, archive);
  writeFileSync(`${file}.minisig`, signData(archive, k.secret, { trustedComment: `opencitadel package local-one@1.0.0 sha256:${sha256(archive)}` }));
  try {
    await assert.rejects(installFromFile(file, { serverDir: tmp.dir }), /no public key for it is known/);
    const [outcome] = await installFromFile(file, { serverDir: tmp.dir, keyFiles: [k.publicKey] });
    assert.equal(outcome!.trust!.keyId, k.publicKey.keyId);
    // Corrupt the archive: the signature no longer matches.
    const other = hostPkg('local-one', '1.0.1');
    writeFileSync(file, other);
    await assert.rejects(installFromFile(file, { serverDir: tmp.dir, keyFiles: [k.publicKey] }), /does not match/);
    // A .pub file on disk works the same through formatPublicKeyFile/readPublicKey (CLI path).
    assert.match(formatPublicKeyFile(k.publicKey), /^untrusted comment: minisign public key /);
  } finally {
    await tmp.cleanup();
  }
});
