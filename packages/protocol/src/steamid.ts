/**
 * SteamID helpers. Deadlock dedicated servers log on to Steam anonymously and get a fresh
 * `[A:1:<account>:<instance>]` id on every launch; players connect to that id over Steam
 * Datagram Relay with `connect [A:1:...]`, so the host must re-read and re-publish it after
 * each start. Servers with a Game Server Login Token keep a stable `[G:1:<account>]` id.
 */

const TYPE_CHARS: Record<string, number> = { U: 1, G: 3, A: 4 };
const TYPE_LETTERS: Record<number, string> = { 1: 'U', 3: 'G', 4: 'A' };

export interface SteamId {
  universe: number;
  type: number;
  account: number;
  instance: number;
}

const STEAM3 = /^\[([UGA]):([0-5]):(\d{1,10})(?::(\d{1,7}))?\]$/;

export function parseSteam3(text: string): SteamId | undefined {
  const m = STEAM3.exec(text.trim());
  if (!m) return undefined;
  const account = Number(m[3]);
  if (account > 0xffffffff) return undefined;
  const type = TYPE_CHARS[m[1]!]!;
  const instance = m[4] !== undefined ? Number(m[4]) : type === 1 ? 1 : 0;
  if (instance > 0xfffff) return undefined;
  return { universe: Number(m[2]), type, account, instance };
}

export function formatSteam3(id: SteamId): string {
  const letter = TYPE_LETTERS[id.type] ?? '?';
  return letter === 'A' ? `[A:${id.universe}:${id.account}:${id.instance}]` : `[${letter}:${id.universe}:${id.account}]`;
}

export function toSteam64(id: SteamId): string {
  const v = (BigInt(id.universe) << 56n) | (BigInt(id.type) << 52n) | (BigInt(id.instance) << 32n) | BigInt(id.account);
  return v.toString();
}

export function fromSteam64(text: string): SteamId | undefined {
  if (!/^\d{1,20}$/.test(text)) return undefined;
  const v = BigInt(text);
  if (v > 0xffffffffffffffffn) return undefined;
  return {
    universe: Number(v >> 56n),
    type: Number((v >> 52n) & 0xfn),
    instance: Number((v >> 32n) & 0xfffffn),
    account: Number(v & 0xffffffffn),
  };
}

/** True for ids a client can `connect` to: anonymous or persistent game server ids. */
export function isServerSteamId(text: string): boolean {
  const id = parseSteam3(text);
  return !!id && (id.type === 3 || id.type === 4);
}

/** `[A:1:123:456]` or a `host:port` address — the two things `connect` accepts. */
export const CONNECT_TARGET = /^(\[[AG]:1:\d{1,10}(?::\d{1,7})?\]|[A-Za-z0-9.-]{1,253}:\d{1,5})$/;
