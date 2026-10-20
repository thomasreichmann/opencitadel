/**
 * Trusted publishing from GitHub Actions: fetch the job's OIDC identity token for the registry's
 * audience and trade it for a short-lived `ocp_` publish token (docs/ARCHITECTURE.md, "Trusted
 * publishing"). Tokens are never printed.
 */

import type { OidcExchangeResponse, Provenance } from '@opencitadel/protocol';
import type { RegistryClient } from './registry.js';

type FetchLike = typeof globalThis.fetch;

export interface GithubActionsOidc {
  requestUrl: string;
  requestToken: string;
}

/** The OIDC request endpoint GitHub gives jobs with `permissions: id-token: write`, if present. */
export function githubActionsOidc(env: NodeJS.ProcessEnv = process.env): GithubActionsOidc | undefined {
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  return requestUrl && requestToken ? { requestUrl, requestToken } : undefined;
}

/** Requests the job's OIDC token for `audience`. */
export async function requestGithubOidcToken(actions: GithubActionsOidc, audience: string, fetchImpl: FetchLike = globalThis.fetch): Promise<string> {
  const url = `${actions.requestUrl}${actions.requestUrl.includes('?') ? '&' : '?'}audience=${encodeURIComponent(audience)}`;
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { authorization: `bearer ${actions.requestToken}`, accept: 'application/json' } });
  } catch (err) {
    throw new Error(`Could not reach GitHub's OIDC token endpoint: ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new Error(`GitHub refused the OIDC token request (HTTP ${res.status}). Does the job have \`permissions: id-token: write\`?`);
  }
  const body = (await res.json().catch(() => ({}))) as { value?: unknown };
  if (typeof body.value !== 'string' || !body.value) throw new Error("GitHub's OIDC token endpoint returned no token");
  return body.value;
}

export const NO_OIDC_ENV =
  'Trusted publishing needs a GitHub Actions OIDC token, but ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN are not set. ' +
  'Run this inside GitHub Actions and give the job `permissions: id-token: write`.';

/** The full exchange: audience from the registry, OIDC token from GitHub, publish token from the registry. */
export async function trustedPublishToken(registry: RegistryClient, env: NodeJS.ProcessEnv = process.env, fetchImpl: FetchLike = globalThis.fetch): Promise<OidcExchangeResponse> {
  const actions = githubActionsOidc(env);
  if (!actions) throw new Error(NO_OIDC_ENV);
  const info = await registry.info();
  const audience = info.oidc?.github?.audience;
  if (!audience) throw new Error(`${registry.baseUrl} does not support trusted publishing (its /v1/registry has no oidc.github audience)`);
  const oidcToken = await requestGithubOidcToken(actions, audience, fetchImpl);
  return registry.exchangeGithubToken(oidcToken);
}

/** One line describing where a version was built, e.g. `owner/repo@1a2b3c4 (release.yml, run 42)`. */
export function describeProvenance(p: Provenance): string {
  return `${p.repository}@${p.sha.slice(0, 7)} (${p.workflow}, run ${p.runId})`;
}
