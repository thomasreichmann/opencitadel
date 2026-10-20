import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findBlock, findEntry, parseKeyValues } from './keyvalues.js';
import { applyContentSearchPath, applyDedicatedPatch, inspectGameinfo, removeOurEdits, CONTENT_SEARCH_PATH, SERVER_CONTENT_SEARCH_PATH } from './gameinfo.js';
import { findDeadlockInstall, gameLayout } from './install.js';

// Trimmed to the shape of the real file: tabs, CRLF, comments, a nested BetaUniverse block.
const FIXTURE = [
  '"GameInfo"',
  '{',
  '\tgame \t\t"citadel"',
  '\tFileSystem',
  '\t{\t',
  '\t\tSearchPaths',
  '\t\t{',
  '\t\t\t// language paths first',
  '\t\t\tGame_UILanguage\t\tcitadel_*LANGUAGE*',
  '\t\t\tGame\t\t\t\tcitadel',
  '\t\t\tGame\t\t\t\tcore',
  '\t\t}',
  '\t}',
  '\tNetworkSystem',
  '\t{',
  '\t\tBetaUniverse',
  '\t\t{',
  '\t\t\tFakeLag\t\t\t40',
  '\t\t\tFakeLoss\t\t.1',
  '\t\t}',
  '\t\t"SkipRedundantChangeCallbacks"\t"1"',
  '\t}',
  '\tConVars',
  '\t{\t ',
  '\t\t"rate"',
  '\t\t{',
  '\t\t\t"min"\t\t"98304"',
  '\t\t}',
  '\t\t"sv_minrate"\t"98304"',
  '\t}',
  '}',
  '',
].join('\r\n');

test('parses nested blocks and leaves', () => {
  const root = parseKeyValues(FIXTURE);
  const net = findBlock(root, ['GameInfo', 'NetworkSystem'])!;
  assert.equal(findEntry(net, 'SkipRedundantChangeCallbacks')?.value, '1');
  assert.equal(findEntry(findBlock(root, ['GameInfo', 'NetworkSystem', 'BetaUniverse'])!, 'FakeLoss')?.value, '.1');
  const paths = findBlock(root, ['gameinfo', 'filesystem', 'searchpaths'])!;
  assert.deepEqual(paths.children!.map((n) => n.value), ['citadel_*LANGUAGE*', 'citadel', 'core']);
});

test('dedicated patch inserts the P2P keys and is idempotent', () => {
  assert.equal(inspectGameinfo(FIXTURE).dedicatedReady, false);
  const patched = applyDedicatedPatch(FIXTURE);
  const status = inspectGameinfo(patched);
  assert.equal(status.dedicatedReady, true, status.dedicatedMissing.join(','));
  assert.equal(status.ourEdits, 2);
  assert.equal(applyDedicatedPatch(patched), patched);
  assert.ok(patched.includes('\t\tCreateListenSocketP2P\t2\t// opencitadel:added\r\n'), 'keeps CRLF and indentation');
});

test('dedicated patch overwrites a wrong value and unpatch restores it', () => {
  const wrong = FIXTURE.replace('"SkipRedundantChangeCallbacks"', 'CreateListenSocketP2P\t0\r\n\t\t"SkipRedundantChangeCallbacks"');
  const patched = applyDedicatedPatch(wrong);
  assert.equal(inspectGameinfo(patched).dedicatedReady, true);
  assert.ok(patched.includes('CreateListenSocketP2P\t2\t// opencitadel:was=0'));
  assert.equal(removeOurEdits(patched), wrong);
});

test('content search path goes ahead of citadel and round-trips', () => {
  const patched = applyContentSearchPath(FIXTURE);
  const paths = findBlock(parseKeyValues(patched), ['GameInfo', 'FileSystem', 'SearchPaths'])!;
  assert.deepEqual(paths.children!.map((n) => n.value), ['citadel_*LANGUAGE*', CONTENT_SEARCH_PATH, 'citadel', 'core']);
  assert.equal(inspectGameinfo(patched).contentMounted, true);
  assert.equal(applyContentSearchPath(patched), patched);
  assert.equal(removeOurEdits(applyDedicatedPatch(patched)), FIXTURE);
});

test('content search path also goes ahead of a community addons path', () => {
  const withAddons = FIXTURE.replace('\t\t\tGame\t\t\t\tcitadel\r\n', '\t\t\tGame\t\t\t\tcitadel/addons\r\n\t\t\tGame\t\t\t\tcitadel\r\n');
  const paths = findBlock(parseKeyValues(applyContentSearchPath(withAddons)), ['GameInfo', 'FileSystem', 'SearchPaths'])!;
  assert.deepEqual(paths.children!.map((n) => n.value).slice(1, 3), [CONTENT_SEARCH_PATH, 'citadel/addons']);
});

test('server and player content paths coexist and both unpatch', () => {
  const both = applyContentSearchPath(applyContentSearchPath(FIXTURE), SERVER_CONTENT_SEARCH_PATH);
  const status = inspectGameinfo(both);
  assert.equal(status.contentMounted, true);
  assert.equal(status.serverContentMounted, true);
  const paths = findBlock(parseKeyValues(both), ['GameInfo', 'FileSystem', 'SearchPaths'])!;
  assert.deepEqual(paths.children!.map((n) => n.value).slice(1, 4), [SERVER_CONTENT_SEARCH_PATH, CONTENT_SEARCH_PATH, 'citadel']);
  assert.equal(removeOurEdits(both), FIXTURE);
});

test('rejects malformed input', () => {
  assert.throws(() => parseKeyValues('"a" { "b" "c"'));
  assert.throws(() => parseKeyValues('"a" }'));
});

// Exercises the real file when a Deadlock install is present. Read-only.
const install = findDeadlockInstall();
test('real gameinfo.gi parses and round-trips', { skip: !install && 'no Deadlock install found' }, () => {
  const src = readFileSync(gameLayout(install!).gameinfo, 'utf8');
  const both = applyContentSearchPath(applyDedicatedPatch(src));
  const status = inspectGameinfo(both);
  assert.equal(status.dedicatedReady, true);
  assert.equal(status.contentMounted, true);
  assert.equal(removeOurEdits(both), src);
});
