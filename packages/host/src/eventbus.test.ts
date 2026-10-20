import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from './eventbus.js';
import { HostServicesImpl, sanitizeChat, toSteamId64 } from './host-services.js';
import { parseHostConfig } from './config.js';
import { initialState } from './state.js';

function recorder(bus: EventBus) {
  const seen: Array<[string, unknown, string]> = [];
  bus.on((e, p, s) => seen.push([e, p, s]));
  return seen;
}

test('presence dedupes joins across sources and enriches known players', () => {
  const bus = new EventBus();
  const seen = recorder(bus);
  bus.setLive('rcon', true);
  bus.reconcile('rcon', [{ name: 'Alice', slot: 2, ping: 30 }]);
  bus.publish('log', 'player.connected', { player: { name: 'alice', steamId: '[U:1:5]' } });
  assert.deepEqual(seen.map((s) => s[0]), ['player.connected']);
  assert.equal(bus.players()[0]!.steamId, '[U:1:5]', 'log detail merged into the rcon-announced player');

  bus.reconcile('rcon', [{ name: 'Alice', slot: 2, ping: 40 }]);
  assert.equal(seen.length, 1, 'same roster emits nothing');
  assert.equal(bus.players()[0]!.ping, 40);

  bus.reconcile('rcon', []);
  assert.deepEqual(seen.map((s) => s[0]), ['player.connected', 'player.disconnected']);
  assert.equal((seen[1]![1] as { player: { steamId: string } }).player.steamId, '[U:1:5]');

  // RCON never reports chat, so log chat still flows while RCON is live.
  assert.equal(bus.publish('log', 'chat.message', { player: { name: 'Alice' }, message: 'gg', teamOnly: false }), true);
});

test('higher-priority sources silence lower ones for players and chat', () => {
  const bus = new EventBus();
  const seen = recorder(bus);
  bus.setLive('rcon', true);
  bus.setLive('bridge', true);
  bus.reconcile('rcon', [{ name: 'Alice' }]);
  bus.publish('log', 'chat.message', { player: { name: 'Alice' }, message: 'hi', teamOnly: false });
  assert.equal(seen.length, 0);

  bus.publish('bridge', 'player.connected', { player: { name: 'Alice', slot: 1, steamId64: '76561197960287930' } });
  bus.publish('bridge', 'chat.message', { player: { name: 'Alice', slot: 1 }, message: 'hi', teamOnly: false });
  bus.publish('bridge', 'chat.message', { player: { name: 'Alice', slot: 1 }, message: 'hi', teamOnly: false });
  assert.deepEqual(seen.map((s) => [s[0], s[2]]), [['player.connected', 'bridge'], ['chat.message', 'bridge']]);
  assert.equal((seen[1]![1] as { player: { steamId64: string } }).player.steamId64, '76561197960287930', 'chat speaker filled from presence');

  // rcon still refreshes ping while the bridge is authoritative, without emitting.
  bus.reconcile('rcon', [{ name: 'Alice', ping: 99 }]);
  assert.equal(bus.players()[0]!.ping, 99);
  bus.setLive('bridge', false);
  bus.reconcile('rcon', []);
  assert.equal(seen.at(-1)![0], 'player.disconnected');
});

test('map changes and readiness fire once', () => {
  let now = 0;
  const bus = new EventBus(() => now);
  const seen = recorder(bus);
  bus.publish('log', 'map.changed', { map: 'dl_midtown' });
  bus.publish('rcon', 'map.changed', { map: 'dl_midtown' });
  bus.publish('log', 'server.ready', { map: 'dl_midtown' });
  bus.publish('rcon', 'server.ready', { map: 'dl_midtown' });
  bus.publish('rcon', 'map.changed', { map: 'dl_streets' });
  assert.deepEqual(seen.map((s) => s[0]), ['map.changed', 'server.ready', 'map.changed']);
  assert.deepEqual(seen[2]![1], { map: 'dl_streets', previous: 'dl_midtown' });

  bus.publish('log', 'chat.message', { player: { name: 'A' }, message: 'x', teamOnly: false });
  now += 2500;
  bus.publish('log', 'chat.message', { player: { name: 'A' }, message: 'x', teamOnly: false });
  assert.equal(seen.filter((s) => s[0] === 'chat.message').length, 2, 'repeats outside the window are new messages');

  bus.resetForLaunch();
  assert.equal(bus.currentMap(), undefined);
  assert.equal(bus.isLive('rcon'), false);
  assert.equal(bus.publish('log', 'server.ready', { map: 'x' }), true);
});

test('host services: chat sanitising, admins, channel selection', async () => {
  assert.equal(sanitizeChat('hi"; quit\nnow'), 'hi   quit now');
  assert.equal(toSteamId64('[U:1:22202]'), '76561197960287930');
  assert.equal(toSteamId64('STEAM_0:0:11101'), '76561197960287930');
  assert.equal(toSteamId64('76561197960287930'), '76561197960287930');
  assert.equal(toSteamId64('garbage'), undefined);

  const config = parseHostConfig({ admins: ['STEAM_0:0:11101'] });
  const sent: string[] = [];
  const state = { ...initialState('x', 12), phase: 'running' as const };
  const fakeRcon = { connected: true, command: async (c: string) => (sent.push(c), 'ok') };
  const services = new HostServicesImpl({ serverDir: '.', config: () => config, state: () => state, bridge: () => undefined, rcon: () => fakeRcon as never });
  assert.equal(services.isAdmin(undefined), true);
  assert.equal(services.isAdmin({ name: 'g', steamId: '[U:1:22202]' }), true);
  assert.equal(services.isAdmin({ name: 'g', steamId64: '76561197960287931' }), false);
  assert.equal(services.isAdmin({ name: 'nobody' }), false);
  await services.say('hello; quit');
  await services.tell({ name: 'Bob' }, 'psst');
  await services.kick({ name: 'Bob', slot: 4 }, 'afk');
  await services.kick({ name: 'Eve"' });
  // `say` goes unquoted (Deadlock shows quotes verbatim), with `;` stripped and `//` defused.
  await services.say('see https://discord.gg/x "now"');
  assert.deepEqual(sent, ['say hello  quit', 'say Bob: psst', 'kickid 4 "afk"', 'kick "Eve"', 'say see https:/​/discord.gg/x  now']);

  state.phase = 'stopped' as never;
  await assert.rejects(services.command('status'), /not running/);
});
