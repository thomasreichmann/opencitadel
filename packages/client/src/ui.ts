/**
 * `citadel-browser ui`: serves the master's web browser from 127.0.0.1 with "local mode" on —
 * joins sync content and launch the game, ping comes from this machine, favourites persist in
 * client.json. GET /v1/* is proxied to the master so the page works unchanged.
 *
 * Because this server can write to the game folder and launch Steam, it only answers requests
 * addressed to its own loopback origin (DNS-rebinding guard) and refuses cross-origin writes.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { DEFAULT_CLIENT_UI_PORT, type ConnectInfo } from '@opencitadel/protocol';
import { MasterClient, MasterError, type FetchLike } from './api.js';
import { addFavorite, clientPaths, isServerId, loadClientConfig, recordHistory, removeFavorite, updateClientConfig } from './config.js';
import { JoinError, joinServer, type JoinResult } from './join.js';
import type { Platform } from './launch.js';
import { mapLimit, pingServers, type PingFn } from './ping.js';
import { CLIENT_VERSION } from './version.js';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Locates the master package's web/ assets through its `./web/*` export. */
export function resolveWebDir(): string | undefined {
  try {
    const index = fileURLToPath(import.meta.resolve('@opencitadel/master/web/index.html'));
    return existsSync(index) ? dirname(index) : undefined;
  } catch {
    return undefined;
  }
}

export interface UiOptions {
  master: MasterClient;
  home: string;
  platform: Platform;
  /** Directory holding index.html etc. Defaults to the master package's web/. */
  webDir?: string;
  port?: number;
  gameRoot?: string;
  fetchImpl?: FetchLike;
  allowPrivateContent?: boolean;
  ping?: PingFn;
  log?: (line: string) => void;
}

export interface UiServer {
  server: Server;
  port: number;
  url: string;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data), 'cache-control': 'no-store' });
  res.end(data);
}

async function readJsonBody(req: IncomingMessage, limit = 16 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'too_large', 'Request body too large');
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  const type = req.headers['content-type'] ?? '';
  if (!type.startsWith('application/json')) throw new HttpError(415, 'unsupported_media_type', 'Send application/json');
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HttpError(400, 'bad_json', 'Body must be a JSON object');
  }
}

const JOIN_STATUS: Record<string, number> = { offline: 409, full: 409, password_required: 401, no_target: 409, no_game: 409, content_failed: 502 };

export async function startUi(opts: UiOptions): Promise<UiServer> {
  const webDir = opts.webDir ?? resolveWebDir();
  if (!webDir) throw new Error('The web browser files (@opencitadel/master/web) were not found. Build the master package or pass a web directory.');
  const root = resolve(webDir);
  const log = opts.log ?? (() => {});
  const cacheDir = clientPaths(opts.home).cacheDir;
  let port = opts.port ?? DEFAULT_CLIENT_UI_PORT;
  // Connect info for ping lookups, so repeated pings don't refetch every server.
  const connectCache = new Map<string, { connect: ConnectInfo; at: number }>();

  const allowedHosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = () => new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

  async function lookupConnect(id: string): Promise<ConnectInfo | undefined> {
    const hit = connectCache.get(id);
    if (hit && Date.now() - hit.at < 60_000) return hit.connect;
    try {
      const detail = await opts.master.getServer(id);
      connectCache.set(id, { connect: detail.connect, at: Date.now() });
      return detail.connect;
    } catch {
      return undefined;
    }
  }

  async function handleLocal(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? 'GET';
    const parts = url.pathname.split('/').filter(Boolean); // ['local', ...]

    if (parts[1] === 'info' && method === 'GET') {
      const config = await loadClientConfig(opts.home);
      return sendJson(res, 200, { ok: true, version: CLIENT_VERSION, masterUrl: opts.master.baseUrl, gameFound: !!opts.gameRoot, gamePath: opts.gameRoot ?? null, favorites: config.favorites });
    }

    if (parts[1] === 'favorites') {
      const id = parts[2] ? decodeURIComponent(parts[2]) : undefined;
      if (id !== undefined && !isServerId(id)) throw new HttpError(400, 'bad_id', 'Invalid server id');
      if (method === 'GET' && !id) return sendJson(res, 200, { ids: (await loadClientConfig(opts.home)).favorites });
      if (method === 'PUT' && id) return sendJson(res, 200, { ids: (await updateClientConfig(opts.home, (c) => addFavorite(c, id))).favorites });
      if (method === 'DELETE' && id) return sendJson(res, 200, { ids: (await updateClientConfig(opts.home, (c) => removeFavorite(c, id))).favorites });
    }

    if (parts[1] === 'ping' && method === 'GET') {
      const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean);
      if (ids.length > 100 || !ids.every(isServerId)) throw new HttpError(400, 'bad_ids', 'Pass up to 100 server ids as ?ids=a,b,c');
      const connects = await mapLimit(ids, 8, lookupConnect);
      const known = ids.flatMap((id, i) => (connects[i] ? [{ id, connect: connects[i]! }] : []));
      const pings = await pingServers(known, { ping: opts.ping });
      return sendJson(res, 200, { pings: Object.fromEntries(ids.map((id) => [id, pings[id] ?? null])) });
    }

    if (parts[1] === 'join' && parts[2] && method === 'POST') {
      const id = decodeURIComponent(parts[2]);
      if (!isServerId(id)) throw new HttpError(400, 'bad_id', 'Invalid server id');
      const body = await readJsonBody(req);
      const password = typeof body.password === 'string' && body.password ? body.password : undefined;
      const server = await opts.master.getServer(id);
      let result: JoinResult;
      try {
        result = await joinServer({
          server,
          password,
          force: body.force === true,
          gameRoot: opts.gameRoot,
          cacheDir,
          platform: opts.platform,
          fetchImpl: opts.fetchImpl,
          allowPrivateContent: opts.allowPrivateContent,
          trustedHosts: [new URL(opts.master.baseUrl).host],
        });
      } catch (err) {
        if (!(err instanceof JoinError)) throw err;
        return sendJson(res, JOIN_STATUS[err.code] ?? 400, {
          ok: false,
          launched: false,
          steamUrl: '',
          command: '',
          contentInstalled: [],
          restartRequired: false,
          message: err.message,
          error: { code: err.code, message: err.message },
        });
      }
      await updateClientConfig(opts.home, (c) => recordHistory(c, { id: server.id, name: server.name, target: result.target.value }));
      log(`join ${server.id} (${server.name}): ${result.message}`);
      const { target: _target, copied: _copied, ...wire } = result;
      return sendJson(res, 200, wire);
    }

    throw new HttpError(404, 'not_found', 'Not found');
  }

  async function proxyMaster(res: ServerResponse, url: URL): Promise<void> {
    const upstream = await opts.master.rawGet(url.pathname + url.search);
    const body = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      'content-length': body.length,
      'cache-control': 'no-store',
    });
    res.end(body);
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    let rel: string;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      throw new HttpError(400, 'bad_path', 'Bad path');
    }
    if (rel.includes('\0')) throw new HttpError(400, 'bad_path', 'Bad path');
    const file = resolve(join(root, rel === '/' ? 'index.html' : rel));
    if (file !== root && !file.startsWith(root + sep)) throw new HttpError(404, 'not_found', 'Not found');
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile()) throw new HttpError(404, 'not_found', 'Not found');
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', 'content-length': data.length, 'cache-control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  const server = createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'no-referrer');
    try {
      // A page on another site can't reach us by name (DNS rebinding) or write cross-origin.
      if (!allowedHosts().has(req.headers.host ?? '')) throw new HttpError(403, 'bad_host', 'Requests must be addressed to 127.0.0.1 or localhost');
      const method = req.method ?? 'GET';
      const safe = method === 'GET' || method === 'HEAD';
      const origin = req.headers.origin;
      if (!safe && origin !== undefined && !allowedOrigins().has(origin)) throw new HttpError(403, 'cross_origin', 'Cross-origin requests are not allowed');
      if (!safe && req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') throw new HttpError(403, 'cross_origin', 'Cross-origin requests are not allowed');

      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      if (url.pathname === '/local' || url.pathname.startsWith('/local/')) return await handleLocal(req, res, url);
      if (url.pathname.startsWith('/v1/')) {
        if (!safe) throw new HttpError(405, 'method_not_allowed', 'Only GET is proxied to the master');
        return await proxyMaster(res, url);
      }
      if (!safe) throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
      return await serveStatic(req, res, url);
    } catch (err) {
      if (res.headersSent) return void res.destroy();
      if (err instanceof HttpError) return sendJson(res, err.status, { error: { code: err.code, message: err.message } });
      if (err instanceof MasterError) {
        const status = err.status === 404 ? 404 : 502;
        return sendJson(res, status, { ok: false, message: err.message, error: { code: err.code ?? 'master_error', message: err.message } });
      }
      log(`error: ${(err as Error).stack ?? err}`);
      return sendJson(res, 500, { error: { code: 'internal', message: (err as Error).message } });
    }
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolvePromise();
    });
  });
  port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}/`;
  return {
    server,
    port,
    url,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}
