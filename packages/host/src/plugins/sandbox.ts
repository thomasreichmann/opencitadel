/**
 * The host plugin sandbox. Each sandboxed plugin runs in its own QuickJS interpreter compiled to
 * WebAssembly (quickjs-emscripten), on its own worker thread (sandbox-worker.ts, sandbox-core.ts).
 * Inside it there is no `require`, `process`, filesystem, network or Node module: the plugin can
 * import only files from its own package and the virtual `@opencitadel/plugin-sdk`, and it
 * reaches the outside world only through the PluginContext. Every context call crosses to this
 * thread, where it runs against the host's permission-checked context, so the permissions in
 * plugin.json are enforced at a real boundary.
 *
 * Limits per plugin: a memory cap for its heap and a CPU deadline for each call into it, both
 * enforced inside the interpreter. A plugin that hits either limit three times is unloaded. And
 * because the interpreter has its own thread, a plugin that wedges it anyway (QuickJS can't
 * interrupt native builtins or garbage collection) stalls only itself: a watchdog pings every
 * worker and terminates one that stops answering.
 */

import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { MessageChannel, Worker, type MessagePort } from 'node:worker_threads';
import type { PluginManifest } from '@opencitadel/protocol';
import { PermissionError, type CommandInvocation, type Disposable, type EventName, type Logger, type Player, type PluginContext, type PluginDefinition } from '@opencitadel/plugin-sdk';
import { DEFAULT_SANDBOX_LIMITS, SandboxError, type SandboxLimits } from './sandbox-core.js';
import type { FromWorker, SyncReply, ToWorker, WorkerInit } from './sandbox-worker.js';

export { DEFAULT_SANDBOX_LIMITS, type SandboxLimits } from './sandbox-core.js';

const WORKER_URL = new URL('./sandbox-worker.js', import.meta.url);
const PING_INTERVAL_MS = 250;
/** How far past its CPU limit a worker may go quiet before it is terminated. */
const WATCHDOG_GRACE_MS = 2000;
const BOOT_TIMEOUT_MS = 20_000;
const FETCH_TIMEOUT_MS = 15_000;
const FETCH_MAX_BYTES = 1024 * 1024;
const FETCH_MAX_REDIRECTS = 5;

export interface SandboxOptions {
  id: string;
  dir: string;
  manifest: PluginManifest;
  limits?: Partial<SandboxLimits>;
  /** Let `ctx.fetch` reach loopback, private and link-local addresses. Off by default (SSRF). */
  allowPrivateNetwork?: boolean;
  log: Logger;
  /** The plugin was shut off (repeated limit hits, an unresponsive or crashed worker). */
  onFatal?: (reason: string) => void;
  /** How far past its CPU limit the worker may go quiet before it is terminated. Default 2000. */
  watchdogGraceMs?: number;
}

const PRIVATE = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) PRIVATE.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) PRIVATE.addSubnet(net, bits, 'ipv6');

function isPrivateAddress(address: string): boolean {
  const v4mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (v4mapped) return PRIVATE.check(v4mapped[1]!, 'ipv4');
  return PRIVATE.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
}

async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (!addresses.length || addresses.some(isPrivateAddress)) {
    throw new Error(`fetch: ${hostname} is a private or local address; set "allowPrivateNetwork": true for this plugin in server.json to allow it`);
  }
}

function errorEnvelope(err: unknown): string {
  if (err instanceof PermissionError) return JSON.stringify({ err: { name: 'PermissionError', message: err.message, plugin: err.plugin, permission: err.permission } });
  const e = err instanceof Error ? err : new Error(String(err));
  return JSON.stringify({ err: { name: e.name, message: e.message } });
}

function okEnvelope(value: unknown): string {
  return JSON.stringify({ ok: value === undefined ? null : value });
}

/** The function names a host-side API object offers, including inherited class methods. */
function methodNames(api: object): string[] {
  const names = new Set<string>();
  for (let o: object | null = api; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const k of Object.getOwnPropertyNames(o)) if (k !== 'constructor' && typeof (api as Record<string, unknown>)[k] === 'function') names.add(k);
  }
  return [...names];
}

function isPlayer(value: unknown): value is Player {
  return typeof value === 'object' && value !== null && typeof (value as Player).name === 'string';
}

export class PluginSandbox {
  private alive = true;
  private ctx?: PluginContext;
  private nextSub = 1;
  private readonly subs = new Map<number, Disposable>();
  private readonly timerSubs = new Map<number, Disposable>();
  private readonly invocations = new Map<string, CommandInvocation>();
  private nextEnter = 1;
  private readonly enters = new Map<number, { resolve: (v: string | undefined) => void; reject: (e: Error) => void }>();
  private nextCall = 1;
  private lastPong = Date.now();
  private pingCount = 0;
  private pinger?: NodeJS.Timeout;
  private booted?: { resolve: () => void; reject: (e: Error) => void };

  private constructor(
    private readonly opts: SandboxOptions,
    private readonly limits: SandboxLimits,
    private readonly worker: Worker,
    private readonly counter: Int32Array,
    private readonly syncPort: MessagePort,
  ) {
    worker.on('message', (msg: FromWorker) => this.onMessage(msg));
    worker.on('error', (err) => this.die(`crashed: ${err.message}`));
    worker.on('exit', (code) => this.die(`exited unexpectedly (code ${code})`));
  }

  /** Starts the plugin's worker and waits until its entry module has loaded. */
  static async create(opts: SandboxOptions): Promise<PluginSandbox> {
    const limits = { ...DEFAULT_SANDBOX_LIMITS, ...opts.limits };
    const signal = new SharedArrayBuffer(4);
    const { port1, port2 } = new MessageChannel();
    const init: WorkerInit = { dir: opts.dir, main: opts.manifest.main!, limits, signal, syncPort: port2 };
    const worker = new Worker(WORKER_URL, {
      workerData: init,
      transferList: [port2],
      // The interpreter's heap is WebAssembly memory, capped by QuickJS; this caps the worker's own JS.
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      env: {},
      argv: [],
    });
    const sandbox = new PluginSandbox(opts, limits, worker, new Int32Array(signal), port1);
    await sandbox.boot();
    return sandbox;
  }

  private boot(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.booted = undefined;
        this.stop();
        reject(new SandboxError(`the plugin did not finish loading within ${BOOT_TIMEOUT_MS / 1000} s`));
      }, BOOT_TIMEOUT_MS);
      this.booted = {
        resolve: () => {
          clearTimeout(timer);
          this.startWatchdog();
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          this.stop();
          reject(err);
        },
      };
    });
  }

  /** Host-side PluginDefinition the runtime treats like any imported plugin. */
  definition(): PluginDefinition {
    return {
      setup: async (ctx) => {
        this.ctx = ctx;
        const info = { id: ctx.id, version: ctx.version, config: ctx.config, dataDir: ctx.dataDir };
        const hasCleanup = JSON.parse((await this.enter('setup', [JSON.stringify(info)])) ?? 'false') as boolean;
        return hasCleanup
          ? async () => {
              if (this.alive) await this.enter('cleanup', []);
            }
          : undefined;
      },
    };
  }

  /** Normal unload: stops the worker without reporting a failure. */
  dispose(): void {
    this.stop();
  }

  // ---------------------------------------------------------------- worker lifecycle

  private startWatchdog(): void {
    const limit = this.limits.timeLimitMs + (this.opts.watchdogGraceMs ?? WATCHDOG_GRACE_MS);
    this.lastPong = Date.now();
    this.pinger = setInterval(() => {
      const quiet = Date.now() - this.lastPong;
      if (quiet > limit) return this.die(`stopped responding for ${quiet} ms (limit ${limit} ms); its worker was terminated`);
      this.post({ type: 'ping', n: ++this.pingCount });
    }, PING_INTERVAL_MS);
    this.pinger.unref();
  }

  /** Stops the worker and releases everything; pending calls reject with `reason`. */
  private stop(reason = 'the plugin was unloaded'): boolean {
    if (!this.alive) return false;
    this.alive = false;
    if (this.pinger) clearInterval(this.pinger);
    for (const d of [...this.subs.values(), ...this.timerSubs.values()]) d.dispose();
    this.subs.clear();
    this.timerSubs.clear();
    this.invocations.clear();
    for (const e of this.enters.values()) e.reject(new SandboxError(reason));
    this.enters.clear();
    this.syncPort.close();
    void this.worker.terminate();
    return true;
  }

  /** The plugin can't go on: stop it and tell the runtime. */
  private die(reason: string): void {
    if (this.booted) {
      const booted = this.booted;
      this.booted = undefined;
      booted.reject(new SandboxError(reason));
      return;
    }
    if (this.stop(reason)) this.opts.onFatal?.(reason);
  }

  private post(msg: ToWorker): void {
    if (this.alive) this.worker.postMessage(msg);
  }

  private onMessage(msg: FromWorker): void {
    switch (msg.type) {
      case 'op':
        return this.answer(msg.seq, msg.op, msg.args);
      case 'entered': {
        const pending = this.enters.get(msg.id);
        this.enters.delete(msg.id);
        if (!pending) return;
        if (msg.error) {
          const err = new Error(msg.error.message);
          err.name = msg.error.name;
          pending.reject(err);
        } else {
          pending.resolve(msg.value);
        }
        return;
      }
      case 'pong':
        this.lastPong = Date.now();
        return;
      case 'log': {
        const fn = (['debug', 'info', 'warn', 'error'] as const).find((l) => l === msg.level) ?? 'info';
        (this.ctx?.log ?? this.opts.log)[fn](String(msg.message).slice(0, 4000));
        return;
      }
      case 'disabled':
        return this.die(msg.reason);
      case 'ready': {
        const booted = this.booted;
        this.booted = undefined;
        return booted?.resolve();
      }
      case 'bootError': {
        const booted = this.booted;
        this.booted = undefined;
        return booted?.reject(new SandboxError(msg.message));
      }
    }
  }

  /** Calls `__ocGuest[fn](...args)` in the worker and awaits its result. */
  private enter(fn: string, args: string[]): Promise<string | undefined> {
    if (!this.alive) return Promise.reject(new SandboxError('the plugin is unloaded'));
    return new Promise((resolve, reject) => {
      const id = this.nextEnter++;
      this.enters.set(id, { resolve, reject });
      this.post({ type: 'enter', id, fn, args });
    });
  }

  // ---------------------------------------------------------------- context calls from the guest

  /** Answers a context call on the sync port. An async operation answers `pending`, then posts its result. */
  private answer(seq: number, op: string, argsJson: string): void {
    let reply: SyncReply;
    try {
      const handler = this.ops[op];
      if (!handler) throw new Error(`unknown sandbox operation "${op}"`);
      if (!this.ctx && op !== 'log') throw new Error('the plugin context is not ready yet (call context methods from setup())');
      const result = handler(JSON.parse(argsJson));
      if (result instanceof Promise) {
        const callId = this.nextCall++;
        reply = { seq, pending: callId };
        result.then(
          (value) => this.post({ type: 'opResult', callId, envelope: okEnvelope(value) }),
          (err) => this.post({ type: 'opResult', callId, envelope: errorEnvelope(err) }),
        );
      } else {
        reply = { seq, done: okEnvelope(result) };
      }
    } catch (err) {
      reply = { seq, done: errorEnvelope(err) };
    }
    if (!this.alive) return;
    this.syncPort.postMessage(reply);
    Atomics.add(this.counter, 0, 1);
    Atomics.notify(this.counter, 0);
  }

  private keep(d: Disposable): number {
    const sub = this.nextSub++;
    this.subs.set(sub, d);
    return sub;
  }

  private player(value: unknown): Player {
    if (!isPlayer(value)) throw new TypeError('expected a player object');
    return value;
  }

  private readonly ops: Record<string, (args: any) => unknown> = {
    log: ({ level, message }: { level: string; message: string }) => {
      const fn = (['debug', 'info', 'warn', 'error'] as const).find((l) => l === level) ?? 'info';
      (this.ctx?.log ?? this.opts.log)[fn](String(message).slice(0, 4000));
    },
    state: () => this.ctx!.server.state,
    command: ({ command }: { command: string }) => this.ctx!.server.command(command),
    say: ({ message }: { message: string }) => this.ctx!.server.say(message),
    tell: ({ player, message }: { player: unknown; message: string }) => this.ctx!.server.tell(this.player(player), message),
    kick: ({ player, reason }: { player: unknown; reason?: string }) => this.ctx!.server.kick(this.player(player), reason === undefined ? undefined : String(reason)),
    changeMap: ({ map }: { map: string }) => this.ctx!.server.changeMap(map),
    findPlayer: ({ query }: { query: string }) => this.ctx!.server.findPlayer(query) ?? null,

    on: ({ id, event }: { id: number; event: EventName }) => this.keep(this.ctx!.on(event, (payload) => this.enter('dispatch', [String(id), JSON.stringify(payload)]).then(() => undefined))),
    register: ({ id, name, description, access, aliases }: { id: number; name: string; description?: string; access?: 'everyone' | 'admin'; aliases?: string[] }) =>
      this.keep(
        this.ctx!.commands.register(name, {
          ...(description !== undefined ? { description: String(description) } : {}),
          ...(access !== undefined ? { access } : {}),
          ...(Array.isArray(aliases) ? { aliases: aliases.map(String) } : {}),
          handler: async (inv) => {
            const token = `${id}:${Math.random().toString(36).slice(2)}`;
            this.invocations.set(token, inv);
            try {
              await this.enter('command', [String(id), JSON.stringify({ player: inv.player ?? null, args: inv.args, raw: inv.raw, isAdmin: inv.isAdmin, token })]);
            } finally {
              this.invocations.delete(token);
            }
          },
        }),
      ),
    reply: ({ token, message }: { token: string; message: string }) => {
      const inv = this.invocations.get(token);
      if (!inv) throw new Error('reply() was called after the command finished');
      return inv.reply(message);
    },
    dispose: ({ sub }: { sub: number }) => {
      this.subs.get(sub)?.dispose();
      this.subs.delete(sub);
    },

    setTimeout: ({ id, ms }: { id: number; ms: number }) => {
      this.timerSubs.set(id, this.ctx!.timers.setTimeout(() => {
        this.timerSubs.delete(id);
        return this.enter('timer', [String(id)]);
      }, ms));
    },
    setInterval: ({ id, ms }: { id: number; ms: number }) => {
      this.timerSubs.set(id, this.ctx!.timers.setInterval(() => this.enter('timer', [String(id)]), ms));
    },
    clearTimer: ({ id }: { id: number }) => {
      this.timerSubs.get(id)?.dispose();
      this.timerSubs.delete(id);
    },

    setTags: ({ tags }: { tags: string[] }) => this.ctx!.listing.setTags(tags),
    setGameMode: ({ mode }: { mode?: string }) => this.ctx!.listing.setGameMode(mode ?? undefined),
    setMetadata: ({ key, value }: { key: string; value?: string }) => this.ctx!.listing.setMetadata(key, value ?? undefined),

    storageGet: ({ key }: { key: string }) => this.ctx!.storage.get(key) ?? null,
    storageSet: ({ key, value }: { key: string; value: unknown }) => this.ctx!.storage.set(key, value),
    storageDelete: ({ key }: { key: string }) => this.ctx!.storage.delete(key),
    storageKeys: () => this.ctx!.storage.keys(),

    expose: ({ methods }: { methods: string[] }) => {
      const api: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
      for (const m of methods.map(String)) {
        api[m] = async (...args: unknown[]) => {
          const out = await this.enter('call', [m, JSON.stringify(args)]);
          return out === undefined ? undefined : JSON.parse(out);
        };
      }
      this.ctx!.plugins.expose(api);
    },
    get: ({ id }: { id: string }) => {
      const api = this.ctx!.plugins.get(id);
      return api ? methodNames(api) : null;
    },
    invoke: async ({ id, method, args }: { id: string; method: string; args: unknown[] }) => {
      const api = this.ctx!.plugins.get(id) as Record<string, unknown> | undefined;
      const fn = api?.[method];
      if (typeof fn !== 'function') throw new Error(`plugin "${id}" exposes no method "${method}"`);
      return await (fn as (...a: unknown[]) => unknown).apply(api, Array.isArray(args) ? args : []);
    },

    fetch: ({ url, init }: { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }) => {
      // Checked before going async so a missing permission throws right away, as it does unsandboxed.
      if (!this.opts.manifest.permissions.includes('network')) throw new PermissionError(this.opts.id, 'network');
      return this.fetch(url, init ?? {});
    },
  };

  /**
   * `ctx.fetch` for sandboxed plugins: http(s) only, public addresses only unless allowed
   * (re-checked on every redirect hop), a timeout, and a capped text body.
   */
  private async fetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) {
    let target = new URL(url);
    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    for (let hop = 0; ; hop++) {
      if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('fetch: only http and https URLs are allowed');
      if (!this.opts.allowPrivateNetwork) await assertPublicHost(target.hostname);
      const res = await this.ctx!.fetch(target, {
        method: init.method ?? 'GET',
        headers: init.headers ?? {},
        ...(init.body !== undefined ? { body: init.body } : {}),
        redirect: 'manual',
        signal,
      });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        if (hop >= FETCH_MAX_REDIRECTS) throw new Error('fetch: too many redirects');
        target = new URL(location, target);
        continue;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      if (res.body) {
        for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
          size += chunk.byteLength;
          if (size > FETCH_MAX_BYTES) {
            await res.body.cancel().catch(() => {});
            throw new Error(`fetch: response is larger than ${FETCH_MAX_BYTES} bytes`);
          }
          chunks.push(Buffer.from(chunk));
        }
      }
      return {
        status: res.status,
        statusText: res.statusText,
        url: target.href,
        redirected: hop > 0,
        headers: Object.fromEntries([...res.headers].map(([k, v]) => [k.toLowerCase(), v])),
        body: Buffer.concat(chunks).toString('utf8'),
      };
    }
  }
}
