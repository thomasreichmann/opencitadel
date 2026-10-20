/**
 * Trusted publishing: verifying GitHub Actions OIDC tokens and matching them to the trusted
 * publishers plugin owners configured. See docs/ARCHITECTURE.md ("Trusted publishing (CI)").
 *
 * The verifier accepts RS256 only, takes keys from the issuer's JWKS (cached, re-fetched for an
 * unknown `kid` at most once a minute), and checks iss/aud/exp/nbf/iat with 60 s of leeway.
 */

import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import type { Provenance, TrustedPublisher } from '@opencitadel/protocol';

export const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
const LEEWAY_S = 60;
const JWKS_REFETCH_MS = 60_000;
const MAX_TOKEN_LENGTH = 16 * 1024;
const MAX_JWKS_BYTES = 256 * 1024;

export class OidcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OidcError';
  }
}

export interface OidcConfig {
  issuer: string;
  jwksUrl: string;
  audience: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/** The claims of a GitHub Actions OIDC token that trusted publishing relies on. */
export interface GithubClaims {
  repository: string;
  repository_id: string;
  repository_owner?: string;
  job_workflow_ref: string;
  workflow_ref?: string;
  ref: string;
  sha: string;
  run_id: string;
  run_attempt: string;
  environment?: string;
  actor?: string;
  event_name?: string;
  workflow?: string;
  server_url?: string;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

function decodeSegment(segment: string, what: string): Buffer {
  if (!segment || !BASE64URL.test(segment)) throw new OidcError(`malformed token: the ${what} is not base64url`);
  return Buffer.from(segment, 'base64url');
}

function decodeJson(segment: string, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(decodeSegment(segment, what).toString('utf8'));
  } catch (err) {
    if (err instanceof OidcError) throw err;
    throw new OidcError(`malformed token: the ${what} is not JSON`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new OidcError(`malformed token: the ${what} is not a JSON object`);
  return value as Record<string, unknown>;
}

export class JwtVerifier {
  private keys = new Map<string, KeyObject>();
  private fetchedAt = -Infinity;
  private inflight?: Promise<void>;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;

  constructor(readonly config: OidcConfig) {
    this.fetch = config.fetch ?? globalThis.fetch;
    this.now = config.now ?? Date.now;
  }

  /** Verifies a compact JWT and returns its payload. Throws OidcError with the reason. */
  async verify(token: string): Promise<Record<string, unknown>> {
    if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) throw new OidcError('malformed token');
    const parts = token.split('.');
    if (parts.length !== 3) throw new OidcError('malformed token: expected three dot-separated parts');
    const [h, p, s] = parts as [string, string, string];
    const header = decodeJson(h, 'header');
    if (header.alg !== 'RS256') throw new OidcError(`unsupported token algorithm "${String(header.alg)}" (only RS256 is accepted)`);
    if (typeof header.kid !== 'string' || !header.kid) throw new OidcError('the token header has no key id (kid)');
    const payload = decodeJson(p, 'payload');
    const signature = decodeSegment(s, 'signature');

    const key = await this.key(header.kid);
    if (!verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, signature)) throw new OidcError('the token signature is invalid');

    if (payload.iss !== this.config.issuer) throw new OidcError(`the token was issued by "${String(payload.iss)}", expected "${this.config.issuer}"`);
    const aud = payload.aud;
    const audiences = Array.isArray(aud) ? aud : [aud];
    if (!audiences.includes(this.config.audience)) throw new OidcError(`the token audience is not "${this.config.audience}"; request the token with that audience`);
    const nowS = this.now() / 1000;
    if (typeof payload.exp !== 'number') throw new OidcError('the token has no expiry');
    if (nowS > payload.exp + LEEWAY_S) throw new OidcError('the token has expired');
    if (typeof payload.nbf === 'number' && nowS + LEEWAY_S < payload.nbf) throw new OidcError('the token is not valid yet');
    if (typeof payload.iat === 'number' && payload.iat > nowS + LEEWAY_S) throw new OidcError('the token was issued in the future');
    return payload;
  }

  private async key(kid: string): Promise<KeyObject> {
    let key = this.keys.get(kid);
    if (!key && this.now() - this.fetchedAt >= JWKS_REFETCH_MS) {
      await this.refresh();
      key = this.keys.get(kid);
    }
    if (!key) throw new OidcError(`the token was signed by an unknown key "${kid}"`);
    return key;
  }

  private refresh(): Promise<void> {
    this.inflight ??= this.load().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async load(): Promise<void> {
    this.fetchedAt = this.now();
    let body: unknown;
    try {
      const res = await this.fetch(this.config.jwksUrl, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length > MAX_JWKS_BYTES) throw new Error('response too large');
      body = JSON.parse(text);
    } catch (err) {
      throw new OidcError(`could not fetch the issuer's signing keys: ${(err as Error).message}`);
    }
    const list = (body as { keys?: unknown })?.keys;
    if (!Array.isArray(list)) throw new OidcError("the issuer's JWKS has no keys");
    const keys = new Map<string, KeyObject>();
    for (const jwk of list as Array<Record<string, unknown>>) {
      if (jwk?.kty !== 'RSA' || typeof jwk.kid !== 'string' || (jwk.use !== undefined && jwk.use !== 'sig')) continue;
      if (jwk.alg !== undefined && jwk.alg !== 'RS256') continue;
      try {
        keys.set(jwk.kid, createPublicKey({ key: { kty: 'RSA', n: jwk.n as string, e: jwk.e as string }, format: 'jwk' }));
      } catch {
        // Skip keys Node can't import; another key may still verify.
      }
    }
    this.keys = keys;
  }
}

/** Pulls the claims trusted publishing needs, or throws if the token isn't a GitHub Actions token. */
export function githubClaims(payload: Record<string, unknown>): GithubClaims {
  const str = (k: string): string | undefined => {
    const v = payload[k];
    return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;
  };
  const need = (k: string): string => {
    const v = str(k);
    if (!v) throw new OidcError(`the token has no "${k}" claim; is it a GitHub Actions token?`);
    return v;
  };
  const claims: GithubClaims = {
    repository: need('repository'),
    repository_id: need('repository_id'),
    job_workflow_ref: need('job_workflow_ref'),
    ref: need('ref'),
    sha: need('sha'),
    run_id: need('run_id'),
    run_attempt: need('run_attempt'),
  };
  for (const k of ['repository_owner', 'workflow_ref', 'environment', 'actor', 'event_name', 'workflow', 'server_url'] as const) {
    const v = str(k);
    if (v) claims[k] = v;
  }
  return claims;
}

/**
 * The workflow file of a `job_workflow_ref` like `owner/repo/.github/workflows/release.yml@refs/tags/v1`,
 * provided the workflow lives in `repository` itself (reusable workflows from other repositories
 * are not accepted).
 */
export function workflowFile(jobWorkflowRef: string, repository: string): string | undefined {
  const m = /^([^/]+\/[^/]+)\/\.github\/workflows\/([^/@]+)@.+$/.exec(jobWorkflowRef);
  if (!m || m[1]!.toLowerCase() !== repository.toLowerCase()) return undefined;
  return m[2];
}

/** `*` matches any run of characters within one path segment; everything else is literal. */
export function refMatches(pattern: string, ref: string): boolean {
  const re = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
  return new RegExp(`^${re}$`).test(ref);
}

/** Why a trusted publisher does not accept these claims, or undefined when it does. */
export function mismatch(tp: Pick<TrustedPublisher, 'repository' | 'workflow' | 'environment' | 'ref' | 'repositoryId'>, claims: GithubClaims): string | undefined {
  if (tp.repository.toLowerCase() !== claims.repository.toLowerCase()) return `repository is ${claims.repository}, expected ${tp.repository}`;
  if (tp.repositoryId && tp.repositoryId !== claims.repository_id) {
    return `repository id is ${claims.repository_id}, but this publisher is pinned to ${tp.repositoryId} (was the repository deleted and re-created?)`;
  }
  const file = workflowFile(claims.job_workflow_ref, claims.repository);
  if (!file) return `the workflow ${claims.job_workflow_ref} is not a workflow of ${claims.repository}`;
  if (file !== tp.workflow) return `workflow is ${file}, expected ${tp.workflow}`;
  if (tp.environment && tp.environment.toLowerCase() !== (claims.environment ?? '').toLowerCase()) {
    return claims.environment ? `environment is ${claims.environment}, expected ${tp.environment}` : `the job must run in the "${tp.environment}" environment`;
  }
  if (tp.ref && !refMatches(tp.ref, claims.ref)) return `ref ${claims.ref} does not match ${tp.ref}`;
  return undefined;
}

/** What the registry records about the build that published a version. */
export function provenanceOf(claims: GithubClaims, issuer: string): Provenance {
  let server = 'https://github.com';
  if (claims.server_url && /^https:\/\/[^\s/]+$/.test(claims.server_url.replace(/\/+$/, ''))) server = claims.server_url.replace(/\/+$/, '');
  else if (issuer !== GITHUB_ISSUER) server = new URL(issuer).origin;
  const out: Provenance = {
    provider: 'github',
    repository: claims.repository,
    repositoryId: claims.repository_id,
    workflow: workflowFile(claims.job_workflow_ref, claims.repository) ?? claims.job_workflow_ref,
    ref: claims.ref,
    sha: claims.sha,
    runId: claims.run_id,
    runAttempt: claims.run_attempt,
    url: `${server}/${claims.repository}/actions/runs/${encodeURIComponent(claims.run_id)}`,
  };
  if (claims.environment) out.environment = claims.environment;
  if (claims.actor) out.actor = claims.actor;
  if (claims.event_name) out.eventName = claims.event_name;
  return out;
}
