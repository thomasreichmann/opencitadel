import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { formatPublicKeyFile, generateSigningKey, parsePublicKey, parseSecretKeyFile, signData, verifySignature, SignatureError } from './signing.js';
import { createZstdStoredStream, zstdStoredFrame } from './zstd.js';

// Produced by minisign 0.11: `minisign -G -W`, then `minisign -S -m msg.txt -t '…'` (and `-l` for legacy).
const VECTOR = {
  publicKey: 'untrusted comment: minisign public key EF2804DE8EA66621\nRWQhZqaO3gQo74X2XPx2uTmSPZUMcQKXTvgeEZdWEvehOISYJoDetmbH\n',
  message: Buffer.from('opencitadel test vector\n'),
  signature: [
    'untrusted comment: signature from minisign secret key',
    'RUQhZqaO3gQo77m0vRImCxj1NYazz9rk0UyOj3lBp42VyG5gqJ6NQTSupojJQtcNlp+SpFaQTzuv2K5q54x4y3LVRLQHUXuAcQM=',
    'trusted comment: opencitadel trusted comment',
    'ZZZV4Y7Vke19vttsszFjWIFpgM2z/dGgA/Ob0Hif9payqnoWi689Ec6S8/libH4bNE/MGA25XWeFq9vu5e5QDQ==',
    '',
  ].join('\n'),
  legacyMessage: Buffer.from('tgz-bytes'),
  legacySignature: [
    'untrusted comment: signature from minisign secret key',
    'RWQhZqaO3gQo76kvVgvcZgYCRQbiBao8QUfPyyQ7wD0KOsnW3Uzclqs7cmnCZlmAAoXGfFYvXM+dk8VMpyemIgr0jQ5X+E5IgwU=',
    'trusted comment: legacy',
    'Q8h938XhksvNyiHZ4FquSniUdcEkQ8/b2get9qP0h7139Hti7kPTx4DNu1BRk1B9MQxR5Pf5Kr30ZD2zzhFbBA==',
    '',
  ].join('\n'),
};

test('verifies signatures made by real minisign (prehashed and legacy)', () => {
  assert.equal(parsePublicKey(VECTOR.publicKey).keyId, 'EF2804DE8EA66621');
  assert.deepEqual(verifySignature(VECTOR.message, VECTOR.signature, [VECTOR.publicKey]), { keyId: 'EF2804DE8EA66621', trustedComment: 'opencitadel trusted comment' });
  assert.equal(verifySignature(VECTOR.legacyMessage, VECTOR.legacySignature, [VECTOR.publicKey]).trustedComment, 'legacy');
  assert.throws(() => verifySignature(Buffer.from('tampered'), VECTOR.signature, [VECTOR.publicKey]), /does not match/);
  const forged = VECTOR.signature.replace('opencitadel trusted comment', 'opencitadel trusted c0mment');
  assert.throws(() => verifySignature(VECTOR.message, forged, [VECTOR.publicKey]), /tampered/);
});

test('sign/verify round trip, key mismatch, passphrase', () => {
  const { secret, publicKey } = generateSigningKey();
  const data = Buffer.from('package bytes');
  const sig = signData(data, secret, { trustedComment: 'opencitadel package x@1.0.0' });
  assert.equal(verifySignature(data, sig, [formatPublicKeyFile(publicKey)]).keyId, publicKey.keyId);
  const other = generateSigningKey();
  assert.throws(() => verifySignature(data, sig, [other.publicKey]), (e: Error) => e instanceof SignatureError && /not one of the trusted keys/.test(e.message));

  const locked = generateSigningKey('hunter2');
  const roundTripped = parseSecretKeyFile(JSON.stringify(locked.secret));
  assert.throws(() => signData(data, roundTripped), /passphrase is required/);
  assert.throws(() => signData(data, roundTripped, { passphrase: 'wrong' }), /wrong passphrase/);
  const ok = signData(data, roundTripped, { passphrase: 'hunter2' });
  assert.equal(verifySignature(data, ok, [locked.publicKey]).keyId, locked.publicKey.keyId);
});

// Cross-check with the real minisign binary when one is available (MINISIGN_BIN or on PATH).
const minisign = process.env.MINISIGN_BIN ?? (spawnSync('minisign', ['-v']).status === 0 ? 'minisign' : undefined);
test('real minisign accepts our signatures', { skip: !minisign && 'minisign not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-minisign-'));
  try {
    const { secret, publicKey } = generateSigningKey();
    const data = Buffer.from('signed by opencitadel');
    writeFileSync(join(dir, 'pkg.tgz'), data);
    writeFileSync(join(dir, 'pkg.tgz.minisig'), signData(data, secret, { trustedComment: 'hello' }));
    const out = execFileSync(minisign!, ['-Vm', join(dir, 'pkg.tgz'), '-P', publicKey.publicKey], { encoding: 'utf8' });
    assert.match(out, /Trusted comment: hello/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const zstdBin = spawnSync('zstd', ['--version']).status === 0;
test('stored zstd frames decode with the reference zstd', { skip: !zstdBin && 'zstd not installed' }, async () => {
  for (const size of [0, 1, 128 * 1024, 128 * 1024 + 1, 300_000]) {
    const data = Buffer.from(Buffer.alloc(size).map((_, i) => (i * 31 + 7) & 0xff));
    const viaBuffer = zstdStoredFrame(data);
    const viaStream = await buffer(Readable.from(chunks(data, 50_000)).pipe(createZstdStoredStream(size)));
    assert.deepEqual(viaStream, viaBuffer, `stream and buffer agree for ${size}`);
    const decoded = execFileSync('zstd', ['-d', '-c', '-q'], { input: viaBuffer, maxBuffer: 64 * 1024 * 1024 });
    assert.equal(Buffer.compare(decoded, data), 0, `round trip for ${size} bytes`);
  }
});

function* chunks(data: Buffer, size: number) {
  for (let i = 0; i < data.length; i += size) yield data.subarray(i, i + size);
}
