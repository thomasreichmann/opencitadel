import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogTail } from './logtail.js';

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

test('tails new lines, handles CRLF, partial lines, truncation and late creation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-tail-'));
  const file = join(dir, 'console.log');
  const lines: string[] = [];
  const tail = new LogTail(file, { from: 'end', pollMs: 20 });
  tail.on('line', (l) => lines.push(l));
  try {
    await tail.start(); // file does not exist yet
    await writeFile(file, 'first\r\nsecond\n');
    await until(() => lines.length === 2);
    assert.deepEqual(lines, ['first', 'second']);

    await appendFile(file, 'par');
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(lines.length, 2, 'a partial line is held back');
    await appendFile(file, 'tial ✓\n');
    await until(() => lines.length === 3);
    assert.equal(lines[2], 'partial ✓');

    // The game restarted and truncated the log.
    await writeFile(file, 'fresh\n');
    await until(() => lines.length === 4);
    assert.equal(lines[3], 'fresh');

    await appendFile(file, 'unterminated');
    await tail.stop();
    assert.equal(lines[4], 'unterminated', 'stop() flushes the last partial line');
  } finally {
    await tail.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('starting from an offset skips older content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-tail-'));
  const file = join(dir, 'console.log');
  await writeFile(file, 'old line\n');
  const offset = await LogTail.sizeOf(file);
  await appendFile(file, 'new line\n');
  const lines: string[] = [];
  const tail = new LogTail(file, { from: offset, pollMs: 20 });
  tail.on('line', (l) => lines.push(l));
  try {
    await tail.start();
    await until(() => lines.length === 1);
    assert.deepEqual(lines, ['new line']);
    assert.equal(await LogTail.sizeOf(join(dir, 'missing.log')), 0);
  } finally {
    await tail.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
