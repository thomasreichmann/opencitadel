/**
 * End-to-end: the real Supervisor driving the fake game (testing/fake-game.ts) through RCON,
 * console.log, the bridge, and a fake master. Nothing touches a real Deadlock install.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventName, Player, PluginEvents } from '@opencitadel/plugin-sdk';
import { hostPaths, parseHostConfig } from './config.js';
import type { PluginHost } from './services.js';
import { setLogSinks } from './logger.js';
import { readStateFile } from './state.js';
import { Supervisor } from './supervisor.js';
import { CFG_NAME } from './launch.js';
import { FAKE_GAME_SCRIPT, createFakeInstall, freePort } from './testing/fake-install.js';

setLogSinks([]);

class RecordingHost implements PluginHost {
  events: Array<[EventName, unknown]> = [];
  unloaded = false;
  async loadAll() {}
  async unloadAll() {
    this.unloaded = true;
  }
  async reload() {}
  emit<E extends EventName>(event: E, payload: PluginEvents[E]) {
    this.events.push([event, payload]);
  }
  async runConsoleCommand() {
    return false;
  }
  listingContributions() {
    return { tags: ['e2e'], gameMode: 'Test', metadata: { suite: 'supervisor' } };
  }
  loaded() {
    return [];
  }
  of<E extends EventName>(event: E): Array<PluginEvents[E]> {
    return this.events.filter(([e]) => e === event).map(([, p]) => p as PluginEvents[E]);
  }
}

interface Hit {
  url: string;
  body: Record<string, unknown> | undefined;
}

async function fakeMaster() {
  const hits: Hit[] = [];
  const server = createServer((req, res: ServerResponse) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      hits.push({ url: req.url!, body: data ? JSON.parse(data) : undefined });
      if (req.url!.endsWith('/offline')) {
        res.writeHead(204).end();
      } else {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, ttl: 90, interval: 30, verified: false }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { hits, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

// Generous: these tests drive real child processes and can be starved when the whole suite runs in parallel.
const until = async (what: string, cond: () => boolean, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

const TIMINGS = { rconRetryMs: 100, statusPollMs: 150, heartbeatMs: 100, stopTimeoutMs: 3000, backoffBaseMs: 150, tickMs: 100, stateWriteMs: 50, logPollMs: 25 };

async function setup(wrapperExtra: string[] = [], overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'oc-game-'));
  const serverDir = await mkdtemp(join(tmpdir(), 'oc-server-'));
  const layout = await createFakeInstall(root);
  const master = await fakeMaster();
  const config = parseHostConfig({
    name: 'E2E Server',
    game: { path: root, wrapper: ['node', FAKE_GAME_SCRIPT, ...wrapperExtra], port: await freePort() },
    rcon: { password: 'rcon-pw' },
    master: { url: master.url, serverId: 'srv1', token: 'ocs_t' },
    bridge: { enabled: true, port: await freePort() },
    privacy: { showPlayerNames: true },
    ...overrides,
  });
  const host = new RecordingHost();
  const sup = new Supervisor({ serverDir, config, gameRoot: root, createPluginHost: () => host, timings: TIMINGS });
  const cleanup = async () => {
    await sup.stop();
    await master.close();
    await rm(root, { recursive: true, force: true });
    await rm(serverDir, { recursive: true, force: true });
  };
  return { root, serverDir, layout, master, config, host, sup, cleanup };
}

const heartbeats = (hits: Hit[]) => hits.filter((h) => h.url === '/v1/servers/srv1/heartbeat').map((h) => h.body!);

test('supervisor runs, lists, survives a crash, and stops cleanly', async () => {
  process.env.FAKE_PLAYERS = 'PlayerOne,PlayerTwo';
  const { layout, master, host, sup, serverDir, cleanup } = await setup();
  try {
    await sup.start();

    await until('a heartbeat with steamId, map and both players', () =>
      heartbeats(master.hits).some((b) => typeof (b.connect as { steamId?: string }).steamId === 'string' && b.players === 2 && b.map === 'dl_midtown'),
    );
    const firstSteamId = sup.getState().steamId!;
    assert.match(firstSteamId, /^\[A:1:\d+:\d+\]$/);
    const hb = heartbeats(master.hits).at(-1)!;
    assert.deepEqual(hb.tags, ['e2e']);
    assert.equal(hb.gameMode, 'Test');
    assert.deepEqual((hb.playerList as Player[]).map((p) => p.name).sort(), ['PlayerOne', 'PlayerTwo']);

    assert.match(await readFile(layout.gameinfo, 'utf8'), /CreateListenSocketP2P\t2/, 'gameinfo patched before launch');
    assert.match(await readFile(join(layout.citadelDir, 'cfg', CFG_NAME), 'utf8'), /rcon_password "rcon-pw"/);
    assert.equal(sup.getState().phase, 'running');
    assert.equal(sup.getState().sources.rcon, true);
    assert.equal(sup.getState().sources.log, true);

    assert.equal(host.of('server.starting')[0]!.attempt, 1);
    assert.equal(host.of('server.ready').length, 1);
    assert.deepEqual(host.of('player.connected').map((e) => e.player.name).sort(), ['PlayerOne', 'PlayerTwo']);
    assert.ok(host.of('console.line').some((e) => e.line.includes('Gameserver logged on to Steam')));

    // Commands go over RCON; chat printed to the log comes back as a chat event.
    assert.equal(await sup.services.command('echo hi'), 'hi');
    await sup.services.command('_chat PlayerOne !hello world');
    await until('log chat event', () => host.of('chat.message').some((e) => e.message === '!hello world'));
    // The fake gives PlayerOne SteamID64 76561198000000002 = [U:1:39734274].
    assert.equal(host.of('chat.message')[0]!.player.steamId, '[U:1:39734274]');
    await sup.services.say('hello all');
    await until('say echoed', () => host.of('console.line').some((e) => e.line.includes('[All Chat][Console (0)]: hello all')));

    // A player leaving shows up on the next status poll.
    await sup.services.command('_leave PlayerTwo');
    await until('disconnect via status diff', () => host.of('player.disconnected').some((e) => e.player.name === 'PlayerTwo'));

    const stateFile = await readStateFile(hostPaths(serverDir).stateFile);
    assert.equal(stateFile?.phase, 'running');
    assert.equal(stateFile?.pid, process.pid);

    // Crash → restart with a new anonymous SteamID, republished in the listing. A command that
    // kills the server can't answer, so the RCON connection simply drops under it.
    await sup.services.command('_crash').catch((err: Error) => assert.match(err.message, /RCON connection closed/));
    await until('crash reported', () => host.of('server.stopped').some((e) => e.crashed));
    await until('relaunch', () => host.of('server.starting').length === 2);
    await until('new steamId listed', () => heartbeats(master.hits).some((b) => (b.connect as { steamId?: string }).steamId && (b.connect as { steamId: string }).steamId !== firstSteamId));
    assert.equal(sup.getState().phase, 'running');

    await sup.stop();
    assert.equal(master.hits.at(-1)!.url, '/v1/servers/srv1/offline');
    assert.deepEqual(host.of('server.stopped').at(-1), { code: 0, crashed: false });
    assert.equal(host.unloaded, true);
    assert.equal(sup.getState().phase, 'stopped');
    assert.equal((await readStateFile(hostPaths(serverDir).stateFile))?.phase, 'stopped');
  } finally {
    delete process.env.FAKE_PLAYERS;
    await cleanup();
  }
});

test('a finished match gets a fresh server, on the map a plugin picked', async () => {
  const { host, sup, cleanup } = await setup([], { bridge: { enabled: false }, restart: { afterMatchDelaySeconds: 1 } });
  try {
    await sup.start();
    await until('running over RCON', () => sup.getState().sources.rcon && sup.getState().map === 'dl_midtown');
    await sup.services.command('_endmatch');
    await until('match.ended', () => host.of('match.ended').length === 1);
    assert.deepEqual(host.of('match.ended')[0], { map: 'dl_midtown' });
    // Inside the post-game window a map change only picks the next map; the restart comes once.
    await sup.changeMap('dl_streets');
    assert.equal(host.of('server.starting').length, 1);
    await until('relaunch on the picked map', () => host.of('map.changed').some((e) => e.map === 'dl_streets'));
    assert.equal(host.of('server.starting').length, 2);
    assert.deepEqual(host.of('server.stopped'), [{ code: 0, crashed: false }]);

    // Outside it, a map change is a restart on the new map (never `changelevel`, which kills a
    // stock server), and later crash restarts keep that map.
    await until('running again', () => sup.getState().sources.rcon);
    await sup.changeMap('dl_hideout');
    await until('on dl_hideout', () => sup.getState().map === 'dl_hideout' && sup.getState().sources.rcon);
    assert.equal(host.of('server.stopped').filter((e) => e.crashed).length, 0);
    await sup.services.command('_crash').catch(() => {});
    await until('crash restart', () => host.of('server.starting').length === 4);
    await until('back on dl_hideout', () => host.of('map.changed').filter((e) => e.map === 'dl_hideout').length === 2);

    assert.ok(host.of('console.line').length > 0);
    assert.ok(!host.of('console.line').some((e) => e.line.includes('GetNumberOfConsoleInputEvents')), 'per-frame stdin noise is dropped');
  } finally {
    await cleanup();
  }
});

test('the in-game bridge is authoritative for players and chat', async () => {
  process.env.FAKE_BRIDGE_DELAY_MS = '150';
  const { host, sup, cleanup } = await setup(['--fake-bridge']);
  try {
    await sup.start();
    await until('bridge connected', () => sup.getState().sources.bridge);
    await until('BridgeBob joins', () => host.of('player.connected').some((e) => e.player.name === 'BridgeBob'));
    const bob = host.of('player.connected').find((e) => e.player.name === 'BridgeBob')!.player;
    assert.equal(bob.steamId64, '76561197960287930');
    assert.equal(bob.steamId, '[U:1:22202]');
    assert.equal(bob.hero, 'Haze');

    await until('bridge chat', () => host.of('chat.message').some((e) => e.message === '!help'));
    assert.equal(host.of('chat.message').find((e) => e.message === '!help')!.player.slot, 9);

    // PlayerOne is seen by both RCON and the bridge but announced once.
    await until('rcon live too', () => sup.getState().sources.rcon);
    assert.equal(host.of('player.connected').filter((e) => e.player.name === 'PlayerOne').length, 1);

    await sup.services.say('via bridge');
    await sup.services.tell({ name: 'PlayerOne', slot: 2 }, 'psst');
    assert.equal(await sup.services.command('echo through-bridge'), 'through-bridge');
    await until('bridge say + tell echoed', () =>
      host.of('console.line').some((e) => e.line.includes(': via bridge')) && host.of('console.line').some((e) => e.line.includes('[Private to 2]: psst')),
    );

    await until('BridgeBob leaves', () => host.of('player.disconnected').some((e) => e.player.name === 'BridgeBob'));
    assert.equal(host.of('player.disconnected').find((e) => e.player.name === 'BridgeBob')!.reason, 'Disconnect by user');
  } finally {
    delete process.env.FAKE_BRIDGE_DELAY_MS;
    await cleanup();
  }
});

test('a server that cannot start is retried with backoff and stops cleanly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oc-game-'));
  const serverDir = await mkdtemp(join(tmpdir(), 'oc-server-'));
  await createFakeInstall(root);
  const config = parseHostConfig({ game: { path: root, wrapper: [join(root, 'no-such-binary')], port: await freePort() }, bridge: { enabled: false }, rcon: { password: 'x' } });
  const host = new RecordingHost();
  const sup = new Supervisor({ serverDir, config, gameRoot: root, createPluginHost: () => host, timings: { ...TIMINGS, backoffBaseMs: 50 } });
  try {
    await sup.start();
    await until('two failed attempts', () => host.of('server.starting').length >= 2);
    assert.ok(host.of('server.stopped').every((e) => e.crashed));
  } finally {
    await sup.stop();
    await rm(root, { recursive: true, force: true });
    await rm(serverDir, { recursive: true, force: true });
  }
  assert.equal(sup.getState().phase, 'stopped');
});
