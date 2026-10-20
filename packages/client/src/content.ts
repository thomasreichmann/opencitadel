/**
 * Server-required content: download, verify and install the VPKs a server lists before joining.
 *
 * Downloads are cached by sha256 under ~/.opencitadel/cache and verified three ways (exact size,
 * sha256, VPK magic) before anything touches the game folder. Maps install as
 * `game/citadel/maps/<name>.vpk` — never over a map OpenCitadel didn't put there, which protects
 * the stock maps that live in the same folder. Addons install into `game/citadel/opencitadel/`
 * as `pak01_dir.vpk`, `pak02_dir.vpk`, … and are mounted through the content search path in
 * gameinfo.gi. The addon set always mirrors the server being joined, so joining a vanilla server
 * unmounts the previous server's addons.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import {
  ADDED_MARKER,
  CONTENT_SEARCH_PATH,
  KvEditor,
  gameLayout,
  inspectGameinfo,
  parseKeyValues,
  patchGameinfoFile,
  type GameinfoStatus,
} from '@opencitadel/gamefiles';
import { parse, v, type ContentItem } from '@opencitadel/protocol';
import type { FetchLike } from './api.js';
import { CLIENT_VERSION } from './version.js';

export const VPK_MAGIC = Buffer.from([0x34, 0x12, 0xaa, 0x55]);
export const MAX_FILE_BYTES = 4 * 1024 ** 3;
export const MAX_JOIN_BYTES = 16 * 1024 ** 3;
const USER_AGENT = `citadel-browser/${CLIENT_VERSION}`;
const ADDON_FILE = /^pak\d{2,3}_dir\.vpk$/;

export class ContentError extends Error {
  constructor(message: string, readonly item?: string) {
    super(message);
    this.name = 'ContentError';
  }
}

export interface ProgressEvent {
  item: ContentItem;
  received: number;
  total: number;
}

const installedValidator = v.object({
  version: v.withDefault(v.int({ min: 1, max: 1 }), 1),
  server: v.optional(v.object({ id: v.optional(v.string({ max: 64 })), name: v.optional(v.string({ max: 128 })) })),
  maps: v.withDefault(v.record(v.object({ sha256: v.string({ pattern: /^[0-9a-f]{64}$/ }), size: v.int({ min: 0 }) }), { key: v.string({ pattern: /^[a-z0-9_]+$/ }) }), {}),
  addons: v.withDefault(
    v.array(v.object({ name: v.string({ max: 64 }), sha256: v.string({ pattern: /^[0-9a-f]{64}$/ }), size: v.int({ min: 0 }), file: v.string({ pattern: ADDON_FILE }) })),
    [],
  ),
  updatedAt: v.withDefault(v.string({ max: 40 }), ''),
});
export type InstalledContent = ReturnType<typeof installedValidator>;

function installedFile(gameRoot: string): string {
  return join(gameLayout(gameRoot).contentDir, 'installed.json');
}

export async function readInstalled(gameRoot: string): Promise<InstalledContent | undefined> {
  const file = installedFile(gameRoot);
  if (!existsSync(file)) return undefined;
  try {
    return parse(installedValidator, JSON.parse(await readFile(file, 'utf8')));
  } catch (err) {
    throw new ContentError(`${file} is corrupt (${(err as Error).message}); run \`citadel-browser content clear\``);
  }
}

async function writeInstalled(gameRoot: string, state: InstalledContent): Promise<void> {
  const file = installedFile(gameRoot);
  await mkdir(gameLayout(gameRoot).contentDir, { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(state, null, 2) + '\n', 'utf8');
  await rename(`${file}.tmp`, file);
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

// ---- download -------------------------------------------------------------------------------

function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const x = ip.toLowerCase();
  if (x.startsWith('::ffff:')) return isPrivateIp(x.slice(7));
  return x === '::' || x === '::1' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80');
}

/**
 * Content URLs come from server owners, so by default they may not point into the player's own
 * network (router admin pages and the like). Every redirect hop is checked too.
 */
async function assertPublicHost(url: URL): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) throw new ContentError(`Refusing to download from a local address: ${url.host}`);
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (addresses.some(isPrivateIp)) throw new ContentError(`Refusing to download from a private address: ${url.host}`);
}

async function fetchFollowingRedirects(url: string, fetchImpl: FetchLike, allowPrivate: boolean, trustedHosts: string[]): Promise<Response> {
  let current = new URL(url);
  for (let hop = 0; hop < 5; hop++) {
    if (current.protocol !== 'https:' && current.protocol !== 'http:') throw new ContentError(`Unsupported download URL: ${current.href}`);
    if (!allowPrivate && !trustedHosts.includes(current.host)) await assertPublicHost(current);
    let res: Response;
    try {
      res = await fetchImpl(current, { redirect: 'manual', headers: { 'user-agent': USER_AGENT } });
    } catch (err) {
      throw new ContentError(`Download from ${current.host} failed: ${(err as { cause?: Error }).cause?.message ?? (err as Error).message}`);
    }
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      current = new URL(location, current);
      continue;
    }
    return res;
  }
  throw new ContentError(`Too many redirects downloading ${url}`);
}

/** Counts bytes through a stream and fails once more than `limit` have passed. */
function byteLimit(limit: number, message: string, onChunk?: (chunk: Buffer, total: number) => void): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > limit) return callback(new ContentError(message));
      onChunk?.(chunk, total);
      callback(null, chunk);
    },
  });
}

export interface CacheOptions {
  fetchImpl?: FetchLike;
  allowPrivate?: boolean;
  /**
   * `host[:port]`s exempt from the private-address check — the configured master, so content
   * served from a registry on a LAN or localhost master still installs.
   */
  trustedHosts?: string[];
  onProgress?(event: ProgressEvent): void;
}

/**
 * Returns the path of a verified copy of `item` in the cache, downloading it if needed.
 * Nothing that fails verification is ever left in the cache.
 */
export async function ensureCached(item: ContentItem, cacheDir: string, opts: CacheOptions = {}): Promise<{ path: string; downloaded: boolean }> {
  const dest = join(cacheDir, item.sha256);
  if (existsSync(dest)) {
    if ((await stat(dest)).size === item.size && (await sha256File(dest)) === item.sha256) return { path: dest, downloaded: false };
    await rm(dest, { force: true });
  }
  if (item.size > MAX_FILE_BYTES) throw new ContentError(`${item.name} is ${item.size} bytes, over the 4 GiB per-file limit`, item.name);
  await mkdir(cacheDir, { recursive: true });

  const res = await fetchFollowingRedirects(item.url, opts.fetchImpl ?? fetch, opts.allowPrivate ?? false, opts.trustedHosts ?? []);
  if (!res.ok || !res.body) {
    await res.body?.cancel();
    throw new ContentError(`Downloading ${item.name} failed: HTTP ${res.status}`, item.name);
  }

  const tmp = join(cacheDir, `${item.sha256}.${randomBytes(4).toString('hex')}.part`);
  const hash = createHash('sha256');
  let head = Buffer.alloc(0);
  let received = 0;
  const verify = byteLimit(item.size, `${item.name} is larger than the advertised ${item.size} bytes`, (chunk, total) => {
    received = total;
    if (head.length < 4) head = Buffer.concat([head, chunk.subarray(0, 4 - head.length)]);
    hash.update(chunk);
    opts.onProgress?.({ item, received, total: item.size });
  });
  const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  try {
    if (new URL(item.url).pathname.endsWith('.gz')) {
      // Bound the compressed stream too, so a trickle of empty gzip members can't run forever.
      const raw = byteLimit(item.size + Math.ceil(item.size / 100) + 65536, `${item.name}: compressed download is implausibly large`);
      await pipeline(source, raw, createGunzip(), verify, createWriteStream(tmp));
    } else {
      await pipeline(source, verify, createWriteStream(tmp));
    }
    if (received !== item.size) throw new ContentError(`${item.name}: got ${received} bytes, expected ${item.size}`, item.name);
    if (!head.equals(VPK_MAGIC)) throw new ContentError(`${item.name} is not a VPK file`, item.name);
    const digest = hash.digest('hex');
    if (digest !== item.sha256) throw new ContentError(`${item.name} failed its checksum (got ${digest.slice(0, 16)}…, expected ${item.sha256.slice(0, 16)}…)`, item.name);
    await rename(tmp, dest);
  } catch (err) {
    await rm(tmp, { force: true });
    if (err instanceof ContentError) throw err;
    throw new ContentError(`Downloading ${item.name} failed: ${(err as Error).message}`, item.name);
  }
  return { path: dest, downloaded: true };
}

// ---- install --------------------------------------------------------------------------------

async function copyAtomic(from: string, to: string): Promise<void> {
  const tmp = `${to}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await copyFile(from, tmp);
    await rename(tmp, to);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

async function ourAddonFiles(contentDir: string): Promise<string[]> {
  if (!existsSync(contentDir)) return [];
  return (await readdir(contentDir)).filter((f) => ADDON_FILE.test(f));
}

const addonFileName = (index: number) => `pak${String(index + 1).padStart(2, '0')}_dir.vpk`;

export interface SyncOptions extends CacheOptions {
  gameRoot: string;
  cacheDir: string;
  items: ContentItem[];
  /** Recorded in installed.json for `content status`. */
  server?: { id?: string; name?: string };
  /** Whether Deadlock is running right now (addon changes then need a restart). */
  gameRunning?: boolean;
}

export interface SyncResult {
  /** Items newly installed or replaced. */
  installed: string[];
  /** Items already in place. */
  unchanged: string[];
  /** Previously installed addons that were unmounted because this server doesn't use them. */
  removed: string[];
  restartRequired: boolean;
  gameinfoPatched: boolean;
}

/** Makes the game folder hold exactly the content `items` needs. See the module comment. */
export async function syncContent(opts: SyncOptions): Promise<SyncResult> {
  const layout = gameLayout(opts.gameRoot);
  const { items } = opts;
  const seen = new Set<string>();
  for (const item of items) {
    const key = `${item.kind}:${item.name}`;
    if (seen.has(key)) throw new ContentError(`The server lists ${item.kind} "${item.name}" twice`, item.name);
    seen.add(key);
  }
  const totalBytes = items.reduce((n, i) => n + i.size, 0);
  if (totalBytes > MAX_JOIN_BYTES) throw new ContentError(`The server requires ${totalBytes} bytes of content, over the 16 GiB limit`);

  const state: InstalledContent = (await readInstalled(opts.gameRoot)) ?? { version: 1, maps: {}, addons: [], updatedAt: '' };
  const result: SyncResult = { installed: [], unchanged: [], removed: [], restartRequired: false, gameinfoPatched: false };

  // Decide what each map needs before downloading anything, so a refusal fails fast.
  const maps = items.filter((i) => i.kind === 'map');
  const mapsToInstall: ContentItem[] = [];
  for (const map of maps) {
    const target = join(layout.mapsDir, `${map.name}.vpk`);
    const ours = state.maps[map.name];
    if (!existsSync(target)) {
      mapsToInstall.push(map);
      continue;
    }
    const size = (await stat(target)).size;
    if (ours) {
      if (ours.sha256 === map.sha256 && size === map.size) result.unchanged.push(map.name);
      else mapsToInstall.push(map);
    } else if (size === map.size && (await sha256File(target)) === map.sha256) {
      // Someone else's identical copy: use it, but don't claim it (so `clear` leaves it alone).
      result.unchanged.push(map.name);
    } else {
      throw new ContentError(
        `Refusing to replace maps/${map.name}.vpk: OpenCitadel didn't install it (it may be a stock map or another mod). Move it aside to join this server.`,
        map.name,
      );
    }
  }

  const addons = items.filter((i) => i.kind === 'addon');
  const onDisk = new Set(await ourAddonFiles(layout.contentDir));
  const addonsUnchanged =
    state.addons.length === addons.length &&
    addons.every((a, i) => state.addons[i]!.sha256 === a.sha256 && state.addons[i]!.name === a.name && onDisk.has(state.addons[i]!.file)) &&
    onDisk.size === addons.length;

  // Download (or reuse) everything that has to be written.
  const cached = new Map<ContentItem, string>();
  for (const item of [...mapsToInstall, ...(addonsUnchanged ? [] : addons)]) {
    cached.set(item, (await ensureCached(item, opts.cacheDir, opts)).path);
  }

  if (mapsToInstall.length) await mkdir(layout.mapsDir, { recursive: true });
  for (const map of mapsToInstall) {
    await copyAtomic(cached.get(map)!, join(layout.mapsDir, `${map.name}.vpk`));
    state.maps[map.name] = { sha256: map.sha256, size: map.size };
    result.installed.push(map.name);
  }

  if (addonsUnchanged) {
    result.unchanged.push(...addons.map((a) => a.name));
  } else {
    result.removed = state.addons.filter((old) => !addons.some((a) => a.sha256 === old.sha256)).map((a) => a.name);
    await mkdir(layout.contentDir, { recursive: true });
    for (const file of onDisk) await rm(join(layout.contentDir, file), { force: true });
    state.addons = [];
    for (const [i, addon] of addons.entries()) {
      const file = addonFileName(i);
      await copyAtomic(cached.get(addon)!, join(layout.contentDir, file));
      state.addons.push({ name: addon.name, sha256: addon.sha256, size: addon.size, file });
      result.installed.push(addon.name);
    }
  }

  // Re-check on every join: Valve's updates rewrite gameinfo.gi and drop the search path.
  if (addons.length) result.gameinfoPatched = await patchGameinfoFile(layout.gameinfo, ['content']);

  const touched = result.installed.length > 0 || !addonsUnchanged;
  if (touched || (items.length && existsSync(installedFile(opts.gameRoot)))) {
    state.server = opts.server;
    state.updatedAt = new Date().toISOString();
    await writeInstalled(opts.gameRoot, state);
  }
  result.restartRequired = !!opts.gameRunning && (!addonsUnchanged || result.gameinfoPatched);
  return result;
}

// ---- status / clear -------------------------------------------------------------------------

export interface ContentStatus {
  installed?: InstalledContent;
  gameinfo: GameinfoStatus;
}

export async function contentStatus(gameRoot: string): Promise<ContentStatus> {
  return { installed: await readInstalled(gameRoot), gameinfo: inspectGameinfo(await readFile(gameLayout(gameRoot).gameinfo, 'utf8')) };
}

/**
 * Removes only the content search-path line we added, leaving any other OpenCitadel edit (such
 * as the dedicated-server P2P keys a host applied to the same install) in place.
 */
export function removeContentSearchPath(source: string): string {
  const editor = new KvEditor(source);
  let offset = 0;
  for (const line of source.split('\n')) {
    const idx = line.indexOf(ADDED_MARKER);
    if (idx !== -1) {
      const node = parseKeyValues(line.slice(0, idx))[0];
      if (node?.key.toLowerCase() === 'game' && node.value === CONTENT_SEARCH_PATH) editor.replaceRange(offset, line.length + 1, '');
    }
    offset += line.length + 1;
  }
  return editor.apply();
}

export interface ClearResult {
  removed: string[];
  /** Map files we recorded but that changed on disk since, so they were left alone. */
  kept: string[];
  gameinfoChanged: boolean;
}

/** Uninstalls everything `syncContent` installed and unmounts the content search path. */
export async function clearContent(gameRoot: string): Promise<ClearResult> {
  const layout = gameLayout(gameRoot);
  const state = await readInstalled(gameRoot).catch(() => undefined);
  const result: ClearResult = { removed: [], kept: [], gameinfoChanged: false };

  for (const [name, rec] of Object.entries(state?.maps ?? {})) {
    const file = join(layout.mapsDir, `${name}.vpk`);
    if (!existsSync(file)) continue;
    if ((await stat(file)).size === rec.size && (await sha256File(file)) === rec.sha256) {
      await rm(file);
      result.removed.push(`maps/${name}.vpk`);
    } else {
      result.kept.push(`maps/${name}.vpk`);
    }
  }
  for (const file of await ourAddonFiles(layout.contentDir)) {
    await rm(join(layout.contentDir, file));
    result.removed.push(`opencitadel/${file}`);
  }
  await rm(installedFile(gameRoot), { force: true });
  if (existsSync(layout.contentDir) && (await readdir(layout.contentDir)).length === 0) await rmdir(layout.contentDir);

  const before = await readFile(layout.gameinfo, 'utf8');
  const after = removeContentSearchPath(before);
  if (after !== before) {
    parseKeyValues(after);
    await copyFile(layout.gameinfo, `${layout.gameinfo}.opencitadel.bak`);
    await writeFile(layout.gameinfo, after, 'utf8');
    result.gameinfoChanged = true;
  }
  return result;
}

/** Deletes cached downloads. Returns how many files were removed. */
export async function clearCache(cacheDir: string): Promise<number> {
  if (!existsSync(cacheDir)) return 0;
  const files = await readdir(cacheDir);
  await rm(cacheDir, { recursive: true, force: true });
  return files.length;
}
