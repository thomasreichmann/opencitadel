import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { packTarGz } from '@opencitadel/protocol';
import { startMaster } from './testutil.js';

function hostPackage(version: string, over: Record<string, unknown> = {}, extraFiles: Record<string, Buffer> = {}): Buffer {
  const manifest = { id: 'welcome', name: 'Welcome', version, kind: 'host', main: 'dist/index.js', description: `Greets players (v${version})`, tags: ['chat'], permissions: ['server.chat'], ...over };
  return packTarGz({ 'plugin.json': Buffer.from(JSON.stringify(manifest)), 'dist/index.js': Buffer.from(`export default { setup() {} }; // ${version}\n`), ...extraFiles });
}

test('publish, browse, download and serve files', async () => {
  const m = await startMaster();
  try {
    const alice = await m.account('alice');
    const pkg = hostPackage('1.0.0');
    const put = (version: string, body: Buffer, token = alice) => m.api('PUT', `/v1/plugins/welcome/${version}`, { raw: body, token, headers: { 'content-type': 'application/gzip' } });

    assert.equal((await put('1.0.0', pkg, 'ock_bad')).status, 401);
    const published = await put('1.0.0', pkg);
    assert.equal(published.status, 201, published.text);
    assert.equal(published.json.plugin.latest, '1.0.0');
    assert.equal(published.json.plugin.owner, 'alice');
    assert.equal(published.json.version.sha256, createHash('sha256').update(pkg).digest('hex'));

    const list = await m.api('GET', '/v1/plugins');
    assert.equal(list.json.total, 1);
    assert.equal(list.json.plugins[0].id, 'welcome');
    assert.equal((await m.api('GET', '/v1/plugins?q=greets')).json.total, 1);
    assert.equal((await m.api('GET', '/v1/plugins?kind=content')).json.total, 0);
    assert.equal((await m.api('GET', '/v1/plugins?tag=chat')).json.total, 1);
    assert.equal((await m.api('GET', '/v1/plugins?kind=bogus')).status, 400);

    const info = await m.api('GET', '/v1/plugins/welcome');
    assert.equal(info.json.manifest.main, 'dist/index.js');
    assert.deepEqual(info.json.manifest.permissions, ['server.chat']);
    assert.equal(info.json.versions.length, 1);

    const ver = await m.api('GET', '/v1/plugins/welcome/1.0.0');
    assert.equal(ver.json.version, '1.0.0');
    assert.equal(ver.json.yanked, false);
    assert.equal(ver.json.packageUrl, '/v1/plugins/welcome/1.0.0/package');

    const dl = await fetch(`${m.base}/v1/plugins/welcome/1.0.0/package`);
    const bytes = Buffer.from(await dl.arrayBuffer());
    assert.equal(dl.headers.get('content-type'), 'application/gzip');
    assert.equal(dl.headers.get('x-checksum-sha256'), published.json.version.sha256);
    assert.deepEqual(bytes, pkg);
    assert.equal((await m.api('GET', '/v1/plugins/welcome')).json.plugin.downloads, 1);

    const file = await fetch(`${m.base}/v1/plugins/welcome/1.0.0/files/dist/index.js`);
    assert.match(file.headers.get('content-type')!, /javascript/);
    assert.match(file.headers.get('content-security-policy')!, /sandbox/);
    assert.match(await file.text(), /1\.0\.0/);
    assert.equal((await m.api('GET', '/v1/plugins/welcome/1.0.0/files/dist/missing.js')).status, 404);
    assert.equal((await m.api('GET', '/v1/plugins/welcome/1.0.0/files/..%2Fplugin.json')).status, 404);
    assert.equal((await m.api('GET', '/v1/plugins/welcome/1.0.0/files/dist%2F..%2F..%2F..%2Fmaster.db')).status, 404);

    // Immutable versions, single owner, manifest must match the URL.
    assert.equal((await put('1.0.0', hostPackage('1.0.0'))).status, 409);
    const bob = await m.account('bob');
    assert.equal((await put('1.1.0', hostPackage('1.1.0'), bob)).json.error.code, 'not_owner');
    assert.equal((await put('1.2.0', hostPackage('1.1.0'))).json.error.code, 'manifest_mismatch');
    assert.equal((await m.api('PUT', '/v1/plugins/other/1.0.0', { raw: hostPackage('1.0.0'), token: alice })).json.error.code, 'manifest_mismatch');
    assert.equal((await put('1.3.0', hostPackage('1.3.0', { main: 'dist/nope.js' }))).json.error.code, 'invalid_package');
    assert.equal((await put('1.4.0', hostPackage('1.4.0', { kind: 'content', content: [{ file: 'pak01_dir.vpk' }], main: undefined }, { 'pak01_dir.vpk': Buffer.from('x') }))).json.error.code, 'kind_mismatch');
    assert.equal((await put('1.5.0', Buffer.from('not a tarball'))).json.error.code, 'invalid_package');
    assert.equal((await put('1.6.0', gzipSync(Buffer.alloc(1024)))).json.error.code, 'invalid_package', 'empty tar: no plugin.json');
    assert.equal((await put('1.7.0', packTarGz({ 'plugin.json': Buffer.from('{"id":"welcome"}') }))).json.error.code, 'invalid_manifest');
    assert.equal((await put('not-semver', pkg)).json.error.code, 'invalid_version');
    assert.equal((await m.api('PUT', '/v1/plugins/Bad_Id/1.0.0', { raw: pkg, token: alice })).json.error.code, 'invalid_id');
    assert.equal((await m.api('GET', '/v1/stats')).json.plugins, 1);
  } finally {
    await m.close();
  }
});

test('version resolution and yanking', async () => {
  const m = await startMaster({ adminToken: 'root' });
  try {
    const alice = await m.account('alice');
    for (const v of ['1.0.0', '1.1.0', '2.0.0']) {
      const r = await m.api('PUT', `/v1/plugins/welcome/${v}`, { raw: hostPackage(v), token: alice });
      assert.equal(r.status, 201, r.text);
      m.advance(1000);
    }
    const resolve = async (spec: string) => (await m.api('GET', `/v1/plugins/welcome/${encodeURIComponent(spec)}`)).json.version;
    assert.equal(await resolve('latest'), '2.0.0');
    assert.equal(await resolve('^1.0.0'), '1.1.0');
    assert.equal(await resolve('~1.0.0'), '1.0.0');
    assert.equal(await resolve('>=1.0.0 <3.0.0'), '2.0.0');
    assert.equal((await m.api('GET', `/v1/plugins/welcome/${encodeURIComponent('^3.0.0')}`)).status, 404);
    assert.equal((await m.api('GET', '/v1/plugins/welcome/what')).status, 400);
    assert.equal((await m.api('GET', '/v1/plugins/nope/latest')).status, 404);

    const bob = await m.account('bob');
    assert.equal((await m.api('POST', '/v1/plugins/welcome/2.0.0/yank', { token: bob })).status, 404, 'only the owner yanks');
    const yanked = await m.api('POST', '/v1/plugins/welcome/2.0.0/yank', { token: alice });
    assert.equal(yanked.json.version.yanked, true);
    assert.equal(await resolve('latest'), '1.1.0');
    assert.equal(await resolve('>=1.0.0 <3.0.0'), '1.1.0', 'ranges skip yanked versions');
    assert.equal(await resolve('2.0.0'), '2.0.0', 'exact versions stay downloadable');
    assert.equal((await fetch(`${m.base}/v1/plugins/welcome/2.0.0/package`)).status, 200);
    assert.equal((await m.api('GET', '/v1/plugins/welcome')).json.plugin.latest, '1.1.0');

    await m.api('POST', '/v1/plugins/welcome/2.0.0/yank', { token: alice, body: { yanked: false } });
    assert.equal(await resolve('latest'), '2.0.0');

    // Admins can yank anything; a plugin with every version yanked drops out of the directory.
    for (const v of ['1.0.0', '1.1.0', '2.0.0']) {
      assert.equal((await m.api('POST', `/v1/admin/plugins/welcome/${v}/yank`, { token: 'root' })).status, 200);
    }
    assert.equal((await m.api('GET', '/v1/plugins')).json.total, 0);
    assert.equal((await m.api('GET', '/v1/plugins/welcome/latest')).status, 404);
    assert.equal((await m.api('POST', '/v1/admin/plugins/welcome/1.0.0/yank', { token: alice })).status, 401);
  } finally {
    await m.close();
  }
});

test('content packages serve VPKs as downloads', async () => {
  const m = await startMaster();
  try {
    const key = await m.account('mapper');
    const vpk = Buffer.concat([Buffer.from([0x34, 0x12, 0xaa, 0x55]), Buffer.alloc(2048, 1)]);
    const manifest = { id: 'arena-map', name: 'Arena', version: '0.1.0', kind: 'content', content: [{ file: 'maps/arena.vpk', client: true }], maps: ['arena'] };
    const r = await m.api('PUT', '/v1/plugins/arena-map/0.1.0', { raw: packTarGz({ 'plugin.json': Buffer.from(JSON.stringify(manifest)), 'maps/arena.vpk': vpk }), token: key });
    assert.equal(r.status, 201, r.text);
    const res = await fetch(`${m.base}/v1/plugins/arena-map/latest/files/maps/arena.vpk`);
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    assert.match(res.headers.get('content-disposition')!, /^attachment; filename="arena.vpk"/);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), vpk);
  } finally {
    await m.close();
  }
});
