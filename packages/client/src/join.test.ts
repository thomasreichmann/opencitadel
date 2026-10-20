import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { JoinError, joinServer, launchTarget } from './join.js';
import { RecordingPlatform } from './launch.js';
import { contentItem, fakeVpk, makeFakeInstall, serverDetail, startHttp, tempDir } from './testutil.js';

const cacheDir = '/nonexistent-cache-not-used';

test('verified servers join by address, others over SDR by SteamID', async () => {
  const platform = new RecordingPlatform();
  const verified = await joinServer({ server: serverDetail({ verified: true }), cacheDir, platform });
  assert.equal(verified.steamUrl, 'steam://connect/203.0.113.5:27015');
  assert.equal(verified.command, 'connect 203.0.113.5:27015');
  const sdr = await joinServer({ server: serverDetail({ verified: false }), cacheDir, platform });
  assert.equal(sdr.steamUrl, 'steam://run/1422450//%2Bconnect%20%5BA%3A1%3A123%3A456%5D/');
  assert.deepEqual(platform.opened, [verified.steamUrl, sdr.steamUrl]);
  assert.deepEqual(platform.copied, ['connect 203.0.113.5:27015', 'connect [A:1:123:456]']);
  assert.equal(sdr.launched, true);
  assert.match(sdr.message, /F7/);
});

test('address-only servers still join, password goes into URL and command', async () => {
  const platform = new RecordingPlatform();
  const r = await joinServer({ server: serverDetail({ connect: { address: 'play.example.com:27016' }, passworded: true }), password: 'hunter2', cacheDir, platform });
  assert.equal(r.steamUrl, 'steam://connect/play.example.com:27016/hunter2');
  assert.equal(r.command, 'password "hunter2"; connect play.example.com:27016');
});

test('refuses offline, full and passworded servers with specific codes', async () => {
  const platform = new RecordingPlatform();
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'ok';
    } catch (err) {
      assert.ok(err instanceof JoinError);
      return err.code;
    }
  };
  assert.equal(await code(joinServer({ server: serverDetail({ online: false }), cacheDir, platform })), 'offline');
  assert.equal(await code(joinServer({ server: serverDetail({ players: 12 }), cacheDir, platform })), 'full');
  assert.equal(await code(joinServer({ server: serverDetail({ players: 12 }), force: true, cacheDir, platform })), 'ok');
  assert.equal(await code(joinServer({ server: serverDetail({ passworded: true }), cacheDir, platform })), 'password_required');
  assert.equal(await code(joinServer({ server: serverDetail({ connect: {} }), cacheDir, platform })), 'no_target');
  assert.equal(
    await code(joinServer({ server: serverDetail({ content: [contentItem('m', 'map', fakeVpk(10), 'https://x.example/m.vpk')] }), cacheDir, platform })),
    'no_game',
  );
});

test('print mode opens nothing', async () => {
  const platform = new RecordingPlatform();
  const r = await joinServer({ server: serverDetail(), cacheDir, platform, launch: false });
  assert.equal(r.launched, false);
  assert.deepEqual(platform.opened, []);
  assert.deepEqual(platform.copied, []);
  const direct = await launchTarget({ target: { kind: 'address', value: '198.51.100.1:27015' }, platform, launch: false });
  assert.equal(direct.steamUrl, 'steam://connect/198.51.100.1:27015');
  assert.deepEqual(platform.opened, []);
});

test('installs content first, and holds the launch when a restart is needed', async () => {
  const tmp = tempDir();
  const gameRoot = makeFakeInstall(join(tmp.dir, 'Deadlock'));
  const addon = fakeVpk(2000, 3);
  const srv = await startHttp((_req, res) => res.writeHead(200).end(addon));
  try {
    const server = serverDetail({ content: [contentItem('mod', 'addon', addon, `${srv.base}/mod.vpk`)], requiresContent: true, modded: true });
    const idle = new RecordingPlatform(false);
    const first = await joinServer({ server, gameRoot, cacheDir: join(tmp.dir, 'cache'), platform: idle, allowPrivateContent: true });
    assert.deepEqual(first.contentInstalled, ['mod']);
    assert.equal(first.launched, true);
    assert.match(first.message, /^Installed mod\. /);

    // Different server content while the game runs: install, but don't launch into stale content.
    const running = new RecordingPlatform(true);
    const other = fakeVpk(2100, 4);
    const srv2 = await startHttp((_req, res) => res.writeHead(200).end(other));
    try {
      const second = await joinServer({
        server: serverDetail({ id: 'otherserver23456', content: [contentItem('mod2', 'addon', other, `${srv2.base}/mod2.vpk`)] }),
        gameRoot,
        cacheDir: join(tmp.dir, 'cache'),
        platform: running,
        allowPrivateContent: true,
      });
      assert.equal(second.restartRequired, true);
      assert.equal(second.launched, false);
      assert.deepEqual(running.opened, []);
      assert.match(second.message, /Quit Deadlock/);
    } finally {
      await srv2.close();
    }

    // Content failures surface as content_failed.
    await assert.rejects(
      joinServer({ server: serverDetail({ content: [{ ...contentItem('bad', 'addon', addon, `${srv.base}/x.vpk`), sha256: '0'.repeat(64) }] }), gameRoot, cacheDir: join(tmp.dir, 'cache'), platform: idle, allowPrivateContent: true }),
      (err: unknown) => err instanceof JoinError && err.code === 'content_failed' && /checksum/.test(err.message),
    );
  } finally {
    await srv.close();
    tmp.cleanup();
  }
});
