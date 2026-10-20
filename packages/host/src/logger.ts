/**
 * Line-oriented logging: `ISO-time LEVEL [component] message`. Sinks are global so the CLI can
 * add a log file and tests can silence or capture output.
 */

import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
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

/** Appends every log line to `file`. Returns the stream so the caller can close it. */
export function fileSink(file: string): { sink: LogSink; stream: WriteStream } {
  mkdirSync(dirname(file), { recursive: true });
  const stream = createWriteStream(file, { flags: 'a' });
  return { sink: (line) => stream.write(line + '\n'), stream };
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
