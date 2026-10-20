import { readFileSync } from 'node:fs';

/** The master's package version, reported by `GET /v1/registry`. */
export const MASTER_VERSION: string = (() => {
  try {
    return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
