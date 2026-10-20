/**
 * `plugin pack` and `plugin publish`: build a reproducible `.tgz` from a plugin directory and
 * upload it to the registry.
 */

import { existsSync } from 'node:fs';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';
import { packTarGz, packageTrustedComment, parseManifest, safeRelativePath, signData, unpackTarGz, type PluginManifest, type PluginVersionInfo, type SecretKeyFile } from '@opencitadel/protocol';
import { sha256 } from './install.js';
import type { RegistryClient } from './registry.js';

const EXTRA_FILES = ['README.md', 'README', 'LICENSE', 'LICENSE.md', 'LICENSE.txt', 'CHANGELOG.md'];
const EXCLUDE = [/\.test\.[cm]?js$/, /\.map$/, /\.tsbuildinfo$/, /\.d\.ts$/, /(^|\/)node_modules(\/|$)/, /(^|\/)\./];

async function readRegular(file: string, label: string): Promise<Buffer> {
  const st = await lstat(file).catch(() => undefined);
  if (!st) throw new Error(`${label} does not exist`);
  if (st.isSymbolicLink()) throw new Error(`${label} is a symlink; packages may only contain regular files`);
  if (!st.isFile()) throw new Error(`${label} is not a file`);
  return readFile(file);
}

async function walk(root: string, rel: string, out: Map<string, Buffer>): Promise<void> {
  for (const entry of await readdir(join(root, rel), { withFileTypes: true })) {
    const path = rel ? posix.join(rel, entry.name) : entry.name;
    if (EXCLUDE.some((re) => re.test(path))) continue;
    if (entry.isSymbolicLink()) throw new Error(`${path} is a symlink; packages may only contain regular files`);
    if (entry.isDirectory()) await walk(root, path, out);
    else if (entry.isFile()) out.set(path, await readFile(join(root, path)));
  }
}

/** Reads plugin.json and gathers the files that belong in the package. */
export async function collectPackage(dir: string): Promise<{ manifest: PluginManifest; files: Map<string, Buffer> }> {
  const root = resolve(dir);
  const manifestRaw = await readRegular(join(root, 'plugin.json'), 'plugin.json');
  let manifest: PluginManifest;
  try {
    manifest = parseManifest(JSON.parse(manifestRaw.toString('utf8')));
  } catch (err) {
    throw new Error(`plugin.json: ${(err as Error).message}`);
  }
  const files = new Map<string, Buffer>([['plugin.json', manifestRaw]]);
  for (const name of EXTRA_FILES) if (existsSync(join(root, name))) files.set(name, await readRegular(join(root, name), name));

  if (manifest.kind === 'host') {
    const main = safeRelativePath(manifest.main!);
    await readRegular(join(root, main), `Entry point ${main} (did you build the plugin?)`);
    const mainDir = posix.dirname(main);
    if (mainDir === '.') files.set(main, await readFile(join(root, main)));
    else await walk(root, mainDir, files);
  } else if (manifest.kind === 'deadworks') {
    for (const asm of manifest.assemblies ?? []) {
      const path = safeRelativePath(asm);
      files.set(path, await readRegular(join(root, path), path));
    }
  } else {
    for (const item of manifest.content ?? []) {
      const path = safeRelativePath(item.file);
      const data = await readRegular(join(root, path), path);
      if (data.length < 4 || data.readUInt32LE(0) !== 0x55aa1234) throw new Error(`${path} is not a VPK (bad magic number)`);
      files.set(path, data);
    }
  }
  return { manifest, files };
}

export interface PackResult {
  manifest: PluginManifest;
  archive: Buffer;
  sha256: string;
  entries: string[];
}

export async function packPlugin(dir: string): Promise<PackResult> {
  const { manifest, files } = await collectPackage(dir);
  const archive = packTarGz(files);
  return { manifest, archive, sha256: sha256(archive), entries: [...files.keys()].sort() };
}

/** Packs to `<out>` (default `<id>-<version>.tgz` in the current directory) and returns the path. */
export async function packPluginToFile(dir: string, out?: string): Promise<PackResult & { file: string }> {
  const result = await packPlugin(dir);
  const file = resolve(out ?? `${result.manifest.id}-${result.manifest.version}.tgz`);
  await writeFile(file, result.archive);
  return { ...result, file };
}

/** Reads a packed `.tgz` and its manifest. */
export async function readPackageFile(file: string): Promise<{ archive: Buffer; manifest: PluginManifest }> {
  const archive = await readFile(file);
  const plugin = unpackTarGz(archive).get('plugin.json');
  if (!plugin) throw new Error(`${file} has no plugin.json`);
  return { archive, manifest: parseManifest(JSON.parse(plugin.toString('utf8'))) };
}

/** A `.minisig` for a package, with OpenCitadel's trusted comment binding id, version and sha256. */
export function signPackage(archive: Buffer, manifest: PluginManifest, secret: SecretKeyFile, passphrase?: string): string {
  return signData(archive, secret, {
    trustedComment: packageTrustedComment(manifest.id, manifest.version, sha256(archive)),
    untrustedComment: `signature of ${manifest.id}@${manifest.version} from opencitadel key ${secret.keyId}`,
    passphrase,
  });
}

/** Writes `<file>.minisig` next to a packed `.tgz`. */
export async function signPackageFile(file: string, secret: SecretKeyFile, passphrase?: string): Promise<{ signatureFile: string; manifest: PluginManifest; keyId: string }> {
  const { archive, manifest } = await readPackageFile(file);
  const signatureFile = `${file}.minisig`;
  await writeFile(signatureFile, signPackage(archive, manifest, secret, passphrase));
  return { signatureFile, manifest, keyId: secret.keyId };
}

export interface PublishOptions {
  /** Sign with this key; omit to publish unsigned. */
  secret?: SecretKeyFile;
  passphrase?: string;
}

/**
 * Publishes a plugin directory or an already-packed `.tgz`, signed when a key is given. `auth` is
 * an account key, or a function that produces a token once the manifest is known (trusted
 * publishing checks the token covers the plugin before uploading).
 */
export async function publishPlugin(
  input: string,
  registry: RegistryClient,
  auth: string | ((manifest: PluginManifest) => Promise<string>),
  opts: PublishOptions = {},
): Promise<{ manifest: PluginManifest; sha256: string; size: number; keyId?: string; version?: PluginVersionInfo }> {
  const { archive, manifest } = /\.(tgz|tar\.gz)$/i.test(input) ? await readPackageFile(input) : await packPlugin(input);
  const signature = opts.secret ? signPackage(archive, manifest, opts.secret, opts.passphrase) : undefined;
  const token = typeof auth === 'string' ? auth : await auth(manifest);
  const res = await registry.publish(manifest.id, manifest.version, archive, token, signature);
  return {
    manifest,
    sha256: sha256(archive),
    size: archive.length,
    ...(opts.secret ? { keyId: opts.secret.keyId } : {}),
    ...(res?.version ? { version: res.version } : {}),
  };
}
