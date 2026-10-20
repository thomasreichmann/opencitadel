/**
 * Test helpers: a fake Deadlock install on disk and free-port discovery. Used by the host's own
 * tests and by end-to-end runs that pair citadel-host with the fake game (fake-game.ts).
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { fileURLToPath } from 'node:url';
import { gameLayout, type GameLayout } from '@opencitadel/gamefiles';

/** Path of the compiled fake game script, for `game.wrapper: ["node", FAKE_GAME_SCRIPT]`. */
export const FAKE_GAME_SCRIPT = fileURLToPath(new URL('./fake-game.js', import.meta.url));

/** Shaped like the real gameinfo.gi in the parts OpenCitadel edits. */
export const FAKE_GAMEINFO = [
  '"GameInfo"',
  '{',
  '\tgame \t\t"citadel"',
  '\tFileSystem',
  '\t{',
  '\t\tSearchPaths',
  '\t\t{',
  '\t\t\tGame_UILanguage\t\tcitadel_*LANGUAGE*',
  '\t\t\tGame\t\t\t\tcitadel',
  '\t\t\tGame\t\t\t\tcore',
  '\t\t}',
  '\t}',
  '\tNetworkSystem',
  '\t{',
  '\t\tBetaUniverse',
  '\t\t{',
  '\t\t\tFakeLag\t\t\t40',
  '\t\t}',
  '\t\t"SkipRedundantChangeCallbacks"\t"1"',
  '\t}',
  '\tConVars',
  '\t{',
  '\t\t"sv_minrate"\t"98304"',
  '\t}',
  '}',
  '',
].join('\r\n');

/** Creates `root/game/{bin/win64/deadlock.exe, citadel/gameinfo.gi, citadel/cfg}`. */
export async function createFakeInstall(root: string, opts: { deadworks?: boolean } = {}): Promise<GameLayout> {
  const layout = gameLayout(root);
  await mkdir(layout.binDir, { recursive: true });
  await mkdir(`${layout.citadelDir}/cfg`, { recursive: true });
  await writeFile(layout.exe, '');
  if (opts.deadworks) await writeFile(layout.deadworksExe, '');
  await writeFile(layout.gameinfo, FAKE_GAMEINFO);
  return layout;
}

function tryPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tcp = createServer();
    tcp.once('error', () => resolve(false));
    tcp.listen(port, '127.0.0.1', () => {
      const udp = createSocket('udp4');
      udp.once('error', () => tcp.close(() => resolve(false)));
      udp.bind(port, '127.0.0.1', () => udp.close(() => tcp.close(() => resolve(true))));
    });
  });
}

/** A port that is currently free for both TCP and UDP on 127.0.0.1. */
export async function freePort(): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const port = await new Promise<number>((resolve, reject) => {
      const s = createServer();
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => {
        const addr = s.address();
        s.close(() => resolve(typeof addr === 'object' && addr ? addr.port : 0));
      });
    });
    if (port && (await tryPort(port))) return port;
  }
  throw new Error('No free port found');
}
