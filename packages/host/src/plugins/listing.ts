/**
 * What installed packages contribute to the heartbeat: the `plugins` list and the `content`
 * players must download before joining.
 */

import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { findDeadlockInstall } from '@opencitadel/gamefiles';
import type { ContentItem, ListingPlugin } from '@opencitadel/protocol';
import type { HostConfig } from '../config.js';
import type { InstalledListing } from '../services.js';
import { installedFilePath, readInstalled, writeInstalled } from './installed.js';
import { sha256 } from './install.js';
import { RegistryClient } from './registry.js';

/**
 * - plugins: installed packages — host plugins only while enabled in server.json; deadworks and
 *   content packages whenever installed (their files are live as soon as they are on disk).
 * - content: `client: true` VPKs of installed content packages, with download URLs on the
 *   registry they were installed from. Packages installed from a local file are skipped (they
 *   have no public URL). A file modified on disk since install is left out, since players
 *   would download the registry's copy, not the server's.
 */
export const installedListing: InstalledListing = async (serverDir: string, config: HostConfig) => {
  const index = await readInstalled(serverDir);
  const plugins: ListingPlugin[] = [];
  const content: ContentItem[] = [];
  let dirty = false;
  for (const [id, pkg] of Object.entries(index).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (pkg.kind === 'host' && !config.plugins[id]?.enabled) continue;
    plugins.push({ id, name: pkg.manifest.name, version: pkg.version, kind: pkg.kind });
    if (pkg.kind !== 'content' || !pkg.registry) continue;
    const gameRoot = pkg.gameRoot ?? config.game.path ?? findDeadlockInstall();
    const registry = new RegistryClient(pkg.registry);
    for (const f of pkg.files) {
      if (!f.content?.client) continue;
      let abs: string;
      try {
        abs = installedFilePath(f, serverDir, gameRoot);
      } catch {
        continue;
      }
      if (!existsSync(abs)) continue;
      const st = await stat(abs);
      if (st.size !== f.size || (f.mtimeMs !== undefined && st.mtimeMs !== f.mtimeMs)) {
        // Touched since install: only advertise it if it is still the registry's file,
        // because that is what players will download.
        if (st.size !== f.size || sha256(await readFile(abs)) !== f.sha256) continue;
        f.mtimeMs = st.mtimeMs;
        dirty = true;
      }
      content.push({ name: f.content.name, kind: f.content.kind, sha256: f.sha256, size: f.size, url: registry.fileUrl(id, pkg.version, f.source) });
    }
  }
  if (dirty) await writeInstalled(serverDir, index).catch(() => {});
  return { plugins, content };
};
