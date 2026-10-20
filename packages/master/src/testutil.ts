/** Shared helpers for the master's tests: a master on an ephemeral port with a fake clock. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMaster, type Master, type MasterOptions } from './app.js';

export interface ApiResult {
  status: number;
  json: any;
  text: string;
  headers: Headers;
}

export interface TestMaster {
  master: Master;
  base: string;
  now(): number;
  advance(ms: number): void;
  api(method: string, path: string, init?: { body?: unknown; raw?: Buffer | string; token?: string; headers?: Record<string, string> }): Promise<ApiResult>;
  /** Creates an account and returns its API key. */
  account(name: string): Promise<string>;
  /** Registers a server under `key` and returns {id, token}. */
  server(key: string, name?: string): Promise<{ id: string; token: string }>;
  close(): Promise<void>;
}

export const T0 = Date.UTC(2026, 9, 19, 12, 0, 0);

export function heartbeat(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Test Server',
    map: 'dl_midtown',
    players: 3,
    maxPlayers: 12,
    connect: { steamId: '[A:1:123:456]' },
    software: { name: 'citadel-host', version: '0.1.0' },
    ...over,
  };
}

export async function startMaster(opts: Partial<MasterOptions> = {}): Promise<TestMaster> {
  const dataDir = mkdtempSync(join(tmpdir(), 'oc-master-'));
  let clock = T0;
  // Tests never send real A2S packets; suites that exercise verification pass their own query.
  const offline = async () => {
    throw new Error('no network in tests');
  };
  const master = await createMaster({ dataDir, now: () => clock, log: () => {}, a2sQuery: offline, ...opts });
  const port = await master.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;

  const api: TestMaster['api'] = async (method, path, init = {}) => {
    const headers: Record<string, string> = { ...init.headers };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    const res = await fetch(base + path, { method, headers, body: init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined) });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text, headers: res.headers };
  };

  return {
    master,
    base,
    now: () => clock,
    advance: (ms) => {
      clock += ms;
    },
    api,
    async account(name) {
      const r = await api('POST', '/v1/accounts', { body: { name } });
      if (r.status !== 201) throw new Error(`account ${name}: ${r.status} ${r.text}`);
      return r.json.apiKey as string;
    },
    async server(key, name = 'Test Server') {
      const r = await api('POST', '/v1/servers', { body: { name }, token: key });
      if (r.status !== 201) throw new Error(`server: ${r.status} ${r.text}`);
      return { id: r.json.server.id as string, token: r.json.token as string };
    },
    async close() {
      await master.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
