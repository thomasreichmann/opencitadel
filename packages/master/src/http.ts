/** Minimal routing and request/response helpers on top of node:http. */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ValidationError } from '@opencitadel/protocol';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  url: URL;
  params: Record<string, string>;
  /** Client IP, after proxy handling. */
  ip: string;
}

export type Handler = (ctx: RequestContext) => Promise<void> | void;

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({ method, parts: pattern.split('/').filter(Boolean), handler });
    return this;
  }

  get(p: string, h: Handler): this {
    return this.add('GET', p, h);
  }
  post(p: string, h: Handler): this {
    return this.add('POST', p, h);
  }
  put(p: string, h: Handler): this {
    return this.add('PUT', p, h);
  }
  delete(p: string, h: Handler): this {
    return this.add('DELETE', p, h);
  }

  /**
   * Finds the route for a path. Patterns use `:name` for one segment and `*name` (last only)
   * for the rest of the path. Returns `allowed` when the path matches but the method does not.
   */
  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | { allowed: string[] } | undefined {
    const segments = path.split('/').filter(Boolean);
    const allowed: string[] = [];
    for (const route of this.routes) {
      const params = matchParts(route.parts, segments);
      if (!params) continue;
      if (route.method === method || (method === 'HEAD' && route.method === 'GET')) return { handler: route.handler, params };
      allowed.push(route.method);
    }
    return allowed.length ? { allowed } : undefined;
  }
}

function matchParts(parts: string[], segments: string[]): Record<string, string> | undefined {
  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.startsWith('*')) {
      if (i >= segments.length) return undefined;
      params[p.slice(1)] = segments.slice(i).map(decode).join('/');
      return params;
    }
    const s = segments[i];
    if (s === undefined) return undefined;
    if (p.startsWith(':')) params[p.slice(1)] = decode(s);
    else if (p !== s) return undefined;
  }
  return parts.length === segments.length ? params : undefined;
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new HttpError(400, 'bad_path', 'Malformed URL encoding');
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(data.length), 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

export function sendEmpty(res: ServerResponse, status = 204): void {
  res.writeHead(status, { 'Cache-Control': 'no-store' });
  res.end();
}

export function sendError(res: ServerResponse, err: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (err instanceof HttpError) {
    sendJson(res, err.status, { error: { code: err.code, message: err.message } }, err.headers);
  } else if (err instanceof ValidationError) {
    sendJson(res, 400, { error: { code: 'invalid_request', message: err.message } });
  } else {
    sendJson(res, 500, { error: { code: 'internal', message: 'Internal server error' } });
  }
}

/** Reads the request body, failing with 413 past `limit` bytes. */
export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    req.resume();
    return Promise.reject(new HttpError(413, 'payload_too_large', `Body exceeds ${limit} bytes`));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        reject(new HttpError(413, 'payload_too_large', `Body exceeds ${limit} bytes`));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => !failed && resolve(Buffer.concat(chunks)));
    req.on('error', (err) => !failed && reject(err));
  });
}

export async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const body = await readBody(req, limit);
  if (body.length === 0) return {};
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON');
  }
}

/** Extracts a bearer token, or undefined. */
export function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  if (!h) return undefined;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  return m?.[1];
}

/** `::ffff:1.2.3.4` → `1.2.3.4`. */
export function normalizeIp(ip: string): string {
  return ip.startsWith('::ffff:') && ip.includes('.') ? ip.slice(7) : ip;
}

export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    const value = Array.isArray(xff) ? xff.join(',') : xff;
    // The entry our own proxy appended is the last one; anything before it is client-supplied.
    const last = value?.split(',').map((s) => s.trim()).filter(Boolean).pop();
    if (last) return normalizeIp(last);
  }
  return normalizeIp(req.socket.remoteAddress ?? 'unknown');
}
