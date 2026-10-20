/**
 * Worker-thread entry for one sandboxed plugin. The main thread (sandbox.ts) owns the plugin's
 * context; this thread owns its interpreter, so a plugin that spins or thrashes can only stall
 * itself.
 *
 * Synchronous context calls (state, storage, permission checks) must answer before the guest
 * continues. The worker posts the request, then blocks in `Atomics.wait` on a shared flag; the
 * main thread answers on a dedicated MessagePort and notifies, and the worker reads the reply
 * with `receiveMessageOnPort`. An operation that turns out to be async comes back as `pending`,
 * and its result arrives later as an ordinary message.
 */

import { parentPort, receiveMessageOnPort, workerData, type MessagePort } from 'node:worker_threads';
import { SandboxCore, type CoreHost, type SandboxLimits } from './sandbox-core.js';

export interface WorkerInit {
  dir: string;
  main: string;
  limits: SandboxLimits;
  /** Int32 counter the main thread increments (and notifies) after each sync reply it puts on `syncPort`. */
  signal: SharedArrayBuffer;
  syncPort: MessagePort;
}

/** Messages the main thread sends to the worker. */
export type ToWorker =
  | { type: 'enter'; id: number; fn: string; args: string[] }
  | { type: 'opResult'; callId: number; envelope: string }
  | { type: 'ping'; n: number };

/** Messages the worker sends to the main thread (sync replies travel on `syncPort`). */
export type FromWorker =
  | { type: 'ready' }
  | { type: 'bootError'; message: string }
  | { type: 'op'; seq: number; op: string; args: string }
  | { type: 'entered'; id: number; value?: string; error?: { name: string; message: string } }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string }
  | { type: 'disabled'; reason: string }
  | { type: 'pong'; n: number };

/** What arrives on `syncPort`: the envelope itself, or the id of an async operation. */
export type SyncReply = { seq: number } & ({ done: string } | { pending: number });

/** How long the worker waits for a synchronous reply before giving up on the main thread. */
const SYNC_TIMEOUT_MS = 10_000;

const init = workerData as WorkerInit;
const port = parentPort!;
const flag = new Int32Array(init.signal);
init.syncPort.unref();
const pendingOps = new Map<number, (envelope: string) => void>();
const send = (msg: FromWorker) => port.postMessage(msg);
const failure = (message: string) => JSON.stringify({ err: { name: 'SandboxError', message } });

let seq = 0;

/**
 * Blocks until the reply to request `want` is on the sync port. The counter changes after every
 * reply is queued, so a reply that lands between draining and waiting can't be missed, and a
 * stale reply (to a request that already timed out) is skipped by its sequence number.
 */
function awaitReply(want: number, op: string): SyncReply | string {
  const deadline = Date.now() + SYNC_TIMEOUT_MS;
  let seen = Atomics.load(flag, 0);
  for (;;) {
    for (let r = receiveMessageOnPort(init.syncPort); r; r = receiveMessageOnPort(init.syncPort)) {
      const reply = r.message as SyncReply;
      if (reply.seq === want) return reply;
    }
    const left = deadline - Date.now();
    if (left <= 0 || Atomics.wait(flag, 0, seen, left) === 'timed-out') return failure(`the host did not answer "${op}" within ${SYNC_TIMEOUT_MS} ms`);
    seen = Atomics.load(flag, 0);
  }
}

const host: CoreHost = {
  call(op, args) {
    const want = ++seq;
    send({ type: 'op', seq: want, op, args });
    const reply = awaitReply(want, op);
    if (typeof reply === 'string') return reply;
    if ('done' in reply) return reply.done;
    return new Promise<string>((resolve) => pendingOps.set(reply.pending, resolve));
  },
  log: (level, message) => send({ type: 'log', level, message }),
  // Deferred so the call that tripped the limit reports its own error before the shutdown.
  disabled: (reason) => setImmediate(() => send({ type: 'disabled', reason })),
};

let core: SandboxCore | undefined;

port.on('message', (msg: ToWorker) => {
  switch (msg.type) {
    case 'ping':
      send({ type: 'pong', n: msg.n });
      break;
    case 'opResult': {
      const resolve = pendingOps.get(msg.callId);
      pendingOps.delete(msg.callId);
      resolve?.(msg.envelope);
      break;
    }
    case 'enter':
      if (!core) {
        send({ type: 'entered', id: msg.id, error: { name: 'SandboxError', message: 'the plugin is not loaded' } });
        break;
      }
      core.enter(msg.fn, msg.args).then(
        (value) => send({ type: 'entered', id: msg.id, ...(value !== undefined ? { value } : {}) }),
        (err: Error) => send({ type: 'entered', id: msg.id, error: { name: err.name, message: err.message } }),
      );
      break;
  }
});

SandboxCore.create({ dir: init.dir, main: init.main, limits: init.limits, host }).then(
  (created) => {
    core = created;
    send({ type: 'ready' });
  },
  (err: Error) => send({ type: 'bootError', message: err.message }),
);
