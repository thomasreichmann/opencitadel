import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ACCOUNT_KEY_PREFIX, PUBLISH_TOKEN_PREFIX, SERVER_TOKEN_PREFIX } from '@opencitadel/protocol';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** 16-character lowercase base32 id (80 random bits). */
export function newId(): string {
  const bytes = randomBytes(10);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

export const newAccountKey = (): string => ACCOUNT_KEY_PREFIX + randomBytes(32).toString('base64url');
export const newServerToken = (): string => SERVER_TOKEN_PREFIX + randomBytes(32).toString('base64url');
export const newPublishToken = (): string => PUBLISH_TOKEN_PREFIX + randomBytes(32).toString('base64url');

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Constant-time comparison of a presented secret against a stored hash. */
export function secretMatches(secret: string, storedHash: string): boolean {
  const a = Buffer.from(hashSecret(secret), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
