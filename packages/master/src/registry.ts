/**
 * Plugin registry: publishing, version resolution and package/file storage.
 *
 * Packages are stored once by content hash at `<data>/packages/<sha256>.tgz`, and their files
 * are unpacked to `<data>/files/<sha256>/` at publish time so single files (content VPKs) can be
 * streamed without re-reading the archive.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import {
  compareVersions,
  isValidRange,
  isValidVersion,
  maxSatisfying,
  parseManifest,
  parseSignature,
  safeRelativePath,
  unpackTarGz,
  type PluginManifest,
  type PluginSummary,
  type PluginVersionInfo,
  type Provenance,
} from '@opencitadel/protocol';
import { HttpError } from './http.js';
import type { ContentFileRow, PluginRow, PluginVersionRow, Store } from './store.js';
import { recomputeKeyChanged, verifyPackageSignature } from './trust.js';

export const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;

export function versionInfo(v: PluginVersionRow): PluginVersionInfo {
  const info: PluginVersionInfo = { version: v.version, sha256: v.sha256, size: v.size, publishedAt: new Date(v.published_at).toISOString(), yanked: !!v.yanked };
  if (v.signature) {
    try {
      const sig = parseSignature(v.signature);
      info.signature = { keyId: sig.keyId, trustedComment: sig.trustedComment };
    } catch {
      // Verified at publish; an unparsable stored signature is reported as unsigned.
    }
  }
  if (v.key_changed) info.keyChanged = true;
  if (v.provenance) {
    try {
      info.provenance = JSON.parse(v.provenance) as Provenance;
    } catch {
      // Written by us at publish; an unreadable record is simply omitted.
    }
  }
  return info;
}

/**
 * The VPKs a content package provides, named the way citadel-host advertises them: maps by
 * their stem, addons as `<id with - as _>_<file stem>`. Files that can't be named are skipped.
 */
export function contentFilesOf(manifest: PluginManifest, files: Map<string, Buffer>, packageSha256: string): ContentFileRow[] {
  if (manifest.kind !== 'content') return [];
  const maps = new Set(manifest.maps ?? []);
  const out: ContentFileRow[] = [];
  for (const item of manifest.content ?? []) {
    const path = safeRelativePath(item.file);
    const data = files.get(path);
    if (!data) continue;
    const stem = posix.basename(path, '.vpk');
    const isMap = maps.has(stem) || path.startsWith('maps/');
    let name: string;
    if (isMap) {
      if (!/^[a-z0-9_]+$/.test(stem)) continue;
      name = stem;
    } else {
      name = `${manifest.id.replace(/-/g, '_')}_${stem.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`.slice(0, 64);
    }
    out.push({
      plugin_id: manifest.id,
      version: manifest.version,
      path,
      kind: isMap ? 'map' : 'addon',
      name,
      sha256: createHash('sha256').update(data).digest('hex'),
      size: data.length,
      package_sha256: packageSha256,
    });
  }
  return out;
}

export interface RegistryOptions {
  /** Reject unsigned packages (OPENCITADEL_REQUIRE_SIGNATURES=1). */
  requireSignatures?: boolean;
}

/** Highest non-yanked version, or undefined if every version is yanked. */
export function latestVersion(versions: PluginVersionRow[]): PluginVersionRow | undefined {
  return versions.filter((v) => !v.yanked).sort((a, b) => compareVersions(a.version, b.version)).pop();
}

export function pluginSummary(p: PluginRow, latest: PluginVersionRow): PluginSummary {
  const summary: PluginSummary = {
    id: p.id,
    name: p.name,
    kind: p.kind,
    description: p.description,
    latest: latest.version,
    owner: p.owner_name,
    tags: p.tags,
    downloads: p.downloads,
    updatedAt: new Date(p.updated_at).toISOString(),
  };
  if (p.author) summary.author = p.author;
  if (p.require_trusted_publishing) summary.requireTrustedPublishing = true;
  return summary;
}

/**
 * Resolves `:version` — an exact version (yanked ones included), `latest`, or a semver range
 * (yanked versions excluded).
 */
export function resolveVersion(store: Store, pluginId: string, spec: string): PluginVersionRow {
  const plugin = store.plugin(pluginId);
  if (!plugin) throw new HttpError(404, 'not_found', `No plugin "${pluginId}"`);
  const versions = store.versions(pluginId);
  let found: PluginVersionRow | undefined;
  if (isValidVersion(spec)) {
    found = versions.find((v) => compareVersions(v.version, spec) === 0);
  } else if (spec === 'latest') {
    found = latestVersion(versions);
  } else if (isValidRange(spec)) {
    const best = maxSatisfying(
      versions.filter((v) => !v.yanked).map((v) => v.version),
      spec,
    );
    found = best ? versions.find((v) => v.version === best) : undefined;
  } else {
    throw new HttpError(400, 'invalid_version', `"${spec}" is not a version, a range or "latest"`);
  }
  if (!found) throw new HttpError(404, 'not_found', `No version of "${pluginId}" matches "${spec}"`);
  return found;
}

const CONTENT_TYPES: Record<string, string> = {
  json: 'application/json; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gz: 'application/gzip',
  tgz: 'application/gzip',
};

/** Never anything a browser would render as active content from our origin. */
export function contentTypeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

export class Registry {
  readonly requireSignatures: boolean;

  constructor(
    private readonly store: Store,
    private readonly dataDir: string,
    private readonly now: () => number,
    opts: RegistryOptions = {},
  ) {
    this.requireSignatures = opts.requireSignatures ?? false;
  }

  packagePath(sha256: string): string {
    return join(this.dataDir, 'packages', `${sha256}.tgz`);
  }

  /** Absolute path of a file inside a published package, or undefined if it isn't there. */
  filePath(sha256: string, rel: string): string | undefined {
    let safe: string;
    try {
      safe = safeRelativePath(rel);
    } catch {
      return undefined;
    }
    const p = join(this.dataDir, 'files', sha256, ...safe.split('/'));
    return existsSync(p) ? p : undefined;
  }

  /**
   * Publishes a package. `signatureText` is the publisher's `.minisig` for the exact bytes; it is
   * verified against the account's active signing keys before anything is stored. `provenance`
   * is recorded when the publish came through trusted publishing.
   */
  async publish(
    accountId: string,
    pluginId: string,
    version: string,
    body: Buffer,
    signatureText?: string,
    provenance?: Provenance,
  ): Promise<{ plugin: PluginSummary; version: PluginVersionInfo }> {
    if (!body.length) throw new HttpError(400, 'invalid_package', 'Empty package');
    let files: Map<string, Buffer>;
    try {
      files = unpackTarGz(body, { maxFiles: 2000, maxTotalBytes: 1024 * 1024 * 1024 });
    } catch (err) {
      throw new HttpError(400, 'invalid_package', `Not a valid package: ${(err as Error).message}`);
    }
    const manifestFile = files.get('plugin.json');
    if (!manifestFile) throw new HttpError(400, 'invalid_package', 'Package has no plugin.json at its root');
    let manifest: PluginManifest;
    try {
      manifest = parseManifest(JSON.parse(manifestFile.toString('utf8')));
    } catch (err) {
      throw new HttpError(400, 'invalid_manifest', `plugin.json: ${(err as Error).message}`);
    }
    if (manifest.id !== pluginId) throw new HttpError(400, 'manifest_mismatch', `plugin.json id "${manifest.id}" does not match "${pluginId}"`);
    if (manifest.version !== version) throw new HttpError(400, 'manifest_mismatch', `plugin.json version "${manifest.version}" does not match "${version}"`);
    const referenced = [manifest.main, ...(manifest.assemblies ?? []), ...(manifest.content ?? []).map((c) => c.file)].filter((f): f is string => !!f);
    for (const ref of referenced) {
      let path: string;
      try {
        path = safeRelativePath(ref);
      } catch {
        throw new HttpError(400, 'invalid_manifest', `plugin.json references an unsafe path "${ref}"`);
      }
      if (!files.has(path)) throw new HttpError(400, 'invalid_package', `plugin.json references "${ref}", which is not in the package`);
    }

    const existing = this.store.plugin(pluginId);
    if (existing && existing.owner_id !== accountId) throw new HttpError(403, 'not_owner', `Plugin "${pluginId}" belongs to another account`);
    const reserved = existing ? undefined : this.store.reservation(pluginId);
    if (reserved && reserved.account_id !== accountId) throw new HttpError(403, 'not_owner', `Plugin id "${pluginId}" is reserved by another account`);
    if (existing && existing.kind !== manifest.kind) throw new HttpError(400, 'kind_mismatch', `Plugin "${pluginId}" is a ${existing.kind} plugin; versions can't change kind`);
    if (existing && this.store.versions(pluginId).some((v) => compareVersions(v.version, version) === 0)) {
      throw new HttpError(409, 'version_exists', `${pluginId}@${version} is already published; versions are immutable`);
    }

    const sha256 = createHash('sha256').update(body).digest('hex');
    let signed: { keyId: string; signature: string } | undefined;
    if (signatureText !== undefined) {
      signed = verifyPackageSignature(this.store, accountId, body, signatureText, { id: pluginId, version, sha256 });
    } else if (this.requireSignatures) {
      throw new HttpError(422, 'signature_required', 'This registry only accepts signed packages (send X-OpenCitadel-Signature)');
    }
    const contentFiles = contentFilesOf(manifest, files, sha256);
    await this.storeFiles(sha256, body, files);

    const now = this.now();
    this.store.transaction(() => {
      // Re-check inside the transaction: two publishes can race.
      const current = this.store.plugin(pluginId);
      if (current && current.owner_id !== accountId) throw new HttpError(403, 'not_owner', `Plugin "${pluginId}" belongs to another account`);
      if (this.store.version(pluginId, version)) throw new HttpError(409, 'version_exists', `${pluginId}@${version} is already published`);
      const meta = { name: manifest.name, description: manifest.description, author: manifest.author ?? null, tags: manifest.tags };
      if (!current) {
        const hold = this.store.reservation(pluginId);
        if (hold && hold.account_id !== accountId) throw new HttpError(403, 'not_owner', `Plugin id "${pluginId}" is reserved by another account`);
        this.store.insertPlugin({ id: pluginId, owner_id: accountId, kind: manifest.kind, created_at: now, updated_at: now, ...meta });
        // The reservation becomes ownership.
        this.store.deleteReservation(pluginId);
      }
      this.store.insertVersion({
        plugin_id: pluginId,
        version,
        sha256,
        size: body.length,
        manifest: JSON.stringify(manifest),
        published_at: now,
        signature: signed?.signature ?? null,
        signature_key_id: signed?.keyId ?? null,
        provenance: provenance ? JSON.stringify(provenance) : null,
      });
      for (const file of contentFiles) this.store.insertContentFile(file);
      recomputeKeyChanged(this.store, pluginId);
      const latest = latestVersion(this.store.versions(pluginId));
      // Listing metadata follows the newest release, not whatever was published last.
      if (latest?.version === version) this.store.updatePluginMeta(pluginId, { ...meta, updated_at: now });
      else this.store.touchPlugin(pluginId, now);
    });

    const plugin = this.store.plugin(pluginId)!;
    const row = this.store.version(pluginId, version)!;
    return { plugin: pluginSummary(plugin, latestVersion(this.store.versions(pluginId)) ?? row), version: versionInfo(row) };
  }

  /** Adds a signature to a version published unsigned. Only the owner may, and only once. */
  async attachSignature(accountId: string, pluginId: string, version: string, signatureText: string): Promise<PluginVersionInfo> {
    const plugin = this.store.plugin(pluginId);
    if (!plugin || plugin.owner_id !== accountId) throw new HttpError(404, 'not_found', `No plugin "${pluginId}" on this account`);
    const row = this.store.versions(pluginId).find((v) => isValidVersion(version) && compareVersions(v.version, version) === 0);
    if (!row) throw new HttpError(404, 'not_found', `No version ${version} of "${pluginId}"`);
    if (row.signature) throw new HttpError(409, 'already_signed', `${pluginId}@${row.version} is already signed; signatures are immutable`);
    const body = await readFile(this.packagePath(row.sha256));
    const signed = verifyPackageSignature(this.store, accountId, body, signatureText, { id: pluginId, version: row.version, sha256: row.sha256 });
    this.store.transaction(() => {
      if (this.store.version(pluginId, row.version)?.signature) throw new HttpError(409, 'already_signed', `${pluginId}@${row.version} is already signed`);
      this.store.setSignature(pluginId, row.version, signed.signature, signed.keyId);
      recomputeKeyChanged(this.store, pluginId);
    });
    return versionInfo(this.store.version(pluginId, row.version)!);
  }

  private async storeFiles(sha256: string, body: Buffer, files: Map<string, Buffer>): Promise<void> {
    const pkg = this.packagePath(sha256);
    const filesDir = join(this.dataDir, 'files', sha256);
    if (existsSync(pkg) && existsSync(filesDir)) return;
    await mkdir(dirname(pkg), { recursive: true });
    const tmpPkg = `${pkg}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpPkg, body);
    const tmpDir = `${filesDir}.${process.pid}.${Date.now()}.tmp`;
    try {
      for (const [rel, data] of files) {
        const out = join(tmpDir, ...rel.split('/'));
        await mkdir(dirname(out), { recursive: true });
        await writeFile(out, data);
      }
      await rm(filesDir, { recursive: true, force: true });
      await rename(tmpDir, filesDir);
      await rename(tmpPkg, pkg);
    } catch (err) {
      await rm(tmpDir, { recursive: true, force: true });
      await rm(tmpPkg, { force: true });
      throw err;
    }
  }

  /** Every plugin with at least one non-yanked version, filtered. */
  list(q: { q?: string; kind?: string; tag?: string }): PluginSummary[] {
    const needle = q.q?.toLowerCase();
    const out: PluginSummary[] = [];
    for (const p of this.store.allPlugins()) {
      const latest = latestVersion(this.store.versions(p.id));
      if (!latest) continue;
      if (q.kind && p.kind !== q.kind) continue;
      if (q.tag && !p.tags.includes(q.tag)) continue;
      if (needle && ![p.id, p.name, p.description, ...p.tags].join('\n').toLowerCase().includes(needle)) continue;
      out.push(pluginSummary(p, latest));
    }
    return out;
  }
}
