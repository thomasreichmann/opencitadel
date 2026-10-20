import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { applyDedicatedPatch, inspectGameinfo } from '@opencitadel/gamefiles';
import { clearContent, contentStatus, ensureCached, readInstalled, removeContentSearchPath, syncContent } from './content.js';
import { GAMEINFO_FIXTURE, contentItem, fakeVpk, makeFakeInstall, sha256, startHttp, tempDir } from './testutil.js';

/** Serves fixed bodies by path and counts requests. */
async function fileServer(files: Record<string, Buffer | ((res: import('node:http').ServerResponse) => void)>) {
  const hits: Record<string, number> = {};
  const http = await startHttp((req, res) => {
    const path = req.url ?? '';
    hits[path] = (hits[path] ?? 0) + 1;
    const body = files[path];
    if (!body) {
      res.writeHead(404).end();
    } else if (typeof body === 'function') {
      body(res);
    } else {
      res.writeHead(200, { 'content-length': body.length }).end(body);
    }
  });
  return { ...http, hits };
}

function setup() {
  const tmp = tempDir();
  const gameRoot = makeFakeInstall(join(tmp.dir, 'Deadlock'));
  const cacheDir = join(tmp.dir, 'cache');
  return { tmp, gameRoot, cacheDir, citadel: join(gameRoot, 'game', 'citadel') };
}

test('installs a raw addon and a gzipped map, mounts the search path, records state', async () => {
  const { tmp, gameRoot, cacheDir, citadel } = setup();
  const addon = fakeVpk(5000, 1);
  const map = fakeVpk(20000, 2);
  const srv = await fileServer({ '/addon.vpk': addon, '/arena.vpk.gz': gzipSync(map) });
  try {
    const items = [contentItem('cool_mod', 'addon', addon, `${srv.base}/addon.vpk`), contentItem('arena', 'map', map, `${srv.base}/arena.vpk.gz`)];
    const progress: number[] = [];
    const result = await syncContent({ gameRoot, cacheDir, items, allowPrivate: true, server: { id: 's1', name: 'One' }, onProgress: (e) => progress.push(e.received) });
    assert.deepEqual(result.installed.sort(), ['arena', 'cool_mod']);
    assert.equal(result.gameinfoPatched, true);
    assert.equal(result.restartRequired, false);
    assert.ok(progress.length > 0 && progress.at(-1)! > 0);
    assert.deepEqual(readFileSync(join(citadel, 'maps', 'arena.vpk')), map);
    assert.deepEqual(readFileSync(join(citadel, 'opencitadel', 'pak01_dir.vpk')), addon);
    assert.equal(inspectGameinfo(readFileSync(join(citadel, 'gameinfo.gi'), 'utf8')).contentMounted, true);
    const state = await readInstalled(gameRoot);
    assert.equal(state?.server?.name, 'One');
    assert.equal(state?.maps.arena?.sha256, sha256(map));
    assert.equal(state?.addons[0]?.file, 'pak01_dir.vpk');

    // Second sync: nothing downloaded, nothing rewritten.
    const again = await syncContent({ gameRoot, cacheDir, items, allowPrivate: true, gameRunning: true });
    assert.deepEqual(again.installed, []);
    assert.deepEqual(again.unchanged.sort(), ['arena', 'cool_mod']);
    assert.equal(again.restartRequired, false);
    assert.equal(srv.hits['/addon.vpk'], 1);
    assert.equal(srv.hits['/arena.vpk.gz'], 1);
  } finally {
    await srv.close();
    tmp.cleanup();
  }
});

test('reuses the cache across installs without downloading again', async () => {
  const { tmp, gameRoot, cacheDir, citadel } = setup();
  const addon = fakeVpk(3000, 3);
  const srv = await fileServer({ '/a.vpk': addon });
  try {
    const items = [contentItem('a', 'addon', addon, `${srv.base}/a.vpk`)];
    await syncContent({ gameRoot, cacheDir, items, allowPrivate: true });
    await clearContent(gameRoot);
    assert.equal(existsSync(join(citadel, 'opencitadel', 'pak01_dir.vpk')), false);
    await syncContent({ gameRoot, cacheDir, items, allowPrivate: true });
    assert.equal(srv.hits['/a.vpk'], 1);
    assert.ok(existsSync(join(citadel, 'opencitadel', 'pak01_dir.vpk')));
  } finally {
    await srv.close();
    tmp.cleanup();
  }
});

test('rejects checksum mismatch, bad magic, oversize and HTTP errors without installing', async () => {
  const { tmp, gameRoot, cacheDir, citadel } = setup();
  const good = fakeVpk(4000, 4);
  const notVpk = Buffer.alloc(4000, 9);
  const srv = await fileServer({
    '/good.vpk': good,
    '/notvpk.vpk': notVpk,
    '/big.vpk': Buffer.concat([good, Buffer.alloc(100)]),
    // Lies about nothing in headers but streams more than advertised in the listing.
    '/huge.vpk': (res) => {
      res.writeHead(200);
      res.write(good);
      res.end(Buffer.alloc(10_000));
    },
  });
  try {
    const tampered = { ...contentItem('x', 'addon', good, `${srv.base}/good.vpk`), sha256: 'f'.repeat(64) };
    await assert.rejects(syncContent({ gameRoot, cacheDir, items: [tampered], allowPrivate: true }), /checksum/);
    await assert.rejects(syncContent({ gameRoot, cacheDir, items: [contentItem('x', 'addon', notVpk, `${srv.base}/notvpk.vpk`)], allowPrivate: true }), /not a VPK/);
    await assert.rejects(syncContent({ gameRoot, cacheDir, items: [contentItem('x', 'addon', good, `${srv.base}/big.vpk`)], allowPrivate: true }), /larger than/);
    await assert.rejects(syncContent({ gameRoot, cacheDir, items: [contentItem('x', 'addon', good, `${srv.base}/huge.vpk`)], allowPrivate: true }), /larger than/);
    await assert.rejects(syncContent({ gameRoot, cacheDir, items: [contentItem('x', 'addon', good, `${srv.base}/missing.vpk`)], allowPrivate: true }), /HTTP 404/);
    assert.equal(existsSync(join(citadel, 'opencitadel')), false, 'nothing installed');
    assert.deepEqual(existsSync(cacheDir) ? readdirSync(cacheDir) : [], [], 'no partial files left in the cache');
    assert.equal(inspectGameinfo(readFileSync(join(citadel, 'gameinfo.gi'), 'utf8')).contentMounted, false);
  } finally {
    await srv.close();
    tmp.cleanup();
  }
});

test('refuses private download hosts unless allowed, including via redirect', async () => {
  const { tmp, cacheDir } = setup();
  const good = fakeVpk(1000, 5);
  const srv = await fileServer({ '/good.vpk': good });
  try {
    await assert.rejects(ensureCached(contentItem('x', 'addon', good, `${srv.base}/good.vpk`), cacheDir), /private address/);
    await assert.rejects(ensureCached(contentItem('x', 'addon', good, 'http://localhost:1/x.vpk'), cacheDir), /local address/);
    // A "public" first hop (TEST-NET-3 literal, so no DNS) that redirects into the LAN.
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith('http://203.0.113.10/')) return new Response(null, { status: 302, headers: { location: `${srv.base}/good.vpk` } });
      return fetch(input, init);
    };
    await assert.rejects(ensureCached(contentItem('x', 'addon', good, 'http://203.0.113.10/r'), cacheDir, { fetchImpl }), /private address/);
    assert.deepEqual(calls, ['http://203.0.113.10/r'], 'the private hop is never requested');
    const ok = await ensureCached(contentItem('x', 'addon', good, 'http://203.0.113.10/r'), cacheDir, { fetchImpl, allowPrivate: true });
    assert.equal(ok.downloaded, true);

    // The configured master's own host is trusted even on a private address.
    const other = fakeVpk(1000, 6);
    const srv2 = await fileServer({ '/other.vpk': other });
    try {
      const trusted = await ensureCached(contentItem('y', 'addon', other, `${srv2.base}/other.vpk`), cacheDir, { trustedHosts: [new URL(srv2.base).host] });
      assert.equal(trusted.downloaded, true);
      await assert.rejects(ensureCached(contentItem('z', 'addon', fakeVpk(900, 7), `${srv2.base}/other.vpk`), cacheDir, { trustedHosts: ['127.0.0.1:1'] }), /private address/);
    } finally {
      await srv2.close();
    }
  } finally {
    await srv.close();
    tmp.cleanup();
  }
});

test('never overwrites a map OpenCitadel did not install, but accepts an identical one', async () => {
  const { tmp, gameRoot, cacheDir, citadel } = setup();
  const stock = fakeVpk(6000, 6);
  writeFileSync(join(citadel, 'maps', 'dl_midtown.vpk'), stock);
  const evil = fakeVpk(6000, 7);
  const srv = await fileServer({ '/evil.vpk': evil, '/same.vpk': stock });
  try {
    await assert.rejects(
      syncContent({ gameRoot, cacheDir, items: [contentItem('dl_midtown', 'map', evil, `${srv.base}/evil.vpk`)], allowPrivate: true }),
      /Refusing to replace maps\/dl_midtown\.vpk/,
    );
    assert.equal(srv.hits['/evil.vpk'], undefined, 'refused before downloading');
    assert.deepEqual(readFileSync(join(citadel, 'maps', 'dl_midtown.vpk')), stock);

    const same = await syncContent({ gameRoot, cacheDir, items: [contentItem('dl_midtown', 'map', stock, `${srv.base}/same.vpk`)], allowPrivate: true });
    assert.deepEqual(same.unchanged, ['dl_midtown']);
    assert.equal((await readInstalled(gameRoot))?.maps.dl_midtown, undefined, 'identical stock map is not claimed');
    await clearContent(gameRoot);
    assert.ok(existsSync(join(citadel, 'maps', 'dl_midtown.vpk')), 'clear leaves the stock map alone');
  } finally {
    await srv.close();
    tmp.cleanup();
  }
});

test('addon set follows the joined server and flags a restart while the game runs', async () => {
  const { tmp, gameRoot, cacheDir, citadel } = setup();
  const a = fakeVpk(1000, 10);
  const b = fakeVpk(1100, 11);
  const c = fakeVpk(1200, 12);
  const srv = await fileServer({ '/a.vpk': a, '/b.vpk': b, '/c.vpk': c });
  const item = (n: string, d: Buffer) => contentItem(n, 'addon', d, `${srv.base}/${n}.vpk`);
  try {
    await syncContent({ gameRoot, cacheDir, items: [item('a', a), item('b', b)], allowPrivate: true });
    assert.deepEqual(readdirSync(join(citadel, 'opencitadel')).sort(), ['installed.json', 'pak01_dir.vpk', 'pak02_dir.vpk']);

    const next = await syncContent({ gameRoot, cacheDir, items: [item('c', c)], allowPrivate: true, gameRunning: true });
    assert.deepEqual(next.installed, ['c']);
    assert.deepEqual(next.removed.sort(), ['a', 'b']);
    assert.equal(next.restartRequired, true);
    assert.deepEqual(readdirSync(join(citadel, 'opencitadel')).sort(), ['installed.json', 'pak01_dir.vpk']);
    assert.deepEqual(readFileSync(join(citadel, 'opencitadel', 'pak01_dir.vpk')), c);

    // Joining a vanilla server unmounts the previous server's addons.
    const vanilla = await syncContent({ gameRoot, cacheDir, items: [], allowPrivate: true, gameRunning: false });
    assert.deepEqual(vanilla.removed, ['c']);
    assert.deepEqual(readdirSync(join(citadel, 'opencitadel')), ['installed.json']);
    assert.equal(vanilla.restartRequired, false);
  } finally {
    await srv.close();
    tmp.cleanup();
  }
});

test('re-mounts the search path after a game update rewrote gameinfo.gi', async () => {
  const { tmp, gameRoot, cacheDir, citadel } = setup();
  const a = fakeVpk(1000, 20);
  const srv = await fileServer({ '/a.vpk': a });
  try {
    const items = [contentItem('a', 'addon', a, `${srv.base}/a.vpk`)];
    await syncContent({ gameRoot, cacheDir, items, allowPrivate: true });
    writeFileSync(join(citadel, 'gameinfo.gi'), GAMEINFO_FIXTURE); // "Valve update"
    const result = await syncContent({ gameRoot, cacheDir, items, allowPrivate: true, gameRunning: true });
    assert.equal(result.gameinfoPatched, true);
    assert.equal(result.restartRequired, true);
    assert.equal((await contentStatus(gameRoot)).gameinfo.contentMounted, true);
  } finally {
    await srv.close();
    tmp.cleanup();
  }
});

test('clear removes our files and only the content search path, keeping dedicated edits', async () => {
  const { tmp, cacheDir } = setup();
  const gameRoot = makeFakeInstall(join(tmp.dir, 'Deadlock2'), applyDedicatedPatch(GAMEINFO_FIXTURE));
  const c2 = join(gameRoot, 'game', 'citadel');
  const a = fakeVpk(1000, 30);
  const m = fakeVpk(2000, 31);
  const srv = await fileServer({ '/a.vpk': a, '/m.vpk': m });
  try {
    await syncContent({ gameRoot, cacheDir, items: [contentItem('a', 'addon', a, `${srv.base}/a.vpk`), contentItem('m', 'map', m, `${srv.base}/m.vpk`)], allowPrivate: true });
    const result = await clearContent(gameRoot);
    assert.deepEqual(result.removed.sort(), ['maps/m.vpk', 'opencitadel/pak01_dir.vpk']);
    assert.equal(result.gameinfoChanged, true);
    assert.equal(existsSync(join(c2, 'opencitadel')), false);
    const status = inspectGameinfo(readFileSync(join(c2, 'gameinfo.gi'), 'utf8'));
    assert.equal(status.contentMounted, false);
    assert.equal(status.dedicatedReady, true, 'host edits survive');
    assert.equal(readFileSync(join(c2, 'gameinfo.gi'), 'utf8'), applyDedicatedPatch(GAMEINFO_FIXTURE));
    assert.ok(existsSync(join(c2, 'gameinfo.gi.opencitadel.bak')));
  } finally {
    await srv.close();
    tmp.cleanup();
  }
});

test('removeContentSearchPath leaves other marked lines alone', () => {
  const src = 'GameInfo\n{\n\tFileSystem\n\t{\n\t\tSearchPaths\n\t\t{\n\t\t\tGame\t\t\t\tcitadel/opencitadel\t// opencitadel:added\n\t\t\tGame citadel\n\t\t}\n\t}\n\tConVars\n\t{\n\t\tnet_p2p_listen_dedicated\t1\t// opencitadel:added\n\t}\n}\n';
  const out = removeContentSearchPath(src);
  assert.ok(!out.includes('citadel/opencitadel'));
  assert.ok(out.includes('net_p2p_listen_dedicated\t1\t// opencitadel:added'));
});
