import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect, type Socket } from 'node:net';
import { BridgeServer } from './bridge.js';
import { createLogger, setLogSinks } from './logger.js';

setLogSinks([]);

function client(port: number) {
  const sock = connect(port, '127.0.0.1');
  const inbox: Array<Record<string, unknown>> = [];
  let buf = '';
  sock.on('data', (c) => {
    buf += c.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      inbox.push(JSON.parse(buf.slice(0, nl)));
      buf = buf.slice(nl + 1);
    }
  });
  sock.on('error', () => {});
  const closed = new Promise<void>((r) => sock.on('close', () => r()));
  const send = (m: object | string) => sock.write((typeof m === 'string' ? m : JSON.stringify(m)) + '\n');
  return { sock, inbox, closed, send };
}

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
};

async function server(opts: Partial<ConstructorParameters<typeof BridgeServer>[0]> = {}) {
  const s = new BridgeServer({ port: 0, token: 'secret-token', log: createLogger('bridge'), ...opts });
  await s.listen();
  return s;
}

test('handshake, events, requests and pings', async () => {
  const s = await server();
  const events: Array<[string, unknown]> = [];
  s.on('event', (n, d) => events.push([n, d]));
  let hello: unknown;
  s.on('connected', (h) => (hello = h));
  const c = client(s.port);
  try {
    c.send({ type: 'hello', token: 'secret-token', bridge: '0.1.0', deadworks: '0.6.1', map: 'dl_midtown' });
    await until(() => c.inbox.length === 1);
    assert.equal(c.inbox[0]!.type, 'welcome');
    assert.deepEqual(hello, { bridge: '0.1.0', deadworks: '0.6.1', map: 'dl_midtown' });
    assert.equal(s.connected, true);

    c.send({ type: 'event', name: 'player.connected', data: { slot: 1, name: 'A' } });
    await until(() => events.length === 1);
    assert.deepEqual(events[0], ['player.connected', { slot: 1, name: 'A' }]);

    const pending = s.request('players');
    await until(() => c.inbox.length === 2);
    const req = c.inbox[1]!;
    assert.equal(req.type, 'request');
    assert.equal(req.method, 'players');
    c.send({ type: 'response', id: req.id, ok: true, result: [{ slot: 1 }] });
    assert.deepEqual(await pending, [{ slot: 1 }]);

    const failing = s.request('kick', { slot: 9 });
    await until(() => c.inbox.length === 3);
    c.send({ type: 'response', id: c.inbox[2]!.id, ok: false, error: 'no such slot' });
    await assert.rejects(failing, /no such slot/);

    c.send({ type: 'ping' });
    await until(() => c.inbox.length === 4);
    assert.equal(c.inbox[3]!.type, 'pong');
  } finally {
    c.sock.destroy();
    await s.close();
  }
});

test('wrong token, garbage and oversize lines close the connection', async () => {
  const s = await server({ maxLineBytes: 1024 });
  try {
    const bad = client(s.port);
    bad.send({ type: 'hello', token: 'nope' });
    await bad.closed;
    assert.equal(s.connected, false);

    const noHello = client(s.port);
    noHello.send({ type: 'event', name: 'x' });
    await noHello.closed;

    const junk = client(s.port);
    junk.send('this is not json');
    await junk.closed;

    const big = client(s.port);
    big.send({ type: 'hello', token: 'secret-token' });
    await until(() => big.inbox.length === 1);
    big.sock.write('x'.repeat(2000));
    await big.closed;
    assert.equal(s.connected, false);
  } finally {
    await s.close();
  }
});

test('requests time out, and fail when the bridge drops', async () => {
  const s = await server({ requestTimeoutMs: 50 });
  const c = client(s.port);
  try {
    await assert.rejects(s.request('say', { message: 'x' }), /not connected/);
    c.send({ type: 'hello', token: 'secret-token' });
    await until(() => s.connected);
    await assert.rejects(s.request('say', { message: 'x' }), /timed out/);
    const hanging = s.request('players', {}, 5000);
    c.sock.destroy();
    await assert.rejects(hanging, /disconnected/);
  } finally {
    await s.close();
  }
});

test('a newer connection replaces the old one; setToken drops it', async () => {
  const s = await server();
  const a = client(s.port);
  const b = client(s.port);
  try {
    a.send({ type: 'hello', token: 'secret-token' });
    await until(() => a.inbox.length === 1);
    b.send({ type: 'hello', token: 'secret-token' });
    await a.closed;
    assert.equal(s.connected, true);
    s.setToken('next');
    await b.closed;
    assert.equal(s.connected, false);
  } finally {
    await s.close();
  }
});

test('silent connections are dropped after the idle timeout', async () => {
  const s = await server({ pingIntervalMs: 20, idleTimeoutMs: 120 });
  const c: { sock: Socket; closed: Promise<void>; inbox: Array<Record<string, unknown>>; send: (m: object) => void } = client(s.port);
  try {
    c.send({ type: 'hello', token: 'secret-token' });
    await until(() => s.connected);
    // keepAlive runs on a timer of min(pingInterval, 5000) ms.
    await until(() => c.inbox.some((m) => m.type === 'ping'), 3000);
    await c.closed;
  } finally {
    await s.close();
  }
});
