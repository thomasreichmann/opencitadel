import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import type { AddressInfo } from 'node:net';
import { queryInfo } from './a2s.js';
import { pickConnectTarget, steamJoinUrl, connectCommand } from './connect.js';
import { parseHeartbeat } from './listing.js';

function infoPayload(): Buffer {
  const s = (x: string) => Buffer.from(x + '\0', 'utf8');
  const port = Buffer.alloc(2);
  port.writeUInt16LE(27015);
  const sid = Buffer.alloc(8);
  sid.writeBigUInt64LE(90000000000000001n);
  return Buffer.concat([
    Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49, 17]),
    s('My Server'), s('dl_midtown'), s('citadel'), s('Deadlock'),
    Buffer.from([0x00, 0x00, 3, 12, 0, 'd'.charCodeAt(0), 'w'.charCodeAt(0), 0, 0]),
    s('1.0.0.0'),
    Buffer.from([0x80 | 0x10 | 0x20]), port, sid, s('dw1,casual'),
  ]);
}

test('A2S_INFO with challenge', async () => {
  const server = createSocket('udp4');
  const challenge = Buffer.from([1, 2, 3, 4]);
  server.on('message', (msg, rinfo) => {
    const hasChallenge = msg.length === 25 + 4 && msg.subarray(25).equals(challenge);
    const reply = hasChallenge ? infoPayload() : Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x41]), challenge]);
    server.send(reply, rinfo.port, rinfo.address);
  });
  await new Promise<void>((r) => server.bind(0, '127.0.0.1', r));
  try {
    const info = await queryInfo('127.0.0.1', (server.address() as AddressInfo).port);
    assert.equal(info.name, 'My Server');
    assert.equal(info.map, 'dl_midtown');
    assert.equal(info.players, 3);
    assert.equal(info.maxPlayers, 12);
    assert.equal(info.port, 27015);
    assert.equal(info.steamId64, '90000000000000001');
    assert.equal(info.keywords, 'dw1,casual');
  } finally {
    server.close();
  }
});

test('A2S_INFO times out', async () => {
  const server = createSocket('udp4');
  await new Promise<void>((r) => server.bind(0, '127.0.0.1', r));
  try {
    await assert.rejects(queryInfo('127.0.0.1', (server.address() as AddressInfo).port, 200), /timed out/);
  } finally {
    server.close();
  }
});

test('connect targets and steam URLs', () => {
  const both = { steamId: '[A:1:123:456]', address: '203.0.113.5:27015' };
  assert.deepEqual(pickConnectTarget(both), { kind: 'steamId', value: '[A:1:123:456]' });
  assert.deepEqual(pickConnectTarget(both, true), { kind: 'address', value: '203.0.113.5:27015' });
  assert.equal(steamJoinUrl({ kind: 'address', value: '203.0.113.5:27015' }), 'steam://connect/203.0.113.5:27015');
  assert.equal(steamJoinUrl({ kind: 'steamId', value: '[A:1:123:456]' }), 'steam://run/1422450//%2Bconnect%20%5BA%3A1%3A123%3A456%5D/');
  assert.equal(connectCommand({ kind: 'steamId', value: '[A:1:123:456]' }, 'pw'), 'password "pw"; connect [A:1:123:456]');
});

test('heartbeat validation', () => {
  const base = { name: 'x', map: 'dl_midtown', players: 1, maxPlayers: 12, connect: { steamId: '[A:1:1:1]' }, software: { name: 'citadel-host', version: '0.1.0' } };
  const hb = parseHeartbeat(base);
  assert.deepEqual(hb.tags, []);
  assert.equal(hb.passworded, false);
  assert.throws(() => parseHeartbeat({ ...base, connect: {} }), /steamId or an address/);
  assert.throws(() => parseHeartbeat({ ...base, players: 20 }), /exceeds/);
  assert.throws(() => parseHeartbeat({ ...base, tags: ['Bad Tag'] }), /tags\[0\]/);
  assert.throws(() => parseHeartbeat({ ...base, connect: { steamId: '[U:1:22202]' } }), /connect.steamId/);
});
