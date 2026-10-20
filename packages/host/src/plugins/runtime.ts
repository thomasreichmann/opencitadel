/**
 * The host plugin runtime: discovers enabled host plugins under `.opencitadel/plugins/`, orders
 * them by dependency, imports them, and gives each a permission-checked PluginContext. Every
 * call into plugin code is isolated: a throwing or hanging plugin is logged, never fatal.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseManifest, resolvePluginConfig, satisfies, type PluginManifest } from '@opencitadel/protocol';
import {
  PermissionError,
  type CommandInvocation,
  type CommandsApi,
  type Disposable,
  type EventName,
  type ListingApi,
  type Logger,
  type Permission,
  type Player,
  type PluginContext,
  type PluginDefinition,
  type PluginEvents,
  type PluginsApi,
  type ServerApi,
  type StorageApi,
  type TimersApi,
} from '@opencitadel/plugin-sdk';
import { hostPaths, loadHostConfig, type HostConfig, type PluginSettings } from '../config.js';
import type { HostServices, ListingContributions, PluginHost } from '../services.js';
import { CommandRegistry, parseCommand } from './commands.js';
import { ensurePluginEnvironment } from './environment.js';
import { readInstalled, type InstalledIndex } from './installed.js';
import { PluginSandbox } from './sandbox.js';
import { PluginStorage } from './storage.js';
import { HOST_VERSION } from './version.js';

export const EVENT_NAMES: ReadonlySet<string> = new Set<EventName>([
  'server.starting',
  'server.ready',
  'server.stopped',
  'map.changed',
  'player.connected',
  'player.disconnected',
  'chat.message',
  'console.line',
  'game.event',
  'tick',
]);

const TAG = /^[a-z0-9][a-z0-9_-]{0,23}$/;
const METADATA_KEY = /^[A-Za-z0-9_.-]{1,40}$/;
const MAX_TAGS = 16;
const MAX_METADATA = 32;
const MAP_NAME = /^[A-Za-z0-9_]+$/;
const CHAT_LINE = 120;

type Handler = (payload: unknown) => void | Promise<void>;

interface Candidate {
  id: string;
  dir: string;
  manifest: PluginManifest;
  settings: PluginSettings;
}

interface LoadedPlugin {
  id: string;
  version: string;
  manifest: PluginManifest;
  dir: string;
  log: Logger;
  handlers: Map<string, Set<Handler>>;
  disposables: Set<() => void>;
  cleanup?: () => void | Promise<void>;
  storage: PluginStorage;
  listing: { tags: string[]; gameMode?: { value: string; seq: number }; metadata: Map<string, string> };
}

export interface RuntimeOptions {
  /** Warn when a handler runs (or stays pending) longer than this. Default 5000. */
  slowHandlerMs?: number;
  /** Storage write debounce. Default 250. */
  storageDebounceMs?: number;
}

export interface PluginStatus {
  loaded: Array<{ id: string; version: string }>;
  /** Plugins that are enabled but could not load, with the reason. */
  failed: Record<string, string>;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Finds a player by `#slot`/slot, SteamID, SteamID64, exact name, or unique name prefix. */
export function findPlayer(players: readonly Player[], query: string): Player | undefined {
  const q = query.trim();
  if (!q) return undefined;
  const slot = /^#?(\d{1,3})$/.exec(q);
  if (slot) {
    const hit = players.find((p) => p.slot === Number(slot[1]));
    if (hit) return hit;
  }
  const lower = q.toLowerCase();
  const byId = players.find((p) => p.steamId?.toLowerCase() === lower || p.steamId64 === q);
  if (byId) return byId;
  const exact = players.filter((p) => p.name.toLowerCase() === lower);
  if (exact.length === 1) return exact[0];
  const prefix = players.filter((p) => p.name.toLowerCase().startsWith(lower));
  return prefix.length === 1 ? prefix[0] : undefined;
}

/** Splits `items` into lines no longer than `max` characters, joined with `sep`. */
function chunkLines(items: string[], max: number, sep = ', '): string[] {
  const lines: string[] = [];
  let line = '';
  for (const item of items) {
    if (line && line.length + sep.length + item.length > max) {
      lines.push(line);
      line = item;
    } else {
      line = line ? line + sep + item : item;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export class PluginRuntime implements PluginHost {
  private config: HostConfig;
  private readonly paths: ReturnType<typeof hostPaths>;
  private readonly log: Logger;
  private readonly slowMs: number;
  private readonly plugins: LoadedPlugin[] = [];
  private readonly commands = new CommandRegistry();
  private readonly exposed = new Map<string, object>();
  private readonly failures = new Map<string, string>();
  private importCounter = 0;
  private seq = 0;

  constructor(
    private readonly services: HostServices,
    config: HostConfig,
    private readonly opts: RuntimeOptions = {},
  ) {
    this.config = config;
    this.paths = hostPaths(services.serverDir);
    this.log = services.logger('plugins');
    this.slowMs = opts.slowHandlerMs ?? 5000;
  }

  // ---------------------------------------------------------------- lifecycle

  async loadAll(): Promise<void> {
    await ensurePluginEnvironment(this.paths.pluginsDir);
    const { ordered } = await this.plan();
    for (const c of ordered) {
      if (this.plugins.some((p) => p.id === c.id)) continue;
      await this.loadOne(c);
    }
  }

  async unloadAll(): Promise<void> {
    for (const plugin of [...this.plugins].reverse()) await this.unloadOne(plugin);
  }

  async reload(id?: string): Promise<void> {
    await this.refreshConfig();
    if (!id) {
      await this.unloadAll();
      this.failures.clear();
      await this.loadAll();
      return;
    }
    await ensurePluginEnvironment(this.paths.pluginsDir);
    const { ordered, candidates } = await this.plan();
    // The plugin plus everything that (transitively) depends on it.
    const affected = new Set<string>([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const c of candidates.values()) {
        if (!affected.has(c.id) && Object.keys(c.manifest.dependencies).some((d) => affected.has(d))) {
          affected.add(c.id);
          grew = true;
        }
      }
      for (const p of this.plugins) {
        if (!affected.has(p.id) && Object.keys(p.manifest.dependencies).some((d) => affected.has(d))) {
          affected.add(p.id);
          grew = true;
        }
      }
    }
    for (const plugin of [...this.plugins].reverse()) if (affected.has(plugin.id)) await this.unloadOne(plugin);
    for (const c of ordered) if (affected.has(c.id)) await this.loadOne(c);
    if (!candidates.has(id) && !this.failures.has(id)) this.log.info(`${id} is not enabled; unloaded`);
  }

  status(): PluginStatus {
    return { loaded: this.loaded(), failed: Object.fromEntries(this.failures) };
  }

  loaded(): Array<{ id: string; version: string }> {
    return this.plugins.map((p) => ({ id: p.id, version: p.version }));
  }

  private async refreshConfig(): Promise<void> {
    if (!existsSync(this.paths.config)) return;
    try {
      this.config = await loadHostConfig(this.services.serverDir);
    } catch (err) {
      this.log.warn(`Keeping the previous config: ${errorText(err)}`);
    }
  }

  private fail(id: string, reason: string): void {
    this.failures.set(id, reason);
    this.log.error(`Plugin "${id}" not loaded: ${reason}`);
  }

  // ---------------------------------------------------------------- discovery & ordering

  /** Enabled host plugins found on disk, keyed by id. Records failures for broken ones. */
  private async discover(installed: InstalledIndex): Promise<Map<string, Candidate>> {
    const found = new Map<string, Candidate>();
    const dir = this.paths.pluginsDir;
    const entries = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const pluginDir = join(dir, entry.name);
      const manifestFile = join(pluginDir, 'plugin.json');
      if (!existsSync(manifestFile)) continue;
      const settings = this.config.plugins[entry.name];
      if (!settings?.enabled) continue;
      let manifest: PluginManifest;
      try {
        manifest = parseManifest(JSON.parse(readFileSync(manifestFile, 'utf8')));
      } catch (err) {
        this.fail(entry.name, `invalid plugin.json: ${errorText(err)}`);
        continue;
      }
      if (manifest.id !== entry.name) {
        this.fail(entry.name, `plugin.json id "${manifest.id}" does not match its directory name`);
        continue;
      }
      if (manifest.kind !== 'host') continue;
      found.set(manifest.id, { id: manifest.id, dir: pluginDir, manifest, settings });
    }
    for (const [id, settings] of Object.entries(this.config.plugins)) {
      if (!settings.enabled || found.has(id) || this.failures.has(id)) continue;
      const pkg = installed[id];
      if (pkg && pkg.kind !== 'host') continue;
      this.fail(id, pkg ? 'installed but its files are missing; reinstall it' : 'enabled in server.json but not installed');
    }
    return found;
  }

  /** Discovers candidates and returns them in load order; records failures. */
  private async plan(): Promise<{ ordered: Candidate[]; candidates: Map<string, Candidate> }> {
    let installed: InstalledIndex = {};
    try {
      installed = await readInstalled(this.services.serverDir);
    } catch (err) {
      this.log.warn(errorText(err));
    }
    const candidates = await this.discover(installed);
    for (const id of candidates.keys()) this.failures.delete(id);

    const bad = new Map<string, string>();
    for (const c of candidates.values()) {
      const engine = c.manifest.engines.opencitadel;
      if (engine && !satisfies(HOST_VERSION, engine)) {
        bad.set(c.id, `needs citadel-host ${engine}, this is ${HOST_VERSION}`);
        continue;
      }
      for (const [dep, range] of Object.entries(c.manifest.dependencies)) {
        const local = candidates.get(dep);
        const version = local?.manifest.version ?? installed[dep]?.version;
        if (!version) {
          bad.set(c.id, `missing dependency "${dep}" (${range})`);
        } else if (!local && installed[dep]?.kind === 'host') {
          bad.set(c.id, `depends on "${dep}", which is installed but not enabled`);
        } else if (!satisfies(version, range)) {
          bad.set(c.id, `needs ${dep}@${range}, but ${version} is installed`);
        }
        if (bad.has(c.id)) break;
      }
    }

    const ordered: Candidate[] = [];
    const state = new Map<string, 'visiting' | 'done'>();
    const visit = (id: string, stack: string[]): boolean => {
      if (bad.has(id)) return false;
      const s = state.get(id);
      if (s === 'done') return true;
      if (s === 'visiting') {
        const cycle = [...stack.slice(stack.indexOf(id)), id];
        for (const member of cycle) bad.set(member, `dependency cycle: ${cycle.join(' → ')}`);
        return false;
      }
      state.set(id, 'visiting');
      const c = candidates.get(id)!;
      for (const dep of Object.keys(c.manifest.dependencies)) {
        if (!candidates.has(dep)) continue; // satisfied by a non-host package
        if (!visit(dep, [...stack, id])) {
          if (!bad.has(id)) bad.set(id, `dependency "${dep}" cannot load`);
          state.set(id, 'done');
          return false;
        }
      }
      state.set(id, 'done');
      if (bad.has(id)) return false;
      ordered.push(c);
      return true;
    };
    for (const id of [...candidates.keys()].sort()) visit(id, []);
    for (const [id, reason] of bad) this.fail(id, reason);
    return { ordered: ordered.filter((c) => !bad.has(c.id)), candidates };
  }

  // ---------------------------------------------------------------- loading

  private async loadOne(c: Candidate): Promise<void> {
    for (const dep of Object.keys(c.manifest.dependencies)) {
      if (this.failures.has(dep)) return this.fail(c.id, `dependency "${dep}" failed to load`);
    }
    let config: Record<string, unknown>;
    try {
      config = resolvePluginConfig(c.manifest, c.settings.config);
    } catch (err) {
      return this.fail(c.id, `bad config in server.json: ${errorText(err)}`);
    }
    const main = resolve(c.dir, c.manifest.main!);
    const rel = relative(c.dir, main);
    if (rel.startsWith('..') || isAbsolute(rel)) return this.fail(c.id, `"main" points outside the plugin directory`);
    if (!existsSync(main)) return this.fail(c.id, `entry point ${c.manifest.main} does not exist`);

    const log = this.services.logger(`plugin:${c.id}`);
    let definition: PluginDefinition;
    let sandbox: PluginSandbox | undefined;
    // Set once the plugin is loaded, so a sandbox that dies later can be unloaded and reported.
    let loaded: LoadedPlugin | undefined;
    if (c.settings.sandbox) {
      try {
        sandbox = await PluginSandbox.create({
          id: c.id,
          dir: c.dir,
          manifest: c.manifest,
          limits: { memoryMb: c.settings.memoryMb, timeLimitMs: c.settings.timeLimitMs },
          allowPrivateNetwork: c.settings.allowPrivateNetwork,
          log,
          onFatal: (reason) => {
            if (!loaded || !this.plugins.includes(loaded)) return;
            const plugin = loaded;
            void this.unloadOne(plugin).then(() => this.fail(c.id, reason));
          },
        });
        definition = sandbox.definition();
      } catch (err) {
        return this.fail(c.id, `failed to load in the sandbox: ${errorText(err)}`);
      }
    } else {
      log.warn('Running WITHOUT the sandbox ("sandbox": false in server.json): this plugin has full access to this machine');
      try {
        const mod = (await import(`${pathToFileURL(main).href}?v=${++this.importCounter}`)) as { default?: unknown };
        const def = mod.default as PluginDefinition | undefined;
        if (!def || typeof def !== 'object' || typeof def.setup !== 'function') throw new Error('the default export must be definePlugin({ setup(ctx) { … } })');
        definition = def;
      } catch (err) {
        return this.fail(c.id, `failed to import: ${errorText(err)}`);
      }
    }

    const dataDir = join(this.paths.dataDir, c.id);
    mkdirSync(dataDir, { recursive: true });
    const plugin: LoadedPlugin = {
      id: c.id,
      version: c.manifest.version,
      manifest: c.manifest,
      dir: c.dir,
      log,
      handlers: new Map(),
      disposables: new Set(),
      storage: new PluginStorage(join(dataDir, 'storage.json'), this.opts.storageDebounceMs, (err) => log.error(`storage: ${err.message}`)),
      listing: { tags: [], metadata: new Map() },
    };
    // Disposables run after cleanup on unload (and if setup fails), so the interpreter goes last.
    if (sandbox) plugin.disposables.add(() => sandbox.dispose());
    const ctx = this.createContext(plugin, config, dataDir);
    try {
      const result = await this.track(plugin, 'setup()', () => definition.setup(ctx));
      if (typeof result === 'function') plugin.cleanup = result as () => void | Promise<void>;
    } catch (err) {
      await this.dispose(plugin);
      return this.fail(c.id, `setup() threw: ${errorText(err)}`);
    }
    this.failures.delete(c.id);
    this.plugins.push(plugin);
    loaded = plugin;
    this.log.info(`Loaded ${c.id}@${c.manifest.version}`);
  }

  private async unloadOne(plugin: LoadedPlugin): Promise<void> {
    if (plugin.cleanup) {
      try {
        await this.track(plugin, 'cleanup', plugin.cleanup);
      } catch (err) {
        plugin.log.error(`cleanup threw: ${errorText(err)}`);
      }
    }
    await this.dispose(plugin);
    const idx = this.plugins.indexOf(plugin);
    if (idx !== -1) this.plugins.splice(idx, 1);
    this.log.info(`Unloaded ${plugin.id}`);
  }

  private async dispose(plugin: LoadedPlugin): Promise<void> {
    for (const d of [...plugin.disposables]) {
      try {
        d();
      } catch (err) {
        plugin.log.error(`dispose: ${errorText(err)}`);
      }
    }
    plugin.disposables.clear();
    plugin.handlers.clear();
    this.commands.removePlugin(plugin.id);
    if (this.exposed.has(plugin.id)) this.exposed.delete(plugin.id);
    await plugin.storage.flush();
  }

  /** Awaits plugin code, warning if it is still pending after the slow threshold. */
  private async track<T>(plugin: LoadedPlugin, label: string, fn: () => T | Promise<T>): Promise<T> {
    const timer = setTimeout(() => plugin.log.warn(`${label} has not finished after ${this.slowMs} ms`), this.slowMs);
    timer.unref();
    try {
      return await fn();
    } finally {
      clearTimeout(timer);
    }
  }

  /** Runs plugin code without awaiting it; errors and slowness are logged. */
  private invoke(plugin: LoadedPlugin, label: string, fn: () => unknown): void {
    const started = performance.now();
    let result: unknown;
    try {
      result = fn();
    } catch (err) {
      plugin.log.error(`${label} threw: ${errorText(err)}`);
      return;
    }
    const elapsed = performance.now() - started;
    if (elapsed > this.slowMs) plugin.log.warn(`${label} blocked for ${Math.round(elapsed)} ms`);
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      const timer = setTimeout(() => plugin.log.warn(`${label} has not finished after ${this.slowMs} ms`), this.slowMs);
      timer.unref();
      (result as Promise<unknown>).then(
        () => clearTimeout(timer),
        (err) => {
          clearTimeout(timer);
          plugin.log.error(`${label} failed: ${errorText(err)}`);
        },
      );
    }
  }

  // ---------------------------------------------------------------- context

  private createContext(plugin: LoadedPlugin, config: Record<string, unknown>, dataDir: string): PluginContext {
    const { services } = this;
    const need = (permission: Permission) => {
      if (!plugin.manifest.permissions.includes(permission)) throw new PermissionError(plugin.id, permission);
    };
    const track = (dispose: () => void): Disposable => {
      plugin.disposables.add(dispose);
      return {
        dispose: () => {
          plugin.disposables.delete(dispose);
          dispose();
        },
      };
    };

    const server: ServerApi = {
      get state() {
        return services.getState();
      },
      command(command) {
        need('server.command');
        return services.command(command);
      },
      say(message) {
        need('server.chat');
        return services.say(message);
      },
      tell(player, message) {
        need('server.chat');
        return services.tell(player, message);
      },
      kick(player, reason) {
        need('players.manage');
        return services.kick(player, reason);
      },
      changeMap(map) {
        need('server.command');
        if (!MAP_NAME.test(map)) throw new Error(`Invalid map name "${map}"`);
        return services.command(`changelevel ${map}`).then(() => undefined);
      },
      findPlayer(query) {
        return findPlayer(services.getState().players, query);
      },
    };

    const commands: CommandsApi = {
      register: (name, options) => {
        const handle = this.commands.register(plugin.id, name, options, plugin.log);
        return track(() => handle.dispose());
      },
    };

    const listing: ListingApi = {
      setTags: (tags) => {
        need('listing.write');
        if (!Array.isArray(tags)) throw new TypeError('setTags expects an array of strings');
        const clean = [...new Set(tags.map((t) => String(t).trim().toLowerCase()))];
        for (const t of clean) if (!TAG.test(t)) throw new Error(`Invalid tag "${t}" (a-z, 0-9, - and _, max 24)`);
        if (clean.length > MAX_TAGS) throw new Error(`At most ${MAX_TAGS} tags`);
        plugin.listing.tags = clean;
      },
      setGameMode: (mode) => {
        need('listing.write');
        if (mode === undefined || mode === '') {
          delete plugin.listing.gameMode;
          return;
        }
        const value = String(mode).trim().slice(0, 48);
        plugin.listing.gameMode = { value, seq: ++this.seq };
      },
      setMetadata: (key, value) => {
        need('listing.write');
        if (!METADATA_KEY.test(key)) throw new Error(`Invalid metadata key "${key}"`);
        if (value === undefined) plugin.listing.metadata.delete(key);
        else plugin.listing.metadata.set(key, String(value).slice(0, 200));
      },
    };

    const storage: StorageApi = {
      get: (key) => {
        need('storage');
        return plugin.storage.get(key);
      },
      set: (key, value) => {
        need('storage');
        plugin.storage.set(key, value);
      },
      delete: (key) => {
        need('storage');
        plugin.storage.delete(key);
      },
      keys: () => {
        need('storage');
        return plugin.storage.keys();
      },
    };

    const timers: TimersApi = {
      setTimeout: (fn, ms) => {
        let handle: Disposable | undefined;
        const t = setTimeout(() => {
          handle?.dispose();
          this.invoke(plugin, 'timeout', fn);
        }, ms);
        t.unref();
        handle = track(() => clearTimeout(t));
        return handle;
      },
      setInterval: (fn, ms) => {
        const t = setInterval(() => this.invoke(plugin, 'interval', fn), Math.max(ms, 10));
        t.unref();
        return track(() => clearInterval(t));
      },
    };

    const pluginsApi: PluginsApi = {
      expose: (api) => {
        if (typeof api !== 'object' || api === null) throw new TypeError('expose() takes an object');
        this.exposed.set(plugin.id, api);
      },
      get: <T extends object>(id: string) => this.exposed.get(id) as T | undefined,
    };

    return {
      id: plugin.id,
      version: plugin.version,
      config: Object.freeze({ ...config }),
      dataDir,
      log: plugin.log,
      server,
      commands,
      listing,
      storage,
      timers,
      plugins: pluginsApi,
      fetch(input, init) {
        need('network');
        return globalThis.fetch(input, init);
      },
      on: (event, handler) => {
        if (!EVENT_NAMES.has(event)) throw new TypeError(`Unknown event "${String(event)}"`);
        if (typeof handler !== 'function') throw new TypeError('on() needs a handler function');
        let set = plugin.handlers.get(event);
        if (!set) plugin.handlers.set(event, (set = new Set()));
        const h = handler as Handler;
        set.add(h);
        return track(() => plugin.handlers.get(event)?.delete(h));
      },
    };
  }

  // ---------------------------------------------------------------- events & commands

  emit<E extends EventName>(event: E, payload: PluginEvents[E]): void {
    for (const plugin of [...this.plugins]) {
      const handlers = plugin.handlers.get(event);
      if (!handlers) continue;
      for (const h of [...handlers]) this.invoke(plugin, `${event} handler`, () => h(payload));
    }
    if (event === 'chat.message') {
      const { player, message } = payload as PluginEvents['chat.message'];
      this.dispatch(message, player).catch((err) => this.log.error(`command dispatch: ${errorText(err)}`));
    }
  }

  async runConsoleCommand(line: string): Promise<boolean> {
    const text = line.trim();
    return this.dispatch(/^[!/]/.test(text) ? text : `!${text}`, undefined);
  }

  /** Runs a chat command. `player` undefined means the host console. Resolves whether it was handled. */
  private async dispatch(text: string, player: Player | undefined): Promise<boolean> {
    const parsed = parseCommand(text);
    if (!parsed) return false;
    const isAdmin = this.services.isAdmin(player);
    const reply = async (message: string) => {
      try {
        if (player) await this.services.tell(player, message);
        else this.services.logger('console').info(message);
      } catch (err) {
        this.log.warn(`could not reply to ${player?.name ?? 'console'}: ${errorText(err)}`);
      }
    };

    if (parsed.name === 'help') {
      await this.help(parsed.args[0], isAdmin, !player, reply);
      return true;
    }
    const cmd = this.commands.get(parsed.name);
    if (!cmd) return false;
    if (cmd.options.access === 'admin' && !isAdmin) {
      await reply(`!${parsed.name} is for admins only.`);
      return true;
    }
    const plugin = this.plugins.find((p) => p.id === cmd.pluginId);
    const invocation: CommandInvocation = { player, args: parsed.args, raw: parsed.raw, isAdmin, reply };
    try {
      if (plugin) await this.track(plugin, `!${parsed.name}`, () => cmd.options.handler(invocation));
      else await cmd.options.handler(invocation);
    } catch (err) {
      (plugin?.log ?? this.log).error(`!${parsed.name} failed: ${errorText(err)}`);
      await reply(`Something went wrong running !${parsed.name}.`);
    }
    return true;
  }

  private async help(topic: string | undefined, isAdmin: boolean, console: boolean, reply: (m: string) => Promise<void>): Promise<void> {
    const visible = this.commands.list().filter((c) => c.options.access !== 'admin' || isAdmin);
    if (topic) {
      const cmd = this.commands.get(topic.replace(/^[!/]/, ''));
      if (!cmd || !visible.includes(cmd)) return reply(`No command !${topic}.`);
      const aliases = cmd.options.aliases?.length ? ` (also ${cmd.options.aliases.map((a) => `!${a}`).join(', ')})` : '';
      return reply(`!${cmd.name}${aliases}: ${cmd.options.description ?? 'no description'}`);
    }
    if (!visible.length) return reply('No commands are available.');
    if (console) {
      for (const c of visible) await reply(`!${c.name}${c.options.access === 'admin' ? ' [admin]' : ''} — ${c.options.description ?? ''}`.trimEnd());
      return;
    }
    const names = visible.map((c) => `!${c.name}`);
    const lines = chunkLines(names, CHAT_LINE);
    lines[0] = `Commands: ${lines[0]}`;
    for (const line of lines) await reply(line);
  }

  // ---------------------------------------------------------------- listing

  listingContributions(): ListingContributions {
    const tags: string[] = [];
    const metadata: Record<string, string> = {};
    let mode: { value: string; seq: number } | undefined;
    let dropped = 0;
    for (const p of this.plugins) {
      for (const t of p.listing.tags) if (!tags.includes(t) && tags.length < MAX_TAGS) tags.push(t);
      if (p.listing.gameMode && (!mode || p.listing.gameMode.seq > mode.seq)) mode = p.listing.gameMode;
      for (const [k, v] of p.listing.metadata) {
        if (k in metadata) continue;
        if (Object.keys(metadata).length >= MAX_METADATA) dropped++;
        else metadata[k] = v;
      }
    }
    if (dropped) this.log.warn(`Listing metadata is capped at ${MAX_METADATA} keys; dropped ${dropped}`);
    return { tags, gameMode: mode?.value, metadata };
  }
}
