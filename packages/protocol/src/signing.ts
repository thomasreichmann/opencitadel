/**
 * Package signatures in minisign format (https://jedisct1.github.io/minisign/).
 *
 * Publishers sign the exact `.tar.gz` bytes with an Ed25519 key. Public keys and signature
 * files are byte-compatible with minisign, so anyone can check a package without OpenCitadel:
 *
 *   minisign -Vm welcome-1.0.0.tgz -P RWQ…
 *
 * Secret keys use OpenCitadel's own file format (PKCS#8 PEM, optionally passphrase-encrypted),
 * since minisign's secret-key format is only needed by minisign itself.
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from 'node:crypto';

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const SIG_ALG_PREHASHED = Buffer.from('ED');
const SIG_ALG_LEGACY = Buffer.from('Ed');
const UNTRUSTED = 'untrusted comment: ';
const TRUSTED = 'trusted comment: ';
const SECRET_KEY_FORMAT = 'opencitadel-ed25519-secret-v1';

export class SignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignatureError';
  }
}

export interface PublicKeyInfo {
  /** minisign's display form: the 8 key-id bytes read little-endian, as 16 uppercase hex digits. */
  keyId: string;
  /** The base64 line of a minisign public key file (`RWQ…`). */
  publicKey: string;
  raw: Buffer;
}

export interface SecretKeyFile {
  format: typeof SECRET_KEY_FORMAT;
  keyId: string;
  /** minisign public key line, so the secret file alone is enough to publish the public half. */
  publicKey: string;
  /** PKCS#8 PEM; encrypted when the key was generated with a passphrase. */
  pkcs8: string;
  encrypted: boolean;
  createdAt: string;
}

function keyIdDisplay(bytes: Buffer): string {
  return Buffer.from(bytes).reverse().toString('hex').toUpperCase();
}

function keyIdBytes(display: string): Buffer {
  if (!/^[0-9A-Fa-f]{16}$/.test(display)) throw new SignatureError(`Invalid key id "${display}"`);
  return Buffer.from(display, 'hex').reverse();
}

function rawPublicKey(key: KeyObject): Buffer {
  return key.export({ format: 'der', type: 'spki' }).subarray(SPKI_ED25519_PREFIX.length);
}

function publicKeyObject(raw: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: 'der', type: 'spki' });
}

/** Accepts a whole minisign `.pub` file or just its base64 line. */
export function parsePublicKey(text: string): PublicKeyInfo {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith(UNTRUSTED));
  if (!line || !/^[A-Za-z0-9+/]+=*$/.test(line)) throw new SignatureError('Not a minisign public key');
  const bin = Buffer.from(line, 'base64');
  if (bin.length !== 42 || !bin.subarray(0, 2).equals(SIG_ALG_LEGACY)) throw new SignatureError('Not an Ed25519 minisign public key');
  return { keyId: keyIdDisplay(bin.subarray(2, 10)), publicKey: line, raw: bin.subarray(10) };
}

/** The two-line `.pub` file minisign writes. */
export function formatPublicKeyFile(info: Pick<PublicKeyInfo, 'keyId' | 'publicKey'>): string {
  return `${UNTRUSTED}minisign public key ${info.keyId}\n${info.publicKey}\n`;
}

/** Creates a new signing key. With a passphrase, the secret key is stored encrypted (AES-256-CBC, scrypt-derived via OpenSSL PEM). */
export function generateSigningKey(passphrase?: string): { secret: SecretKeyFile; publicKey: PublicKeyInfo } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const id = randomBytes(8);
  const raw = rawPublicKey(publicKey);
  const line = Buffer.concat([SIG_ALG_LEGACY, id, raw]).toString('base64');
  const pkcs8 = privateKey.export(
    passphrase ? { format: 'pem', type: 'pkcs8', cipher: 'aes-256-cbc', passphrase } : { format: 'pem', type: 'pkcs8' },
  ) as string;
  const keyId = keyIdDisplay(id);
  return {
    secret: { format: SECRET_KEY_FORMAT, keyId, publicKey: line, pkcs8, encrypted: !!passphrase, createdAt: new Date().toISOString() },
    publicKey: { keyId, publicKey: line, raw },
  };
}

export function parseSecretKeyFile(text: string): SecretKeyFile {
  let json: Partial<SecretKeyFile>;
  try {
    json = JSON.parse(text);
  } catch {
    throw new SignatureError('Signing key file is not valid JSON');
  }
  if (json.format !== SECRET_KEY_FORMAT || typeof json.pkcs8 !== 'string' || typeof json.keyId !== 'string' || typeof json.publicKey !== 'string') {
    throw new SignatureError('Not an OpenCitadel signing key file');
  }
  return json as SecretKeyFile;
}

function loadPrivateKey(secret: SecretKeyFile, passphrase?: string): KeyObject {
  if (secret.encrypted && !passphrase) throw new SignatureError(`Signing key ${secret.keyId} is encrypted; a passphrase is required`);
  try {
    return createPrivateKey(secret.encrypted ? { key: secret.pkcs8, format: 'pem', passphrase } : { key: secret.pkcs8, format: 'pem' });
  } catch {
    throw new SignatureError(`Could not unlock signing key ${secret.keyId} (wrong passphrase?)`);
  }
}

export interface SignOptions {
  trustedComment?: string;
  untrustedComment?: string;
  passphrase?: string;
}

/** Signs `data` and returns a minisign signature file (prehashed `ED` variant, as minisign ≥ 0.10 does by default). */
export function signData(data: Buffer, secret: SecretKeyFile, opts: SignOptions = {}): string {
  const key = loadPrivateKey(secret, opts.passphrase);
  const pub = parsePublicKey(secret.publicKey);
  if (!rawPublicKey(createPublicKey(key)).equals(pub.raw)) throw new SignatureError('Signing key file is corrupt: public and secret halves differ');
  const trusted = (opts.trustedComment ?? `timestamp:${Math.floor(Date.now() / 1000)}`).replace(/[\r\n]/g, ' ');
  const untrusted = (opts.untrustedComment ?? 'signature from opencitadel secret key').replace(/[\r\n]/g, ' ');
  const digest = createHash('blake2b512').update(data).digest();
  const signature = sign(null, digest, key);
  const global = sign(null, Buffer.concat([signature, Buffer.from(trusted, 'utf8')]), key);
  const sigLine = Buffer.concat([SIG_ALG_PREHASHED, keyIdBytes(secret.keyId), signature]).toString('base64');
  return `${UNTRUSTED}${untrusted}\n${sigLine}\n${TRUSTED}${trusted}\n${global.toString('base64')}\n`;
}

export interface ParsedSignature {
  keyId: string;
  algorithm: 'ED' | 'Ed';
  signature: Buffer;
  trustedComment: string;
  globalSignature: Buffer;
}

export function parseSignature(text: string): ParsedSignature {
  const lines = text.split(/\r?\n/);
  if (lines.length < 4 || !lines[0]!.startsWith(UNTRUSTED) || !lines[2]!.startsWith(TRUSTED)) throw new SignatureError('Not a minisign signature file');
  const bin = Buffer.from(lines[1]!.trim(), 'base64');
  const global = Buffer.from(lines[3]!.trim(), 'base64');
  if (bin.length !== 74 || global.length !== 64) throw new SignatureError('Malformed minisign signature');
  const alg = bin.subarray(0, 2);
  if (!alg.equals(SIG_ALG_PREHASHED) && !alg.equals(SIG_ALG_LEGACY)) throw new SignatureError('Unsupported signature algorithm');
  return {
    keyId: keyIdDisplay(bin.subarray(2, 10)),
    algorithm: alg.equals(SIG_ALG_PREHASHED) ? 'ED' : 'Ed',
    signature: bin.subarray(10),
    trustedComment: lines[2]!.slice(TRUSTED.length),
    globalSignature: global,
  };
}

/**
 * Verifies `data` against a signature file and a set of acceptable public keys. Returns the
 * signing key id and trusted comment; throws SignatureError if no key matches or either the
 * file signature or the trusted-comment signature fails.
 */
export function verifySignature(data: Buffer, signatureText: string, publicKeys: Array<string | PublicKeyInfo>): { keyId: string; trustedComment: string } {
  const sig = parseSignature(signatureText);
  const keys = publicKeys.map((k) => (typeof k === 'string' ? parsePublicKey(k) : k));
  const key = keys.find((k) => k.keyId === sig.keyId);
  if (!key) throw new SignatureError(`Signed by key ${sig.keyId}, which is not one of the trusted keys (${keys.map((k) => k.keyId).join(', ') || 'none'})`);
  const pub = publicKeyObject(key.raw);
  const message = sig.algorithm === 'ED' ? createHash('blake2b512').update(data).digest() : data;
  if (!verify(null, message, pub, sig.signature)) throw new SignatureError(`Signature by key ${sig.keyId} does not match the package contents`);
  if (!verify(null, Buffer.concat([sig.signature, Buffer.from(sig.trustedComment, 'utf8')]), pub, sig.globalSignature)) {
    throw new SignatureError(`Trusted comment of the signature by key ${sig.keyId} has been tampered with`);
  }
  return { keyId: sig.keyId, trustedComment: sig.trustedComment };
}

/** The trusted comment OpenCitadel puts on package signatures. */
export function packageTrustedComment(id: string, version: string, sha256: string, now = Date.now()): string {
  return `opencitadel package ${id}@${version} sha256:${sha256} timestamp:${Math.floor(now / 1000)}`;
}
