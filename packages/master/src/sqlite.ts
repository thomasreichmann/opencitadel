/**
 * Loads `node:sqlite` without its one-time ExperimentalWarning. A static import would load the
 * builtin (and print the warning) before any of our code runs, so it is required lazily after
 * a narrow filter is installed on process.emitWarning.
 */

import { createRequire } from 'node:module';
import type * as Sqlite from 'node:sqlite';

let cached: typeof Sqlite | undefined;

export function loadSqlite(): typeof Sqlite {
  if (cached) return cached;
  const original = process.emitWarning;
  process.emitWarning = function (warning: string | Error, ...rest: unknown[]) {
    const message = typeof warning === 'string' ? warning : warning.message;
    const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: string } | undefined)?.type ?? (warning as Error).name;
    if (type === 'ExperimentalWarning' && /SQLite/i.test(message)) return;
    return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    cached = createRequire(import.meta.url)('node:sqlite') as typeof Sqlite;
  } finally {
    process.emitWarning = original;
  }
  return cached;
}
