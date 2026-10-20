/**
 * Server listing wire types: what a host sends in a heartbeat and what the master serves to
 * browsers. Native OpenCitadel endpoints use these camelCase shapes; the master translates to
 * and from Deadworks' snake_case shapes on its `/api/servers/*` compatibility routes.
 */

import { v, parse, type Infer } from './validate.js';
import { CONNECT_TARGET } from './steamid.js';
import { PLUGIN_KINDS } from './manifest.js';
import type { Provenance } from './registry.js';

export const PROTOCOL_VERSION = 1;

/** Coarse regions for filtering. Hosts choose one; it is not inferred from IP. */
export const REGIONS = ['na-east', 'na-west', 'na-central', 'sa', 'eu-west', 'eu-east', 'eu-north', 'ru', 'me', 'af', 'asia-east', 'asia-south', 'asia-se', 'oce'] as const;
export type Region = (typeof REGIONS)[number];

const name = v.string({ min: 1, max: 64 });
const shortText = (max: number) => v.string({ max });
const tag = v.string({ min: 1, max: 24, pattern: /^[a-z0-9][a-z0-9_-]*$/ });
const mapName = v.string({ min: 1, max: 64, pattern: /^[A-Za-z0-9_./-]+$/ });
const count = v.int({ min: 0, max: 255 });

export const connectInfoValidator = v.object({
  /** `[A:1:…]` or `[G:1:…]` — joinable over Steam Datagram Relay without port forwarding. */
  steamId: v.optional(v.string({ max: 40, pattern: /^\[[AG]:1:\d{1,10}(?::\d{1,7})?\]$/ })),
  /** `host:port` — joinable directly when the port is reachable. */
  address: v.optional(v.string({ max: 260, pattern: CONNECT_TARGET })),
});
export type ConnectInfo = Infer<typeof connectInfoValidator>;

export const listingPlayerValidator = v.object({
  name: v.string({ max: 64 }),
  team: v.optional(v.int({ min: 0, max: 16 })),
  hero: v.optional(shortText(48)),
  kills: v.optional(v.int({ min: 0, max: 100000 })),
  deaths: v.optional(v.int({ min: 0, max: 100000 })),
  assists: v.optional(v.int({ min: 0, max: 100000 })),
  level: v.optional(v.int({ min: 0, max: 1000 })),
  /** Seconds connected. */
  time: v.optional(v.int({ min: 0, max: 10 * 365 * 86400 })),
});
export type ListingPlayer = Infer<typeof listingPlayerValidator>;

export const listingPluginValidator = v.object({
  id: v.string({ min: 1, max: 64, pattern: /^[A-Za-z0-9._-]+$/ }),
  name: v.optional(shortText(80)),
  version: v.string({ min: 1, max: 64 }),
  kind: v.withDefault(v.literal([...PLUGIN_KINDS, 'other'] as const), 'other'),
});
export type ListingPlugin = Infer<typeof listingPluginValidator>;

/** A file players must install before joining. Verified by sha256 + size after download. */
export const contentItemValidator = v.object({
  /** File stem: maps install as `citadel/maps/<name>.vpk`. */
  name: v.string({ min: 1, max: 64, pattern: /^[a-z0-9_]+$/ }),
  kind: v.literal(['map', 'addon'] as const),
  sha256: v.string({ pattern: /^[0-9a-f]{64}$/ }),
  size: v.int({ min: 1, max: 4 * 1024 ** 3 }),
  /** Raw `.vpk`, or gzip-compressed if it ends in `.gz`. */
  url: v.string({ max: 1000, pattern: /^https?:\/\/[^\s]+$/ }),
});
export type ContentItem = Infer<typeof contentItemValidator>;

export const heartbeatValidator = v.object({
  name,
  description: v.withDefault(shortText(500), ''),
  map: mapName,
  gameMode: v.optional(shortText(48)),
  players: count,
  maxPlayers: count,
  bots: v.withDefault(count, 0),
  passworded: v.withDefault(v.bool(), false),
  region: v.optional(v.literal(REGIONS)),
  /** ISO 3166-1 alpha-2, chosen by the host. */
  country: v.optional(v.string({ pattern: /^[A-Z]{2}$/ })),
  tags: v.withDefault(v.array(tag, { max: 16 }), []),
  connect: connectInfoValidator,
  playerList: v.withDefault(v.array(listingPlayerValidator, { max: 64 }), []),
  plugins: v.withDefault(v.array(listingPluginValidator, { max: 64 }), []),
  content: v.withDefault(v.array(contentItemValidator, { max: 32 }), []),
  metadata: v.withDefault(v.record(shortText(200), { maxKeys: 32, key: v.string({ min: 1, max: 40, pattern: /^[A-Za-z0-9_.-]+$/ }) }), {}),
  links: v.withDefault(
    v.object({
      website: v.optional(v.string({ max: 300, pattern: /^https:\/\/[^\s]+$/ })),
      discord: v.optional(v.string({ max: 300, pattern: /^https:\/\/[^\s]+$/ })),
    }),
    {},
  ),
  software: v.object({ name: v.string({ min: 1, max: 40 }), version: v.string({ min: 1, max: 40 }) }),
  gameBuild: v.optional(shortText(40)),
});
export type Heartbeat = Infer<typeof heartbeatValidator>;

/** Validates a heartbeat body and checks it names at least one way to connect. */
export function parseHeartbeat(body: unknown): Heartbeat {
  const hb = parse(heartbeatValidator, body);
  if (!hb.connect.steamId && !hb.connect.address) throw new Error('connect: needs a steamId or an address');
  if (hb.players > hb.maxPlayers && hb.maxPlayers > 0) throw new Error('players: exceeds maxPlayers');
  return hb;
}

export type ListingSource = 'opencitadel' | 'deadworks';

/** One row of `GET /v1/servers`. */
export interface ServerSummary {
  id: string;
  name: string;
  map: string;
  gameMode?: string;
  players: number;
  maxPlayers: number;
  bots: number;
  passworded: boolean;
  region?: Region;
  country?: string;
  tags: string[];
  connect: ConnectInfo;
  /** Runs plugins or custom content. */
  modded: boolean;
  /** Players must download content before joining. */
  requiresContent: boolean;
  /** The master reached the server over A2S at its listed address and the answer matched. */
  verified: boolean;
  source: ListingSource;
  software?: { name: string; version: string };
  lastHeartbeat: string;
}

/** `GET /v1/servers/:id`. */
export interface ServerDetail extends ServerSummary {
  description: string;
  playerList: ListingPlayer[];
  plugins: ListingPlugin[];
  content: ContentItem[];
  metadata: Record<string, string>;
  links: { website?: string; discord?: string };
  gameBuild?: string;
  firstSeen: string;
  online: boolean;
  owner?: { name: string };
}

export interface ServerListResponse {
  servers: ServerSummary[];
  total: number;
  limit: number;
  offset: number;
  /** Totals across every online server, ignoring filters. */
  stats: { servers: number; players: number };
}

/** Query parameters accepted by `GET /v1/servers`. */
export interface ServerListQuery {
  q?: string;
  region?: Region;
  map?: string;
  mode?: string;
  /** Comma-separated; every tag must match. */
  tags?: string;
  notFull?: boolean;
  notEmpty?: boolean;
  noPassword?: boolean;
  modded?: boolean;
  verified?: boolean;
  sort?: 'players' | 'name' | 'newest';
  limit?: number;
  offset?: number;
}

export interface HeartbeatResponse {
  ok: true;
  /** Seconds until the listing expires without another heartbeat. */
  ttl: number;
  /** Suggested seconds until the next heartbeat. */
  interval: number;
  verified: boolean;
}

/** Registry: one row of `GET /v1/plugins`. */
export interface PluginSummary {
  id: string;
  name: string;
  kind: (typeof PLUGIN_KINDS)[number];
  description: string;
  latest: string;
  author?: string;
  owner: string;
  tags: string[];
  downloads: number;
  updatedAt: string;
  /** The owner only accepts new versions from the plugin's trusted publishers (CI). */
  requireTrustedPublishing?: boolean;
}

export interface PluginVersionInfo {
  version: string;
  sha256: string;
  size: number;
  publishedAt: string;
  yanked: boolean;
  /** Present when the publisher signed the package (see signing.ts). */
  signature?: { keyId: string; trustedComment: string };
  /** Signed by a different key than the previous signed version, or unsigned after a signed one. */
  keyChanged?: boolean;
  /** Set when the version was published through trusted publishing (see registry.ts). */
  provenance?: Provenance;
}
