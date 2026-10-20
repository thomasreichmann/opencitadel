/**
 * Client for the master's plugin registry (`/v1/plugins/*`, see docs/ARCHITECTURE.md).
 */

import type {
  Advisory,
  OidcExchangeResponse,
  PluginManifest,
  PluginSummary,
  PluginVersionInfo,
  PublisherInfo,
  RegistryInfo,
  SigningKeyInfo,
  TrustedPublisher,
  TrustedPublisherInput,
} from '@opencitadel/protocol';

export class RegistryError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'RegistryError';
  }
}

export interface PluginInfo {
  plugin: PluginSummary;
  manifest: PluginManifest;
  versions: PluginVersionInfo[];
}

export type VersionDetail = PluginVersionInfo & { manifest: PluginManifest };

/** What `PUT /v1/plugins/:id/:version` answers. */
export interface PublishResponse {
  plugin?: PluginSummary;
  version?: PluginVersionInfo;
}

type FetchLike = typeof globalThis.fetch;

const seg = (s: string) => encodeURIComponent(s);

export class RegistryClient {
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly fetchImpl: FetchLike = globalThis.fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl + path, init);
    } catch (err) {
      throw new RegistryError(`Could not reach the registry at ${this.baseUrl}: ${(err as Error).message}`, 0);
    }
    if (!res.ok) {
      let message = `${init?.method ?? 'GET'} ${path} failed with HTTP ${res.status}`;
      let code: string | undefined;
      try {
        const body = (await res.json()) as { error?: { code?: string; message?: string } };
        if (body.error?.message) message = body.error.message;
        code = body.error?.code;
      } catch {
        // not JSON
      }
      throw new RegistryError(message, res.status, code);
    }
    return res;
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    return (await (await this.request(path, init)).json()) as T;
  }

  search(q = '', opts: { kind?: string; tag?: string; limit?: number } = {}): Promise<{ plugins: PluginSummary[]; total: number }> {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (opts.kind) params.set('kind', opts.kind);
    if (opts.tag) params.set('tag', opts.tag);
    if (opts.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return this.json(`/v1/plugins${qs ? `?${qs}` : ''}`);
  }

  plugin(id: string): Promise<PluginInfo> {
    return this.json(`/v1/plugins/${seg(id)}`);
  }

  version(id: string, version: string): Promise<VersionDetail> {
    return this.json(`/v1/plugins/${seg(id)}/${seg(version)}`);
  }

  /** Downloads a package. `checksum` is the server's X-Checksum-Sha256 header, if sent. */
  async download(id: string, version: string): Promise<{ data: Buffer; checksum?: string }> {
    const res = await this.request(`/v1/plugins/${seg(id)}/${seg(version)}/package`);
    const data = Buffer.from(await res.arrayBuffer());
    const checksum = res.headers.get('x-checksum-sha256')?.trim().toLowerCase() || undefined;
    return { data, checksum };
  }

  /**
   * Uploads a package. `token` is an account key (`ock_`) or a trusted-publishing token (`ocp_`);
   * `signature` is the `.minisig` text, sent base64-encoded in X-OpenCitadel-Signature.
   */
  publish(id: string, version: string, archive: Buffer, token: string, signature?: string): Promise<PublishResponse> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'content-type': 'application/gzip' };
    if (signature) headers['x-opencitadel-signature'] = Buffer.from(signature, 'utf8').toString('base64');
    return this.json(`/v1/plugins/${seg(id)}/${seg(version)}`, { method: 'PUT', headers, body: new Uint8Array(archive) });
  }

  /** Registry metadata, including the OIDC audience for trusted publishing. */
  info(): Promise<RegistryInfo> {
    return this.json('/v1/registry');
  }

  /** Trades a GitHub Actions OIDC token for a short-lived publish token. */
  exchangeGithubToken(oidcToken: string): Promise<OidcExchangeResponse> {
    return this.json('/v1/oidc/github', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: oidcToken }),
    });
  }

  async addTrustedPublisher(id: string, input: TrustedPublisherInput, apiKey: string): Promise<TrustedPublisher> {
    const body = await this.json<{ publisher: TrustedPublisher }>(`/v1/plugins/${seg(id)}/trusted-publishers`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    return body.publisher;
  }

  async trustedPublishers(id: string, apiKey: string): Promise<TrustedPublisher[]> {
    return (await this.json<{ publishers: TrustedPublisher[] }>(`/v1/plugins/${seg(id)}/trusted-publishers`, { headers: { authorization: `Bearer ${apiKey}` } })).publishers;
  }

  async removeTrustedPublisher(id: string, publisherId: string, apiKey: string): Promise<void> {
    await this.request(`/v1/plugins/${seg(id)}/trusted-publishers/${seg(publisherId)}`, { method: 'DELETE', headers: { authorization: `Bearer ${apiKey}` } });
  }

  /** Owner settings; `requireTrustedPublishing` stops account keys from publishing new versions. */
  setPluginSettings(id: string, settings: { requireTrustedPublishing: boolean }, apiKey: string): Promise<{ settings: { requireTrustedPublishing: boolean } }> {
    return this.json(`/v1/plugins/${seg(id)}/settings`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(settings),
    });
  }

  /** The version's `.minisig`, or undefined when it was published unsigned. */
  async signature(id: string, version: string): Promise<string | undefined> {
    try {
      return await (await this.request(`/v1/plugins/${seg(id)}/${seg(version)}/package.minisig`)).text();
    } catch (err) {
      if (err instanceof RegistryError && err.status === 404) return undefined;
      throw err;
    }
  }

  publisher(name: string): Promise<PublisherInfo> {
    return this.json(`/v1/publishers/${seg(name)}`);
  }

  async advisories(id: string): Promise<Advisory[]> {
    return (await this.json<{ advisories: Advisory[] }>(`/v1/plugins/${seg(id)}/advisories`)).advisories;
  }

  async allAdvisories(since?: string): Promise<Advisory[]> {
    return (await this.json<{ advisories: Advisory[] }>(`/v1/advisories${since ? `?since=${encodeURIComponent(since)}` : ''}`)).advisories;
  }

  async registerSigningKey(publicKey: string, apiKey: string, label?: string): Promise<SigningKeyInfo> {
    const body = await this.json<{ key: SigningKeyInfo }>('/v1/accounts/me/signing-keys', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(label ? { publicKey, label } : { publicKey }),
    });
    return body.key;
  }

  /** Public URL of one file inside a published package (used for client content downloads). */
  fileUrl(id: string, version: string, path: string): string {
    return `${this.baseUrl}/v1/plugins/${seg(id)}/${seg(version)}/files/${path.split('/').map(seg).join('/')}`;
  }
}
