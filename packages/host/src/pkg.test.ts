import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSigningKey, unpackTarGz } from '@opencitadel/protocol';
import { makePackage, startFakeRegistry } from './plugins/fake-registry.js';
import { readManifest } from './plugins/install.js';
import { signPackage } from './plugins/pack.js';
import { pkgStateDir, runPkg } from './pkg.js';
import { createFakeInstall } from './testing/fake-install.js';

const VPK = (fill: number) => {
  const b = Buffer.alloc(64, fill);
  b.writeUInt32LE(0x55aa1234, 0);
  return b;
};

test('citadel-pkg installs deadworks and content packages into a Deadlock install and refuses host plugins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oc-pkg-'));
  const gameRoot = join(root, 'Deadlock');
  await createFakeInstall(gameRoot);
  const k = generateSigningKey();
  const dw = makePackage({ id: 'deathmatch', name: 'Deathmatch', version: '1.2.0', kind: 'deadworks', assemblies: ['Deathmatch.dll'] }, { 'Deathmatch.dll': 'MZ' });
  const map = makePackage({ id: 'arena', name: 'Arena', version: '0.1.0', kind: 'content', maps: ['arena'], content: [{ file: 'maps/arena.vpk', client: true }, { file: 'pak01_dir.vpk' }] }, { 'maps/arena.vpk': VPK(1), 'pak01_dir.vpk': VPK(2) });
  const host = makePackage({ id: 'welcome', name: 'Welcome', version: '0.1.0', kind: 'host', main: 'index.mjs' }, { 'index.mjs': 'export default { setup() {} };' });
  const reg = await startFakeRegistry({
    keys: [{ keyId: k.publicKey.keyId, publicKey: k.publicKey.publicKey, addedAt: '2026-10-01T00:00:00Z' }],
    packages: {
      deathmatch: { '1.2.0': { archive: dw, signature: signPackage(dw, readManifest(unpackTarGz(dw)), k.secret) } },
      arena: { '0.1.0': { archive: map } },
      welcome: { '0.1.0': { archive: host } },
    },
  });
  const out: string[] = [];
  const pkg = (...argv: string[]) => {
    out.length = 0;
    return runPkg(['--game', gameRoot, '--registry', reg.url, ...argv], (l) => void out.push(l), {});
  };
  try {
    assert.equal(await runPkg(['help'], (l) => void out.push(l), {}), 0);
    assert.match(out.join('\n'), /Usage: citadel-pkg/);
    assert.equal(await runPkg(['--game', join(root, 'nope'), 'list'], (l) => void out.push(l), {}), 2);

    assert.equal(await pkg('search'), 0);
    assert.ok(!out.join('\n').includes('welcome'), 'host plugins are hidden from citadel-pkg search');

    assert.equal(await pkg('install', 'deathmatch'), 0, out.join('\n'));
    assert.match(out.join('\n'), /Full trust/);
    assert.match(out.join('\n'), new RegExp(`signed by ${k.publicKey.keyId}`));
    assert.equal(readFileSync(join(gameRoot, 'game', 'bin', 'win64', 'managed', 'plugins', 'Deathmatch.dll'), 'utf8'), 'MZ');

    assert.equal(await pkg('install', 'arena'), 0);
    assert.match(out.join('\n'), /warning: UNSIGNED/);
    assert.ok(existsSync(join(gameRoot, 'game', 'citadel', 'maps', 'arena.vpk')));
    // Addons go where Deadworks mounts and advertises them, named as the registry's FastDL serves them.
    assert.ok(existsSync(join(gameRoot, 'game', 'citadel', 'deadworks_server_addons', 'vpks', 'arena_pak01_dir.vpk')));
    assert.doesNotMatch(readFileSync(join(gameRoot, 'game', 'citadel', 'gameinfo.gi'), 'utf8'), /opencitadel/, 'Deadworks mounts its own addons');
    assert.match(out.join('\n'), /"content_addons": \["arena_pak01_dir"\]/);
    assert.match(out.join('\n'), new RegExp(`"fastdl_url": "${reg.url}/fastdl"`));

    assert.equal(await pkg('install', 'welcome'), 1);
    assert.match(out.join('\n'), /welcome is a host plugin: it runs inside citadel-host/);

    const state = pkgStateDir(gameRoot);
    assert.equal(state, join(gameRoot, 'game', 'bin', 'win64', 'configs', 'opencitadel'));
    const installed = JSON.parse(readFileSync(join(state, 'installed.json'), 'utf8'));
    assert.deepEqual(Object.keys(installed).sort(), ['arena', 'deathmatch']);
    assert.ok(existsSync(join(state, 'trust.json')));
    assert.equal(JSON.parse(readFileSync(join(state, 'config.json'), 'utf8')).registry, reg.url);

    assert.equal(await pkg('list'), 0);
    assert.match(out.join('\n'), /deathmatch\s+1\.2\.0\s+deadworks\s+active\s+signed/);
    assert.equal(await pkg('lock'), 0);
    assert.ok(existsSync(join(state, 'plugins.lock.json')));

    assert.equal(await pkg('publish', '.'), 2, 'authoring commands are not part of citadel-pkg');
    assert.match(out.join('\n'), /authoring commands live in `citadel-host plugin`/);

    assert.equal(await pkg('remove', 'deathmatch'), 0);
    assert.ok(!existsSync(join(gameRoot, 'game', 'bin', 'win64', 'managed', 'plugins', 'Deathmatch.dll')));
    assert.equal(await pkg('remove', 'arena'), 0);
    assert.ok(!existsSync(join(gameRoot, 'game', 'citadel', 'maps', 'arena.vpk')));

    // The remembered registry is used when no flag is given.
    out.length = 0;
    assert.equal(await runPkg(['--game', gameRoot, 'search'], (l) => void out.push(l), {}), 0);
    assert.match(out.join('\n'), /deathmatch/);
  } finally {
    await reg.close();
    await rm(root, { recursive: true, force: true });
  }
});
