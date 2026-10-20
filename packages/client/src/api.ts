/** Typed client for the master server's public `GET /v1/*` routes. */

import type { ServerDetail, ServerListQuery, ServerListResponse } from '@opencitadel/protocol';

export class MasterError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message);
    this.name = 'MasterError';
  }
}

export type FetchLike = typeof fetch;

export class MasterClient {
  readonly baseUrl: string;

  constructor(baseUrl: string, private readonly fetchImpl: FetchLike = fetch, private readonly timeoutMs = 8000) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /** Performs a GET relative to the master and returns the raw response (used by the UI proxy). */
  async rawGet(pathAndQuery: string): Promise<Response> {
    const url = this.baseUrl + pathAndQuery;
    try {
      return await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs), headers: { accept: 'application/json' } });
    } catch (err) {
      const cause = (err as Error).name === 'TimeoutError' ? 'timed out' : ((err as { cause?: Error }).cause?.message ?? (err as Error).message);
      throw new MasterError(`Cannot reach the master server at ${this.baseUrl} (${cause}). Set it with --master or OPENCITADEL_MASTER.`);
    }
  }

  private async getJson<T>(pathAndQuery: string): Promise<T> {
    const res = await this.rawGet(pathAndQuery);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new MasterError(`The master server at ${this.baseUrl} returned a non-JSON response (HTTP ${res.status})`, res.status);
    }
    if (!res.ok) {
      const error = (body as { error?: { code?: string; message?: string } })?.error;
      throw new MasterError(error?.message ?? `HTTP ${res.status}`, res.status, error?.code);
    }
    return body as T;
  }

  listServers(query: ServerListQuery = {}): Promise<ServerListResponse> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      params.set(key, value === true ? '1' : value === false ? '0' : String(value));
    }
    const qs = params.toString();
    return this.getJson<ServerListResponse>(`/v1/servers${qs ? `?${qs}` : ''}`);
  }

  async getServer(id: string): Promise<ServerDetail> {
    try {
      return await this.getJson<ServerDetail>(`/v1/servers/${encodeURIComponent(id)}`);
    } catch (err) {
      if (err instanceof MasterError && err.status === 404) throw new MasterError(`No server with id "${id}" (it may have been offline for more than a day)`, 404, 'not_found');
      throw err;
    }
  }

  stats(): Promise<{ servers: number; players: number; plugins: number }> {
    return this.getJson('/v1/stats');
  }
}
