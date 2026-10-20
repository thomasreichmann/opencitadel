import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseManifest, unpackTarGz } from '@opencitadel/protocol';
import { parseHostConfig, pluginSettings, type HostConfig } from '../config.js';
import { runPackageCli, runPluginCli } from './cli.js';
import { installFromFile, sha256 } from './install.js';
import { packPlugin, packPluginToFile } from './pack.js';
import { PluginRuntime } from './runtime.js';
import { scaffoldPlugin } from './scaffold.js';
import { fakeServices, tempServerDir } from './testing.js';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const EXAMPLES = ['welcome', 'map-rotation', 'discord-webhook'];

for (const name of EXAMPLES) {
  test(`example plugin ${name} packs cleanly`, async () => {
    const dir = join(repo, 'plugins', name);
    assert.ok(existsSync(join(dir, 'dist', 'index.js')), `build plugins/${name} first`);
    const { manifest, archive, entries, sha256: digest } = await packPlugin(dir);
    assert.equal(manifest.id, name);
    assert.equal(digest, sha256(archive));
    assert.ok(entries.includes('plugin.json'));
    assert.ok(entries.includes('dist/index.js'));
    assert.ok(!entries.some((e) => /\.test\.js$|\.map$|\.d\.ts$|^src\/|tsbuildinfo/.test(e)), entries.join(', '));
    const files = unpackTarGz(archive);
    assert.deepEqual([...files.keys()].sort(), entries);
    assert.deepEqual(parseManifest(JSON.parse(files.get('plugin.json')!.toString())), manifest);
    // Reproducible: same inputs, same bytes.
    assert.equal((await packPlugin(dir)).sha256, digest);
  });
}

test('packed welcome plugin installs and greets through the runtime', async () => {
  const tmp = tempServerDir();
  try {
    const { file } = await packPluginToFile(join(repo, 'plugins', 'welcome'), join(tmp.dir, 'welcome.tgz'));
    await installFromFile(file, { serverDir: tmp.dir });
    const svc = fakeServices(tmp.dir);
    const config = parseHostConfig({ plugins: { welcome: { config: { delaySeconds: 0, message: 'Hey {name}, this is {server}' } } } });
    const rt = new PluginRuntime(svc, config);
    await rt.loadAll();
    assert.deepEqual(rt.status(), { loaded: [{ id: 'welcome', version: '0.1.0' }], failed: {} });
    const ann = { name: 'Ann', steamId: '[U:1:5]' };
    svc.state.players.push(ann);
    rt.emit('player.connected', { player: ann });
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(svc.tells.map((t) => t.message), ['Hey Ann, this is Test']);
    rt.emit('chat.message', { player: ann, message: '!discord', teamOnly: false });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(svc.tells.at(-1)!.message, 'This server has no Discord set.');
    await rt.unloadAll();
  } finally {
    await tmp.cleanup();
  }
});

test('pack refuses missing entry points, symlinks and non-VPK content', async () => {
  const tmp = tempServerDir();
  try {
    const hostDir = join(tmp.dir, 'h');
    await mkdir(join(hostDir, 'dist'), { recursive: true });
    await writeFile(join(hostDir, 'plugin.json'), JSON.stringify({ id: 'hhh', name: 'h', version: '1.0.0', kind: 'host', main: 'dist/index.js' }));
    await assert.rejects(packPlugin(hostDir), /did you build the plugin/);
    await writeFile(join(hostDir, 'dist', 'index.js'), 'export default { setup() {} };');
    await symlink('/etc/hostname', join(hostDir, 'dist', 'link.js'));
    await assert.rejects(packPlugin(hostDir), /symlink/);

    const contentDir = join(tmp.dir, 'c');
    await mkdir(contentDir, { recursive: true });
    await writeFile(join(contentDir, 'plugin.json'), JSON.stringify({ id: 'ccc', name: 'c', version: '1.0.0', kind: 'content', content: [{ file: 'pak01_dir.vpk' }] }));
    await writeFile(join(contentDir, 'pak01_dir.vpk'), 'not a vpk');
    await assert.rejects(packPlugin(contentDir), /not a VPK/);
  } finally {
    await tmp.cleanup();
  }
});

test('scaffolds each kind with a valid manifest', async () => {
  const tmp = tempServerDir();
  try {
    for (const kind of ['host', 'deadworks', 'content'] as const) {
      const dir = join(tmp.dir, `my-${kind}-plugin`);
      const files = await scaffoldPlugin(dir, { kind });
      assert.ok(files.includes('plugin.json') && files.includes('README.md'));
      const manifest = parseManifest(JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')));
      assert.equal(manifest.id, `my-${kind}-plugin`);
      assert.equal(manifest.kind, kind);
    }
    assert.ok(existsSync(join(tmp.dir, 'my-host-plugin', 'src', 'index.ts')));
    assert.ok(existsSync(join(tmp.dir, 'my-deadworks-plugin', 'MyDeadworksPlugin.csproj')));
    await assert.rejects(scaffoldPlugin(join(tmp.dir, 'my-host-plugin')), /not empty/);
    await assert.rejects(scaffoldPlugin(join(tmp.dir, 'X')), /not a valid plugin id/);
  } finally {
    await tmp.cleanup();
  }
});

test('plugin CLI: pack, install, list, disable/enable, remove, search, info, publish', async () => {
  const tmp = tempServerDir();
  const puts: Array<{ url: string; auth?: string; type?: string; body: Buffer }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (req.method === 'PUT') {
      puts.push({ url: req.url!, auth: req.headers.authorization, type: req.headers['content-type'], body: Buffer.concat(chunks) });
      res.writeHead(201, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url!.startsWith('/v1/plugins?')) {
      return res.end(JSON.stringify({ plugins: [{ id: 'welcome', name: 'Welcome', kind: 'host', description: 'Greets', latest: '0.1.0', owner: 'oc', tags: [], downloads: 7, updatedAt: '' }], total: 1 }));
    }
    res.end(JSON.stringify({ plugin: { owner: 'oc', downloads: 7 }, manifest: { id: 'welcome', name: 'Welcome', kind: 'host', description: 'Greets', dependencies: {}, permissions: ['server.chat'] }, versions: [{ version: '0.1.0', publishedAt: 'today', yanked: false }] }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const master = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const out: string[] = [];
  let saved: HostConfig | undefined;
  const ctx = {
    serverDir: tmp.dir,
    config: parseHostConfig({ master: { url: master } }),
    saveConfig: async (c: HostConfig) => void (saved = structuredClone(c)),
    print: (l: string) => void out.push(l),
    // Keep the developer's own ~/.opencitadel/signing keys out of the test.
    env: { OPENCITADEL_HOME: join(tmp.dir, 'home') },
  };
  const run = async (...argv: string[]) => {
    out.length = 0;
    return runPackageCli(argv, ctx);
  };
  try {
    assert.equal(await runPluginCli([], { ...ctx, print: () => {} }), 1);
    assert.equal(await run(), 1);
    assert.match(out.join('\n'), /Usage: citadel-host plugin/);
    assert.equal(await run('bogus'), 2);

    const tgz = join(tmp.dir, 'welcome.tgz');
    assert.equal(await run('pack', join(repo, 'plugins', 'welcome'), '--out', tgz), 0);
    assert.match(out[0]!, /Packed welcome@0\.1\.0/);

    assert.equal(await run('install', tgz), 0);
    assert.match(out.join('\n'), /Installed welcome@0\.1\.0 \(host\)[\s\S]*server\.chat: Send chat messages to players/);
    assert.deepEqual(saved!.plugins.welcome, pluginSettings({ enabled: true }));
    assert.equal(saved!.plugins.welcome!.sandbox, true, 'installed plugins are sandboxed by default');

    assert.equal(await run('list'), 0);
    assert.match(out[1]!, /^welcome\s+0\.1\.0\s+host\s+enabled\s+unsigned\s+-$/);
    assert.equal(await run('disable', 'welcome'), 0);
    assert.equal(saved!.plugins.welcome!.enabled, false);
    assert.equal(await run('enable', 'welcome'), 0);
    assert.equal(saved!.plugins.welcome!.enabled, true);
    assert.equal(await run('enable', 'nothing-here'), 1);

    assert.equal(await run('search', 'wel'), 0);
    assert.match(out[1]!, /^welcome\s+0\.1\.0\s+host\s+7\s+Greets$/);
    assert.equal(await run('info', 'welcome'), 0);
    assert.match(out.join('\n'), /Welcome \(welcome\) — host[\s\S]*0\.1\.0/);

    assert.equal(await run('publish', tgz), 2, 'needs an API key');
    assert.equal(await run('publish', tgz, '--api-key', 'ock_test'), 0);
    assert.equal(puts[0]!.url, '/v1/plugins/welcome/0.1.0');
    assert.equal(puts[0]!.auth, 'Bearer ock_test');
    assert.equal(puts[0]!.type, 'application/gzip');
    assert.deepEqual(puts[0]!.body, await readFile(tgz));

    assert.equal(await run('remove', 'welcome'), 0);
    assert.equal(saved!.plugins.welcome, undefined);
    assert.equal(await run('remove', 'welcome'), 1);
    assert.match(out[0]!, /not installed/);

    assert.equal(await run('new', join(tmp.dir, 'fresh-plugin'), '--kind', 'content'), 0);
    assert.equal(await run('new', join(tmp.dir, 'x2'), '--kind', 'nope'), 2);
  } finally {
    server.close();
    await tmp.cleanup();
  }
});
