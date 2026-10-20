import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ServerState } from '@opencitadel/plugin-sdk';
import { parseHostConfig } from './config.js';
import { Heartbeater, buildHeartbeat } from './heartbeat.js';
import { createLogger, setLogSinks, type LogLevel } from './logger.js';
import { initialState } from './state.js';

const logs: Array<[LogLevel, string]> = [];
setLogSinks([(line, level) => logs.push([level, line])]);

interface Hit {
  method: string;
  url: string;
  auth?: string;
  body: unknown;
}

async function fakeMaster(handler: (hit: Hit, res: ServerResponse) => void) {
  const hits: Hit[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      const hit = { method: req.method!, url: req.url!, auth: req.headers.authorization, body: data ? JSON.parse(data) : undefined };
      hits.push(hit);
      handler(hit, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { hits, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

function runningState(over: Partial<ServerState> = {}): ServerState {
  return {
    ...initialState('host name', 12),
    phase: 'running',
    map: 'dl_streets',
    steamId: '[A:1:123:456]',
    players: [
      { name: 'Alice', team: 2, hero: 'Haze', connectedFor: 61.7 },
      { name: 'Bot', bot: true },
    ],
    ...over,
  };
}

test('buildHeartbeat merges config, state and contributions', () => {
  const config = parseHostConfig({ name: 'My Server', tags: ['casual'], region: 'eu-west', country: 'DE', game: { password: 'x' }, publicAddress: '203.0.113.5:27015' });
  const hb = buildHeartbeat(config, runningState(), { tags: ['Casual', 'deathmatch', 'BAD TAG'], gameMode: 'Deathmatch', metadata: { rotation: 'a,b', 'bad key!': 'x' } }, { plugins: [{ id: 'welcome', version: '1.0.0', kind: 'host' }], content: [] });
  assert.equal(hb.name, 'My Server');
  assert.equal(hb.map, 'dl_streets');
  assert.equal(hb.players, 1);
  assert.equal(hb.bots, 1);
  assert.equal(hb.passworded, true);
  assert.deepEqual(hb.tags, ['casual', 'deathmatch']);
  assert.equal(hb.gameMode, 'Deathmatch');
  assert.deepEqual({ ...hb.metadata }, { rotation: 'a,b' });
  assert.deepEqual(hb.connect, { steamId: '[A:1:123:456]', address: '203.0.113.5:27015' });
  // Names are private by default.
  assert.deepEqual(hb.playerList, [{ name: '', team: 2, hero: 'Haze', time: 61 }]);
  assert.equal(hb.software.name, 'citadel-host');
  assert.equal(hb.plugins[0]!.id, 'welcome');
  const shown = buildHeartbeat(parseHostConfig({ privacy: { showPlayerNames: true } }), runningState(), { tags: [], metadata: {} }, { plugins: [], content: [] });
  assert.deepEqual(shown.playerList, [{ name: 'Alice', team: 2, hero: 'Haze', time: 61 }]);
});

test('heartbeats are sent with the server token, then offline on stop', async () => {
  const master = await fakeMaster((hit, res) => {
    res.writeHead(hit.url.endsWith('/offline') ? 204 : 200, { 'content-type': 'application/json' });
    res.end(hit.url.endsWith('/offline') ? '' : JSON.stringify({ ok: true, ttl: 90, interval: 30, verified: false }));
  });
  const config = parseHostConfig({ master: { url: master.url, serverId: 'srv1', token: 'ocs_abc' } });
  let state = runningState({ steamId: undefined });
  const hb = new Heartbeater({
    config: () => config,
    state: () => state,
    contributions: () => ({ tags: [], metadata: {} }),
    installed: async () => ({ plugins: [], content: [] }),
    log: createLogger('heartbeat'),
    intervalMs: 50,
  });
  try {
    hb.start();
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(master.hits.length, 0, 'waits for a SteamID or public address');
    state = runningState();
    await until(() => master.hits.length >= 2);
    const first = master.hits[0]!;
    assert.equal(first.url, '/v1/servers/srv1/heartbeat');
    assert.equal(first.auth, 'Bearer ocs_abc');
    assert.equal((first.body as { connect: { steamId: string } }).connect.steamId, '[A:1:123:456]');
    await hb.stop();
    assert.equal(master.hits.at(-1)!.url, '/v1/servers/srv1/offline');
  } finally {
    await hb.stop();
    await master.close();
  }
});

test('a rejected token is reported clearly and retried slowly', async () => {
  const master = await fakeMaster((_hit, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'bad token' } }));
  });
  const config = parseHostConfig({ master: { url: master.url, serverId: 'srv1', token: 'ocs_bad' } });
  const hb = new Heartbeater({
    config: () => config,
    state: () => runningState(),
    contributions: () => ({ tags: [], metadata: {} }),
    installed: async () => ({ plugins: [], content: [] }),
    log: createLogger('heartbeat'),
    intervalMs: 20,
  });
  try {
    logs.length = 0;
    assert.equal(await hb.sendNow(), 'rejected');
    hb.start();
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(master.hits.length <= 2, `backs off after a 401 (saw ${master.hits.length} requests)`);
    assert.ok(logs.some(([level, line]) => level === 'error' && line.includes('rejected this server') && line.includes('citadel-host register')));
    await hb.stop();
    assert.ok(!master.hits.some((h) => h.url.endsWith('/offline')), 'never listed, so no offline call');
  } finally {
    await hb.stop();
    await master.close();
  }
});

test('unlisted or unregistered servers send nothing', async () => {
  let calls = 0;
  const hb = new Heartbeater({
    config: () => parseHostConfig({ master: { listed: false, serverId: 'x', token: 'y' } }),
    state: () => runningState(),
    contributions: () => ({ tags: [], metadata: {} }),
    installed: async () => ({ plugins: [], content: [] }),
    log: createLogger('heartbeat'),
    fetch: (async () => {
      calls++;
      return new Response('{}');
    }) as typeof fetch,
  });
  assert.equal(await hb.sendNow(), 'skipped');
  await hb.stop();
  assert.equal(calls, 0);
});
