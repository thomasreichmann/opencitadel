/**
 * Deciding whether to trust a package: verify its minisign signature and apply the host's key
 * policy. See docs/ARCHITECTURE.md ("Package trust on the host").
 *
 * Pins are stored per plugin in trust.json with the full public key, not just the key id:
 * minisign key ids are random labels, so anyone (including a compromised registry) can mint a
 * key with the same id. Once pinned, a plugin's updates are verified against the pinned key
 * material, whatever the registry later says.
 */

import { parsePublicKey, parseSignature, verifySignature, SignatureError, type PublicKeyInfo, type SigningKeyInfo } from '@opencitadel/protocol';
import type { HostConfig } from '../config.js';
import { packageStore, readJsonObject, writeJsonAtomic, type StoreLocation } from './installed.js';

export interface PinnedKey {
  keyId: string;
  /** minisign public key line. */
  publicKey: string;
  pinnedAt: string;
  how: 'first-use' | 'accepted' | 'trusted-config';
}

export type TrustStore = Record<string, { keys: PinnedKey[] }>;

export async function readTrust(location: StoreLocation): Promise<TrustStore> {
  return readJsonObject<TrustStore>(packageStore(location).trust, {});
}

export async function writeTrust(location: StoreLocation, trust: TrustStore): Promise<void> {
  await writeJsonAtomic(packageStore(location).trust, trust);
}

export class TrustError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrustError';
  }
}

export interface TrustPolicy {
  security: HostConfig['security'];
  /** Accept (and re-pin to) a signing key outside the pinned set. */
  acceptNewKey?: boolean;
  /** Accept an unsigned package even though the plugin was signed before or keys are configured. */
  allowUnsigned?: boolean;
  /** Public keys supplied on the command line (`--key-file`). */
  extraKeys?: PublicKeyInfo[];
}

export interface TrustDecision {
  signed: boolean;
  keyId?: string;
  trustedComment?: string;
  /** Human-readable status, e.g. `signed by EF28… (pinned)` or `UNSIGNED`. */
  status: string;
  /** Pin set to store for this plugin once the install succeeds (undefined: leave as is). */
  pin?: PinnedKey[];
}

/** Keys from security.trustedKeys for this plugin: per-id entries plus `"*"`. Entries are key ids or full public keys. */
function configuredKeys(security: HostConfig['security'], id: string): { ids: Set<string>; keys: PublicKeyInfo[] } {
  const entries = [...(security.trustedKeys[id] ?? []), ...(security.trustedKeys['*'] ?? [])];
  const ids = new Set<string>();
  const keys: PublicKeyInfo[] = [];
  for (const entry of entries) {
    if (/^[0-9A-Fa-f]{16}$/.test(entry)) ids.add(entry.toUpperCase());
    else {
      const key = parsePublicKey(entry);
      ids.add(key.keyId);
      keys.push(key);
    }
  }
  return { ids, keys };
}

/**
 * Checks `archive` against `signatureText` and the policy. Throws TrustError when the package
 * must not be installed. Has no side effects: callers persist `decision.pin` once the install
 * has succeeded.
 */
export function decideTrust(
  id: string,
  archive: Buffer,
  signatureText: string | undefined,
  pinned: PinnedKey[] | undefined,
  publisherKeys: SigningKeyInfo[] | undefined,
  policy: TrustPolicy,
  now = new Date(),
): TrustDecision {
  const configured = configuredKeys(policy.security, id);
  const pins = pinned ?? [];

  if (!signatureText) {
    if (policy.security.requireSignatures) throw new TrustError(`${id} is not signed, and security.requireSignatures is on`);
    if (!policy.allowUnsigned) {
      if (configured.ids.size) throw new TrustError(`${id} is not signed, but security.trustedKeys lists keys for it. Use --allow-unsigned to install it anyway.`);
      if (pins.length) throw new TrustError(`${id} was signed by ${pins.map((p) => p.keyId).join(', ')} before, but this version is not signed. Use --allow-unsigned to install it anyway.`);
    }
    return { signed: false, status: 'UNSIGNED: nothing proves who published this package' };
  }

  let keyId: string;
  try {
    keyId = parseSignature(signatureText).keyId;
  } catch (err) {
    throw new TrustError(`${id}: ${(err as Error).message}`);
  }
  const revoked = publisherKeys?.find((k) => k.keyId === keyId && k.revokedAt);
  if (revoked) throw new TrustError(`${id} is signed with key ${keyId}, which its publisher revoked on ${revoked.revokedAt}`);

  // Key material, most trusted first: configured full keys, pins, then what the registry or the
  // command line supplies.
  const fromRegistry = (publisherKeys ?? []).filter((k) => !k.revokedAt).map((k) => parsePublicKey(k.publicKey));
  const material = (kid: string): PublicKeyInfo | undefined =>
    configured.keys.find((k) => k.keyId === kid) ??
    (pins.find((p) => p.keyId === kid) && parsePublicKey(pins.find((p) => p.keyId === kid)!.publicKey)) ??
    policy.extraKeys?.find((k) => k.keyId === kid) ??
    fromRegistry.find((k) => k.keyId === kid);

  let how: PinnedKey['how'];
  let note: string;
  if (configured.ids.size) {
    if (!configured.ids.has(keyId)) throw new TrustError(`${id} is signed by ${keyId}, which security.trustedKeys does not allow (${[...configured.ids].join(', ')})`);
    how = 'trusted-config';
    note = 'trusted key from server config';
  } else if (pins.length && !pins.some((p) => p.keyId === keyId)) {
    if (!policy.acceptNewKey) {
      throw new TrustError(
        `${id} is now signed by ${keyId}, but it is pinned to ${pins.map((p) => p.keyId).join(', ')}. ` +
          `If the publisher rotated their key, check with them out of band, then rerun with --accept-new-key.`,
      );
    }
    how = 'accepted';
    note = 'new key accepted with --accept-new-key';
  } else if (pins.length) {
    how = pins.find((p) => p.keyId === keyId)!.how;
    note = 'pinned';
  } else {
    how = 'first-use';
    note = 'pinned on first use';
  }

  const key = material(keyId);
  if (!key) throw new TrustError(`${id} is signed by ${keyId}, but no public key for it is known. Pass its public key with --key-file.`);
  const pinnedKey = pins.find((p) => p.keyId === keyId);
  const registryKey = fromRegistry.find((k) => k.keyId === keyId);
  if (pinnedKey && registryKey && registryKey.publicKey !== pinnedKey.publicKey) {
    // Verification still uses the pinned key; this only explains a failure that follows.
    note += '; WARNING: the registry reports a different public key for this key id';
  }
  let verified: { keyId: string; trustedComment: string };
  try {
    verified = verifySignature(archive, signatureText, [key]);
  } catch (err) {
    if (err instanceof SignatureError) throw new TrustError(`${id}: ${err.message}`);
    throw err;
  }

  const entry: PinnedKey = { keyId, publicKey: key.publicKey, pinnedAt: now.toISOString(), how };
  const pin = how === 'accepted' ? [entry] : pinnedKey ? undefined : [...pins, entry];
  return { signed: true, keyId, trustedComment: verified.trustedComment, status: `signed by ${keyId} (${note})`, pin };
}
