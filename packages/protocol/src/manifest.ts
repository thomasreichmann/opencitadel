/**
 * plugin.json — the manifest at the root of every OpenCitadel package.
 *
 * Three kinds of package share one format and one registry:
 *  - `host`      JavaScript plugins run by `citadel-host` beside the game server process. They see
 *                server events (from RCON, the console log and the optional in-game bridge) and
 *                can run commands, answer chat commands and shape the server's browser listing.
 *  - `deadworks` .NET plugins for the Deadworks in-process framework; the host installs their
 *                assemblies into `game/bin/win64/managed/plugins`.
 *  - `content`   VPKs (maps, VData mods, models). Server-side they are mounted for the game
 *                server; files marked `client: true` are advertised in the listing so the
 *                browser can download and verify them before a player joins.
 */

import { v, parse, ValidationError, type Infer } from './validate.js';
import { isValidRange, isValidVersion } from './semver.js';

export const PLUGIN_KINDS = ['host', 'deadworks', 'content'] as const;
export type PluginKind = (typeof PLUGIN_KINDS)[number];

/**
 * Capabilities a host plugin must declare to use the matching API. The host enforces them on
 * the plugin's context object and shows them to the admin at install time. This is a
 * declaration and review aid, not a sandbox: host plugins run in the host's process.
 */
export const PERMISSIONS = {
  'server.command': 'Run arbitrary server console commands',
  'server.chat': 'Send chat messages to players',
  'players.manage': 'Kick players and change teams',
  'listing.write': 'Change the server listing (tags, game mode, metadata)',
  'network': 'Make outbound network requests',
  'storage': 'Persist data on the host',
} as const;
export type Permission = keyof typeof PERMISSIONS;

export const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/;

export const versionV = (value: unknown, path: string): string => {
  const s = v.string({ max: 64 })(value, path);
  if (!isValidVersion(s)) throw new ValidationError(path, 'must be a semver version like 1.2.3');
  return s;
};

const rangeV = (value: unknown, path: string): string => {
  const s = v.string({ max: 128 })(value, path);
  if (!isValidRange(s)) throw new ValidationError(path, 'must be a version range like ^1.2.0');
  return s;
};

const configField = v.object({
  type: v.literal(['string', 'number', 'integer', 'boolean', 'string[]', 'object'] as const),
  description: v.optional(v.string({ max: 500 })),
  default: v.optional(v.json({ maxBytes: 16 * 1024 })),
  /** Never shown in listings or logs (API keys, webhook URLs). */
  secret: v.optional(v.bool()),
});
export type ConfigField = Infer<typeof configField>;

const contentFile = v.object({
  /** Path inside the package, e.g. `pak01_dir.vpk`. */
  file: v.string({ max: 200, pattern: /^[A-Za-z0-9_./-]+\.vpk$/ }),
  /** Players must have this file to join (custom maps, VData changes, models). */
  client: v.withDefault(v.bool(), false),
});

export const pluginManifestValidator = v.object({
  id: v.string({ pattern: PLUGIN_ID }),
  name: v.string({ min: 1, max: 80 }),
  version: versionV,
  kind: v.literal(PLUGIN_KINDS),
  description: v.withDefault(v.string({ max: 1000 }), ''),
  author: v.optional(v.string({ max: 120 })),
  license: v.optional(v.string({ max: 64 })),
  homepage: v.optional(v.string({ max: 300, pattern: /^https:\/\// })),
  /** Source repository. The registry shows it so reviewers can compare a package with its source. */
  repository: v.optional(v.string({ max: 300, pattern: /^https:\/\/\S+$/ })),
  tags: v.withDefault(v.array(v.string({ max: 32, pattern: /^[a-z0-9-]+$/ }), { max: 16 }), []),
  /** host: ESM entry point inside the package. */
  main: v.optional(v.string({ max: 200 })),
  /** deadworks: assemblies (and their dependencies) to copy into managed/plugins. */
  assemblies: v.optional(v.array(v.string({ max: 200, pattern: /^[A-Za-z0-9_./-]+\.(dll|pdb|json)$/ }), { max: 64 })),
  /** content: VPKs this package provides. */
  content: v.optional(v.array(contentFile, { max: 64 })),
  /** content: map names (without extension) this package adds. */
  maps: v.optional(v.array(v.string({ max: 64, pattern: /^[a-z0-9_]+$/ }), { max: 32 })),
  engines: v.withDefault(v.record(rangeV, { maxKeys: 8 }), {}),
  dependencies: v.withDefault(v.record(rangeV, { maxKeys: 32, key: v.string({ pattern: PLUGIN_ID }) }), {}),
  permissions: v.withDefault(v.array(v.literal(Object.keys(PERMISSIONS) as Permission[]), { max: 16 }), []),
  config: v.withDefault(v.record(configField, { maxKeys: 64, key: v.string({ max: 64, pattern: /^[A-Za-z][A-Za-z0-9_]*$/ }) }), {}),
});

export type PluginManifest = Infer<typeof pluginManifestValidator>;

/** Validates a parsed plugin.json, including the cross-field rules each kind needs. */
export function parseManifest(json: unknown): PluginManifest {
  const m = parse(pluginManifestValidator, json);
  if (m.kind === 'host' && !m.main) throw new ValidationError('main', 'host plugins need an entry point');
  if (m.kind === 'deadworks' && !m.assemblies?.some((a) => a.endsWith('.dll'))) throw new ValidationError('assemblies', 'deadworks plugins need at least one .dll');
  if (m.kind === 'content' && !m.content?.length) throw new ValidationError('content', 'content packages need at least one .vpk');
  return m;
}

/** Fills in config defaults declared in the manifest beneath values supplied by the admin. */
export function resolvePluginConfig(manifest: PluginManifest, supplied: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(manifest.config)) {
    const value = key in supplied ? supplied[key] : field.default;
    if (value === undefined) continue;
    const ok =
      field.type === 'string' ? typeof value === 'string'
      : field.type === 'number' ? typeof value === 'number'
      : field.type === 'integer' ? Number.isInteger(value)
      : field.type === 'boolean' ? typeof value === 'boolean'
      : field.type === 'string[]' ? Array.isArray(value) && value.every((x) => typeof x === 'string')
      : typeof value === 'object' && value !== null;
    if (!ok) throw new Error(`config.${key} must be of type ${field.type}`);
    out[key] = value;
  }
  return out;
}
