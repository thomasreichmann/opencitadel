/**
 * The master server: wires the store, registry, verifier and rate limiter into one HTTP
 * service. Route table and semantics are documented in docs/ARCHITECTURE.md ("Master server").
 */

import { createReadStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { isIP, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import {
  ACCOUNT_KEY_PREFIX,
  DEADWORKS_HEARTBEAT_TTL,
  HEARTBEAT_INTERVAL,
  HEARTBEAT_TTL,
  PLUGIN_ID,
  PLUGIN_KINDS,
  PUBLISH_TOKEN_PREFIX,
  advisoryInputValidator,
  compareVersions,
  createZstdStoredStream,
  isValidVersion,
  parse,
  parseHeartbeat,
  parsePublicKey,
  reportInputValidator,
  satisfies,
  signingKeyInputValidator,
  trustedPublisherInputValidator,
  v,
  type HeartbeatResponse,
  type OidcExchangeResponse,
  type Provenance,
  type PublisherInfo,
  type RegistryInfo,
  type ServerListResponse,
} from '@opencitadel/protocol';
import { dwRegisterValidator, fromDeadworksHeartbeat, rawAddress, toDwServer, dwContentItems } from './compat.js';
import { HttpError, Router, bearer, clientIp, readBody, readJson, sendEmpty, sendError, sendJson, type RequestContext } from './http.js';
import { DETAIL_RETENTION_MS, filterAndSort, isOnline, parseListQuery, toDetail, toSummary } from './listings.js';
import { DEFAULT_RATE_LIMITS, RateLimiter, type BucketSpec, type RateClass } from './ratelimit.js';
import { MAX_PACKAGE_BYTES, Registry, contentTypeFor, latestVersion, pluginSummary, resolveVersion, versionInfo } from './registry.js';
import { GITHUB_ISSUER, JwtVerifier, OidcError, githubClaims, mismatch, provenanceOf, type GithubClaims } from './oidc.js';
import { hashSecret, newAccountKey, newId, newPublishToken, newServerToken, secretMatches } from './secrets.js';
import { StaticSite, defaultWebDir } from './static.js';
import { Store, type AccountRow, type ListingRow, type PluginRow, type PublishScope, type ServerRow, type TrustedPublisherRow } from './store.js';
import { MAX_ACTIVE_SIGNING_KEYS, MAX_TRUSTED_PUBLISHERS, advisoryView, decodeSignatureHeader, reportView, signingKeyView, trustedPublisherView } from './trust.js';
import { Verifier, type A2sQuery, type Resolver } from './verify.js';
import { MASTER_VERSION } from './version.js';

export const JSON_LIMIT = 64 * 1024;
export const MAX_SERVERS_PER_ACCOUNT = 100;
/** How long a publish token from trusted publishing stays valid. */
export const PUBLISH_TOKEN_TTL_MS = 15 * 60 * 1000;
const LISTING_PURGE_MS = 7 * 24 * 60 * 60 * 1000;
/** zstd stored-frame block size (see protocol/src/zstd.ts); used to precompute Content-Length. */
const ZSTD_BLOCK = 128 * 1024;
const FASTDL_FILE = /^([a-z0-9_]+)_([0-9a-f]{16})\.vpk\.zst$/;

export type LogFn = (level: 'info' | 'warn' | 'error', message: string) => void;

export const defaultLog: LogFn = (level, message) => {
  const line = `${new Date().toISOString()} ${level.toUpperCase()} [master] ${message}`;
  (level === 'info' ? console.log : console.error)(line);
};

export interface MasterOptions {
  dataDir: string;
  now?: () => number;
  /** Enables /v1/admin/* when set. */
  adminToken?: string;
  registration?: 'open' | 'closed';
  trustProxy?: boolean;
  deadworksCompat?: boolean;
  /** Probe (and verify) private/loopback addresses. For LAN masters and tests. */
  allowPrivate?: boolean;
  /** Base URL used for absolute links in API responses. */
  publicUrl?: string;
  a2sQuery?: A2sQuery;
  resolve?: Resolver;
  rateLimits?: Partial<Record<RateClass, BucketSpec>>;
  webDir?: string;
  log?: LogFn;
  /** Shown in `GET /v1/registry`. */
  name?: string;
  /** Where takedown and security reports go; published in `GET /v1/registry` and on the web UI. */
  abuseContact?: string;
  /** Reject unsigned packages. */
  requireSignatures?: boolean;
  /** Keep the player names Deadworks heartbeats carry (off by default). */
  deadworksPlayerNames?: boolean;
  /** Trusted publishing: the GitHub Actions OIDC issuer (default token.actions.githubusercontent.com). */
  oidcIssuer?: string;
  /** Where the issuer's signing keys are (default `<issuer>/.well-known/jwks`). */
  oidcJwksUrl?: string;
  /** The audience CI must request tokens for (default: the public URL, else `opencitadel`). */
  oidcAudience?: string;
  /** For tests: how the JWKS is fetched. */
  oidcFetch?: typeof fetch;
}

export interface Master {
  server: Server;
  store: Store;
  registry: Registry;
  verifier: Verifier;
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

const accountName = v.string({ min: 3, max: 32, pattern: /^[A-Za-z0-9][A-Za-z0-9_.-]*$/ });
const serverName = v.string({ min: 1, max: 64 });

function ownedServer(s: ServerRow, listing: ListingRow | undefined, now: number) {
  const out: { id: string; name: string; createdAt: string; online: boolean; lastHeartbeat?: string } = {
    id: s.id,
    name: s.name,
    createdAt: new Date(s.created_at).toISOString(),
    online: !!listing && isOnline(listing, now),
  };
  if (listing) out.lastHeartbeat = new Date(listing.last_heartbeat).toISOString();
  return out;
}

function accountView(a: AccountRow) {
  return { id: a.id, name: a.name, createdAt: new Date(a.created_at).toISOString() };
}

function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function createMaster(opts: MasterOptions): Promise<Master> {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? defaultLog;
  const registrationOpen = (opts.registration ?? 'open') === 'open';
  const compat = opts.deadworksCompat ?? true;
  await mkdir(opts.dataDir, { recursive: true });
  const store = new Store(join(opts.dataDir, 'master.db'));
  const registry = new Registry(store, opts.dataDir, now, { requireSignatures: opts.requireSignatures ?? false });
  const verifierOpts: ConstructorParameters<typeof Verifier>[0] = { store, now, allowPrivate: opts.allowPrivate ?? false, log: (m) => log('info', m) };
  if (opts.a2sQuery) verifierOpts.query = opts.a2sQuery;
  if (opts.resolve) verifierOpts.resolve = opts.resolve;
  const verifier = new Verifier(verifierOpts);
  const limiter = new RateLimiter({ ...DEFAULT_RATE_LIMITS, ...opts.rateLimits }, now);
  const site = new StaticSite(opts.webDir ?? defaultWebDir());
  const base = opts.publicUrl?.replace(/\/+$/, '') ?? '';
  const issuer = (opts.oidcIssuer ?? GITHUB_ISSUER).replace(/\/+$/, '');
  const oidc = new JwtVerifier({
    issuer,
    jwksUrl: opts.oidcJwksUrl ?? `${issuer}/.well-known/jwks`,
    audience: opts.oidcAudience || base || 'opencitadel',
    now,
    ...(opts.oidcFetch ? { fetch: opts.oidcFetch } : {}),
  });
  const router = new Router();

  // ---- auth helpers ----

  const requireAccount = (ctx: RequestContext): AccountRow => {
    const key = bearer(ctx.req);
    if (!key || !key.startsWith(ACCOUNT_KEY_PREFIX)) throw new HttpError(401, 'unauthorized', 'An account API key is required (Authorization: Bearer ock_…)');
    const account = store.accountByKeyHash(hashSecret(key));
    if (!account) throw new HttpError(401, 'unauthorized', 'Unknown API key');
    if (account.disabled) throw new HttpError(403, 'account_disabled', 'This account is disabled');
    return account;
  };

  const isAdmin = (ctx: RequestContext): boolean => {
    const token = bearer(ctx.req);
    return !!opts.adminToken && !!token && constantTimeEqual(token, opts.adminToken);
  };

  const requireAdmin = (ctx: RequestContext): void => {
    if (!opts.adminToken) throw new HttpError(404, 'not_found', 'Not found');
    if (!isAdmin(ctx)) throw new HttpError(401, 'unauthorized', 'Admin token required');
  };

  const requireServerToken = (ctx: RequestContext, id: string): ServerRow => {
    const server = store.server(id);
    if (!server) throw new HttpError(404, 'not_found', `No server "${id}"`);
    const token = bearer(ctx.req);
    if (!token || !secretMatches(token, server.token_hash)) throw new HttpError(401, 'unauthorized', 'Invalid server token');
    if (server.blocked) throw new HttpError(403, 'server_blocked', 'This server has been delisted by an administrator');
    if (server.owner_id) {
      const owner = store.accountByIdOrName(server.owner_id);
      if (owner?.disabled) throw new HttpError(403, 'account_disabled', "This server's account is disabled");
    }
    return server;
  };

  /** The plugin, when the caller is its owner or an admin. Non-owners get a 404 like other owner routes. */
  const requireOwnerOrAdmin = (ctx: RequestContext, pluginId: string): { plugin: PluginRow; actor: string } => {
    const plugin = store.plugin(pluginId);
    if (isAdmin(ctx)) {
      if (!plugin) throw new HttpError(404, 'not_found', `No plugin "${pluginId}"`);
      return { plugin, actor: 'admin' };
    }
    const account = requireAccount(ctx);
    if (!plugin || plugin.owner_id !== account.id) throw new HttpError(404, 'not_found', `No plugin "${pluginId}" on this account`);
    return { plugin, actor: account.name };
  };

  /**
   * The account in control of a plugin id: its owner, or the holder of an unpublished id's
   * reservation. With `reserve`, an id nobody holds is reserved for the caller.
   */
  const requireControl = (pluginId: string, account: AccountRow, reserve = false): void => {
    if (!PLUGIN_ID.test(pluginId)) throw new HttpError(400, 'invalid_id', 'Plugin ids are 3-48 lowercase letters, digits and dashes');
    const plugin = store.plugin(pluginId);
    const holder = plugin ? plugin.owner_id : store.reservation(pluginId)?.account_id;
    if (holder === account.id) return;
    if (holder || !reserve) throw new HttpError(404, 'not_found', `No plugin "${pluginId}" on this account`);
    store.reserve(pluginId, account.id, now());
    log('info', `plugin id ${pluginId} reserved by ${account.name} for trusted publishing`);
  };

  const requireOwnedServer = (ctx: RequestContext): ServerRow => {
    const account = requireAccount(ctx);
    const server = store.server(ctx.params.id!);
    if (!server || server.owner_id !== account.id) throw new HttpError(404, 'not_found', `No server "${ctx.params.id}" on this account`);
    return server;
  };

  /** A listing still worth showing on a detail page (online, or offline for < 24 h). */
  const visibleListing = (id: string): ListingRow => {
    const l = store.listing(id);
    if (!l || l.blocked || l.owner_disabled || now() - l.last_heartbeat > DETAIL_RETENTION_MS) throw new HttpError(404, 'not_found', `No server "${id}"`);
    return l;
  };

  const onlineListings = (): ListingRow[] => {
    const t = now();
    return store.candidateListings(t).filter((l) => isOnline(l, t));
  };

  // ---- health & stats ----

  router.get('/healthz', (ctx) => sendJson(ctx.res, 200, { ok: true }));

  router.get('/v1/stats', (ctx) => {
    const online = onlineListings().map(toSummary);
    sendJson(ctx.res, 200, { servers: online.length, players: online.reduce((n, s) => n + s.players, 0), plugins: registry.list({}).length });
  });

  // ---- accounts ----

  router.post('/v1/accounts', async (ctx) => {
    if (!registrationOpen) throw new HttpError(403, 'registration_closed', 'Account registration is closed on this master');
    const body = parse(v.object({ name: accountName }), await readJson(ctx.req, JSON_LIMIT));
    if (store.accountNameTaken(body.name)) throw new HttpError(409, 'name_taken', `The name "${body.name}" is taken`);
    const apiKey = newAccountKey();
    const account = store.createAccount(newId(), body.name, hashSecret(apiKey), now());
    log('info', `account created: ${account.name} (${account.id}) from ${ctx.ip}`);
    sendJson(ctx.res, 201, { account: accountView(account), apiKey });
  });

  router.get('/v1/accounts/me', (ctx) => {
    const account = requireAccount(ctx);
    const t = now();
    const servers = store.serversByOwner(account.id).map((s) => ownedServer(s, store.listing(s.id), t));
    sendJson(ctx.res, 200, { account: accountView(account), servers });
  });

  router.post('/v1/accounts/me/rotate-key', (ctx) => {
    const account = requireAccount(ctx);
    const apiKey = newAccountKey();
    store.setAccountKey(account.id, hashSecret(apiKey));
    sendJson(ctx.res, 200, { apiKey });
  });

  // ---- signing keys & publishers ----

  router.get('/v1/registry', (ctx) => {
    const info: RegistryInfo = { requireSignatures: registry.requireSignatures, version: MASTER_VERSION, oidc: { github: { audience: oidc.config.audience } } };
    if (opts.name) info.name = opts.name;
    if (base) info.publicUrl = base;
    if (opts.abuseContact) info.abuseContact = opts.abuseContact;
    sendJson(ctx.res, 200, info);
  });

  // ---- trusted publishing ----

  router.post('/v1/oidc/github', async (ctx) => {
    const body = parse(v.object({ token: v.string({ min: 10, max: 16 * 1024 }) }), await readJson(ctx.req, JSON_LIMIT));
    let claims: GithubClaims;
    try {
      claims = githubClaims(await oidc.verify(body.token));
    } catch (err) {
      if (err instanceof OidcError) throw new HttpError(401, 'invalid_token', `OIDC token rejected: ${err.message}`);
      throw err;
    }
    const candidates = store.trustedPublishersForRepository(claims.repository);
    if (!candidates.length) throw new HttpError(401, 'no_trusted_publisher', `No trusted publisher is configured for the repository ${claims.repository}`);
    const matched: TrustedPublisherRow[] = [];
    const reasons: string[] = [];
    for (const tp of candidates) {
      const account = store.accountByIdOrName(tp.account_id);
      if (!account || account.disabled) {
        reasons.push(`${tp.plugin_id}: the owning account is disabled`);
        continue;
      }
      const plugin = store.plugin(tp.plugin_id);
      if (plugin && plugin.owner_id !== tp.account_id) continue; // left over from a previous owner
      const why = mismatch(
        { repository: tp.repository, workflow: tp.workflow, environment: tp.environment ?? undefined, ref: tp.ref ?? undefined, repositoryId: tp.repository_id ?? undefined },
        claims,
      );
      if (why) reasons.push(`${tp.plugin_id}: ${why}`);
      else matched.push(tp);
    }
    if (!matched.length) throw new HttpError(401, 'no_matching_publisher', `No trusted publisher accepts this workflow run (${reasons.join('; ') || 'none configured'})`);
    for (const tp of matched) if (!tp.repository_id) store.pinRepositoryId(tp.id, claims.repository_id);
    const scope: PublishScope[] = [];
    for (const tp of matched) if (!scope.some((s) => s.plugin === tp.plugin_id)) scope.push({ plugin: tp.plugin_id, account: tp.account_id });
    const token = newPublishToken();
    const expiresAt = now() + PUBLISH_TOKEN_TTL_MS;
    store.insertPublishToken({ token_hash: hashSecret(token), scope, claims: { ...claims }, created_at: now(), expires_at: expiresAt });
    log('info', `publish token for ${scope.map((s) => s.plugin).join(', ')} issued to ${claims.repository} run ${claims.run_id} (${claims.ref})`);
    const response: OidcExchangeResponse = { token, expiresAt: new Date(expiresAt).toISOString(), plugins: scope.map((s) => s.plugin) };
    sendJson(ctx.res, 200, response);
  });

  router.post('/v1/accounts/me/signing-keys', async (ctx) => {
    const account = requireAccount(ctx);
    const body = parse(signingKeyInputValidator, await readJson(ctx.req, JSON_LIMIT));
    let key: ReturnType<typeof parsePublicKey>;
    try {
      key = parsePublicKey(body.publicKey);
    } catch (err) {
      throw new HttpError(400, 'invalid_key', (err as Error).message);
    }
    const taken = () => {
      const existing = store.signingKey(key.keyId);
      if (!existing) return undefined;
      if (existing.account_id !== account.id) return new HttpError(409, 'key_taken', `Key ${key.keyId} is registered to another account`);
      return new HttpError(409, 'key_exists', existing.revoked_at === null ? `Key ${key.keyId} is already registered` : `Key ${key.keyId} was revoked and can't be added again`);
    };
    const conflict = taken();
    if (conflict) throw conflict;
    if (store.signingKeys(account.id).filter((k) => k.revoked_at === null).length >= MAX_ACTIVE_SIGNING_KEYS) {
      throw new HttpError(409, 'key_limit', `Accounts can have at most ${MAX_ACTIVE_SIGNING_KEYS} active signing keys; revoke one first`);
    }
    try {
      store.addSigningKey({ key_id: key.keyId, account_id: account.id, public_key: key.publicKey, label: body.label ?? null, added_at: now() });
    } catch (err) {
      throw taken() ?? err; // lost a race with another registration of the same key
    }
    log('info', `signing key ${key.keyId} added by ${account.name}`);
    sendJson(ctx.res, 201, { key: signingKeyView(store.signingKey(key.keyId)!) });
  });

  router.get('/v1/accounts/me/signing-keys', (ctx) => {
    const account = requireAccount(ctx);
    sendJson(ctx.res, 200, { keys: store.signingKeys(account.id).map(signingKeyView) });
  });

  router.delete('/v1/accounts/me/signing-keys/:keyId', (ctx) => {
    const account = requireAccount(ctx);
    const keyId = ctx.params.keyId!.toUpperCase();
    const key = store.signingKey(keyId);
    if (!key || key.account_id !== account.id) throw new HttpError(404, 'not_found', `No signing key ${keyId} on this account`);
    if (key.revoked_at === null) {
      store.revokeSigningKey(keyId, now());
      log('warn', `signing key ${keyId} revoked by ${account.name}`);
    }
    sendEmpty(ctx.res);
  });

  router.get('/v1/publishers/:name', (ctx) => {
    const name = ctx.params.name!;
    const account = store.accountByIdOrName(name);
    if (!account || account.name.toLowerCase() !== name.toLowerCase()) throw new HttpError(404, 'not_found', `No publisher "${name}"`);
    const info: PublisherInfo = { name: account.name, signingKeys: store.signingKeys(account.id).map(signingKeyView), plugins: store.pluginsByOwner(account.id) };
    sendJson(ctx.res, 200, info);
  });

  // ---- servers (owner side) ----

  router.post('/v1/servers', async (ctx) => {
    const account = requireAccount(ctx);
    const body = parse(v.object({ name: serverName }), await readJson(ctx.req, JSON_LIMIT));
    if (store.countServersByOwner(account.id) >= MAX_SERVERS_PER_ACCOUNT) throw new HttpError(403, 'server_limit', `Accounts can register at most ${MAX_SERVERS_PER_ACCOUNT} servers`);
    const token = newServerToken();
    const server = store.createServer({ id: newId(), owner_id: account.id, name: body.name, token_hash: hashSecret(token), source: 'opencitadel', created_at: now(), ip: null, port: null });
    log('info', `server registered: ${server.id} "${server.name}" by ${account.name}`);
    sendJson(ctx.res, 201, { server: ownedServer(server, undefined, now()), token });
  });

  router.delete('/v1/servers/:id', (ctx) => {
    const server = requireOwnedServer(ctx);
    store.deleteServer(server.id);
    sendEmpty(ctx.res);
  });

  router.post('/v1/servers/:id/rotate-token', (ctx) => {
    const server = requireOwnedServer(ctx);
    const token = newServerToken();
    store.setServerToken(server.id, hashSecret(token));
    sendJson(ctx.res, 200, { token });
  });

  router.post('/v1/servers/:id/heartbeat', async (ctx) => {
    const server = requireServerToken(ctx, ctx.params.id!);
    const body = await readJson(ctx.req, JSON_LIMIT);
    let heartbeat;
    try {
      heartbeat = parseHeartbeat(body);
    } catch (err) {
      throw new HttpError(400, 'invalid_heartbeat', (err as Error).message);
    }
    const prev = store.listing(server.id);
    store.updateServerSeen(server.id, heartbeat.name, ctx.ip, null);
    store.upsertListing({ serverId: server.id, heartbeat, extra: null, now: now(), ttl: HEARTBEAT_TTL, ip: ctx.ip });
    void verifier.maybeProbe(server.id, heartbeat.connect.address, prev?.last_probe ?? null, prev?.verified_addr ?? null);
    const current = store.listing(server.id)!;
    const response: HeartbeatResponse = {
      ok: true,
      ttl: HEARTBEAT_TTL,
      interval: HEARTBEAT_INTERVAL,
      verified: current.verified && !!heartbeat.connect.address && current.verified_addr === heartbeat.connect.address,
    };
    sendJson(ctx.res, 200, response);
  });

  router.post('/v1/servers/:id/offline', (ctx) => {
    const server = requireServerToken(ctx, ctx.params.id!);
    store.setListingOffline(server.id);
    sendEmpty(ctx.res);
  });

  // ---- browsing ----

  router.get('/v1/servers', (ctx) => {
    const q = parseListQuery(ctx.url.searchParams);
    const rows = onlineListings().map((l) => ({ summary: toSummary(l), firstSeen: l.first_seen, description: l.heartbeat.description }));
    const matched = filterAndSort(rows, q);
    const body: ServerListResponse = {
      servers: matched.slice(q.offset, q.offset + q.limit),
      total: matched.length,
      limit: q.limit,
      offset: q.offset,
      stats: { servers: rows.length, players: rows.reduce((n, r) => n + r.summary.players, 0) },
    };
    sendJson(ctx.res, 200, body);
  });

  router.get('/v1/servers/:id', (ctx) => {
    sendJson(ctx.res, 200, toDetail(visibleListing(ctx.params.id!), now()));
  });

  // ---- plugin registry ----

  router.get('/v1/plugins', (ctx) => {
    const p = ctx.url.searchParams;
    const kind = p.get('kind') || undefined;
    if (kind && !(PLUGIN_KINDS as readonly string[]).includes(kind)) throw new HttpError(400, 'invalid_query', `kind must be one of: ${PLUGIN_KINDS.join(', ')}`);
    const limit = Number(p.get('limit') ?? 100);
    const offset = Number(p.get('offset') ?? 0);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new HttpError(400, 'invalid_query', 'limit must be an integer between 1 and 200');
    if (!Number.isInteger(offset) || offset < 0) throw new HttpError(400, 'invalid_query', 'offset must be a non-negative integer');
    const query: { q?: string; kind?: string; tag?: string } = {};
    const text = p.get('q')?.trim().slice(0, 100);
    if (text) query.q = text;
    if (kind) query.kind = kind;
    const tag = p.get('tag')?.trim().slice(0, 32);
    if (tag) query.tag = tag;
    const all = registry.list(query);
    sendJson(ctx.res, 200, { plugins: all.slice(offset, offset + limit), total: all.length });
  });

  router.get('/v1/plugins/:id', (ctx) => {
    const plugin = store.plugin(ctx.params.id!);
    if (!plugin) throw new HttpError(404, 'not_found', `No plugin "${ctx.params.id}"`);
    const versions = store.versions(plugin.id);
    const sorted = [...versions].sort((a, b) => -compare(a.version, b.version));
    const latest = latestVersion(versions) ?? sorted[0]!;
    sendJson(ctx.res, 200, { plugin: pluginSummary(plugin, latest), manifest: JSON.parse(latest.manifest), versions: sorted.map(versionInfo) });
  });

  // Registered before /v1/plugins/:id/:version, which would otherwise claim "advisories",
  // "trusted-publishers" and "settings" as versions.

  router.get('/v1/plugins/:id/trusted-publishers', (ctx) => {
    const account = requireAccount(ctx);
    requireControl(ctx.params.id!, account);
    sendJson(ctx.res, 200, { publishers: store.trustedPublishers(ctx.params.id!).map(trustedPublisherView) });
  });

  router.post('/v1/plugins/:id/trusted-publishers', async (ctx) => {
    const account = requireAccount(ctx);
    const id = ctx.params.id!;
    const body = parse(trustedPublisherInputValidator, await readJson(ctx.req, JSON_LIMIT));
    requireControl(id, account, true);
    const existing = store.trustedPublishers(id);
    if (existing.length >= MAX_TRUSTED_PUBLISHERS) throw new HttpError(409, 'publisher_limit', `A plugin can have at most ${MAX_TRUSTED_PUBLISHERS} trusted publishers`);
    const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? '').toLowerCase() === (b ?? '').toLowerCase();
    if (existing.some((tp) => same(tp.repository, body.repository) && tp.workflow === body.workflow && same(tp.environment, body.environment) && (tp.ref ?? '') === (body.ref ?? ''))) {
      throw new HttpError(409, 'publisher_exists', 'That trusted publisher is already configured');
    }
    const tpId = newId();
    store.insertTrustedPublisher({
      id: tpId,
      plugin_id: id,
      account_id: account.id,
      provider: body.provider,
      repository: body.repository,
      workflow: body.workflow,
      environment: body.environment ?? null,
      ref: body.ref ?? null,
      repository_id: null,
      added_at: now(),
    });
    log('info', `trusted publisher ${tpId} (${body.repository} ${body.workflow}${body.environment ? ` env ${body.environment}` : ''}) added to ${id} by ${account.name}`);
    sendJson(ctx.res, 201, { publisher: trustedPublisherView(store.trustedPublisher(tpId)!) });
  });

  router.delete('/v1/plugins/:id/trusted-publishers/:tpId', (ctx) => {
    const account = requireAccount(ctx);
    const id = ctx.params.id!;
    requireControl(id, account);
    const tp = store.trustedPublisher(ctx.params.tpId!);
    if (!tp || tp.plugin_id !== id) throw new HttpError(404, 'not_found', `No trusted publisher "${ctx.params.tpId}" on ${id}`);
    store.deleteTrustedPublisher(tp.id);
    log('info', `trusted publisher ${tp.id} removed from ${id} by ${account.name}`);
    sendEmpty(ctx.res);
  });

  router.put('/v1/plugins/:id/settings', async (ctx) => {
    const account = requireAccount(ctx);
    const id = ctx.params.id!;
    const body = parse(v.object({ requireTrustedPublishing: v.bool() }), await readJson(ctx.req, JSON_LIMIT));
    requireControl(id, account, true);
    store.setRequireTrustedPublishing(id, body.requireTrustedPublishing);
    log('info', `${id}: trusted publishing ${body.requireTrustedPublishing ? 'required' : 'optional'} (set by ${account.name})`);
    sendJson(ctx.res, 200, { settings: { requireTrustedPublishing: store.requireTrustedPublishing(id) } });
  });

  router.get('/v1/plugins/:id/advisories', (ctx) => {
    const plugin = store.plugin(ctx.params.id!);
    if (!plugin) throw new HttpError(404, 'not_found', `No plugin "${ctx.params.id}"`);
    sendJson(ctx.res, 200, { advisories: store.advisoriesForPlugin(plugin.id).map(advisoryView) });
  });

  router.post('/v1/plugins/:id/advisories', async (ctx) => {
    const { plugin, actor } = requireOwnerOrAdmin(ctx, ctx.params.id!);
    const body = parse(advisoryInputValidator, await readJson(ctx.req, JSON_LIMIT));
    if (body.fixedIn && satisfies(body.fixedIn, body.affected)) throw new HttpError(400, 'invalid_request', `fixedIn ${body.fixedIn} falls inside the affected range "${body.affected}"`);
    const t = now();
    const id = newId();
    store.insertAdvisory({
      id,
      plugin_id: plugin.id,
      severity: body.severity,
      title: body.title,
      description: body.description,
      affected: body.affected,
      fixed_in: body.fixedIn ?? null,
      url: body.url ?? null,
      published_at: t,
      updated_at: t,
    });
    log('warn', `advisory ${id} (${body.severity}) for ${plugin.id} ${body.affected} published by ${actor}`);
    sendJson(ctx.res, 201, { advisory: advisoryView(store.advisory(id)!) });
  });

  router.get('/v1/advisories', (ctx) => {
    const sinceParam = ctx.url.searchParams.get('since');
    let since = 0;
    if (sinceParam) {
      since = Date.parse(sinceParam);
      if (Number.isNaN(since)) throw new HttpError(400, 'invalid_query', 'since must be an ISO 8601 timestamp');
    }
    sendJson(ctx.res, 200, { advisories: store.advisoriesChangedSince(since, 500).map(advisoryView), asOf: new Date(now()).toISOString() });
  });

  router.post('/v1/advisories/:id/withdraw', (ctx) => {
    const advisory = store.advisory(ctx.params.id!);
    if (!advisory) throw new HttpError(404, 'not_found', `No advisory "${ctx.params.id}"`);
    const { actor } = requireOwnerOrAdmin(ctx, advisory.plugin_id);
    if (!advisory.withdrawn) {
      store.withdrawAdvisory(advisory.id, now());
      log('info', `advisory ${advisory.id} withdrawn by ${actor}`);
    }
    sendJson(ctx.res, 200, { advisory: advisoryView(store.advisory(advisory.id)!) });
  });

  router.post('/v1/plugins/:id/reports', async (ctx) => {
    const plugin = store.plugin(ctx.params.id!);
    if (!plugin) throw new HttpError(404, 'not_found', `No plugin "${ctx.params.id}"`);
    const body = parse(reportInputValidator, await readJson(ctx.req, JSON_LIMIT));
    if (body.version && !store.versions(plugin.id).some((x) => compare(x.version, body.version!) === 0)) {
      throw new HttpError(400, 'invalid_version', `${plugin.id} has no version ${body.version}`);
    }
    const id = newId();
    store.insertReport({ id, plugin_id: plugin.id, version: body.version ?? null, reason: body.reason, details: body.details, contact: body.contact ?? null, ip: ctx.ip, created_at: now() });
    log('warn', `report ${id} (${body.reason}) against ${plugin.id}${body.version ? `@${body.version}` : ''} from ${ctx.ip}`);
    sendJson(ctx.res, 202, { id });
  });

  const packageUrl = (id: string, version: string) => `${base}/v1/plugins/${encodeURIComponent(id)}/${encodeURIComponent(version)}/package`;

  router.get('/v1/plugins/:id/:version', (ctx) => {
    const ver = resolveVersion(store, ctx.params.id!, ctx.params.version!);
    const plugin = store.plugin(ver.plugin_id)!;
    const url = packageUrl(ver.plugin_id, ver.version);
    sendJson(ctx.res, 200, {
      manifest: JSON.parse(ver.manifest),
      ...versionInfo(ver),
      owner: plugin.owner_name,
      kind: plugin.kind,
      packageUrl: url,
      ...(ver.signature ? { signatureUrl: `${url}.minisig` } : {}),
    });
  });

  router.get('/v1/plugins/:id/:version/package.minisig', (ctx) => {
    const ver = resolveVersion(store, ctx.params.id!, ctx.params.version!);
    if (!ver.signature) throw new HttpError(404, 'not_signed', `${ver.plugin_id}@${ver.version} is not signed`);
    const data = Buffer.from(ver.signature, 'utf8');
    ctx.res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': String(data.length),
      'Content-Disposition': `attachment; filename="${ver.plugin_id}-${ver.version}.tgz.minisig"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
    });
    if (ctx.method === 'HEAD') return void ctx.res.end();
    ctx.res.end(data);
  });

  router.put('/v1/plugins/:id/:version/signature', async (ctx) => {
    const account = requireAccount(ctx);
    const text = (await readBody(ctx.req, 8 * 1024)).toString('utf8');
    const version = await registry.attachSignature(account.id, ctx.params.id!, ctx.params.version!, text);
    log('info', `${ctx.params.id}@${version.version} signed by ${version.signature?.keyId} (${account.name})`);
    sendJson(ctx.res, 200, { version });
  });

  router.get('/v1/plugins/:id/:version/package', (ctx) => {
    const ver = resolveVersion(store, ctx.params.id!, ctx.params.version!);
    const file = registry.packagePath(ver.sha256);
    ctx.res.writeHead(200, {
      'Content-Type': 'application/gzip',
      'Content-Length': String(ver.size),
      'Content-Disposition': `attachment; filename="${ver.plugin_id}-${ver.version}.tgz"`,
      'X-Checksum-Sha256': ver.sha256,
      'X-Plugin-Version': ver.version,
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'X-Checksum-Sha256, X-Plugin-Version',
    });
    if (ctx.method === 'HEAD') return void ctx.res.end();
    store.countDownload(ver.plugin_id, ver.version);
    createReadStream(file).on('error', () => ctx.res.destroy()).pipe(ctx.res);
  });

  router.get('/v1/plugins/:id/:version/files/*path', (ctx) => {
    const ver = resolveVersion(store, ctx.params.id!, ctx.params.version!);
    const file = registry.filePath(ver.sha256, ctx.params.path!);
    if (!file) throw new HttpError(404, 'not_found', `No file "${ctx.params.path}" in ${ver.plugin_id}@${ver.version}`);
    const type = contentTypeFor(file);
    const name = ctx.params.path!.split('/').pop()!.replace(/[^A-Za-z0-9._-]/g, '_');
    ctx.res.writeHead(200, {
      'Content-Type': type,
      'Content-Disposition': `${type === 'application/octet-stream' ? 'attachment' : 'inline'}; filename="${name}"`,
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'public, max-age=86400, immutable',
      'Access-Control-Allow-Origin': '*',
    });
    if (ctx.method === 'HEAD') return void ctx.res.end();
    createReadStream(file).on('error', () => ctx.res.destroy()).pipe(ctx.res);
  });

  router.put('/v1/plugins/:id/:version', async (ctx) => {
    const { id, version } = ctx.params as { id: string; version: string };
    const presented = bearer(ctx.req);
    let account: AccountRow;
    let provenance: Provenance | undefined;
    if (presented?.startsWith(PUBLISH_TOKEN_PREFIX)) {
      // Trusted publishing: a short-lived token minted from a verified CI identity.
      const token = store.publishToken(hashSecret(presented));
      if (!token) throw new HttpError(401, 'unauthorized', 'Unknown publish token');
      if (token.expires_at <= now()) throw new HttpError(401, 'token_expired', 'This publish token has expired; exchange a fresh OIDC token at /v1/oidc/github');
      const entry = token.scope.find((s) => s.plugin === id);
      if (!entry) throw new HttpError(403, 'token_scope', `This publish token covers ${token.scope.map((s) => s.plugin).join(', ')}, not "${id}"`);
      const owner = store.accountByIdOrName(entry.account);
      if (!owner) throw new HttpError(401, 'unauthorized', 'The account behind this publish token no longer exists');
      if (owner.disabled) throw new HttpError(403, 'account_disabled', 'This account is disabled');
      account = owner;
      provenance = provenanceOf(token.claims as unknown as GithubClaims, oidc.config.issuer);
    } else {
      account = requireAccount(ctx);
      if (store.requireTrustedPublishing(id)) {
        throw new HttpError(403, 'trusted_publishing_required', `"${id}" only accepts new versions from its trusted publishers (CI); account keys can't publish it`);
      }
    }
    if (!PLUGIN_ID.test(id)) throw new HttpError(400, 'invalid_id', 'Plugin ids are 3-48 lowercase letters, digits and dashes');
    if (!isValidVersion(version)) throw new HttpError(400, 'invalid_version', 'Versions must be semver, e.g. 1.2.3');
    const body = await readBody(ctx.req, MAX_PACKAGE_BYTES);
    const signature = decodeSignatureHeader(ctx.req.headers['x-opencitadel-signature']);
    const result = await registry.publish(account.id, id, version, body, signature, provenance);
    const signedBy = result.version.signature ? ` (signed by ${result.version.signature.keyId})` : ' (unsigned)';
    const via = provenance ? ` via trusted publishing from ${provenance.repository}@${provenance.sha.slice(0, 7)}` : '';
    log('info', `published ${id}@${version} by ${account.name}${via}${signedBy}`);
    sendJson(ctx.res, 201, result);
  });

  // ---- Deadworks FastDL: /fastdl/{maps|addons}/<name>_<sha256[0:16]>.vpk.zst ----

  router.get('/fastdl/:dir/:file', (ctx) => {
    const kind = ctx.params.dir === 'maps' ? 'map' : ctx.params.dir === 'addons' ? 'addon' : undefined;
    const m = FASTDL_FILE.exec(ctx.params.file!);
    const row = kind && m ? store.contentFile(kind, m[1]!, m[2]!) : undefined;
    const file = row ? registry.filePath(row.package_sha256, row.path) : undefined;
    if (!row || !file) throw new HttpError(404, 'not_found', `No content file ${ctx.params.dir}/${ctx.params.file}`);
    const blocks = row.size === 0 ? 1 : Math.ceil(row.size / ZSTD_BLOCK);
    ctx.res.writeHead(200, {
      'Content-Type': 'application/zstd',
      'Content-Length': String(14 + 3 * blocks + row.size),
      'Content-Disposition': `attachment; filename="${ctx.params.file}"`,
      'X-Content-Type-Options': 'nosniff',
      // sha256 of the decompressed VPK, which is what Deadworks verifies.
      'X-Checksum-Sha256': row.sha256,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Access-Control-Allow-Origin': '*',
    });
    if (ctx.method === 'HEAD') return void ctx.res.end();
    const zstd = createZstdStoredStream(row.size).on('error', () => ctx.res.destroy());
    createReadStream(file).on('error', () => ctx.res.destroy()).pipe(zstd).pipe(ctx.res);
  });

  const yank = async (ctx: RequestContext, adminOnly: boolean) => {
    const { id, version } = ctx.params as { id: string; version: string };
    if (adminOnly) requireAdmin(ctx);
    const plugin = store.plugin(id);
    if (!adminOnly && !isAdmin(ctx)) {
      const account = requireAccount(ctx);
      if (!plugin || plugin.owner_id !== account.id) throw new HttpError(404, 'not_found', `No plugin "${id}" on this account`);
    }
    if (!plugin) throw new HttpError(404, 'not_found', `No plugin "${id}"`);
    if (!isValidVersion(version)) throw new HttpError(400, 'invalid_version', 'Yank an exact version, e.g. 1.2.3');
    const ver = store.versions(id).find((x) => compare(x.version, version) === 0);
    if (!ver) throw new HttpError(404, 'not_found', `No version ${version} of "${id}"`);
    const body = parse(v.object({ yanked: v.withDefault(v.bool(), true) }), await readJson(ctx.req, JSON_LIMIT));
    store.setYanked(id, ver.version, body.yanked);
    sendJson(ctx.res, 200, { ok: true, version: versionInfo(store.version(id, ver.version)!) });
  };

  router.post('/v1/plugins/:id/:version/yank', (ctx) => yank(ctx, false));

  // ---- admin ----

  router.get('/v1/admin/servers', (ctx) => {
    requireAdmin(ctx);
    const t = now();
    const servers = store.allServers().map((s) => ({
      id: s.id,
      name: s.name,
      source: s.source,
      owner: s.owner_id ? { id: s.owner_id, name: s.owner_name } : null,
      ip: s.ip,
      port: s.port,
      blocked: !!s.blocked,
      createdAt: new Date(s.created_at).toISOString(),
      lastHeartbeat: s.last_heartbeat ? new Date(s.last_heartbeat).toISOString() : null,
      online: !!s.last_heartbeat && !s.offline && !s.blocked && s.last_heartbeat + (s.ttl ?? 0) * 1000 > t,
    }));
    sendJson(ctx.res, 200, { servers });
  });

  router.delete('/v1/admin/servers/:id', (ctx) => {
    requireAdmin(ctx);
    const server = store.server(ctx.params.id!);
    if (!server) throw new HttpError(404, 'not_found', `No server "${ctx.params.id}"`);
    store.setServerBlocked(server.id, true);
    store.setListingOffline(server.id);
    log('warn', `admin delisted server ${server.id} "${server.name}"`);
    sendEmpty(ctx.res);
  });

  router.post('/v1/admin/accounts/:id/disable', (ctx) => {
    requireAdmin(ctx);
    const account = store.accountByIdOrName(ctx.params.id!);
    if (!account) throw new HttpError(404, 'not_found', `No account "${ctx.params.id}"`);
    store.setAccountDisabled(account.id, true);
    log('warn', `admin disabled account ${account.name}`);
    sendJson(ctx.res, 200, { ok: true, account: { ...accountView(account), disabled: true } });
  });

  router.post('/v1/admin/plugins/:id/:version/yank', (ctx) => yank(ctx, true));

  router.get('/v1/admin/reports', (ctx) => {
    requireAdmin(ctx);
    const status = ctx.url.searchParams.get('status') || 'open';
    if (status !== 'open' && status !== 'resolved') throw new HttpError(400, 'invalid_query', 'status must be open or resolved');
    sendJson(ctx.res, 200, { reports: store.reports(status).map(reportView) });
  });

  router.post('/v1/admin/reports/:id/resolve', async (ctx) => {
    requireAdmin(ctx);
    const report = store.report(ctx.params.id!);
    if (!report) throw new HttpError(404, 'not_found', `No report "${ctx.params.id}"`);
    const body = parse(v.object({ note: v.withDefault(v.string({ max: 2000 }), '') }), await readJson(ctx.req, JSON_LIMIT));
    store.resolveReport(report.id, body.note, now());
    log('info', `report ${report.id} resolved`);
    sendJson(ctx.res, 200, { report: reportView(store.report(report.id)!) });
  });

  // ---- Deadworks compatibility ----

  if (compat) {
    router.post('/api/servers/register', async (ctx) => {
      if (!registrationOpen) throw new HttpError(403, 'registration_closed', 'Registration is closed on this master');
      const body = parse(dwRegisterValidator, await readJson(ctx.req, JSON_LIMIT));
      if (isIP(ctx.ip) !== 4) throw new HttpError(400, 'ipv4_required', 'Deadworks servers must register over IPv4');
      const token = newServerToken();
      const id = newId();
      store.createServer({ id, owner_id: null, name: body.name.trim().slice(0, 64) || 'Deadworks Server', token_hash: hashSecret(token), source: 'deadworks', created_at: now(), ip: ctx.ip, port: body.port });
      log('info', `deadworks server registered: ${id} from ${ctx.ip}:${body.port}`);
      sendJson(ctx.res, 201, { id, token });
    });

    router.post('/api/servers/:id/heartbeat', async (ctx) => {
      const server = requireServerToken(ctx, ctx.params.id!);
      const body = await readJson(ctx.req, JSON_LIMIT);
      const { heartbeat, extra, port } = fromDeadworksHeartbeat(body, ctx.ip, server.port, opts.deadworksPlayerNames ?? false);
      const prev = store.listing(server.id);
      store.updateServerSeen(server.id, heartbeat.name, ctx.ip, port);
      store.upsertListing({ serverId: server.id, heartbeat, extra, now: now(), ttl: DEADWORKS_HEARTBEAT_TTL, ip: ctx.ip });
      void verifier.maybeProbe(server.id, heartbeat.connect.address, prev?.last_probe ?? null, prev?.verified_addr ?? null);
      sendJson(ctx.res, 200, { ok: true });
    });

    const dw = (l: ListingRow) => {
      const s = toSummary(l);
      return toDwServer(l, s.players, s.map, now());
    };

    router.get('/api/servers', (ctx) => {
      const servers = onlineListings()
        .map(dw)
        .filter((s) => !!s)
        .sort((a, b) => b.player_count - a.player_count || a.name.localeCompare(b.name));
      sendJson(ctx.res, 200, { servers }, { 'Access-Control-Allow-Origin': '*' });
    });

    router.get('/api/servers/lookup', (ctx) => {
      const address = ctx.url.searchParams.get('address')?.trim();
      if (!address) throw new HttpError(400, 'invalid_query', 'address is required');
      const listing = onlineListings().find((l) => rawAddress(l) === address || l.heartbeat.connect.address === address);
      const server = listing && dw(listing);
      if (!server) throw new HttpError(404, 'not_found', `No online server at ${address}`);
      sendJson(ctx.res, 200, server);
    });

    router.get('/api/servers/:id', (ctx) => {
      const server = dw(visibleListing(ctx.params.id!));
      if (!server) throw new HttpError(404, 'not_found', `Server "${ctx.params.id}" has no direct address`);
      sendJson(ctx.res, 200, server);
    });

    router.get('/api/servers/:id/content', (ctx) => {
      const listing = visibleListing(ctx.params.id!);
      sendJson(ctx.res, 200, { items: dwContentItems(listing.heartbeat.content) });
    });
  }

  // ---- dispatch ----

  const rateClass = (method: string, path: string): RateClass | undefined => {
    if (path === '/healthz') return undefined;
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return 'read';
    if (path.endsWith('/heartbeat') || path.endsWith('/offline')) return 'heartbeat';
    if (path === '/v1/accounts' || path === '/api/servers/register') return 'register';
    if (method === 'POST' && /^\/v1\/plugins\/[^/]+\/reports$/.test(path)) return 'report';
    if (method === 'PUT' && path.startsWith('/v1/plugins/')) return 'publish';
    return 'write';
  };

  const server = createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://master.invalid');
    } catch {
      return sendError(res, new HttpError(400, 'bad_request', 'Malformed URL'));
    }
    const path = url.pathname;
    const ip = clientIp(req, opts.trustProxy ?? false);
    try {
      const cls = rateClass(method, path);
      if (cls) {
        const wait = limiter.take(cls, ip);
        if (wait) throw new HttpError(429, 'rate_limited', `Too many requests; retry in ${wait}s`, { 'Retry-After': String(wait) });
      }
      if ((method === 'GET' || method === 'HEAD') && site.serve(req, res, path)) return;
      const match = router.match(method === 'OPTIONS' ? 'GET' : method, path);
      if (!match) throw new HttpError(404, 'not_found', `No route for ${method} ${path}`);
      if (method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD', 'Access-Control-Max-Age': '86400' });
        return void res.end();
      }
      if ('allowed' in match) throw new HttpError(405, 'method_not_allowed', `${method} is not allowed here`, { Allow: [...new Set(match.allowed)].join(', ') });
      if (method === 'GET' || method === 'HEAD') res.setHeader('Access-Control-Allow-Origin', '*');
      await match.handler({ req, res, method, path, url, params: match.params, ip });
    } catch (err) {
      if (!(err instanceof HttpError) && !(err instanceof Error && err.name === 'ValidationError')) {
        log('error', `${method} ${path}: ${(err as Error).stack ?? err}`);
      }
      sendError(res, err);
    }
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 10 * 60_000;

  const purge = setInterval(() => {
    try {
      const n = store.purgeListingsBefore(now() - LISTING_PURGE_MS);
      if (n) log('info', `purged ${n} stale listings`);
      store.purgePublishTokens(now());
    } catch (err) {
      log('error', `purge failed: ${(err as Error).message}`);
    }
  }, 60 * 60 * 1000);
  purge.unref();

  return {
    server,
    store,
    registry,
    verifier,
    listen(port, host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve((server.address() as AddressInfo).port);
        });
      });
    },
    async close() {
      clearInterval(purge);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await verifier.idle();
      store.close();
    },
  };
}

/** Stored versions were validated at publish, so compareVersions never throws on them. */
function compare(a: string, b: string): number {
  return compareVersions(a, b);
}
