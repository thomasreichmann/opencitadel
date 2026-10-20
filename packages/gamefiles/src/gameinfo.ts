import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { KvEditor, findBlock, findEntry, kvQuote, parseKeyValues, type KvNode } from './keyvalues.js';

/** Marks lines we inserted, so `unpatch` can remove exactly those. */
export const ADDED_MARKER = '// opencitadel:added';
/** Marks values we overwrote; the original value follows the `=`. */
export const REPLACED_MARKER = '// opencitadel:was=';

/** The search path (relative to `game/`) where `citadel-browser` mounts a server's required content. */
export const CONTENT_SEARCH_PATH = 'citadel/opencitadel';
/**
 * Where `citadel-host` mounts addon VPKs from installed content packages. Kept apart from the
 * player's content so that hosting and playing on one install never clear each other's files.
 */
export const SERVER_CONTENT_SEARCH_PATH = 'citadel/opencitadel_server';

/**
 * gameinfo.gi edits that let `deadlock.exe -dedicated` accept Steam P2P (SDR) connections,
 * so players can join with `connect [A:1:...]` without the host forwarding ports.
 * Source: deadlockmodding.pages.dev/dedicated-server-hosting.
 */
const DEDICATED_EDITS: Array<{ block: string[]; key: string; value: string }> = [
  { block: ['GameInfo', 'NetworkSystem'], key: 'CreateListenSocketP2P', value: '2' },
  { block: ['GameInfo', 'ConVars'], key: 'net_p2p_listen_dedicated', value: '1' },
];

export interface GameinfoStatus {
  /** Every dedicated-server edit is present with the right value. */
  dedicatedReady: boolean;
  /** Dedicated-server edits that are missing or wrong, as `Block.key`. */
  dedicatedMissing: string[];
  /** The player content search path is mounted. */
  contentMounted: boolean;
  /** The server content search path is mounted. */
  serverContentMounted: boolean;
  /** Lines carrying our markers (non-zero means the file has been patched by us). */
  ourEdits: number;
}

export function inspectGameinfo(source: string): GameinfoStatus {
  const root = parseKeyValues(source);
  const dedicatedMissing = DEDICATED_EDITS.filter(({ block, key, value }) => {
    const b = findBlock(root, block);
    return !b || findEntry(b, key)?.value !== value;
  }).map(({ block, key }) => `${block[block.length - 1]}.${key}`);
  const searchPaths = findBlock(root, ['GameInfo', 'FileSystem', 'SearchPaths']);
  const mounted = (path: string) => !!searchPaths?.children?.some((n) => n.key.toLowerCase() === 'game' && n.value === path);
  const ourEdits = source.split('\n').filter((l) => l.includes(ADDED_MARKER) || l.includes(REPLACED_MARKER)).length;
  return {
    dedicatedReady: dedicatedMissing.length === 0,
    dedicatedMissing,
    contentMounted: mounted(CONTENT_SEARCH_PATH),
    serverContentMounted: mounted(SERVER_CONTENT_SEARCH_PATH),
    ourEdits,
  };
}

function ensureEntry(editor: KvEditor, block: KvNode, key: string, value: string): void {
  const existing = findEntry(block, key);
  if (!existing) {
    editor.insertLinesAtTop(block, [`${kvQuote(key)}\t${kvQuote(value)}\t${ADDED_MARKER}`]);
  } else if (existing.children) {
    throw new Error(`gameinfo.gi: expected "${key}" to be a value, found a block`);
  } else if (existing.value !== value) {
    editor.replaceValue(existing, value, `${REPLACED_MARKER.slice(3)}${existing.value}`);
  }
}

/** Returns gameinfo.gi text with the dedicated-server edits applied (unchanged if already applied). */
export function applyDedicatedPatch(source: string): string {
  const root = parseKeyValues(source);
  const editor = new KvEditor(source);
  for (const { block, key, value } of DEDICATED_EDITS) {
    const b = findBlock(root, block);
    if (!b) throw new Error(`gameinfo.gi: block ${block.join(' > ')} not found; the file format may have changed`);
    ensureEntry(editor, b, key, value);
  }
  return editor.apply();
}

/**
 * Returns gameinfo.gi text with a content search path mounted ahead of the stock `citadel`
 * path (and ahead of a community `citadel/addons` path), so server content overrides both.
 */
export function applyContentSearchPath(source: string, searchPath: string = CONTENT_SEARCH_PATH): string {
  const root = parseKeyValues(source);
  const searchPaths = findBlock(root, ['GameInfo', 'FileSystem', 'SearchPaths']);
  if (!searchPaths?.children) throw new Error('gameinfo.gi: FileSystem > SearchPaths not found');
  const games = searchPaths.children.filter((n) => n.key.toLowerCase() === 'game');
  if (games.some((n) => n.value === searchPath)) return source;
  const anchor = games.find((n) => n.value === 'citadel' || n.value?.startsWith('citadel/'));
  if (!anchor) throw new Error('gameinfo.gi: no "Game citadel" search path to anchor on');
  const editor = new KvEditor(source);
  editor.insertLinesBefore(anchor, [`Game\t\t\t\t${searchPath}\t${ADDED_MARKER}`]);
  return editor.apply();
}

/** Reverts every edit carrying our markers. */
export function removeOurEdits(source: string): string {
  const editor = new KvEditor(source);
  let offset = 0;
  for (const line of source.split('\n')) {
    const idx = line.indexOf(REPLACED_MARKER);
    if (idx !== -1) {
      // Rewrite `key <new>\t// opencitadel:was=<old>` back to `key <old>`.
      const original = line.slice(idx + REPLACED_MARKER.length).replace(/\r$/, '').trim();
      const head = line.slice(0, idx).replace(/\s+$/, '');
      const node = parseKeyValues(head)[0];
      if (node?.valueStart !== undefined) {
        const lineEditor = new KvEditor(head);
        lineEditor.replaceValue(node, original);
        const end = line.endsWith('\r') ? line.length - 1 : line.length;
        editor.replaceRange(offset, end, lineEditor.apply());
      }
    }
    offset += line.length + 1;
  }
  editor.removeLinesContaining(ADDED_MARKER);
  return editor.apply();
}

export type GameinfoChange = 'dedicated' | 'content' | 'server-content';

/**
 * Applies edits to a gameinfo.gi file in place. Writes `<file>.opencitadel.bak` with the
 * pre-edit content whenever the file actually changes. Returns whether it changed.
 */
export async function patchGameinfoFile(file: string, changes: GameinfoChange[]): Promise<boolean> {
  const before = await readFile(file, 'utf8');
  let after = before;
  if (changes.includes('dedicated')) after = applyDedicatedPatch(after);
  if (changes.includes('content')) after = applyContentSearchPath(after, CONTENT_SEARCH_PATH);
  if (changes.includes('server-content')) after = applyContentSearchPath(after, SERVER_CONTENT_SEARCH_PATH);
  if (after === before) return false;
  parseKeyValues(after); // never write a file we can't read back
  await copyFile(file, `${file}.opencitadel.bak`);
  await writeFile(file, after, 'utf8');
  return true;
}

export async function unpatchGameinfoFile(file: string): Promise<boolean> {
  const before = await readFile(file, 'utf8');
  const after = removeOurEdits(before);
  if (after === before) return false;
  parseKeyValues(after);
  if (!existsSync(`${file}.opencitadel.bak`)) await copyFile(file, `${file}.opencitadel.bak`);
  await writeFile(file, after, 'utf8');
  return true;
}
