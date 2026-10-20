/**
 * Minimal gzip'd ustar reader/writer for plugin packages. Packages are ordinary .tar.gz files
 * (inspect with `tar -tzf`), but reading is deliberately strict: only regular files and
 * directories, relative paths with no `..`, and hard limits on size and entry count, because
 * packages arrive from the network.
 */

import { gunzipSync, gzipSync } from 'node:zlib';

export interface TarLimits {
  maxFiles: number;
  /** Uncompressed bytes across all files. */
  maxTotalBytes: number;
}

export const DEFAULT_TAR_LIMITS: TarLimits = { maxFiles: 2000, maxTotalBytes: 512 * 1024 * 1024 };

/** Normalises and checks a package-relative path. Throws on anything that could escape. */
export function safeRelativePath(p: string): string {
  const norm = p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!norm || norm.startsWith('/') || /^[A-Za-z]:/.test(norm)) throw new Error(`Unsafe path in package: "${p}"`);
  const parts = norm.split('/');
  if (parts.some((s) => s === '..' || s === '' || s === '.')) throw new Error(`Unsafe path in package: "${p}"`);
  if (/[\u0000-\u001f]/.test(norm)) throw new Error(`Unsafe path in package: "${p}"`);
  return norm;
}

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

function header(name: string, size: number, mtime: number): Buffer {
  const h = Buffer.alloc(512, 0);
  let prefix = '';
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    // ustar splits long names at a '/' into prefix (155) + name (100).
    const cut = name.lastIndexOf('/', 155);
    if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100) throw new Error(`Path too long for a package: ${name}`);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
  }
  h.write(base, 0, 100, 'utf8');
  h.write(octal(0o644, 8), 100, 8, 'ascii');
  h.write(octal(0, 8), 108, 8, 'ascii');
  h.write(octal(0, 8), 116, 8, 'ascii');
  h.write(octal(size, 12), 124, 12, 'ascii');
  h.write(octal(mtime, 12), 136, 12, 'ascii');
  h.write('        ', 148, 8, 'ascii');
  h.write('0', 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return h;
}

/** Packs files (path → contents) into a .tar.gz buffer. Paths are sorted for reproducible output. */
export function packTarGz(files: Map<string, Buffer> | Record<string, Buffer>, mtime = 0): Buffer {
  const entries = files instanceof Map ? [...files] : Object.entries(files);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const chunks: Buffer[] = [];
  for (const [name, data] of entries) {
    chunks.push(header(safeRelativePath(name), data.length, mtime), data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

function cstr(buf: Buffer, start: number, len: number): string {
  const slice = buf.subarray(start, start + len);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? len : nul).toString('utf8');
}

function parseOctal(buf: Buffer, start: number, len: number): number {
  const s = cstr(buf, start, len).trim();
  if (!/^[0-7]*$/.test(s)) throw new Error('Corrupt tar header');
  return s ? parseInt(s, 8) : 0;
}

function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space === -1) break;
    const len = Number(data.subarray(i, space).toString('ascii'));
    if (!len) break;
    const record = data.subarray(space + 1, i + len - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += len;
  }
  return out;
}

/** Unpacks a .tar.gz buffer into path → contents. Directories are implied, not returned. */
export function unpackTarGz(gz: Buffer, limits: TarLimits = DEFAULT_TAR_LIMITS): Map<string, Buffer> {
  // Bound decompression itself, not just the entries we keep (gzip bombs).
  const tar = gunzipSync(gz, { maxOutputLength: limits.maxTotalBytes + 1024 * 1024 });
  const files = new Map<string, Buffer>();
  let total = 0;
  let off = 0;
  let nextName: string | undefined;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
    if (sum !== parseOctal(h, 148, 8)) throw new Error('Corrupt tar header checksum');
    const size = parseOctal(h, 124, 12);
    const type = String.fromCharCode(h[156]!);
    const prefix = cstr(h, 345, 155);
    const rawName = prefix ? `${prefix}/${cstr(h, 0, 100)}` : cstr(h, 0, 100);
    const dataStart = off + 512;
    const data = tar.subarray(dataStart, dataStart + size);
    if (data.length !== size) throw new Error('Truncated tar entry');
    off = dataStart + Math.ceil(size / 512) * 512;

    if (type === 'x') {
      nextName = parsePax(data).path ?? nextName;
      continue;
    }
    if (type === 'L') {
      nextName = cstr(data, 0, data.length);
      continue;
    }
    if (type === 'g') continue;
    const name = nextName ?? rawName;
    nextName = undefined;
    if (type === '5') {
      safeRelativePath(name);
      continue;
    }
    if (type !== '0' && type !== '\0') throw new Error(`Unsupported entry type '${type}' for "${name}" (links are not allowed)`);
    const path = safeRelativePath(name);
    total += size;
    if (files.size >= limits.maxFiles) throw new Error(`Package has more than ${limits.maxFiles} files`);
    if (total > limits.maxTotalBytes) throw new Error(`Package exceeds ${limits.maxTotalBytes} bytes uncompressed`);
    if (files.has(path)) throw new Error(`Duplicate path in package: ${path}`);
    files.set(path, Buffer.from(data));
  }
  return files;
}
