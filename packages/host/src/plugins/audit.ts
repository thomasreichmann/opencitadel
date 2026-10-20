/**
 * Security advisories against installed packages: `plugin audit`, and a quiet check when the
 * host starts.
 */

import { satisfies, type Advisory, type AdvisorySeverity } from '@opencitadel/protocol';
import type { Logger } from '@opencitadel/plugin-sdk';
import type { HostConfig } from '../config.js';
import { readInstalled, type StoreLocation } from './installed.js';
import { RegistryClient, RegistryError } from './registry.js';

export interface AdvisoryMatch {
  id: string;
  version: string;
  advisory: Advisory;
}

export interface AuditResult {
  matches: AdvisoryMatch[];
  /** Packages that could not be checked, with the reason. */
  unchecked: Array<{ id: string; reason: string }>;
}

const RANK: Record<AdvisorySeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export const isSerious = (m: AdvisoryMatch) => RANK[m.advisory.severity] >= RANK.high;

/**
 * Checks every installed package against its registry's advisories (packages installed from a
 * local file are checked against `fallbackRegistry`). Withdrawn advisories are ignored.
 */
export async function auditInstalled(location: StoreLocation, fallbackRegistry: string, fetchImpl?: typeof fetch): Promise<AuditResult> {
  const index = await readInstalled(location);
  const result: AuditResult = { matches: [], unchecked: [] };
  const clients = new Map<string, RegistryClient>();
  for (const [id, pkg] of Object.entries(index).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const url = pkg.registry ?? fallbackRegistry;
    let client = clients.get(url);
    if (!client) clients.set(url, (client = new RegistryClient(url, fetchImpl)));
    let advisories: Advisory[];
    try {
      advisories = await client.advisories(id);
    } catch (err) {
      if (err instanceof RegistryError && err.status === 404) continue;
      result.unchecked.push({ id, reason: (err as Error).message });
      continue;
    }
    for (const advisory of advisories) {
      if (advisory.withdrawn || (advisory.pluginId !== undefined && advisory.pluginId !== id)) continue;
      if (satisfies(pkg.version, advisory.affected)) result.matches.push({ id, version: pkg.version, advisory });
    }
  }
  result.matches.sort((a, b) => RANK[b.advisory.severity] - RANK[a.advisory.severity] || (a.id < b.id ? -1 : 1));
  return result;
}

export function formatMatch(m: AdvisoryMatch): string {
  const a = m.advisory;
  const fix = a.fixedIn ? ` Fixed in ${a.fixedIn}: \`citadel-host plugin install ${m.id}@${a.fixedIn}\`.` : ' No fixed version yet; consider removing it.';
  return `${a.severity.toUpperCase()} ${m.id}@${m.version}: ${a.title} (affects ${a.affected}).${fix}${a.url ? ` ${a.url}` : ''}`;
}

/**
 * Logs a warning for every installed package an advisory affects. Meant for host start-up:
 * never throws and never blocks the server on a slow or unreachable registry.
 */
export async function checkAdvisories(serverDir: string, config: HostConfig, logger: Logger): Promise<AdvisoryMatch[]> {
  try {
    const { matches, unchecked } = await auditInstalled(serverDir, config.master.url);
    for (const m of matches) (isSerious(m) ? logger.error : logger.warn)(`Security advisory: ${formatMatch(m)}`);
    if (unchecked.length) logger.debug(`Could not check advisories for ${unchecked.map((u) => u.id).join(', ')}: ${unchecked[0]!.reason}`);
    return matches;
  } catch (err) {
    logger.debug(`Advisory check skipped: ${(err as Error).message}`);
    return [];
  }
}
