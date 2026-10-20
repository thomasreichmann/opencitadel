/**
 * How a player gets from a listing into a server.
 *
 * - `host:port` targets use `steam://connect/<host:port>[/<password>]`, which the Deadworks
 *   launcher also uses for Deadlock.
 * - SteamID targets (`[A:1:…]`, joined over Steam Datagram Relay) have no dedicated Steam URL,
 *   so they launch the game with `+connect` via `steam://run/<appid>//<args>/`. Steam asks the
 *   player to confirm launch arguments. If the game is already running, Steam does not forward
 *   the arguments; the browser falls back to showing the console command (F7 console, enabled
 *   under Settings → "Dev command console").
 */

import { DEADLOCK_APP_ID_STR } from './constants.js';
import type { ConnectInfo } from './listing.js';

export type ConnectTarget = { kind: 'address'; value: string } | { kind: 'steamId'; value: string };

/** Prefers a verified address (directly reachable), otherwise the SDR SteamID, otherwise any address. */
export function pickConnectTarget(connect: ConnectInfo, verified = false): ConnectTarget | undefined {
  if (connect.address && verified) return { kind: 'address', value: connect.address };
  if (connect.steamId) return { kind: 'steamId', value: connect.steamId };
  if (connect.address) return { kind: 'address', value: connect.address };
  return undefined;
}

/** The console command a player can paste into the F7 console. */
export function connectCommand(target: ConnectTarget, password?: string): string {
  const pw = password ? `password "${password.replace(/"/g, '')}"; ` : '';
  return `${pw}connect ${target.value}`;
}

export function steamJoinUrl(target: ConnectTarget, password?: string): string {
  if (target.kind === 'address') {
    return `steam://connect/${target.value}${password ? `/${encodeURIComponent(password)}` : ''}`;
  }
  const args = [...(password ? ['+password', `"${password.replace(/"/g, '')}"`] : []), '+connect', target.value];
  return `steam://run/${DEADLOCK_APP_ID_STR}//${encodeURIComponent(args.join(' '))}/`;
}
