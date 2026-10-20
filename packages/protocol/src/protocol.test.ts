import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { formatSteam3, fromSteam64, isServerSteamId, parseSteam3, toSteam64 } from './steamid.js';
import { compareVersions, maxSatisfying, satisfies } from './semver.js';
import { packTarGz, unpackTarGz, safeRelativePath } from './tarball.js';
import { parseManifest, resolvePluginConfig } from './manifest.js';
import { v, parse, ValidationError } from './validate.js';

test('steam3 <-> steam64', () => {
  const anon = parseSteam3('[A:1:3405691582:12345]')!;
  assert.deepEqual(anon, { universe: 1, type: 4, account: 3405691582, instance: 12345 });
  assert.equal(formatSteam3(fromSteam64(toSteam64(anon))!), '[A:1:3405691582:12345]');
  // Gabe Newell's well-known id: [U:1:22202] == 76561197960287930
  assert.equal(toSteam64(parseSteam3('[U:1:22202]')!), '76561197960287930');
  assert.equal(isServerSteamId('[G:1:1234]'), true);
  assert.equal(isServerSteamId('[U:1:22202]'), false);
  assert.equal(parseSteam3('[A:1:99999999999:1]'), undefined);
});

test('semver ranges', () => {
  assert.ok(satisfies('1.4.2', '^1.2.0'));
  assert.ok(!satisfies('2.0.0', '^1.2.0'));
  assert.ok(satisfies('0.2.5', '^0.2.1'));
  assert.ok(!satisfies('0.3.0', '^0.2.1'));
  assert.ok(satisfies('1.2.9', '~1.2.3'));
  assert.ok(!satisfies('1.3.0', '~1.2.3'));
  assert.ok(satisfies('3.0.0', '>=1.0.0 <4.0.0 || ^9'));
  assert.ok(satisfies('9.1.0', '>=1.0.0 <4.0.0 || ^9'));
  assert.ok(satisfies('5.5.5', '*'));
  assert.ok(compareVersions('1.0.0-beta.2', '1.0.0-beta.10') < 0);
  assert.ok(compareVersions('1.0.0-rc.1', '1.0.0') < 0);
  assert.equal(maxSatisfying(['1.0.0', '1.5.0', '2.0.0'], '^1.0.0'), '1.5.0');
});

test('tar.gz round trip and interop with system tar', () => {
  const files = { 'plugin.json': Buffer.from('{"id":"x"}'), 'dist/index.js': Buffer.from('export default 1;\n'), ['deep/'.repeat(30) + 'f.txt']: Buffer.alloc(1500, 7) };
  const gz = packTarGz(files);
  const back = unpackTarGz(gz);
  assert.deepEqual([...back.keys()].sort(), Object.keys(files).sort());
  assert.deepEqual(back.get('deep/'.repeat(30) + 'f.txt'), files['deep/'.repeat(30) + 'f.txt']);

  const dir = mkdtempSync(join(tmpdir(), 'oc-tar-'));
  try {
    writeFileSync(join(dir, 'a.tgz'), gz);
    const listing = execFileSync('tar', ['-tzf', join(dir, 'a.tgz')], { encoding: 'utf8' });
    assert.ok(listing.includes('dist/index.js'));
    // And read an archive produced by system tar (GNU/pax headers, directory entries).
    execFileSync('tar', ['-xzf', join(dir, 'a.tgz'), '-C', dir]);
    execFileSync('tar', ['-czf', join(dir, 'b.tgz'), '-C', dir, 'plugin.json', 'dist', 'deep']);
    const sys = unpackTarGz(readFileSync(join(dir, 'b.tgz')));
    assert.deepEqual(sys.get('dist/index.js')?.toString(), 'export default 1;\n');
    assert.equal(sys.size, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tar reader rejects traversal and links', () => {
  assert.throws(() => safeRelativePath('../etc/passwd'));
  assert.throws(() => safeRelativePath('/abs'));
  assert.throws(() => safeRelativePath('C:/win'));
  assert.throws(() => safeRelativePath('a/../../b'));
  // Hand-build a symlink entry.
  const h = Buffer.alloc(512);
  h.write('evil', 0);
  h.write('0000644\0', 100);
  h.write('00000000000\0', 124);
  h.write('2', 156);
  h.write('/etc/passwd', 157);
  h.write('ustar\0', 257);
  h.write('        ', 148);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  assert.throws(() => unpackTarGz(gzipSync(Buffer.concat([h, Buffer.alloc(1024)]))), /links are not allowed/);
  assert.throws(() => unpackTarGz(packTarGz({ a: Buffer.alloc(10), b: Buffer.alloc(10) }), { maxFiles: 1, maxTotalBytes: 100 }), /more than 1 files/);
});

test('manifest validation', () => {
  const m = parseManifest({ id: 'welcome', name: 'Welcome', version: '1.0.0', kind: 'host', main: 'index.js', permissions: ['server.chat'], config: { message: { type: 'string', default: 'hi' } }, extra: 'dropped' });
  assert.equal(m.description, '');
  assert.equal((m as Record<string, unknown>).extra, undefined);
  assert.deepEqual(resolvePluginConfig(m, {}), { message: 'hi' });
  assert.deepEqual(resolvePluginConfig(m, { message: 'yo' }), { message: 'yo' });
  assert.throws(() => resolvePluginConfig(m, { message: 5 }), /must be of type string/);
  assert.throws(() => parseManifest({ ...m, main: undefined }), /entry point/);
  assert.throws(() => parseManifest({ ...m, id: 'Bad_Id' }), ValidationError);
  assert.throws(() => parseManifest({ ...m, version: '1.0' }), /semver/);
  assert.throws(() => parseManifest({ ...m, permissions: ['root'] }), /must be one of/);
  assert.throws(() => parseManifest({ ...m, dependencies: { other: 'not a range!' } }), /version range/);
});

test('validator strips unknown keys and reports paths', () => {
  const schema = v.object({ a: v.int({ min: 0 }), b: v.optional(v.array(v.string({ max: 3 }))) });
  assert.deepEqual(parse(schema, { a: 1, z: 2 }), { a: 1 });
  assert.throws(() => parse(schema, { a: 1, b: ['ok', 'toolong'] }), /b\[1\]: must be at most 3/);
  assert.throws(() => parse(v.string(), 'bad\u0001'), /control characters/);
});
