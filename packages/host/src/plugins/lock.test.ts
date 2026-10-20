import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateSigningKey, unpackTarGz, type Advisory } from '@opencitadel/protocol';
import { parseHostConfig, type HostConfig } from '../config.js';
import { checkAdvisories } from './audit.js';
import { runPackageCli } from './cli.js';
import { makePackage, startFakeRegistry } from './fake-registry.js';
import { readManifest } from './install.js';
import { readInstalled } from './installed.js';
import { signPackage } from './pack.js';
import { fakeServices, tempServerDir } from './testing.js';

const hostPkg = (id: string, version: string, extra: Record<string, unknown> = {}) =>
  makePackage({ id, name: id, version, kind: 'host', main: 'index.mjs', ...extra }, { 'index.mjs': `export default { setup() {} }; // ${version}` });

const advisory = (pluginId: string, severity: Advisory['severity'], affected: string, extra: Partial<Advisory> = {}): Advisory => ({
  id: `${pluginId}-${severity}-${affected}`,
  pluginId,
  severity,
  title: `${severity} problem`,
  description: '',
  affected,
  publishedAt: '2026-10-10T00:00:00Z',
  withdrawn: false,
  ...extra,
});

function cli(dir: string, url: string) {
  const out: string[] = [];
  const ctx = { serverDir: dir, config: parseHostConfig({ master: { url } }), saveConfig: async (_c: HostConfig) => {}, print: (l: string) => void out.push(l), env: {} };
  return {
    out,
    run: async (...argv: string[]) => {
      out.length = 0;
      return runPackageCli(argv, ctx);
    },
  };
}

test('audit: matches affected versions, ignores withdrawn ones, exits 1 for high/critical', async () => {
  const tmp = tempServerDir();
  const reg = await startFakeRegistry({
    packages: { alpha: { '1.0.0': { archive: hostPkg('alpha', '1.0.0') } }, beta: { '2.0.0': { archive: hostPkg('beta', '2.0.0') } } },
    advisories: {
      alpha: [advisory('alpha', 'low', '<1.1.0', { fixedIn: '1.1.0' }), advisory('alpha', 'critical', '<1.0.0')],
      beta: [advisory('beta', 'high', '>=2.0.0 <2.1.0', { withdrawn: true })],
    },
  });
  const { run, out } = cli(tmp.dir, reg.url);
  try {
    assert.equal(await run('install', 'alpha'), 0);
    assert.equal(await run('install', 'beta'), 0);
    assert.equal(await run('audit'), 0, 'only a low advisory applies');
    assert.deepEqual(out, ['LOW alpha@1.0.0: low problem (affects <1.1.0). Fixed in 1.1.0: `citadel-host plugin install alpha@1.1.0`.']);

    reg.state.advisories.beta![0]!.withdrawn = false;
    assert.equal(await run('audit'), 1);
    assert.match(out[0]!, /^HIGH beta@2\.0\.0: high problem/);

    const svc = fakeServices(tmp.dir);
    const matches = await checkAdvisories(tmp.dir, parseHostConfig({ master: { url: reg.url } }), svc.logger('plugins'));
    assert.equal(matches.length, 2);
    assert.equal(svc.logged('Security advisory: HIGH beta', 'error').length, 1);
    assert.equal(svc.logged('Security advisory: LOW alpha', 'warn').length, 1);
  } finally {
    await reg.close();
  }
  // Registry gone: start-up check must neither throw nor warn loudly.
  const svc = fakeServices(tmp.dir);
  assert.deepEqual(await checkAdvisories(tmp.dir, parseHostConfig({ master: { url: 'http://127.0.0.1:9' } }), svc.logger('plugins')), []);
  assert.equal(svc.logged('', 'warn').length, 0);
  await tmp.cleanup();
});

test('lock and sync reproduce the exact set, and refuse checksum or key mismatches', async () => {
  const tmp = tempServerDir();
  const fresh = tempServerDir();
  const k = generateSigningKey();
  const sign = (a: Buffer) => signPackage(a, readManifest(unpackTarGz(a)), k.secret);
  const lib1 = hostPkg('lib', '1.0.0');
  const lib2 = hostPkg('lib', '1.5.0');
  const app = hostPkg('app', '1.0.0', { dependencies: { lib: '^1.0.0' } });
  const reg = await startFakeRegistry({
    keys: [{ keyId: k.publicKey.keyId, publicKey: k.publicKey.publicKey, addedAt: '2026-10-01T00:00:00Z' }],
    packages: { lib: { '1.0.0': { archive: lib1, signature: sign(lib1) } }, app: { '1.0.0': { archive: app, signature: sign(app) } } },
  });
  const a = cli(tmp.dir, reg.url);
  const b = cli(fresh.dir, reg.url);
  try {
    assert.equal(await a.run('install', 'app'), 0);
    assert.equal(await a.run('lock'), 0);
    const lockFile = join(tmp.dir, 'plugins.lock.json');
    const lock = JSON.parse(readFileSync(lockFile, 'utf8'));
    assert.deepEqual(Object.keys(lock.packages), ['app', 'lib']);
    assert.equal(lock.packages.lib.version, '1.0.0');
    assert.equal(lock.packages.lib.keyId, k.publicKey.keyId);
    assert.equal(lock.packages.lib.publicKey, k.publicKey.publicKey);

    // A newer lib appears; sync on a fresh server must still install exactly 1.0.0.
    reg.state.packages.lib!['1.5.0'] = { archive: lib2, signature: sign(lib2) };
    assert.equal(await b.run('install', 'lib@1.5.0'), 0);
    assert.equal(await b.run('sync', '--lockfile', lockFile), 0, b.out.join('\n'));
    let index = await readInstalled(fresh.dir);
    assert.deepEqual(Object.fromEntries(Object.entries(index).map(([id, p]) => [id, p.version])), { app: '1.0.0', lib: '1.0.0' });
    assert.equal(await b.run('sync', '--lockfile', lockFile), 0);
    assert.match(b.out.join('\n'), /Unchanged: app, lib/);

    // Extras are removed.
    reg.state.packages.extra = { '1.0.0': { archive: hostPkg('extra', '1.0.0') } };
    assert.equal(await b.run('install', 'extra'), 0);
    assert.equal(await b.run('sync', '--lockfile', lockFile), 0);
    assert.match(b.out.join('\n'), /Removed \(not in the lockfile\): extra/);

    // Tampered lockfile: wrong checksum, then wrong key.
    const bad = structuredClone(lock);
    bad.packages.lib.sha256 = 'a'.repeat(64);
    writeFileSync(join(tmp.dir, 'bad.lock.json'), JSON.stringify(bad));
    const third = tempServerDir();
    const c = cli(third.dir, reg.url);
    assert.equal(await c.run('sync', '--lockfile', join(tmp.dir, 'bad.lock.json')), 1);
    assert.match(c.out.join('\n'), /lockfile pins a{64}/);
    const wrongKey = structuredClone(lock);
    wrongKey.packages.lib.keyId = '0123456789ABCDEF';
    delete wrongKey.packages.lib.publicKey;
    writeFileSync(join(tmp.dir, 'key.lock.json'), JSON.stringify(wrongKey));
    assert.equal(await c.run('sync', '--lockfile', join(tmp.dir, 'key.lock.json')), 1);
    assert.match(c.out.join('\n'), /expects lib@1\.0\.0 signed by 0123456789ABCDEF/);
    assert.deepEqual(await readInstalled(third.dir), {}, 'a failed sync changes nothing');
    await third.cleanup();
  } finally {
    await reg.close();
    await tmp.cleanup();
    await fresh.cleanup();
  }
});
