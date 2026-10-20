/**
 * The live ServerState, plus `.opencitadel/state.json` so `citadel-host status` (a separate
 * process) can report on a running supervisor.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ServerState } from '@opencitadel/plugin-sdk';

export interface StateFile extends ServerState {
  /** PID of the supervisor (citadel-host), not the game. */
  pid: number;
  gamePid?: number;
  updatedAt: string;
  version: string;
}

export function initialState(hostname: string, maxPlayers: number, address?: string): ServerState {
  return {
    phase: 'stopped',
    hostname,
    players: [],
    maxPlayers,
    ...(address ? { address } : {}),
    sources: { rcon: false, log: false, bridge: false },
  };
}

/** Writes the state file at most every `intervalMs`, coalescing bursts of updates. */
export class StateWriter {
  private timer?: NodeJS.Timeout;
  private dirty = false;
  private lastWrite = 0;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly snapshot: () => StateFile,
    private readonly intervalMs = 2000,
  ) {}

  markDirty(): void {
    this.dirty = true;
    // Leading edge: the first change after a quiet period is written right away.
    if (!this.timer) this.timer = setTimeout(() => void this.flush(), Math.max(0, this.lastWrite + this.intervalMs - Date.now()));
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.dirty) return this.writing;
    this.dirty = false;
    this.lastWrite = Date.now();
    const data = JSON.stringify(this.snapshot(), null, 2) + '\n';
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, data);
      await rename(tmp, this.file);
    }).catch(() => {});
    return this.writing;
  }

  async close(): Promise<void> {
    this.dirty = true;
    await this.flush();
  }
}

export async function readStateFile(file: string): Promise<StateFile | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as StateFile;
  } catch {
    return undefined;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
