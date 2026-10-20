import { readFileSync } from 'node:fs';

/** citadel-browser's version, read from package.json so releases only bump the manifest. */
export const CLIENT_VERSION: string = (() => {
  try {
    return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
