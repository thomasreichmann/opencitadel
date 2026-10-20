/**
 * .opencitadel/installed.json — every package the host installed and every file it wrote, so
 * upgrades and `plugin remove` touch exactly those files and nothing else.
 *
 * Where that state lives is a PackageStore: `citadel-host` keeps it under the server directory,
 * `citadel-pkg` under the game's `game/bin/win64/configs/opencitadel/`.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PluginKind, PluginManifest, Provenance } from '@opencitadel/protocol';
import { hostPaths } from '../config.js';

export interface InstalledFile {
  /** `server`: relative to the store root (the server directory). `game`: relative to the Deadlock install root. */
  base: 'server' | 'game';
  /** Forward-slash relative path. */
  path: string;
  /** Path inside the package the file came from. */
  source: string;
  size: number;
  sha256: string;
  mtimeMs?: number;
  /** Set for content VPKs. */
  content?: { kind: 'map' | 'addon'; name: string; client: boolean };
}

export interface InstalledPackage {
  version: string;
  kind: PluginKind;
  /** sha256 of the package archive. */
  sha256: string;
  installedAt: string;
  /** Registry base URL it came from; absent for packages installed from a local file. */
  registry?: string;
  /** Absolute Deadlock install root used for `game` files. */
  gameRoot?: string;
  /** The verified publisher signature; absent when the package was installed unsigned. */
  signature?: { keyId: string; trustedComment: string };
  /** Where the version was built, when it came from trusted publishing (as the registry reported it). */
  provenance?: Provenance;
  manifest: PluginManifest;
  files: InstalledFile[];
}

export type InstalledIndex = Record<string, InstalledPackage>;

/** Where a package manager instance keeps its state. */
export interface PackageStore {
  /** Base directory for `server` files (the server directory for citadel-host). */
  root: string;
  installed: string;
  /** Pinned signing keys (trust.json). */
  trust: string;
  cacheDir: string;
  /** Unpacked host plugins. */
  pluginsDir: string;
  /** Default plugins.lock.json location. */
  lockfile: string;
}

/** A server directory (citadel-host layout) or an explicit store. */
export type StoreLocation = string | PackageStore;

export function packageStore(location: StoreLocation): PackageStore {
  if (typeof location !== 'string') return location;
  const p = hostPaths(location);
  return {
    root: location,
    installed: p.installed,
    trust: join(p.stateDir, 'trust.json'),
    cacheDir: p.cacheDir,
    pluginsDir: p.pluginsDir,
    lockfile: join(location, 'plugins.lock.json'),
  };
}

/** citadel-pkg's store: everything under one state directory inside the game install. */
export function flatStore(stateDir: string): PackageStore {
  return {
    root: stateDir,
    installed: join(stateDir, 'installed.json'),
    trust: join(stateDir, 'trust.json'),
    cacheDir: join(stateDir, 'cache'),
    pluginsDir: join(stateDir, 'plugins'),
    lockfile: join(stateDir, 'plugins.lock.json'),
  };
}

export async function readJsonObject<T>(file: string, fallback: T): Promise<T> {
  if (!existsSync(file)) return fallback;
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`${file} must contain an object`);
  return raw as T;
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n');
  await rename(tmp, file);
}

export async function readInstalled(location: StoreLocation): Promise<InstalledIndex> {
  return readJsonObject<InstalledIndex>(packageStore(location).installed, {});
}

export async function writeInstalled(location: StoreLocation, index: InstalledIndex): Promise<void> {
  await writeJsonAtomic(packageStore(location).installed, index);
}

/** Absolute path of an installed file. Throws for game files when no install root is known. */
export function installedFilePath(file: InstalledFile, root: string, gameRoot: string | undefined): string {
  if (file.base === 'server') return join(root, ...file.path.split('/'));
  if (!gameRoot) throw new Error(`Need the Deadlock install path to locate ${file.path}`);
  return join(gameRoot, ...file.path.split('/'));
}

/** The package that owns a file, if any. */
export function fileOwner(index: InstalledIndex, base: InstalledFile['base'], path: string): string | undefined {
  for (const [id, pkg] of Object.entries(index)) {
    if (pkg.files.some((f) => f.base === base && f.path === path)) return id;
  }
  return undefined;
}

/** Installed packages that declare a dependency on `id`. */
export function dependentsOf(index: InstalledIndex, id: string): string[] {
  return Object.entries(index)
    .filter(([other, pkg]) => other !== id && id in (pkg.manifest.dependencies ?? {}))
    .map(([other]) => other);
}
