/**
 * The host side of the in-game bridge: a loopback TCP server speaking newline-delimited JSON
 * with the OpenCitadel.Bridge Deadworks plugin (see docs/ARCHITECTURE.md, "Bridge protocol").
 *
 * One authenticated connection is active at a time; a newer one (e.g. after a map change or a
 * plugin reload) replaces it. The per-launch token is passed to the game in OPENCITADEL_BRIDGE_TOKEN.
 */

import { EventEmitter } from 'node:events';
import { createServer, type Server, type Socket } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import type { Logger } from '@opencitadel/plugin-sdk';
import { HOST_VERSION } from './version.js';

export interface BridgeHello {
  bridge?: string;
  deadworks?: string;
  map?: string;
}

export interface BridgeOptions {
  port: number;
  host?: string;
  token: string;
  log: Logger;
  pingIntervalMs?: number;
  idleTimeoutMs?: number;
  helloTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxLineBytes?: number;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

type BridgeEvents = {
  connected: [BridgeHello];
  disconnected: [];
  event: [string, Record<string, unknown>];
};

class Connection {
  buffer: Buffer = Buffer.alloc(0);
  authed = false;
  lastSeen = Date.now();
  constructor(readonly socket: Socket) {}
  send(msg: object): void {
    if (!this.socket.destroyed) this.socket.write(JSON.stringify(msg) + '\n');
  }
}

export class BridgeServer extends EventEmitter<BridgeEvents> {
  private server?: Server;
  private active?: Connection;
  private readonly sockets = new Set<Connection>();
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private token: string;
  private pingTimer?: NodeJS.Timeout;

  constructor(private readonly opts: BridgeOptions) {
    super();
    this.token = opts.token;
  }

  get connected(): boolean {
    return !!this.active && !this.active.socket.destroyed;
  }

  get port(): number {
    const addr = this.server?.address();
    return typeof addr === 'object' && addr ? addr.port : this.opts.port;
  }

  /** Changes the expected token (each launch gets a fresh one). Drops the current connection. */
  setToken(token: string): void {
    this.token = token;
    this.active?.socket.destroy();
  }

  async listen(): Promise<void> {
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.opts.port, this.opts.host ?? '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    server.on('error', (err) => this.opts.log.error(`Bridge server error: ${err.message}`));
    const interval = this.opts.pingIntervalMs ?? 15_000;
    this.pingTimer = setInterval(() => this.keepAlive(), Math.min(interval, 5000));
  }

  async close(): Promise<void> {
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const c of this.sockets) c.socket.destroy();
    this.failPending(new Error('Bridge closed'));
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = undefined;
  }

  /** Sends a request to the in-game plugin and resolves with its result. */
  request(method: string, params: Record<string, unknown> = {}, timeoutMs = this.opts.requestTimeoutMs ?? 5000): Promise<unknown> {
    const conn = this.active;
    if (!conn || conn.socket.destroyed) return Promise.reject(new Error('Bridge is not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Bridge request "${method}" timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      conn.send({ type: 'request', id, method, params });
    });
  }

  private accept(socket: Socket): void {
    const conn = new Connection(socket);
    this.sockets.add(conn);
    socket.setNoDelay(true);
    const helloTimer = setTimeout(() => {
      if (!conn.authed) socket.destroy();
    }, this.opts.helloTimeoutMs ?? 5000);
    socket.on('data', (chunk) => this.onData(conn, chunk));
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(helloTimer);
      this.sockets.delete(conn);
      if (this.active === conn) {
        this.active = undefined;
        this.failPending(new Error('Bridge disconnected'));
        this.opts.log.info('In-game bridge disconnected.');
        this.emit('disconnected');
      }
    });
  }

  private onData(conn: Connection, chunk: Buffer): void {
    const max = this.opts.maxLineBytes ?? 64 * 1024;
    conn.buffer = Buffer.concat([conn.buffer, chunk]);
    let nl = conn.buffer.indexOf(0x0a);
    while (nl !== -1) {
      const line = conn.buffer.subarray(0, nl);
      conn.buffer = conn.buffer.subarray(nl + 1);
      if (line.length > max) return this.drop(conn, 'line too long');
      if (line.length) this.onLine(conn, line.toString('utf8'));
      if (conn.socket.destroyed) return;
      nl = conn.buffer.indexOf(0x0a);
    }
    if (conn.buffer.length > max) this.drop(conn, 'line too long');
  }

  private drop(conn: Connection, reason: string): void {
    this.opts.log.warn(`Closing bridge connection: ${reason}`);
    conn.socket.destroy();
  }

  private tokenMatches(candidate: unknown): boolean {
    if (typeof candidate !== 'string') return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private onLine(conn: Connection, line: string): void {
    let msg: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
      msg = parsed as Record<string, unknown>;
    } catch {
      return this.drop(conn, 'invalid JSON');
    }
    conn.lastSeen = Date.now();

    if (!conn.authed) {
      if (msg.type !== 'hello' || !this.tokenMatches(msg.token)) return this.drop(conn, 'bad or missing hello token');
      conn.authed = true;
      const previous = this.active;
      this.active = conn;
      previous?.socket.destroy();
      conn.send({ type: 'welcome', host: HOST_VERSION });
      const hello: BridgeHello = {
        ...(typeof msg.bridge === 'string' ? { bridge: msg.bridge } : {}),
        ...(typeof msg.deadworks === 'string' ? { deadworks: msg.deadworks } : {}),
        ...(typeof msg.map === 'string' ? { map: msg.map } : {}),
      };
      this.opts.log.info(`In-game bridge connected (bridge ${hello.bridge ?? '?'}, deadworks ${hello.deadworks ?? '?'}).`);
      this.emit('connected', hello);
      return;
    }
    if (conn !== this.active) return;

    switch (msg.type) {
      case 'event': {
        if (typeof msg.name !== 'string') return;
        const data = typeof msg.data === 'object' && msg.data !== null && !Array.isArray(msg.data) ? (msg.data as Record<string, unknown>) : {};
        this.emit('event', msg.name, data);
        return;
      }
      case 'response': {
        const id = typeof msg.id === 'number' ? msg.id : -1;
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        clearTimeout(p.timer);
        if (msg.ok === true) p.resolve(msg.result);
        else p.reject(new Error(typeof msg.error === 'string' ? msg.error : 'Bridge request failed'));
        return;
      }
      case 'ping':
        conn.send({ type: 'pong' });
        return;
      default:
        // pong, and message types from newer bridges, just refresh lastSeen.
        return;
    }
  }

  private keepAlive(): void {
    const conn = this.active;
    if (!conn) return;
    const now = Date.now();
    if (now - conn.lastSeen > (this.opts.idleTimeoutMs ?? 45_000)) return this.drop(conn, 'no traffic');
    if (now - conn.lastSeen >= (this.opts.pingIntervalMs ?? 15_000)) conn.send({ type: 'ping' });
  }

  private failPending(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }
}
