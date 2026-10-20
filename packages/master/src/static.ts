/** Serves the web server browser (packages/master/web) from memory with strict security headers. */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8',
};

/** Same-origin only: no inline script or style, no third-party requests, no framing. */
export const HTML_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

interface Asset {
  body: Buffer;
  type: string;
  etag: string;
}

export function defaultWebDir(): string {
  return fileURLToPath(new URL('../web/', import.meta.url));
}

export class StaticSite {
  private readonly assets = new Map<string, Asset>();

  constructor(dir: string) {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
      const full = join(dir, name);
      if (!TYPES[ext] || !statSync(full).isFile()) continue;
      const body = readFileSync(full);
      this.assets.set(`/${name}`, { body, type: TYPES[ext], etag: `"${createHash('sha1').update(body).digest('base64url')}"` });
    }
    const index = this.assets.get('/index.html');
    if (index) this.assets.set('/', index);
  }

  /** Serves the asset if the path names one. Returns false otherwise. */
  serve(req: IncomingMessage, res: ServerResponse, path: string): boolean {
    const asset = this.assets.get(path);
    if (!asset) return false;
    const headers: Record<string, string> = {
      'Content-Type': asset.type,
      'Cache-Control': 'no-cache',
      ETag: asset.etag,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
    };
    if (asset.type.startsWith('text/html')) {
      headers['Content-Security-Policy'] = HTML_CSP;
      headers['X-Frame-Options'] = 'DENY';
      headers['Permissions-Policy'] = 'camera=(), microphone=(), geolocation=()';
    }
    if (req.headers['if-none-match'] === asset.etag) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }
    headers['Content-Length'] = String(asset.body.length);
    res.writeHead(200, headers);
    res.end(asset.body);
    return true;
  }
}
