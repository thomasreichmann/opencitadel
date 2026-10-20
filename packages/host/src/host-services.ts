/**
 * HostServices for the plugin runtime: routes commands through the bridge when it is up and
 * RCON otherwise, and makes chat text safe to embed in a console command.
 */

import { fromSteam64, parseSteam3, toSteam64 } from '@opencitadel/protocol';
import type { Logger, Player, ServerState } from '@opencitadel/plugin-sdk';
import type { HostConfig } from './config.js';
import type { HostServices } from './services.js';
import type { BridgeServer } from './bridge.js';
import type { RconClient } from './rcon.js';
import { createLogger } from './logger.js';
import { playerSteamId } from './parsers.js';

/** Strips what would let chat text end the `say` command and start another (quotes, `;`, newlines). */
export function sanitizeChat(text: string): string {
  return text.replace(/[";\r\n\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 240);
}

/**
 * Text for an unquoted `say`. Deadlock prints quotes verbatim, so `say "hi"` shows `"hi"` in chat,
 * and an unquoted `//` starts a console comment, cutting URLs short (observed on build 6796).
 * A zero-width space between the slashes keeps the whole message and renders invisibly.
 */
export function chatCommandText(text: string): string {
  return sanitizeChat(text).replace(/\/\//g, '/​/');
}

/** Normalises any SteamID spelling to SteamID64 for comparisons. */
export function toSteamId64(id: string): string | undefined {
  const trimmed = id.trim();
  if (/^\d{17}$/.test(trimmed)) return fromSteam64(trimmed) ? trimmed : undefined;
  const s3 = playerSteamId(trimmed);
  if (s3) return toSteam64(parseSteam3(s3)!);
  return undefined;
}

export interface HostServicesDeps {
  serverDir: string;
  config: () => HostConfig;
  state: () => ServerState;
  bridge: () => BridgeServer | undefined;
  rcon: () => RconClient | undefined;
  /** The supervisor's map change; without one, a plain `changelevel`. */
  changeMap?: (map: string) => Promise<void>;
}

export class HostServicesImpl implements HostServices {
  readonly serverDir: string;

  constructor(private readonly deps: HostServicesDeps) {
    this.serverDir = deps.serverDir;
  }

  getState(): ServerState {
    return this.deps.state();
  }

  private bridgeUp(): BridgeServer | undefined {
    const b = this.deps.bridge();
    return b?.connected ? b : undefined;
  }

  async command(command: string): Promise<string> {
    const phase = this.deps.state().phase;
    if (phase !== 'running' && phase !== 'starting') throw new Error('The server is not running');
    const bridge = this.bridgeUp();
    if (bridge) {
      const result = await bridge.request('command', { command });
      return typeof result === 'string' ? result : result === undefined || result === null ? '' : JSON.stringify(result);
    }
    const rcon = this.deps.rcon();
    if (rcon?.connected) return rcon.command(command);
    throw new Error('No command channel: RCON is not connected and the in-game bridge is not running');
  }

  async say(message: string): Promise<void> {
    const text = chatCommandText(message);
    if (!text) return;
    const bridge = this.bridgeUp();
    if (bridge) {
      await bridge.request('say', { message: message.slice(0, 240) });
      return;
    }
    await this.command(`say ${text}`);
  }

  async tell(player: Player, message: string): Promise<void> {
    const bridge = this.bridgeUp();
    if (bridge && player.slot !== undefined) {
      await bridge.request('tell', { slot: player.slot, message: message.slice(0, 240) });
      return;
    }
    await this.say(`${player.name}: ${message}`);
  }

  async kick(player: Player, reason?: string): Promise<void> {
    const bridge = this.bridgeUp();
    if (bridge && player.slot !== undefined) {
      await bridge.request('kick', { slot: player.slot, reason: reason ?? '' });
      return;
    }
    const why = reason ? ` "${sanitizeChat(reason)}"` : '';
    if (player.slot !== undefined) await this.command(`kickid ${player.slot}${why}`);
    else await this.command(`kick "${sanitizeChat(player.name)}"`);
  }

  async changeMap(map: string): Promise<void> {
    if (this.deps.changeMap) return this.deps.changeMap(map);
    await this.command(`changelevel ${map}`);
  }

  isAdmin(player: Player | undefined): boolean {
    if (!player) return true;
    const id = player.steamId64 ?? (player.steamId ? toSteamId64(player.steamId) : undefined);
    if (!id) return false;
    return this.deps.config().admins.some((a) => toSteamId64(a) === id);
  }

  logger(component: string): Logger {
    return createLogger(component);
  }
}
