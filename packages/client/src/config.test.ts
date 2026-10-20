import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { addFavorite, loadClientConfig, recordHistory, removeFavorite, resolveMasterUrl, updateClientConfig, DEFAULT_MASTER_URL, clientHome } from './config.js';
import { formatServerDetail, formatServerList, makeStyle, table, truncate } from './format.js';
import { serverDetail, tempDir } from './testutil.js';

test('favorites and history persist and stay deduplicated', async () => {
  const tmp = tempDir();
  try {
    const home = join(tmp.dir, 'home');
    assert.deepEqual((await loadClientConfig(home)).favorites, []);
    await updateClientConfig(home, (c) => {
      addFavorite(c, 'aaaa');
      addFavorite(c, 'bbbb');
      addFavorite(c, 'aaaa');
    });
    await updateClientConfig(home, (c) => removeFavorite(c, 'bbbb'));
    assert.deepEqual((await loadClientConfig(home)).favorites, ['aaaa']);
    assert.throws(() => addFavorite({ favorites: [], history: [] }, '../evil'), /Invalid server id/);

    await updateClientConfig(home, (c) => {
      recordHistory(c, { id: 'a', name: 'A', target: '[A:1:1:1]' }, new Date('2026-01-01T00:00:00Z'));
      recordHistory(c, { id: 'b', name: 'B', target: '1.2.3.4:27015' }, new Date('2026-01-02T00:00:00Z'));
      recordHistory(c, { id: 'a', name: 'A', target: '[A:1:1:1]' }, new Date('2026-01-03T00:00:00Z'));
    });
    const { history } = await loadClientConfig(home);
    assert.deepEqual(history.map((h) => h.name), ['A', 'B']);
    assert.equal(history[0]!.at, '2026-01-03T00:00:00.000Z');
  } finally {
    tmp.cleanup();
  }
});

test('corrupt config is reported, not silently replaced', async () => {
  const tmp = tempDir();
  try {
    mkdirSync(tmp.dir, { recursive: true });
    writeFileSync(join(tmp.dir, 'client.json'), '{nope');
    await assert.rejects(loadClientConfig(tmp.dir), /not valid JSON/);
  } finally {
    tmp.cleanup();
  }
});

test('master URL precedence: flag, env, config, default', () => {
  const config = { favorites: [], history: [], masterUrl: 'https://cfg.example' };
  assert.equal(resolveMasterUrl(config, 'https://flag.example/', { OPENCITADEL_MASTER: 'https://env.example' }), 'https://flag.example');
  assert.equal(resolveMasterUrl(config, undefined, { OPENCITADEL_MASTER: 'https://env.example' }), 'https://env.example');
  assert.equal(resolveMasterUrl(config, undefined, {}), 'https://cfg.example');
  assert.equal(resolveMasterUrl({ favorites: [], history: [] }, undefined, {}), DEFAULT_MASTER_URL);
  assert.throws(() => resolveMasterUrl(config, 'ftp://x', {}), /Invalid master URL/);
  assert.equal(clientHome({ OPENCITADEL_HOME: '/tmp/x' }), '/tmp/x');
});

test('tables align and truncate; styling honours NO_COLOR', () => {
  assert.equal(table(['A', 'NUM'], [['xx', '1'], ['y', '100']], ['l', 'r']), 'A   NUM\nxx    1\ny   100');
  assert.equal(truncate('abcdefgh', 5), 'abcd…');
  const style = makeStyle({ isTTY: true }, { NO_COLOR: '1' });
  assert.equal(style.bold('x'), 'x');
  assert.equal(makeStyle({ isTTY: true }, {}).bold('x'), '\x1b[1mx\x1b[22m');
  assert.equal(makeStyle({ isTTY: false }, {}).bold('x'), 'x');
});

test('server list and detail formatting', () => {
  const s = serverDetail({ name: 'A very long server name that keeps going and going forever', passworded: true, requiresContent: true, modded: true, verified: true });
  const out = formatServerList([s, serverDetail({ id: 'second', players: 12 })], { pings: { [s.id]: 42, second: null }, favorites: ['second'] });
  const lines = out.split('\n');
  assert.match(lines[0]!, /^ID\s+NAME\s+MAP\s+PLAYERS\s+REGION\s+PING\s+FLAGS$/);
  assert.match(lines[1]!, /A very long server name that keeps goin…/);
  assert.match(lines[1]!, /42ms\s+locked,content,verified$/);
  assert.match(lines[2]!, /★ Test Server/);
  assert.match(lines[2]!, /12\/12/);
  assert.match(lines[2]!, /—/);
  assert.equal(formatServerList([]), 'No servers match.');

  const detail = formatServerDetail(
    serverDetail({
      playerList: [{ name: 'Alice', hero: 'Haze', team: 2, kills: 5, deaths: 1, assists: 3 }],
      plugins: [{ id: 'welcome', version: '1.0.0', kind: 'host' }],
      content: [{ name: 'arena', kind: 'map', sha256: 'a'.repeat(64), size: 1536, url: 'https://x.example/a.vpk' }],
      metadata: { rotation: 'midtown → hideout' },
    }),
  );
  assert.match(detail, /Connect\s+\[A:1:123:456\]/);
  assert.match(detail, /Alice\s+Haze\s+2\s+5\/1\/3/);
  assert.match(detail, /welcome\s+1\.0\.0\s+host/);
  assert.match(detail, /arena\s+map\s+1\.5 KB/);
  assert.match(detail, /rotation\s+midtown → hideout/);
});
