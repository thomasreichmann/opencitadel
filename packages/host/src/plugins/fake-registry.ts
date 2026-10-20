/**
 * Test helper: an in-memory registry speaking the master's plugin, publisher, signing-key and
 * advisory routes (docs/ARCHITECTURE.md, "Plugin registry" and "Registry trust and moderation").
 * It verifies uploaded signatures against the publisher's keys the way the master does.
 */

import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { packTarGz, parsePublicKey, parseSignature, unpackTarGz, verifySignature, type Advisory, type Provenance, type SigningKeyInfo, type TrustedPublisher } from '@opencitadel/protocol';

export interface FakePackage {
  archive: Buffer;
  /** `.minisig` text served for this version. */
  signature?: string;
  yanked?: boolean;
  provenance?: Provenance;
}

export interface FakeRegistryState {
  owner: string;
  apiKey: string;
  packages: Record<string, Record<string, FakePackage>>;
  /** The publisher's signing keys, as /v1/publishers reports them. */
  keys: SigningKeyInfo[];
  advisories: Record<string, Advisory[]>;
  downloads: string[];
  /** Signature headers received on publish (decoded), per `id@version`. */
  publishedSignatures: Record<string, string | undefined>;
  /** Trusted publishing: the audience in /v1/registry (absent = not supported). */
  oidcAudience?: string;
  /** The only GitHub OIDC token the exchange accepts. */
  acceptedOidcToken: string;
  /** OIDC tokens received by the exchange. */
  oidcTokens: string[];
  trustedPublishers: Record<string, TrustedPublisher[]>;
  settings: Record<string, { requireTrustedPublishing: boolean }>;
  /** Provenance recorded for versions published with the publish token. */
  provenance: Provenance;
  /** Which credential each publish used, per `id@version`. */
  publishedWith: Record<string, 'account' | 'trusted'>;
}

/** The publish token the fake exchange hands out. */
export const FAKE_PUBLISH_TOKEN = 'ocp_fake_publish_token';

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** A package archive with the given manifest and files. */
export function makePackage(manifest: Record<string, unknown>, files: Record<string, Buffer | string> = {}): Buffer {
  const entries: Record<string, Buffer> = { 'plugin.json': Buffer.from(JSON.stringify(manifest)) };
  for (const [k, v] of Object.entries(files)) entries[k] = Buffer.isBuffer(v) ? v : Buffer.from(v);
  return packTarGz(entries);
}

export async function startFakeRegistry(init: Partial<FakeRegistryState> = {}): Promise<{ url: string; state: FakeRegistryState; close(): Promise<void>; server: Server }> {
  const state: FakeRegistryState = {
    owner: 'author',
    apiKey: 'ock_test',
    packages: {},
    keys: [],
    advisories: {},
    downloads: [],
    publishedSignatures: {},
    acceptedOidcToken: 'github-oidc-jwt',
    oidcTokens: [],
    trustedPublishers: {},
    settings: {},
    provenance: {
      provider: 'github',
      repository: 'author/alpha-plugin',
      repositoryId: '123456',
      workflow: 'release.yml',
      ref: 'refs/tags/v1.0.0',
      sha: '0123456789abcdef0123456789abcdef01234567',
      runId: '987',
      runAttempt: '1',
      environment: 'release',
      url: 'https://github.com/author/alpha-plugin/actions/runs/987/attempts/1',
    },
    publishedWith: {},
    ...init,
  };

  const versionInfo = (version: string, p: FakePackage) => {
    const sig = p.signature ? parseSignature(p.signature) : undefined;
    return {
      version,
      sha256: sha256(p.archive),
      size: p.archive.length,
      publishedAt: '2026-10-01T00:00:00Z',
      yanked: !!p.yanked,
      ...(sig ? { signature: { keyId: sig.keyId, trustedComment: sig.trustedComment } } : {}),
      ...(p.provenance ? { provenance: p.provenance } : {}),
    };
  };
  const manifestOf = (p: FakePackage) => JSON.parse(unpackTarGz(p.archive).get('plugin.json')!.toString('utf8'));

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url!, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const error = (status: number, message: string) => send(status, { error: { code: 'error', message } });
    const authed = req.headers.authorization === `Bearer ${state.apiKey}`;

    if (parts[0] !== 'v1') return error(404, 'not found');
    if (parts[1] === 'registry') {
      return send(200, { requireSignatures: false, version: 'fake', ...(state.oidcAudience ? { oidc: { github: { audience: state.oidcAudience } } } : {}) });
    }
    if (parts[1] === 'oidc' && parts[2] === 'github' && req.method === 'POST') {
      const { token } = JSON.parse(body.toString('utf8')) as { token: string };
      state.oidcTokens.push(token);
      if (token !== state.acceptedOidcToken) return error(401, 'no trusted publisher matches repository author/other-repo, workflow release.yml');
      const plugins = Object.keys(state.trustedPublishers).filter((id) => state.trustedPublishers[id]!.length);
      return send(200, { token: FAKE_PUBLISH_TOKEN, expiresAt: '2026-10-19T12:15:00Z', plugins });
    }
    if (parts[1] === 'publishers' && parts[2] === state.owner) {
      return send(200, { name: state.owner, signingKeys: state.keys, plugins: Object.keys(state.packages) });
    }
    if (parts[1] === 'advisories') return send(200, { advisories: Object.values(state.advisories).flat() });
    if (parts[1] === 'accounts' && parts[2] === 'me' && parts[3] === 'signing-keys' && req.method === 'POST') {
      if (!authed) return error(401, 'bad key');
      const { publicKey, label } = JSON.parse(body.toString('utf8')) as { publicKey: string; label?: string };
      const info = parsePublicKey(publicKey);
      const key: SigningKeyInfo = { keyId: info.keyId, publicKey: info.publicKey, addedAt: new Date().toISOString(), ...(label ? { label } : {}) };
      state.keys.push(key);
      return send(201, { key });
    }
    if (parts[1] !== 'plugins') return error(404, 'not found');
    if (parts.length === 2) {
      const plugins = Object.entries(state.packages).map(([id, versions]) => {
        const latest = Object.keys(versions).sort().pop()!;
        const m = manifestOf(versions[latest]!);
        return { id, name: m.name, kind: m.kind, description: m.description ?? '', latest, owner: state.owner, tags: [], downloads: 0, updatedAt: '' };
      });
      return send(200, { plugins, total: plugins.length });
    }
    const id = parts[2]!;
    const versions = state.packages[id];

    if (parts[3] === 'trusted-publishers') {
      if (!authed) return error(401, 'bad key');
      const list = (state.trustedPublishers[id] ??= []);
      if (req.method === 'POST') {
        const input = JSON.parse(body.toString('utf8')) as Omit<TrustedPublisher, 'id' | 'pluginId' | 'addedAt'>;
        const tp: TrustedPublisher = { ...input, id: `tp${list.length + 1}`, pluginId: id, addedAt: '2026-10-19T12:00:00Z' };
        list.push(tp);
        return send(201, { publisher: tp });
      }
      if (req.method === 'DELETE') {
        const at = list.findIndex((tp) => tp.id === parts[4]);
        if (at === -1) return error(404, `no trusted publisher ${parts[4]}`);
        list.splice(at, 1);
        res.writeHead(204);
        return res.end();
      }
      return send(200, { publishers: list });
    }
    if (parts[3] === 'settings' && req.method === 'PUT') {
      if (!authed) return error(401, 'bad key');
      state.settings[id] = JSON.parse(body.toString('utf8')) as { requireTrustedPublishing: boolean };
      return send(200, { settings: state.settings[id] });
    }

    if (req.method === 'PUT' && parts.length === 4) {
      const trusted = req.headers.authorization === `Bearer ${FAKE_PUBLISH_TOKEN}`;
      if (trusted && !state.trustedPublishers[id]?.length) return error(403, `the publish token does not cover ${id}`);
      if (!authed && !trusted) return error(401, 'bad key');
      if (!trusted && state.settings[id]?.requireTrustedPublishing) return error(403, `${id} only accepts versions from its trusted publishers`);
      const header = req.headers['x-opencitadel-signature'];
      const signature = typeof header === 'string' ? Buffer.from(header, 'base64').toString('utf8') : undefined;
      if (signature) {
        try {
          verifySignature(body, signature, state.keys.filter((k) => !k.revokedAt).map((k) => k.publicKey));
        } catch (err) {
          return error(400, `bad signature: ${(err as Error).message}`);
        }
      }
      state.publishedSignatures[`${id}@${parts[3]}`] = signature;
      state.publishedWith[`${id}@${parts[3]}`] = trusted ? 'trusted' : 'account';
      const stored: FakePackage = { archive: body, ...(signature ? { signature } : {}), ...(trusted ? { provenance: state.provenance } : {}) };
      state.packages[id] = { ...(versions ?? {}), [parts[3]!]: stored };
      return send(201, { ok: true, version: versionInfo(parts[3]!, stored) });
    }

    if (!versions) return error(404, `No package ${id}`);
    if (parts.length === 3) {
      const latest = Object.keys(versions).sort().pop()!;
      return send(200, {
        plugin: {
          id,
          name: id,
          kind: manifestOf(versions[latest]!).kind,
          description: '',
          latest,
          owner: state.owner,
          tags: [],
          downloads: 7,
          updatedAt: '',
          ...(state.settings[id]?.requireTrustedPublishing ? { requireTrustedPublishing: true } : {}),
        },
        manifest: manifestOf(versions[latest]!),
        versions: Object.entries(versions).map(([v, p]) => versionInfo(v, p)),
      });
    }
    if (parts[3] === 'advisories') return send(200, { advisories: state.advisories[id] ?? [] });
    const p = versions[parts[3]!];
    if (!p) return error(404, 'no such version');
    if (parts.length === 4) return send(200, { ...versionInfo(parts[3]!, p), manifest: manifestOf(p) });
    if (parts[4] === 'package') {
      state.downloads.push(`${id}@${parts[3]}`);
      res.writeHead(200, { 'content-type': 'application/gzip', 'x-checksum-sha256': sha256(p.archive) });
      return res.end(p.archive);
    }
    if (parts[4] === 'package.minisig') {
      if (!p.signature) return error(404, 'unsigned');
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(p.signature);
    }
    error(404, 'not found');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, state, server, close: () => new Promise((r) => server.close(() => r())) };
}
