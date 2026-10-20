import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { parseKeyValues, findBlock } from './keyvalues.js';

/** Paths inside a Deadlock install that the host and client care about. */
export interface GameLayout {
  /** Install root (the folder that contains `game/`). */
  root: string;
  binDir: string;
  exe: string;
  /** Present only when Deadworks has been installed into the game folder. */
  deadworksExe: string;
  citadelDir: string;
  gameinfo: string;
  /** Written by `-condebug`. */
  consoleLog: string;
  /** Where `citadel-browser` mounts a server's required content (see CONTENT_SEARCH_PATH). */
  contentDir: string;
  /** Where `citadel-host` mounts addons from content packages (see SERVER_CONTENT_SEARCH_PATH). */
  serverContentDir: string;
  mapsDir: string;
  deadworksPluginsDir: string;
}

export function gameLayout(root: string): GameLayout {
  const binDir = join(root, 'game', 'bin', 'win64');
  const citadelDir = join(root, 'game', 'citadel');
  return {
    root,
    binDir,
    exe: join(binDir, 'deadlock.exe'),
    deadworksExe: join(binDir, 'deadworks.exe'),
    citadelDir,
    gameinfo: join(citadelDir, 'gameinfo.gi'),
    consoleLog: join(citadelDir, 'console.log'),
    contentDir: join(citadelDir, 'opencitadel'),
    serverContentDir: join(citadelDir, 'opencitadel_server'),
    mapsDir: join(citadelDir, 'maps'),
    deadworksPluginsDir: join(binDir, 'managed', 'plugins'),
  };
}

export function isDeadlockInstall(root: string): boolean {
  return existsSync(join(root, 'game', 'bin', 'win64', 'deadlock.exe')) && existsSync(join(root, 'game', 'citadel', 'gameinfo.gi'));
}

function isWsl(): boolean {
  if (platform() !== 'linux') return false;
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

/** Steam installation roots worth checking on this machine. */
export function steamRoots(): string[] {
  const home = homedir();
  if (platform() === 'win32') {
    return ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam'];
  }
  const roots = [join(home, '.steam', 'steam'), join(home, '.local', 'share', 'Steam'), join(home, '.var', 'app', 'com.valvesoftware.Steam', 'data', 'Steam')];
  if (platform() === 'darwin') roots.push(join(home, 'Library', 'Application Support', 'Steam'));
  if (isWsl()) roots.unshift('/mnt/c/Program Files (x86)/Steam', '/mnt/c/Program Files/Steam');
  return roots;
}

/** Converts `D:\\SteamLibrary` to `/mnt/d/SteamLibrary` when running under WSL. */
function libraryPathForHost(p: string): string {
  if (isWsl() && /^[A-Za-z]:\\/.test(p)) {
    return `/mnt/${p[0]!.toLowerCase()}/${p.slice(3).replace(/\\/g, '/')}`;
  }
  return p;
}

/** Library folders listed in a Steam root's libraryfolders.vdf. */
export function steamLibraries(steamRoot: string): string[] {
  const vdf = join(steamRoot, 'steamapps', 'libraryfolders.vdf');
  if (!existsSync(vdf)) return [steamRoot];
  try {
    const block = findBlock(parseKeyValues(readFileSync(vdf, 'utf8')), ['libraryfolders']);
    const paths = (block?.children ?? [])
      .map((lib) => lib.children?.find((n) => n.key.toLowerCase() === 'path')?.value)
      .filter((p): p is string => !!p)
      .map(libraryPathForHost);
    return paths.length ? paths : [steamRoot];
  } catch {
    return [steamRoot];
  }
}

/**
 * Locates the Deadlock install: `DEADLOCK_PATH` first, then every Steam library on the machine.
 * Returns undefined if none is found.
 */
export function findDeadlockInstall(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.DEADLOCK_PATH) return isDeadlockInstall(env.DEADLOCK_PATH) ? env.DEADLOCK_PATH : undefined;
  for (const root of steamRoots()) {
    for (const lib of steamLibraries(root)) {
      const candidate = join(lib, 'steamapps', 'common', 'Deadlock');
      if (isDeadlockInstall(candidate)) return candidate;
    }
  }
  return undefined;
}
