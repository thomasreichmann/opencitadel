/**
 * plugins.lock.json: the exact package set a server runs (version, archive sha256, registry and
 * signing key), so several servers can share one reviewed set. `plugin sync` reproduces it and
 * refuses anything that does not match byte for byte.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { parsePublicKey, satisfies, type PluginKind, type PublicKeyInfo } from '@opencitadel/protocol';
import { commitPackage, fetchFromRegistry, removePackage, type FetchedPackage, type InstallOptions, type InstallOutcome } from './install.js';
import { packageStore, readInstalled, writeJsonAtomic, type StoreLocation } from './installed.js';
import { RegistryClient } from './registry.js';
import { readTrust } from './trust.js';

export const LOCKFILE_VERSION = 1;

export interface LockEntry {
  version: string;
  kind: PluginKind;
  sha256: string;
  /** Registry the package came from; absent for packages installed from a local file. */
  registry?: string;
  /** Signing key id and its public key, when the package was signed. */
  keyId?: string;
  publicKey?: string;
}

export interface Lockfile {
  lockfileVersion: typeof LOCKFILE_VERSION;
  generatedAt: string;
  packages: Record<string, LockEntry>;
}

/** Builds a lockfile from what is installed now. */
export async function buildLockfile(location: StoreLocation): Promise<Lockfile> {
  const index = await readInstalled(location);
  const trust = await readTrust(location);
  const packages: Record<string, LockEntry> = {};
  for (const [id, pkg] of Object.entries(index).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const keyId = pkg.signature?.keyId;
    const publicKey = keyId ? trust[id]?.keys.find((k) => k.keyId === keyId)?.publicKey : undefined;
    packages[id] = {
      version: pkg.version,
      kind: pkg.kind,
      sha256: pkg.sha256,
      ...(pkg.registry ? { registry: pkg.registry } : {}),
      ...(keyId ? { keyId } : {}),
      ...(publicKey ? { publicKey } : {}),
    };
  }
  return { lockfileVersion: LOCKFILE_VERSION, generatedAt: new Date().toISOString(), packages };
}

export async function writeLockfile(location: StoreLocation, file = packageStore(location).lockfile): Promise<{ file: string; lock: Lockfile }> {
  const lock = await buildLockfile(location);
  await writeJsonAtomic(file, lock);
  return { file, lock };
}

export async function readLockfile(file: string): Promise<Lockfile> {
  if (!existsSync(file)) throw new Error(`No lockfile at ${file}. Create one with \`plugin lock\`.`);
  let raw: Partial<Lockfile>;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  if (raw.lockfileVersion !== LOCKFILE_VERSION || typeof raw.packages !== 'object' || raw.packages === null) {
    throw new Error(`${file} is not a version ${LOCKFILE_VERSION} OpenCitadel lockfile`);
  }
  for (const [id, e] of Object.entries(raw.packages)) {
    if (typeof e?.version !== 'string' || !/^[0-9a-f]{64}$/.test(e.sha256 ?? '')) throw new Error(`${file}: entry ${id} needs a version and a sha256`);
  }
  return raw as Lockfile;
}

export interface SyncResult {
  installed: InstallOutcome[];
  unchanged: string[];
  removed: string[];
}

/**
 * Makes the installed set exactly the lockfile's. Everything is downloaded and verified before
 * anything on disk changes; a checksum, signing-key or dependency mismatch aborts the sync.
 */
export async function syncLockfile(lock: Lockfile, opts: InstallOptions, defaultRegistry: string, fetchImpl?: typeof fetch): Promise<SyncResult> {
  const index = await readInstalled(opts.serverDir);
  const unchanged: string[] = [];
  const fetched = new Map<string, FetchedPackage>();
  const clients = new Map<string, RegistryClient>();
  for (const [id, entry] of Object.entries(lock.packages)) {
    const current = index[id];
    if (current && current.version === entry.version && current.sha256 === entry.sha256) {
      unchanged.push(id);
      continue;
    }
    // Entries without a registry were installed from a local file; they sync only if the default registry has them.
    const url = entry.registry ?? defaultRegistry;
    let client = clients.get(url);
    if (!client) clients.set(url, (client = new RegistryClient(url, fetchImpl)));
    const keyFiles: PublicKeyInfo[] = [...(opts.keyFiles ?? []), ...(entry.publicKey ? [parsePublicKey(entry.publicKey)] : [])];
    const pkg = await fetchFromRegistry(id, entry.version, { ...opts, registry: client, keyFiles }, entry.sha256);
    if (entry.keyId && pkg.decision.keyId !== entry.keyId) {
      throw new Error(`The lockfile expects ${id}@${entry.version} signed by ${entry.keyId}, but it is ${pkg.decision.signed ? `signed by ${pkg.decision.keyId}` : 'unsigned'}`);
    }
    fetched.set(id, pkg);
  }

  // Every dependency must be satisfied inside the locked set.
  const versions = new Map(Object.entries(lock.packages).map(([id, e]) => [id, e.version]));
  const manifestOf = (id: string) => fetched.get(id)?.manifest ?? index[id]?.manifest;
  for (const id of versions.keys()) {
    for (const [dep, range] of Object.entries(manifestOf(id)?.dependencies ?? {})) {
      const v = versions.get(dep);
      if (!v || !satisfies(v, range)) throw new Error(`The lockfile is incomplete: ${id} needs ${dep}@${range}${v ? `, but it locks ${v}` : ''}`);
    }
  }

  // Place dependencies before dependents.
  const order: string[] = [];
  const visit = (id: string, seen: Set<string>) => {
    if (order.includes(id) || !fetched.has(id)) return;
    if (seen.has(id)) throw new Error(`Dependency cycle through ${id}`);
    seen.add(id);
    for (const dep of Object.keys(fetched.get(id)!.manifest.dependencies)) visit(dep, seen);
    order.push(id);
  };
  for (const id of fetched.keys()) visit(id, new Set());

  const installed: InstallOutcome[] = [];
  for (const id of order) installed.push(await commitPackage(fetched.get(id)!, opts));

  const removed: string[] = [];
  const extras = Object.keys(await readInstalled(opts.serverDir)).filter((id) => !(id in lock.packages));
  for (const id of extras) {
    await removePackage(id, { serverDir: opts.serverDir, gameRoot: opts.gameRoot, force: true });
    removed.push(id);
  }
  return { installed, unchanged, removed };
}
