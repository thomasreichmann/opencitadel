import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { RconClient, decodePackets, encodePacket } from './rcon.js';

/**
 * A fake Source RCON server. `mirrorSentinel: false` imitates servers that ignore empty packets.
 * `deferMs` imitates Deadlock: it runs commands on a later tick and stamps the output with the id
 * of the most recent packet it received (observed on build 6796).
 */
function fakeServer(opts: { password: string; mirrorSentinel: boolean; deferMs?: number; respond: (cmd: string) => string[] }): Promise<Server> {
  const server = createServer((sock: Socket) => {
    let buf: Buffer = Buffer.alloc(0);
    let authed = false;
    let lastId = 0;
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const { packets, rest } = decodePackets(buf);
      buf = rest;
      for (const p of packets) {
        lastId = p.id;
        if (p.type === 3) {
          authed = p.body === opts.password;
          sock.write(encodePacket(p.id, 0, ''));
          sock.write(encodePacket(authed ? p.id : -1, 2, ''));
        } else if (p.type === 2 && authed) {
          const reply = () => {
            const id = opts.deferMs ? lastId : p.id;
            for (const part of opts.respond(p.body)) sock.write(encodePacket(id, 0, part));
          };
          if (opts.deferMs) setTimeout(reply, opts.deferMs);
          else reply();
        } else if (p.type === 0 && authed && opts.mirrorSentinel) {
          sock.write(encodePacket(p.id, 0, ''));
        }
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

for (const [label, mirrorSentinel, deferMs] of [
  ['Source 1: reply, then sentinel echo', true, 0],
  ['no sentinel echo', false, 0],
  ['Deadlock: sentinel echo first, reply a tick later', true, 40],
] as const) {
  test(`rcon commands (${label})`, async () => {
    const server = await fakeServer({
      password: 'secret',
      mirrorSentinel,
      deferMs,
      respond: (cmd) => (cmd === 'status' ? ['hostname: test\n', 'map     : dl_midtown\n'] : cmd === 'big' ? ['x'.repeat(5000)] : []),
    });
    const client = new RconClient({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, password: 'secret', quietMs: 50, replyWaitMs: 300 });
    try {
      await client.connect();
      const [a, b, c] = await Promise.all([client.command('status'), client.command('sv_cheats 0'), client.command('big')]);
      assert.equal(a, 'hostname: test\nmap     : dl_midtown\n');
      assert.equal(b, '');
      assert.equal(c.length, 5000);
    } finally {
      client.close();
      server.close();
    }
  });
}

test('rcon rejects a bad password', async () => {
  const server = await fakeServer({ password: 'secret', mirrorSentinel: true, respond: () => [] });
  const client = new RconClient({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, password: 'nope' });
  try {
    await assert.rejects(client.connect(), /authentication failed/);
  } finally {
    client.close();
    server.close();
  }
});

test('queued commands fail when the connection drops', async () => {
  let victim: Socket | undefined;
  const server = createServer((s) => {
    victim = s;
    s.on('data', (chunk) => {
      const { packets } = decodePackets(chunk);
      for (const p of packets) if (p.type === 3) s.write(encodePacket(p.id, 2, ''));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const client = new RconClient({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, password: 'x', quietMs: 5000 });
  client.on('error', () => {});
  try {
    await client.connect();
    const first = client.command('one');
    const second = client.command('two');
    victim!.destroy();
    await assert.rejects(first, /closed/);
    await assert.rejects(second, /not connected/);
  } finally {
    client.close();
    server.close();
  }
});
