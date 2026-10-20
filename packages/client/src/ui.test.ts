import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import type { ServerDetail } from '@opencitadel/protocol';
import { MasterClient } from './api.js';
import { RecordingPlatform } from './launch.js';
import { startUi, type UiServer } from './ui.js';
import { serverDetail, startHttp, tempDir } from './testutil.js';

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json(): any;
}

function call(port: number, method: string, path: string, opts: { headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...opts.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) });
      });
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

const json = (body: unknown) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function setup() {
  const tmp = tempDir();
  const webDir = join(tmp.dir, 'web');
  mkdirSync(webDir);
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>OpenCitadel</title>');
  writeFileSync(join(webDir, 'app.js'), 'console.log(1)');
  writeFileSync(join(tmp.dir, 'secret.txt'), 'do not serve');

  const servers: Record<string, ServerDetail> = {
    open: serverDetail({ id: 'open' }),
    locked: serverDetail({ id: 'locked', passworded: true }),
    sdronly: serverDetail({ id: 'sdronly', connect: { steamId: '[A:1:9:9]' } }),
  };
  const master = await startHttp((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (url.pathname === '/v1/servers') return send(200, { servers: Object.values(servers), total: 3, limit: 100, offset: 0, stats: { servers: 3, players: 9 }, echo: url.search });
    const m = /^\/v1\/servers\/([^/]+)$/.exec(url.pathname);
    if (m && servers[m[1]!]) return send(200, servers[m[1]!]);
    send(404, { error: { code: 'not_found', message: 'No such server' } });
  });
  const home = join(tmp.dir, 'home');
  const platform = new RecordingPlatform();
  const ui: UiServer = await startUi({
    master: new MasterClient(master.base),
    home,
    platform,
    webDir,
    port: 0,
    ping: async (host) => (host === '203.0.113.5' ? 25 : 999),
  });
  return {
    ui,
    home,
    platform,
    async close() {
      await ui.close();
      await master.close();
      tmp.cleanup();
    },
  };
}

test('serves the web app and proxies the master', async () => {
  const t = await setup();
  try {
    const index = await call(t.ui.port, 'GET', '/');
    assert.equal(index.status, 200);
    assert.match(index.headers['content-type'] as string, /text\/html/);
    assert.match(index.body, /OpenCitadel/);
    assert.match((await call(t.ui.port, 'GET', '/app.js')).headers['content-type'] as string, /javascript/);
    assert.equal((await call(t.ui.port, 'GET', '/%2e%2e/secret.txt')).status, 404);
    assert.equal((await call(t.ui.port, 'GET', '/../secret.txt')).status, 404);
    assert.equal((await call(t.ui.port, 'GET', '/nope.html')).status, 404);

    const list = await call(t.ui.port, 'GET', '/v1/servers?region=eu-west');
    assert.equal(list.status, 200);
    assert.equal(list.json().total, 3);
    assert.equal(list.json().echo, '?region=eu-west');
    assert.equal((await call(t.ui.port, 'GET', '/v1/servers/missing')).status, 404);
    assert.equal((await call(t.ui.port, 'PUT', '/v1/servers')).status, 405);
  } finally {
    await t.close();
  }
});

test('local info, favorites and ping', async () => {
  const t = await setup();
  try {
    const info = await call(t.ui.port, 'GET', '/local/info');
    assert.equal(info.status, 200);
    assert.equal(info.json().ok, true);
    assert.equal(info.json().gameFound, false);

    assert.deepEqual((await call(t.ui.port, 'PUT', '/local/favorites/open')).json(), { ids: ['open'] });
    assert.deepEqual((await call(t.ui.port, 'PUT', '/local/favorites/locked')).json(), { ids: ['open', 'locked'] });
    assert.deepEqual((await call(t.ui.port, 'DELETE', '/local/favorites/open')).json(), { ids: ['locked'] });
    assert.deepEqual((await call(t.ui.port, 'GET', '/local/favorites')).json(), { ids: ['locked'] });
    assert.deepEqual(JSON.parse(readFileSync(join(t.home, 'client.json'), 'utf8')).favorites, ['locked']);
    assert.equal((await call(t.ui.port, 'PUT', '/local/favorites/..%2Fx')).status, 400);

    const ping = await call(t.ui.port, 'GET', '/local/ping?ids=open,sdronly,missing');
    assert.deepEqual(ping.json(), { pings: { open: 25, sdronly: null, missing: null } });
    assert.equal((await call(t.ui.port, 'GET', '/local/ping?ids=bad%20id')).status, 400);
  } finally {
    await t.close();
  }
});

test('join launches through the platform and records history', async () => {
  const t = await setup();
  try {
    const r = await call(t.ui.port, 'POST', '/local/join/open', json({}));
    assert.equal(r.status, 200, r.body);
    const body = r.json();
    assert.deepEqual(Object.keys(body).sort(), ['command', 'contentInstalled', 'launched', 'message', 'ok', 'restartRequired', 'steamUrl']);
    assert.equal(body.ok, true);
    assert.equal(body.launched, true);
    assert.equal(body.steamUrl, 'steam://run/1422450//%2Bconnect%20%5BA%3A1%3A123%3A456%5D/');
    assert.deepEqual(t.platform.opened, [body.steamUrl]);
    assert.equal(JSON.parse(readFileSync(join(t.home, 'client.json'), 'utf8')).history[0].id, 'open');

    const locked = await call(t.ui.port, 'POST', '/local/join/locked', json({}));
    assert.equal(locked.status, 401);
    assert.equal(locked.json().ok, false);
    assert.equal(locked.json().error.code, 'password_required');
    const unlocked = await call(t.ui.port, 'POST', '/local/join/locked', json({ password: 'pw' }));
    assert.equal(unlocked.status, 200);
    assert.match(unlocked.json().command, /^password "pw"; connect/);

    assert.equal((await call(t.ui.port, 'POST', '/local/join/missing', json({}))).status, 404);
    // An empty body is fine (no password); a non-JSON body is not.
    assert.equal((await call(t.ui.port, 'POST', '/local/join/open')).status, 200);
    assert.equal((await call(t.ui.port, 'POST', '/local/join/open', { headers: { 'content-type': 'text/plain' }, body: 'x' })).status, 415);
  } finally {
    await t.close();
  }
});

test('rejects foreign Host headers and cross-origin writes', async () => {
  const t = await setup();
  try {
    const port = t.ui.port;
    assert.equal((await call(port, 'GET', '/local/info', { headers: { host: `evil.example:${port}` } })).status, 403);
    assert.equal((await call(port, 'GET', '/', { headers: { host: 'localhost:1' } })).status, 403);
    assert.equal((await call(port, 'GET', '/local/info', { headers: { host: `localhost:${port}` } })).status, 200);

    const evil = await call(port, 'POST', '/local/join/open', { headers: { origin: 'http://evil.example', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(evil.status, 403);
    const crossSite = await call(port, 'PUT', '/local/favorites/open', { headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(crossSite.status, 403);
    const sameOrigin = await call(port, 'PUT', '/local/favorites/open', { headers: { origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' } });
    assert.equal(sameOrigin.status, 200);
    assert.deepEqual(t.platform.opened, [], 'nothing launched by rejected requests');
  } finally {
    await t.close();
  }
});
