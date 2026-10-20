/**
 * `citadel-host plugin <command>` and `citadel-pkg <command>`: search, install and manage
 * packages; scaffold, sign, pack and publish your own. Both binaries share this code; citadel-pkg
 * runs it against a Deadlock install instead of a server directory and handles only deadworks and
 * content packages.
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { PLUGIN_KINDS, parse, parsePublicKey, trustedPublisherInputValidator, type PluginKind, type TrustedPublisher } from '@opencitadel/protocol';
import { hostPaths, pluginSettings } from '../config.js';
import type { RunPluginCli, PluginCliContext } from '../services.js';
import { auditInstalled, formatMatch, isSerious } from './audit.js';
import { describePermissions, installFromFile, installFromRegistry, removePackage, trustLabel, type InstallOptions, type InstallOutcome } from './install.js';
import { packageStore, readInstalled, type PackageStore, type StoreLocation } from './installed.js';
import { createSigningKey, findSigningKey, readPublicKey, signingPassphrase } from './keys.js';
import { readLockfile, syncLockfile, writeLockfile } from './lock.js';
import { describeProvenance, githubActionsOidc, trustedPublishToken } from './oidc.js';
import { packPluginToFile, publishPlugin, signPackageFile } from './pack.js';
import { RegistryClient } from './registry.js';
import { scaffoldPlugin, PUBLISH_COMMAND } from './scaffold.js';

export const PLUGIN_USAGE = `Usage: citadel-host plugin <command>

Find and install
  search [query] [--kind host|deadworks|content]   Search the registry
  info <id>                                        Show a package, its versions and signatures
  install <id>[@range] | <file.tgz> [--disabled]   Install a package and its dependencies
      [--accept-new-key] [--allow-unsigned] [--key-file <pub>]
  remove <id> [--force] [--keep-config]            Remove a package and exactly its files
  list                                             Installed packages
  enable <id> | disable <id>                       Toggle a host plugin in server.json
  audit                                            Check installed packages against security advisories
  lock [--lockfile <file>]                         Write plugins.lock.json from what is installed
  sync [--lockfile <file>]                         Install exactly the lockfile's packages

Make and publish
  new <dir> [--kind host|deadworks|content] [--id <id>]   Scaffold a new plugin
  pack <dir> [--out <file.tgz>]                    Build a package
  keygen [--out <file>]                            Create a signing key (OPENCITADEL_SIGNING_PASSPHRASE encrypts it)
  key register [<key or .pub file>] [--label <l>]  Register your public key with your registry account
  sign <file.tgz> [--key <file>]                   Write <file.tgz>.minisig
  publish <dir|file.tgz> [--key <file>] [--no-sign] [--oidc]
                                                   Publish (signed when a key is found); --oidc uses
                                                   trusted publishing from GitHub Actions (the default
                                                   there when no account key is given)

Publish from CI (trusted publishing; owner commands need --api-key)
  trusted-publisher add <id> --repo <owner/repo> --workflow <file.yml>
      [--environment <name>] [--ref <pattern>] [--require]
  trusted-publisher list <id>
  trusted-publisher remove <id> <publisher-id>
  trusted-publisher require <id> [--off]           Only accept new versions from trusted publishers

  --master <url>    Registry to use (default: OPENCITADEL_MASTER, then master.url from server.json)
  --api-key <key>   Account key for key register, trusted-publisher and publish (or OPENCITADEL_API_KEY)
  --json            Machine-readable output (search, info, list, audit, trusted-publisher list)

  OPENCITADEL_SIGNING_KEY may be a key file path or, for CI secrets, the key file's contents.`;

export const PKG_USAGE = `Usage: citadel-pkg [--game <Deadlock dir>] [--registry <url>] <command>

Installs Deadworks plugins and content packs from an OpenCitadel registry into a Deadlock
install, without citadel-host. State lives in game/bin/win64/configs/opencitadel/.

  search [query] [--kind deadworks|content]        Search the registry
  info <id>                                        Show a package, its versions and signatures
  install <id>[@range] | <file.tgz>                Install a package and its dependencies
      [--accept-new-key] [--allow-unsigned] [--key-file <pub>]
  remove <id> [--force]                            Remove a package and exactly its files
  list                                             Installed packages
  audit                                            Check installed packages against security advisories
  lock [--lockfile <file>]                         Write plugins.lock.json from what is installed
  sync [--lockfile <file>]                         Install exactly the lockfile's packages

  --json            Machine-readable output (search, info, list, audit)`;

/** Extra context for citadel-pkg and tests; citadel-host passes a plain PluginCliContext. */
export interface PackageCliContext extends PluginCliContext {
  mode?: 'host' | 'pkg';
  /** Explicit package store (citadel-pkg); defaults to the server directory layout. */
  store?: PackageStore;
  env?: NodeJS.ProcessEnv;
}

const PKG_COMMANDS = new Set(['search', 'info', 'install', 'remove', 'list', 'audit', 'lock', 'sync']);
const PKG_KINDS: readonly PluginKind[] = ['deadworks', 'content'];

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));

function table(rows: string[][], print: (l: string) => void): void {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  for (const r of rows) print(r.map((c, i) => (i === r.length - 1 ? c : pad(c, widths[i]!))).join('  ').trimEnd());
}

function printOutcomes(outcomes: InstallOutcome[], print: (l: string) => void, mode: 'host' | 'pkg', registryUrl?: string): void {
  for (const o of outcomes) {
    if (o.skipped) {
      print(`${o.id}@${o.version} is already installed`);
      continue;
    }
    print(`Installed ${o.id}@${o.version} (${o.kind})`);
    if (o.trust) print(`  ${o.trust.signed ? '' : 'warning: '}${o.trust.status}`);
    print(`  ${trustLabel(o.kind)}`);
    if (o.kind === 'host') {
      if (o.permissions.length) {
        print(`  ${o.id} may:`);
        for (const line of describePermissions(o.permissions)) print(`  ${line}`);
      } else {
        print(`  ${o.id} requests no permissions`);
      }
    }
    if (o.mountedContent) print(`  Mounted citadel/opencitadel_server in gameinfo.gi for server content${mode === 'pkg' ? ' (restart the server to load it)' : ''}`);
    if (o.deadworksAddons?.length) {
      print(`  Placed addon${o.deadworksAddons.length > 1 ? 's' : ''} in citadel/deadworks_server_addons/vpks: ${o.deadworksAddons.join(', ')}`);
      print('  To serve them to players, add to game/bin/win64/configs/deadworks.jsonc under "serverbrowser":');
      print(`    "content_addons": [${o.deadworksAddons.map((n) => `"${n}"`).join(', ')}],`);
      if (registryUrl) print(`    "fastdl_url": "${registryUrl.replace(/\/+$/, '')}/fastdl"`);
    }
  }
}

function printPublisher(tp: TrustedPublisher, print: (l: string) => void): void {
  print(`  repository:  ${tp.repository}${tp.repositoryId ? ` (GitHub id ${tp.repositoryId}, pinned)` : ''}`);
  print(`  workflow:    .github/workflows/${tp.workflow}`);
  if (tp.environment) print(`  environment: ${tp.environment}`);
  if (tp.ref) print(`  ref:         ${tp.ref}`);
}

/** What the linked workflow needs, printed after `trusted-publisher add`. */
function workflowSnippet(tp: TrustedPublisher, registryUrl: string): string[] {
  return [
    `Next, the publishing job in .github/workflows/${tp.workflow} needs:`,
    '',
    '    permissions:',
    '      contents: read',
    '      id-token: write',
    ...(tp.environment ? [`    environment: ${tp.environment}`] : []),
    '    steps:',
    '      # …check out and build the plugin, then:',
    `      - run: ${PUBLISH_COMMAND}`,
    '        env:',
    `          OPENCITADEL_MASTER: ${registryUrl}`,
    '          OPENCITADEL_SIGNING_KEY: ${{ secrets.OPENCITADEL_SIGNING_KEY }}',
    '          OPENCITADEL_SIGNING_PASSPHRASE: ${{ secrets.OPENCITADEL_SIGNING_PASSPHRASE }}',
    '',
    '`citadel-host plugin new` scaffolds a complete workflow.',
  ];
}

export const runPluginCli: RunPluginCli = (argv, ctx) => runPackageCli(argv, ctx);

export async function runPackageCli(argv: string[], ctx: PackageCliContext): Promise<number> {
  const print = ctx.print;
  const mode = ctx.mode ?? 'host';
  const env = ctx.env ?? process.env;
  const usage = mode === 'pkg' ? PKG_USAGE : PLUGIN_USAGE;
  const usageName = mode === 'pkg' ? 'citadel-pkg' : 'citadel-host plugin';
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help') {
    print(usage);
    return command ? 0 : 1;
  }
  if (mode === 'pkg' && !PKG_COMMANDS.has(command)) {
    print(`citadel-pkg does not have a "${command}" command${['new', 'pack', 'publish', 'keygen', 'key', 'sign', 'trusted-publisher'].includes(command) ? ' (authoring commands live in `citadel-host plugin`)' : ''}.\n`);
    print(usage);
    return 2;
  }

  let values: Record<string, string | boolean | string[] | undefined>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        master: { type: 'string' },
        kind: { type: 'string' },
        id: { type: 'string' },
        out: { type: 'string' },
        'api-key': { type: 'string' },
        disabled: { type: 'boolean' },
        force: { type: 'boolean' },
        'keep-config': { type: 'boolean' },
        json: { type: 'boolean' },
        key: { type: 'string' },
        'key-file': { type: 'string', multiple: true },
        'accept-new-key': { type: 'boolean' },
        'allow-unsigned': { type: 'boolean' },
        'no-sign': { type: 'boolean' },
        lockfile: { type: 'string' },
        label: { type: 'string' },
        oidc: { type: 'boolean' },
        repo: { type: 'string' },
        workflow: { type: 'string' },
        environment: { type: 'string' },
        ref: { type: 'string' },
        require: { type: 'boolean' },
        off: { type: 'boolean' },
      },
    }));
  } catch (err) {
    print((err as Error).message);
    return 2;
  }

  const location: StoreLocation = ctx.store ?? ctx.serverDir;
  const store = packageStore(location);
  // OPENCITADEL_MASTER matters in CI, where there is no server.json to name the registry.
  const registryUrl = (values.master as string | undefined) ?? (mode === 'host' ? env.OPENCITADEL_MASTER : undefined) ?? ctx.config.master.url;
  const registry = () => new RegistryClient(registryUrl);
  const kind = values.kind as string | undefined;
  if (kind && !(PLUGIN_KINDS as readonly string[]).includes(kind)) {
    print(`--kind must be one of: ${PLUGIN_KINDS.join(', ')}`);
    return 2;
  }
  const need = (n: number, text: string): boolean => {
    if (positionals.length >= n) return true;
    print(`Usage: ${usageName} ${text}`);
    return false;
  };
  const apiKey = () => (values['api-key'] as string | undefined) ?? env.OPENCITADEL_API_KEY;
  const installOptions = async (): Promise<InstallOptions> => ({
    serverDir: location,
    gameRoot: ctx.gameRoot,
    registry: registry(),
    force: !!values.force,
    security: ctx.config.security,
    acceptNewKey: !!values['accept-new-key'],
    allowUnsigned: !!values['allow-unsigned'],
    keyFiles: await Promise.all(((values['key-file'] as string[] | undefined) ?? []).map((f) => readPublicKey(f))),
    ...(mode === 'pkg' ? { allowedKinds: PKG_KINDS, addonLayout: 'deadworks' as const } : {}),
  });

  try {
    switch (command) {
      case 'search': {
        const res = await registry().search(positionals.join(' '), { kind });
        const plugins = mode === 'pkg' ? res.plugins.filter((p) => p.kind !== 'host') : res.plugins;
        if (values.json) return print(JSON.stringify({ ...res, plugins }, null, 2)), 0;
        if (!plugins.length) return print('No packages found.'), 0;
        table([['ID', 'VERSION', 'KIND', 'DOWNLOADS', 'DESCRIPTION'], ...plugins.map((p) => [p.id, p.latest, p.kind, String(p.downloads), p.description.slice(0, 60)])], print);
        if (res.total > res.plugins.length) print(`… ${res.total - res.plugins.length} more`);
        return 0;
      }

      case 'info': {
        if (!need(1, 'info <id>')) return 2;
        const info = await registry().plugin(positionals[0]!);
        if (values.json) return print(JSON.stringify(info, null, 2)), 0;
        const m = info.manifest;
        print(`${m.name} (${m.id}) — ${m.kind}`);
        if (m.description) print(m.description);
        print(trustLabel(m.kind));
        if (m.author) print(`Author: ${m.author}`);
        if (m.homepage) print(`Homepage: ${m.homepage}`);
        if (m.repository) print(`Source: ${m.repository}`);
        print(`Publisher: ${info.plugin.owner}   Downloads: ${info.plugin.downloads}`);
        if (info.plugin.requireTrustedPublishing) print('Trusted publishing only: new versions can only come from the plugin\'s CI workflows');
        // Registries normally fill manifest defaults; don't rely on it.
        const deps = m.dependencies ?? {};
        if (Object.keys(deps).length) print(`Depends on: ${Object.entries(deps).map(([d, r]) => `${d}@${r}`).join(', ')}`);
        if (m.permissions?.length) {
          print('Permissions:');
          for (const line of describePermissions(m.permissions)) print(line);
        }
        print('Versions:');
        for (const v of info.versions) {
          const sig = v.signature ? `signed by ${v.signature.keyId}${v.keyChanged ? ' (KEY CHANGED)' : ''}` : `unsigned${v.keyChanged ? ' (previous version was signed)' : ''}`;
          print(`  ${v.version}${v.yanked ? ' (yanked)' : ''}  ${v.publishedAt}  ${sig}${v.provenance ? `  built by ${describeProvenance(v.provenance)}` : ''}`);
        }
        return 0;
      }

      case 'install': {
        if (!need(1, 'install <id>[@range] | <file.tgz>')) return 2;
        const spec = positionals[0]!;
        const opts = await installOptions();
        const local = /\.(tgz|tar\.gz)$/i.test(spec) && existsSync(spec);
        const outcomes = local ? await installFromFile(spec, opts) : await installFromRegistry(spec, opts);
        printOutcomes(outcomes, print, mode, registryUrl);
        if (mode === 'pkg') return 0;
        let changed = false;
        for (const o of outcomes) {
          if (o.kind !== 'host' || o.skipped) continue;
          const current = ctx.config.plugins[o.id];
          // Dependencies are always enabled; the named package honours --disabled.
          const enable = o === outcomes[outcomes.length - 1] ? !values.disabled : true;
          ctx.config.plugins[o.id] = pluginSettings({ enabled: current ? current.enabled || enable : enable }, current);
          changed = true;
        }
        if (changed) {
          await ctx.saveConfig(ctx.config);
          print('Restart citadel-host, or type `reload` in its console, to load new host plugins.');
        }
        return 0;
      }

      case 'remove': {
        if (!need(1, 'remove <id>')) return 2;
        const id = positionals[0]!;
        const pkg = await removePackage(id, { serverDir: location, gameRoot: ctx.gameRoot, force: !!values.force });
        print(`Removed ${id}@${pkg.version} (${pkg.files.length} file${pkg.files.length === 1 ? '' : 's'})`);
        if (mode === 'pkg') return 0;
        if (!values['keep-config'] && ctx.config.plugins[id]) {
          delete ctx.config.plugins[id];
          await ctx.saveConfig(ctx.config);
        }
        if (existsSync(join(hostPaths(ctx.serverDir).dataDir, id))) print(`Its data is kept in ${join(hostPaths(ctx.serverDir).dataDir, id)}`);
        return 0;
      }

      case 'list': {
        const index = await readInstalled(location);
        const rows = Object.entries(index)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([id, p]) => ({
            id,
            version: p.version,
            kind: p.kind as string,
            status: p.kind !== 'host' ? 'active' : ctx.config.plugins[id]?.enabled ? 'enabled' : 'disabled',
            signature: p.signature ? `signed ${p.signature.keyId}` : 'unsigned',
            built: p.provenance ? `${p.provenance.repository}@${p.provenance.sha.slice(0, 7)} (${p.provenance.workflow})` : '-',
          }));
        if (mode === 'host') {
          for (const [id, s] of Object.entries(ctx.config.plugins)) {
            if (index[id]) continue;
            const dev = existsSync(join(store.pluginsDir, id, 'plugin.json'));
            rows.push({ id, version: '-', kind: dev ? 'host' : '?', status: dev ? (s.enabled ? 'enabled (local copy)' : 'disabled (local copy)') : 'missing', signature: '-', built: '-' });
          }
        }
        if (values.json) return print(JSON.stringify(rows, null, 2)), 0;
        if (!rows.length) return print(`No packages installed. Try \`${usageName} search\`.`), 0;
        table([['ID', 'VERSION', 'KIND', 'STATUS', 'SIGNATURE', 'BUILT BY'], ...rows.map((r) => [r.id, r.version, r.kind, r.status, r.signature, r.built])], print);
        return 0;
      }

      case 'enable':
      case 'disable': {
        if (!need(1, `${command} <id>`)) return 2;
        const id = positionals[0]!;
        const index = await readInstalled(location);
        const local = existsSync(join(store.pluginsDir, id, 'plugin.json'));
        if (!index[id] && !local) {
          print(`${id} is not installed`);
          return 1;
        }
        if (index[id] && index[id].kind !== 'host') {
          print(`${id} is a ${index[id].kind} package; its files are active while installed. Use \`plugin remove\` to take it off the server.`);
          return 1;
        }
        const enabled = command === 'enable';
        ctx.config.plugins[id] = pluginSettings({ enabled }, ctx.config.plugins[id]);
        await ctx.saveConfig(ctx.config);
        print(`${enabled ? 'Enabled' : 'Disabled'} ${id}. Type \`reload\` in the citadel-host console (or restart it) to apply.`);
        return 0;
      }

      case 'audit': {
        const result = await auditInstalled(location, registryUrl);
        if (values.json) {
          print(JSON.stringify(result, null, 2));
        } else {
          for (const m of result.matches) print(formatMatch(m));
          for (const u of result.unchecked) print(`Could not check ${u.id}: ${u.reason}`);
          if (!result.matches.length) print(`No known advisories affect the installed packages${result.unchecked.length ? ' that could be checked' : ''}.`);
        }
        return result.matches.some(isSerious) ? 1 : 0;
      }

      case 'lock': {
        const { file, lock } = await writeLockfile(location, values.lockfile ? resolve(values.lockfile as string) : undefined);
        const unsigned = Object.entries(lock.packages).filter(([, e]) => !e.keyId).map(([id]) => id);
        print(`Wrote ${file} (${Object.keys(lock.packages).length} package${Object.keys(lock.packages).length === 1 ? '' : 's'})`);
        if (unsigned.length) print(`  unsigned: ${unsigned.join(', ')}`);
        return 0;
      }

      case 'sync': {
        const lock = await readLockfile(values.lockfile ? resolve(values.lockfile as string) : store.lockfile);
        const result = await syncLockfile(lock, await installOptions(), registryUrl);
        printOutcomes(result.installed, print, mode, registryUrl);
        if (result.unchanged.length) print(`Unchanged: ${result.unchanged.join(', ')}`);
        if (result.removed.length) print(`Removed (not in the lockfile): ${result.removed.join(', ')}`);
        if (mode === 'host') {
          let changed = false;
          for (const o of result.installed) {
            if (o.kind === 'host' && !ctx.config.plugins[o.id]) {
              ctx.config.plugins[o.id] = pluginSettings({ enabled: true });
              changed = true;
            }
          }
          if (changed) await ctx.saveConfig(ctx.config);
        }
        print('In sync with the lockfile.');
        return 0;
      }

      case 'new': {
        if (!need(1, 'new <dir> [--kind host|deadworks|content] [--id <id>]')) return 2;
        const files = await scaffoldPlugin(positionals[0]!, { kind: kind as PluginKind | undefined, id: values.id as string | undefined });
        print(`Created ${positionals[0]}:`);
        for (const f of files) print(`  ${f}`);
        return 0;
      }

      case 'pack': {
        if (!need(1, 'pack <dir> [--out <file.tgz>]')) return 2;
        const res = await packPluginToFile(positionals[0]!, values.out as string | undefined);
        print(`Packed ${res.manifest.id}@${res.manifest.version} → ${res.file}`);
        print(`  ${res.entries.length} files, ${res.archive.length} bytes, sha256 ${res.sha256}`);
        return 0;
      }

      case 'keygen': {
        const key = await createSigningKey(values.out as string | undefined, env);
        print(`Created signing key ${key.publicKey.keyId}`);
        print(`  secret key: ${key.keyFile} (keep it private; back it up)`);
        print(`  public key: ${key.publicKeyFile}`);
        if (!key.encrypted) print('  The secret key is not encrypted. Set OPENCITADEL_SIGNING_PASSPHRASE before keygen to encrypt it.');
        print('');
        print(key.publicKey.publicKey);
        print('');
        print(`Register it with your registry account:\n  ${usageName} key register ${key.keyFile} --api-key ock_…`);
        return 0;
      }

      case 'key': {
        if (positionals[0] !== 'register') {
          print(`Usage: ${usageName} key register [<key or .pub file>] [--label <label>] --api-key ock_…`);
          return 2;
        }
        const key = apiKey();
        if (!key) return print('Registering a key needs an account key: pass --api-key or set OPENCITADEL_API_KEY'), 2;
        let publicKey;
        if (positionals[1]) publicKey = await readPublicKey(positionals[1]);
        else {
          const found = await findSigningKey(values.key as string | undefined, env);
          if (!found) return print(`No signing key found. Create one with \`${usageName} keygen\`.`), 1;
          publicKey = parsePublicKey(found.secret.publicKey);
        }
        const info = await registry().registerSigningKey(publicKey.publicKey, key, values.label as string | undefined);
        print(`Registered key ${info.keyId} with ${registryUrl}. Packages you publish signed with it can now be verified.`);
        return 0;
      }

      case 'sign': {
        if (!need(1, 'sign <file.tgz> [--key <file>]')) return 2;
        const found = await findSigningKey(values.key as string | undefined, env);
        if (!found) return print(`No signing key found. Create one with \`${usageName} keygen\`, or pass --key.`), 1;
        const res = await signPackageFile(positionals[0]!, found.secret, signingPassphrase(env));
        print(`Signed ${res.manifest.id}@${res.manifest.version} with ${res.keyId} → ${res.signatureFile}`);
        return 0;
      }

      case 'publish': {
        if (!need(1, 'publish <dir|file.tgz> [--api-key ock_…] [--oidc]')) return 2;
        const key = apiKey();
        // Trusted publishing when asked, or by default inside GitHub Actions without an account key.
        const oidc = !!values.oidc || (!key && !!githubActionsOidc(env));
        if (!key && !oidc) {
          print('Publishing needs an account key (pass --api-key or set OPENCITADEL_API_KEY), or --oidc for trusted publishing from GitHub Actions');
          return 2;
        }
        const found = values['no-sign'] ? undefined : await findSigningKey(values.key as string | undefined, env);
        if (!found && !values['no-sign']) print(`warning: no signing key found, publishing UNSIGNED. Create one with \`${usageName} keygen\`.`);
        const reg = registry();
        const auth = oidc
          ? async (manifest: { id: string }) => {
              const exchange = await trustedPublishToken(reg, env);
              if (!exchange.plugins.includes(manifest.id)) {
                throw new Error(
                  `This workflow is a trusted publisher for ${exchange.plugins.join(', ') || 'no plugins'}, not ${manifest.id}. ` +
                    `Link it with \`${usageName} trusted-publisher add ${manifest.id} …\`.`,
                );
              }
              print(`Trusted publishing: ${reg.baseUrl} accepted this workflow for ${manifest.id} (token valid until ${exchange.expiresAt})`);
              return exchange.token;
            }
          : key!;
        const res = await publishPlugin(positionals[0]!, reg, auth, { secret: found?.secret, passphrase: signingPassphrase(env) });
        print(`Published ${res.manifest.id}@${res.manifest.version} to ${reg.baseUrl} (${res.size} bytes, sha256 ${res.sha256}, ${res.keyId ? `signed by ${res.keyId}` : 'unsigned'})`);
        if (res.version?.provenance) print(`  provenance: ${describeProvenance(res.version.provenance)} ${res.version.provenance.url}`);
        return 0;
      }

      case 'trusted-publisher': {
        const [sub, id, publisherId] = positionals;
        const usageLine = 'trusted-publisher add|list|remove|require <id> …';
        if (!sub || !id || !['add', 'list', 'remove', 'require'].includes(sub)) return print(`Usage: ${usageName} ${usageLine}`), 2;
        const key = apiKey();
        if (!key) return print('Managing trusted publishers needs your account key: pass --api-key or set OPENCITADEL_API_KEY'), 2;
        const reg = registry();
        switch (sub) {
          case 'add': {
            if (!values.repo || !values.workflow) return print(`Usage: ${usageName} trusted-publisher add <id> --repo <owner/repo> --workflow <file.yml> [--environment <name>] [--ref <pattern>] [--require]`), 2;
            const input = parse(trustedPublisherInputValidator, {
              provider: 'github',
              repository: values.repo,
              workflow: values.workflow,
              ...(values.environment ? { environment: values.environment } : {}),
              ...(values.ref ? { ref: values.ref } : {}),
            });
            const tp = await reg.addTrustedPublisher(id, input, key);
            print(`Added trusted publisher ${tp.id} for ${id}:`);
            printPublisher(tp, print);
            if (values.require) {
              await reg.setPluginSettings(id, { requireTrustedPublishing: true }, key);
              print(`${id} now only accepts new versions from its trusted publishers.`);
            }
            print('');
            for (const line of workflowSnippet(tp, reg.baseUrl)) print(line);
            return 0;
          }
          case 'list': {
            const publishers = await reg.trustedPublishers(id, key);
            if (values.json) return print(JSON.stringify(publishers, null, 2)), 0;
            if (!publishers.length) return print(`${id} has no trusted publishers. Add one with \`${usageName} trusted-publisher add ${id} --repo <owner/repo> --workflow <file.yml>\`.`), 0;
            for (const tp of publishers) {
              print(tp.id);
              printPublisher(tp, print);
            }
            return 0;
          }
          case 'remove': {
            if (!publisherId) return print(`Usage: ${usageName} trusted-publisher remove <id> <publisher-id> (see \`trusted-publisher list ${id}\`)`), 2;
            await reg.removeTrustedPublisher(id, publisherId, key);
            print(`Removed trusted publisher ${publisherId} from ${id}.`);
            return 0;
          }
          default: {
            const requireIt = !values.off;
            await reg.setPluginSettings(id, { requireTrustedPublishing: requireIt }, key);
            print(
              requireIt
                ? `${id} now only accepts new versions from its trusted publishers; account keys can no longer publish it.`
                : `${id} accepts new versions published with an account key again.`,
            );
            return 0;
          }
        }
      }

      default:
        print(`Unknown command "${command}".\n`);
        print(usage);
        return 2;
    }
  } catch (err) {
    print(`Error: ${(err as Error).message}`);
    return 1;
  }
}
