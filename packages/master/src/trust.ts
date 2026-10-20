/**
 * Registry trust: verifying publisher signatures against the account's registered keys,
 * tracking key changes between versions, and the JSON views for keys, advisories and reports.
 * See docs/ARCHITECTURE.md ("Registry trust and moderation").
 */

import { compareVersions, parseSignature, verifySignature, type Advisory, type AdvisorySeverity, type SigningKeyInfo, type TrustedPublisher } from '@opencitadel/protocol';
import { HttpError } from './http.js';
import type { AdvisoryRow, ReportRow, SigningKeyRow, Store, TrustedPublisherRow } from './store.js';

/** Most active keys an account may hold at once. */
export const MAX_ACTIVE_SIGNING_KEYS = 10;
/** Most trusted publishers a plugin may have. */
export const MAX_TRUSTED_PUBLISHERS = 10;
/** Upper bound for a base64-encoded `.minisig` in the publish header. */
const MAX_SIGNATURE_HEADER = 4096;

const OUR_TRUSTED_COMMENT = /^opencitadel package (\S+)@(\S+) sha256:([0-9a-f]{64})(?:\s|$)/;

/** Decodes the `X-OpenCitadel-Signature` header (base64 of the .minisig text). */
export function decodeSignatureHeader(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  const raw = (Array.isArray(value) ? value.join('') : value).trim();
  if (!raw) return undefined;
  if (raw.length > MAX_SIGNATURE_HEADER || !/^[A-Za-z0-9+/]+=*$/.test(raw)) {
    throw new HttpError(400, 'invalid_signature', 'X-OpenCitadel-Signature must be the base64 encoding of a .minisig file');
  }
  return Buffer.from(raw, 'base64').toString('utf8');
}

/**
 * Checks `signatureText` over `pkg` against the account's active keys. Rejects revoked or
 * unknown keys, tampered packages, and OpenCitadel trusted comments that name another package.
 * Returns the signing key id and the signature text normalised to end with a newline.
 */
export function verifyPackageSignature(
  store: Store,
  accountId: string,
  pkg: Buffer,
  signatureText: string,
  expect: { id: string; version: string; sha256: string },
): { keyId: string; signature: string } {
  let keyId: string;
  try {
    keyId = parseSignature(signatureText).keyId;
  } catch (err) {
    throw new HttpError(400, 'invalid_signature', (err as Error).message);
  }
  const key = store.signingKey(keyId);
  if (key && key.account_id === accountId && key.revoked_at !== null) {
    throw new HttpError(400, 'invalid_signature', `Signing key ${keyId} has been revoked`);
  }
  const active = store.signingKeys(accountId).filter((k) => k.revoked_at === null);
  if (!active.length) {
    throw new HttpError(400, 'invalid_signature', 'This account has no signing keys; register one with POST /v1/accounts/me/signing-keys');
  }
  let trustedComment: string;
  try {
    trustedComment = verifySignature(pkg, signatureText, active.map((k) => k.public_key)).trustedComment;
  } catch (err) {
    throw new HttpError(400, 'invalid_signature', (err as Error).message);
  }
  const ours = OUR_TRUSTED_COMMENT.exec(trustedComment);
  if (ours && (ours[1] !== expect.id || ours[2] !== expect.version || ours[3] !== expect.sha256)) {
    throw new HttpError(400, 'invalid_signature', `The signature was made for ${ours[1]}@${ours[2]}, not ${expect.id}@${expect.version}`);
  }
  return { keyId, signature: signatureText.replace(/\s*$/, '\n') };
}

/**
 * Recomputes `key_changed` for every version of a plugin, in semver order: a signed version is
 * flagged when the nearest lower signed version used a different key, and an unsigned version
 * is flagged when any lower version was signed.
 */
export function recomputeKeyChanged(store: Store, pluginId: string): void {
  const versions = store.versions(pluginId).sort((a, b) => compareVersions(a.version, b.version));
  let lastKey: string | null = null;
  for (const v of versions) {
    const changed = v.signature_key_id ? lastKey !== null && lastKey !== v.signature_key_id : lastKey !== null;
    if (!!v.key_changed !== changed) store.setKeyChanged(pluginId, v.version, changed);
    if (v.signature_key_id) lastKey = v.signature_key_id;
  }
}

export function signingKeyView(k: SigningKeyRow): SigningKeyInfo {
  const out: SigningKeyInfo = { keyId: k.key_id, publicKey: k.public_key, addedAt: new Date(k.added_at).toISOString() };
  if (k.label) out.label = k.label;
  if (k.revoked_at !== null) out.revokedAt = new Date(k.revoked_at).toISOString();
  return out;
}

export function trustedPublisherView(r: TrustedPublisherRow): TrustedPublisher {
  const out: TrustedPublisher = {
    id: r.id,
    pluginId: r.plugin_id,
    provider: r.provider,
    repository: r.repository,
    workflow: r.workflow,
    addedAt: new Date(r.added_at).toISOString(),
  };
  if (r.environment) out.environment = r.environment;
  if (r.ref) out.ref = r.ref;
  if (r.repository_id) out.repositoryId = r.repository_id;
  return out;
}

export function advisoryView(a: AdvisoryRow): Advisory {
  const out: Advisory = {
    id: a.id,
    pluginId: a.plugin_id,
    severity: a.severity as AdvisorySeverity,
    title: a.title,
    description: a.description,
    affected: a.affected,
    publishedAt: new Date(a.published_at).toISOString(),
    withdrawn: !!a.withdrawn,
  };
  if (a.fixed_in) out.fixedIn = a.fixed_in;
  if (a.url) out.url = a.url;
  return out;
}

/** Admin-only view: includes the reporter's contact and IP. */
export function reportView(r: ReportRow) {
  return {
    id: r.id,
    pluginId: r.plugin_id,
    ...(r.version ? { version: r.version } : {}),
    reason: r.reason,
    details: r.details,
    ...(r.contact ? { contact: r.contact } : {}),
    ...(r.ip ? { ip: r.ip } : {}),
    createdAt: new Date(r.created_at).toISOString(),
    status: r.status,
    ...(r.resolved_at !== null ? { resolvedAt: new Date(r.resolved_at).toISOString() } : {}),
    ...(r.resolution ? { resolution: r.resolution } : {}),
  };
}
