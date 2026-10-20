import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heartbeat, startMaster } from './testutil.js';

/** What Deadworks' ServerBrowser.cs sends (managed/ServerBrowser.cs BuildPayload). */
function dwHeartbeat(over: Record<string, unknown> = {}) {
  return {
    player_count: 2,
    max_players: 12,
    map: 'dl_midtown',
    game_mode: 'Normal',
    players: [
      { name: 'Haze main', hero: 'Haze', team: 2, kills: 4, deaths: 1, assists: 3, level: 9 },
      { name: 'Grey', hero: 'Grey Talon', team: 3, kills: 1, deaths: 4, assists: 0, level: 7 },
    ],
    mods: [{ name: 'DeathmatchPlugin', type: 'plugin', version: '1.0.0' }],
    content_addons: ['custom_hats'],
    extra_maps: [],
    name: 'DW Deathmatch',
    version: 'v0.6.1',
    port: 27015,
    ...over,
  };
}

test('Deadworks servers register, heartbeat and show up in both APIs', async () => {
  const m = await startMaster({ trustProxy: true });
  try {
    const xff = { 'x-forwarded-for': '203.0.113.9' };
    const reg = await m.api('POST', '/api/servers/register', { body: { name: 'DW Deathmatch', port: 27015, max_players: 12 }, headers: xff });
    assert.equal(reg.status, 201);
    assert.equal(typeof reg.json.id, 'string');
    assert.equal(typeof reg.json.token, 'string');
    const { id, token } = reg.json as { id: string; token: string };

    assert.equal((await m.api('POST', `/api/servers/${id}/heartbeat`, { body: dwHeartbeat(), token: 'nope', headers: xff })).status, 401);
    const hb = await m.api('POST', `/api/servers/${id}/heartbeat`, { body: dwHeartbeat(), token, headers: xff });
    assert.equal(hb.status, 200, hb.text);

    const dwList = await m.api('GET', '/api/servers');
    assert.equal(dwList.json.servers.length, 1);
    const s = dwList.json.servers[0];
    assert.equal(s.id, id);
    assert.equal(s.registered, true);
    assert.equal(s.address, '203.0.113.9:27015');
    assert.equal(s.raw_address, '203.0.113.9:27015');
    assert.equal(s.online, true);
    assert.equal(s.player_count, 2);
    assert.equal(s.max_players, 12);
    assert.equal(s.country, '');
    assert.deepEqual(s.mods, [{ name: 'DeathmatchPlugin', type: 'plugin', version: '1.0.0' }]);
    assert.deepEqual(s.content_addons, ['custom_hats']);
    // Player names are dropped by default (OPENCITADEL_DEADWORKS_PLAYER_NAMES); heroes and stats stay.
    assert.deepEqual(s.players[0], { name: '', hero: 'Haze', team: 2, kills: 4, deaths: 1, assists: 3, level: 9 });
    assert.equal(typeof s.last_heartbeat, 'string');

    assert.equal((await m.api('GET', `/api/servers/${id}`)).json.name, 'DW Deathmatch');
    assert.equal((await m.api('GET', '/api/servers/lookup?address=203.0.113.9:27015')).json.id, id);
    assert.equal((await m.api('GET', '/api/servers/lookup?address=203.0.113.9:27016')).status, 404);
    assert.equal((await m.api('GET', '/api/servers/lookup')).status, 400);
    assert.deepEqual((await m.api('GET', `/api/servers/${id}/content`)).json, { items: [] });

    const native = (await m.api('GET', '/v1/servers')).json.servers[0];
    assert.equal(native.source, 'deadworks');
    assert.deepEqual(native.software, { name: 'deadworks', version: 'v0.6.1' });
    assert.deepEqual(native.connect, { address: '203.0.113.9:27015' });
    assert.equal(native.gameMode, 'Normal');
    assert.equal(native.modded, true);
    assert.equal(native.requiresContent, true);
    const detail = (await m.api('GET', `/v1/servers/${id}`)).json;
    assert.equal(detail.plugins[0].kind, 'deadworks');
    assert.equal(detail.playerList[1].hero, 'Grey Talon');

    // A Deadworks lease is 240 s, longer than its default 90 s heartbeat.
    m.advance(200_000);
    assert.equal((await m.api('GET', '/api/servers')).json.servers.length, 1);
    m.advance(41_000);
    assert.equal((await m.api('GET', '/api/servers')).json.servers.length, 0);
    assert.equal((await m.api('GET', `/api/servers/${id}`)).json.online, false);

    // "Invalid" game modes and missing maps are tolerated.
    await m.api('POST', `/api/servers/${id}/heartbeat`, { body: dwHeartbeat({ game_mode: 'Invalid', map: '', mods: [], content_addons: [] }), token, headers: xff });
    const relisted = (await m.api('GET', `/v1/servers/${id}`)).json;
    assert.equal(relisted.gameMode, undefined);
    assert.equal(relisted.map, 'unknown');
    assert.equal(relisted.modded, false);
  } finally {
    await m.close();
  }
});

test('Deadworks player names are kept only when the operator opts in', async () => {
  for (const keep of [false, true]) {
    const m = await startMaster({ trustProxy: true, deadworksPlayerNames: keep });
    try {
      const xff = { 'x-forwarded-for': '203.0.113.10' };
      const { id, token } = (await m.api('POST', '/api/servers/register', { body: { name: 'DW', port: 27015 }, headers: xff })).json as { id: string; token: string };
      assert.equal((await m.api('POST', `/api/servers/${id}/heartbeat`, { body: dwHeartbeat(), token, headers: xff })).status, 200);
      const expected = keep ? ['Haze main', 'Grey'] : ['', ''];
      const dw = (await m.api('GET', `/api/servers/${id}`)).json;
      assert.deepEqual(dw.players.map((p: { name: string }) => p.name), expected);
      assert.equal(dw.players[1].hero, 'Grey Talon');
      const native = (await m.api('GET', `/v1/servers/${id}`)).json;
      assert.deepEqual(native.playerList.map((p: { name: string }) => p.name), expected);
      assert.equal(native.players, 2, 'counts are kept either way');
      // Nothing with a name reached the database when names are off.
      const stored = m.master.store.listing(id)!.heartbeat.playerList.map((p) => p.name);
      assert.deepEqual(stored, expected);
    } finally {
      await m.close();
    }
  }
});

test('native listings appear in the Deadworks list only when directly joinable', async () => {
  const m = await startMaster();
  try {
    const key = await m.account('ocowner');
    const direct = await m.server(key, 'Direct');
    const sdr = await m.server(key, 'SDR only');
    const content = [{ name: 'arena', kind: 'map', sha256: 'ab'.repeat(32), size: 4096, url: 'https://master.example/v1/plugins/arena/0.1.0/files/arena.vpk' }];
    await m.api('POST', `/v1/servers/${direct.id}/heartbeat`, { body: heartbeat({ name: 'Direct', connect: { address: '198.51.100.4:27015', steamId: '[A:1:1:2]' }, content, country: 'DE' }), token: direct.token });
    await m.api('POST', `/v1/servers/${sdr.id}/heartbeat`, { body: heartbeat({ name: 'SDR only' }), token: sdr.token });

    const list = (await m.api('GET', '/api/servers')).json.servers;
    assert.deepEqual(list.map((s: { name: string }) => s.name), ['Direct']);
    assert.equal(list[0].country, 'DE');
    assert.deepEqual(list[0].extra_maps, ['arena']);
    const items = (await m.api('GET', `/api/servers/${direct.id}/content`)).json.items;
    assert.equal(items[0].filename, 'arena');
    assert.equal(items[0].kind, 'map');
    assert.equal(items[0].sha256, 'ab'.repeat(32));
    assert.equal(items[0].size, 4096);
    assert.equal(typeof items[0].version, 'number');
    assert.equal(items[0].download_url, content[0]!.url);
    assert.equal((await m.api('GET', `/api/servers/${sdr.id}`)).status, 404);
  } finally {
    await m.close();
  }
});

test('Deadworks registration respects closed registration and the compat switch', async () => {
  const closed = await startMaster({ registration: 'closed' });
  try {
    assert.equal((await closed.api('POST', '/api/servers/register', { body: { name: 'x', port: 27015, max_players: 12 } })).status, 403);
  } finally {
    await closed.close();
  }
  const off = await startMaster({ deadworksCompat: false });
  try {
    assert.equal((await off.api('GET', '/api/servers')).status, 404);
  } finally {
    await off.close();
  }
});
