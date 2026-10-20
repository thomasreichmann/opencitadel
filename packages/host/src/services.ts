/**
 * The seam between the host core (supervisor, RCON, bridge, heartbeat) and the plugin system.
 * The core implements HostServices; the plugin runtime consumes it and never reaches into the
 * core directly.
 */

import type { ContentItem, ListingPlugin } from '@opencitadel/protocol';
import type { EventName, Logger, Player, PluginEvents, ServerState } from '@opencitadel/plugin-sdk';
import type { HostConfig } from './config.js';

export interface HostServices {
  /** The server directory (where server.json lives). */
  readonly serverDir: string;
  getState(): ServerState;
  /**
   * Runs a console command: through the bridge when connected, else RCON.
   * Rejects when neither is available or the server is not running.
   */
  command(command: string): Promise<string>;
  say(message: string): Promise<void>;
  /** Private message via the bridge; falls back to `say` with the player's name prefixed. */
  tell(player: Player, message: string): Promise<void>;
  kick(player: Player, reason?: string): Promise<void>;
  /** True when the player's SteamID is in `config.admins`. Undefined (host console) is admin. */
  isAdmin(player: Player | undefined): boolean;
  logger(component: string): Logger;
}

/** What plugins contribute to the heartbeat, merged across all loaded plugins. */
export interface ListingContributions {
  tags: string[];
  gameMode?: string;
  metadata: Record<string, string>;
}

/**
 * Implemented by the plugin runtime (`./plugins/runtime.ts`), driven by the supervisor:
 * `loadAll()` after the config is read, `emit()` for every bus event, `unloadAll()` on shutdown.
 */
export interface PluginHost {
  loadAll(): Promise<void>;
  unloadAll(): Promise<void>;
  /** Reloads one plugin, or all when `id` is omitted, re-reading config. */
  reload(id?: string): Promise<void>;
  /** Fans an event out to plugin handlers. `chat.message` also dispatches `!command`s. */
  emit<E extends EventName>(event: E, payload: PluginEvents[E]): void;
  /** Runs a `!command args` typed at the host console. Resolves false if no plugin claims it. */
  runConsoleCommand(line: string): Promise<boolean>;
  listingContributions(): ListingContributions;
  /** Loaded host plugins. */
  loaded(): Array<{ id: string; version: string }>;
}

/** Signature of the factory the plugin system exports from `./plugins/index.ts`. */
export type CreatePluginHost = (services: HostServices, config: HostConfig) => PluginHost;

/** Heartbeat inputs derived from installed packages (exported from `./plugins/index.ts`). */
export type InstalledListing = (serverDir: string, config: HostConfig) => Promise<{ plugins: ListingPlugin[]; content: ContentItem[] }>;

/** Passed to `runPluginCli` (exported from `./plugins/index.ts`) for `citadel-host plugin …`. */
export interface PluginCliContext {
  serverDir: string;
  config: HostConfig;
  saveConfig(config: HostConfig): Promise<void>;
  /** Deadlock install root, when one was found (needed for deadworks and content packages). */
  gameRoot?: string;
  /** Writes user-facing output (defaults to stdout). */
  print(line: string): void;
}

/** `runPluginCli(argv, ctx)` resolves with a process exit code. `argv` excludes `plugin`. */
export type RunPluginCli = (argv: string[], ctx: PluginCliContext) => Promise<number>;
