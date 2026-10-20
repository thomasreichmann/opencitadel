#!/usr/bin/env node
/**
 * citadel-master — run the OpenCitadel master server, or administer its database.
 *
 *   citadel-master serve [--port 8080] [--host 0.0.0.0] [--data ./data] [--public-url URL] [--allow-private] [--abuse-contact ADDR]
 *   citadel-master account create <name> [--data ./data]
 *   citadel-master account disable <name> [--data ./data]
 *   citadel-master server delist <id> [--data ./data]
 */

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_MASTER_PORT } from '@opencitadel/protocol';
import { createMaster, defaultLog } from './app.js';
import { hashSecret, newAccountKey, newId } from './secrets.js';
import { Store } from './store.js';

const USAGE = `citadel-master — open server list, browser and plugin registry for Deadlock

Usage:
  citadel-master serve [--port ${DEFAULT_MASTER_PORT}] [--host ADDR] [--data ./data] [--public-url URL] [--allow-private]
                       [--abuse-contact ADDR] [--name NAME]
  citadel-master account create <name> [--data ./data]
  citadel-master account disable <name> [--data ./data]
  citadel-master server delist <id> [--data ./data]

Environment:
  OPENCITADEL_ADMIN_TOKEN              enables /v1/admin/* with this bearer token
  OPENCITADEL_REGISTRATION             open (default) | closed
  OPENCITADEL_TRUST_PROXY=1            use X-Forwarded-For for client IPs (behind a reverse proxy)
  OPENCITADEL_DEADWORKS_COMPAT         1 (default) | 0 — Deadworks /api/servers/* routes
  OPENCITADEL_REQUIRE_SIGNATURES=1     reject unsigned plugin packages
  OPENCITADEL_ABUSE_CONTACT            takedown/security contact (same as --abuse-contact)
  OPENCITADEL_NAME                     registry name shown in /v1/registry (same as --name)
  OPENCITADEL_DEADWORKS_PLAYER_NAMES=1 keep player names from Deadworks heartbeats (dropped by default)
  OPENCITADEL_OIDC_AUDIENCE            audience CI requests its OIDC token for (default: --public-url, else "opencitadel")
  OPENCITADEL_GITHUB_OIDC_ISSUER       GitHub Actions OIDC issuer (default https://token.actions.githubusercontent.com;
                                       for GitHub Enterprise Server: https://HOST/_services/token)
  OPENCITADEL_GITHUB_OIDC_JWKS_URL     where the issuer's signing keys are (default <issuer>/.well-known/jwks)
`;

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function openStore(dataDir: string): Store {
  mkdirSync(dataDir, { recursive: true });
  return new Store(join(dataDir, 'master.db'));
}

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      data: { type: 'string', default: './data' },
      'public-url': { type: 'string' },
      'allow-private': { type: 'boolean', default: false },
      'abuse-contact': { type: 'string' },
      name: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [cmd, sub, arg] = positionals;
  const dataDir = resolve(values.data!);

  if (values.help || !cmd) {
    console.log(USAGE);
    return;
  }

  if (cmd === 'serve') {
    const port = Number(values.port ?? process.env.PORT ?? DEFAULT_MASTER_PORT);
    if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`Invalid --port ${values.port}`);
    const registration = process.env.OPENCITADEL_REGISTRATION === 'closed' ? 'closed' : 'open';
    const master = await createMaster({
      dataDir,
      adminToken: process.env.OPENCITADEL_ADMIN_TOKEN || undefined,
      registration,
      trustProxy: process.env.OPENCITADEL_TRUST_PROXY === '1',
      deadworksCompat: process.env.OPENCITADEL_DEADWORKS_COMPAT !== '0',
      allowPrivate: values['allow-private'],
      publicUrl: values['public-url'],
      abuseContact: (values['abuse-contact'] ?? process.env.OPENCITADEL_ABUSE_CONTACT) || undefined,
      name: (values.name ?? process.env.OPENCITADEL_NAME) || undefined,
      requireSignatures: process.env.OPENCITADEL_REQUIRE_SIGNATURES === '1',
      deadworksPlayerNames: process.env.OPENCITADEL_DEADWORKS_PLAYER_NAMES === '1',
      oidcAudience: process.env.OPENCITADEL_OIDC_AUDIENCE || undefined,
      oidcIssuer: process.env.OPENCITADEL_GITHUB_OIDC_ISSUER || undefined,
      oidcJwksUrl: process.env.OPENCITADEL_GITHUB_OIDC_JWKS_URL || undefined,
    });
    const bound = await master.listen(port, values.host);
    defaultLog(
      'info',
      `listening on http://${values.host ?? '0.0.0.0'}:${bound} (data: ${dataDir}, registration: ${registration}, signatures: ${master.registry.requireSignatures ? 'required' : 'optional'})`,
    );
    let closing = false;
    const shutdown = async () => {
      if (closing) return;
      closing = true;
      defaultLog('info', 'shutting down');
      await master.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  if (cmd === 'account' && (sub === 'create' || sub === 'disable')) {
    if (!arg) fail(`Usage: citadel-master account ${sub} <name>`);
    const store = openStore(dataDir);
    try {
      if (sub === 'create') {
        if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{2,31}$/.test(arg)) fail('Account names are 3-32 characters: letters, digits, _ . -');
        if (store.accountNameTaken(arg)) fail(`The name "${arg}" is taken`);
        const key = newAccountKey();
        const account = store.createAccount(newId(), arg, hashSecret(key), Date.now());
        console.log(`Created account ${account.name} (${account.id}).`);
        console.log(`API key (shown once, store it safely): ${key}`);
      } else {
        const account = store.accountByIdOrName(arg);
        if (!account) fail(`No account "${arg}"`);
        store.setAccountDisabled(account.id, true);
        console.log(`Disabled account ${account.name}; its servers are delisted.`);
      }
    } finally {
      store.close();
    }
    return;
  }

  if (cmd === 'server' && sub === 'delist') {
    if (!arg) fail('Usage: citadel-master server delist <id>');
    const store = openStore(dataDir);
    try {
      const server = store.server(arg);
      if (!server) fail(`No server "${arg}"`);
      store.setServerBlocked(server.id, true);
      store.setListingOffline(server.id);
      console.log(`Delisted ${server.id} "${server.name}"; its token is blocked.`);
    } finally {
      store.close();
    }
    return;
  }

  fail(USAGE);
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
