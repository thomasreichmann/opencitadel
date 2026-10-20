/**
 * Follows a growing text file (the server's `-condebug` console.log) and emits complete lines.
 * Polls with fstat rather than fs.watch, which is unreliable across WSL, Wine and network drives.
 * Truncation or replacement of the file restarts reading from the beginning.
 */

import { EventEmitter } from 'node:events';
import { open, stat, type FileHandle } from 'node:fs/promises';

export interface LogTailOptions {
  /** Byte offset to start from; `'end'` (default) skips what is already in the file. */
  from?: number | 'end';
  pollMs?: number;
}

export class LogTail extends EventEmitter<{ line: [string]; error: [Error] }> {
  private offset = 0;
  private ino: number | undefined;
  private pending: Buffer = Buffer.alloc(0);
  private timer?: NodeJS.Timeout;
  private current?: Promise<void>;
  private stopped = true;

  constructor(readonly file: string, private readonly opts: LogTailOptions = {}) {
    super();
  }

  /** Current size of `file`, or 0 if it does not exist. Use as `from` to skip older content. */
  static async sizeOf(file: string): Promise<number> {
    try {
      return (await stat(file)).size;
    } catch {
      return 0;
    }
  }

  async start(): Promise<void> {
    this.stopped = false;
    const from = this.opts.from ?? 'end';
    if (from === 'end') {
      try {
        const s = await stat(this.file);
        this.offset = s.size;
        this.ino = s.ino;
      } catch {
        this.offset = 0;
      }
    } else {
      this.offset = from;
    }
    this.timer = setInterval(() => void this.poll(), this.opts.pollMs ?? 250);
    await this.poll();
  }

  /** Stops polling. A final unterminated line is emitted, since the writer has gone. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    await this.current;
    await this.poll();
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.pending.length) {
      this.emitLine(this.pending);
      this.pending = Buffer.alloc(0);
    }
  }

  private emitLine(bytes: Buffer): void {
    this.emit('line', bytes.toString('utf8').replace(/\r$/, ''));
  }

  private poll(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.current ??= this.readNew().finally(() => {
      this.current = undefined;
    });
    return this.current;
  }

  private async readNew(): Promise<void> {
    let fh: FileHandle | undefined;
    try {
      fh = await open(this.file, 'r');
      const s = await fh.stat();
      // A different inode (on platforms that report one) or a shrunken file means a new log.
      const replaced = this.ino !== undefined && s.ino !== 0 && s.ino !== this.ino;
      if (replaced || s.size < this.offset) {
        this.offset = 0;
        this.pending = Buffer.alloc(0);
      }
      this.ino = s.ino;
      while (this.offset < s.size) {
        const len = Math.min(s.size - this.offset, 1024 * 1024);
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, this.offset);
        if (bytesRead === 0) break;
        this.offset += bytesRead;
        this.consume(buf.subarray(0, bytesRead));
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.emit('error', err as Error);
    } finally {
      await fh?.close();
    }
  }

  private consume(chunk: Buffer): void {
    let data = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    let nl = data.indexOf(0x0a);
    while (nl !== -1) {
      this.emitLine(data.subarray(0, nl));
      data = data.subarray(nl + 1);
      nl = data.indexOf(0x0a);
    }
    this.pending = Buffer.from(data);
  }
}
