import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { heartbeat, startMaster } from './testutil.js';
import { isPrivateIp } from './verify.js';
import type { A2sQuery } from './verify.js';

test('account and server lifecycle', async () => {
  const m = await startMaster();
  try {
    const created = await m.api('POST', '/v1/accounts', { body: { name: 'alice' } });
    assert.equal(created.status, 201);
    assert.match(created.json.apiKey, /^ock_/);
    assert.equal(created.json.account.name, 'alice');
    const key = created.json.apiKey as string;

    assert.equal((await m.api('POST', '/v1/accounts', { body: { name: 'ALICE' } })).status, 409, 'names are case-insensitive');
    assert.equal((await m.api('POST', '/v1/accounts', { body: { name: 'a' } })).json.error.code, 'invalid_request');
    assert.equal((await m.api('GET', '/v1/accounts/me')).status, 401);
    assert.equal((await m.api('GET', '/v1/accounts/me', { token: 'ock_nope' })).status, 401);

    const srv = await m.api('POST', '/v1/servers', { body: { name: 'Alice EU' }, token: key });
    assert.equal(srv.status, 201);
    assert.match(srv.json.token, /^ocs_/);
    assert.match(srv.json.server.id, /^[a-z2-7]{16}$/);
    assert.equal(srv.json.server.online, false);
    const { id } = srv.json.server;
    const token = srv.json.token as string;

    assert.equal((await m.api('POST', `/v1/servers/${id}/heartbeat`, { body: heartbeat(), token: 'ocs_wrong' })).status, 401);
    assert.equal((await m.api('POST', `/v1/servers/nosuchserver/heartbeat`, { body: heartbeat(), token })).status, 404);

    const hb = await m.api('POST', `/v1/servers/${id}/heartbeat`, { body: heartbeat({ name: 'Alice EU', region: 'eu-west' }), token });
    assert.equal(hb.status, 200);
    assert.deepEqual(hb.json, { ok: true, ttl: 90, interval: 30, verified: false });

    const list = await m.api('GET', '/v1/servers');
    assert.equal(list.json.total, 1);
    assert.equal(list.json.servers[0].name, 'Alice EU');
    assert.equal(list.json.servers[0].source, 'opencitadel');
    assert.equal(list.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(list.json.stats, { servers: 1, players: 3 });

    const detail = await m.api('GET', `/v1/servers/${id}`);
    assert.equal(detail.json.online, true);
    assert.deepEqual(detail.json.owner, { name: 'alice' });
    assert.equal(detail.json.description, '');

    const me = await m.api('GET', '/v1/accounts/me', { token: key });
    assert.equal(me.json.servers.length, 1);
    assert.equal(me.json.servers[0].online, true);

    // Token rotation: the old token stops working.
    const rotated = await m.api('POST', `/v1/servers/${id}/rotate-token`, { token: key });
    assert.equal((await m.api('POST', `/v1/servers/${id}/heartbeat`, { body: heartbeat(), token })).status, 401);
    assert.equal((await m.api('POST', `/v1/servers/${id}/heartbeat`, { body: heartbeat(), token: rotated.json.token })).status, 200);

    // Offline delists immediately but keeps the detail page.
    assert.equal((await m.api('POST', `/v1/servers/${id}/offline`, { token: rotated.json.token })).status, 204);
    assert.equal((await m.api('GET', '/v1/servers')).json.total, 0);
    assert.equal((await m.api('GET', `/v1/servers/${id}`)).json.online, false);

    // Another account can't touch it.
    const bob = await m.account('bob');
    assert.equal((await m.api('DELETE', `/v1/servers/${id}`, { token: bob })).status, 404);
    assert.equal((await m.api('DELETE', `/v1/servers/${id}`, { token: key })).status, 204);
    assert.equal((await m.api('GET', `/v1/servers/${id}`)).status, 404);

    // Key rotation.
    const newKey = (await m.api('POST', '/v1/accounts/me/rotate-key', { token: key })).json.apiKey;
    assert.equal((await m.api('GET', '/v1/accounts/me', { token: key })).status, 401);
    assert.equal((await m.api('GET', '/v1/accounts/me', { token: newKey })).status, 200);
  } finally {
    await m.close();
  }
});

test('heartbeat validation errors', async () => {
  const m = await startMaster();
  try {
    const key = await m.account('carol');
    const { id, token } = await m.server(key);
    const send = (body: unknown) => m.api('POST', `/v1/servers/${id}/heartbeat`, { body, token });
    const noConnect = await send(heartbeat({ connect: {} }));
    assert.equal(noConnect.status, 400);
    assert.equal(noConnect.json.error.code, 'invalid_heartbeat');
    assert.match((await send(heartbeat({ tags: ['Not OK'] }))).json.error.message, /tags\[0\]/);
    assert.match((await send(heartbeat({ players: 13 }))).json.error.message, /exceeds/);
    assert.match((await send(heartbeat({ connect: { steamId: '[U:1:22202]' } }))).json.error.message, /connect\.steamId/);
    assert.equal((await send(heartbeat({ region: 'mars' }))).status, 400);
    const badJson = await m.api('POST', `/v1/servers/${id}/heartbeat`, { raw: '{nope', token, headers: { 'content-type': 'application/json' } });
    assert.equal(badJson.json.error.code, 'invalid_json');
    const huge = await m.api('POST', `/v1/servers/${id}/heartbeat`, { raw: JSON.stringify(heartbeat({ description: 'x'.repeat(70_000) })), token });
    assert.equal(huge.status, 413);
    assert.equal((await m.api('GET', '/v1/servers')).json.total, 0, 'nothing was listed');
  } finally {
    await m.close();
  }
});

test('browse filters, sorting and pagination', async () => {
  const m = await startMaster();
  try {
    const key = await m.account('dave');
    const make = async (name: string, over: Record<string, unknown>) => {
      const { id, token } = await m.server(key, name);
      await m.api('POST', `/v1/servers/${id}/heartbeat`, { body: heartbeat({ name, ...over }), token });
      m.advance(1000); // distinct firstSeen
      return id;
    };
    await make('Alpha Casual', { players: 12, maxPlayers: 12, region: 'eu-west', tags: ['casual', 'eu'] });
    await make('Bravo Ranked', { players: 6, region: 'na-east', tags: ['ranked'], passworded: true, gameMode: 'StreetBrawl' });
    await make('Charlie Modded', { players: 0, region: 'eu-west', map: 'dl_hideout', plugins: [{ id: 'welcome', version: '1.0.0', kind: 'host' }] });
    await make('Delta Content', {
      players: 2,
      region: 'asia-se',
      description: 'Custom arena with a secret',
      content: [{ name: 'arena_map', kind: 'map', sha256: 'a'.repeat(64), size: 1024, url: 'https://cdn.example/arena_map.vpk' }],
    });

    const names = async (qs: string) => (await m.api('GET', `/v1/servers${qs}`)).json.servers.map((s: { name: string }) => s.name);
    assert.deepEqual(await names(''), ['Alpha Casual', 'Bravo Ranked', 'Delta Content', 'Charlie Modded'], 'default: most players first');
    assert.deepEqual(await names('?sort=name'), ['Alpha Casual', 'Bravo Ranked', 'Charlie Modded', 'Delta Content']);
    assert.deepEqual(await names('?sort=newest'), ['Delta Content', 'Charlie Modded', 'Bravo Ranked', 'Alpha Casual']);
    assert.deepEqual(await names('?q=ranked'), ['Bravo Ranked']);
    assert.deepEqual(await names('?q=SECRET'), ['Delta Content'], 'searches descriptions');
    assert.deepEqual(await names('?region=eu-west'), ['Alpha Casual', 'Charlie Modded']);
    assert.deepEqual(await names('?map=DL_HIDEOUT'), ['Charlie Modded']);
    assert.deepEqual(await names('?mode=streetbrawl'), ['Bravo Ranked']);
    assert.deepEqual(await names('?tags=casual,eu'), ['Alpha Casual']);
    assert.deepEqual(await names('?tags=casual,ranked'), []);
    assert.deepEqual(await names('?notFull=1&sort=name'), ['Bravo Ranked', 'Charlie Modded', 'Delta Content']);
    assert.deepEqual(await names('?notEmpty=true&sort=name'), ['Alpha Casual', 'Bravo Ranked', 'Delta Content']);
    assert.deepEqual(await names('?noPassword=1&sort=name'), ['Alpha Casual', 'Charlie Modded', 'Delta Content']);
    assert.deepEqual(await names('?modded=1&sort=name'), ['Charlie Modded', 'Delta Content']);
    assert.deepEqual(await names('?modded=0&sort=name'), ['Alpha Casual', 'Bravo Ranked']);
    assert.deepEqual(await names('?verified=1'), []);

    const page = await m.api('GET', '/v1/servers?sort=name&limit=2&offset=1');
    assert.deepEqual(page.json.servers.map((s: { name: string }) => s.name), ['Bravo Ranked', 'Charlie Modded']);
    assert.equal(page.json.total, 4);
    assert.equal(page.json.limit, 2);
    assert.equal(page.json.offset, 1);
    assert.deepEqual(page.json.stats, { servers: 4, players: 20 });

    const delta = (await m.api('GET', '/v1/servers?q=delta')).json.servers[0];
    assert.equal(delta.requiresContent, true);
    assert.equal(delta.modded, true);

    for (const bad of ['?region=mars', '?sort=ping', '?limit=0', '?limit=500', '?notFull=maybe']) {
      assert.equal((await m.api('GET', `/v1/servers${bad}`)).status, 400, bad);
    }
    const stats = await m.api('GET', '/v1/stats');
    assert.deepEqual(stats.json, { servers: 4, players: 20, plugins: 0 });
  } finally {
    await m.close();
  }
});

test('listings expire after their TTL; details last 24 h', async () => {
  const m = await startMaster();
  try {
    const key = await m.account('erin');
    const { id, token } = await m.server(key);
    await m.api('POST', `/v1/servers/${id}/heartbeat`, { body: heartbeat(), token });
    m.advance(89_000);
    assert.equal((await m.api('GET', '/v1/servers')).json.total, 1);
    m.advance(2_000);
    assert.equal((await m.api('GET', '/v1/servers')).json.total, 0);
    const detail = await m.api('GET', `/v1/servers/${id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.online, false);
    m.advance(24 * 3600_000);
    assert.equal((await m.api('GET', `/v1/servers/${id}`)).status, 404);
    // Coming back relists it.
    await m.api('POST', `/v1/servers/${id}/heartbeat`, { body: heartbeat(), token });
    assert.equal((await m.api('GET', '/v1/servers')).json.total, 1);
  } finally {
    await m.close();
  }
});

test('A2S verification overrides counts, is rate-limited, and skips private addresses', async () => {
  const calls: string[] = [];
  let fail = false;
  const query: A2sQuery = async (host, port) => {
    calls.push(`${host}:${port}`);
    if (fail) throw new Error('timed out');
    return { players: 7, maxPlayers: 12, map: 'dl_hideout' };
  };
  const m = await startMaster({ a2sQuery: query, resolve: async (h) => (h === 'play.example.com' ? '198.51.100.20' : h) });
  try {
    const key = await m.account('frank');
    const { id, token } = await m.server(key);
    const beat = (over: Record<string, unknown> = {}) => m.api('POST', `/v1/servers/${id}/heartbeat`, { body: heartbeat({ connect: { address: '203.0.113.5:27015' }, ...over }), token });

    assert.equal((await beat()).json.verified, false, 'first heartbeat answers before the probe completes');
    await m.master.verifier.idle();
    let s = (await m.api('GET', '/v1/servers')).json.servers[0];
    assert.equal(s.verified, true);
    assert.equal(s.players, 7, 'A2S count wins');
    assert.equal(s.map, 'dl_hideout');
    assert.equal((await beat()).json.verified, true);
    await m.master.verifier.idle();
    assert.equal(calls.length, 1, 'no re-probe within 5 minutes');
    assert.equal((await m.api('GET', '/v1/servers?verified=1')).json.total, 1);

    m.advance(5 * 60_000);
    fail = true;
    await beat();
    await m.master.verifier.idle();
    assert.equal(calls.length, 2);
    s = (await m.api('GET', '/v1/servers')).json.servers[0];
    assert.equal(s.verified, false);
    assert.equal(s.players, 3, 'falls back to self-reported count');

    // Changing the address probes right away; hostnames are resolved first.
    fail = false;
    await beat({ connect: { address: 'play.example.com:27016' } });
    await m.master.verifier.idle();
    assert.equal(calls.at(-1), '198.51.100.20:27016');
    assert.equal((await m.api('GET', `/v1/servers/${id}`)).json.verified, true);

    // Private targets are never probed.
    const before = calls.length;
    await beat({ connect: { address: '192.168.1.50:27015' } });
    await m.master.verifier.idle();
    assert.equal(calls.length, before);
    assert.equal((await m.api('GET', `/v1/servers/${id}`)).json.verified, false);
    await beat({ connect: { address: 'localhost:27015' }, });
    await m.master.verifier.idle();
    assert.equal(calls.length, before, 'localhost resolves to loopback');
  } finally {
    await m.close();
  }
});

test('allowPrivate probes LAN addresses', async () => {
  let called = 0;
  const m = await startMaster({ allowPrivate: true, a2sQuery: async () => (called++, { players: 1, maxPlayers: 12, map: 'dl_midtown' }) });
  try {
    const key = await m.account('gina');
    const { id, token } = await m.server(key);
    await m.api('POST', `/v1/servers/${id}/heartbeat`, { body: heartbeat({ connect: { address: '127.0.0.1:27015' } }), token });
    await m.master.verifier.idle();
    assert.equal(called, 1);
    assert.equal((await m.api('GET', `/v1/servers/${id}`)).json.verified, true);
  } finally {
    await m.close();
  }
});

test('private IP classification', () => {
  for (const ip of ['10.1.2.3', '127.0.0.1', '172.20.0.1', '192.168.0.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1', '224.0.0.1']) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '203.0.113.5', '172.32.0.1', '2001:db8::1', '::ffff:1.1.1.1']) assert.equal(isPrivateIp(ip), false, ip);
});

test('rate limiting returns 429 with Retry-After and refills over time', async () => {
  const m = await startMaster({ rateLimits: { read: { capacity: 3, refillPerSecond: 1 } } });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await m.api('GET', '/v1/servers')).status, 200);
    const limited = await m.api('GET', '/v1/servers');
    assert.equal(limited.status, 429);
    assert.equal(limited.json.error.code, 'rate_limited');
    assert.equal(limited.headers.get('retry-after'), '1');
    assert.equal((await m.api('GET', '/healthz')).status, 200, 'health checks are exempt');
    m.advance(1000);
    assert.equal((await m.api('GET', '/v1/servers')).status, 200);
  } finally {
    await m.close();
  }
});

test('admin routes', async () => {
  const none = await startMaster();
  try {
    assert.equal((await none.api('GET', '/v1/admin/servers', { token: 'anything' })).status, 404, 'admin is off without a token');
  } finally {
    await none.close();
  }

  const m = await startMaster({ adminToken: 'admin-secret' });
  try {
    const key = await m.account('hank');
    const a = await m.server(key, 'Server A');
    const b = await m.server(key, 'Server B');
    for (const s of [a, b]) await m.api('POST', `/v1/servers/${s.id}/heartbeat`, { body: heartbeat(), token: s.token });

    assert.equal((await m.api('GET', '/v1/admin/servers', { token: 'wrong' })).status, 401);
    const all = await m.api('GET', '/v1/admin/servers', { token: 'admin-secret' });
    assert.equal(all.json.servers.length, 2);
    assert.equal(all.json.servers[0].owner.name, 'hank');
    assert.equal(all.json.servers[0].ip, '127.0.0.1');
    assert.equal(all.json.servers[0].online, true);

    assert.equal((await m.api('DELETE', `/v1/admin/servers/${a.id}`, { token: 'admin-secret' })).status, 204);
    const blocked = await m.api('POST', `/v1/servers/${a.id}/heartbeat`, { body: heartbeat(), token: a.token });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.error.code, 'server_blocked');
    assert.equal((await m.api('GET', '/v1/servers')).json.total, 1);

    assert.equal((await m.api('POST', '/v1/admin/accounts/hank/disable', { token: 'admin-secret' })).status, 200);
    assert.equal((await m.api('GET', '/v1/accounts/me', { token: key })).json.error.code, 'account_disabled');
    assert.equal((await m.api('GET', '/v1/servers')).json.total, 0, "a disabled account's servers are delisted");
    assert.equal((await m.api('POST', `/v1/servers/${b.id}/heartbeat`, { body: heartbeat(), token: b.token })).status, 403);
  } finally {
    await m.close();
  }
});

test('registration can be closed', async () => {
  const m = await startMaster({ registration: 'closed' });
  try {
    const r = await m.api('POST', '/v1/accounts', { body: { name: 'ivan' } });
    assert.equal(r.status, 403);
    assert.equal(r.json.error.code, 'registration_closed');
  } finally {
    await m.close();
  }
});

test('serves the web UI with a strict CSP, and JSON 404s', async () => {
  const m = await startMaster();
  try {
    const res = await fetch(`${m.base}/`);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type')!, /text\/html/);
    assert.match(res.headers.get('content-security-policy')!, /script-src 'self'/);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.match(html, /<script src="app\.js"/);
    assert.doesNotMatch(html, /<script>|style=/, 'no inline script or style');
    const js = await fetch(`${m.base}/app.js`);
    assert.match(js.headers.get('content-type')!, /javascript/);
    const etag = js.headers.get('etag')!;
    assert.equal((await fetch(`${m.base}/app.js`, { headers: { 'if-none-match': etag } })).status, 304);
    assert.equal((await fetch(`${m.base}/style.css`)).status, 200);
    const missing = await m.api('GET', '/nope');
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error.code, 'not_found');
    assert.equal((await m.api('PATCH', '/v1/servers')).status, 405);
    assert.equal((await m.api('GET', '/v1/nothing/here')).status, 404);
    const wrongMethod = await m.api('DELETE', '/v1/accounts');
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get('allow'), 'POST');
  } finally {
    await m.close();
  }
});

test('CLI administers the database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-master-cli-'));
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  try {
    const out = execFileSync(process.execPath, [cli, 'account', 'create', 'operator', '--data', dir], { encoding: 'utf8' });
    assert.match(out, /API key \(shown once, store it safely\): ock_/);
    const disabled = execFileSync(process.execPath, [cli, 'account', 'disable', 'operator', '--data', dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.match(disabled, /Disabled account operator/);
    assert.throws(() => execFileSync(process.execPath, [cli, 'server', 'delist', 'nope', '--data', dir], { stdio: 'pipe' }), /No server/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
