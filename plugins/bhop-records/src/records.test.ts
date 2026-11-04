import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CommandInvocation, CommandOptions, Player, PluginContext, PluginEvents } from '@opencitadel/plugin-sdk';
import plugin, { formatTime, parseRun, submit, type BhopRecordsConfig, type RunFinished } from './index.js';

const run = (steamId64: string, time: number, name = `p${steamId64}`): RunFinished => ({
  map: 'bhop_eazy', style: 'exact aa1000', steamId64, name, time, jumps: 40, maxSpeed: 600, track: 0,
});

function fakeContext(config: Partial<BhopRecordsConfig> = {}) {
  const handlers: Record<string, Array<(p: unknown) => unknown>> = {};
  const commands: Record<string, CommandOptions> = {};
  const store = new Map<string, unknown>();
  const metadata = new Map<string, string | undefined>();
  const said: string[] = [];
  const posts: string[] = [];
  let gameMode: string | undefined;
  const ctx = {
    config: { announce: 'records', webhookUrl: '', leaderboardSize: 100, ...config },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    server: { state: { map: 'bhop_eazy', players: [] }, say: async (m: string) => void said.push(m) },
    storage: { get: (k: string) => store.get(k), set: (k: string, v: unknown) => void store.set(k, v) },
    listing: {
      setMetadata: (k: string, v: string | undefined) => void metadata.set(k, v),
      setGameMode: (m: string) => void (gameMode = m),
      setTags: () => {},
    },
    commands: { register: (name: string, o: CommandOptions) => ((commands[name] = o), { dispose() {} }) },
    on: (e: string, h: (p: unknown) => unknown) => ((handlers[e] ??= []).push(h), { dispose() {} }),
    fetch: async (_url: string, init: { body: string }) => {
      posts.push(JSON.parse(init.body).content);
      return { ok: true, status: 204 } as Response;
    },
  } as unknown as PluginContext<BhopRecordsConfig>;
  const emit = async <E extends keyof PluginEvents>(e: E, p: PluginEvents[E]) => {
    for (const h of handlers[e] ?? []) await h(p);
  };
  const finish = (r: RunFinished) => emit('game.event', { name: 'bhop.run_finished', data: { ...r } });
  const command = async (name: string, player?: Player) => {
    const replies: string[] = [];
    const inv: CommandInvocation = { player, args: [], raw: '', isAdmin: false, reply: async (m) => void replies.push(m) };
    await commands[name]!.handler(inv);
    return replies;
  };
  return { ctx, said, posts, metadata, store, finish, command, gameMode: () => gameMode };
}

test('submit keeps the best time per player, fastest first', () => {
  let board = submit([], run('1', 30), 1, 100).board;
  board = submit(board, run('2', 25), 2, 100).board;
  const slower = submit(board, run('1', 35), 3, 100);
  assert.equal(slower.result.personalBest, false);
  assert.equal(slower.result.rank, 2);
  const faster = submit(slower.board, run('1', 20), 4, 100);
  assert.equal(faster.result.mapRecord, true);
  assert.equal(faster.result.previousRecord?.steamId64, '2');
  assert.deepEqual(faster.board.map((e) => [e.steamId64, e.time]), [['1', 20], ['2', 25]]);
});

test('submit trims the board to its size', () => {
  let board = submit([], run('1', 10), 1, 2).board;
  board = submit(board, run('2', 11), 2, 2).board;
  const third = submit(board, run('3', 12), 3, 2);
  assert.equal(third.board.length, 2);
  assert.equal(third.result.rank, 0);
});

test('parseRun rejects malformed events', () => {
  assert.equal(parseRun({ ...run('1', 30), map: '../etc' }), undefined);
  assert.equal(parseRun({ ...run('1', 30), time: -1 }), undefined);
  assert.equal(parseRun({ ...run('x', 30) }), undefined);
  assert.equal(parseRun({ ...run('1', 30) })?.time, 30);
});

test('formatTime', () => {
  assert.equal(formatTime(83.4567), '1:23.457');
  assert.equal(formatTime(3725.25), '1:02:05.250');
});

test('announces map records, lists them, and posts them to Discord', async () => {
  const f = fakeContext({ webhookUrl: 'https://discord.example/hook' });
  await plugin.setup(f.ctx);
  assert.equal(f.gameMode(), 'Bhop');
  await f.finish(run('1', 30, 'Ann'));
  await f.finish(run('2', 31, 'Bob'));
  assert.deepEqual(f.said, ['New bhop_eazy record: 0:30.000 by Ann']);
  assert.equal(f.metadata.get('bhopRecord'), '0:30.000 by Ann');
  await f.finish(run('2', 29.5, 'Bob'));
  assert.match(f.said[1]!, /0:29\.500 by Bob \(beat Ann by 0:00\.500\)/);
  assert.equal(f.posts.length, 2);
  assert.match(f.posts[1]!, /\*\*Bob\*\* set the `bhop_eazy` record/);
});

test('bonus runs have their own board and leave the main record alone', async () => {
  const f = fakeContext();
  await plugin.setup(f.ctx);
  await f.finish(run('1', 30, 'Ann'));
  await f.finish({ ...run('2', 12, 'Bob'), style: 'exact aa1000 bonus 1', track: 1 });
  assert.deepEqual(f.said, ['New bhop_eazy record: 0:30.000 by Ann', 'New bhop_eazy bonus 1 record: 0:12.000 by Bob']);
  // The listing and !wr keep showing the main course.
  assert.equal(f.metadata.get('bhopRecord'), '0:30.000 by Ann');
  assert.deepEqual(await f.command('wr'), ['bhop_eazy record: 0:30.000 by Ann']);
  // Events from before tracks existed count as the main course.
  const { track: _, ...old } = run('3', 20);
  assert.equal(parseRun(old)?.track, 0);
});

test('!wr and !pb answer from the board', async () => {
  const f = fakeContext();
  await plugin.setup(f.ctx);
  await f.finish(run('1', 30, 'Ann'));
  await f.finish(run('2', 40, 'Bob'));
  assert.deepEqual(await f.command('wr'), ['bhop_eazy record: 0:30.000 by Ann']);
  const bob: Player = { slot: 2, name: 'Bob', steamId64: '2', bot: false } as Player;
  assert.deepEqual(await f.command('pb', bob), ['Your best on bhop_eazy: 0:40.000, rank 2 of 2.']);
});
