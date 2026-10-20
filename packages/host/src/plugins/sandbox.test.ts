import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHostConfig } from '../config.js';
import type { PluginContext } from '@opencitadel/plugin-sdk';
import { PluginRuntime } from './runtime.js';
import { PluginSandbox } from './sandbox.js';
import { fakeServices, tempServerDir, writeLocalPlugin, type FakeServices } from './testing.js';

// Everything here runs sandboxed (the default) and observes plugins only through what reaches
// the host: logs, chat, commands. No shared globals: that is the point of the sandbox.

async function withRuntime(plugins: Record<string, unknown>, fn: (rt: PluginRuntime, svc: FakeServices, dir: string) => Promise<void>) {
  const tmp = tempServerDir('oc-sandbox-');
  const svc = fakeServices(tmp.dir);
  const rt = new PluginRuntime(svc, parseHostConfig({ plugins }), { storageDebounceMs: 10 });
  try {
    await fn(rt, svc, tmp.dir);
  } finally {
    await rt.unloadAll();
    await tmp.cleanup();
  }
}

const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const lines = (svc: FakeServices, text: string) => svc.logged(text).map((l) => l.message);

/** Plugins run on their own threads, so wait for an outcome instead of assuming one. */
async function until(what: string, cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await settle(10);
  }
}

test('a sandboxed plugin sees no Node, filesystem, process or raw network', async () => {
  await withRuntime({ probe: {} }, async (rt, svc, dir) => {
    await writeLocalPlugin(dir, 'probe', `export default { setup(ctx) {
      const kinds = ['require', 'process', 'Buffer', 'module', 'fetch', 'XMLHttpRequest', 'WebSocket', 'setTimeout', 'console']
        .map((n) => n + '=' + typeof globalThis[n]);
      ctx.log.info('globals ' + kinds.join(' '));
      ctx.log.info('host bridge hidden ' + (typeof globalThis.__ocHost === 'undefined'));
    } };`);
    await rt.loadAll();
    assert.deepEqual(rt.status().failed, {});
    assert.deepEqual(lines(svc, 'globals '), [
      'globals require=undefined process=undefined Buffer=undefined module=undefined fetch=undefined XMLHttpRequest=undefined WebSocket=undefined setTimeout=function console=object',
    ]);
    assert.deepEqual(lines(svc, 'host bridge hidden'), ['host bridge hidden true']);
  });
});

test('imports are confined to the package and the SDK', async () => {
  await withRuntime({ nodeish: {}, escapee: {}, bare: {}, tidy: {} }, async (rt, svc, dir) => {
    await writeLocalPlugin(dir, 'nodeish', `import { readFileSync } from 'node:fs'; export default { setup() {} };`);
    await writeLocalPlugin(dir, 'escapee', `import x from '../../../secret.js'; export default { setup() {} };`);
    await writeLocalPlugin(dir, 'bare', `import _ from 'lodash'; export default { setup() {} };`);
    const tidy = await writeLocalPlugin(dir, 'tidy', `import { definePlugin } from '@opencitadel/plugin-sdk'; import { greet } from './lib/greet.mjs';
      export default definePlugin({ setup(ctx) { ctx.log.info(greet('sandbox')); } });`);
    await mkdir(join(tidy, 'lib'), { recursive: true });
    await writeFile(join(tidy, 'lib', 'greet.mjs'), `export const greet = (n) => 'hello ' + n;`);
    await rt.loadAll();
    const failed = rt.status().failed;
    assert.match(failed.nodeish!, /Node\.js module.*"sandbox": false/);
    assert.match(failed.escapee!, /outside the plugin package/);
    assert.match(failed.bare!, /Bundle dependencies/);
    assert.deepEqual(rt.loaded().map((p) => p.id), ['tidy']);
    assert.deepEqual(lines(svc, 'hello '), ['hello sandbox']);
  });
});

test('permissions hold across the boundary, with the same sync/async shape as unsandboxed', async () => {
  const probe = `export default { setup(ctx) {
    const out = [];
    const tryIt = (name, fn) => { try { const r = fn(); out.push(name + ':ok'); if (r && r.catch) r.catch(() => {}); } catch (e) { out.push(name + ':' + e.name + ':' + e.permission); } };
    tryIt('say', () => ctx.server.say('hi'));
    tryIt('command', () => ctx.server.command('status'));
    tryIt('kick', () => ctx.server.kick({ name: 'x' }));
    tryIt('tags', () => ctx.listing.setTags(['a']));
    tryIt('storage', () => ctx.storage.set('k', 1));
    tryIt('fetch', () => ctx.fetch('https://example.org/'));
    tryIt('state', () => ctx.server.state.map);
    ctx.log.info('probe ' + ctx.id + ' ' + out.join(','));
  } };`;
  await withRuntime({ quiet: {}, loud: {} }, async (rt, svc, dir) => {
    await writeLocalPlugin(dir, 'quiet', probe);
    await writeLocalPlugin(dir, 'loud', probe.replace("ctx.fetch('https://example.org/')", "0"), {
      permissions: ['server.chat', 'server.command', 'players.manage', 'listing.write', 'storage'],
    });
    await rt.loadAll();
    await settle();
    assert.deepEqual(lines(svc, 'probe quiet'), [
      'probe quiet say:PermissionError:server.chat,command:PermissionError:server.command,kick:PermissionError:players.manage,tags:PermissionError:listing.write,storage:PermissionError:storage,fetch:PermissionError:network,state:ok',
    ]);
    assert.match(lines(svc, 'probe loud')[0]!, /^probe loud (\w+:ok,?)+$/);
    assert.deepEqual(svc.says, ['hi']);
    assert.deepEqual(svc.commands, ['status']);
  });
});

test('async round trips: commands, storage, cross-plugin calls, timers and cleanup', async () => {
  await withRuntime({ provider: {}, consumer: {} }, async (rt, svc, dir) => {
    await writeLocalPlugin(dir, 'provider', `export default { setup(ctx) {
      ctx.plugins.expose({ add: (a, b) => a + b, slow: async (n) => n * 2 });
    } };`);
    await writeLocalPlugin(
      dir,
      'consumer',
      `export default { setup(ctx) {
        ctx.commands.register('echo', { description: 'echo', handler: async (c) => {
          const out = await ctx.server.command('status');
          await c.reply(c.args.join('|') + ' / ' + out + ' / admin=' + c.isAdmin);
        } });
        ctx.storage.set('visits', (ctx.storage.get('visits') ?? 0) + 1);
        const api = ctx.plugins.get('provider');
        Promise.all([api.add(2, 3), api.slow(21)]).then(([a, b]) => ctx.log.info('remote ' + a + ' ' + b));
        const t = ctx.timers.setInterval(() => ctx.log.info('interval'), 10);
        setTimeout(() => ctx.log.info('global timeout'), 5);
        return () => { t.dispose(); ctx.log.info('cleanup ran, visits ' + ctx.storage.get('visits')); };
      } };`,
      { permissions: ['server.command', 'server.chat', 'storage'], dependencies: { provider: '*' } },
    );
    await rt.loadAll();
    await rt.runConsoleCommand('!echo a "b c"');
    await settle(60);
    assert.deepEqual(lines(svc, 'remote '), ['remote 5 42']);
    assert.ok(lines(svc, 'interval').length >= 2);
    assert.deepEqual(lines(svc, 'global timeout'), ['global timeout']);
    assert.deepEqual(lines(svc, 'a|b c'), ['a|b c / ran status / admin=true']);
    await rt.unloadAll();
    const ticks = lines(svc, 'interval').length;
    await settle(40);
    assert.equal(lines(svc, 'interval').length, ticks, 'timers stop when the plugin unloads');
    assert.deepEqual(lines(svc, 'cleanup ran'), ['cleanup ran, visits 1']);
  });
});

test('a plugin that spins is interrupted, then disabled; others keep working', async () => {
  await withRuntime({ spinner: { timeLimitMs: 50 }, steady: {} }, async (rt, svc, dir) => {
    await writeLocalPlugin(dir, 'spinner', `export default { setup(ctx) { ctx.on('tick', () => { for (;;) {} }); } };`);
    await writeLocalPlugin(dir, 'steady', `export default { setup(ctx) { ctx.on('tick', ({ now }) => ctx.log.info('steady ' + now)); } };`);
    await rt.loadAll();
    for (let i = 1; i <= 4; i++) {
      rt.emit('tick', { now: i });
      await settle(10);
    }
    // The steady plugin is answered right away, while the spinner is still burning its own thread.
    await until('steady to see every tick', () => lines(svc, 'steady ').length === 4, 1000);
    assert.deepEqual(lines(svc, 'steady '), ['steady 1', 'steady 2', 'steady 3', 'steady 4']);
    await until('the spinner to be shut off', () => rt.status().failed.spinner !== undefined);
    assert.equal(svc.logged('exceeded the 50 ms CPU limit', 'error').length, 3);
    assert.match(rt.status().failed.spinner!, /disabled until reloaded/);
    assert.deepEqual(rt.loaded().map((p) => p.id), ['steady']);
  });
});

test('a worker wedged in native code is terminated while the host keeps running', async () => {
  const tmp = tempServerDir('oc-sandbox-');
  const dir = await writeLocalPlugin(tmp.dir, 'wedge', `export default { setup() { globalThis.big = 'ab'.repeat(5e7); } };`);
  const svc = fakeServices(tmp.dir);
  const fatal: string[] = [];
  const sandbox = await PluginSandbox.create({
    id: 'wedge',
    dir,
    manifest: { id: 'wedge', name: 'wedge', version: '1.0.0', kind: 'host', main: 'index.mjs', description: '', tags: [], engines: {}, dependencies: {}, permissions: [], config: {} },
    limits: { timeLimitMs: 50, memoryMb: 512 },
    watchdogGraceMs: 100,
    log: svc.logger('plugin:wedge'),
    onFatal: (reason) => fatal.push(reason),
  });
  // Count host-thread timer ticks during the stall: they only fire if this thread is free.
  let ticks = 0;
  const ticker = setInterval(() => ticks++, 10);
  try {
    const ctx = { id: 'wedge', version: '1.0.0', config: {}, dataDir: tmp.dir, log: svc.logger('plugin:wedge') } as unknown as PluginContext;
    await assert.rejects(sandbox.definition().setup(ctx) as Promise<unknown>, /stopped responding/);
    assert.equal(fatal.length, 1);
    assert.match(fatal[0]!, /worker was terminated/);
    assert.ok(ticks >= 10, `the host thread kept running (${ticks} timer ticks during the stall)`);
  } finally {
    clearInterval(ticker);
    sandbox.dispose();
    await tmp.cleanup();
  }
});

test('runaway setup and memory hogs are contained', async () => {
  await withRuntime({ forever: { timeLimitMs: 50 }, hog: { memoryMb: 8 }, fine: {} }, async (rt, svc, dir) => {
    await writeLocalPlugin(dir, 'forever', `while (true) {} export default { setup() {} };`);
    await writeLocalPlugin(dir, 'hog', `export default { setup(ctx) { ctx.on('tick', () => { globalThis.keep = new Array(1e7).fill(1); }); } };`);
    await writeLocalPlugin(dir, 'fine', `export default { setup(ctx) { ctx.on('tick', () => ctx.log.info('still fine')); } };`);
    await rt.loadAll();
    assert.match(rt.status().failed.forever!, /CPU limit/);
    rt.emit('tick', { now: 1 });
    await settle();
    assert.equal(svc.logged('ran out of memory (limit 8 MB)', 'error').length, 1);
    assert.deepEqual(lines(svc, 'still fine'), ['still fine']);
    // Out-of-memory counts toward the same three strikes as the CPU limit.
    rt.emit('tick', { now: 2 });
    rt.emit('tick', { now: 3 });
    await settle();
    assert.equal(svc.logged('disabled until reloaded', 'error').length >= 1, true);
  });
});

test('fetch: private addresses are blocked unless allowed; bodies are capped', async () => {
  const server: Server = createServer((req, res) => {
    if (req.url === '/big') return res.end('x'.repeat(1024 * 1024 + 10));
    if (req.url === '/hop') return res.writeHead(302, { location: '/data' }).end();
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ hello: 'world' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const code = `export default { setup(ctx) {
    const go = (path) => ctx.fetch('${base}' + path).then(async (r) => ctx.log.info(ctx.id + ' ' + path + ' ' + r.status + ' ' + r.headers.get('content-type') + ' ' + JSON.stringify(await r.json()) + ' redirected=' + r.redirected),
      (e) => ctx.log.info(ctx.id + ' ' + path + ' error ' + e.message));
    go('/data'); go('/hop'); go('/big');
  } };`;
  try {
    await withRuntime({ strict: {}, local: { allowPrivateNetwork: true } }, async (rt, svc, dir) => {
      await writeLocalPlugin(dir, 'strict', code, { permissions: ['network'] });
      await writeLocalPlugin(dir, 'local', code, { permissions: ['network'] });
      await rt.loadAll();
      await settle(300);
      assert.match(lines(svc, 'strict /data')[0]!, /error fetch: 127\.0\.0\.1 is a private or local address/);
      assert.deepEqual(lines(svc, 'local /data'), ['local /data 200 application/json {"hello":"world"} redirected=false']);
      assert.deepEqual(lines(svc, 'local /hop'), ['local /hop 200 application/json {"hello":"world"} redirected=true']);
      assert.match(lines(svc, 'local /big')[0]!, /larger than 1048576 bytes/);
    });
  } finally {
    server.close();
  }
});

test('the example plugins run in the sandbox', async () => {
  const repo = fileURLToPath(new URL('../../../../', import.meta.url));
  const examples = ['welcome', 'map-rotation', 'discord-webhook'];
  const missing = examples.filter((id) => !existsSync(join(repo, 'plugins', id, 'dist', 'index.js')));
  if (missing.length) return assert.fail(`build the example plugins first (missing dist for ${missing.join(', ')})`);
  await withRuntime(
    {
      welcome: { config: { delaySeconds: 0 } },
      'map-rotation': { config: { maps: ['dl_midtown', 'dl_streets'] } },
      'discord-webhook': { config: { webhookUrl: '' } },
    },
    async (rt, svc, dir) => {
      for (const id of examples) {
        const target = join(dir, '.opencitadel', 'plugins', id);
        cpSync(join(repo, 'plugins', id, 'plugin.json'), join(target, 'plugin.json'));
        cpSync(join(repo, 'plugins', id, 'dist'), join(target, 'dist'), { recursive: true });
      }
      await rt.loadAll();
      assert.deepEqual(rt.status().failed, {});
      assert.deepEqual(rt.loaded().map((p) => p.id).sort(), [...examples].sort());
      rt.emit('player.connected', { player: { name: 'Ann', slot: 2 } });
      rt.emit('tick', { now: Date.now() });
      await settle(100);
      assert.ok(svc.tells.some((t) => t.message.includes('Ann')), 'welcome greeted the player from inside the sandbox');
      assert.equal(svc.logged('', 'error').length, 0, svc.logged('', 'error').map((l) => l.message).join('\n'));
    },
  );
});
