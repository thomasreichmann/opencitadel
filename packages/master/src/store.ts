/**
 * SQLite persistence for the master: accounts, servers, their latest listing, and the plugin
 * registry. Secrets are stored only as SHA-256 hashes. Schema changes go through numbered
 * migrations recorded in `schema_migrations`.
 */

import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Heartbeat, ListingSource, PluginKind } from '@opencitadel/protocol';
import { loadSqlite } from './sqlite.js';

const MIGRATIONS: string[] = [
  `
  CREATE TABLE accounts (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    key_hash    TEXT NOT NULL UNIQUE,
    created_at  INTEGER NOT NULL,
    disabled    INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE servers (
    id          TEXT PRIMARY KEY,
    owner_id    TEXT REFERENCES accounts(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    token_hash  TEXT NOT NULL UNIQUE,
    source      TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    blocked     INTEGER NOT NULL DEFAULT 0,
    ip          TEXT,
    port        INTEGER
  );
  CREATE INDEX servers_owner ON servers(owner_id);
  CREATE TABLE listings (
    server_id       TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
    heartbeat       TEXT NOT NULL,
    extra           TEXT,
    first_seen      INTEGER NOT NULL,
    last_heartbeat  INTEGER NOT NULL,
    ttl             INTEGER NOT NULL,
    offline         INTEGER NOT NULL DEFAULT 0,
    ip              TEXT,
    verified        INTEGER NOT NULL DEFAULT 0,
    verified_addr   TEXT,
    resolved_ip     TEXT,
    a2s             TEXT,
    last_probe      INTEGER
  );
  CREATE INDEX listings_seen ON listings(last_heartbeat);
  CREATE TABLE plugins (
    id          TEXT PRIMARY KEY,
    owner_id    TEXT NOT NULL REFERENCES accounts(id),
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL,
    description TEXT NOT NULL,
    author      TEXT,
    tags        TEXT NOT NULL,
    downloads   INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE TABLE plugin_versions (
    plugin_id     TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
    version       TEXT NOT NULL,
    sha256        TEXT NOT NULL,
    size          INTEGER NOT NULL,
    manifest      TEXT NOT NULL,
    published_at  INTEGER NOT NULL,
    yanked        INTEGER NOT NULL DEFAULT 0,
    downloads     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (plugin_id, version)
  );
  `,
  // 2: registry trust and moderation (signing keys, signatures, advisories, reports, FastDL index).
  `
  CREATE TABLE signing_keys (
    key_id      TEXT PRIMARY KEY,
    account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    public_key  TEXT NOT NULL,
    label       TEXT,
    added_at    INTEGER NOT NULL,
    revoked_at  INTEGER
  );
  CREATE INDEX signing_keys_account ON signing_keys(account_id);
  ALTER TABLE plugin_versions ADD COLUMN signature TEXT;
  ALTER TABLE plugin_versions ADD COLUMN signature_key_id TEXT;
  ALTER TABLE plugin_versions ADD COLUMN key_changed INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE advisories (
    id            TEXT PRIMARY KEY,
    plugin_id     TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
    severity      TEXT NOT NULL,
    title         TEXT NOT NULL,
    description   TEXT NOT NULL,
    affected      TEXT NOT NULL,
    fixed_in      TEXT,
    url           TEXT,
    published_at  INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    withdrawn     INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX advisories_plugin ON advisories(plugin_id);
  CREATE INDEX advisories_updated ON advisories(updated_at);
  CREATE TABLE reports (
    id           TEXT PRIMARY KEY,
    plugin_id    TEXT NOT NULL,
    version      TEXT,
    reason       TEXT NOT NULL,
    details      TEXT NOT NULL,
    contact      TEXT,
    ip           TEXT,
    created_at   INTEGER NOT NULL,
    status       TEXT NOT NULL DEFAULT 'open',
    resolved_at  INTEGER,
    resolution   TEXT
  );
  CREATE INDEX reports_status ON reports(status, created_at);
  CREATE TABLE content_files (
    plugin_id       TEXT NOT NULL,
    version         TEXT NOT NULL,
    path            TEXT NOT NULL,
    kind            TEXT NOT NULL,
    name            TEXT NOT NULL,
    sha256          TEXT NOT NULL,
    size            INTEGER NOT NULL,
    package_sha256  TEXT NOT NULL,
    PRIMARY KEY (plugin_id, version, path),
    FOREIGN KEY (plugin_id, version) REFERENCES plugin_versions(plugin_id, version) ON DELETE CASCADE
  );
  CREATE INDEX content_files_lookup ON content_files(kind, name);
  `,
  // 3: trusted publishing (CI publishers, short-lived publish tokens, provenance, plugin settings).
  `
  CREATE TABLE plugin_reservations (
    plugin_id   TEXT PRIMARY KEY,
    account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE trusted_publishers (
    id             TEXT PRIMARY KEY,
    plugin_id      TEXT NOT NULL,
    account_id     TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    provider       TEXT NOT NULL,
    repository     TEXT NOT NULL COLLATE NOCASE,
    workflow       TEXT NOT NULL,
    environment    TEXT,
    ref            TEXT,
    repository_id  TEXT,
    added_at       INTEGER NOT NULL
  );
  CREATE INDEX trusted_publishers_plugin ON trusted_publishers(plugin_id);
  CREATE INDEX trusted_publishers_repository ON trusted_publishers(repository);
  CREATE TABLE publish_tokens (
    token_hash  TEXT PRIMARY KEY,
    scope       TEXT NOT NULL,
    claims      TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
  );
  CREATE INDEX publish_tokens_expiry ON publish_tokens(expires_at);
  CREATE TABLE plugin_settings (
    plugin_id                   TEXT PRIMARY KEY,
    require_trusted_publishing  INTEGER NOT NULL DEFAULT 0
  );
  ALTER TABLE plugin_versions ADD COLUMN provenance TEXT;
  `,
];

export interface AccountRow {
  id: string;
  name: string;
  created_at: number;
  disabled: number;
}

export interface ServerRow {
  id: string;
  owner_id: string | null;
  name: string;
  token_hash: string;
  source: ListingSource;
  created_at: number;
  blocked: number;
  ip: string | null;
  port: number | null;
}

/** Deadworks-only fields kept verbatim so the compatibility routes can echo them back. */
export interface DeadworksExtra {
  mods: Array<{ name: string; type: string; version: string }>;
  content_addons: string[];
  extra_maps: string[];
}

export interface A2sSnapshot {
  players: number;
  maxPlayers: number;
  map: string;
}

export interface ListingRow {
  server_id: string;
  heartbeat: Heartbeat;
  extra: DeadworksExtra | null;
  first_seen: number;
  last_heartbeat: number;
  ttl: number;
  offline: boolean;
  ip: string | null;
  verified: boolean;
  verified_addr: string | null;
  resolved_ip: string | null;
  a2s: A2sSnapshot | null;
  last_probe: number | null;
  // Joined from servers/accounts:
  source: ListingSource;
  owner_id: string | null;
  owner_name: string | null;
  owner_disabled: boolean;
  blocked: boolean;
}

export interface PluginRow {
  id: string;
  owner_id: string;
  owner_name: string;
  name: string;
  kind: PluginKind;
  description: string;
  author: string | null;
  tags: string[];
  downloads: number;
  created_at: number;
  updated_at: number;
  /** Only trusted publishers (CI) may publish new versions. */
  require_trusted_publishing: boolean;
}

export interface PluginVersionRow {
  plugin_id: string;
  version: string;
  sha256: string;
  size: number;
  manifest: string;
  published_at: number;
  yanked: number;
  downloads: number;
  /** The minisign signature file, when the publisher signed this version. */
  signature: string | null;
  signature_key_id: string | null;
  key_changed: number;
  /** Provenance JSON, for versions published through trusted publishing. */
  provenance: string | null;
}

export interface TrustedPublisherRow {
  id: string;
  plugin_id: string;
  account_id: string;
  provider: 'github';
  repository: string;
  workflow: string;
  environment: string | null;
  ref: string | null;
  repository_id: string | null;
  added_at: number;
}

/** Who a publish token may publish for: each plugin id with the account it publishes as. */
export interface PublishScope {
  plugin: string;
  account: string;
}

export interface PublishTokenRow {
  token_hash: string;
  scope: PublishScope[];
  claims: Record<string, string>;
  created_at: number;
  expires_at: number;
}

export interface SigningKeyRow {
  key_id: string;
  account_id: string;
  public_key: string;
  label: string | null;
  added_at: number;
  revoked_at: number | null;
}

export interface AdvisoryRow {
  id: string;
  plugin_id: string;
  severity: string;
  title: string;
  description: string;
  affected: string;
  fixed_in: string | null;
  url: string | null;
  published_at: number;
  updated_at: number;
  withdrawn: number;
}

export interface ReportRow {
  id: string;
  plugin_id: string;
  version: string | null;
  reason: string;
  details: string;
  contact: string | null;
  ip: string | null;
  created_at: number;
  status: 'open' | 'resolved';
  resolved_at: number | null;
  resolution: string | null;
}

export interface ContentFileRow {
  plugin_id: string;
  version: string;
  path: string;
  kind: 'map' | 'addon';
  name: string;
  sha256: string;
  size: number;
  package_sha256: string;
}

type Row = Record<string, unknown>;

function listingFromRow(r: Row): ListingRow {
  return {
    server_id: r.server_id as string,
    heartbeat: JSON.parse(r.heartbeat as string) as Heartbeat,
    extra: r.extra ? (JSON.parse(r.extra as string) as DeadworksExtra) : null,
    first_seen: Number(r.first_seen),
    last_heartbeat: Number(r.last_heartbeat),
    ttl: Number(r.ttl),
    offline: !!r.offline,
    ip: (r.ip as string | null) ?? null,
    verified: !!r.verified,
    verified_addr: (r.verified_addr as string | null) ?? null,
    resolved_ip: (r.resolved_ip as string | null) ?? null,
    a2s: r.a2s ? (JSON.parse(r.a2s as string) as A2sSnapshot) : null,
    last_probe: r.last_probe === null || r.last_probe === undefined ? null : Number(r.last_probe),
    source: r.source as ListingSource,
    owner_id: (r.owner_id as string | null) ?? null,
    owner_name: (r.owner_name as string | null) ?? null,
    owner_disabled: !!r.owner_disabled,
    blocked: !!r.blocked,
  };
}

function pluginFromRow(r: Row): PluginRow {
  return {
    id: r.id as string,
    owner_id: r.owner_id as string,
    owner_name: r.owner_name as string,
    name: r.name as string,
    kind: r.kind as PluginKind,
    description: r.description as string,
    author: (r.author as string | null) ?? null,
    tags: JSON.parse(r.tags as string) as string[],
    downloads: Number(r.downloads),
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
    require_trusted_publishing: !!r.require_trusted_publishing,
  };
}

const PLUGIN_SELECT = `
  SELECT p.*, a.name AS owner_name, COALESCE(ps.require_trusted_publishing, 0) AS require_trusted_publishing
  FROM plugins p JOIN accounts a ON a.id = p.owner_id LEFT JOIN plugin_settings ps ON ps.plugin_id = p.id`;

const LISTING_SELECT = `
  SELECT l.*, s.source, s.owner_id, s.blocked, a.name AS owner_name, COALESCE(a.disabled, 0) AS owner_disabled
  FROM listings l JOIN servers s ON s.id = l.server_id LEFT JOIN accounts a ON a.id = s.owner_id`;

export class Store {
  readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();

  constructor(path: string) {
    const { DatabaseSync } = loadSqlite();
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
    const row = this.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as Row | undefined;
    const current = Number(row?.v ?? 0);
    for (let i = current; i < MIGRATIONS.length; i++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[i]!);
        this.db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(i + 1, Date.now());
      });
    }
  }

  private stmt(sql: string): StatementSync {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  // ---- accounts ----

  createAccount(id: string, name: string, keyHash: string, now: number): AccountRow {
    this.stmt('INSERT INTO accounts (id, name, key_hash, created_at) VALUES (?, ?, ?, ?)').run(id, name, keyHash, now);
    return { id, name, created_at: now, disabled: 0 };
  }

  accountByKeyHash(hash: string): AccountRow | undefined {
    return this.stmt('SELECT id, name, created_at, disabled FROM accounts WHERE key_hash = ?').get(hash) as AccountRow | undefined;
  }

  accountByIdOrName(idOrName: string): AccountRow | undefined {
    return this.stmt('SELECT id, name, created_at, disabled FROM accounts WHERE id = ? OR name = ?').get(idOrName, idOrName) as AccountRow | undefined;
  }

  accountNameTaken(name: string): boolean {
    return !!this.stmt('SELECT 1 FROM accounts WHERE name = ?').get(name);
  }

  setAccountKey(id: string, keyHash: string): void {
    this.stmt('UPDATE accounts SET key_hash = ? WHERE id = ?').run(keyHash, id);
  }

  setAccountDisabled(id: string, disabled: boolean): void {
    this.stmt('UPDATE accounts SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, id);
  }

  // ---- servers ----

  createServer(row: Omit<ServerRow, 'blocked'>): ServerRow {
    this.stmt('INSERT INTO servers (id, owner_id, name, token_hash, source, created_at, ip, port) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      row.id,
      row.owner_id,
      row.name,
      row.token_hash,
      row.source,
      row.created_at,
      row.ip,
      row.port,
    );
    return { ...row, blocked: 0 };
  }

  server(id: string): ServerRow | undefined {
    return this.stmt('SELECT * FROM servers WHERE id = ?').get(id) as ServerRow | undefined;
  }

  serversByOwner(ownerId: string): ServerRow[] {
    return this.stmt('SELECT * FROM servers WHERE owner_id = ? ORDER BY created_at').all(ownerId) as unknown as ServerRow[];
  }

  countServersByOwner(ownerId: string): number {
    return Number((this.stmt('SELECT COUNT(*) AS n FROM servers WHERE owner_id = ?').get(ownerId) as Row).n);
  }

  setServerToken(id: string, tokenHash: string): void {
    this.stmt('UPDATE servers SET token_hash = ? WHERE id = ?').run(tokenHash, id);
  }

  setServerBlocked(id: string, blocked: boolean): void {
    this.stmt('UPDATE servers SET blocked = ? WHERE id = ?').run(blocked ? 1 : 0, id);
  }

  updateServerSeen(id: string, name: string, ip: string | null, port: number | null): void {
    this.stmt('UPDATE servers SET name = ?, ip = COALESCE(?, ip), port = COALESCE(?, port) WHERE id = ?').run(name, ip, port, id);
  }

  deleteServer(id: string): void {
    this.stmt('DELETE FROM servers WHERE id = ?').run(id);
  }

  allServers(): Array<ServerRow & { owner_name: string | null; last_heartbeat: number | null; offline: number | null; ttl: number | null }> {
    return this.stmt(
      `SELECT s.*, a.name AS owner_name, l.last_heartbeat, l.offline, l.ttl
       FROM servers s LEFT JOIN accounts a ON a.id = s.owner_id LEFT JOIN listings l ON l.server_id = s.id
       ORDER BY s.created_at`,
    ).all() as never;
  }

  // ---- listings ----

  upsertListing(args: { serverId: string; heartbeat: Heartbeat; extra: DeadworksExtra | null; now: number; ttl: number; ip: string | null }): void {
    this.stmt(
      `INSERT INTO listings (server_id, heartbeat, extra, first_seen, last_heartbeat, ttl, offline, ip)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(server_id) DO UPDATE SET
         heartbeat = excluded.heartbeat, extra = excluded.extra, last_heartbeat = excluded.last_heartbeat,
         ttl = excluded.ttl, offline = 0, ip = excluded.ip,
         first_seen = CASE WHEN listings.last_heartbeat + listings.ttl * 1000 < excluded.last_heartbeat - 86400000
                           THEN excluded.first_seen ELSE listings.first_seen END`,
    ).run(args.serverId, JSON.stringify(args.heartbeat), args.extra ? JSON.stringify(args.extra) : null, args.now, args.now, args.ttl, args.ip);
  }

  listing(serverId: string): ListingRow | undefined {
    const r = this.stmt(`${LISTING_SELECT} WHERE l.server_id = ?`).get(serverId) as Row | undefined;
    return r ? listingFromRow(r) : undefined;
  }

  /** Listings that could be online at `now` (the caller applies the remaining rules). */
  candidateListings(now: number): ListingRow[] {
    return (this.stmt(`${LISTING_SELECT} WHERE l.offline = 0 AND l.last_heartbeat + l.ttl * 1000 > ?`).all(now) as Row[]).map(listingFromRow);
  }

  setListingOffline(serverId: string): void {
    this.stmt('UPDATE listings SET offline = 1 WHERE server_id = ?').run(serverId);
  }

  deleteListing(serverId: string): void {
    this.stmt('DELETE FROM listings WHERE server_id = ?').run(serverId);
  }

  recordProbe(serverId: string, result: { verified: boolean; address: string; resolvedIp: string | null; a2s: A2sSnapshot | null; at: number }): void {
    this.stmt('UPDATE listings SET verified = ?, verified_addr = ?, resolved_ip = ?, a2s = ?, last_probe = ? WHERE server_id = ?').run(
      result.verified ? 1 : 0,
      result.address,
      result.resolvedIp,
      result.a2s ? JSON.stringify(result.a2s) : null,
      result.at,
      serverId,
    );
  }

  purgeListingsBefore(cutoff: number): number {
    return Number(this.stmt('DELETE FROM listings WHERE last_heartbeat < ?').run(cutoff).changes);
  }

  // ---- plugins ----

  plugin(id: string): PluginRow | undefined {
    const r = this.stmt(`${PLUGIN_SELECT} WHERE p.id = ?`).get(id) as Row | undefined;
    return r ? pluginFromRow(r) : undefined;
  }

  allPlugins(): PluginRow[] {
    return (this.stmt(`${PLUGIN_SELECT} ORDER BY p.updated_at DESC`).all() as Row[]).map(pluginFromRow);
  }

  countPlugins(): number {
    return Number((this.stmt('SELECT COUNT(*) AS n FROM plugins').get() as Row).n);
  }

  insertPlugin(row: Omit<PluginRow, 'owner_name' | 'downloads' | 'require_trusted_publishing'>): void {
    this.stmt('INSERT INTO plugins (id, owner_id, name, kind, description, author, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      row.id,
      row.owner_id,
      row.name,
      row.kind,
      row.description,
      row.author,
      JSON.stringify(row.tags),
      row.created_at,
      row.updated_at,
    );
  }

  updatePluginMeta(id: string, meta: { name: string; description: string; author: string | null; tags: string[]; updated_at: number }): void {
    this.stmt('UPDATE plugins SET name = ?, description = ?, author = ?, tags = ?, updated_at = ? WHERE id = ?').run(
      meta.name,
      meta.description,
      meta.author,
      JSON.stringify(meta.tags),
      meta.updated_at,
      id,
    );
  }

  touchPlugin(id: string, at: number): void {
    this.stmt('UPDATE plugins SET updated_at = ? WHERE id = ?').run(at, id);
  }

  versions(pluginId: string): PluginVersionRow[] {
    return this.stmt('SELECT * FROM plugin_versions WHERE plugin_id = ?').all(pluginId) as unknown as PluginVersionRow[];
  }

  version(pluginId: string, version: string): PluginVersionRow | undefined {
    return this.stmt('SELECT * FROM plugin_versions WHERE plugin_id = ? AND version = ?').get(pluginId, version) as PluginVersionRow | undefined;
  }

  insertVersion(row: Omit<PluginVersionRow, 'yanked' | 'downloads' | 'key_changed'>): void {
    this.stmt(
      'INSERT INTO plugin_versions (plugin_id, version, sha256, size, manifest, published_at, signature, signature_key_id, provenance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(row.plugin_id, row.version, row.sha256, row.size, row.manifest, row.published_at, row.signature, row.signature_key_id, row.provenance);
  }

  setSignature(pluginId: string, version: string, signature: string, keyId: string): void {
    this.stmt('UPDATE plugin_versions SET signature = ?, signature_key_id = ? WHERE plugin_id = ? AND version = ?').run(signature, keyId, pluginId, version);
  }

  setKeyChanged(pluginId: string, version: string, changed: boolean): void {
    this.stmt('UPDATE plugin_versions SET key_changed = ? WHERE plugin_id = ? AND version = ?').run(changed ? 1 : 0, pluginId, version);
  }

  pluginsByOwner(accountId: string): string[] {
    return (this.stmt('SELECT id FROM plugins WHERE owner_id = ? ORDER BY id').all(accountId) as Row[]).map((r) => r.id as string);
  }

  // ---- trusted publishing ----

  /** The account holding an id nobody has published yet (set by configuring trusted publishing for it). */
  reservation(pluginId: string): { account_id: string; created_at: number } | undefined {
    return this.stmt('SELECT account_id, created_at FROM plugin_reservations WHERE plugin_id = ?').get(pluginId) as { account_id: string; created_at: number } | undefined;
  }

  reserve(pluginId: string, accountId: string, at: number): void {
    this.stmt('INSERT OR IGNORE INTO plugin_reservations (plugin_id, account_id, created_at) VALUES (?, ?, ?)').run(pluginId, accountId, at);
  }

  deleteReservation(pluginId: string): void {
    this.stmt('DELETE FROM plugin_reservations WHERE plugin_id = ?').run(pluginId);
  }

  insertTrustedPublisher(row: TrustedPublisherRow): void {
    this.stmt(
      'INSERT INTO trusted_publishers (id, plugin_id, account_id, provider, repository, workflow, environment, ref, repository_id, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(row.id, row.plugin_id, row.account_id, row.provider, row.repository, row.workflow, row.environment, row.ref, row.repository_id, row.added_at);
  }

  trustedPublisher(id: string): TrustedPublisherRow | undefined {
    return this.stmt('SELECT * FROM trusted_publishers WHERE id = ?').get(id) as TrustedPublisherRow | undefined;
  }

  trustedPublishers(pluginId: string): TrustedPublisherRow[] {
    return this.stmt('SELECT * FROM trusted_publishers WHERE plugin_id = ? ORDER BY added_at, id').all(pluginId) as unknown as TrustedPublisherRow[];
  }

  /** Publishers configured for a repository (case-insensitive), across all plugins. */
  trustedPublishersForRepository(repository: string): TrustedPublisherRow[] {
    return this.stmt('SELECT * FROM trusted_publishers WHERE repository = ? ORDER BY plugin_id, added_at, id').all(repository) as unknown as TrustedPublisherRow[];
  }

  deleteTrustedPublisher(id: string): void {
    this.stmt('DELETE FROM trusted_publishers WHERE id = ?').run(id);
  }

  pinRepositoryId(id: string, repositoryId: string): void {
    this.stmt('UPDATE trusted_publishers SET repository_id = ? WHERE id = ? AND repository_id IS NULL').run(repositoryId, id);
  }

  requireTrustedPublishing(pluginId: string): boolean {
    const r = this.stmt('SELECT require_trusted_publishing AS v FROM plugin_settings WHERE plugin_id = ?').get(pluginId) as Row | undefined;
    return !!r?.v;
  }

  setRequireTrustedPublishing(pluginId: string, value: boolean): void {
    this.stmt(
      'INSERT INTO plugin_settings (plugin_id, require_trusted_publishing) VALUES (?, ?) ON CONFLICT(plugin_id) DO UPDATE SET require_trusted_publishing = excluded.require_trusted_publishing',
    ).run(pluginId, value ? 1 : 0);
  }

  insertPublishToken(row: PublishTokenRow): void {
    this.stmt('INSERT INTO publish_tokens (token_hash, scope, claims, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(
      row.token_hash,
      JSON.stringify(row.scope),
      JSON.stringify(row.claims),
      row.created_at,
      row.expires_at,
    );
  }

  publishToken(hash: string): PublishTokenRow | undefined {
    const r = this.stmt('SELECT * FROM publish_tokens WHERE token_hash = ?').get(hash) as Row | undefined;
    if (!r) return undefined;
    return {
      token_hash: r.token_hash as string,
      scope: JSON.parse(r.scope as string) as PublishScope[],
      claims: JSON.parse(r.claims as string) as Record<string, string>,
      created_at: Number(r.created_at),
      expires_at: Number(r.expires_at),
    };
  }

  purgePublishTokens(now: number): number {
    return Number(this.stmt('DELETE FROM publish_tokens WHERE expires_at <= ?').run(now).changes);
  }

  // ---- signing keys ----

  addSigningKey(row: Omit<SigningKeyRow, 'revoked_at'>): void {
    this.stmt('INSERT INTO signing_keys (key_id, account_id, public_key, label, added_at) VALUES (?, ?, ?, ?, ?)').run(row.key_id, row.account_id, row.public_key, row.label, row.added_at);
  }

  signingKey(keyId: string): SigningKeyRow | undefined {
    return this.stmt('SELECT * FROM signing_keys WHERE key_id = ?').get(keyId) as SigningKeyRow | undefined;
  }

  signingKeys(accountId: string): SigningKeyRow[] {
    return this.stmt('SELECT * FROM signing_keys WHERE account_id = ? ORDER BY added_at, key_id').all(accountId) as unknown as SigningKeyRow[];
  }

  revokeSigningKey(keyId: string, at: number): void {
    this.stmt('UPDATE signing_keys SET revoked_at = ? WHERE key_id = ? AND revoked_at IS NULL').run(at, keyId);
  }

  // ---- advisories ----

  insertAdvisory(row: Omit<AdvisoryRow, 'withdrawn'>): void {
    this.stmt(
      'INSERT INTO advisories (id, plugin_id, severity, title, description, affected, fixed_in, url, published_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(row.id, row.plugin_id, row.severity, row.title, row.description, row.affected, row.fixed_in, row.url, row.published_at, row.updated_at);
  }

  advisory(id: string): AdvisoryRow | undefined {
    return this.stmt('SELECT * FROM advisories WHERE id = ?').get(id) as AdvisoryRow | undefined;
  }

  advisoriesForPlugin(pluginId: string): AdvisoryRow[] {
    return this.stmt('SELECT * FROM advisories WHERE plugin_id = ? ORDER BY published_at DESC, id').all(pluginId) as unknown as AdvisoryRow[];
  }

  /** Advisories created or changed after `since`, most recently changed first. */
  advisoriesChangedSince(since: number, limit: number): AdvisoryRow[] {
    return this.stmt('SELECT * FROM advisories WHERE updated_at > ? ORDER BY updated_at DESC, id LIMIT ?').all(since, limit) as unknown as AdvisoryRow[];
  }

  withdrawAdvisory(id: string, at: number): void {
    this.stmt('UPDATE advisories SET withdrawn = 1, updated_at = ? WHERE id = ?').run(at, id);
  }

  // ---- reports ----

  insertReport(row: Omit<ReportRow, 'status' | 'resolved_at' | 'resolution'>): void {
    this.stmt('INSERT INTO reports (id, plugin_id, version, reason, details, contact, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      row.id,
      row.plugin_id,
      row.version,
      row.reason,
      row.details,
      row.contact,
      row.ip,
      row.created_at,
    );
  }

  report(id: string): ReportRow | undefined {
    return this.stmt('SELECT * FROM reports WHERE id = ?').get(id) as ReportRow | undefined;
  }

  reports(status: 'open' | 'resolved'): ReportRow[] {
    return this.stmt('SELECT * FROM reports WHERE status = ? ORDER BY created_at DESC, id LIMIT 500').all(status) as unknown as ReportRow[];
  }

  resolveReport(id: string, note: string, at: number): void {
    this.stmt("UPDATE reports SET status = 'resolved', resolved_at = ?, resolution = ? WHERE id = ?").run(at, note, id);
  }

  // ---- FastDL content index ----

  insertContentFile(row: ContentFileRow): void {
    this.stmt('INSERT OR REPLACE INTO content_files (plugin_id, version, path, kind, name, sha256, size, package_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      row.plugin_id,
      row.version,
      row.path,
      row.kind,
      row.name,
      row.sha256,
      row.size,
      row.package_sha256,
    );
  }

  /** A content file by kind, name and the first 16 hex digits of its sha256. */
  contentFile(kind: 'map' | 'addon', name: string, sha16: string): ContentFileRow | undefined {
    return this.stmt('SELECT * FROM content_files WHERE kind = ? AND name = ? AND substr(sha256, 1, 16) = ? LIMIT 1').get(kind, name, sha16) as ContentFileRow | undefined;
  }

  setYanked(pluginId: string, version: string, yanked: boolean): void {
    this.stmt('UPDATE plugin_versions SET yanked = ? WHERE plugin_id = ? AND version = ?').run(yanked ? 1 : 0, pluginId, version);
  }

  countDownload(pluginId: string, version: string): void {
    this.transaction(() => {
      this.stmt('UPDATE plugin_versions SET downloads = downloads + 1 WHERE plugin_id = ? AND version = ?').run(pluginId, version);
      this.stmt('UPDATE plugins SET downloads = downloads + 1 WHERE id = ?').run(pluginId);
    });
  }
}
