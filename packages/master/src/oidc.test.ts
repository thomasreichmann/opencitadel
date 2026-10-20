import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, generateKeyPairSync, sign as rsaSign, type KeyObject } from 'node:crypto';
import { formatPublicKeyFile, generateSigningKey, packTarGz, packageTrustedComment, signData, type SecretKeyFile } from '@opencitadel/protocol';
import { GITHUB_ISSUER, JwtVerifier, mismatch, provenanceOf, refMatches, workflowFile, githubClaims } from './oidc.js';
import { startMaster, T0, type TestMaster } from './testutil.js';

// ---- a fake GitHub OIDC issuer ----

interface IssuerKey {
  kid: string;
  privateKey: KeyObject;
  jwk: Record<string, unknown>;
}

function newKey(kid: string): IssuerKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...(publicKey.export({ format: 'jwk' }) as object), kid, alg: 'RS256', use: 'sig' } };
}

/** A JWKS endpoint as an injectable fetch; counts fetches so tests can check caching. */
function jwksFetch(keys: IssuerKey[]) {
  const state = { keys, fetches: 0 };
  const fetchImpl = (async () => {
    state.fetches++;
    return new Response(JSON.stringify({ keys: state.keys.map((k) => k.jwk) }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { state, fetch: fetchImpl };
}

const b64 = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

function mint(key: IssuerKey, claims: Record<string, unknown>, header: Record<string, unknown> = {}): string {
  const h = b64({ alg: 'RS256', typ: 'JWT', kid: key.kid, ...header });
  const p = b64(claims);
  return `${h}.${p}.${rsaSign('RSA-SHA256', Buffer.from(`${h}.${p}`), key.privateKey).toString('base64url')}`;
}

/** Claims shaped like a GitHub Actions token for a tag push of acme/arena through the release environment. */
function githubToken(nowMs: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  const iat = Math.floor(nowMs / 1000);
  return {
    iss: GITHUB_ISSUER,
    aud: 'opencitadel',
    sub: 'repo:acme/arena:environment:release',
    repository: 'acme/arena',
    repository_id: '4242',
    repository_owner: 'acme',
    repository_owner_id: '77',
    job_workflow_ref: 'acme/arena/.github/workflows/release.yml@refs/tags/v1.0.0',
    workflow_ref: 'acme/arena/.github/workflows/release.yml@refs/tags/v1.0.0',
    workflow: 'Release',
    ref: 'refs/tags/v1.0.0',
    ref_type: 'tag',
    sha: '0123456789abcdef0123456789abcdef01234567',
    run_id: '987654',
    run_number: '12',
    run_attempt: '1',
    environment: 'release',
    actor: 'octocat',
    event_name: 'push',
    iat,
    nbf: iat - 5,
    exp: iat + 300,
    ...over,
  };
}

// ---- the verifier ----

test('JwtVerifier accepts a valid RS256 token and checks iss, aud and time claims', async () => {
  const k1 = newKey('k1');
  const jwks = jwksFetch([k1]);
  let now = T0;
  const verifier = new JwtVerifier({ issuer: GITHUB_ISSUER, jwksUrl: 'https://issuer.invalid/jwks', audience: 'opencitadel', fetch: jwks.fetch, now: () => now });
  const payload = await verifier.verify(mint(k1, githubToken(now)));
  assert.equal(payload.repository, 'acme/arena');
  assert.equal(jwks.state.fetches, 1);
  await verifier.verify(mint(k1, githubToken(now, { aud: ['other', 'opencitadel'] })));
  assert.equal(jwks.state.fetches, 1, 'keys are cached');

  await assert.rejects(verifier.verify(mint(k1, githubToken(now, { aud: 'someone-else' }))), /audience is not "opencitadel"/);
  await assert.rejects(verifier.verify(mint(k1, githubToken(now, { iss: 'https://evil.example' }))), /issued by "https:\/\/evil\.example"/);
  await assert.rejects(verifier.verify(mint(k1, githubToken(now, { exp: Math.floor(now / 1000) - 61 }))), /expired/);
  await verifier.verify(mint(k1, githubToken(now, { exp: Math.floor(now / 1000) - 30 })));
  await assert.rejects(verifier.verify(mint(k1, githubToken(now, { nbf: Math.floor(now / 1000) + 120 }))), /not valid yet/);
  await assert.rejects(verifier.verify(mint(k1, githubToken(now, { iat: Math.floor(now / 1000) + 120 }))), /issued in the future/);
  await assert.rejects(verifier.verify(mint(k1, githubToken(now, { exp: undefined }))), /no expiry/);

  // Clock moves on: the same token expires.
  const token = mint(k1, githubToken(now));
  now += 10 * 60 * 1000;
  await assert.rejects(verifier.verify(token), /expired/);
});

test('JwtVerifier rejects forged, malformed and non-RS256 tokens', async () => {
  const k1 = newKey('k1');
  const impostor = newKey('k1'); // same kid, different key
  const jwks = jwksFetch([k1]);
  const verifier = new JwtVerifier({ issuer: GITHUB_ISSUER, jwksUrl: 'https://issuer.invalid/jwks', audience: 'opencitadel', fetch: jwks.fetch, now: () => T0 });
  await assert.rejects(verifier.verify(mint(impostor, githubToken(T0))), /signature is invalid/);

  const [h, p] = mint(k1, githubToken(T0)).split('.') as [string, string];
  const tampered = `${h}.${b64({ ...githubToken(T0), repository: 'evil/repo' })}.${mint(k1, githubToken(T0)).split('.')[2]}`;
  await assert.rejects(verifier.verify(tampered), /signature is invalid/);

  const none = `${b64({ alg: 'none', kid: 'k1' })}.${p}.`;
  await assert.rejects(verifier.verify(none), /unsupported token algorithm "none"/);
  // HS256 "signed" with the public key as the HMAC secret: the classic algorithm-confusion attack.
  const hsHeader = b64({ alg: 'HS256', kid: 'k1' });
  const hs = `${hsHeader}.${p}.${createHmac('sha256', JSON.stringify(k1.jwk)).update(`${hsHeader}.${p}`).digest('base64url')}`;
  await assert.rejects(verifier.verify(hs), /unsupported token algorithm "HS256"/);
  await assert.rejects(verifier.verify(`${b64({ alg: 'RS256' })}.${p}.${'a'.repeat(10)}`), /no key id/);

  await assert.rejects(verifier.verify('only.two'), /three dot-separated parts/);
  await assert.rejects(verifier.verify(`${h}.${p}.not+base64url`), /not base64url/);
  await assert.rejects(verifier.verify(`${b64('not json')}.${p}.${h}`), /header is not JSON/);
  await assert.rejects(verifier.verify(`${b64([1, 2])}.${p}.${h}`), /header is not a JSON object/);
});

test('JwtVerifier re-fetches the JWKS for an unknown kid, at most once a minute', async () => {
  const k1 = newKey('k1');
  const k2 = newKey('k2');
  const jwks = jwksFetch([k1]);
  let now = T0;
  const verifier = new JwtVerifier({ issuer: GITHUB_ISSUER, jwksUrl: 'https://issuer.invalid/jwks', audience: 'opencitadel', fetch: jwks.fetch, now: () => now });
  await verifier.verify(mint(k1, githubToken(now)));
  assert.equal(jwks.state.fetches, 1);

  // The issuer rotates in k2, but we fetched less than a minute ago: no stampede of refetches.
  jwks.state.keys = [k1, k2];
  now += 10_000;
  await assert.rejects(verifier.verify(mint(k2, githubToken(now))), /unknown key "k2"/);
  assert.equal(jwks.state.fetches, 1);

  now += 60_000;
  const ok = await verifier.verify(mint(k2, githubToken(now)));
  assert.equal(ok.repository, 'acme/arena');
  assert.equal(jwks.state.fetches, 2, 'one refetch picked up the new key');
  await assert.rejects(verifier.verify(mint(newKey('k3'), githubToken(now))), /unknown key "k3"/);
  assert.equal(jwks.state.fetches, 2);

  const broken = new JwtVerifier({
    issuer: GITHUB_ISSUER,
    jwksUrl: 'https://issuer.invalid/jwks',
    audience: 'opencitadel',
    fetch: (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch,
    now: () => now,
  });
  await assert.rejects(broken.verify(mint(k1, githubToken(now))), /could not fetch the issuer's signing keys: HTTP 503/);
});

test('matching helpers: workflow file, ref patterns, mismatches, provenance', () => {
  assert.equal(workflowFile('acme/arena/.github/workflows/release.yml@refs/tags/v1', 'ACME/Arena'), 'release.yml');
  assert.equal(workflowFile('other/repo/.github/workflows/release.yml@refs/heads/main', 'acme/arena'), undefined, 'reusable workflows from other repos are not accepted');
  assert.equal(workflowFile('acme/arena/.github/workflows/nested/x.yml@main', 'acme/arena'), undefined);

  assert.ok(refMatches('refs/tags/v*', 'refs/tags/v1.2.3'));
  assert.ok(!refMatches('refs/tags/v*', 'refs/tags/release/v1'), '* stays within a path segment');
  assert.ok(!refMatches('refs/tags/v*', 'refs/heads/v1'));
  assert.ok(refMatches('refs/heads/main', 'refs/heads/main'));
  assert.ok(!refMatches('refs/heads/main', 'refs/heads/mainline'));
  assert.ok(refMatches('refs/tags/v1.*', 'refs/tags/v1.4'), 'dots are literal');
  assert.ok(!refMatches('refs/tags/v1.*', 'refs/tags/v1x4'));

  const claims = githubClaims(githubToken(T0));
  const tp = { repository: 'Acme/Arena', workflow: 'release.yml', environment: 'Release', ref: 'refs/tags/v*' };
  assert.equal(mismatch(tp, claims), undefined, 'repository and environment compare case-insensitively');
  assert.match(mismatch({ ...tp, repository: 'acme/other' }, claims)!, /repository is acme\/arena, expected acme\/other/);
  assert.match(mismatch({ ...tp, workflow: 'deploy.yml' }, claims)!, /workflow is release\.yml, expected deploy\.yml/);
  assert.match(mismatch({ ...tp, environment: 'prod' }, claims)!, /environment is release, expected prod/);
  assert.match(mismatch(tp, githubClaims(githubToken(T0, { environment: undefined })))!, /must run in the "Release" environment/);
  assert.match(mismatch(tp, githubClaims(githubToken(T0, { ref: 'refs/heads/main' })))!, /ref refs\/heads\/main does not match refs\/tags\/v\*/);
  assert.match(mismatch({ ...tp, repositoryId: '1' }, claims)!, /pinned to 1/);
  assert.throws(() => githubClaims({ iss: GITHUB_ISSUER, repository: 'x/y' }), /no "repository_id" claim/);

  const prov = provenanceOf(claims, GITHUB_ISSUER);
  assert.deepEqual(prov, {
    provider: 'github',
    repository: 'acme/arena',
    repositoryId: '4242',
    workflow: 'release.yml',
    ref: 'refs/tags/v1.0.0',
    sha: '0123456789abcdef0123456789abcdef01234567',
    runId: '987654',
    runAttempt: '1',
    environment: 'release',
    actor: 'octocat',
    eventName: 'push',
    url: 'https://github.com/acme/arena/actions/runs/987654',
  });
  // GitHub Enterprise Server: links point at the instance, from server_url or the issuer.
  assert.equal(provenanceOf(claims, 'https://ghe.example.com/_services/token').url, 'https://ghe.example.com/acme/arena/actions/runs/987654');
  assert.equal(provenanceOf({ ...claims, server_url: 'https://git.corp.example/' }, GITHUB_ISSUER).url, 'https://git.corp.example/acme/arena/actions/runs/987654');
});

// ---- the master: trusted publishers, the exchange, publishing ----

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function pkg(id: string, version: string): Buffer {
  const manifest = { id, name: id, version, kind: 'host', main: 'dist/index.js', repository: 'https://github.com/acme/arena' };
  return packTarGz({ 'plugin.json': Buffer.from(JSON.stringify(manifest)), 'dist/index.js': Buffer.from(`export default { setup() {} }; // ${version}\n`) });
}

async function publish(m: TestMaster, token: string, id: string, version: string, secret?: SecretKeyFile) {
  const body = pkg(id, version);
  const headers: Record<string, string> = { 'content-type': 'application/gzip' };
  if (secret) headers['x-opencitadel-signature'] = Buffer.from(signData(body, secret, { trustedComment: packageTrustedComment(id, version, sha256(body)) })).toString('base64');
  return m.api('PUT', `/v1/plugins/${id}/${version}`, { raw: body, token, headers });
}

async function withIssuer(fn: (m: TestMaster, issuer: IssuerKey, jwks: ReturnType<typeof jwksFetch>) => Promise<void>) {
  const issuer = newKey('gh-1');
  const jwks = jwksFetch([issuer]);
  const m = await startMaster({ oidcFetch: jwks.fetch });
  try {
    await fn(m, issuer, jwks);
  } finally {
    await m.close();
  }
}

const releasePublisher = { repository: 'acme/arena', workflow: 'release.yml', environment: 'release', ref: 'refs/tags/v*' };

test('trusted publishing: reserve, exchange, publish with provenance, pin the repository', async () => {
  await withIssuer(async (m, issuer) => {
    const alice = await m.account('alice');
    const bob = await m.account('bob');
    const { secret, publicKey } = generateSigningKey();
    await m.api('POST', '/v1/accounts/me/signing-keys', { token: alice, body: { publicKey: formatPublicKeyFile(publicKey) } });

    // Configuring a publisher for an unpublished id reserves it for alice.
    const added = await m.api('POST', '/v1/plugins/arena/trusted-publishers', { token: alice, body: releasePublisher });
    assert.equal(added.status, 201, added.text);
    assert.deepEqual(Object.keys(added.json.publisher).sort(), ['addedAt', 'environment', 'id', 'pluginId', 'provider', 'ref', 'repository', 'workflow']);
    assert.equal((await m.api('POST', '/v1/plugins/arena/trusted-publishers', { token: alice, body: releasePublisher })).json.error.code, 'publisher_exists');
    assert.equal((await m.api('POST', '/v1/plugins/arena/trusted-publishers', { token: bob, body: { ...releasePublisher, workflow: 'x.yml' } })).status, 404, 'reserved for alice');
    assert.equal((await m.api('GET', '/v1/plugins/arena/trusted-publishers', { token: bob })).status, 404);
    assert.equal((await m.api('GET', '/v1/plugins/arena/trusted-publishers')).status, 401);
    assert.equal((await m.api('POST', '/v1/plugins/arena/trusted-publishers', { token: alice, body: { ...releasePublisher, workflow: '../evil' } })).status, 400);
    const squat = await publish(m, bob, 'arena', '0.0.1');
    assert.equal(squat.status, 403);
    assert.match(squat.json.error.message, /reserved by another account/);

    assert.equal((await m.api('GET', '/v1/registry')).json.oidc.github.audience, 'opencitadel');
    const exchanged = await m.api('POST', '/v1/oidc/github', { body: { token: mint(issuer, githubToken(m.now())) } });
    assert.equal(exchanged.status, 200, exchanged.text);
    assert.match(exchanged.json.token, /^ocp_/);
    assert.deepEqual(exchanged.json.plugins, ['arena']);
    assert.equal(exchanged.json.expiresAt, new Date(m.now() + 15 * 60 * 1000).toISOString());

    const published = await publish(m, exchanged.json.token, 'arena', '1.0.0', secret);
    assert.equal(published.status, 201, published.text);
    assert.equal(published.json.version.signature.keyId, publicKey.keyId, 'signatures still verify against the owning account');
    assert.equal(published.json.plugin.owner, 'alice', 'the reservation became ownership');
    const info = (await m.api('GET', '/v1/plugins/arena/1.0.0')).json;
    assert.deepEqual(info.provenance, {
      provider: 'github',
      repository: 'acme/arena',
      repositoryId: '4242',
      workflow: 'release.yml',
      ref: 'refs/tags/v1.0.0',
      sha: '0123456789abcdef0123456789abcdef01234567',
      runId: '987654',
      runAttempt: '1',
      environment: 'release',
      actor: 'octocat',
      eventName: 'push',
      url: 'https://github.com/acme/arena/actions/runs/987654',
    });
    // The token is multi-use until it expires, and scoped to what matched.
    assert.equal((await publish(m, exchanged.json.token, 'arena', '1.0.1', secret)).status, 201);
    const otherPlugin = await publish(m, exchanged.json.token, 'elsewhere', '1.0.0');
    assert.equal(otherPlugin.status, 403);
    assert.equal(otherPlugin.json.error.code, 'token_scope');

    // First use pinned GitHub's repository id: a re-created repo with the same name is refused.
    const list = (await m.api('GET', '/v1/plugins/arena/trusted-publishers', { token: alice })).json.publishers;
    assert.equal(list[0].repositoryId, '4242');
    const recreated = await m.api('POST', '/v1/oidc/github', { body: { token: mint(issuer, githubToken(m.now(), { repository_id: '9999' })) } });
    assert.equal(recreated.status, 401);
    assert.match(recreated.json.error.message, /pinned to 4242/);

    // Expiry.
    m.advance(15 * 60 * 1000 + 1);
    const late = await publish(m, exchanged.json.token, 'arena', '1.0.2', secret);
    assert.equal(late.status, 401);
    assert.equal(late.json.error.code, 'token_expired');
    assert.equal((await publish(m, 'ocp_' + 'x'.repeat(43), 'arena', '1.0.2')).status, 401);
  });
});

test('trusted publishing: tokens that do not match are refused with the reason', async () => {
  await withIssuer(async (m, issuer) => {
    const alice = await m.account('alice');
    await m.api('POST', '/v1/plugins/arena/trusted-publishers', { token: alice, body: releasePublisher });
    const exchange = (over: Record<string, unknown>, key = issuer) => m.api('POST', '/v1/oidc/github', { body: { token: mint(key, githubToken(m.now(), over)) } });

    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ job_workflow_ref: 'acme/arena/.github/workflows/deploy.yml@refs/tags/v1.0.0' }, /workflow is deploy\.yml, expected release\.yml/],
      [{ environment: undefined }, /must run in the "release" environment/],
      [{ environment: 'staging' }, /environment is staging, expected release/],
      [{ ref: 'refs/heads/main' }, /ref refs\/heads\/main does not match refs\/tags\/v\*/],
      [{ job_workflow_ref: 'mallory/tools/.github/workflows/release.yml@refs/heads/main' }, /not a workflow of acme\/arena/],
    ];
    for (const [over, reason] of cases) {
      const r = await exchange(over);
      assert.equal(r.status, 401, JSON.stringify(over));
      assert.equal(r.json.error.code, 'no_matching_publisher');
      assert.match(r.json.error.message, reason);
    }
    const unknownRepo = await exchange({ repository: 'acme/other', job_workflow_ref: 'acme/other/.github/workflows/release.yml@refs/tags/v1' });
    assert.equal(unknownRepo.json.error.code, 'no_trusted_publisher');

    const forged = await exchange({}, newKey('gh-1'));
    assert.equal(forged.status, 401);
    assert.equal(forged.json.error.code, 'invalid_token');
    assert.match(forged.json.error.message, /signature is invalid/);
    assert.match((await exchange({ aud: 'https://pypi.org' })).json.error.message, /audience/);
    assert.equal((await m.api('POST', '/v1/oidc/github', { body: { token: 'not-a-jwt-at-all' } })).json.error.code, 'invalid_token');
    assert.equal((await m.api('POST', '/v1/oidc/github', { body: {} })).status, 400);

    // A disabled owner's publishers stop working.
    const adminless = await m.api('GET', '/v1/accounts/me', { token: alice });
    m.master.store.setAccountDisabled(adminless.json.account.id, true);
    assert.match((await exchange({})).json.error.message, /owning account is disabled/);
  });
});

test('trusted publishing: one repo can publish several plugins; owners manage publishers and settings', async () => {
  await withIssuer(async (m, issuer) => {
    const alice = await m.account('alice');
    const bob = await m.account('bob');
    // An existing plugin, published the classic way first.
    assert.equal((await publish(m, alice, 'arena', '0.9.0')).status, 201);
    assert.equal((await m.api('POST', '/v1/plugins/arena/trusted-publishers', { token: bob, body: releasePublisher })).status, 404, 'owner only');
    const tp = (await m.api('POST', '/v1/plugins/arena/trusted-publishers', { token: alice, body: releasePublisher })).json.publisher;
    await m.api('POST', '/v1/plugins/arena-maps/trusted-publishers', { token: alice, body: { repository: 'acme/arena', workflow: 'release.yml' } });

    const token = (await m.api('POST', '/v1/oidc/github', { body: { token: mint(issuer, githubToken(m.now())) } })).json;
    assert.deepEqual(token.plugins.sort(), ['arena', 'arena-maps']);

    // Require trusted publishing: account keys can no longer publish, CI still can.
    assert.equal((await m.api('PUT', '/v1/plugins/arena/settings', { token: bob, body: { requireTrustedPublishing: true } })).status, 404);
    const set = await m.api('PUT', '/v1/plugins/arena/settings', { token: alice, body: { requireTrustedPublishing: true } });
    assert.deepEqual(set.json, { settings: { requireTrustedPublishing: true } });
    assert.equal((await m.api('PUT', '/v1/plugins/arena/settings', { token: alice, body: { requireTrustedPublishing: 'yes' } })).status, 400);
    const blocked = await publish(m, alice, 'arena', '1.0.0');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.error.code, 'trusted_publishing_required');
    assert.equal((await publish(m, token.token, 'arena', '1.0.0')).status, 201);
    assert.equal((await m.api('GET', '/v1/plugins/arena')).json.plugin.requireTrustedPublishing, true);
    assert.equal((await m.api('GET', '/v1/plugins')).json.plugins.find((p: { id: string }) => p.id === 'arena').requireTrustedPublishing, true);
    assert.equal((await publish(m, token.token, 'arena-maps', '0.1.0')).status, 201);
    assert.equal((await m.api('GET', '/v1/plugins/arena-maps')).json.plugin.requireTrustedPublishing, undefined);

    // Removing the publisher stops new exchanges for that plugin.
    assert.equal((await m.api('DELETE', `/v1/plugins/arena/trusted-publishers/${tp.id}`, { token: bob })).status, 404);
    assert.equal((await m.api('DELETE', `/v1/plugins/arena-maps/trusted-publishers/${tp.id}`, { token: alice })).status, 404, 'publisher ids are per plugin');
    assert.equal((await m.api('DELETE', `/v1/plugins/arena/trusted-publishers/${tp.id}`, { token: alice })).status, 204);
    const after = (await m.api('POST', '/v1/oidc/github', { body: { token: mint(issuer, githubToken(m.now())) } })).json;
    assert.deepEqual(after.plugins, ['arena-maps']);

    // At most 10 per plugin.
    for (let i = 0; i < 10; i++) {
      const r = await m.api('POST', '/v1/plugins/arena/trusted-publishers', { token: alice, body: { repository: `acme/repo${i}`, workflow: 'release.yml' } });
      assert.equal(r.status, 201);
    }
    assert.equal((await m.api('POST', '/v1/plugins/arena/trusted-publishers', { token: alice, body: { repository: 'acme/one-more', workflow: 'release.yml' } })).json.error.code, 'publisher_limit');
  });
});
