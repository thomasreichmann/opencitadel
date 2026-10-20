import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { packTarGz, type PluginVersionInfo } from '@opencitadel/protocol';
import { parseHostConfig } from '../config.js';
import { installFromFile, installFromRegistry, removePackage, resolveVersion, sha256 } from './install.js';
import { readInstalled } from './installed.js';
import { installedListing } from './listing.js';
import { RegistryClient } from './registry.js';
import { tempServerDir } from './testing.js';
import { PluginRuntime } from './runtime.js';
import { fakeServices } from './testing.js';

const VPK = (fill: number, size = 64) => {
  const b = Buffer.alloc(size, fill);
  b.writeUInt32LE(0x55aa1234, 0);
  return b;
};

function pkg(manifest: Record<string, unknown>, files: Record<string, Buffer | string> = {}): Buffer {
  const entries: Record<string, Buffer> = { 'plugin.json': Buffer.from(JSON.stringify(manifest)) };
  for (const [k, v] of Object.entries(files)) entries[k] = Buffer.isBuffer(v) ? v : Buffer.from(v);
  return packTarGz(entries);
}

const host = (id: string, version: string, extra: Record<string, unknown> = {}) =>
  pkg({ id, name: id, version, kind: 'host', main: 'dist/index.js', permissions: ['server.chat'], ...extra }, {
    'dist/index.js': `export default { setup(ctx) { ctx.log.info('loaded ${id}@${version}'); } };`,
  });

interface Published {
  archive: Buffer;
  yanked?: boolean;
  /** Override the checksum header to simulate tampering. */
  header?: string;
}

/** A fake registry that serves the routes RegistryClient uses. */
async function fakeRegistry(packages: Record<string, Record<string, Published>>): Promise<{ url: string; server: Server; downloads: string[] }> {
  const downloads: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); // v1 plugins id [version] [package|files ...]
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const versions = packages[parts[2] ?? ''];
    if (parts[0] !== 'v1' || parts[1] !== 'plugins' || !versions) return send(404, { error: { code: 'not_found', message: `No package ${parts[2]}` } });
    const infos: PluginVersionInfo[] = Object.entries(versions).map(([version, p]) => ({ version, sha256: sha256(p.archive), size: p.archive.length, publishedAt: '2026-10-01T00:00:00Z', yanked: !!p.yanked }));
    if (parts.length === 3) return send(200, { plugin: { id: parts[2] }, manifest: {}, versions: infos });
    const p = versions[parts[3]!];
    if (!p) return send(404, { error: { code: 'not_found', message: 'no such version' } });
    if (parts[4] === 'package') {
      downloads.push(`${parts[2]}@${parts[3]}`);
      res.writeHead(200, { 'content-type': 'application/gzip', 'x-checksum-sha256': p.header ?? sha256(p.archive) });
      return res.end(p.archive);
    }
    send(404, { error: { code: 'not_found', message: 'nope' } });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, downloads };
}

const GAMEINFO = ['"GameInfo"', '{', '\tFileSystem', '\t{', '\t\tSearchPaths', '\t\t{', '\t\t\tGame\t\t\t\tcitadel', '\t\t\tGame\t\t\t\tcore', '\t\t}', '\t}', '}', ''].join('\n');

function fakeGame(root: string): string {
  mkdirSync(join(root, 'game', 'bin', 'win64'), { recursive: true });
  mkdirSync(join(root, 'game', 'citadel', 'maps'), { recursive: true });
  writeFileSync(join(root, 'game', 'bin', 'win64', 'deadlock.exe'), '');
  writeFileSync(join(root, 'game', 'citadel', 'gameinfo.gi'), GAMEINFO);
  return root;
}

test('resolveVersion skips yanked versions unless asked exactly', () => {
  const v = (version: string, yanked = false): PluginVersionInfo => ({ version, sha256: '', size: 0, publishedAt: '', yanked });
  const versions = [v('1.0.0'), v('1.1.0'), v('1.2.0', true), v('2.0.0-beta.1')];
  assert.equal(resolveVersion(versions, '^1.0.0'), '1.1.0');
  assert.equal(resolveVersion(versions, 'latest'), '1.1.0');
  assert.equal(resolveVersion(versions, '1.2.0'), '1.2.0');
  assert.equal(resolveVersion(versions, '^3.0.0'), undefined);
});

test('installs host plugins with dependencies, then removes them', async () => {
  const tmp = tempServerDir();
  const reg = await fakeRegistry({
    alpha: { '1.0.0': { archive: host('alpha', '1.0.0') }, '1.1.0': { archive: host('alpha', '1.1.0') }, '1.2.0': { archive: host('alpha', '1.2.0'), yanked: true } },
    beta: { '0.3.0': { archive: host('beta', '0.3.0', { dependencies: { alpha: '^1.0.0' } }) } },
  });
  try {
    const registry = new RegistryClient(reg.url + '/');
    const outcomes = await installFromRegistry('beta', { serverDir: tmp.dir, registry });
    assert.deepEqual(outcomes.map((o) => `${o.id}@${o.version}:${o.skipped}`), ['alpha@1.1.0:false', 'beta@0.3.0:false']);
    assert.deepEqual(outcomes[1]!.permissions, ['server.chat']);
    const index = await readInstalled(tmp.dir);
    assert.equal(index.alpha!.registry, reg.url);
    assert.ok(existsSync(join(tmp.dir, '.opencitadel', 'plugins', 'beta', 'dist', 'index.js')));
    assert.ok(existsSync(join(tmp.dir, '.opencitadel', 'cache', `${index.beta!.sha256}.tgz`)));

    // Already satisfied: nothing downloaded again.
    const again = await installFromRegistry('alpha@^1.0.0', { serverDir: tmp.dir, registry });
    assert.equal(again[0]!.skipped, true);
    assert.equal(reg.downloads.length, 2);

    // Installed plugins load through the runtime, inside the sandbox, in dependency order.
    const svc = fakeServices(tmp.dir);
    const rt = new PluginRuntime(svc, parseHostConfig({ plugins: { alpha: {}, beta: {} } }));
    await rt.loadAll();
    assert.deepEqual(svc.logged('loaded ').map((l) => l.message), ['loaded alpha@1.1.0', 'loaded beta@0.3.0']);
    await rt.unloadAll();

    await assert.rejects(removePackage('alpha', { serverDir: tmp.dir }), /beta depends on alpha/);
    await removePackage('beta', { serverDir: tmp.dir });
    await removePackage('alpha', { serverDir: tmp.dir });
    assert.deepEqual(await readInstalled(tmp.dir), {});
    assert.ok(!existsSync(join(tmp.dir, '.opencitadel', 'plugins', 'beta')));
    await assert.rejects(installFromRegistry('nope', { serverDir: tmp.dir, registry }), /No package nope/);
  } finally {
    reg.server.close();
    await tmp.cleanup();
  }
});

test('rejects checksum mismatches, unsafe archives and id mismatches', async () => {
  const tmp = tempServerDir();
  const good = host('evil', '1.0.0');
  // An archive whose entry name escapes the package directory.
  const h = Buffer.alloc(512);
  h.write('../escape.js', 0);
  h.write('0000644\0', 100);
  h.write('00000000004\0', 124);
  h.write('0', 156);
  h.write('ustar\0', 257);
  h.write('        ', 148);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const traversal = gzipSync(Buffer.concat([h, Buffer.from('evil'), Buffer.alloc(508), Buffer.alloc(1024)]));
  const reg = await fakeRegistry({
    evil: { '1.0.0': { archive: good, header: 'f'.repeat(64) } },
    sneaky: { '1.0.0': { archive: traversal } },
    liar: { '1.0.0': { archive: host('someone-else', '1.0.0') } },
  });
  try {
    const registry = new RegistryClient(reg.url);
    await assert.rejects(installFromRegistry('evil', { serverDir: tmp.dir, registry }), /Checksum mismatch/);
    await assert.rejects(installFromRegistry('sneaky', { serverDir: tmp.dir, registry }), /Unsafe path/);
    await assert.rejects(installFromRegistry('liar', { serverDir: tmp.dir, registry }), /do not match liar@1\.0\.0/);
    assert.deepEqual(await readInstalled(tmp.dir), {});
    assert.ok(!existsSync(join(tmp.dir, 'escape.js')));
  } finally {
    reg.server.close();
    await tmp.cleanup();
  }
});

test('deadworks and content packages install into the game, refuse to clobber, and list content', async () => {
  const tmp = tempServerDir();
  const gameRoot = fakeGame(join(tmp.dir, 'Deadlock'));
  const dw = pkg({ id: 'dw-tools', name: 'DW Tools', version: '2.0.0', kind: 'deadworks', assemblies: ['bin/DwTools.dll', 'bin/DwTools.pdb'] }, { 'bin/DwTools.dll': 'MZ...', 'bin/DwTools.pdb': 'pdb' });
  const content = pkg(
    { id: 'arena-map', name: 'Arena', version: '1.0.0', kind: 'content', maps: ['arena_one'], content: [{ file: 'maps/arena_one.vpk', client: true }, { file: 'pak01_dir.vpk', client: true }, { file: 'server_only.vpk' }] },
    { 'maps/arena_one.vpk': VPK(1), 'pak01_dir.vpk': VPK(2), 'server_only.vpk': VPK(3) },
  );
  const reg = await fakeRegistry({ 'dw-tools': { '2.0.0': { archive: dw } }, 'arena-map': { '1.0.0': { archive: content } } });
  try {
    const registry = new RegistryClient(reg.url);
    await assert.rejects(installFromRegistry('dw-tools', { serverDir: tmp.dir, registry }), /need the Deadlock install path/);

    await installFromRegistry('dw-tools', { serverDir: tmp.dir, gameRoot, registry });
    assert.equal(readFileSync(join(gameRoot, 'game', 'bin', 'win64', 'managed', 'plugins', 'DwTools.dll'), 'utf8'), 'MZ...');

    // A user's own addon already sits in pak01; ours must take the next free slot.
    mkdirSync(join(gameRoot, 'game', 'citadel', 'opencitadel_server'), { recursive: true });
    writeFileSync(join(gameRoot, 'game', 'citadel', 'opencitadel_server', 'pak01_dir.vpk'), 'theirs');
    const [outcome] = await installFromRegistry('arena-map', { serverDir: tmp.dir, gameRoot, registry });
    assert.equal(outcome!.mountedContent, true);
    assert.deepEqual(readFileSync(join(gameRoot, 'game', 'citadel', 'maps', 'arena_one.vpk')), VPK(1));
    assert.deepEqual(readFileSync(join(gameRoot, 'game', 'citadel', 'opencitadel_server', 'pak02_dir.vpk')), VPK(2));
    assert.deepEqual(readFileSync(join(gameRoot, 'game', 'citadel', 'opencitadel_server', 'pak03_dir.vpk')), VPK(3));
    assert.equal(readFileSync(join(gameRoot, 'game', 'citadel', 'opencitadel_server', 'pak01_dir.vpk'), 'utf8'), 'theirs');
    assert.match(readFileSync(join(gameRoot, 'game', 'citadel', 'gameinfo.gi'), 'utf8'), /Game\t+citadel\/opencitadel_server/);

    const config = parseHostConfig({ game: { path: gameRoot } });
    const listing = await installedListing(tmp.dir, config);
    assert.deepEqual(listing.plugins, [
      { id: 'arena-map', name: 'Arena', version: '1.0.0', kind: 'content' },
      { id: 'dw-tools', name: 'DW Tools', version: '2.0.0', kind: 'deadworks' },
    ]);
    assert.deepEqual(listing.content, [
      { name: 'arena_one', kind: 'map', sha256: sha256(VPK(1)), size: 64, url: `${reg.url}/v1/plugins/arena-map/1.0.0/files/maps/arena_one.vpk` },
      { name: 'arena_map_pak01_dir', kind: 'addon', sha256: sha256(VPK(2)), size: 64, url: `${reg.url}/v1/plugins/arena-map/1.0.0/files/pak01_dir.vpk` },
    ]);

    // A server-side edit to a client file means players would download something else: drop it.
    writeFileSync(join(gameRoot, 'game', 'citadel', 'maps', 'arena_one.vpk'), VPK(9, 70));
    assert.deepEqual((await installedListing(tmp.dir, config)).content.map((c) => c.name), ['arena_map_pak01_dir']);

    await removePackage('arena-map', { serverDir: tmp.dir });
    assert.ok(!existsSync(join(gameRoot, 'game', 'citadel', 'maps', 'arena_one.vpk')));
    assert.ok(!existsSync(join(gameRoot, 'game', 'citadel', 'opencitadel_server', 'pak02_dir.vpk')));
    assert.ok(existsSync(join(gameRoot, 'game', 'citadel', 'opencitadel_server', 'pak01_dir.vpk')), 'their file survives');

    // A map we did not install is never overwritten.
    writeFileSync(join(gameRoot, 'game', 'citadel', 'maps', 'arena_one.vpk'), 'hand-placed');
    await assert.rejects(installFromRegistry('arena-map', { serverDir: tmp.dir, gameRoot, registry }), /Refusing to overwrite game\/citadel\/maps\/arena_one\.vpk/);
    assert.equal(readFileSync(join(gameRoot, 'game', 'citadel', 'maps', 'arena_one.vpk'), 'utf8'), 'hand-placed');
    assert.equal((await readInstalled(tmp.dir))['arena-map'], undefined);

    await removePackage('dw-tools', { serverDir: tmp.dir });
    assert.ok(!existsSync(join(gameRoot, 'game', 'bin', 'win64', 'managed', 'plugins', 'DwTools.dll')));
  } finally {
    reg.server.close();
    await tmp.cleanup();
  }
});

test('local .tgz installs, upgrades in place, and disabled host plugins are not listed', async () => {
  const tmp = tempServerDir();
  try {
    const v1 = join(tmp.dir, 'gamma-1.0.0.tgz');
    const v2 = join(tmp.dir, 'gamma-2.0.0.tgz');
    writeFileSync(v1, host('gamma', '1.0.0'));
    writeFileSync(v2, pkg({ id: 'gamma', name: 'gamma', version: '2.0.0', kind: 'host', main: 'main.mjs' }, { 'main.mjs': 'export default { setup() {} };' }));
    await installFromFile(v1, { serverDir: tmp.dir });
    await installFromFile(v2, { serverDir: tmp.dir });
    const dir = join(tmp.dir, '.opencitadel', 'plugins', 'gamma');
    assert.ok(existsSync(join(dir, 'main.mjs')));
    assert.ok(!existsSync(join(dir, 'dist')), 'files from the old version are gone');
    assert.equal((await readInstalled(tmp.dir)).gamma!.version, '2.0.0');
    assert.deepEqual((await installedListing(tmp.dir, parseHostConfig({ plugins: { gamma: { enabled: false } } }))).plugins, []);
    assert.deepEqual((await installedListing(tmp.dir, parseHostConfig({ plugins: { gamma: {} } }))).plugins, [{ id: 'gamma', name: 'gamma', version: '2.0.0', kind: 'host' }]);

    // A hand-made plugin directory is never replaced by an install.
    writeFileSync(join(tmp.dir, 'delta.tgz'), host('delta', '1.0.0'));
    mkdirSync(join(tmp.dir, '.opencitadel', 'plugins', 'delta'), { recursive: true });
    await assert.rejects(installFromFile(join(tmp.dir, 'delta.tgz'), { serverDir: tmp.dir }), /not installed by OpenCitadel/);
    // Dependencies of a local file must already be there.
    writeFileSync(join(tmp.dir, 'eps.tgz'), host('eps', '1.0.0', { dependencies: { zeta: '^1.0.0' } }));
    await assert.rejects(installFromFile(join(tmp.dir, 'eps.tgz'), { serverDir: tmp.dir }), /needs zeta@\^1\.0\.0/);
  } finally {
    await tmp.cleanup();
  }
});
