#!/usr/bin/env node
/**
 * Publishes the six @opencitadel packages from CI with npm trusted publishing (see
 * .github/workflows/release.yml and docs/RELEASING.md). No token: npm 11 exchanges the
 * workflow's GitHub OIDC token itself and attaches provenance.
 *
 *   node scripts/publish-packages.mjs [--dry-run]
 *
 * - On a tag build, the tag (vX.Y.Z) must equal every package's version.
 * - `workspace:*` dependencies are pinned to the release version in the CI checkout, as pnpm
 *   would when packing, so `npm publish` (the command trusted publishing supports) works.
 * - Packages are published in dependency order, and versions already on the registry are
 *   skipped, so a failed run can simply be re-run.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ORDER = ['protocol', 'gamefiles', 'plugin-sdk', 'master', 'host', 'client'];
const repo = resolve(import.meta.dirname, '..');
const dryRun = process.argv.includes('--dry-run');

const manifests = ORDER.map((dir) => {
  const file = join(repo, 'packages', dir, 'package.json');
  return { dir, file, json: JSON.parse(readFileSync(file, 'utf8')) };
});

const versions = new Set(manifests.map((m) => m.json.version));
if (versions.size !== 1) throw new Error(`Package versions differ: ${manifests.map((m) => `${m.json.name}@${m.json.version}`).join(', ')}`);
const [version] = versions;

if (process.env.GITHUB_REF_TYPE === 'tag') {
  const tag = process.env.GITHUB_REF_NAME ?? '';
  if (tag !== `v${version}`) throw new Error(`Tag ${tag} does not match the package version v${version}`);
}

const published = (name) => {
  try {
    return execFileSync('npm', ['view', `${name}@${version}`, 'version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === version;
  } catch {
    return false;
  }
};

// Pin workspace dependencies for the publish, and put the manifests back afterwards so a local
// run leaves the checkout untouched.
const originals = manifests.map((m) => readFileSync(m.file, 'utf8'));
try {
  for (const m of manifests) {
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const [dep, range] of Object.entries(m.json[field] ?? {})) {
        if (String(range).startsWith('workspace:')) m.json[field][dep] = version;
      }
    }
    writeFileSync(m.file, JSON.stringify(m.json, null, 2) + '\n');
  }

  for (const m of manifests) {
    const name = m.json.name;
    if (!dryRun && published(name)) {
      console.log(`= ${name}@${version} is already on the registry; skipping`);
      continue;
    }
    console.log(`${dryRun ? '~' : '+'} ${name}@${version}`);
    execFileSync('npm', ['publish', '--access', 'public', ...(dryRun ? ['--dry-run'] : [])], { cwd: join(repo, 'packages', m.dir), stdio: 'inherit' });
  }
} finally {
  manifests.forEach((m, i) => writeFileSync(m.file, originals[i]));
}
console.log(dryRun ? `Dry run complete for v${version}.` : `Published v${version}.`);
