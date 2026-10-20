/** Turns stored listings into the public browse shapes, and applies browse filters. */

import { REGIONS, type Region, type ServerDetail, type ServerListQuery, type ServerSummary } from '@opencitadel/protocol';
import { HttpError } from './http.js';
import type { ListingRow } from './store.js';

export const DETAIL_RETENTION_MS = 24 * 60 * 60 * 1000;

export function isOnline(l: ListingRow, now: number): boolean {
  return !l.offline && !l.blocked && !l.owner_disabled && l.last_heartbeat + l.ttl * 1000 > now;
}

/** Verified listings report the A2S player count and map instead of the self-reported ones. */
function effective(l: ListingRow): { players: number; map: string } {
  const hb = l.heartbeat;
  const a2sCurrent = l.verified && l.a2s && l.verified_addr === hb.connect.address;
  return a2sCurrent ? { players: l.a2s!.players, map: l.a2s!.map || hb.map } : { players: hb.players, map: hb.map };
}

export function toSummary(l: ListingRow): ServerSummary {
  const hb = l.heartbeat;
  const { players, map } = effective(l);
  const dwContent = (l.extra?.content_addons.length ?? 0) > 0;
  const verified = l.verified && l.verified_addr === hb.connect.address && !!hb.connect.address;
  const summary: ServerSummary = {
    id: l.server_id,
    name: hb.name,
    map,
    players,
    maxPlayers: Math.max(hb.maxPlayers, players),
    bots: hb.bots,
    passworded: hb.passworded,
    tags: hb.tags,
    connect: hb.connect,
    modded: hb.plugins.length > 0 || hb.content.length > 0 || dwContent || (l.extra?.mods.length ?? 0) > 0,
    requiresContent: hb.content.length > 0 || dwContent,
    verified,
    source: l.source,
    software: hb.software,
    lastHeartbeat: new Date(l.last_heartbeat).toISOString(),
  };
  if (hb.gameMode) summary.gameMode = hb.gameMode;
  if (hb.region) summary.region = hb.region;
  if (hb.country) summary.country = hb.country;
  return summary;
}

export function toDetail(l: ListingRow, now: number): ServerDetail {
  const hb = l.heartbeat;
  const detail: ServerDetail = {
    ...toSummary(l),
    description: hb.description,
    playerList: hb.playerList,
    plugins: hb.plugins,
    content: hb.content,
    metadata: hb.metadata,
    links: hb.links,
    firstSeen: new Date(l.first_seen).toISOString(),
    online: isOnline(l, now),
  };
  if (hb.gameBuild) detail.gameBuild = hb.gameBuild;
  if (l.owner_name) detail.owner = { name: l.owner_name };
  return detail;
}

function bool(v: string | null, name: string): boolean | undefined {
  if (v === null || v === '') return undefined;
  if (v === '1' || v === 'true') return true;
  if (v === '0' || v === 'false') return false;
  throw new HttpError(400, 'invalid_query', `${name} must be 1, 0, true or false`);
}

function int(v: string | null, name: string, min: number, max: number, fallback: number): number {
  if (v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, 'invalid_query', `${name} must be an integer between ${min} and ${max}`);
  return n;
}

export function parseListQuery(params: URLSearchParams): Required<Pick<ServerListQuery, 'limit' | 'offset' | 'sort'>> & ServerListQuery {
  const region = params.get('region') || undefined;
  if (region && !(REGIONS as readonly string[]).includes(region)) throw new HttpError(400, 'invalid_query', `region must be one of: ${REGIONS.join(', ')}`);
  const sort = params.get('sort') || 'players';
  if (!['players', 'name', 'newest'].includes(sort)) throw new HttpError(400, 'invalid_query', 'sort must be players, name or newest');
  const q: ServerListQuery & { limit: number; offset: number; sort: 'players' | 'name' | 'newest' } = {
    limit: int(params.get('limit'), 'limit', 1, 200, 100),
    offset: int(params.get('offset'), 'offset', 0, 1_000_000, 0),
    sort: sort as 'players' | 'name' | 'newest',
  };
  const text = (k: string, max = 100) => {
    const v = params.get(k)?.trim();
    if (v && v.length > max) throw new HttpError(400, 'invalid_query', `${k} is too long`);
    return v || undefined;
  };
  const search = text('q');
  if (search) q.q = search;
  if (region) q.region = region as Region;
  const map = text('map');
  if (map) q.map = map;
  const mode = text('mode');
  if (mode) q.mode = mode;
  const tags = text('tags', 400);
  if (tags) q.tags = tags;
  for (const k of ['notFull', 'notEmpty', 'noPassword', 'modded', 'verified'] as const) {
    const b = bool(params.get(k), k);
    if (b !== undefined) q[k] = b;
  }
  return q;
}

export function filterAndSort(rows: Array<{ summary: ServerSummary; firstSeen: number; description: string }>, q: ServerListQuery & { sort: string }): ServerSummary[] {
  const needle = q.q?.toLowerCase();
  const tags = q.tags?.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean) ?? [];
  const filtered = rows.filter(({ summary: s, description }) => {
    if (needle) {
      const hay = [s.name, s.map, s.gameMode ?? '', description, ...s.tags].join('\n').toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    if (q.region && s.region !== q.region) return false;
    if (q.map && s.map.toLowerCase() !== q.map.toLowerCase()) return false;
    if (q.mode && (s.gameMode ?? '').toLowerCase() !== q.mode.toLowerCase()) return false;
    if (tags.length && !tags.every((t) => s.tags.includes(t))) return false;
    if (q.notFull && s.players >= s.maxPlayers) return false;
    if (q.notEmpty && s.players === 0) return false;
    if (q.noPassword && s.passworded) return false;
    if (q.modded !== undefined && s.modded !== q.modded) return false;
    if (q.verified && !s.verified) return false;
    return true;
  });
  const byName = (a: ServerSummary, b: ServerSummary) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.id.localeCompare(b.id);
  if (q.sort === 'name') filtered.sort((a, b) => byName(a.summary, b.summary));
  else if (q.sort === 'newest') filtered.sort((a, b) => b.firstSeen - a.firstSeen || byName(a.summary, b.summary));
  else filtered.sort((a, b) => b.summary.players - a.summary.players || byName(a.summary, b.summary));
  return filtered.map((r) => r.summary);
}
