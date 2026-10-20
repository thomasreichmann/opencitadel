/**
 * Background A2S verification of listed addresses. A listing that names `connect.address` is
 * probed at most once per PROBE_INTERVAL; when the server answers, the listing is marked
 * verified and the A2S player count and map replace the self-reported ones. Private, loopback
 * and link-local targets are never probed unless explicitly allowed, so the master can't be
 * used to scan its own network.
 */

import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { queryInfo } from '@opencitadel/protocol';
import type { A2sSnapshot, Store } from './store.js';

export const PROBE_INTERVAL_MS = 5 * 60 * 1000;
export const PROBE_TIMEOUT_MS = 1500;

export type A2sQuery = (host: string, port: number, timeoutMs: number) => Promise<A2sSnapshot>;
export type Resolver = (host: string) => Promise<string>;

export const defaultA2sQuery: A2sQuery = async (host, port, timeoutMs) => {
  const info = await queryInfo(host, port, timeoutMs);
  return { players: info.players, maxPlayers: info.maxPlayers, map: info.map };
};

export const defaultResolver: Resolver = async (host) => (isIP(host) ? host : (await lookup(host)).address);

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

const PRIVATE_V4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
];

/** True for addresses that are not publicly routable. */
export function isPrivateIp(ip: string): boolean {
  if (ip.startsWith('::ffff:') && ip.includes('.')) ip = ip.slice(7);
  const v = isIP(ip);
  if (v === 4) {
    const n = ipv4ToInt(ip);
    return PRIVATE_V4.some(([base, bits]) => (n >>> (32 - bits)) === (ipv4ToInt(base) >>> (32 - bits)));
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    return lower === '::' || lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith('ff');
  }
  return true;
}

/** Splits `host:port`; returns undefined for anything else. */
export function splitAddress(address: string): { host: string; port: number } | undefined {
  const i = address.lastIndexOf(':');
  if (i <= 0) return undefined;
  const port = Number(address.slice(i + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return { host: address.slice(0, i), port };
}

export interface VerifierOptions {
  store: Store;
  now: () => number;
  query?: A2sQuery;
  resolve?: Resolver;
  allowPrivate?: boolean;
  log?: (msg: string) => void;
}

export class Verifier {
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(private readonly opts: VerifierOptions) {}

  /**
   * Schedules a probe if the listing's address is due one. Never throws, never blocks the
   * caller; returns the probe promise for tests.
   */
  maybeProbe(serverId: string, address: string | undefined, lastProbe: number | null, lastAddress: string | null): Promise<void> | undefined {
    const { store, now } = this.opts;
    if (!address) {
      if (lastAddress) store.recordProbe(serverId, { verified: false, address: '', resolvedIp: null, a2s: null, at: now() });
      return undefined;
    }
    if (address === lastAddress && lastProbe !== null && now() - lastProbe < PROBE_INTERVAL_MS) return undefined;
    if (this.inflight.has(serverId)) return this.inflight.get(serverId);
    const p = this.probe(serverId, address).finally(() => this.inflight.delete(serverId));
    this.inflight.set(serverId, p);
    return p;
  }

  /** Resolves when no probes are running. */
  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight.values()]);
  }

  private async probe(serverId: string, address: string): Promise<void> {
    const { store, now, query = defaultA2sQuery, resolve = defaultResolver, allowPrivate = false, log } = this.opts;
    const target = splitAddress(address);
    let result: { verified: boolean; resolvedIp: string | null; a2s: A2sSnapshot | null } = { verified: false, resolvedIp: null, a2s: null };
    if (target) {
      try {
        const ip = await resolve(target.host);
        result.resolvedIp = ip;
        if (!allowPrivate && isPrivateIp(ip)) {
          log?.(`not probing ${serverId}: ${address} resolves to non-public ${ip}`);
        } else {
          const a2s = await query(ip, target.port, PROBE_TIMEOUT_MS);
          result = { verified: true, resolvedIp: ip, a2s };
        }
      } catch (err) {
        log?.(`A2S probe of ${serverId} at ${address} failed: ${(err as Error).message}`);
      }
    }
    // The listing may have been deleted while we waited.
    if (store.listing(serverId)) store.recordProbe(serverId, { ...result, address, at: now() });
  }
}
