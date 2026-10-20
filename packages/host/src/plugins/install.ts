/**
 * Installing and removing packages: resolve `id@range` (and dependencies) against the
 * registry, download, check the checksum and the publisher signature, unpack, and put each
 * kind's files where they belong. Every file written is recorded in installed.json; files we
 * did not write are never overwritten.
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, posix } from 'node:path';
import { patchGameinfoFile, gameLayout } from '@opencitadel/gamefiles';
import {
  PERMISSIONS,
  TRUST_LABELS,
  compareVersions,
  maxSatisfying,
  parseManifest,
  safeRelativePath,
  satisfies,
  unpackTarGz,
  type Permission,
  type PluginKind,
  type PluginManifest,
  type PluginVersionInfo,
  type PublicKeyInfo,
  type SigningKeyInfo,
} from '@opencitadel/protocol';
import type { HostConfig } from '../config.js';
import {
  dependentsOf,
  fileOwner,
  installedFilePath,
  packageStore,
  readInstalled,
  writeInstalled,
  type InstalledFile,
  type InstalledIndex,
  type InstalledPackage,
  type StoreLocation,
} from './installed.js';
import type { RegistryClient } from './registry.js';
import { decideTrust, readTrust, writeTrust, type TrustDecision } from './trust.js';

export interface InstallOptions {
  /** A server directory, or an explicit package store (citadel-pkg). */
  serverDir: StoreLocation;
  /** Deadlock install root; required for deadworks and content packages. */
  gameRoot?: string;
  registry?: RegistryClient;
  print?: (line: string) => void;
  /** Reinstall even if a satisfying version is already installed. */
  force?: boolean;
  /** Signature policy (server.json `security`). Defaults to trust-on-first-use with no required signatures. */
  security?: HostConfig['security'];
  acceptNewKey?: boolean;
  allowUnsigned?: boolean;
  /** Public keys given on the command line (`--key-file`). */
  keyFiles?: PublicKeyInfo[];
  /** Package kinds this installer may place (citadel-pkg excludes `host`). */
  allowedKinds?: readonly PluginKind[];
  /**
   * Where content addons go:
   * - `opencitadel` (citadel-host): `citadel/opencitadel_server/pakNN_dir.vpk`, mounted through gameinfo.gi.
   * - `deadworks` (citadel-pkg): `citadel/deadworks_server_addons/vpks/<name>.vpk`. Deadworks mounts those
   *   files itself and advertises the ones named in `serverbrowser.content_addons`, so its launcher can
   *   fetch them from the registry's `/fastdl` route under the same name.
   */
  addonLayout?: 'opencitadel' | 'deadworks';
}

export interface InstallOutcome {
  id: string;
  version: string;
  kind: PluginManifest['kind'];
  permissions: Permission[];
  /** Already installed at a satisfying version; nothing changed. */
  skipped: boolean;
  /** gameinfo.gi was patched to mount server content. */
  mountedContent?: boolean;
  /** Addon names placed for Deadworks (`addonLayout: 'deadworks'`), to list in `serverbrowser.content_addons`. */
  deadworksAddons?: string[];
  /** Signature status, for packages that were actually installed. */
  trust?: Pick<TrustDecision, 'signed' | 'keyId' | 'status'>;
}

export const sha256 = (data: Buffer | Uint8Array) => createHash('sha256').update(data).digest('hex');

/** Addon name: `<id with - as _>_<file stem>`, the same rule the registry's FastDL index uses. */
export function addonName(pluginId: string, stem: string): string {
  return `${pluginId.replace(/-/g, '_')}_${stem.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`.slice(0, 64);
}

export function parseSpec(spec: string): { id: string; range: string } {
  const at = spec.indexOf('@', 1);
  const id = (at === -1 ? spec : spec.slice(0, at)).trim();
  const range = (at === -1 ? '*' : spec.slice(at + 1)).trim() || '*';
  return { id, range };
}

/** Picks the version to install. Yanked versions only match when asked for exactly. */
export function resolveVersion(versions: PluginVersionInfo[], range: string): string | undefined {
  if (versions.some((v) => v.version === range)) return range;
  const live = versions.filter((v) => !v.yanked).map((v) => v.version);
  if (range === 'latest' || range === '*') {
    // Prefer the newest stable release; fall back to a pre-release only if that is all there is.
    const stable = live.filter((v) => !v.includes('-'));
    return (stable.length ? stable : live).sort(compareVersions).pop();
  }
  return maxSatisfying(live, range);
}

/** Human-readable permission lines for printing before a plugin is enabled. */
export function describePermissions(permissions: readonly Permission[]): string[] {
  return permissions.map((p) => `  - ${p}: ${PERMISSIONS[p] ?? 'unknown permission'}`);
}

/** The trust label for a kind (what installing it means). */
export function trustLabel(kind: PluginKind): string {
  return TRUST_LABELS[kind];
}

async function atomicWrite(file: string, data: Buffer): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

export function readManifest(files: Map<string, Buffer>): PluginManifest {
  const raw = files.get('plugin.json');
  if (!raw) throw new Error('package has no plugin.json at its root');
  let json: unknown;
  try {
    json = JSON.parse(raw.toString('utf8'));
  } catch (err) {
    throw new Error(`plugin.json is not valid JSON: ${(err as Error).message}`);
  }
  return parseManifest(json);
}

async function cachedPackage(location: StoreLocation, registry: RegistryClient, id: string, version: string, expected: string): Promise<Buffer> {
  const cacheFile = join(packageStore(location).cacheDir, `${expected}.tgz`);
  if (existsSync(cacheFile)) {
    const cached = await readFile(cacheFile);
    if (sha256(cached) === expected) return cached;
  }
  const { data, checksum } = await registry.download(id, version);
  const actual = sha256(data);
  if (actual !== expected || (checksum && checksum !== actual)) {
    throw new Error(`Checksum mismatch for ${id}@${version}: registry says ${checksum ?? expected}, download is ${actual}. Not installing.`);
  }
  await atomicWrite(cacheFile, data);
  return data;
}

function checkKind(manifest: PluginManifest, opts: InstallOptions): void {
  if (opts.allowedKinds && !opts.allowedKinds.includes(manifest.kind)) {
    throw new Error(
      manifest.kind === 'host'
        ? `${manifest.id} is a host plugin: it runs inside citadel-host, so install it with \`citadel-host plugin install ${manifest.id}\``
        : `${manifest.id} is a ${manifest.kind} package, which this installer does not handle`,
    );
  }
}

/** A package that has been downloaded, unpacked and verified, ready to place. */
export interface FetchedPackage {
  manifest: PluginManifest;
  files: Map<string, Buffer>;
  archiveSha: string;
  registryUrl?: string;
  decision: TrustDecision;
  provenance?: InstalledPackage['provenance'];
}

/**
 * Downloads `id@version` from the registry and verifies checksum, contents and signature.
 * `expectedSha` (from a lockfile) must match the registry's recorded checksum when given.
 */
export async function fetchFromRegistry(id: string, version: string, opts: InstallOptions, expectedSha?: string): Promise<FetchedPackage> {
  const registry = opts.registry;
  if (!registry) throw new Error('No registry configured');
  const info = await registry.plugin(id);
  const entry = info.versions.find((v) => v.version === version);
  if (!entry) throw new Error(`${id}@${version} is not published on ${registry.baseUrl}`);
  if (expectedSha && entry.sha256 !== expectedSha) {
    throw new Error(`${id}@${version} on ${registry.baseUrl} has sha256 ${entry.sha256}, but the lockfile pins ${expectedSha}`);
  }
  const archive = await cachedPackage(opts.serverDir, registry, id, version, entry.sha256);
  const files = unpackTarGz(archive);
  const manifest = readManifest(files);
  if (manifest.id !== id || manifest.version !== version) {
    throw new Error(`Package contents (${manifest.id}@${manifest.version}) do not match ${id}@${version}`);
  }
  checkKind(manifest, opts);
  let signature: string | undefined;
  let publisherKeys: SigningKeyInfo[] | undefined;
  if (entry.signature) {
    signature = await registry.signature(id, version);
    if (!signature) throw new Error(`The registry lists a signature for ${id}@${version} but does not serve it`);
    publisherKeys = (await registry.publisher(info.plugin.owner)).signingKeys;
  }
  const trust = await readTrust(opts.serverDir);
  const decision = decideTrust(id, archive, signature, trust[id]?.keys, publisherKeys, trustPolicy(opts));
  return { manifest, files, archiveSha: sha256(archive), registryUrl: registry.baseUrl, decision, ...(entry.provenance ? { provenance: entry.provenance } : {}) };
}

function trustPolicy(opts: InstallOptions) {
  return {
    security: opts.security ?? { requireSignatures: false, trustedKeys: {} },
    acceptNewKey: opts.acceptNewKey,
    allowUnsigned: opts.allowUnsigned,
    extraKeys: opts.keyFiles,
  };
}

/** Places a fetched package, records its signature, and stores any new key pin. */
export async function commitPackage(fetched: FetchedPackage, opts: InstallOptions): Promise<InstallOutcome> {
  const { decision } = fetched;
  const outcome = await placePackage(
    fetched.manifest,
    fetched.files,
    fetched.archiveSha,
    opts,
    fetched.registryUrl,
    decision.signed ? { keyId: decision.keyId!, trustedComment: decision.trustedComment! } : undefined,
    fetched.provenance,
  );
  if (decision.pin) {
    const trust = await readTrust(opts.serverDir);
    trust[fetched.manifest.id] = { keys: decision.pin };
    await writeTrust(opts.serverDir, trust);
  }
  return { ...outcome, trust: { signed: decision.signed, keyId: decision.keyId, status: decision.status } };
}

/** Installs `id[@range]` plus missing dependencies from the registry. Dependencies come first. */
export async function installFromRegistry(spec: string, opts: InstallOptions): Promise<InstallOutcome[]> {
  if (!opts.registry) throw new Error('No registry configured');
  const { id, range } = parseSpec(spec);
  const outcomes: InstallOutcome[] = [];
  await installRecursive(id, range, opts, [], outcomes, true);
  return outcomes;
}

async function installRecursive(id: string, range: string, opts: InstallOptions, stack: string[], outcomes: InstallOutcome[], top: boolean): Promise<void> {
  if (stack.includes(id)) throw new Error(`Dependency cycle: ${[...stack, id].join(' → ')}`);
  if (outcomes.some((o) => o.id === id)) return;
  const index = await readInstalled(opts.serverDir);
  const current = index[id];
  if (current && satisfies(current.version, range) && !(top && opts.force)) {
    outcomes.push({ id, version: current.version, kind: current.kind, permissions: current.manifest.permissions, skipped: true });
    return;
  }
  const info = await opts.registry!.plugin(id);
  const version = resolveVersion(info.versions, range);
  if (!version) throw new Error(`No published version of ${id} matches ${range}`);
  const fetched = await fetchFromRegistry(id, version, opts);
  for (const [dep, depRange] of Object.entries(fetched.manifest.dependencies)) {
    await installRecursive(dep, depRange, opts, [...stack, id], outcomes, false);
  }
  outcomes.push(await commitPackage(fetched, opts));
}

/**
 * Installs a local `.tgz`, verifying a sibling `<file>.minisig` when present (against
 * `--key-file`, configured or pinned keys, or the publisher's keys on the registry).
 * Dependencies must already be installed or resolvable from the registry.
 */
export async function installFromFile(file: string, opts: InstallOptions): Promise<InstallOutcome[]> {
  const archive = await readFile(file);
  const files = unpackTarGz(archive);
  const manifest = readManifest(files);
  checkKind(manifest, opts);
  const signature = existsSync(`${file}.minisig`) ? await readFile(`${file}.minisig`, 'utf8') : undefined;
  let publisherKeys: SigningKeyInfo[] | undefined;
  if (signature && opts.registry) {
    try {
      const info = await opts.registry.plugin(manifest.id);
      publisherKeys = (await opts.registry.publisher(info.plugin.owner)).signingKeys;
    } catch {
      // Not on the registry (or unreachable): rely on --key-file, configured and pinned keys.
    }
  }
  const trust = await readTrust(opts.serverDir);
  const decision = decideTrust(manifest.id, archive, signature, trust[manifest.id]?.keys, publisherKeys, trustPolicy(opts));

  const outcomes: InstallOutcome[] = [];
  const index = await readInstalled(opts.serverDir);
  for (const [dep, range] of Object.entries(manifest.dependencies)) {
    if (index[dep] && satisfies(index[dep].version, range)) continue;
    if (!opts.registry) throw new Error(`${manifest.id} needs ${dep}@${range}; install it first`);
    await installRecursive(dep, range, opts, [manifest.id], outcomes, false);
  }
  outcomes.push(await commitPackage({ manifest, files, archiveSha: sha256(archive), decision }, opts));
  return outcomes;
}

interface PlannedFile {
  file: InstalledFile;
  data: Buffer;
}

/** Writes a verified, unpacked package to its destinations and records it. */
export async function placePackage(
  manifest: PluginManifest,
  files: Map<string, Buffer>,
  archiveSha: string,
  opts: InstallOptions,
  registry: string | undefined,
  signature?: InstalledPackage['signature'],
  provenance?: InstalledPackage['provenance'],
): Promise<InstallOutcome> {
  checkKind(manifest, opts);
  const store = packageStore(opts.serverDir);
  const { gameRoot } = opts;
  const index = await readInstalled(store);
  const previous = index[manifest.id];
  const owned = (base: InstalledFile['base'], path: string) => previous?.files.some((f) => f.base === base && f.path === path) ?? false;
  const plan: PlannedFile[] = [];
  const add = (base: InstalledFile['base'], path: string, source: string, content?: InstalledFile['content']) => {
    const data = files.get(source);
    if (!data) throw new Error(`plugin.json lists ${source}, but the package does not contain it`);
    plan.push({ file: { base, path, source, size: data.length, sha256: sha256(data), ...(content ? { content } : {}) }, data });
  };

  if (manifest.kind === 'host') {
    const main = safeRelativePath(manifest.main!);
    if (!files.has(main)) throw new Error(`Entry point ${main} is not in the package`);
    for (const path of files.keys()) add('server', posix.join('.opencitadel/plugins', manifest.id, path), path);
  } else {
    if (!gameRoot) throw new Error(`${manifest.kind} packages need the Deadlock install path (set game.path in server.json)`);
    if (manifest.kind === 'deadworks') {
      const seen = new Set<string>();
      for (const asm of manifest.assemblies ?? []) {
        const name = basename(safeRelativePath(asm));
        if (seen.has(name.toLowerCase())) throw new Error(`Two assemblies are named ${name}`);
        seen.add(name.toLowerCase());
        add('game', `game/bin/win64/managed/plugins/${name}`, safeRelativePath(asm));
      }
    } else {
      const maps = new Set(manifest.maps ?? []);
      const addonDir = 'game/citadel/opencitadel_server';
      const taken = new Set<string>();
      const layout = gameLayout(gameRoot);
      for (const item of manifest.content ?? []) {
        const source = safeRelativePath(item.file);
        const stem = basename(source, '.vpk');
        if (maps.has(stem) || source.startsWith('maps/')) {
          if (!/^[a-z0-9_]+$/.test(stem)) throw new Error(`Map file names must be lowercase a-z, 0-9 and _: ${source}`);
          add('game', `game/citadel/maps/${stem}.vpk`, source, { kind: 'map', name: stem, client: item.client });
        } else if (opts.addonLayout === 'deadworks') {
          const name = addonName(manifest.id, stem);
          add('game', `game/citadel/deadworks_server_addons/vpks/${name}.vpk`, source, { kind: 'addon', name, client: item.client });
        } else {
          // Addons are mounted as pakNN_dir.vpk, the community addon naming convention.
          let slot = 1;
          for (; slot <= 99; slot++) {
            const name = `pak${String(slot).padStart(2, '0')}_dir.vpk`;
            const path = `${addonDir}/${name}`;
            if (taken.has(path)) continue;
            if (existsSync(join(layout.serverContentDir, name)) && !owned('game', path)) continue;
            break;
          }
          if (slot > 99) throw new Error(`No free pakNN_dir.vpk slot in ${addonDir}`);
          const path = `${addonDir}/pak${String(slot).padStart(2, '0')}_dir.vpk`;
          taken.add(path);
          add('game', path, source, { kind: 'addon', name: addonName(manifest.id, stem), client: item.client });
        }
      }
    }
  }

  // Never clobber a file we did not install, or one another package owns.
  for (const { file } of plan) {
    const abs = installedFilePath(file, store.root, gameRoot);
    const owner = fileOwner(index, file.base, file.path);
    if (owner && owner !== manifest.id) throw new Error(`${file.path} belongs to package "${owner}"`);
    if (!owner && existsSync(abs)) throw new Error(`Refusing to overwrite ${file.path}: it was not installed by OpenCitadel`);
  }
  const pluginDir = join(store.pluginsDir, manifest.id);
  if (manifest.kind === 'host' && !previous && existsSync(pluginDir)) {
    throw new Error(`Refusing to replace ${pluginDir}: it was not installed by OpenCitadel (a development copy?)`);
  }

  if (manifest.kind === 'host') {
    // Stage, then swap the directory in, so a failed install never leaves half a plugin.
    const staging = join(store.pluginsDir, `.staging-${manifest.id}-${randomBytes(4).toString('hex')}`);
    try {
      for (const { file, data } of plan) await atomicWrite(join(staging, ...file.path.split('/').slice(3)), data);
      const old = `${pluginDir}.old-${randomBytes(4).toString('hex')}`;
      if (existsSync(pluginDir)) await rename(pluginDir, old);
      await rename(staging, pluginDir);
      await rm(old, { recursive: true, force: true });
    } catch (err) {
      await rm(staging, { recursive: true, force: true });
      throw err;
    }
  } else {
    const created: string[] = [];
    try {
      for (const { file, data } of plan) {
        const abs = installedFilePath(file, store.root, gameRoot);
        if (!existsSync(abs)) created.push(abs);
        await atomicWrite(abs, data);
      }
    } catch (err) {
      for (const abs of created) await unlink(abs).catch(() => {});
      throw err;
    }
    // Drop files the previous version had that this one does not.
    for (const f of previous?.files ?? []) {
      if (!plan.some((p) => p.file.base === f.base && p.file.path === f.path)) {
        await unlink(installedFilePath(f, store.root, previous!.gameRoot ?? gameRoot)).catch(() => {});
      }
    }
  }

  for (const p of plan) {
    if (p.file.base === 'game') p.file.mtimeMs = (await stat(installedFilePath(p.file, store.root, gameRoot))).mtimeMs;
  }

  let mountedContent = false;
  const addons = plan.filter((p) => p.file.content?.kind === 'addon').map((p) => p.file.content!.name);
  if (addons.length && opts.addonLayout !== 'deadworks') {
    const gameinfo = gameLayout(gameRoot!).gameinfo;
    if (existsSync(gameinfo)) mountedContent = await patchGameinfoFile(gameinfo, ['server-content']);
  }

  const record: InstalledPackage = {
    version: manifest.version,
    kind: manifest.kind,
    sha256: archiveSha,
    installedAt: new Date().toISOString(),
    ...(registry ? { registry } : {}),
    ...(manifest.kind !== 'host' && gameRoot ? { gameRoot } : {}),
    ...(signature ? { signature } : {}),
    ...(provenance ? { provenance } : {}),
    manifest,
    files: plan.map((p) => p.file),
  };
  const latest = await readInstalled(store);
  latest[manifest.id] = record;
  await writeInstalled(store, latest);
  return {
    id: manifest.id,
    version: manifest.version,
    kind: manifest.kind,
    permissions: manifest.permissions,
    skipped: false,
    mountedContent,
    ...(addons.length && opts.addonLayout === 'deadworks' ? { deadworksAddons: addons } : {}),
  };
}

export interface RemoveOptions {
  serverDir: StoreLocation;
  gameRoot?: string;
  /** Remove even if other installed packages depend on it. */
  force?: boolean;
}

/** Deletes exactly the files a package installed. Plugin data under .opencitadel/data is kept, and so is its key pin. */
export async function removePackage(id: string, opts: RemoveOptions): Promise<InstalledPackage> {
  const store = packageStore(opts.serverDir);
  const index: InstalledIndex = await readInstalled(store);
  const pkg = index[id];
  if (!pkg) throw new Error(`${id} is not installed`);
  const dependents = dependentsOf(index, id);
  if (dependents.length && !opts.force) throw new Error(`${dependents.join(', ')} depend${dependents.length === 1 ? 's' : ''} on ${id}; remove ${dependents.length === 1 ? 'it' : 'them'} first or use --force`);
  const gameRoot = pkg.gameRoot ?? opts.gameRoot;
  for (const f of pkg.files) {
    await unlink(installedFilePath(f, store.root, gameRoot)).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
  }
  if (pkg.kind === 'host') await rm(join(store.pluginsDir, id), { recursive: true, force: true });
  delete index[id];
  await writeInstalled(store, index);
  return pkg;
}

/** True when installed content packages put addon VPKs on the server (the content search path must stay mounted). */
export async function hasServerAddons(location: StoreLocation): Promise<boolean> {
  const index = await readInstalled(location);
  return Object.values(index).some((p) => p.files.some((f) => f.content?.kind === 'addon'));
}
