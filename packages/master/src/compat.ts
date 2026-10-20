/**
 * Deadworks wire compatibility. Deadworks game servers register and heartbeat with snake_case
 * bodies (managed/ServerBrowser.cs); its launcher reads `{servers:[…]}` lists of the same
 * shape. These helpers translate between that and the native listing model.
 */

import { isIP } from 'node:net';
import { parseHeartbeat, v, type ContentItem, type Heartbeat } from '@opencitadel/protocol';
import { HttpError } from './http.js';
import { isOnline } from './listings.js';
import type { DeadworksExtra, ListingRow } from './store.js';
import { splitAddress } from './verify.js';

export const dwRegisterValidator = v.object({
  name: v.withDefault(v.string({ max: 200 }), ''),
  port: v.int({ min: 1, max: 65535 }),
  max_players: v.withDefault(v.int({ min: 0, max: 255 }), 12),
});

const nonNegative = v.withDefault(v.int({ min: 0, max: 1_000_000 }), 0);

export const dwHeartbeatValidator = v.object({
  name: v.withDefault(v.string({ max: 200 }), ''),
  version: v.withDefault(v.string({ max: 40 }), ''),
  port: v.optional(v.int({ min: 1, max: 65535 })),
  player_count: v.withDefault(v.int({ min: 0, max: 255 }), 0),
  max_players: v.withDefault(v.int({ min: 0, max: 255 }), 0),
  map: v.withDefault(v.string({ max: 64 }), ''),
  game_mode: v.withDefault(v.string({ max: 48 }), ''),
  players: v.withDefault(
    v.array(
      v.object({
        name: v.withDefault(v.string({ max: 64 }), ''),
        hero: v.withDefault(v.string({ max: 48 }), ''),
        team: nonNegative,
        kills: nonNegative,
        deaths: nonNegative,
        assists: nonNegative,
        level: nonNegative,
      }),
      { max: 64 },
    ),
    [],
  ),
  mods: v.withDefault(
    v.array(
      v.object({
        name: v.string({ min: 1, max: 80 }),
        type: v.withDefault(v.string({ max: 32 }), 'plugin'),
        version: v.withDefault(v.string({ max: 40 }), '0.0.0'),
      }),
      { max: 64 },
    ),
    [],
  ),
  content_addons: v.withDefault(v.array(v.string({ max: 64 }), { max: 64 }), []),
  extra_maps: v.withDefault(v.array(v.string({ max: 64 }), { max: 32 }), []),
});

/** Deadworks names its fallback server "Deadworks Server"; trim and cap to the listing limit. */
function cleanName(name: string): string {
  return name.trim().slice(0, 64) || 'Deadworks Server';
}

/**
 * Converts a Deadworks heartbeat into a native one, plus the fields only Deadworks uses.
 * Deadworks always sends player names; unless `keepPlayerNames` is set they are dropped before
 * anything is stored, keeping heroes, teams and stats.
 */
export function fromDeadworksHeartbeat(body: unknown, ip: string, registeredPort: number | null, keepPlayerNames = false): { heartbeat: Heartbeat; extra: DeadworksExtra; port: number } {
  const dw = dwHeartbeatValidator(body, '');
  const port = dw.port ?? registeredPort;
  if (!port) throw new HttpError(400, 'invalid_request', 'port: required');
  if (isIP(ip) !== 4) throw new HttpError(400, 'ipv4_required', 'Deadworks servers must heartbeat over IPv4');
  const maxPlayers = Math.max(dw.max_players, dw.player_count);
  const map = /^[A-Za-z0-9_./-]+$/.test(dw.map) ? dw.map : 'unknown';
  const gameMode = dw.game_mode && dw.game_mode !== 'Invalid' ? dw.game_mode : undefined;
  let heartbeat: Heartbeat;
  try {
    heartbeat = parseHeartbeat({
      name: cleanName(dw.name),
      map,
      gameMode,
      players: dw.player_count,
      maxPlayers,
      connect: { address: `${ip}:${port}` },
      playerList: dw.players.map((p) => ({ name: keepPlayerNames ? p.name : '', hero: p.hero || undefined, team: Math.min(p.team, 16), kills: p.kills, deaths: p.deaths, assists: p.assists, level: Math.min(p.level, 1000) })),
      plugins: dw.mods.map((m) => ({ id: m.name.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64) || 'plugin', name: m.name, version: m.version || '0.0.0', kind: 'deadworks' })),
      software: { name: 'deadworks', version: dw.version || 'unknown' },
    });
  } catch (err) {
    throw new HttpError(400, 'invalid_heartbeat', (err as Error).message);
  }
  return { heartbeat, extra: { mods: dw.mods, content_addons: dw.content_addons, extra_maps: dw.extra_maps }, port };
}

/** A stable numeric "version" Deadworks' launcher can compare, derived from the file hash. */
function hashVersion(sha256: string): number {
  return parseInt(sha256.slice(0, 12), 16);
}

export function dwContentItems(content: ContentItem[]): Array<{ filename: string; kind: string; version: number; download_url: string; sha256: string; size: number }> {
  return content.map((c) => ({ filename: c.name, kind: c.kind, version: hashVersion(c.sha256), download_url: c.url, sha256: c.sha256, size: c.size }));
}

/**
 * The dotted-quad `ip:port` Deadworks clients connect to, or undefined when the listing has none
 * (SDR-only servers can't be joined from Deadworks' browser).
 */
export function rawAddress(l: ListingRow): string | undefined {
  const address = l.heartbeat.connect.address;
  if (!address) return undefined;
  const target = splitAddress(address);
  if (!target) return undefined;
  if (isIP(target.host) === 4) return address;
  if (l.resolved_ip && isIP(l.resolved_ip) === 4 && l.verified_addr === address) return `${l.resolved_ip}:${target.port}`;
  return undefined;
}

export interface DwServer {
  id: string;
  registered: true;
  name: string;
  address: string;
  raw_address: string;
  country: string;
  online: boolean;
  player_count: number;
  max_players: number;
  map: string;
  players: Array<{ name: string; hero: string; team: number; kills: number; deaths: number; assists: number; level: number }>;
  mods: Array<{ name: string; type: string; version: string }>;
  content_addons: string[];
  extra_maps: string[];
  content: ReturnType<typeof dwContentItems>;
  last_heartbeat: string | null;
}

export function toDwServer(l: ListingRow, players: number, map: string, now: number): DwServer | undefined {
  const raw = rawAddress(l);
  if (!raw) return undefined;
  const hb = l.heartbeat;
  return {
    id: l.server_id,
    registered: true,
    name: hb.name,
    address: hb.connect.address!,
    raw_address: raw,
    country: hb.country ?? '',
    online: isOnline(l, now),
    player_count: players,
    max_players: Math.max(hb.maxPlayers, players),
    map,
    players: hb.playerList.map((p) => ({ name: p.name, hero: p.hero ?? '', team: p.team ?? 0, kills: p.kills ?? 0, deaths: p.deaths ?? 0, assists: p.assists ?? 0, level: p.level ?? 0 })),
    mods: l.extra?.mods ?? hb.plugins.map((p) => ({ name: p.name ?? p.id, type: 'plugin', version: p.version })),
    content_addons: l.extra?.content_addons ?? hb.content.filter((c) => c.kind === 'addon').map((c) => c.name),
    extra_maps: l.extra?.extra_maps ?? hb.content.filter((c) => c.kind === 'map').map((c) => c.name),
    content: dwContentItems(hb.content),
    last_heartbeat: new Date(l.last_heartbeat).toISOString(),
  };
}
