/**
 * Test helpers for the plugin system: a recording HostServices, temp server directories, and
 * a writer for throwaway plugins.
 */

import { mkdtempSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger, Player, ServerState } from '@opencitadel/plugin-sdk';
import type { HostServices } from '../services.js';

export interface LogLine {
  component: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
}

export interface FakeServices extends HostServices {
  state: ServerState;
  admins: Set<string>;
  commands: string[];
  says: string[];
  tells: Array<{ player: Player; message: string }>;
  kicks: Array<{ player: Player; reason?: string }>;
  logs: LogLine[];
  /** Log lines at `level` (or worse) whose message contains `text`. */
  logged(text: string, level?: LogLine['level']): LogLine[];
}

export function fakeServices(serverDir: string, overrides: Partial<HostServices> = {}): FakeServices {
  const logs: LogLine[] = [];
  const severity = { debug: 0, info: 1, warn: 2, error: 3 };
  const svc: FakeServices = {
    serverDir,
    state: { phase: 'running', map: 'dl_midtown', hostname: 'Test', players: [], maxPlayers: 12, sources: { rcon: true, log: true, bridge: false } },
    admins: new Set(),
    commands: [],
    says: [],
    tells: [],
    kicks: [],
    logs,
    logged: (text, level = 'debug') => logs.filter((l) => severity[l.level] >= severity[level] && l.message.includes(text)),
    getState() {
      return svc.state;
    },
    async command(command) {
      svc.commands.push(command);
      return `ran ${command}`;
    },
    async say(message) {
      svc.says.push(message);
    },
    async tell(player, message) {
      svc.tells.push({ player, message });
    },
    async kick(player, reason) {
      svc.kicks.push({ player, reason });
    },
    async changeMap(map) {
      svc.commands.push(`changelevel ${map}`);
    },
    isAdmin(player) {
      return !player || (!!player.steamId && svc.admins.has(player.steamId));
    },
    logger(component): Logger {
      const at = (level: LogLine['level']) => (message: string) => void logs.push({ component, level, message });
      return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
    },
    ...overrides,
  };
  return svc;
}

/** A temp server directory; call `cleanup()` when done. */
export function tempServerDir(prefix = 'oc-host-'): { dir: string; cleanup(): Promise<void> } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Writes a plugin straight into `.opencitadel/plugins/<id>/` (as a local copy, not installed). */
export async function writeLocalPlugin(
  serverDir: string,
  id: string,
  code: string,
  manifest: Record<string, unknown> = {},
  main = 'index.mjs',
): Promise<string> {
  const dir = join(serverDir, '.opencitadel', 'plugins', id);
  await mkdir(join(dir, main, '..'), { recursive: true });
  await writeFile(join(dir, 'plugin.json'), JSON.stringify({ id, name: id, version: '1.0.0', kind: 'host', main, ...manifest }, null, 2));
  await writeFile(join(dir, main), code);
  return dir;
}
