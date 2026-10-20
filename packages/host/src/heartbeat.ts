/**
 * Keeps the server listed on the master: builds the heartbeat from live state, plugin listing
 * contributions and installed packages, posts it every `interval` seconds while the server runs,
 * backs off on failures, and delists on shutdown.
 */

import { HEARTBEAT_INTERVAL, parseHeartbeat, type ContentItem, type Heartbeat, type HeartbeatResponse, type ListingPlugin } from '@opencitadel/protocol';
import type { Logger, ServerState } from '@opencitadel/plugin-sdk';
import type { HostConfig } from './config.js';
import type { ListingContributions } from './services.js';
import { HOST_SOFTWARE, HOST_VERSION } from './version.js';

const TAG = /^[a-z0-9][a-z0-9_-]{0,23}$/;
const META_KEY = /^[A-Za-z0-9_.-]{1,40}$/;

export interface InstalledInfo {
  plugins: ListingPlugin[];
  content: ContentItem[];
}

/** Assembles the heartbeat body. Throws (ValidationError) if the result would be rejected by the master. */
export function buildHeartbeat(config: HostConfig, state: ServerState, contributions: ListingContributions, installed: InstalledInfo): Heartbeat {
  const humans = state.players.filter((p) => !p.bot);
  const tags = [...new Set([...config.tags, ...contributions.tags.map((t) => t.toLowerCase())])].filter((t) => TAG.test(t)).slice(0, 16);
  const metadata = Object.fromEntries(
    Object.entries(contributions.metadata)
      .filter(([k, v]) => META_KEY.test(k) && typeof v === 'string')
      .slice(0, 32)
      .map(([k, v]) => [k, v.slice(0, 200)]),
  );
  return parseHeartbeat({
    name: config.name,
    description: config.description,
    map: state.map ?? config.game.map,
    gameMode: contributions.gameMode?.slice(0, 48),
    players: Math.min(humans.length, state.maxPlayers > 0 ? state.maxPlayers : 255, 255),
    maxPlayers: state.maxPlayers,
    bots: Math.min(state.players.length - humans.length, 255),
    passworded: config.game.password.length > 0,
    region: config.region,
    country: config.country,
    tags,
    connect: { steamId: state.steamId, address: config.publicAddress },
    playerList: humans.slice(0, 64).map((p) => ({
      // Names stay private unless the admin opts in; heroes and teams are enough to pick a server.
      name: config.privacy.showPlayerNames ? p.name.slice(0, 64) : '',
      ...(p.team !== undefined ? { team: p.team } : {}),
      ...(p.hero ? { hero: p.hero.slice(0, 48) } : {}),
      ...(p.connectedFor !== undefined ? { time: Math.floor(p.connectedFor) } : {}),
    })),
    plugins: installed.plugins,
    content: installed.content,
    metadata,
    links: config.links,
    software: { name: HOST_SOFTWARE, version: HOST_VERSION },
  });
}

export interface HeartbeaterDeps {
  config: () => HostConfig;
  state: () => ServerState;
  contributions: () => ListingContributions;
  installed: () => Promise<InstalledInfo>;
  log: Logger;
  fetch?: typeof fetch;
  /** Overrides the interval (ms) suggested by the master; used by tests. */
  intervalMs?: number;
}

export type HeartbeatOutcome = 'sent' | 'skipped' | 'failed' | 'rejected';

export class Heartbeater {
  private timer?: NodeJS.Timeout;
  private failures = 0;
  private intervalMs: number;
  private running = false;
  private inFlight?: Promise<HeartbeatOutcome>;
  /** True once a heartbeat for the current listing has been accepted. */
  listed = false;

  constructor(private readonly deps: HeartbeaterDeps) {
    this.intervalMs = deps.intervalMs ?? HEARTBEAT_INTERVAL * 1000;
  }

  private endpoint(path: string): { url: string; token: string } | undefined {
    const { master } = this.deps.config();
    if (!master.listed || !master.serverId || !master.token) return undefined;
    return { url: `${master.url.replace(/\/+$/, '')}/v1/servers/${encodeURIComponent(master.serverId)}/${path}`, token: master.token };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    if (!this.endpoint('heartbeat')) {
      this.deps.log.info('Not listing this server: set master.serverId/token with `citadel-host register` (or master.listed is false).');
    }
    this.schedule(0);
  }

  private schedule(ms: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.beat(), ms);
  }

  private async beat(): Promise<void> {
    const outcome = await this.sendNow();
    if (outcome === 'failed' || outcome === 'rejected') {
      this.failures++;
      // 401/404 will not fix itself quickly; retry slowly in case the admin re-registers.
      const backoff = outcome === 'rejected' ? 300_000 : Math.min(this.intervalMs * 2 ** this.failures, 300_000);
      this.schedule(backoff);
    } else {
      this.failures = 0;
      this.schedule(this.intervalMs);
    }
  }

  /** Sends one heartbeat now (if the server is running and listable). */
  sendNow(): Promise<HeartbeatOutcome> {
    this.inFlight ??= this.doSend().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async doSend(): Promise<HeartbeatOutcome> {
    const target = this.endpoint('heartbeat');
    const state = this.deps.state();
    if (!target || state.phase !== 'running') return 'skipped';
    if (!state.steamId && !this.deps.config().publicAddress) {
      this.deps.log.debug('Heartbeat waits for the server SteamID (or set publicAddress).');
      return 'skipped';
    }
    let body: Heartbeat;
    try {
      body = buildHeartbeat(this.deps.config(), state, this.deps.contributions(), await this.deps.installed());
    } catch (err) {
      this.deps.log.error(`Heartbeat not sent, the listing is invalid: ${(err as Error).message}`);
      return 'failed';
    }
    const doFetch = this.deps.fetch ?? fetch;
    try {
      const res = await doFetch(target.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${target.token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        this.listed = false;
        this.deps.log.error(
          res.status === 404
            ? 'The master does not know this server id (404). It may have been deleted; run `citadel-host register` again.'
            : `The master rejected this server's token (${res.status}). Rotate it or run \`citadel-host register\` again.`,
        );
        return 'rejected';
      }
      if (!res.ok) {
        this.deps.log.warn(`Heartbeat failed: HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
        return 'failed';
      }
      const data = (await res.json().catch(() => ({}))) as Partial<HeartbeatResponse>;
      if (!this.listed) this.deps.log.info(`Listed on ${this.deps.config().master.url}${data.verified ? ' (verified)' : ''}`);
      this.listed = true;
      if (this.deps.intervalMs === undefined && typeof data.interval === 'number' && data.interval >= 10 && data.interval <= 300) {
        this.intervalMs = data.interval * 1000;
      }
      return 'sent';
    } catch (err) {
      this.deps.log.warn(`Heartbeat failed: ${(err as Error).message}`);
      return 'failed';
    }
  }

  /** Stops the loop and, if we were listed, tells the master we are gone. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.inFlight?.catch(() => {});
    await this.sendOffline();
  }

  async sendOffline(): Promise<void> {
    const target = this.endpoint('offline');
    if (!target || !this.listed) return;
    this.listed = false;
    try {
      await (this.deps.fetch ?? fetch)(target.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${target.token}` },
        signal: AbortSignal.timeout(5000),
      });
      this.deps.log.info('Delisted from the master.');
    } catch (err) {
      this.deps.log.warn(`Could not delist: ${(err as Error).message}`);
    }
  }
}
