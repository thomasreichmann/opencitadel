import { readFileSync } from 'node:fs';

/** citadel-host's version, checked against a plugin's `engines.opencitadel` range. */
export const HOST_VERSION: string = (() => {
  try {
    return (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
})();
