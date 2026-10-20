export const DEADLOCK_APP_ID = 1422450;
export const DEADLOCK_APP_ID_STR = '1422450';

/** Default game port (`+hostport`). Also the RCON (TCP) and A2S (UDP) port. */
export const DEFAULT_GAME_PORT = 27015;
/** Default loopback port the host listens on for the in-game bridge. */
export const DEFAULT_BRIDGE_PORT = 27100;
/** Default port for `citadel-browser ui`. */
export const DEFAULT_CLIENT_UI_PORT = 47900;
/** Default port for `citadel-master`. */
export const DEFAULT_MASTER_PORT = 8080;

/** Seconds between native heartbeats, and how long a listing lives without one. */
export const HEARTBEAT_INTERVAL = 30;
export const HEARTBEAT_TTL = 90;
/** Deadworks heartbeats default to every 90 s, so its listings get a longer lease. */
export const DEADWORKS_HEARTBEAT_TTL = 240;

/** Secret prefixes make leaked credentials easy to recognise and scan for. */
export const ACCOUNT_KEY_PREFIX = 'ock_';
export const SERVER_TOKEN_PREFIX = 'ocs_';

export const DEFAULT_MAP = 'dl_midtown';
