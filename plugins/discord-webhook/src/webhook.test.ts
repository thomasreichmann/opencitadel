import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Player, PluginContext, PluginEvents } from '@opencitadel/plugin-sdk';
import plugin, { escapeMarkdown, packMessages, type WebhookConfig } from './index.js';

const URL_ = 'https://discord.com/api/webhooks/123/abc';

function fakeContext(config: Partial<WebhookConfig> = {}, respond: (n: number) => Response = () => new Response(null, { status: 204 })) {
  const handlers: Record<string, Array<(p: unknown) => unknown>> = {};
  const posts: Array<{ url: string; body: { content: string; username: string; allowed_mentions: unknown } }> = [];
  const warnings: string[] = [];
  const players: Player[] = [];
  const ctx = {
    config: { webhookUrl: URL_, events: ['server', 'players', 'maps'], relayChat: false, username: '', batchSeconds: 5, maxPerMinute: 20, ...config },
    log: { info() {}, debug() {}, warn: (m: string) => void warnings.push(m), error: (m: string) => void warnings.push(m) },
    server: { state: { hostname: 'My *Cool* Server', players, maxPlayers: 12 } },
    fetch: async (url: string, init: RequestInit) => {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return respond(posts.length);
    },
    on: (e: string, h: (p: unknown) => unknown) => ((handlers[e] ??= []).push(h), { dispose() {} }),
  } as unknown as PluginContext<WebhookConfig>;
  const emit = async <E extends keyof PluginEvents>(e: E, p: PluginEvents[E]) => {
    for (const h of handlers[e] ?? []) await h(p);
  };
  return { ctx, posts, warnings, players, emit, handlers };
}

test('escapes markdown and packs lines under the limit', () => {
  assert.equal(escapeMarkdown('*bold* _it_ `code` @everyone\nnext'), '\\*bold\\* \\_it\\_ \\`code\\` @everyone next');
  assert.deepEqual(packMessages(['a', 'b', 'c'], 3), ['a\nb', 'c']);
  assert.equal(packMessages(['x'.repeat(10)], 5)[0], 'xxxx…');
});

test('does nothing without a webhook URL', async () => {
  const f = fakeContext({ webhookUrl: '' });
  await plugin.setup(f.ctx);
  assert.deepEqual(Object.keys(f.handlers), []);
  assert.match(f.warnings[0]!, /No webhookUrl/);
});

test('batches events into one post per window, with mentions disabled', async () => {
  const f = fakeContext({ relayChat: true });
  await plugin.setup(f.ctx);
  const t = 1_000_000;
  await f.emit('server.ready', { map: 'dl_midtown' });
  f.players.push({ name: 'Ann' });
  await f.emit('player.connected', { player: { name: 'Ann' } });
  await f.emit('chat.message', { player: { name: 'Ann' }, message: 'gg @everyone', teamOnly: false });
  await f.emit('chat.message', { player: { name: 'Ann' }, message: 'secret plan', teamOnly: true });
  await f.emit('player.connected', { player: { name: 'Bot', bot: true } });
  await f.emit('tick', { now: t });
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0]!.url, URL_);
  assert.deepEqual(f.posts[0]!.body.allowed_mentions, { parse: [] });
  assert.equal(f.posts[0]!.body.username, 'My *Cool* Server');
  assert.deepEqual(f.posts[0]!.body.content.split('\n'), [
    ':green_circle: **My \\*Cool\\* Server** is up on `dl_midtown`',
    ':arrow_right: Ann joined (1/12)',
    ':speech_balloon: **Ann**: gg @everyone',
  ]);
  // Within the batch window nothing more is sent.
  await f.emit('player.disconnected', { player: { name: 'Ann' } });
  await f.emit('tick', { now: t + 2000 });
  assert.equal(f.posts.length, 1);
  await f.emit('tick', { now: t + 5000 });
  assert.equal(f.posts.length, 2);
  assert.equal(f.posts[1]!.body.content, ':arrow_left: Ann left');
});

test('respects maxPerMinute and Discord 429s', async () => {
  const f = fakeContext({ maxPerMinute: 2, batchSeconds: 1 }, (n) =>
    n === 3 ? new Response(JSON.stringify({ retry_after: 10 }), { status: 429 }) : new Response(null, { status: 204 }),
  );
  await plugin.setup(f.ctx);
  let t = 0;
  for (let i = 0; i < 4; i++) {
    await f.emit('map.changed', { map: `m${i}` });
    t += 1000;
    await f.emit('tick', { now: t });
  }
  assert.equal(f.posts.length, 2, 'capped at 2 per minute');
  t = 61_000;
  await f.emit('tick', { now: t });
  assert.equal(f.posts.length, 3, 'third post hits the 429');
  await f.emit('tick', { now: t + 5000 });
  assert.equal(f.posts.length, 3, 'paused for retry_after');
  await f.emit('tick', { now: t + 11_000 });
  assert.equal(f.posts.length, 4);
  assert.equal(f.posts[3]!.body.content, ':map: Map changed to `m2`\n:map: Map changed to `m3`');
});

test('server stop flushes immediately', async () => {
  const f = fakeContext();
  await plugin.setup(f.ctx);
  await f.emit('server.stopped', { code: 1, crashed: true });
  assert.equal(f.posts.length, 1);
  assert.match(f.posts[0]!.body.content, /crashed/);
});
