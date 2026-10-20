/**
 * ~/.opencitadel/client.json — the browser's settings, favourites and join history.
 * `OPENCITADEL_HOME` moves the whole directory (used by tests and portable setups).
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MASTER_PORT, parse, v, type Infer } from '@opencitadel/protocol';

export const DEFAULT_MASTER_URL = `http://localhost:${DEFAULT_MASTER_PORT}`;
const MAX_HISTORY = 50;
const SERVER_ID = /^[A-Za-z0-9_-]{1,64}$/;

const historyEntry = v.object({
  id: v.optional(v.string({ max: 64 })),
  name: v.string({ max: 128 }),
  /** What was connected to: `[A:1:…]` or `host:port`. */
  target: v.string({ max: 260 }),
  at: v.string({ max: 40 }),
});
export type HistoryEntry = Infer<typeof historyEntry>;

const clientConfigValidator = v.object({
  masterUrl: v.optional(v.string({ max: 500, pattern: /^https?:\/\/\S+$/ })),
  gamePath: v.optional(v.string({ max: 1000 })),
  favorites: v.withDefault(v.array(v.string({ pattern: SERVER_ID }), { max: 500 }), []),
  history: v.withDefault(v.array(historyEntry, { max: 500 }), []),
});
export type ClientConfig = Infer<typeof clientConfigValidator>;

export function clientHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENCITADEL_HOME || join(homedir(), '.opencitadel');
}

export function clientPaths(home: string) {
  return { home, config: join(home, 'client.json'), cacheDir: join(home, 'cache') };
}

export function isServerId(id: string): boolean {
  return SERVER_ID.test(id);
}

export async function loadClientConfig(home: string): Promise<ClientConfig> {
  const file = clientPaths(home).config;
  if (!existsSync(file)) return parse(clientConfigValidator, {});
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  return parse(clientConfigValidator, raw);
}

/** Writes atomically so a crash never leaves a half-written config. */
export async function saveClientConfig(home: string, config: ClientConfig): Promise<void> {
  const file = clientPaths(home).config;
  await mkdir(home, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8');
  await rename(tmp, file);
}

/** `--master` flag, then `OPENCITADEL_MASTER`, then client.json, then the localhost default. */
export function resolveMasterUrl(config: ClientConfig, flag?: string, env: NodeJS.ProcessEnv = process.env): string {
  const url = flag || env.OPENCITADEL_MASTER || config.masterUrl || DEFAULT_MASTER_URL;
  if (!/^https?:\/\/\S+$/.test(url)) throw new Error(`Invalid master URL: ${url}`);
  return url.replace(/\/+$/, '');
}

/** Read-modify-write helper so callers never clobber concurrent changes to other fields. */
export async function updateClientConfig(home: string, fn: (config: ClientConfig) => void): Promise<ClientConfig> {
  const config = await loadClientConfig(home);
  fn(config);
  await saveClientConfig(home, config);
  return config;
}

export function addFavorite(config: ClientConfig, id: string): void {
  if (!isServerId(id)) throw new Error(`Invalid server id: ${id}`);
  if (!config.favorites.includes(id)) config.favorites.push(id);
}

export function removeFavorite(config: ClientConfig, id: string): void {
  config.favorites = config.favorites.filter((f) => f !== id);
}

/** Most recent first; joining the same target again moves it to the front. */
export function recordHistory(config: ClientConfig, entry: Omit<HistoryEntry, 'at'>, now = new Date()): void {
  config.history = [{ ...entry, at: now.toISOString() }, ...config.history.filter((h) => h.target !== entry.target)].slice(0, MAX_HISTORY);
}
