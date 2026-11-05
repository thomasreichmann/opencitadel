/**
 * Line-oriented logging: `ISO-time LEVEL [component] message`. Sinks are global so the CLI can
 * add a log file and tests can silence or capture output.
 */

import { closeSync, existsSync, fstatSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { format } from 'node:util';
import type { Logger } from '@opencitadel/plugin-sdk';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogSink = (line: string, level: LogLevel) => void;

const consoleSink: LogSink = (line, level) => {
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
};

let sinks: LogSink[] = [consoleSink];
let threshold: LogLevel = (['debug', 'info', 'warn', 'error'] as const).find((l) => l === process.env.OPENCITADEL_LOG_LEVEL) ?? 'info';

export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

export function setLogSinks(next: LogSink[]): void {
  sinks = next;
}

export function addLogSink(sink: LogSink): void {
  sinks.push(sink);
}

export interface RotationOptions {
  /** Size past which the file is renamed to `<file>.1` (older ones to `.2`, …) and a new one started. */
  maxBytes: number;
  /** Rotated files kept; 0 starts the file over instead. */
  keep: number;
}

/**
 * A log file that can't outgrow `maxBytes` × (`keep` + 1). Lines are written synchronously, so
 * nothing is lost on a crash. A file that can't be written (disk full, removed folder) is reported
 * once and then skipped, rather than taking the host down.
 */
export class RotatingFile {
  private fd: number | undefined;
  private size = 0;
  private failed = false;

  constructor(
    readonly file: string,
    private readonly opts: RotationOptions,
  ) {}

  write(line: string): void {
    if (this.failed) return;
    try {
      const data = Buffer.from(line + '\n');
      if (this.fd === undefined) this.open();
      if (this.size > 0 && this.size + data.length > this.opts.maxBytes) this.rotate();
      writeSync(this.fd!, data);
      this.size += data.length;
    } catch (err) {
      this.failed = true;
      process.stderr.write(`Can't write ${this.file}, so it is no longer written: ${(err as Error).message}\n`);
    }
  }

  close(): void {
    if (this.fd !== undefined) closeSync(this.fd);
    this.fd = undefined;
  }

  private open(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    this.fd = openSync(this.file, 'a');
    this.size = fstatSync(this.fd).size;
  }

  private rotate(): void {
    this.close();
    if (this.opts.keep > 0) {
      for (let i = this.opts.keep - 1; i >= 1; i--) {
        if (existsSync(`${this.file}.${i}`)) renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`);
      }
      renameSync(this.file, `${this.file}.1`);
      this.open();
    } else {
      mkdirSync(dirname(this.file), { recursive: true });
      this.fd = openSync(this.file, 'w');
      this.size = 0;
    }
  }
}

/** Appends every log line to `file`, rotating it (see {@link RotatingFile}). */
export function fileSink(file: string, opts: RotationOptions): { sink: LogSink; file: RotatingFile } {
  const out = new RotatingFile(file, opts);
  return { sink: (line) => out.write(line), file: out };
}

/**
 * Where the game's console lines go: to `echo` (the host's output) and, timestamped, to `file`,
 * leaving out lines matching `ignore` and runaway repeats (see {@link RepeatLimiter}). Undefined
 * when they go nowhere. Invalid patterns are reported and skipped.
 */
export function gameLineWriter(
  logs: { game: boolean; repeatsPerMinute: number; ignore: readonly string[] },
  file: string,
  rotation: RotationOptions,
  echo: ((line: string) => void) | undefined,
  log: Logger,
  now: () => number = Date.now,
): ((line: string) => void) | undefined {
  const out = logs.game ? new RotatingFile(file, rotation) : undefined;
  if (!out && !echo) return undefined;
  const ignore: RegExp[] = [];
  for (const pattern of logs.ignore) {
    try {
      ignore.push(new RegExp(pattern));
    } catch (err) {
      log.warn(`Ignoring logs.ignore pattern ${JSON.stringify(pattern)}: ${(err as Error).message}`);
    }
  }
  const limiter = new RepeatLimiter(logs.repeatsPerMinute);
  return (line) => {
    if (ignore.some((re) => re.test(line))) return;
    const t = now();
    for (const kept of limiter.admit(line, t)) {
      echo?.(kept);
      out?.write(`${new Date(t).toISOString()} ${kept}`);
    }
  };
}

/**
 * Lets each distinct line through `max` times per window (a minute); further copies are counted,
 * and a line saying how many were left out comes before the first line of the next window. One
 * runaway message (a game printing the same line every tick) then costs a few lines a minute
 * instead of thousands. Lines that differ, if only by a number, are not repeats.
 */
export class RepeatLimiter {
  private counts = new Map<string, number>();
  private windowStart: number | undefined;

  constructor(
    private readonly max: number,
    private readonly windowMs = 60_000,
    /** Distinct lines tracked per window; beyond it lines pass unchecked rather than grow memory. */
    private readonly maxTracked = 10_000,
  ) {}

  /** The lines to write for `line`: none while it is over the limit. */
  admit(line: string, now = Date.now()): string[] {
    const out = this.windowStart === undefined || now - this.windowStart >= this.windowMs ? this.flush(now) : [];
    const seen = this.counts.get(line);
    if (seen === undefined && this.counts.size >= this.maxTracked) return [...out, line];
    const n = (seen ?? 0) + 1;
    this.counts.set(line, n);
    if (n <= this.max) out.push(line);
    return out;
  }

  /** Ends the window: the counts of lines left out, if any. */
  flush(now = Date.now()): string[] {
    const out: string[] = [];
    for (const [line, n] of this.counts) {
      if (n > this.max) out.push(`[${n - this.max} more in ${Math.round(this.windowMs / 1000)} s, not logged] ${line}`);
    }
    this.counts.clear();
    this.windowStart = now;
    return out;
  }
}

export function createLogger(component: string): Logger {
  const emit = (level: LogLevel, message: string, args: unknown[]) => {
    if (ORDER[level] < ORDER[threshold]) return;
    const text = args.length ? format(message, ...args) : message;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${component}] ${text}`;
    for (const sink of sinks) sink(line, level);
  };
  return {
    debug: (m, ...a) => emit('debug', m, a),
    info: (m, ...a) => emit('info', m, a),
    warn: (m, ...a) => emit('warn', m, a),
    error: (m, ...a) => emit('error', m, a),
  };
}
