/**
 * The interpreter half of the plugin sandbox. It runs inside the plugin's worker thread
 * (sandbox-worker.ts) and owns the QuickJS runtime: module loading, the guest prelude, CPU and
 * memory limits, and the plumbing that turns host replies into resolved guest promises. Context
 * calls go out through `CoreHost.call`, which the worker answers by asking the main thread.
 */

import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { join, posix, relative, isAbsolute } from 'node:path';
import { getQuickJS, shouldInterruptAfterDeadline, type QuickJSContext, type QuickJSHandle, type QuickJSRuntime } from 'quickjs-emscripten';
import { PRELUDE, SDK_MODULE, SDK_MODULE_SOURCE } from './sandbox-prelude.js';

export interface SandboxLimits {
  /** Heap cap for the plugin's interpreter. */
  memoryMb: number;
  /** CPU time allowed for each call into the plugin. */
  timeLimitMs: number;
}

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = { memoryMb: 64, timeLimitMs: 1000 };

/** Calls into the plugin that may hit a limit before it is shut off. */
const MAX_STRIKES = 3;
const ROOT = '/plugin/';

export interface CoreHost {
  /** Runs a context operation: a JSON envelope now, or a promise of one for async operations. */
  call(op: string, argsJson: string): string | Promise<string>;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
  /** The plugin hit its limits too often; the host should unload it. */
  disabled(reason: string): void;
}

export interface CoreOptions {
  dir: string;
  main: string;
  limits: SandboxLimits;
  host: CoreHost;
}

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxError';
  }
}

export class SandboxCore {
  private alive = true;
  private strikes = 0;
  private disabledReason?: string;
  private guest!: QuickJSHandle;

  private constructor(
    private readonly opts: CoreOptions,
    private readonly runtime: QuickJSRuntime,
    private readonly vm: QuickJSContext,
  ) {}

  /** Creates the interpreter, installs the bridge, and evaluates the plugin's entry module. */
  static async create(opts: CoreOptions): Promise<SandboxCore> {
    const QuickJS = await getQuickJS();
    const runtime = QuickJS.newRuntime();
    runtime.setMemoryLimit(opts.limits.memoryMb * 1024 * 1024);
    runtime.setMaxStackSize(1024 * 1024);
    const vm = runtime.newContext();
    const core = new SandboxCore(opts, runtime, vm);
    try {
      await core.boot();
      return core;
    } catch (err) {
      core.dispose();
      throw err;
    }
  }

  private async boot(): Promise<void> {
    const { vm, runtime, opts } = this;
    const pluginRoot = realpathSync(opts.dir);
    // QuickJS drops errors returned by the normalizer, so a refused import resolves to a marker
    // name that the loader then rejects with the real explanation. Module names are C strings to
    // QuickJS, so the marker must not contain NUL; package paths all start with ROOT.
    const refusals: string[] = [];
    const refuse = (message: string) => `opencitadel-refused:${refusals.push(message) - 1}`;
    runtime.setModuleLoader(
      (name) => {
        if (name === SDK_MODULE) return SDK_MODULE_SOURCE;
        const refused = /^opencitadel-refused:(\d+)$/.exec(name);
        if (refused) return { error: new SandboxError(refusals[Number(refused[1])]!) };
        try {
          const file = join(pluginRoot, ...name.slice(ROOT.length).split('/'));
          const real = realpathSync(file);
          const rel = relative(pluginRoot, real);
          if (rel.startsWith('..') || isAbsolute(rel)) return { error: new SandboxError(`"${name}" resolves outside the plugin package`) };
          return readFileSync(real, 'utf8');
        } catch {
          return { error: new SandboxError(`cannot find module "${name.slice(ROOT.length)}" in the plugin package`) };
        }
      },
      (base, requested) => {
        if (requested === SDK_MODULE) return SDK_MODULE;
        if (requested.startsWith('./') || requested.startsWith('../') || requested.startsWith('/')) {
          // `/x` means the package root, like a bundler's root-relative import.
          const resolved = posix.normalize(requested.startsWith('/') ? posix.join(ROOT, requested.slice(1)) : posix.join(posix.dirname(base), requested));
          if (!resolved.startsWith(ROOT)) return refuse(`"${requested}" points outside the plugin package`);
          return resolved;
        }
        const builtin = requested.startsWith('node:') || /^(fs|path|os|net|http|https|child_process|crypto|url|util|events|stream)(\/|$)/.test(requested);
        return refuse(
          builtin
            ? `"${requested}" is a Node.js module, which sandboxed plugins cannot use. Use the PluginContext API, or set "sandbox": false for this plugin in server.json (it then runs with full access).`
            : `"${requested}" is not available in the sandbox. Bundle dependencies into your package (only relative imports and ${SDK_MODULE} resolve).`,
        );
      },
    );

    const hostFn = vm.newFunction('__ocHost', (opHandle, argsHandle) => this.onHostCall(vm.getString(opHandle), vm.getString(argsHandle)));
    vm.setProp(vm.global, '__ocHost', hostFn);
    hostFn.dispose();

    this.arm();
    const prelude = vm.evalCode(PRELUDE, 'opencitadel-prelude.js', { type: 'global' });
    if (prelude.error) throw this.takeError(prelude.error, 'sandbox prelude failed');
    prelude.value.dispose();
    this.guest = vm.getProp(vm.global, '__ocGuest');

    const main = posix.normalize(posix.join(ROOT, opts.main.replace(/\\/g, '/')));
    if (!main.startsWith(ROOT)) throw new SandboxError('"main" points outside the plugin package');
    if (!existsSync(join(pluginRoot, ...main.slice(ROOT.length).split('/')))) throw new SandboxError(`entry point ${opts.main} does not exist`);
    const entry = `import plugin from ${JSON.stringify(`./${main.slice(ROOT.length)}`)};\nglobalThis.__ocPlugin = plugin;\n`;
    this.arm();
    const res = vm.evalCode(entry, `${ROOT}__entry__.js`, { type: 'module' });
    if (res.error) throw this.takeError(res.error, 'failed to load');
    // Module evaluation can return a promise (top-level await); wait for it to settle.
    await this.settle(res.value, 'failed to load');
  }

  /** Calls `__ocGuest[fn](...args)` and awaits its result. */
  async enter(fn: string, args: string[]): Promise<string | undefined> {
    if (!this.alive) throw new SandboxError('the plugin is unloaded');
    if (this.disabledReason) throw new SandboxError(this.disabledReason);
    const { vm } = this;
    const fnHandle = vm.getProp(this.guest, fn);
    const argHandles = args.map((a) => vm.newString(a));
    this.arm();
    const res = vm.callFunction(fnHandle, this.guest, ...argHandles);
    fnHandle.dispose();
    for (const h of argHandles) h.dispose();
    if (res.error) throw this.takeError(res.error, fn);
    return this.settle(res.value, fn);
  }

  dispose(): void {
    if (!this.alive) return;
    this.alive = false;
    try {
      this.guest?.dispose();
      this.vm.dispose();
      this.runtime.dispose();
    } catch {
      // The worker is going away; nothing useful to do with a teardown error.
    }
  }

  /** Sets the CPU deadline for the next stretch of guest code. */
  private arm(): void {
    this.runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + this.opts.limits.timeLimitMs));
  }

  /** Converts (and disposes) an error handle, counting limit overruns. */
  private takeError(handle: QuickJSHandle, context: string): Error {
    const dumped = this.vm.dump(handle) as { name?: string; message?: string; stack?: string } | string;
    handle.dispose();
    const name = typeof dumped === 'object' && dumped ? dumped.name : undefined;
    const message = typeof dumped === 'object' && dumped ? (dumped.message ?? JSON.stringify(dumped)) : String(dumped);
    const { limits } = this.opts;
    if (/interrupted/i.test(message)) return this.strike(`${context}: exceeded the ${limits.timeLimitMs} ms CPU limit`);
    if (/out of memory/i.test(message)) return this.strike(`${context}: the plugin ran out of memory (limit ${limits.memoryMb} MB)`);
    const err = new Error(`${message}${typeof dumped === 'object' && dumped?.stack ? `\n${dumped.stack.trim()}` : ''}`);
    if (name) err.name = name;
    return err;
  }

  private strike(message: string): Error {
    this.strikes++;
    if (this.strikes >= MAX_STRIKES && !this.disabledReason) {
      this.disabledReason = `hit its CPU or memory limit ${this.strikes} times; disabled until reloaded`;
      this.opts.host.disabled(this.disabledReason);
    }
    return new SandboxError(message);
  }

  /** Runs pending promise jobs (continuations woken by host replies) under a fresh deadline. */
  private pump(): void {
    if (!this.alive) return;
    this.arm();
    const res = this.runtime.executePendingJobs();
    if (res.error) this.opts.host.log('error', this.takeError(res.error, 'async work').message);
  }

  /** Waits for a handle that may be a promise; resolves with its string value (or undefined). */
  private async settle(handle: QuickJSHandle, context: string): Promise<string | undefined> {
    const state = this.vm.getPromiseState(handle);
    if (state.type === 'fulfilled' && state.notAPromise) {
      const value = this.vm.typeof(handle) === 'string' ? this.vm.getString(handle) : undefined;
      handle.dispose();
      return value;
    }
    // An already-settled promise hands out a fresh value handle; resolvePromise below reads it again.
    if (state.type === 'fulfilled') state.value.dispose();
    else if (state.type === 'rejected') state.error.dispose();
    const pending = this.vm.resolvePromise(handle);
    handle.dispose();
    this.pump();
    const res = await pending;
    if (!this.alive) throw new SandboxError(`${context}: the plugin was unloaded`);
    if (res.error) throw this.takeError(res.error, context);
    const value = this.vm.typeof(res.value) === 'string' ? this.vm.getString(res.value) : undefined;
    res.value.dispose();
    return value;
  }

  private onHostCall(op: string, argsJson: string): QuickJSHandle {
    const { vm } = this;
    const reply = this.opts.host.call(op, argsJson);
    if (typeof reply === 'string') return vm.newString(reply);
    const deferred = vm.newPromise();
    reply.then((text) => {
      if (!this.alive || !deferred.alive) return;
      const h = vm.newString(text);
      deferred.resolve(h);
      h.dispose();
      deferred.dispose();
      this.pump();
    });
    return deferred.handle.dup();
  }
}
