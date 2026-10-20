/** Shared fixtures for the client tests. Never points at a real Deadlock install. */

import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentItem, ServerDetail } from '@opencitadel/protocol';
import { VPK_MAGIC } from './content.js';

export const GAMEINFO_FIXTURE = [
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
  '\t\t"SkipRedundantChangeCallbacks"\t"1"',
  '\t}',
  '\tConVars',
  '\t{',
  '\t\t"sv_minrate"\t"98304"',
  '\t}',
  '}',
  '',
].join('\r\n');

export function tempDir(prefix = 'oc-client-'): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A minimal fake Deadlock install: exe, gameinfo.gi and a maps folder. */
export function makeFakeInstall(root: string, gameinfo = GAMEINFO_FIXTURE): string {
  mkdirSync(join(root, 'game', 'bin', 'win64'), { recursive: true });
  mkdirSync(join(root, 'game', 'citadel', 'maps'), { recursive: true });
  writeFileSync(join(root, 'game', 'bin', 'win64', 'deadlock.exe'), '');
  writeFileSync(join(root, 'game', 'citadel', 'gameinfo.gi'), gameinfo);
  return root;
}

/** A buffer that passes the VPK magic check, with content derived from `seed`. */
export function fakeVpk(size: number, seed = 1): Buffer {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = (i * 31 + seed * 7) & 0xff;
  VPK_MAGIC.copy(buf, 0);
  return buf;
}

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function contentItem(name: string, kind: ContentItem['kind'], data: Buffer, url: string): ContentItem {
  return { name, kind, sha256: sha256(data), size: data.length, url };
}

export async function startHttp(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; base: string; close(): Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    server,
    base,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}

export function serverDetail(overrides: Partial<ServerDetail> = {}): ServerDetail {
  return {
    id: 'abcdefgh23456789',
    name: 'Test Server',
    map: 'dl_midtown',
    players: 3,
    maxPlayers: 12,
    bots: 0,
    passworded: false,
    region: 'eu-west',
    tags: ['casual'],
    connect: { steamId: '[A:1:123:456]', address: '203.0.113.5:27015' },
    modded: false,
    requiresContent: false,
    verified: false,
    source: 'opencitadel',
    software: { name: 'citadel-host', version: '0.1.0' },
    lastHeartbeat: '2026-10-19T20:00:00.000Z',
    description: '',
    playerList: [],
    plugins: [],
    content: [],
    metadata: {},
    links: {},
    firstSeen: '2026-10-19T19:00:00.000Z',
    online: true,
    ...overrides,
  };
}
