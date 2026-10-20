/**
 * @opencitadel/plugin-sdk — the API surface for OpenCitadel host plugins.
 *
 * A host plugin is an ES module whose default export is `definePlugin({...})`. `citadel-host`
 * loads it next to the Deadlock server process and hands `setup()` a {@link PluginContext}:
 *
 * ```ts
 * import { definePlugin } from '@opencitadel/plugin-sdk';
 *
 * export default definePlugin({
 *   setup(ctx) {
 *     ctx.on('player.connected', ({ player }) => ctx.server.say(`Welcome, ${player.name}!`));
 *     ctx.commands.register('discord', { description: 'Show our Discord', handler: (c) => c.reply('discord.gg/...') });
 *   },
 * });
 * ```
 *
 * Context methods that touch the server, the network or the listing require the matching
 * permission in plugin.json (`server.command`, `server.chat`, `players.manage`, `network`,
 * `listing.write`, `storage`); calling one without it throws {@link PermissionError}.
 *
 * Plugins run in a WebAssembly sandbox (QuickJS). There is no `require`, `process`, `Buffer`,
 * filesystem, global `fetch` or Node module: only standard JavaScript, `console`, the timer
 * globals and this context. A plugin may import its own files and this SDK; bundle anything
 * else. Each plugin has a memory cap and a CPU limit per call into it.
 */

export type Permission = 'server.command' | 'server.chat' | 'players.manage' | 'listing.write' | 'network' | 'storage';

export class PermissionError extends Error {
  constructor(readonly plugin: string, readonly permission: Permission) {
    super(`Plugin "${plugin}" needs the "${permission}" permission in plugin.json to do this`);
    this.name = 'PermissionError';
  }
}

/** A player as best the host knows them. Fields depend on which event sources are available. */
export interface Player {
  /** Engine player slot / userid, when known. */
  slot?: number;
  name: string;
  /** `[U:1:<account>]`, when known (RCON status or the in-game bridge). */
  steamId?: string;
  /** Decimal SteamID64, when known. */
  steamId64?: string;
  team?: number;
  hero?: string;
  ping?: number;
  /** Seconds since the player connected. */
  connectedFor?: number;
  bot?: boolean;
}

export type ServerPhase = 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed';

export interface ServerState {
  phase: ServerPhase;
  map?: string;
  /** `[A:1:...]` (anonymous) or `[G:1:...]` (GSLT) id players connect to; changes every launch for anonymous servers. */
  steamId?: string;
  /** Public `host:port`, when the admin publishes one. */
  address?: string;
  hostname: string;
  players: Player[];
  maxPlayers: number;
  /** Which event sources are live right now. Plugins can degrade gracefully without the bridge. */
  sources: { rcon: boolean; log: boolean; bridge: boolean };
  /** Unix ms when the current server process started. */
  startedAt?: number;
}

/** Everything a plugin can subscribe to. Payloads are plain data. */
export interface PluginEvents {
  /** The game process is being launched. */
  'server.starting': { attempt: number };
  /** The server finished loading a map and accepts players. */
  'server.ready': { map: string; steamId?: string };
  /** The game process exited. `crashed` is false for an orderly stop. */
  'server.stopped': { code: number | null; crashed: boolean };
  'map.changed': { map: string; previous?: string };
  /**
   * A team won and the post-game screen is up. Unless `restart.afterMatch` is off, the host then
   * starts a fresh server; a `changeMap()` from this handler picks the map it starts on.
   */
  'match.ended': { map: string };
  'player.connected': { player: Player };
  'player.disconnected': { player: Player; reason?: string };
  /** Requires the in-game bridge or a server that logs chat. */
  'chat.message': { player: Player; message: string; teamOnly: boolean };
  /** Every line the server prints, after the host's own parsers have seen it. */
  'console.line': { line: string };
  /** Pass-through of named game events forwarded by the in-game bridge (e.g. `player_death`). */
  'game.event': { name: string; data: Record<string, unknown> };
  /** Fired roughly once a second while the server runs; cheap periodic work goes here. */
  'tick': { now: number };
}

export type EventName = keyof PluginEvents;

export interface Disposable {
  dispose(): void;
}

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface ServerApi {
  /** Snapshot of the current server state. */
  readonly state: Readonly<ServerState>;
  /** Runs a console command and resolves with its output. Needs `server.command`. */
  command(command: string): Promise<string>;
  /** Broadcasts a chat message to everyone. Needs `server.chat`. */
  say(message: string): Promise<void>;
  /** Sends a chat message to one player (needs the bridge; falls back to `say`). Needs `server.chat`. */
  tell(player: Player, message: string): Promise<void>;
  /** Kicks a player. Needs `players.manage`. */
  kick(player: Player, reason?: string): Promise<void>;
  /**
   * Moves the server to `map`. Needs `server.command`. By default this restarts the server on
   * that map (players are disconnected, and an anonymous server gets a new SteamID); see
   * `game.mapChange`. After `match.ended` it only picks the map for the coming restart.
   */
  changeMap(map: string): Promise<void>;
  /** Looks a player up by slot, SteamID, or case-insensitive name prefix. */
  findPlayer(query: string): Player | undefined;
}

export interface CommandInvocation {
  /** Who typed it. Undefined when run from the host console. */
  player?: Player;
  /** Arguments after the command name, split on whitespace (quotes respected). */
  args: string[];
  /** The text after the command name, unsplit. */
  raw: string;
  /** True if the caller is listed as an admin in the host config. */
  isAdmin: boolean;
  /** Replies privately when possible, otherwise to chat. */
  reply(message: string): Promise<void>;
}

export interface CommandOptions {
  description?: string;
  /** `admin` commands are refused for non-admins before the handler runs. Default `everyone`. */
  access?: 'everyone' | 'admin';
  aliases?: string[];
  handler(invocation: CommandInvocation): void | Promise<void>;
}

/**
 * Chat commands. Players type `!name args` (or `/name args`) in chat; admins can also run
 * them from the host console. Needs chat events, i.e. the bridge or a chat-logging server.
 */
export interface CommandsApi {
  register(name: string, options: CommandOptions): Disposable;
}

/**
 * What this server advertises in the browser. Contributions from all plugins are merged;
 * tags are unioned, the last plugin to set the game mode wins. Needs `listing.write`.
 */
export interface ListingApi {
  setTags(tags: string[]): void;
  setGameMode(mode: string | undefined): void;
  /** Free-form key/value pairs shown on the server's detail page (max 32 keys host-wide). */
  setMetadata(key: string, value: string | undefined): void;
}

/** Small persistent JSON key/value store, one per plugin. Needs `storage`. */
export interface StorageApi {
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  keys(): string[];
}

/** Timers that are cancelled automatically when the plugin unloads. */
export interface TimersApi {
  setTimeout(fn: () => void, ms: number): Disposable;
  setInterval(fn: () => void, ms: number): Disposable;
}

/**
 * Another plugin's API as seen across the sandbox boundary: every method returns a promise, and
 * arguments and results travel as JSON (no functions, class instances or cycles).
 */
export type Remote<T> = {
  [K in keyof T as T[K] extends (...args: never[]) => unknown ? K : never]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
};

/** Cross-plugin APIs: a plugin exposes an object, dependents look it up by plugin id. */
export interface PluginsApi {
  /** Offers this plugin's methods to other plugins. Only functions are exposed. */
  expose<T extends object>(api: T): void;
  /** Another plugin's exposed API. Always `await` its methods: they are asynchronous in the sandbox. */
  get<T extends object>(pluginId: string): Remote<T> | undefined;
}

export interface PluginContext<Config = Record<string, unknown>> {
  /** This plugin's id from plugin.json. */
  readonly id: string;
  readonly version: string;
  /** Admin-supplied config merged over the defaults declared in plugin.json. */
  readonly config: Readonly<Config>;
  /** Directory the plugin may write to. */
  readonly dataDir: string;
  readonly log: Logger;
  readonly server: ServerApi;
  readonly commands: CommandsApi;
  readonly listing: ListingApi;
  readonly storage: StorageApi;
  readonly timers: TimersApi;
  readonly plugins: PluginsApi;
  /** `fetch`, gated by the `network` permission. */
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
  /** Subscribes to an event. Handlers that throw are logged and do not affect other plugins. */
  on<E extends EventName>(event: E, handler: (payload: PluginEvents[E]) => void | Promise<void>): Disposable;
}

export interface PluginDefinition<Config = Record<string, unknown>> {
  /** Called once when the plugin loads. May return a cleanup function, run on unload. */
  setup(ctx: PluginContext<Config>): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}

/** Brands a plugin definition so the host can recognise it. */
export const PLUGIN_BRAND: unique symbol = Symbol.for('opencitadel.plugin');

/** What `definePlugin()` returns. A named type so plugin modules can emit declarations. */
export interface DefinedPlugin<Config = Record<string, unknown>> extends PluginDefinition<Config> {
  readonly [PLUGIN_BRAND]: true;
}

export function definePlugin<Config = Record<string, unknown>>(definition: PluginDefinition<Config>): DefinedPlugin<Config> {
  return Object.assign(definition, { [PLUGIN_BRAND]: true as const });
}
