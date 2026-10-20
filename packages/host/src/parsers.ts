/**
 * Parsers for what the dedicated server prints: individual console-log lines and RCON `status`
 * output. Both are tolerant — Deadlock's exact wording is not documented, so they accept the
 * Source 2 (CS2-style) layout first and the Source 1 layout as a fallback, and ignore the rest.
 */

import { fromSteam64, parseSteam3, formatSteam3, toSteam64 } from '@opencitadel/protocol';

const MAP_NAME = '[A-Za-z0-9_./-]+';

export type LogEvent =
  | { kind: 'steamId'; steamId: string }
  | { kind: 'map'; map: string }
  | { kind: 'chat'; name: string; userId?: number; steamId?: string; team?: string; message: string; teamOnly: boolean }
  | { kind: 'connected'; name: string; userId?: number; steamId?: string; address?: string }
  | { kind: 'disconnected'; name: string; userId?: number; steamId?: string; reason?: string }
  | { kind: 'gameState'; state: string; id: number };

/**
 * Deadlock's match phases, from `ChangeGameState: GameInProgress (7)` (build 6796): Init (1),
 * WaitingForPlayersToJoin (2), HeroSelection (3), MatchIntro (4), WaitForMapToLoad (5),
 * PreGameWait (6), GameInProgress (7), PostGame (8), End (11).
 */
const GAME_STATE = /^ChangeGameState: ([A-Za-z]{1,40}) \((\d{1,3})\)$/;

const SERVER_STEAMID = /\[(?:A:1:\d{1,10}:\d{1,7}|G:1:\d{1,10})\]/;
const SERVER_STEAMID_SRC = '\\[(?:A:1:\\d{1,10}:\\d{1,7}|G:1:\\d{1,10})\\]';

function isGameServer64(id64: string): string | undefined {
  const id = fromSteam64(id64);
  return id && (id.type === 3 || id.type === 4) && id.universe === 1 ? formatSteam3(id) : undefined;
}

/**
 * The engine lines that announce the server's own SteamID. Each pattern must match the whole
 * line. Player names (at most 32 characters) can appear at the start of other engine lines, but
 * never fill one of these on their own, so a player called `[A:1:5:5]` can't redirect joins.
 */
const SERVER_ID_LINES: Array<(line: string) => string | undefined> = [
  // Deadlock: `SV:  ServerSteamID=[A:1:570253314:51555] (90293420156608514).` The two forms must agree.
  (line) => {
    const m = new RegExp(`^(?:SV:\\s+)?ServerSteamID=(${SERVER_STEAMID_SRC}) \\((\\d{15,20})\\)\\.?$`).exec(line);
    return m && isGameServer64(m[2]!) === m[1] ? m[1] : undefined;
  },
  // Deadlock: `Gameserver logged on to Steam, assigned identity steamid:90293419965850626`
  (line) => {
    const m = /^Gameserver logged on to Steam, assigned identity steamid:(\d{15,20})$/.exec(line);
    return m ? isGameServer64(m[1]!) : undefined;
  },
  // Source style: `SV:  Assigned anonymous gameserver Steam ID [A:1:…:…].`
  (line) => new RegExp(`^(?:SV:\\s+)?Assigned (?:anonymous|persistent) gameserver Steam ID (${SERVER_STEAMID_SRC})\\.?$`).exec(line)?.[1],
];

const MAP_PATTERNS = [
  // Source 2: `loaded spawngroup(  1)  : SV:  [1: dl_midtown | main lump | mapload]`
  new RegExp(`\\[\\d+:\\s*(${MAP_NAME})\\s*\\|\\s*main lump\\s*\\|\\s*mapload\\s*\\]`),
  // Source 2: `SV:  Spawn Server: dl_midtown`
  new RegExp(`Spawn Server:\\s*(${MAP_NAME})`),
  new RegExp(`Host_NewGame on map\\s+(${MAP_NAME})`, 'i'),
  // Source-style logs: `Loading map "dl_midtown"`, `Started map "dl_midtown"`
  new RegExp(`(?:Loading|Started) map "(${MAP_NAME})"`, 'i'),
];

// `"Name<2><[U:1:12345]><Team>"` — the player tag in Source-style server logs.
const PLAYER_TAG = '"(.+?)<(\\d+)><([^>]*)><([^>]*)>"';
const CHAT = new RegExp(`${PLAYER_TAG}\\s+(say|say_team)\\s+"(.*)"\\s*$`);
const CONNECTED = new RegExp(`${PLAYER_TAG}\\s+connected(?:, address "([^"]*)")?`);
const DISCONNECTED = new RegExp(`${PLAYER_TAG}\\s+disconnected(?: \\(reason "([^"]*)"\\))?`);

/** Normalises the uniqueid field of a log tag or status row to `[U:1:n]`, if it is one. */
export function playerSteamId(uniqueId: string): string | undefined {
  const s3 = parseSteam3(uniqueId);
  if (s3 && s3.type === 1) return formatSteam3(s3);
  const s2 = /^STEAM_[0-5]:([01]):(\d{1,10})$/.exec(uniqueId);
  if (s2) return `[U:1:${Number(s2[2]) * 2 + Number(s2[1])}]`;
  return undefined;
}

function tagFields(m: RegExpExecArray) {
  return { name: m[1]!, userId: Number(m[2]), steamId: playerSteamId(m[3]!), team: m[4] || undefined };
}

/**
 * Deadlock prefixes every console line with a timestamp and a channel tag:
 * `10/19 23:56:49 [Server] SV:  ServerSteamID=[A:1:…] (…).` Strips exactly one of each, so the
 * whole-line patterns below see what the engine wrote (and a player name can't add a second).
 */
/**
 * Printed every frame (~60 a second, for as long as the server runs) when the server's stdin is
 * not a console, which it never is under the host. Seen on build 6796 with and without -console.
 */
export function isConsoleNoise(line: string): boolean {
  return /CTextConsoleWin::GetLine: !GetNumberOfConsoleInputEvents\s*$/.test(line);
}

export function stripLogPrefix(line: string): string {
  return line
    .trim()
    .replace(/^\d{2}\/\d{2} \d{2}:\d{2}:\d{2} /, '')
    .replace(/^\[[A-Za-z0-9_ ]{1,32}\] /, '');
}

export function parseLogLine(line: string): LogEvent | undefined {
  const body = stripLogPrefix(line);
  for (const match of SERVER_ID_LINES) {
    const steamId = match(body);
    if (steamId) return { kind: 'steamId', steamId };
  }
  const state = GAME_STATE.exec(body);
  if (state) return { kind: 'gameState', state: state[1]!, id: Number(state[2]) };
  for (const re of MAP_PATTERNS) {
    const m = re.exec(line);
    if (m) return { kind: 'map', map: m[1]! };
  }
  let m = CHAT.exec(line);
  if (m) {
    const { team, ...rest } = tagFields(m);
    return { kind: 'chat', ...rest, ...(team ? { team } : {}), message: m[6]!, teamOnly: m[5] === 'say_team' };
  }
  m = DISCONNECTED.exec(line);
  if (m) {
    const { name, userId, steamId } = tagFields(m);
    return { kind: 'disconnected', name, userId, steamId, ...(m[5] ? { reason: m[5] } : {}) };
  }
  m = CONNECTED.exec(line);
  if (m) {
    const { name, userId, steamId } = tagFields(m);
    return { kind: 'connected', name, userId, steamId, ...(m[5] ? { address: m[5] } : {}) };
  }
  return undefined;
}

export interface StatusPlayer {
  id?: number;
  name: string;
  /** Seconds connected. */
  time?: number;
  ping?: number;
  loss?: number;
  state?: string;
  address?: string;
  steamId?: string;
  steamId64?: string;
  bot?: boolean;
}

export interface StatusInfo {
  hostname?: string;
  map?: string;
  steamId?: string;
  steamId64?: string;
  version?: string;
  localAddress?: string;
  publicIp?: string;
  humans?: number;
  bots?: number;
  maxPlayers?: number;
  players: StatusPlayer[];
}

/** `01:02` → 62, `1:01:02` → 3662. */
export function parseDuration(text: string): number | undefined {
  if (!/^\d+(:\d{1,2}){1,2}$/.test(text)) return undefined;
  return text.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
}

const intOrUndefined = (s: string | undefined): number | undefined => (s !== undefined && /^\d+$/.test(s) ? Number(s) : undefined);

/** A CS2-style row: `    2    01:02   35    0     active 786432 198.51.100.7:27005 'PlayerOne'`. */
function parseSource2Row(line: string): StatusPlayer | undefined {
  const m = /^(.*?)'(.*)'\s*$/.exec(line);
  if (!m) return undefined;
  const tokens = m[1]!.trim().split(/\s+/);
  const id = intOrUndefined(tokens[0]);
  if (id === undefined) return undefined;
  const name = m[2]!;
  const timeToken = tokens[1] ?? '';
  // 65535 / [NoChan] rows are connection slots still challenging, not players.
  if (!name || id === 65535 || timeToken === '[NoChan]') return undefined;
  const player: StatusPlayer = { id, name };
  if (timeToken.toUpperCase() === 'BOT') player.bot = true;
  else player.time = parseDuration(timeToken);
  player.ping = intOrUndefined(tokens[2]);
  player.loss = intOrUndefined(tokens[3]);
  player.state = tokens[4];
  let adr: string | undefined;
  if (tokens.length >= 7) adr = tokens[6];
  else if (tokens[5]) adr = /^\d+(\D.*)$/.exec(tokens[5])?.[1];
  if (adr && adr !== 'unknown' && /:\d+$/.test(adr)) player.address = adr;
  if (adr === 'BOT') player.bot = true;
  // Players connected over Steam Datagram Relay show their SteamID as the address:
  // `0  00:15  0  0  active 196608 [U:1:22202]:0 'Alice'` (Deadlock build 6796).
  const relayed = adr ? /^(\[U:1:\d{1,10}\]):\d+$/.exec(adr) : null;
  if (relayed) {
    const steamId = playerSteamId(relayed[1]!);
    if (steamId) {
      player.steamId = steamId;
      player.steamId64 = toSteam64(parseSteam3(steamId)!);
      delete player.address;
    }
  }
  return player;
}

/** A Source 1 row: `#      2 "PlayerOne" STEAM_1:0:12345 01:02 35 0 active 196608 198.51.100.7:27005`. */
function parseSource1Row(line: string): StatusPlayer | undefined {
  const m = /^#\s*(\d+)\s+(?:\d+\s+)?"(.*)"\s+(\S+)\s*(.*)$/.exec(line);
  if (!m) return undefined;
  const player: StatusPlayer = { id: Number(m[1]), name: m[2]! };
  const uid = m[3]!;
  if (uid === 'BOT') player.bot = true;
  const steamId = playerSteamId(uid);
  if (steamId) {
    player.steamId = steamId;
    player.steamId64 = toSteam64(parseSteam3(steamId)!);
  }
  const rest = m[4]!.trim().split(/\s+/).filter(Boolean);
  if (player.bot) {
    player.state = rest[0];
    return player;
  }
  player.time = parseDuration(rest[0] ?? '');
  player.ping = intOrUndefined(rest[1]);
  player.loss = intOrUndefined(rest[2]);
  player.state = rest[3];
  const adr = rest[5];
  if (adr && /:\d+$/.test(adr)) player.address = adr;
  return player;
}

export function parseStatus(text: string): StatusInfo {
  const info: StatusInfo = { players: [] };
  let inTable = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    if (/^#end\b/.test(line.trim())) break;

    const spawn = MAP_PATTERNS[0]!.exec(line);
    if (spawn && !info.map) {
      info.map = spawn[1];
      continue;
    }
    if (/^-+\s*players\s*-+$/i.test(line.trim())) {
      inTable = true;
      continue;
    }
    // Header rows of either table layout.
    if (/^\s*id\s+time\s+ping/i.test(line) || /^#\s*userid\s+name/i.test(line)) {
      inTable = true;
      continue;
    }
    if (inTable || /^#\s*\d+\s/.test(line)) {
      const player = line.trimStart().startsWith('#') ? parseSource1Row(line.trim()) : parseSource2Row(line);
      if (player) info.players.push(player);
      continue;
    }

    const kv = /^([A-Za-z/ ]+?)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!.trim().toLowerCase();
    const value = kv[2]!.trim();
    switch (key) {
      case 'hostname':
        info.hostname = value;
        break;
      case 'version':
        info.version = value;
        break;
      case 'map':
        info.map = /^(\S+)/.exec(value)?.[1];
        break;
      case 'steamid': {
        const id = SERVER_STEAMID.exec(value)?.[0];
        if (id) info.steamId = id;
        const id64 = /\((\d{15,20})\)/.exec(value)?.[1];
        if (id64) info.steamId64 = id64;
        break;
      }
      case 'udp/ip': {
        info.localAddress = /^(\S+)/.exec(value)?.[1];
        // Deadlock prints `(public 203.0.113.5:27015)`; CS2 prints `(public ip: 203.0.113.5)`.
        const pub = /public(?: ip)?:?\s*(\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F:]*:[0-9a-fA-F:]+)/.exec(value)?.[1];
        if (pub) info.publicIp = pub;
        break;
      }
      case 'players': {
        const m = /(\d+)\s+humans?,\s*(\d+)\s+bots?\s*\((\d+)(?:\/\d+)?\s+max\)/.exec(value);
        if (m) {
          info.humans = Number(m[1]);
          info.bots = Number(m[2]);
          info.maxPlayers = Number(m[3]);
        }
        break;
      }
    }
  }
  return info;
}
