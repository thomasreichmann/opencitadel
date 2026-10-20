/**
 * Merges events from the three sources (in-game bridge, RCON `status` polling, console log)
 * into one stream where each real-world event appears once.
 *
 * - Player events are taken from the highest-priority source that is currently live
 *   (bridge > rcon > log); lower sources are ignored for them while a higher one is up. Chat comes
 *   from the bridge when it is live, otherwise from the log (RCON never sees chat).
 * - Presence is tracked (matching on SteamID, else name), so a join is never announced twice.
 * - `map.changed` fires only when the map actually changes; `server.ready` once per launch.
 */

import type { EventName, Player, PluginEvents } from '@opencitadel/plugin-sdk';

export type EventSource = 'bridge' | 'rcon' | 'log';

const RANK: Record<EventSource, number> = { log: 1, rcon: 2, bridge: 3 };

export type BusListener = <E extends EventName>(event: E, payload: PluginEvents[E], source: EventSource) => void;

const CHAT_DEDUPE_MS = 2000;

function samePlayer(a: Player, b: Player): boolean {
  if (a.steamId64 && b.steamId64) return a.steamId64 === b.steamId64;
  if (a.steamId && b.steamId) return a.steamId === b.steamId;
  // RCON `status` has names but no SteamIDs, and its ids are userids rather than slots.
  return !!a.name && a.name.toLowerCase() === b.name.toLowerCase();
}

/** Copies defined fields of `from` onto `into`. */
function enrich(into: Player, from: Player): void {
  for (const [k, v] of Object.entries(from)) if (v !== undefined) (into as unknown as Record<string, unknown>)[k] = v;
}

export class EventBus {
  private readonly listeners: BusListener[] = [];
  private readonly live = new Set<EventSource>(['log']);
  private present: Player[] = [];
  private map: string | undefined;
  private ready = false;
  private recentChat: Array<{ key: string; at: number }> = [];

  constructor(private readonly now: () => number = Date.now) {}

  on(listener: BusListener): void {
    this.listeners.push(listener);
  }

  /** Marks a source live or not. Going live or dead never emits events by itself. */
  setLive(source: EventSource, live: boolean): void {
    if (live) this.live.add(source);
    else if (source !== 'log') this.live.delete(source);
  }

  isLive(source: EventSource): boolean {
    return this.live.has(source);
  }

  /** Forgets per-launch state; call before each server start. */
  resetForLaunch(): void {
    this.present = [];
    this.map = undefined;
    this.ready = false;
    this.recentChat = [];
    this.live.clear();
    this.live.add('log');
  }

  players(): Player[] {
    return this.present.map((p) => ({ ...p }));
  }

  currentMap(): string | undefined {
    return this.map;
  }

  isReady(): boolean {
    return this.ready;
  }

  private topLive(): number {
    let top = 0;
    for (const s of this.live) top = Math.max(top, RANK[s]);
    return top;
  }

  private authoritative(source: EventSource): boolean {
    return RANK[source] >= this.topLive();
  }

  private emit<E extends EventName>(event: E, payload: PluginEvents[E], source: EventSource): void {
    for (const l of this.listeners) l(event, payload, source);
  }

  /** Publishes one event. Returns true if it was emitted (not filtered as a duplicate). */
  publish<E extends EventName>(source: EventSource, event: E, payload: PluginEvents[E]): boolean {
    switch (event) {
      case 'player.connected': {
        const { player } = payload as PluginEvents['player.connected'];
        const existing = this.present.find((p) => samePlayer(p, player));
        if (existing) {
          // A later or better source may know more about someone we already announced.
          enrich(existing, player);
          return false;
        }
        if (!this.authoritative(source)) return false;
        this.present.push({ ...player });
        break;
      }
      case 'player.disconnected': {
        const { player } = payload as PluginEvents['player.disconnected'];
        if (!this.authoritative(source)) return false;
        const idx = this.present.findIndex((p) => samePlayer(p, player));
        if (idx === -1) return false;
        const [gone] = this.present.splice(idx, 1);
        payload = { ...payload, player: { ...gone!, ...stripUndefined(player) } } as PluginEvents[E];
        break;
      }
      case 'chat.message': {
        const chat = payload as PluginEvents['chat.message'];
        // RCON never reports chat, so only a live bridge outranks the log here.
        if (source !== 'bridge' && this.live.has('bridge')) return false;
        const t = this.now();
        this.recentChat = this.recentChat.filter((c) => t - c.at < CHAT_DEDUPE_MS);
        const key = `${(chat.player.steamId64 ?? chat.player.steamId ?? chat.player.name).toLowerCase()}\u0000${chat.message}\u0000${chat.teamOnly}`;
        if (this.recentChat.some((c) => c.key === key)) return false;
        this.recentChat.push({ key, at: t });
        // Fill in what presence knows about the speaker (e.g. SteamID from the bridge).
        const known = this.present.find((p) => samePlayer(p, chat.player));
        if (known) payload = { ...chat, player: { ...known, ...stripUndefined(chat.player) } } as PluginEvents[E];
        break;
      }
      case 'map.changed': {
        const { map } = payload as PluginEvents['map.changed'];
        if (map === this.map) return false;
        const previous = this.map;
        this.map = map;
        payload = (previous ? { map, previous } : { map }) as PluginEvents[E];
        break;
      }
      case 'server.ready': {
        if (this.ready) return false;
        this.ready = true;
        const { map } = payload as PluginEvents['server.ready'];
        if (map && !this.map) this.map = map;
        break;
      }
    }
    this.emit(event, payload, source);
    return true;
  }

  /**
   * Applies a full roster snapshot (e.g. from `status`): emits joins and leaves relative to the
   * current presence when `source` is authoritative, and otherwise only refreshes details such as
   * ping for players already known.
   */
  reconcile(source: EventSource, roster: Player[]): void {
    if (!this.authoritative(source)) {
      for (const p of this.present) {
        const fresh = roster.find((r) => samePlayer(p, r));
        if (fresh) {
          if (fresh.ping !== undefined) p.ping = fresh.ping;
          if (fresh.connectedFor !== undefined) p.connectedFor = fresh.connectedFor;
        }
      }
      return;
    }
    for (const p of [...this.present]) {
      if (!roster.some((r) => samePlayer(p, r))) this.publish(source, 'player.disconnected', { player: p });
    }
    for (const r of roster) this.publish(source, 'player.connected', { player: r });
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
