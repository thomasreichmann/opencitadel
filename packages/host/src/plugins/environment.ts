/**
 * Prepares `.opencitadel/plugins/` so installed plugins can be imported as ES modules:
 *  - `package.json` with `"type": "module"`, inherited by plugin directories that ship none;
 *  - `node_modules/@opencitadel/plugin-sdk` linked to the host's own SDK, so a plugin's
 *    `import { definePlugin } from '@opencitadel/plugin-sdk'` resolves to the same module the
 *    host uses (Node walks up from the plugin to this node_modules).
 */

import { existsSync, readFileSync } from 'node:fs';
import { lstat, mkdir, readlink, symlink, unlink, writeFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SDK_NAME = '@opencitadel/plugin-sdk';

/** Root directory of the plugin SDK package the host itself resolves. */
export function sdkPackageDir(): string {
  let dir = dirname(fileURLToPath(import.meta.resolve(SDK_NAME)));
  for (;;) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        if ((JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }).name === SDK_NAME) return dir;
      } catch {
        // keep walking
      }
    }
    const up = dirname(dir);
    if (up === dir) throw new Error(`Could not locate the ${SDK_NAME} package directory`);
    dir = up;
  }
}

export async function ensurePluginEnvironment(pluginsDir: string): Promise<void> {
  await mkdir(join(pluginsDir, 'node_modules', '@opencitadel'), { recursive: true });

  const pkg = join(pluginsDir, 'package.json');
  if (!existsSync(pkg)) await writeFile(pkg, JSON.stringify({ private: true, type: 'module' }, null, 2) + '\n');

  const target = sdkPackageDir();
  const link = join(pluginsDir, 'node_modules', '@opencitadel', 'plugin-sdk');
  const stat = await lstat(link).catch(() => undefined);
  if (stat?.isSymbolicLink()) {
    const current = resolve(dirname(link), await readlink(link));
    if (current === resolve(target)) return;
    await unlink(link);
  } else if (stat) {
    // A real directory someone put there on purpose; leave it alone.
    return;
  }
  await symlink(target, link, platform() === 'win32' ? 'junction' : 'dir');
}
