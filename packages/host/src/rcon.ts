/**
 * Source RCON client (https://developer.valvesoftware.com/wiki/Source_RCON_Protocol).
 *
 * Deadlock's engine2.dll carries the standard `-usercon` / `rcon_password` pair, so a server
 * launched with both answers RCON on its game port over TCP. Commands are serialised; a
 * response ends either when the server mirrors our empty sentinel packet (Source 1 behaviour)
 * or after a short quiet period (some Source 2 servers never mirror it).
 */

import { Socket, connect } from 'node:net';
import { EventEmitter } from 'node:events';

const SERVERDATA_AUTH = 3;
const SERVERDATA_AUTH_RESPONSE = 2;
const SERVERDATA_EXECCOMMAND = 2;
const SERVERDATA_RESPONSE_VALUE = 0;

export interface RconOptions {
  host: string;
  port: number;
  password: string;
  /** Connect + auth timeout. */
  timeoutMs?: number;
  /** Per-command timeout. */
  commandTimeoutMs?: number;
  /** How long to wait after the last response packet before treating a response as complete. */
  quietMs?: number;
}

export function encodePacket(id: number, type: number, body: string): Buffer {
  const bodyBytes = Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(14 + bodyBytes.length);
  buf.writeInt32LE(10 + bodyBytes.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  bodyBytes.copy(buf, 12);
  // Two trailing NULs: body terminator + empty string.
  return buf;
}

export interface RconPacket {
  id: number;
  type: number;
  body: string;
}

/** Splits complete packets off the front of `buf`. Returns them and the unconsumed rest. */
export function decodePackets(buf: Buffer): { packets: RconPacket[]; rest: Buffer } {
  const packets: RconPacket[] = [];
  let off = 0;
  while (buf.length - off >= 4) {
    const size = buf.readInt32LE(off);
    if (size < 10 || size > 1024 * 1024) throw new Error(`Invalid RCON packet size ${size}`);
    if (buf.length - off - 4 < size) break;
    const id = buf.readInt32LE(off + 4);
    const type = buf.readInt32LE(off + 8);
    const bodyEnd = buf.indexOf(0, off + 12);
    const body = buf.toString('utf8', off + 12, bodyEnd === -1 || bodyEnd > off + 4 + size ? off + 2 + size : bodyEnd);
    packets.push({ id, type, body });
    off += 4 + size;
  }
  return { packets, rest: buf.subarray(off) };
}

interface Pending {
  id: number;
  sentinel: number;
  chunks: string[];
  resolve(out: string): void;
  reject(err: Error): void;
  quiet?: NodeJS.Timeout;
  timeout: NodeJS.Timeout;
}

export class RconClient extends EventEmitter {
  private socket?: Socket;
  private buffer: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending?: Pending;
  private queue: Array<() => void> = [];
  private authed = false;

  constructor(private readonly opts: RconOptions) {
    super();
  }

  get connected(): boolean {
    return this.authed && !!this.socket && !this.socket.destroyed;
  }

  /** Connects and authenticates. Rejects on bad password, refusal or timeout. */
  async connect(): Promise<void> {
    const { host, port, password, timeoutMs = 5000 } = this.opts;
    this.close();
    const socket = connect({ host, port });
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    socket.setNoDelay(true);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`RCON connect to ${host}:${port} timed out`));
      }, timeoutMs);
      const authId = this.allocId();
      const onData = (chunk: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        let packets: RconPacket[];
        try {
          ({ packets, rest: this.buffer } = decodePackets(this.buffer));
        } catch (err) {
          cleanup();
          socket.destroy();
          return reject(err as Error);
        }
        for (const p of packets) {
          if (p.type !== SERVERDATA_AUTH_RESPONSE) continue;
          cleanup();
          if (p.id === -1) {
            socket.destroy();
            return reject(new Error('RCON authentication failed (wrong rcon_password?)'));
          }
          this.authed = true;
          socket.on('data', (c) => this.onData(c));
          return resolve();
        }
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        clearTimeout(timer);
        socket.off('data', onData);
        socket.off('error', onError);
      };
      socket.on('data', onData);
      socket.once('error', onError);
      socket.once('connect', () => socket.write(encodePacket(authId, SERVERDATA_AUTH, password)));
    });

    socket.on('error', (err) => this.emit('error', err));
    socket.on('close', () => {
      this.authed = false;
      this.failPending(new Error('RCON connection closed'));
      this.emit('close');
    });
  }

  /** Runs a command and resolves with its full output. Commands are run one at a time. */
  command(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const run = () => {
        if (!this.connected) {
          reject(new Error('RCON is not connected'));
          return this.drain();
        }
        const id = this.allocId();
        const sentinel = this.allocId();
        const timeout = setTimeout(() => this.finish(new Error(`RCON command timed out: ${command}`)), this.opts.commandTimeoutMs ?? 10000);
        this.pending = { id, sentinel, chunks: [], resolve, reject, timeout };
        this.socket!.write(encodePacket(id, SERVERDATA_EXECCOMMAND, command));
        this.socket!.write(encodePacket(sentinel, SERVERDATA_RESPONSE_VALUE, ''));
        // Commands with no output at all still need to complete.
        this.armQuietTimer();
      };
      this.queue.push(run);
      if (!this.pending && this.queue.length === 1) this.drain();
    });
  }

  close(): void {
    this.authed = false;
    this.socket?.destroy();
    this.socket = undefined;
    this.failPending(new Error('RCON connection closed'));
  }

  private allocId(): number {
    this.nextId = (this.nextId % 0x7ffffffe) + 1;
    return this.nextId;
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let packets: RconPacket[];
    try {
      ({ packets, rest: this.buffer } = decodePackets(this.buffer));
    } catch (err) {
      this.emit('error', err);
      this.close();
      return;
    }
    const p = this.pending;
    if (!p) return;
    for (const packet of packets) {
      if (packet.id === p.sentinel) return this.finish();
      if (packet.id === p.id && packet.type === SERVERDATA_RESPONSE_VALUE) {
        p.chunks.push(packet.body);
        this.armQuietTimer();
      }
    }
  }

  private armQuietTimer(): void {
    const p = this.pending;
    if (!p) return;
    if (p.quiet) clearTimeout(p.quiet);
    p.quiet = setTimeout(() => this.finish(), this.opts.quietMs ?? 250);
  }

  private finish(err?: Error): void {
    const p = this.pending;
    if (!p) return;
    this.pending = undefined;
    clearTimeout(p.timeout);
    if (p.quiet) clearTimeout(p.quiet);
    if (err) p.reject(err);
    else p.resolve(p.chunks.join(''));
    this.drain();
  }

  private failPending(err: Error): void {
    if (this.pending) this.finish(err);
    const queued = this.queue.splice(0);
    // Each queued runner rejects itself when it sees the connection is gone.
    for (const run of queued) run();
  }

  private drain(): void {
    if (this.pending) return;
    const next = this.queue.shift();
    if (next) next();
  }
}
