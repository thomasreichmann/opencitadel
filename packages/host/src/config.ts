/**
 * server.json — the host's configuration. See docs/ARCHITECTURE.md ("Host") for the meaning of
 * each field. Loaded with defaults filled in and validated; saved with mode 0600 because it
 * holds the server token and the RCON password.
 */

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DEFAULT_BRIDGE_PORT, DEFAULT_GAME_PORT, DEFAULT_MAP, DEFAULT_MASTER_PORT, REGIONS, parse, v, type Infer, type Validator } from '@opencitadel/protocol';

/** A config section that may be omitted entirely; its fields' own defaults then apply. */
const section = <T>(inner: Validator<T>): Validator<T> => (value, path) => inner(value ?? {}, path);

const tag = v.string({ min: 1, max: 24, pattern: /^[a-z0-9][a-z0-9_-]*$/ });

export const hostConfigValidator = v.object({
  name: v.withDefault(v.string({ min: 1, max: 64 }), 'OpenCitadel Server'),
  description: v.withDefault(v.string({ max: 500 }), ''),
  region: v.optional(v.literal(REGIONS)),
  country: v.optional(v.string({ pattern: /^[A-Z]{2}$/ })),
  tags: v.withDefault(v.array(tag, { max: 16 }), []),
  links: section(
    v.object({
      website: v.optional(v.string({ max: 300, pattern: /^https:\/\/\S+$/ })),
      discord: v.optional(v.string({ max: 300, pattern: /^https:\/\/\S+$/ })),
    }),
  ),
  game: section(
    v.object({
      path: v.optional(v.string({ max: 1000 })),
      executable: v.withDefault(v.literal(['deadlock', 'deadworks'] as const), 'deadlock'),
      wrapper: v.withDefault(v.array(v.string({ max: 300 }), { max: 8 }), []),
      map: v.withDefault(v.string({ min: 1, max: 64, pattern: /^[A-Za-z0-9_]+$/ }), DEFAULT_MAP),
      port: v.withDefault(v.int({ min: 1, max: 65535 }), DEFAULT_GAME_PORT),
      password: v.withDefault(v.string({ max: 64, trim: false }), ''),
      maxPlayers: v.withDefault(v.int({ min: 1, max: 64 }), 12),
      convars: v.withDefault(v.record(v.string({ max: 500 }), { maxKeys: 256, key: v.string({ max: 64, pattern: /^[A-Za-z0-9_]+$/ }) }), {}),
      extraArgs: v.withDefault(v.array(v.string({ max: 500 }), { max: 64 }), []),
      patchGameinfo: v.withDefault(v.bool(), true),
      logSource: v.withDefault(v.literal(['condebug', 'stdout'] as const), 'condebug'),
    }),
  ),
  rcon: section(
    v.object({
      enabled: v.withDefault(v.bool(), true),
      password: v.withDefault(v.string({ max: 128, trim: false }), ''),
    }),
  ),
  publicAddress: v.optional(v.string({ max: 260, pattern: /^[A-Za-z0-9.-]+:\d{1,5}$/ })),
  master: section(
    v.object({
      url: v.withDefault(v.string({ max: 500, pattern: /^https?:\/\/\S+$/ }), `http://localhost:${DEFAULT_MASTER_PORT}`),
      serverId: v.optional(v.string({ max: 64 })),
      token: v.optional(v.string({ max: 200 })),
      listed: v.withDefault(v.bool(), true),
    }),
  ),
  restart: section(
    v.object({
      onCrash: v.withDefault(v.bool(), true),
      maxBackoffSeconds: v.withDefault(v.int({ min: 5, max: 3600 }), 300),
      dailyAt: v.optional(v.string({ pattern: /^([01]\d|2[0-3]):[0-5]\d$/ })),
    }),
  ),
  admins: v.withDefault(v.array(v.string({ max: 40 }), { max: 256 }), []),
  privacy: section(
    v.object({
      /** Publish player names in the listing. Off by default: the count, heroes and teams are enough to pick a server. */
      showPlayerNames: v.withDefault(v.bool(), false),
    }),
  ),
  security: section(
    v.object({
      /** Refuse to install packages that are not signed. */
      requireSignatures: v.withDefault(v.bool(), false),
      /**
       * Signing keys accepted per plugin id (`"*"` applies to every plugin). Prefer full minisign
       * public keys (`RWQ…`): a bare 16-hex key id is only a label, so its key material still
       * has to come from the registry or an earlier pin. Plugins without an entry are pinned to
       * the first key seen (trust on first use).
       */
      trustedKeys: v.withDefault(
        v.record(v.array(v.string({ max: 60, pattern: /^(?:[0-9A-F]{16}|RW[A-Za-z0-9+/]{54})$/ }), { max: 16 }), { maxKeys: 256 }),
        {},
      ),
    }),
  ),
  bridge: section(
    v.object({
      enabled: v.withDefault(v.bool(), true),
      port: v.withDefault(v.int({ min: 1, max: 65535 }), DEFAULT_BRIDGE_PORT),
    }),
  ),
  plugins: v.withDefault(
    v.record(
      v.object({
        enabled: v.withDefault(v.bool(), true),
        config: v.withDefault(v.record(v.json({ maxBytes: 64 * 1024 }), { maxKeys: 128 }), {}),
        /** Run in the WebAssembly sandbox. `false` gives the plugin full access to this machine. */
        sandbox: v.withDefault(v.bool(), true),
        /** Sandbox heap cap. */
        memoryMb: v.withDefault(v.int({ min: 8, max: 1024 }), 64),
        /** CPU time allowed for each call into a sandboxed plugin. */
        timeLimitMs: v.withDefault(v.int({ min: 10, max: 60_000 }), 1000),
        /** Let a sandboxed plugin's fetch reach loopback, LAN and link-local addresses. */
        allowPrivateNetwork: v.withDefault(v.bool(), false),
      }),
      { maxKeys: 256 },
    ),
    {},
  ),
});

export type HostConfig = Infer<typeof hostConfigValidator>;
export type PluginSettings = HostConfig['plugins'][string];

/** Settings for a plugin entry, keeping any existing values and filling in the defaults. */
export function pluginSettings(overrides: Partial<PluginSettings> = {}, existing?: PluginSettings): PluginSettings {
  const defaults = parseHostConfig({ plugins: { x: {} } }).plugins.x!;
  return { ...defaults, ...existing, ...overrides };
}

export const CONFIG_FILE = 'server.json';
export const STATE_DIR = '.opencitadel';

/** Paths under a server directory. */
export function hostPaths(serverDir: string) {
  const state = join(serverDir, STATE_DIR);
  return {
    serverDir,
    config: join(serverDir, CONFIG_FILE),
    stateDir: state,
    stateFile: join(state, 'state.json'),
    installed: join(state, 'installed.json'),
    pluginsDir: join(state, 'plugins'),
    dataDir: join(state, 'data'),
    cacheDir: join(state, 'cache'),
    logsDir: join(state, 'logs'),
  };
}

/** Validates raw JSON into a config with every default filled in. */
export function parseHostConfig(raw: unknown): HostConfig {
  return parse(hostConfigValidator, raw ?? {});
}

export function defaultHostConfig(): HostConfig {
  const config = parseHostConfig({});
  config.rcon.password = randomBytes(18).toString('base64url');
  return config;
}

export async function loadHostConfig(serverDir: string): Promise<HostConfig> {
  const file = hostPaths(serverDir).config;
  if (!existsSync(file)) throw new Error(`No ${CONFIG_FILE} in ${serverDir}. Run \`citadel-host init\` first.`);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  return parseHostConfig(raw);
}

/** Writes atomically (temp file + rename) with owner-only permissions. */
export async function saveHostConfig(serverDir: string, config: HostConfig): Promise<void> {
  const file = hostPaths(serverDir).config;
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  await rename(tmp, file);
  await chmod(file, 0o600).catch(() => {});
}
