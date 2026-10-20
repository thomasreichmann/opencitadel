/**
 * Publisher signing keys on the author's machine: generation, discovery and loading.
 * Keys live in `~/.opencitadel/signing/<keyId>.key` (mode 0600) next to a minisign `.pub` file;
 * `OPENCITADEL_HOME` moves `~/.opencitadel`.
 */

import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { formatPublicKeyFile, generateSigningKey, parsePublicKey, parseSecretKeyFile, type PublicKeyInfo, type SecretKeyFile } from '@opencitadel/protocol';

export function signingDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.OPENCITADEL_HOME ?? join(homedir(), '.opencitadel'), 'signing');
}

export interface GeneratedKey {
  keyFile: string;
  publicKeyFile: string;
  publicKey: PublicKeyInfo;
  encrypted: boolean;
}

/** Writes a new key pair. Refuses to overwrite an existing file. */
export async function createSigningKey(out: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<GeneratedKey> {
  const passphrase = env.OPENCITADEL_SIGNING_PASSPHRASE || undefined;
  const { secret, publicKey } = generateSigningKey(passphrase);
  const keyFile = resolve(out ?? join(signingDir(env), `${secret.keyId}.key`));
  const publicKeyFile = keyFile.replace(/\.key$/i, '') + '.pub';
  if (existsSync(keyFile)) throw new Error(`${keyFile} already exists`);
  await mkdir(dirname(keyFile), { recursive: true, mode: 0o700 });
  await writeFile(keyFile, JSON.stringify(secret, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await chmod(keyFile, 0o600).catch(() => {});
  await writeFile(publicKeyFile, formatPublicKeyFile(publicKey));
  return { keyFile, publicKeyFile, publicKey, encrypted: secret.encrypted };
}

/** How an inline key from the environment is labelled in place of a file path. */
export const INLINE_KEY_LABEL = '$OPENCITADEL_SIGNING_KEY';

/**
 * The signing key to use: `--key`, then `OPENCITADEL_SIGNING_KEY`, then the only `.key` file in
 * the signing directory. `OPENCITADEL_SIGNING_KEY` may hold a path or, for CI secrets, the key
 * file's JSON itself. Returns undefined when none is configured; throws when the choice is
 * ambiguous or a named file is unusable. Error messages never echo the key.
 */
export async function findSigningKey(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<{ file: string; secret: SecretKeyFile } | undefined> {
  if (!flag && env.OPENCITADEL_SIGNING_KEY?.trim().startsWith('{')) {
    try {
      return { file: INLINE_KEY_LABEL, secret: parseSecretKeyFile(env.OPENCITADEL_SIGNING_KEY.trim()) };
    } catch (err) {
      throw new Error(`OPENCITADEL_SIGNING_KEY holds JSON but not a usable signing key: ${(err as Error).message}`);
    }
  }
  const named = flag ?? env.OPENCITADEL_SIGNING_KEY;
  if (named) return { file: resolve(named), secret: parseSecretKeyFile(await readFile(resolve(named), 'utf8')) };
  const dir = signingDir(env);
  if (!existsSync(dir)) return undefined;
  const keys = (await readdir(dir)).filter((f) => f.endsWith('.key'));
  if (keys.length === 0) return undefined;
  if (keys.length > 1) throw new Error(`Several signing keys in ${dir} (${keys.join(', ')}); choose one with --key or OPENCITADEL_SIGNING_KEY`);
  const file = join(dir, keys[0]!);
  return { file, secret: parseSecretKeyFile(await readFile(file, 'utf8')) };
}

/** Reads a public key from a minisign `.pub` file, a bare `RWQ…` line, or an OpenCitadel secret key file. */
export async function readPublicKey(file: string): Promise<PublicKeyInfo> {
  const text = await readFile(file, 'utf8');
  try {
    return parsePublicKey(parseSecretKeyFile(text).publicKey);
  } catch {
    return parsePublicKey(text);
  }
}

export const signingPassphrase = (env: NodeJS.ProcessEnv = process.env) => env.OPENCITADEL_SIGNING_PASSPHRASE || undefined;
