import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CommandOptions, Player, PluginContext, PluginEvents } from '@opencitadel/plugin-sdk';
import plugin, { formatGreeting, type WelcomeConfig } from './index.js';

/** Just enough PluginContext for this plugin; timers run when `flushTimers()` is called. */
function fakeContext(config: WelcomeConfig) {
  const handlers: Record<string, Array<(p: unknown) => void>> = {};
  const commands: Record<string, CommandOptions> = {};
  const timers = new Set<() => void>();
  const told: string[] = [];
  const players: Player[] = [];
  const ctx = {
    config,
    server: {
      state: { hostname: 'Midtown Brawl', players },
      tell: async (p: Player, m: string) => void told.push(`${p.name}: ${m}`),
      findPlayer: (q: string) => players.find((p) => p.steamId === q || p.name === q),
    },
    timers: {
      setTimeout(fn: () => void) {
        timers.add(fn);
        return { dispose: () => timers.delete(fn) };
      },
    },
    commands: { register: (name: string, o: CommandOptions) => ((commands[name] = o), { dispose() {} }) },
    on: (e: string, h: (p: unknown) => void) => ((handlers[e] ??= []).push(h), { dispose() {} }),
  } as unknown as PluginContext<WelcomeConfig>;
  return {
    ctx,
    told,
    players,
    commands,
    emit: <E extends keyof PluginEvents>(e: E, p: PluginEvents[E]) => handlers[e]?.forEach((h) => h(p)),
    flushTimers: () => {
      for (const fn of [...timers]) {
        timers.delete(fn);
        fn();
      }
    },
  };
}

const config: WelcomeConfig = { message: 'Hi {name}, welcome to {server}!', delaySeconds: 10, rules: ['No griefing', 'Have fun'], discord: 'https://discord.gg/abc', regreetMinutes: 30 };

test('formats placeholders', () => {
  assert.equal(formatGreeting('{name}@{server} {name}', { name: 'Ann' }, 'S'), 'Ann@S Ann');
});

test('greets players who stay, once, after the delay', async () => {
  const f = fakeContext(config);
  await plugin.setup(f.ctx);
  const ann = { name: 'Ann', steamId: '[U:1:1]' };
  const bob = { name: 'Bob', steamId: '[U:1:2]' };
  f.players.push(ann);
  f.emit('player.connected', { player: ann });
  f.emit('player.connected', { player: ann }); // reconnect within the delay
  f.emit('player.connected', { player: bob });
  f.emit('player.disconnected', { player: bob });
  f.emit('player.connected', { player: { name: 'Botty', bot: true } });
  f.flushTimers();
  assert.deepEqual(f.told, ['Ann: Hi Ann, welcome to Midtown Brawl!']);

  // Leaving and rejoining soon after a greeting doesn't repeat it, unless regreetMinutes is 0.
  f.emit('player.disconnected', { player: ann });
  f.emit('player.connected', { player: ann });
  f.flushTimers();
  assert.equal(f.told.length, 1);
  const every = fakeContext({ ...config, regreetMinutes: 0 });
  await plugin.setup(every.ctx);
  every.players.push(ann);
  for (let i = 0; i < 2; i++) {
    every.emit('player.connected', { player: ann });
    every.flushTimers();
  }
  assert.equal(every.told.length, 2);
});

test('!rules and !discord', async () => {
  const f = fakeContext(config);
  await plugin.setup(f.ctx);
  const replies: string[] = [];
  const reply = async (m: string) => void replies.push(m);
  await f.commands.rules!.handler({ args: [], raw: '', isAdmin: false, reply });
  await f.commands.discord!.handler({ args: [], raw: '', isAdmin: false, reply });
  assert.deepEqual(replies, ['1. No griefing', '2. Have fun', 'Join us: https://discord.gg/abc']);

  const empty = fakeContext({ ...config, rules: [], discord: '' });
  await plugin.setup(empty.ctx);
  replies.length = 0;
  await empty.commands.rules!.handler({ args: [], raw: '', isAdmin: false, reply });
  await empty.commands.discord!.handler({ args: [], raw: '', isAdmin: false, reply });
  assert.deepEqual(replies, ['This server has no rules set. Be nice!', 'This server has no Discord set.']);
});
