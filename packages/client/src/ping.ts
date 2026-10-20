/** Client-side ping over A2S_INFO for servers that publish a direct address. */

import { queryInfo, type ConnectInfo } from '@opencitadel/protocol';

export type PingFn = (host: string, port: number, timeoutMs: number) => Promise<number>;

const a2sPing: PingFn = async (host, port, timeoutMs) => (await queryInfo(host, port, timeoutMs)).pingMs;

/** Splits `host:port`; undefined for anything else (SteamID-only servers can't be pinged). */
export function splitAddress(address: string | undefined): { host: string; port: number } | undefined {
  const m = address ? /^([A-Za-z0-9.-]+):(\d{1,5})$/.exec(address) : null;
  if (!m) return undefined;
  const port = Number(m[2]);
  return port > 0 && port < 65536 ? { host: m[1]!, port } : undefined;
}

/** Runs `fn` over `items` with at most `limit` in flight. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Pings every server with an address. Result: id → round-trip ms, or null when the server has no
 * address or didn't answer.
 */
export async function pingServers(
  servers: Array<{ id: string; connect: ConnectInfo }>,
  opts: { concurrency?: number; timeoutMs?: number; ping?: PingFn } = {},
): Promise<Record<string, number | null>> {
  const { concurrency = 16, timeoutMs = 1500, ping = a2sPing } = opts;
  const results = await mapLimit(servers, concurrency, async (s) => {
    const addr = splitAddress(s.connect.address);
    if (!addr) return null;
    try {
      return await ping(addr.host, addr.port, timeoutMs);
    } catch {
      return null;
    }
  });
  return Object.fromEntries(servers.map((s, i) => [s.id, results[i] ?? null]));
}
