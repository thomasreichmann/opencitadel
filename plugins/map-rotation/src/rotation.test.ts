import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CommandInvocation, CommandOptions, Player, PluginContext, PluginEvents, ServerState } from '@opencitadel/plugin-sdk';
import plugin, { nextMap, type RotationConfig } from './index.js';

function fakeContext(config: Partial<RotationConfig> = {}) {
  const handlers: Record<string, Array<(p: unknown) => unknown>> = {};
  const commands: Record<string, CommandOptions> = {};
  const store = new Map<string, unknown>();
  const metadata = new Map<string, string | undefined>();
  const said: string[] = [];
  const changes: string[] = [];
  const state: Pick<ServerState, 'phase' | 'map' | 'players'> = { phase: 'running', map: 'dl_midtown', players: [] };
  const ctx = {
    config: { maps: ['dl_midtown', 'dl_hideout', 'street_test'], emptyMinutes: 10, intervalMinutes: 0, rtvRatio: 0.5, ...config },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    server: {
      state,
      say: async (m: string) => void said.push(m),
      changeMap: async (m: string) => {
        changes.push(m);
        state.map = m;
      },
    },
    storage: { get: (k: string) => store.get(k), set: (k: string, v: unknown) => void store.set(k, v) },
    listing: { setMetadata: (k: string, v: string | undefined) => void metadata.set(k, v) },
    commands: { register: (name: string, o: CommandOptions) => ((commands[name] = o), { dispose() {} }) },
    on: (e: string, h: (p: unknown) => unknown) => ((handlers[e] ??= []).push(h), { dispose() {} }),
  } as unknown as PluginContext<RotationConfig>;
  const emit = async <E extends keyof PluginEvents>(e: E, p: PluginEvents[E]) => {
    for (const h of handlers[e] ?? []) await h(p);
  };
  const run = async (name: string, player: Player | undefined, args: string[] = [], isAdmin = false) => {
    const replies: string[] = [];
    const inv: CommandInvocation = { player, args, raw: args.join(' '), isAdmin, reply: async (m) => void replies.push(m) };
    await commands[name]!.handler(inv);
    return replies;
  };
  return { ctx, state, said, changes, store, metadata, emit, run };
}

const players = (n: number): Player[] => Array.from({ length: n }, (_, i) => ({ name: `P${i}`, steamId: `[U:1:${i + 1}]` }));

test('nextMap', () => {
  assert.equal(nextMap(['a', 'b', 'c'], 'b', 0), 'c');
  assert.equal(nextMap(['a', 'b', 'c'], 'c', 0), 'a');
  assert.equal(nextMap(['a', 'b'], 'zz', 0), 'b');
  assert.equal(nextMap(['a'], 'a', 0), undefined);
  assert.equal(nextMap([], 'a', 0), undefined);
});

test('rotates once after the server has been empty long enough', async () => {
  const f = fakeContext();
  await plugin.setup(f.ctx);
  assert.equal(f.metadata.get('nextMap'), 'dl_hideout');
  const t0 = 1_000_000;
  await f.emit('tick', { now: t0 });
  await f.emit('tick', { now: t0 + 9 * 60_000 });
  assert.deepEqual(f.changes, []);
  await f.emit('tick', { now: t0 + 10 * 60_000 });
  assert.deepEqual(f.changes, ['dl_hideout']);
  assert.equal(f.store.get('index'), 1);
  await f.emit('tick', { now: t0 + 30 * 60_000 });
  assert.deepEqual(f.changes, ['dl_hideout'], 'only once per empty spell');
  await f.emit('map.changed', { map: 'dl_hideout' });
  assert.equal(f.metadata.get('nextMap'), 'street_test');
});

test('scheduled rotation announces a minute ahead', async () => {
  const f = fakeContext({ intervalMinutes: 30 });
  await plugin.setup(f.ctx);
  f.state.players.push(...players(2));
  const t0 = Date.now();
  await f.emit('tick', { now: t0 + 28 * 60_000 });
  assert.deepEqual(f.said, []);
  await f.emit('tick', { now: t0 + 29 * 60_000 });
  assert.deepEqual(f.said, ['Next map: dl_hideout in 1 minute.']);
  await f.emit('tick', { now: t0 + 30 * 60_000 });
  assert.deepEqual(f.changes, ['dl_hideout']);
});

test('!rtv needs the configured share of players; votes reset on map change', async () => {
  const f = fakeContext({ rtvRatio: 0.5 });
  await plugin.setup(f.ctx);
  const [a, b, c, d] = players(4);
  f.state.players.push(a!, b!, c!, d!);
  await f.run('rtv', a);
  await f.run('rtv', a); // voting twice does not count twice
  assert.deepEqual(f.changes, []);
  assert.match(f.said.at(-1)!, /\(1\/2\)/);
  await f.emit('player.disconnected', { player: a! });
  await f.run('rtv', b);
  assert.deepEqual(f.changes, []);
  await f.run('rtv', c);
  assert.deepEqual(f.changes, ['dl_hideout']);
  assert.equal(f.said.at(-1), 'Vote passed! Changing map to dl_hideout.');
  assert.deepEqual(await f.run('rtv', undefined), ['Only players can vote.']);
});

test('!map and !nextmap', async () => {
  const f = fakeContext();
  await plugin.setup(f.ctx);
  assert.deepEqual(await f.run('nextmap', undefined), ['Next map: dl_hideout']);
  assert.deepEqual(await f.run('map', undefined, []), ['Usage: !map <name>']);
  assert.deepEqual(await f.run('map', undefined, ['bad;name']), ['Usage: !map <name>']);
  await f.run('map', undefined, ['street_test'], true);
  assert.deepEqual(f.changes, ['street_test']);
  assert.equal(f.store.get('index'), 2);
});
