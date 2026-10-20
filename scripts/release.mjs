#!/usr/bin/env node
/**
 * Prepares a release: bumps all six @opencitadel packages to one version, commits, and tags.
 * Pushing the tag runs .github/workflows/release.yml, which publishes to npm.
 *
 *   node scripts/release.mjs 0.2.0
 *   git push --follow-tags
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PACKAGES = ['protocol', 'gamefiles', 'plugin-sdk', 'master', 'host', 'client'];
const repo = resolve(import.meta.dirname, '..');
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? '')) {
  console.error('usage: node scripts/release.mjs <version>   (e.g. 0.2.0)');
  process.exit(2);
}
if (git('status', '--porcelain')) {
  console.error('The working tree has uncommitted changes; commit or stash them first.');
  process.exit(1);
}
if (git('tag', '--list', `v${version}`)) {
  console.error(`Tag v${version} already exists.`);
  process.exit(1);
}

for (const dir of PACKAGES) {
  const file = join(repo, 'packages', dir, 'package.json');
  const json = JSON.parse(readFileSync(file, 'utf8'));
  json.version = version;
  writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
}

git('add', ...PACKAGES.map((dir) => join('packages', dir, 'package.json')));
git('commit', '-m', `Release v${version}`);
git('tag', '-a', `v${version}`, '-m', `v${version}`);
console.log(`Bumped ${PACKAGES.length} packages to ${version}, committed, and tagged v${version}.`);
console.log('Push to publish:  git push --follow-tags');
