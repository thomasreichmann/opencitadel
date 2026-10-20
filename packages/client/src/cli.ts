#!/usr/bin/env node
/** citadel-browser — find, join and sync content for community Deadlock servers. */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { isDeadlockInstall, findDeadlockInstall } from '@opencitadel/gamefiles';
import { CONNECT_TARGET, REGIONS, type ConnectTarget, type Region, type ServerListQuery } from '@opencitadel/protocol';
import { MasterClient, MasterError } from './api.js';
import {
  addFavorite,
  clientHome,
  clientPaths,
  isServerId,
  loadClientConfig,
  recordHistory,
  removeFavorite,
  resolveMasterUrl,
  updateClientConfig,
  type ClientConfig,
} from './config.js';
import { ContentError, clearCache, clearContent, contentStatus, type ProgressEvent } from './content.js';
import { formatServerDetail, formatServerList, formatSize, makeStyle, table, truncate } from './format.js';
import { JoinError, joinServer, launchTarget } from './join.js';
import { systemPlatform, type Platform } from './launch.js';
import { mapLimit, pingServers } from './ping.js';
import { startUi } from './ui.js';
import { CLIENT_VERSION } from './version.js';

const USAGE = `citadel-browser ${CLIENT_VERSION} — community Deadlock servers

Usage: citadel-browser <command> [options]

Commands:
  list                     List online servers
  info <id>                Show a server's details, players, plugins and content
  join <id>                Install the server's content and launch Deadlock into it
  connect <address|id>     Join an unlisted server by host:port or [A:1:…] SteamID
  favorites [add|remove <id>]
  history                  Servers you joined recently
  content status|clear     Show or remove installed server content
  ui                       Open the server browser in your web browser

Common options:
  --master <url>           Master server (default: $OPENCITADEL_MASTER, client.json, http://localhost:8080)
  --game <path>            Deadlock install folder (default: auto-detect, $DEADLOCK_PATH)
  -h, --help               Help for a command

list options:
  -s, --search <text>  --region <r>  --map <m>  --mode <m>  --tags <a,b>
  --not-full  --not-empty  --no-password  --modded  --vanilla  --verified
  --sort players|name|newest  --limit <n>  --ping  --json

join options:   --password <pw>  --no-content  --force  --print
connect options: --password <pw>  --print
content clear:  --cache (also delete downloaded files)
ui options:     --port <n> (default 47900)  --no-open
`;

const GLOBAL = {
  master: { type: 'string' },
  game: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const satisfies ParseArgsConfig['options'];

class UsageError extends Error {}

interface Env {
  home: string;
  config: ClientConfig;
  platform: Platform;
  out(line: string): void;
  err(line: string): void;
}

function parse<O extends NonNullable<ParseArgsConfig['options']>>(args: string[], options: O) {
  try {
    return parseArgs({ args, options: { ...GLOBAL, ...options }, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

function help(env: Env): number {
  env.out(USAGE);
  return 0;
}

function master(env: Env, flag: string | undefined): MasterClient {
  return new MasterClient(resolveMasterUrl(env.config, flag));
}

/** `--game`, then client.json `gamePath`, then auto-detection. Undefined when nothing is found. */
function gameRoot(env: Env, flag: string | undefined): string | undefined {
  if (flag) {
    if (!isDeadlockInstall(flag)) throw new Error(`${flag} doesn't look like a Deadlock install (expected game/bin/win64/deadlock.exe)`);
    return flag;
  }
  if (env.config.gamePath && isDeadlockInstall(env.config.gamePath)) return env.config.gamePath;
  return findDeadlockInstall();
}

function requireGameRoot(env: Env, flag: string | undefined): string {
  const root = gameRoot(env, flag);
  if (!root) throw new Error('No Deadlock install found. Pass --game <path>, set DEADLOCK_PATH, or set "gamePath" in ~/.opencitadel/client.json.');
  return root;
}

/** Single-line download progress on stderr (only when it's a terminal). */
function progressPrinter(env: Env): ((e: ProgressEvent) => void) | undefined {
  if (!process.stderr.isTTY) return undefined;
  let last = 0;
  return (e) => {
    const now = Date.now();
    const done = e.received >= e.total;
    if (!done && now - last < 100) return;
    last = now;
    const pct = Math.floor((e.received / e.total) * 100);
    process.stderr.write(`\r  ${truncate(e.item.name, 30)}  ${String(pct).padStart(3)}%  ${formatSize(e.received)} / ${formatSize(e.total)}\x1b[K${done ? '\n' : ''}`);
  };
}

async function cmdList(env: Env, args: string[]): Promise<number> {
  const { values } = parse(args, {
    search: { type: 'string', short: 's' },
    region: { type: 'string' },
    map: { type: 'string' },
    mode: { type: 'string' },
    tags: { type: 'string' },
    'not-full': { type: 'boolean' },
    'not-empty': { type: 'boolean' },
    'no-password': { type: 'boolean' },
    modded: { type: 'boolean' },
    vanilla: { type: 'boolean' },
    verified: { type: 'boolean' },
    sort: { type: 'string' },
    limit: { type: 'string' },
    ping: { type: 'boolean' },
    json: { type: 'boolean' },
  });
  if (values.help) return help(env);
  if (values.region && !(REGIONS as readonly string[]).includes(values.region)) throw new UsageError(`--region must be one of: ${REGIONS.join(', ')}`);
  if (values.sort && !['players', 'name', 'newest'].includes(values.sort)) throw new UsageError('--sort must be players, name or newest');
  if (values.modded && values.vanilla) throw new UsageError('--modded and --vanilla are mutually exclusive');
  const limit = values.limit ? Number(values.limit) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) throw new UsageError('--limit must be 1–200');

  const query: ServerListQuery = {
    q: values.search,
    region: values.region as Region | undefined,
    map: values.map,
    mode: values.mode,
    tags: values.tags,
    notFull: values['not-full'] || undefined,
    notEmpty: values['not-empty'] || undefined,
    noPassword: values['no-password'] || undefined,
    modded: values.modded ? true : values.vanilla ? false : undefined,
    verified: values.verified || undefined,
    sort: values.sort as ServerListQuery['sort'],
    limit,
  };
  const response = await master(env, values.master).listServers(query);
  // Belt and braces: the master may not understand modded=0.
  const servers = values.vanilla ? response.servers.filter((s) => !s.modded) : response.servers;
  const pings = values.ping ? await pingServers(servers) : undefined;
  if (values.json) {
    env.out(JSON.stringify({ ...response, servers, ...(pings ? { pings } : {}) }, null, 2));
    return 0;
  }
  const style = makeStyle();
  env.out(formatServerList(servers, { pings, favorites: env.config.favorites, style }));
  env.out(style.dim(`\n${servers.length} of ${response.total} shown · ${response.stats.servers} servers, ${response.stats.players} players online`));
  return 0;
}

async function cmdInfo(env: Env, args: string[]): Promise<number> {
  const { values, positionals } = parse(args, { json: { type: 'boolean' } });
  if (values.help) return help(env);
  const id = positionals[0];
  if (!id) throw new UsageError('Usage: citadel-browser info <id>');
  const server = await master(env, values.master).getServer(id);
  env.out(values.json ? JSON.stringify(server, null, 2) : formatServerDetail(server, makeStyle()));
  return 0;
}

async function cmdJoin(env: Env, args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    password: { type: 'string' },
    'no-content': { type: 'boolean' },
    force: { type: 'boolean' },
    print: { type: 'boolean' },
  });
  if (values.help) return help(env);
  const id = positionals[0];
  if (!id) throw new UsageError('Usage: citadel-browser join <id> [--password <pw>]');
  const client = master(env, values.master);
  const server = await client.getServer(id);
  const root = values['no-content'] ? undefined : gameRoot(env, values.game);
  if (server.content.length && !values['no-content']) env.err(`${server.name} needs ${server.content.length} content file(s); checking…`);
  try {
    const result = await joinServer({
      server,
      password: values.password,
      force: values.force,
      skipContent: values['no-content'],
      gameRoot: root,
      cacheDir: clientPaths(env.home).cacheDir,
      platform: env.platform,
      launch: !values.print,
      trustedHosts: [new URL(client.baseUrl).host],
      onProgress: progressPrinter(env),
    });
    await updateClientConfig(env.home, (c) => recordHistory(c, { id: server.id, name: server.name, target: result.target.value }));
    env.out(result.message);
    if (values.print) env.out(result.steamUrl);
    return 0;
  } catch (err) {
    if (err instanceof JoinError) {
      env.err(err.message);
      if (err.code === 'password_required') env.err('Pass it with --password <password>.');
      if (err.code === 'full') env.err('Use --force to try anyway.');
      if (err.code === 'no_game') env.err('Or skip content with --no-content (you may not be able to play on this server).');
      return 1;
    }
    throw err;
  }
}

async function cmdConnect(env: Env, args: string[]): Promise<number> {
  const { values, positionals } = parse(args, { password: { type: 'string' }, print: { type: 'boolean' } });
  if (values.help) return help(env);
  const value = positionals[0];
  if (!value || !CONNECT_TARGET.test(value)) throw new UsageError('Usage: citadel-browser connect <host:port | [A:1:…]>');
  const target: ConnectTarget = value.startsWith('[') ? { kind: 'steamId', value } : { kind: 'address', value };
  const result = await launchTarget({ target, password: values.password, platform: env.platform, launch: !values.print });
  await updateClientConfig(env.home, (c) => recordHistory(c, { name: value, target: value }));
  env.out(result.message);
  if (values.print) env.out(result.steamUrl);
  return 0;
}

async function cmdFavorites(env: Env, args: string[]): Promise<number> {
  const { values, positionals } = parse(args, { json: { type: 'boolean' } });
  if (values.help) return help(env);
  const [action, id] = positionals;
  if (action === 'add' || action === 'remove') {
    if (!id || !isServerId(id)) throw new UsageError(`Usage: citadel-browser favorites ${action} <id>`);
    await updateClientConfig(env.home, (c) => (action === 'add' ? addFavorite(c, id) : removeFavorite(c, id)));
    env.out(action === 'add' ? `Added ${id} to favorites.` : `Removed ${id} from favorites.`);
    return 0;
  }
  if (action) throw new UsageError('Usage: citadel-browser favorites [add|remove <id>]');
  const ids = env.config.favorites;
  if (!ids.length) {
    env.out('No favorites yet. Add one with: citadel-browser favorites add <id>');
    return 0;
  }
  const client = master(env, values.master);
  const details = await mapLimit(ids, 8, (fid) => client.getServer(fid).catch(() => undefined));
  if (values.json) {
    env.out(JSON.stringify(details.map((d, i) => d ?? { id: ids[i], online: false }), null, 2));
    return 0;
  }
  const style = makeStyle();
  env.out(
    table(
      ['ID', 'NAME', 'STATUS', 'PLAYERS'],
      ids.map((fid, i) => {
        const d = details[i];
        return [fid, d ? truncate(d.name, 40) : '', !d ? style.dim('gone') : d.online ? style.green('online') : style.dim('offline'), d ? `${d.players}/${d.maxPlayers}` : ''];
      }),
      ['l', 'l', 'l', 'r'],
      style,
    ),
  );
  return 0;
}

async function cmdHistory(env: Env, args: string[]): Promise<number> {
  const { values } = parse(args, { json: { type: 'boolean' } });
  if (values.help) return help(env);
  if (values.json || !env.config.history.length) {
    env.out(values.json ? JSON.stringify(env.config.history, null, 2) : 'No servers joined yet.');
    return 0;
  }
  env.out(table(['WHEN', 'SERVER', 'ID', 'TARGET'], env.config.history.map((h) => [h.at.replace('T', ' ').slice(0, 16), truncate(h.name, 40), h.id ?? '', h.target]), [], makeStyle()));
  return 0;
}

async function cmdContent(env: Env, args: string[]): Promise<number> {
  const { values, positionals } = parse(args, { cache: { type: 'boolean' }, json: { type: 'boolean' } });
  if (values.help) return help(env);
  const action = positionals[0] ?? 'status';
  if (action === 'status') {
    const status = await contentStatus(requireGameRoot(env, values.game));
    if (values.json) {
      env.out(JSON.stringify(status, null, 2));
      return 0;
    }
    const inst = status.installed;
    if (!inst || (!Object.keys(inst.maps).length && !inst.addons.length)) {
      env.out('No server content installed.');
    } else {
      if (inst.server?.name) env.out(`Installed for: ${inst.server.name}${inst.server.id ? ` (${inst.server.id})` : ''}`);
      const rows = [
        ...Object.entries(inst.maps).map(([name, m]) => [name, 'map', formatSize(m.size), `maps/${name}.vpk`]),
        ...inst.addons.map((a) => [a.name, 'addon', formatSize(a.size), `opencitadel/${a.file}`]),
      ];
      env.out(table(['NAME', 'KIND', 'SIZE', 'FILE'], rows, ['l', 'l', 'r', 'l'], makeStyle()));
    }
    env.out(`Content search path in gameinfo.gi: ${status.gameinfo.contentMounted ? 'mounted' : 'not mounted'}`);
    return 0;
  }
  if (action === 'clear') {
    const result = await clearContent(requireGameRoot(env, values.game));
    env.out(result.removed.length ? `Removed ${result.removed.join(', ')}` : 'No installed content to remove.');
    if (result.kept.length) env.out(`Left alone (changed since install): ${result.kept.join(', ')}`);
    if (result.gameinfoChanged) env.out('Removed the content search path from gameinfo.gi (backup: gameinfo.gi.opencitadel.bak).');
    if (values.cache) env.out(`Deleted ${await clearCache(clientPaths(env.home).cacheDir)} cached download(s).`);
    return 0;
  }
  throw new UsageError('Usage: citadel-browser content status|clear [--cache]');
}

async function cmdUi(env: Env, args: string[]): Promise<number> {
  const { values } = parse(args, { port: { type: 'string' }, 'no-open': { type: 'boolean' } });
  if (values.help) return help(env);
  const port = values.port !== undefined ? Number(values.port) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new UsageError('--port must be 0–65535');
  const root = gameRoot(env, values.game);
  const client = master(env, values.master);
  const ui = await startUi({ master: client, home: env.home, platform: env.platform, port, gameRoot: root, log: (l) => env.err(l) });
  env.out(`Server browser running at ${ui.url} (master: ${client.baseUrl})`);
  if (!root) env.err('No Deadlock install found: joins work, but servers that need content can’t be prepared. Use --game <path>.');
  env.out('Press Ctrl+C to stop.');
  if (!values['no-open']) await env.platform.openUrl(ui.url).catch((err) => env.err(`Couldn't open a browser (${(err as Error).message}); visit ${ui.url}`));
  await new Promise<void>((resolve) => {
    const stop = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      void ui.close().then(resolve);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  return 0;
}

const COMMANDS: Record<string, (env: Env, args: string[]) => Promise<number>> = {
  list: cmdList,
  ls: cmdList,
  info: cmdInfo,
  join: cmdJoin,
  connect: cmdConnect,
  favorites: cmdFavorites,
  fav: cmdFavorites,
  history: cmdHistory,
  content: cmdContent,
  ui: cmdUi,
};

export async function main(argv: string[], platform: Platform = systemPlatform()): Promise<number> {
  const [command, ...rest] = argv;
  const out = (line: string) => void process.stdout.write(line + '\n');
  const err = (line: string) => void process.stderr.write(line + '\n');
  if (!command || command === 'help' || command === '-h' || command === '--help' || command === '--version' || command === '-v') {
    out(command === '--version' || command === '-v' ? CLIENT_VERSION : USAGE);
    return 0;
  }
  const handler = COMMANDS[command];
  if (!handler) {
    err(`Unknown command "${command}".\n`);
    err(USAGE);
    return 2;
  }
  try {
    const home = clientHome();
    const env: Env = { home, config: await loadClientConfig(home), platform, out, err };
    return await handler(env, rest);
  } catch (e) {
    if (e instanceof UsageError) {
      err(e.message);
      return 2;
    }
    if (e instanceof MasterError || e instanceof ContentError) {
      err(e.message);
      return 1;
    }
    err(`Error: ${(e as Error).message}`);
    return 1;
  }
}

/** True when this file is the program being run (directly or through a bin symlink), not an import. */
function invokedDirectly(): boolean {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
