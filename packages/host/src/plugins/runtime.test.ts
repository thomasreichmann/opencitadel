import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseHostConfig, saveHostConfig, type HostConfig } from '../config.js';
import { PluginRuntime } from './runtime.js';
import { fakeServices, tempServerDir, writeLocalPlugin, type FakeServices } from './testing.js';
import { parseCommand, tokenize } from './commands.js';

// Plugins report back through this global so tests can observe them.
declare global {
  // eslint-disable-next-line no-var
  var __oc: Record<string, unknown[]>;
}
const record = (key: string) => (globalThis.__oc[key] ??= []);

// These tests observe plugins through a shared global, so they run plugins unsandboxed; the same
// behaviour inside the sandbox is covered by sandbox.test.ts.
function config(plugins: Record<string, unknown>): HostConfig {
  return parseHostConfig({ plugins: Object.fromEntries(Object.entries(plugins).map(([id, s]) => [id, { sandbox: false, ...(s as object) }])) });
}

async function setup(plugins: Record<string, unknown>, fn: (rt: PluginRuntime, svc: FakeServices, dir: string) => Promise<void>, opts = {}) {
  const tmp = tempServerDir();
  globalThis.__oc = {};
  const svc = fakeServices(tmp.dir);
  const rt = new PluginRuntime(svc, config(plugins), { storageDebounceMs: 10, ...opts });
  try {
    await fn(rt, svc, tmp.dir);
  } finally {
    await rt.unloadAll();
    await tmp.cleanup();
  }
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test('tokenize and parseCommand', () => {
  assert.deepEqual(tokenize(`kick "John Doe" 'bad  manners' x`), ['kick', 'John Doe', 'bad  manners', 'x']);
  assert.deepEqual(tokenize('say "a \\"quoted\\" word" ""'), ['say', 'a "quoted" word', '']);
  assert.deepEqual(parseCommand('!Map  dl_midtown now'), { name: 'map', raw: 'dl_midtown now', args: ['dl_midtown', 'now'] });
  assert.deepEqual(parseCommand('/rtv'), { name: 'rtv', raw: '', args: [] });
  assert.equal(parseCommand('hello !map'), undefined);
  assert.equal(parseCommand('!'), undefined);
});

test('loads enabled plugins with config defaults; skips disabled ones', async () => {
  await setup({ alpha: { config: { greeting: 'yo' } }, bravo: { enabled: false } }, async (rt, svc, dir) => {
    await writeLocalPlugin(dir, 'alpha', `export default { setup(ctx) { globalThis.__oc.alpha = [ctx.config, ctx.id, ctx.version, ctx.dataDir]; } };`, {
      config: { greeting: { type: 'string', default: 'hi' }, count: { type: 'integer', default: 3 } },
    });
    await writeLocalPlugin(dir, 'bravo', `export default { setup() { globalThis.__oc.bravo = [1]; } };`);
    await rt.loadAll();
    assert.deepEqual(rt.loaded(), [{ id: 'alpha', version: '1.0.0' }]);
    const [cfg, id, version, dataDir] = globalThis.__oc.alpha as [Record<string, unknown>, string, string, string];
    assert.deepEqual(cfg, { greeting: 'yo', count: 3 });
    assert.equal(id, 'alpha');
    assert.equal(version, '1.0.0');
    assert.ok(existsSync(dataDir));
    assert.equal(globalThis.__oc.bravo, undefined);
    assert.equal(svc.logged('', 'error').length, 0);
  });
});

test('permissions are enforced on the context', async () => {
  await setup({ quiet: {}, loud: {} }, async (rt, svc, dir) => {
    const probe = `
      const out = [];
      const tryIt = (name, fn) => { try { fn(); out.push(name + ':ok'); } catch (e) { out.push(name + ':' + e.name + ':' + e.permission); } };
      tryIt('say', () => ctx.server.say('hi'));
      tryIt('command', () => ctx.server.command('status'));
      tryIt('kick', () => ctx.server.kick({ name: 'x' }));
      tryIt('tags', () => ctx.listing.setTags(['a']));
      tryIt('storage', () => ctx.storage.set('k', 1));
      tryIt('fetch', () => ctx.fetch('http://127.0.0.1:1/').catch(() => {}));
      tryIt('state', () => ctx.server.state.map);
      globalThis.__oc[ctx.id] = out;`;
    await writeLocalPlugin(dir, 'quiet', `export default { setup(ctx) { ${probe} } };`);
    await writeLocalPlugin(dir, 'loud', `export default { setup(ctx) { ${probe} } };`, {
      permissions: ['server.chat', 'server.command', 'players.manage', 'listing.write', 'storage', 'network'],
    });
    await rt.loadAll();
    assert.deepEqual(globalThis.__oc.quiet, [
      'say:PermissionError:server.chat',
      'command:PermissionError:server.command',
      'kick:PermissionError:players.manage',
      'tags:PermissionError:listing.write',
      'storage:PermissionError:storage',
      'fetch:PermissionError:network',
      'state:ok',
    ]);
    assert.ok((globalThis.__oc.loud as string[]).every((s) => s.endsWith(':ok')));
    assert.deepEqual(svc.says, ['hi']);
    assert.deepEqual(svc.commands, ['status']);
  });
});

test('events fan out; a throwing plugin does not affect others', async () => {
  await setup({ bad: {}, good: {} }, async (rt, svc, dir) => {
    await writeLocalPlugin(dir, 'bad', `export default { setup(ctx) {
      ctx.on('player.connected', () => { throw new Error('boom'); });
      ctx.on('player.connected', async () => { throw new Error('async boom'); });
    } };`);
    await writeLocalPlugin(dir, 'good', `export default { setup(ctx) {
      ctx.on('player.connected', ({ player }) => { globalThis.__oc.good.push(player.name); });
    } };`);
    globalThis.__oc.good = [];
    await rt.loadAll();
    rt.emit('player.connected', { player: { name: 'Alice' } });
    rt.emit('player.connected', { player: { name: 'Bob' } });
    await tick();
    assert.deepEqual(globalThis.__oc.good, ['Alice', 'Bob']);
    assert.equal(svc.logged('threw: boom', 'error').length, 2);
    assert.equal(svc.logged('failed: async boom', 'error').length, 2);
  });
});

test('slow handlers are reported', async () => {
  await setup(
    { slow: {} },
    async (rt, svc, dir) => {
      await writeLocalPlugin(dir, 'slow', `export default { setup(ctx) { ctx.on('tick', () => new Promise((r) => setTimeout(r, 80))); } };`);
      await rt.loadAll();
      rt.emit('tick', { now: Date.now() });
      await tick(120);
      assert.equal(svc.logged('has not finished after 30 ms', 'warn').length, 1);
    },
    { slowHandlerMs: 30 },
  );
});

test('chat commands: dispatch, quoting, aliases, admin access and help', async () => {
  await setup({ cmds: {} }, async (rt, svc, dir) => {
    await writeLocalPlugin(dir, 'cmds', `export default { setup(ctx) {
      ctx.commands.register('greet', { description: 'Greets', aliases: ['hi'], handler: async (c) => { globalThis.__oc.greet.push(c.args); await c.reply('hello ' + c.args[0]); } });
      ctx.commands.register('ban', { description: 'Bans', access: 'admin', handler: (c) => { globalThis.__oc.ban.push(c.raw); } });
      ctx.commands.register('oops', { handler: () => { throw new Error('nope'); } });
      ctx.commands.register('help', { handler: () => {} });
    } };`);
    globalThis.__oc.greet = [];
    globalThis.__oc.ban = [];
    await rt.loadAll();
    const pleb = { name: 'Pleb', steamId: '[U:1:1]' };
    const admin = { name: 'Boss', steamId: '[U:1:2]' };
    svc.admins.add('[U:1:2]');

    rt.emit('chat.message', { player: pleb, message: '!greet "John Doe" now', teamOnly: false });
    rt.emit('chat.message', { player: pleb, message: '/hi you', teamOnly: false });
    rt.emit('chat.message', { player: pleb, message: '!ban Someone', teamOnly: false });
    rt.emit('chat.message', { player: admin, message: '!ban Someone else', teamOnly: false });
    rt.emit('chat.message', { player: pleb, message: '!oops', teamOnly: false });
    rt.emit('chat.message', { player: pleb, message: '!unknown', teamOnly: false });
    rt.emit('chat.message', { player: pleb, message: 'just chatting', teamOnly: false });
    await tick();
    assert.deepEqual(globalThis.__oc.greet, [['John Doe', 'now'], ['you']]);
    assert.deepEqual(globalThis.__oc.ban, ['Someone else']);
    const told = svc.tells.map((t) => `${t.player.name}: ${t.message}`);
    assert.ok(told.includes('Pleb: hello John Doe'));
    assert.ok(told.includes('Pleb: !ban is for admins only.'));
    assert.ok(told.includes('Pleb: Something went wrong running !oops.'));
    assert.equal(svc.logged('!help is built in', 'warn').length, 1);

    svc.tells.length = 0;
    rt.emit('chat.message', { player: pleb, message: '!help', teamOnly: false });
    rt.emit('chat.message', { player: admin, message: '!help', teamOnly: false });
    rt.emit('chat.message', { player: pleb, message: '!help hi', teamOnly: false });
    await tick();
    assert.deepEqual(svc.tells.map((t) => t.message), ['Commands: !greet, !oops', 'Commands: !ban, !greet, !oops', '!greet (also !hi): Greets']);

    assert.equal(await rt.runConsoleCommand('!ban ConsoleTarget'), true);
    assert.equal(await rt.runConsoleCommand('greet console'), true);
    assert.equal(await rt.runConsoleCommand('status'), false);
    assert.deepEqual(globalThis.__oc.ban, ['Someone else', 'ConsoleTarget']);
  });
});

test('storage persists across reload and to disk', async () => {
  await setup({ store: {} }, async (rt, _svc, dir) => {
    await writeLocalPlugin(dir, 'store', `export default { setup(ctx) {
      const n = (ctx.storage.get('runs') ?? 0) + 1;
      ctx.storage.set('runs', n);
      ctx.storage.set('obj', { a: [1, 2] });
      globalThis.__oc.runs = [n, ctx.storage.keys().sort()];
    } };`, { permissions: ['storage'] });
    await rt.loadAll();
    assert.deepEqual(globalThis.__oc.runs, [1, ['obj', 'runs']]);
    await rt.reload('store');
    assert.deepEqual(globalThis.__oc.runs, [2, ['obj', 'runs']]);
    await rt.unloadAll();
    const saved = JSON.parse(readFileSync(join(dir, '.opencitadel', 'data', 'store', 'storage.json'), 'utf8'));
    assert.deepEqual(saved, { runs: 2, obj: { a: [1, 2] } });
  });
});

test('timers, handlers and commands are disposed on unload; cleanup runs', async () => {
  await setup({ timed: {} }, async (rt, _svc, dir) => {
    await writeLocalPlugin(dir, 'timed', `export default { setup(ctx) {
      ctx.timers.setInterval(() => globalThis.__oc.ticks.push(1), 5);
      ctx.timers.setTimeout(() => globalThis.__oc.late.push(1), 200);
      ctx.on('tick', () => globalThis.__oc.events.push(1));
      ctx.commands.register('ping', { handler: (c) => c.reply('pong') });
      return () => { globalThis.__oc.cleaned.push(1); };
    } };`);
    Object.assign(globalThis.__oc, { ticks: [], late: [], events: [], cleaned: [] });
    await rt.loadAll();
    await tick(40);
    assert.ok(globalThis.__oc.ticks!.length > 0);
    await rt.unloadAll();
    const ticks = globalThis.__oc.ticks!.length;
    rt.emit('tick', { now: 0 });
    await tick(250);
    assert.equal(globalThis.__oc.ticks!.length, ticks);
    assert.deepEqual(globalThis.__oc.late, []);
    assert.deepEqual(globalThis.__oc.events, []);
    assert.deepEqual(globalThis.__oc.cleaned, [1]);
    assert.equal(await rt.runConsoleCommand('!ping'), false);
  });
});

test('dependency ordering, missing and mismatched deps, cycles, failed deps', async () => {
  const plugins = Object.fromEntries(['core', 'addon', 'needs-missing', 'too-new', 'cyc-a', 'cyc-b', 'broken', 'on-broken'].map((id) => [id, {}]));
  await setup(plugins, async (rt, svc, dir) => {
    const loadedCode = `export default { setup(ctx) { globalThis.__oc.order.push(ctx.id); ctx.plugins.expose({ who: () => ctx.id }); } };`;
    globalThis.__oc.order = [];
    await writeLocalPlugin(dir, 'addon', `export default { setup(ctx) { globalThis.__oc.order.push(ctx.id); globalThis.__oc.api = [ctx.plugins.get('core').who()]; } };`, { dependencies: { core: '^1.0.0' } });
    await writeLocalPlugin(dir, 'core', loadedCode, { version: '1.4.0' });
    await writeLocalPlugin(dir, 'needs-missing', loadedCode, { dependencies: { ghost: '*' } });
    await writeLocalPlugin(dir, 'too-new', loadedCode, { dependencies: { core: '^2.0.0' } });
    await writeLocalPlugin(dir, 'cyc-a', loadedCode, { dependencies: { 'cyc-b': '*' } });
    await writeLocalPlugin(dir, 'cyc-b', loadedCode, { dependencies: { 'cyc-a': '*' } });
    await writeLocalPlugin(dir, 'broken', `export default { setup() { throw new Error('kaput'); } };`);
    await writeLocalPlugin(dir, 'on-broken', loadedCode, { dependencies: { broken: '*' } });
    await rt.loadAll();
    assert.deepEqual(globalThis.__oc.order, ['core', 'addon']);
    assert.deepEqual(globalThis.__oc.api, ['core']);
    const failed = rt.status().failed;
    assert.match(failed['needs-missing']!, /missing dependency "ghost"/);
    assert.match(failed['too-new']!, /needs core@\^2\.0\.0, but 1\.4\.0/);
    assert.match(failed['cyc-a']!, /dependency cycle/);
    assert.match(failed['cyc-b']!, /dependency cycle/);
    assert.match(failed.broken!, /setup\(\) threw: kaput/);
    assert.match(failed['on-broken']!, /dependency "broken" failed to load/);
    assert.ok(svc.logged('not loaded', 'error').length >= 6);
  });
});

test('engine range and bad exports are rejected; enabled-but-missing is reported', async () => {
  await setup({ old: {}, noexport: {}, ghost: {} }, async (rt, _svc, dir) => {
    await writeLocalPlugin(dir, 'old', `export default { setup() {} };`, { engines: { opencitadel: '>=99.0.0' } });
    await writeLocalPlugin(dir, 'noexport', `export const x = 1;`);
    await rt.loadAll();
    const failed = rt.status().failed;
    assert.match(failed.old!, /needs citadel-host >=99\.0\.0/);
    assert.match(failed.noexport!, /default export must be definePlugin/);
    assert.match(failed.ghost!, /not installed/);
    assert.deepEqual(rt.loaded(), []);
  });
});

test('listing contributions merge across plugins', async () => {
  await setup({ one: {}, two: {} }, async (rt, _svc, dir) => {
    await writeLocalPlugin(dir, 'one', `export default { setup(ctx) {
      ctx.listing.setTags(['Casual', 'modded']);
      ctx.listing.setGameMode('Deathmatch');
      for (let i = 0; i < 30; i++) ctx.listing.setMetadata('k' + i, 'v' + i);
      globalThis.__oc.one = [ctx.listing];
    } };`, { permissions: ['listing.write'] });
    await writeLocalPlugin(dir, 'two', `export default { setup(ctx) {
      ctx.listing.setTags(['modded', 'ranked']);
      ctx.listing.setGameMode('Arena');
      for (let i = 25; i < 35; i++) ctx.listing.setMetadata('k' + i, 'two' + i);
      globalThis.__oc.two = [ctx.listing];
    } };`, { permissions: ['listing.write'] });
    await rt.loadAll();
    let merged = rt.listingContributions();
    assert.deepEqual(merged.tags, ['casual', 'modded', 'ranked']);
    assert.equal(merged.gameMode, 'Arena');
    assert.equal(Object.keys(merged.metadata).length, 32);
    assert.equal(merged.metadata.k25, 'v25', 'earlier plugin keeps its key');
    // The most recent setter wins, and clearing falls back to the other plugin.
    (globalThis.__oc.one![0] as { setGameMode(m: string): void }).setGameMode('Brawl');
    assert.equal(rt.listingContributions().gameMode, 'Brawl');
    (globalThis.__oc.one![0] as { setGameMode(m?: string): void }).setGameMode(undefined);
    merged = rt.listingContributions();
    assert.equal(merged.gameMode, 'Arena');
    assert.throws(() => (globalThis.__oc.one![0] as { setTags(t: string[]): void }).setTags(['bad tag!']), /Invalid tag/);
  });
});

test('installed plugins can import @opencitadel/plugin-sdk; reload picks up new code and config', async () => {
  await setup({ sdk: { config: { word: 'first' } } }, async (rt, _svc, dir) => {
    const code = (marker: string) => `import { definePlugin, PLUGIN_BRAND } from '@opencitadel/plugin-sdk';
      export default definePlugin({ setup(ctx) { globalThis.__oc.sdk.push(['${marker}', ctx.config.word, PLUGIN_BRAND.toString()]); } });`;
    globalThis.__oc.sdk = [];
    // A plain .js entry: relies on the generated package.json for ESM and the SDK link.
    const pluginDir = await writeLocalPlugin(dir, 'sdk', code('v1'), { config: { word: { type: 'string' } } }, 'dist/index.js');
    await rt.loadAll();
    assert.deepEqual(globalThis.__oc.sdk, [['v1', 'first', 'Symbol(opencitadel.plugin)']]);

    await writeFile(join(pluginDir, 'dist', 'index.js'), code('v2'));
    await saveHostConfig(dir, config({ sdk: { config: { word: 'second' } } }));
    await rt.reload('sdk');
    assert.deepEqual(globalThis.__oc.sdk![1], ['v2', 'second', 'Symbol(opencitadel.plugin)']);

    await saveHostConfig(dir, config({ sdk: { enabled: false } }));
    await rt.reload();
    assert.deepEqual(rt.loaded(), []);
  });
});

test('reload of a dependency reloads its dependents', async () => {
  await setup({ base: {}, top: {} }, async (rt, _svc, dir) => {
    globalThis.__oc.events = [];
    await writeLocalPlugin(dir, 'base', `export default { setup(ctx) { globalThis.__oc.events.push('load ' + ctx.id); return () => globalThis.__oc.events.push('unload ' + ctx.id); } };`);
    await writeLocalPlugin(dir, 'top', `export default { setup(ctx) { globalThis.__oc.events.push('load ' + ctx.id); return () => globalThis.__oc.events.push('unload ' + ctx.id); } };`, { dependencies: { base: '*' } });
    await rt.loadAll();
    globalThis.__oc.events = [];
    await rt.reload('base');
    assert.deepEqual(globalThis.__oc.events, ['unload top', 'unload base', 'load base', 'load top']);
  });
});

test('findPlayer matches slot, SteamID and unique name prefix', async () => {
  const { findPlayer } = await import('./runtime.js');
  const players = [
    { slot: 2, name: 'Alice', steamId: '[U:1:10]', steamId64: '76561197960265738' },
    { slot: 3, name: 'Alfred', steamId: '[U:1:11]' },
    { slot: 4, name: 'Bob' },
  ];
  assert.equal(findPlayer(players, '#3')?.name, 'Alfred');
  assert.equal(findPlayer(players, '4')?.name, 'Bob');
  assert.equal(findPlayer(players, '[u:1:10]')?.name, 'Alice');
  assert.equal(findPlayer(players, '76561197960265738')?.name, 'Alice');
  assert.equal(findPlayer(players, 'bo')?.name, 'Bob');
  assert.equal(findPlayer(players, 'al'), undefined, 'ambiguous');
  assert.equal(findPlayer(players, 'alice')?.name, 'Alice');
});
