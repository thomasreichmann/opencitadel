#!/usr/bin/env node
/**
 * citadel-pkg — install Deadworks plugins and content packs from an OpenCitadel registry into a
 * Deadlock install, for servers that run Deadworks without citadel-host. Run `citadel-pkg help`.
 */

import { runPkg } from './pkg.js';

runPkg(process.argv.slice(2), (line) => process.stdout.write(line + '\n')).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    process.exit(1);
  },
);
