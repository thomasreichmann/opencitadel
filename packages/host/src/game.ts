/**
 * Locating the Deadlock install for a server and keeping its gameinfo.gi fit for hosting.
 */

import { readdir, readFile } from 'node:fs/promises';
import {
  findDeadlockInstall,
  gameLayout,
  inspectGameinfo,
  isDeadlockInstall,
  patchGameinfoFile,
  unpatchGameinfoFile,
  type GameinfoChange,
  type GameinfoStatus,
  type GameLayout,
} from '@opencitadel/gamefiles';
import type { Logger } from '@opencitadel/plugin-sdk';
import type { HostConfig } from './config.js';

/** The install root from `game.path`, or auto-detected. Throws with a fix-it message if none. */
export function resolveGameRoot(config: HostConfig): string {
  if (config.game.path) {
    if (!isDeadlockInstall(config.game.path)) {
      throw new Error(`game.path "${config.game.path}" is not a Deadlock install (expected game/bin/win64/deadlock.exe and game/citadel/gameinfo.gi)`);
    }
    return config.game.path;
  }
  const found = findDeadlockInstall();
  if (!found) throw new Error('Could not find Deadlock. Set game.path in server.json or the DEADLOCK_PATH environment variable.');
  return found;
}

async function hasServerContent(layout: GameLayout): Promise<boolean> {
  try {
    return (await readdir(layout.serverContentDir)).some((f) => f.toLowerCase().endsWith('.vpk'));
  } catch {
    return false;
  }
}

/** Edits the server needs: always the P2P listen socket, plus the content search path once content packages are installed. */
export async function requiredGameinfoChanges(layout: GameLayout): Promise<GameinfoChange[]> {
  return (await hasServerContent(layout)) ? ['dedicated', 'server-content'] : ['dedicated'];
}

/** Applies any missing edits. Valve's updates overwrite gameinfo.gi, so this runs before every start. */
export async function ensureGameinfo(layout: GameLayout, log: Logger): Promise<boolean> {
  const changed = await patchGameinfoFile(layout.gameinfo, await requiredGameinfoChanges(layout));
  if (changed) log.info(`Patched ${layout.gameinfo} for dedicated hosting (backup: gameinfo.gi.opencitadel.bak).`);
  return changed;
}

export async function gameinfoStatus(layout: GameLayout): Promise<GameinfoStatus> {
  return inspectGameinfo(await readFile(layout.gameinfo, 'utf8'));
}

export async function patchGameinfo(layout: GameLayout): Promise<boolean> {
  return patchGameinfoFile(layout.gameinfo, await requiredGameinfoChanges(layout));
}

export async function unpatchGameinfo(layout: GameLayout): Promise<boolean> {
  return unpatchGameinfoFile(layout.gameinfo);
}

export { gameLayout };
