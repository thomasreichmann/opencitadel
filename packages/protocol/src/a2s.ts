/**
 * A2S_INFO over UDP (https://developer.valvesoftware.com/wiki/Server_queries#A2S_INFO).
 *
 * Deadlock dedicated servers answer A2S on their game port (Deadworks' Docker healthcheck relies
 * on it). The master uses this to verify that a listed address is real and to read true player
 * counts; the browser uses it for ping.
 */

import { createSocket } from 'node:dgram';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

export interface A2sInfo {
  protocol: number;
  name: string;
  map: string;
  folder: string;
  game: string;
  appId: number;
  players: number;
  maxPlayers: number;
  bots: number;
  serverType: string;
  environment: string;
  passworded: boolean;
  vac: boolean;
  version: string;
  port?: number;
  steamId64?: string;
  keywords?: string;
  gameId?: string;
  /** Round-trip time of the final request, in ms. */
  pingMs: number;
}

const HEADER = Buffer.from([0xff, 0xff, 0xff, 0xff]);
const INFO_REQUEST = Buffer.concat([HEADER, Buffer.from('TSource Engine Query\0', 'latin1')]);

export function buildInfoRequest(challenge?: Buffer): Buffer {
  return challenge ? Buffer.concat([INFO_REQUEST, challenge]) : INFO_REQUEST;
}

class Reader {
  off = 0;
  constructor(private readonly buf: Buffer) {}
  byte(): number {
    if (this.off >= this.buf.length) throw new Error('A2S response truncated');
    return this.buf[this.off++]!;
  }
  short(): number {
    if (this.off + 2 > this.buf.length) throw new Error('A2S response truncated');
    const v = this.buf.readUInt16LE(this.off);
    this.off += 2;
    return v;
  }
  long64(): bigint {
    if (this.off + 8 > this.buf.length) throw new Error('A2S response truncated');
    const v = this.buf.readBigUInt64LE(this.off);
    this.off += 8;
    return v;
  }
  string(): string {
    const end = this.buf.indexOf(0, this.off);
    if (end === -1) throw new Error('A2S response truncated');
    const s = this.buf.toString('utf8', this.off, end);
    this.off = end + 1;
    return s;
  }
  get remaining(): number {
    return this.buf.length - this.off;
  }
}

/** Parses an `I` (0x49) response, starting after the 0xFFFFFFFF header. */
export function parseInfoResponse(payload: Buffer, pingMs = 0): A2sInfo {
  const r = new Reader(payload);
  if (r.byte() !== 0x49) throw new Error('Not an A2S_INFO response');
  const info: A2sInfo = {
    protocol: r.byte(),
    name: r.string(),
    map: r.string(),
    folder: r.string(),
    game: r.string(),
    appId: r.short(),
    players: r.byte(),
    maxPlayers: r.byte(),
    bots: r.byte(),
    serverType: String.fromCharCode(r.byte()),
    environment: String.fromCharCode(r.byte()),
    passworded: r.byte() === 1,
    vac: r.byte() === 1,
    version: r.string(),
    pingMs,
  };
  if (r.remaining > 0) {
    const edf = r.byte();
    if (edf & 0x80) info.port = r.short();
    if (edf & 0x10) info.steamId64 = r.long64().toString();
    if (edf & 0x40) {
      r.short();
      r.string();
    }
    if (edf & 0x20) info.keywords = r.string();
    if (edf & 0x01) info.gameId = r.long64().toString();
  }
  return info;
}

/** Queries A2S_INFO, handling the challenge round-trip. Rejects on timeout or a malformed reply. */
export async function queryInfo(host: string, port: number, timeoutMs = 1500): Promise<A2sInfo> {
  const address = isIP(host) ? host : (await lookup(host)).address;
  const socket = createSocket(isIP(address) === 6 ? 'udp6' : 'udp4');
  try {
    return await new Promise<A2sInfo>((resolve, reject) => {
      let sentAt = 0;
      let challenges = 0;
      const timer = setTimeout(() => reject(new Error(`A2S query to ${host}:${port} timed out`)), timeoutMs);
      const send = (msg: Buffer) => {
        sentAt = performance.now();
        socket.send(msg, port, address, (err) => err && reject(err));
      };
      socket.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      socket.on('message', (msg, rinfo) => {
        if (rinfo.address !== address || rinfo.port !== port) return;
        try {
          if (msg.length < 5 || msg.readInt32LE(0) !== -1) throw new Error('Unsupported A2S packet (split or malformed)');
          const kind = msg[4];
          if (kind === 0x41) {
            if (++challenges > 3) throw new Error('A2S server keeps sending challenges');
            send(buildInfoRequest(msg.subarray(5, 9)));
            return;
          }
          clearTimeout(timer);
          resolve(parseInfoResponse(msg.subarray(4), Math.round(performance.now() - sentAt)));
        } catch (err) {
          clearTimeout(timer);
          reject(err as Error);
        }
      });
      send(buildInfoRequest());
    });
  } finally {
    socket.close();
  }
}
