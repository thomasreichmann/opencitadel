import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RepeatLimiter, RotatingFile, gameLineWriter } from './logger.js';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'oc-logs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a log file is rotated past its size and keeps only so many old ones', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'logs', 'game.log');
  const log = new RotatingFile(file, { maxBytes: 100, keep: 2 });
  for (let i = 0; i < 40; i++) log.write(`line ${String(i).padStart(2, '0')} ${'x'.repeat(10)}`); // 20 bytes each
  log.close();
  for (const f of [file, `${file}.1`, `${file}.2`]) assert.ok(statSync(f).size <= 100, f);
  assert.ok(!existsSync(`${file}.3`));
  // The newest lines are in the file, the ones before in .1.
  assert.match(readFileSync(file, 'utf8'), /line 39/);
  assert.match(readFileSync(`${file}.1`, 'utf8'), /line 34/);
  assert.doesNotMatch(readFileSync(`${file}.2`, 'utf8'), /line 0[0-9]/, 'the oldest were dropped');

  // Reopened, it carries on from the size on disk.
  const again = new RotatingFile(file, { maxBytes: 100, keep: 2 });
  again.write('after a restart');
  again.close();
  assert.ok(statSync(file).size <= 100);
});

test('with keep 0 the file starts over', (t) => {
  const file = join(tempDir(t), 'host.log');
  const log = new RotatingFile(file, { maxBytes: 50, keep: 0 });
  for (let i = 0; i < 10; i++) log.write(`line ${i} ${'y'.repeat(12)}`);
  log.close();
  assert.ok(statSync(file).size <= 50);
  assert.ok(!existsSync(`${file}.1`));
  assert.match(readFileSync(file, 'utf8'), /line 9/);
});

test('a file that cannot be written is given up on, not thrown', (t) => {
  const dir = tempDir(t);
  const log = new RotatingFile(dir, { maxBytes: 100, keep: 1 }); // a directory: opening it fails
  const write = process.stderr.write;
  let warned = 0;
  process.stderr.write = (() => ((warned++), true)) as typeof process.stderr.write;
  try {
    log.write('a');
    log.write('b');
  } finally {
    process.stderr.write = write;
  }
  assert.equal(warned, 1);
});

test('a line repeated every tick is logged a few times a minute, with a count', () => {
  const limiter = new RepeatLimiter(3);
  const t0 = 1_000_000;
  const out: string[] = [];
  for (let i = 0; i < 64 * 60; i++) {
    out.push(...limiter.admit('Player A was out of the play area', t0 + i * 15));
    if (i % 100 === 0) out.push(...limiter.admit(`tick ${i}`, t0 + i * 15)); // different lines pass
  }
  assert.equal(out.filter((l) => l === 'Player A was out of the play area').length, 3);
  assert.equal(out.filter((l) => l.startsWith('tick ')).length, 39);
  // The next window starts with what was left out of the last.
  const next = limiter.admit('Player A was out of the play area', t0 + 60_000);
  assert.deepEqual(next, ['[3837 more in 60 s, not logged] Player A was out of the play area', 'Player A was out of the play area']);
  assert.deepEqual(limiter.flush(t0 + 120_000), []);
});

test('game lines: timestamped, ignored patterns and repeats left out, echoed too', (t) => {
  const file = join(tempDir(t), 'game.log');
  const echoed: string[] = [];
  let now = Date.UTC(2026, 10, 4, 12, 0, 0);
  const write = gameLineWriter(
    { game: true, repeatsPerMinute: 2, ignore: ['^Certificate expires', '(unclosed'] },
    file,
    { maxBytes: 1 << 20, keep: 1 },
    (l) => echoed.push(l),
    quiet,
    () => now,
  )!;
  write('Client #1 "A" connected');
  write('Certificate expires in 3h4m at 1 (current time 0), will renew in 2h');
  for (let i = 0; i < 5; i++) write('spam');
  now += 61_000;
  write('later');
  assert.deepEqual(echoed, ['Client #1 "A" connected', 'spam', 'spam', '[3 more in 60 s, not logged] spam', 'later']);
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines[0], '2026-11-04T12:00:00.000Z Client #1 "A" connected');
  assert.equal(lines.length, 5);

  assert.equal(gameLineWriter({ game: false, repeatsPerMinute: 5, ignore: [] }, file, { maxBytes: 1, keep: 0 }, undefined, quiet), undefined);
});
