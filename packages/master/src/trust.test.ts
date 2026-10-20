import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { formatPublicKeyFile, generateSigningKey, packTarGz, packageTrustedComment, signData, verifySignature, type SecretKeyFile } from '@opencitadel/protocol';
import { startMaster, type TestMaster } from './testutil.js';

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function hostPackage(version: string, id = 'welcome'): Buffer {
  const manifest = { id, name: 'Welcome', version, kind: 'host', main: 'dist/index.js', repository: 'https://example.org/welcome' };
  return packTarGz({ 'plugin.json': Buffer.from(JSON.stringify(manifest)), 'dist/index.js': Buffer.from(`export default { setup() {} }; // ${version}\n`) });
}

function sign(body: Buffer, secret: SecretKeyFile, id = 'welcome', version = '1.0.0'): string {
  return signData(body, secret, { trustedComment: packageTrustedComment(id, version, sha256(body)) });
}

const sigHeader = (text: string) => ({ 'x-opencitadel-signature': Buffer.from(text).toString('base64') });

async function addKey(m: TestMaster, apiKey: string, publicKey: { keyId: string; publicKey: string }, label?: string) {
  return m.api('POST', '/v1/accounts/me/signing-keys', { token: apiKey, body: { publicKey: formatPublicKeyFile(publicKey), ...(label ? { label } : {}) } });
}

async function publish(m: TestMaster, apiKey: string, version: string, signature?: string, body = hostPackage(version), id = 'welcome') {
  return m.api('PUT', `/v1/plugins/${id}/${version}`, { raw: body, token: apiKey, headers: { 'content-type': 'application/gzip', ...(signature ? sigHeader(signature) : {}) } });
}

/** Decodes the stored (raw-block) zstd frames the master emits, checking the frame layout. */
function decodeStoredZstd(buf: Buffer): Buffer {
  assert.deepEqual(buf.subarray(0, 4), Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), 'zstd magic');
  assert.equal(buf[4], 0xc0, 'frame header: 8-byte content size, no checksum');
  const size = Number(buf.readBigUInt64LE(6));
  const parts: Buffer[] = [];
  let off = 14;
  for (;;) {
    const header = buf[off]! | (buf[off + 1]! << 8) | (buf[off + 2]! << 16);
    off += 3;
    assert.equal((header >> 1) & 3, 0, 'raw block');
    const len = header >> 3;
    parts.push(buf.subarray(off, off + len));
    off += len;
    if (header & 1) break;
  }
  assert.equal(off, buf.length, 'nothing after the last block');
  const out = Buffer.concat(parts);
  assert.equal(out.length, size, 'frame content size matches');
  return out;
}

test('signing keys: register, list, uniqueness, limit, revoke, publisher page', async () => {
  const m = await startMaster();
  try {
    const alice = await m.account('alice');
    const bob = await m.account('bob');
    const k1 = generateSigningKey().publicKey;

    const added = await addKey(m, alice, k1, 'laptop');
    assert.equal(added.status, 201, added.text);
    assert.deepEqual(Object.keys(added.json.key).sort(), ['addedAt', 'keyId', 'label', 'publicKey']);
    assert.equal(added.json.key.keyId, k1.keyId);
    assert.equal(added.json.key.publicKey, k1.publicKey);

    // A bare base64 line works too, but each key id lives on exactly one account.
    assert.equal((await m.api('POST', '/v1/accounts/me/signing-keys', { token: alice, body: { publicKey: k1.publicKey } })).json.error.code, 'key_exists');
    assert.equal((await addKey(m, bob, k1)).json.error.code, 'key_taken');
    assert.equal((await m.api('POST', '/v1/accounts/me/signing-keys', { token: alice, body: { publicKey: 'RWQ' + 'A'.repeat(50) } })).json.error.code, 'invalid_key');
    assert.equal((await m.api('POST', '/v1/accounts/me/signing-keys', { body: { publicKey: k1.publicKey } })).status, 401);

    for (let i = 0; i < 9; i++) assert.equal((await addKey(m, alice, generateSigningKey().publicKey)).status, 201);
    const extra = generateSigningKey().publicKey;
    assert.equal((await addKey(m, alice, extra)).json.error.code, 'key_limit');

    assert.equal((await m.api('DELETE', `/v1/accounts/me/signing-keys/${k1.keyId.toLowerCase()}`, { token: alice })).status, 204);
    assert.equal((await m.api('DELETE', `/v1/accounts/me/signing-keys/${k1.keyId}`, { token: alice })).status, 204, 'revoking twice is harmless');
    assert.equal((await m.api('DELETE', `/v1/accounts/me/signing-keys/${k1.keyId}`, { token: bob })).status, 404);
    assert.equal((await addKey(m, alice, extra)).status, 201, 'revoking frees a slot');
    assert.equal((await addKey(m, alice, k1)).json.error.code, 'key_exists', 'revoked keys cannot come back');

    const mine = (await m.api('GET', '/v1/accounts/me/signing-keys', { token: alice })).json.keys;
    assert.equal(mine.length, 11);
    assert.equal(typeof mine.find((k: { keyId: string }) => k.keyId === k1.keyId).revokedAt, 'string');

    await publish(m, alice, '1.0.0');
    const pub = await m.api('GET', '/v1/publishers/ALICE');
    assert.equal(pub.status, 200);
    assert.equal(pub.json.name, 'alice');
    assert.deepEqual(pub.json.plugins, ['welcome']);
    assert.equal(pub.json.signingKeys.length, 11, 'revoked keys stay listed so old signatures can be judged');
    assert.equal((await m.api('GET', '/v1/publishers/nobody')).status, 404);
  } finally {
    await m.close();
  }
});

test('signed publishing: valid, tampered, unknown or revoked key, mismatched comment, .minisig download', async () => {
  const m = await startMaster();
  try {
    const alice = await m.account('alice');
    const { secret, publicKey } = generateSigningKey();
    const body = hostPackage('1.0.0');

    assert.equal((await publish(m, alice, '1.0.0', sign(body, secret))).json.error.message.includes('no signing keys'), true);
    assert.equal((await addKey(m, alice, publicKey)).status, 201);

    // Signature over different bytes.
    const tampered = await publish(m, alice, '1.0.0', sign(hostPackage('9.9.9'), secret), body);
    assert.equal(tampered.status, 400);
    assert.equal(tampered.json.error.code, 'invalid_signature');
    // A key the account never registered.
    const stranger = generateSigningKey().secret;
    assert.match((await publish(m, alice, '1.0.0', sign(body, stranger), body)).json.error.message, /not one of the trusted keys/);
    // An OpenCitadel trusted comment naming another version.
    const wrongComment = signData(body, secret, { trustedComment: packageTrustedComment('welcome', '2.0.0', sha256(body)) });
    assert.match((await publish(m, alice, '1.0.0', wrongComment, body)).json.error.message, /made for welcome@2\.0\.0/);
    // Garbage header.
    assert.equal((await m.api('PUT', '/v1/plugins/welcome/1.0.0', { raw: body, token: alice, headers: { 'x-opencitadel-signature': '!!!' } })).json.error.code, 'invalid_signature');

    const ok = await publish(m, alice, '1.0.0', sign(body, secret), body);
    assert.equal(ok.status, 201, ok.text);
    assert.equal(ok.json.version.signature.keyId, publicKey.keyId);
    assert.match(ok.json.version.signature.trustedComment, /^opencitadel package welcome@1\.0\.0 sha256:/);
    assert.equal(ok.json.version.keyChanged, undefined);

    const detail = (await m.api('GET', '/v1/plugins/welcome/1.0.0')).json;
    assert.equal(detail.owner, 'alice');
    assert.equal(detail.kind, 'host');
    assert.equal(detail.signatureUrl, '/v1/plugins/welcome/1.0.0/package.minisig');
    assert.equal(detail.manifest.repository, 'https://example.org/welcome');

    const sigRes = await fetch(`${m.base}/v1/plugins/welcome/1.0.0/package.minisig`);
    assert.equal(sigRes.status, 200);
    assert.match(sigRes.headers.get('content-type')!, /text\/plain/);
    const sigText = await sigRes.text();
    const pkgBytes = Buffer.from(await (await fetch(`${m.base}/v1/plugins/welcome/1.0.0/package`)).arrayBuffer());
    assert.equal(verifySignature(pkgBytes, sigText, [publicKey]).keyId, publicKey.keyId, 'anyone can verify the download with the publisher key');

    // Unsigned versions have no .minisig; revoked keys can no longer sign.
    assert.equal((await publish(m, alice, '1.1.0')).status, 201);
    assert.equal((await m.api('GET', '/v1/plugins/welcome/1.1.0/package.minisig')).status, 404);
    await m.api('DELETE', `/v1/accounts/me/signing-keys/${publicKey.keyId}`, { token: alice });
    const v12 = hostPackage('1.2.0');
    assert.match((await publish(m, alice, '1.2.0', sign(v12, secret, 'welcome', '1.2.0'), v12)).json.error.message, /revoked/);
    // The old signature still verifies against the (revoked) key listed on the publisher page.
    assert.equal((await m.api('GET', '/v1/plugins/welcome/1.0.0')).json.signature.keyId, publicKey.keyId);
  } finally {
    await m.close();
  }
});

test('registry info, and registries that require signatures', async () => {
  const m = await startMaster({ requireSignatures: true, abuseContact: 'abuse@example.org', name: 'Test Registry', publicUrl: 'https://registry.example/' });
  try {
    assert.deepEqual((await m.api('GET', '/v1/registry')).json, {
      requireSignatures: true,
      version: '0.1.0',
      name: 'Test Registry',
      publicUrl: 'https://registry.example',
      abuseContact: 'abuse@example.org',
      // The audience CI requests its OIDC token for defaults to the public URL.
      oidc: { github: { audience: 'https://registry.example' } },
    });
    const alice = await m.account('alice');
    const { secret, publicKey } = generateSigningKey();
    await addKey(m, alice, publicKey);
    const unsigned = await publish(m, alice, '1.0.0');
    assert.equal(unsigned.status, 422);
    assert.equal(unsigned.json.error.code, 'signature_required');
    const body = hostPackage('1.0.0');
    assert.equal((await publish(m, alice, '1.0.0', sign(body, secret), body)).status, 201);
  } finally {
    await m.close();
  }
  const plain = await startMaster();
  try {
    assert.deepEqual((await plain.api('GET', '/v1/registry')).json, { requireSignatures: false, version: '0.1.0', oidc: { github: { audience: 'opencitadel' } } });
  } finally {
    await plain.close();
  }
});

test('a signature can be attached once to an unsigned version', async () => {
  const m = await startMaster();
  try {
    const alice = await m.account('alice');
    const bob = await m.account('bob');
    const { secret, publicKey } = generateSigningKey();
    await addKey(m, alice, publicKey);
    const body = hostPackage('1.0.0');
    assert.equal((await publish(m, alice, '1.0.0', undefined, body)).status, 201);
    assert.equal((await publish(m, alice, '1.1.0')).status, 201);
    const attach = (version: string, text: string, token = alice) => m.api('PUT', `/v1/plugins/welcome/${version}/signature`, { raw: text, token, headers: { 'content-type': 'text/plain' } });

    assert.equal((await attach('1.0.0', sign(body, secret), bob)).status, 404);
    assert.equal((await attach('1.1.0', sign(body, secret, 'welcome', '1.1.0'))).json.error.code, 'invalid_signature', 'signature over the wrong package');
    assert.equal((await attach('1.0.0', 'not a signature')).json.error.code, 'invalid_signature');
    const ok = await attach('1.0.0', sign(body, secret));
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.version.signature.keyId, publicKey.keyId);
    assert.equal((await attach('1.0.0', sign(body, secret))).json.error.code, 'already_signed');
    assert.equal((await m.api('GET', '/v1/plugins/welcome/1.0.0/package.minisig')).status, 200);
    assert.equal((await attach('3.0.0', sign(body, secret))).status, 404);
  } finally {
    await m.close();
  }
});

test('keyChanged flags key switches and dropped signatures, in version order', async () => {
  const m = await startMaster();
  try {
    const alice = await m.account('alice');
    const k1 = generateSigningKey();
    const k2 = generateSigningKey();
    await addKey(m, alice, k1.publicKey);
    await addKey(m, alice, k2.publicKey);
    const signed = async (version: string, key?: SecretKeyFile) => {
      const body = hostPackage(version);
      const r = await publish(m, alice, version, key ? sign(body, key, 'welcome', version) : undefined, body);
      assert.equal(r.status, 201, r.text);
      return body;
    };
    await signed('1.0.0', k1.secret);
    await signed('1.1.0', k1.secret);
    await signed('1.2.0', k2.secret);
    const v13 = await signed('1.3.0');
    await signed('1.4.0', k2.secret);
    const flags = async () =>
      Object.fromEntries(((await m.api('GET', '/v1/plugins/welcome')).json.versions as Array<{ version: string; keyChanged?: boolean }>).map((v) => [v.version, !!v.keyChanged]));
    assert.deepEqual(await flags(), { '1.4.0': false, '1.3.0': true, '1.2.0': true, '1.1.0': false, '1.0.0': false });

    // Signing 1.3.0 with the old key later re-flags its neighbours.
    const r = await m.api('PUT', '/v1/plugins/welcome/1.3.0/signature', { raw: sign(v13, k1.secret, 'welcome', '1.3.0'), token: alice });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(await flags(), { '1.4.0': true, '1.3.0': true, '1.2.0': true, '1.1.0': false, '1.0.0': false });
  } finally {
    await m.close();
  }
});

test('advisories: owner and admin publish, list, since, withdraw', async () => {
  const m = await startMaster({ adminToken: 'root' });
  try {
    const alice = await m.account('alice');
    const bob = await m.account('bob');
    await publish(m, alice, '1.0.0');
    const high = { severity: 'high', title: 'Remote command execution via !map', description: 'Map names were passed to the console unescaped.', affected: '<1.2.0', fixedIn: '1.2.0', url: 'https://example.org/adv/1' };

    assert.equal((await m.api('POST', '/v1/plugins/welcome/advisories', { body: high })).status, 401);
    assert.equal((await m.api('POST', '/v1/plugins/welcome/advisories', { body: high, token: bob })).status, 404);
    assert.equal((await m.api('POST', '/v1/plugins/welcome/advisories', { body: { ...high, affected: 'soon' }, token: alice })).status, 400);
    assert.equal((await m.api('POST', '/v1/plugins/welcome/advisories', { body: { ...high, severity: 'apocalyptic' }, token: alice })).status, 400);
    assert.match((await m.api('POST', '/v1/plugins/welcome/advisories', { body: { ...high, fixedIn: '1.1.0' }, token: alice })).json.error.message, /falls inside/);

    const a1 = await m.api('POST', '/v1/plugins/welcome/advisories', { body: high, token: alice });
    assert.equal(a1.status, 201, a1.text);
    assert.equal(a1.json.advisory.pluginId, 'welcome');
    assert.equal(a1.json.advisory.withdrawn, false);
    assert.equal(a1.json.advisory.fixedIn, '1.2.0');
    m.advance(60_000);
    const a2 = await m.api('POST', '/v1/plugins/welcome/advisories', { body: { severity: 'low', title: 'Misleading help text', affected: '*' }, token: 'root' });
    assert.equal(a2.status, 201, a2.text);

    const perPlugin = (await m.api('GET', '/v1/plugins/welcome/advisories')).json.advisories;
    assert.deepEqual(perPlugin.map((a: { id: string }) => a.id), [a2.json.advisory.id, a1.json.advisory.id], 'newest first');
    assert.equal((await m.api('GET', '/v1/plugins/nope/advisories')).status, 404);
    assert.equal((await m.api('GET', '/v1/plugins/welcome/1.0.0')).json.version, '1.0.0', 'version route still resolves');

    const all = (await m.api('GET', '/v1/advisories')).json;
    assert.equal(all.advisories.length, 2);
    const asOf = all.asOf as string;
    m.advance(60_000);
    assert.equal((await m.api('GET', `/v1/advisories?since=${encodeURIComponent(asOf)}`)).json.advisories.length, 0);

    assert.equal((await m.api('POST', `/v1/advisories/${a1.json.advisory.id}/withdraw`, { token: bob })).status, 404);
    const withdrawn = await m.api('POST', `/v1/advisories/${a1.json.advisory.id}/withdraw`, { token: alice });
    assert.equal(withdrawn.json.advisory.withdrawn, true);
    const changed = (await m.api('GET', `/v1/advisories?since=${encodeURIComponent(asOf)}`)).json.advisories;
    assert.deepEqual(changed.map((a: { id: string; withdrawn: boolean }) => [a.id, a.withdrawn]), [[a1.json.advisory.id, true]], 'withdrawals show up in ?since');
    assert.equal((await m.api('POST', `/v1/advisories/${a2.json.advisory.id}/withdraw`, { token: 'root' })).json.advisory.withdrawn, true);
    assert.equal((await m.api('POST', '/v1/advisories/missing/withdraw', { token: 'root' })).status, 404);
    assert.equal((await m.api('GET', '/v1/advisories?since=yesterday')).status, 400);
  } finally {
    await m.close();
  }
});

test('reports: validated, rate limited per IP, private, resolved by admins', async () => {
  const m = await startMaster({ adminToken: 'root' });
  try {
    const alice = await m.account('alice');
    await publish(m, alice, '1.0.0');
    const report = { reason: 'malware', details: 'Downloads and runs an exe from a pastebin at startup.', contact: 'finder@example.org', version: '1.0.0' };

    const r = await m.api('POST', '/v1/plugins/welcome/reports', { body: report });
    assert.equal(r.status, 202, r.text);
    assert.equal(typeof r.json.id, 'string');
    assert.equal((await m.api('POST', '/v1/plugins/welcome/reports', { body: { ...report, reason: 'vibes' } })).status, 400);
    assert.equal((await m.api('POST', '/v1/plugins/welcome/reports', { body: { ...report, details: 'bad' } })).status, 400);
    assert.equal((await m.api('POST', '/v1/plugins/welcome/reports', { body: { ...report, version: '7.0.0' } })).json.error.code, 'invalid_version');
    assert.equal((await m.api('POST', '/v1/plugins/nope/reports', { body: report })).status, 404);
    // That was five requests from this IP; the sixth within the hour is refused.
    const limited = await m.api('POST', '/v1/plugins/welcome/reports', { body: report });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    m.advance(15 * 60_000);
    assert.equal((await m.api('POST', '/v1/plugins/welcome/reports', { body: { reason: 'copyright', details: 'Contains the map from my mod without permission.' } })).status, 202);

    assert.equal((await m.api('GET', '/v1/admin/reports', { token: alice })).status, 401);
    const open = (await m.api('GET', '/v1/admin/reports', { token: 'root' })).json.reports;
    assert.equal(open.length, 2);
    const first = open.find((x: { id: string }) => x.id === r.json.id);
    assert.equal(first.contact, 'finder@example.org');
    assert.equal(first.ip, '127.0.0.1');
    assert.equal(first.status, 'open');
    assert.equal((await m.api('GET', '/v1/admin/reports?status=weird', { token: 'root' })).status, 400);

    const resolved = await m.api('POST', `/v1/admin/reports/${r.json.id}/resolve`, { token: 'root', body: { note: 'Yanked 1.0.0 and disabled the account.' } });
    assert.equal(resolved.json.report.status, 'resolved');
    assert.equal(resolved.json.report.resolution, 'Yanked 1.0.0 and disabled the account.');
    assert.equal((await m.api('GET', '/v1/admin/reports', { token: 'root' })).json.reports.length, 1);
    assert.equal((await m.api('GET', '/v1/admin/reports?status=resolved', { token: 'root' })).json.reports.length, 1);
    assert.equal((await m.api('POST', '/v1/admin/reports/missing/resolve', { token: 'root', body: {} })).status, 404);
  } finally {
    await m.close();
  }
});

test('FastDL serves registry content as zstd in the Deadworks launcher layout', async () => {
  const m = await startMaster();
  try {
    const key = await m.account('mapper');
    const map = Buffer.concat([Buffer.from([0x34, 0x12, 0xaa, 0x55]), Buffer.from(Buffer.alloc(300_000).map((_, i) => (i * 7) & 0xff))]);
    const addon = Buffer.concat([Buffer.from([0x34, 0x12, 0xaa, 0x55]), Buffer.alloc(1000, 9)]);
    const manifest = {
      id: 'arena-map',
      name: 'Arena',
      version: '0.1.0',
      kind: 'content',
      maps: ['arena'],
      content: [
        { file: 'maps/arena.vpk', client: true },
        { file: 'pak01_dir.vpk', client: true },
      ],
    };
    const pkg = packTarGz({ 'plugin.json': Buffer.from(JSON.stringify(manifest)), 'maps/arena.vpk': map, 'pak01_dir.vpk': addon });
    assert.equal((await m.api('PUT', '/v1/plugins/arena-map/0.1.0', { raw: pkg, token: key })).status, 201);

    const mapUrl = `${m.base}/fastdl/maps/arena_${sha256(map).slice(0, 16)}.vpk.zst`;
    const res = await fetch(mapUrl);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/zstd');
    assert.equal(res.headers.get('x-checksum-sha256'), sha256(map));
    const frame = Buffer.from(await res.arrayBuffer());
    assert.equal(Number(res.headers.get('content-length')), frame.length);
    assert.deepEqual(decodeStoredZstd(frame), map);
    const head = await fetch(mapUrl, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(frame.length));

    const addonUrl = `${m.base}/fastdl/addons/arena_map_pak01_dir_${sha256(addon).slice(0, 16)}.vpk.zst`;
    const addonFrame = Buffer.from(await (await fetch(addonUrl)).arrayBuffer());
    assert.deepEqual(decodeStoredZstd(addonFrame), addon);

    if (spawnSync('zstd', ['--version']).status === 0) {
      const out = spawnSync('zstd', ['-d', '-c', '-q'], { input: frame, maxBuffer: 16 * 1024 * 1024 });
      assert.equal(out.status, 0, String(out.stderr));
      assert.deepEqual(out.stdout, map, 'the reference zstd decodes our frames');
    }

    const missing = [
      `/fastdl/maps/arena_${'0'.repeat(16)}.vpk.zst`,
      `/fastdl/addons/arena_${sha256(map).slice(0, 16)}.vpk.zst`,
      `/fastdl/maps/arena_${sha256(map).slice(0, 15)}.vpk.zst`,
      `/fastdl/maps/arena_${sha256(map).slice(0, 16)}.vpk.bz2`,
      `/fastdl/maps/ARENA_${sha256(map).slice(0, 16)}.vpk.zst`,
      `/fastdl/stuff/arena_${sha256(map).slice(0, 16)}.vpk.zst`,
    ];
    for (const path of missing) assert.equal((await m.api('GET', path)).status, 404, path);
  } finally {
    await m.close();
  }
});
