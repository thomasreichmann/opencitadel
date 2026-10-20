/**
 * citadel-pkg: install Deadworks plugins and content packs from an OpenCitadel registry into a
 * Deadlock install, for servers that run Deadworks without citadel-host. The binary is
 * pkg-cli.ts; this module holds the logic so tests can drive it.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { findDeadlockInstall, gameLayout, isDeadlockInstall } from '@opencitadel/gamefiles';
import { DEFAULT_MASTER_PORT } from '@opencitadel/protocol';
import { parseHostConfig, type HostConfig } from './config.js';
import { PKG_USAGE, runPackageCli } from './plugins/cli.js';
import { flatStore, writeJsonAtomic } from './plugins/installed.js';

/** citadel-pkg's settings, kept in `<state dir>/config.json`. */
export interface PkgConfig {
  registry: string;
  security: HostConfig['security'];
}

export function pkgStateDir(gameRoot: string): string {
  return join(gameLayout(gameRoot).binDir, 'configs', 'opencitadel');
}

async function loadPkgConfig(stateDir: string, registryFlag: string | undefined, env: NodeJS.ProcessEnv): Promise<PkgConfig> {
  const file = join(stateDir, 'config.json');
  let saved: Partial<PkgConfig> = {};
  if (existsSync(file)) {
    try {
      saved = JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
    }
  }
  const registry = (registryFlag ?? env.OPENCITADEL_MASTER ?? saved.registry ?? `http://localhost:${DEFAULT_MASTER_PORT}`).replace(/\/+$/, '');
  const security = parseHostConfig({ security: saved.security }).security;
  const config: PkgConfig = { registry: saved.registry ?? registry, security };
  // Remember the registry the first time so later runs need no flag; security stays as the admin wrote it.
  if (!existsSync(file)) await writeJsonAtomic(file, config);
  return { ...config, registry };
}

function extractGlobal(argv: string[], name: string): { value?: string; rest: string[] } {
  const rest: string[] = [];
  let value: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === `--${name}`) value = argv[++i];
    else if (a.startsWith(`--${name}=`)) value = a.slice(name.length + 3);
    else rest.push(a);
  }
  return { value, rest };
}

export async function runPkg(argv: string[], print: (line: string) => void, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const game = extractGlobal(argv, 'game');
  const reg = extractGlobal(game.rest, 'registry');
  const args = reg.rest;
  if (!args.length || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    print(PKG_USAGE);
    return args.length ? 0 : 1;
  }
  const gameRoot = game.value ? resolve(game.value) : findDeadlockInstall(env);
  if (!gameRoot) {
    print('Could not find Deadlock. Pass --game <Deadlock install folder> or set DEADLOCK_PATH.');
    return 2;
  }
  if (!isDeadlockInstall(gameRoot)) {
    print(`${gameRoot} is not a Deadlock install (expected game/bin/win64/deadlock.exe and game/citadel/gameinfo.gi)`);
    return 2;
  }
  const stateDir = pkgStateDir(gameRoot);
  const settings = await loadPkgConfig(stateDir, reg.value, env);
  const config = parseHostConfig({ master: { url: settings.registry }, security: settings.security, game: { path: gameRoot } });
  return runPackageCli(args, {
    mode: 'pkg',
    serverDir: stateDir,
    store: flatStore(stateDir),
    config,
    // citadel-pkg never edits server.json-style settings.
    saveConfig: async () => {},
    gameRoot,
    print,
    env,
  });
}
