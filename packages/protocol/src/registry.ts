/**
 * Registry trust and moderation types: publisher signing keys, security advisories, abuse
 * reports, and registry metadata. See docs/ARCHITECTURE.md ("Plugin registry").
 */

import { v, ValidationError, type Infer } from './validate.js';
import { isValidRange } from './semver.js';
import { versionV } from './manifest.js';

/** `GET /v1/registry`. */
export interface RegistryInfo {
  name?: string;
  publicUrl?: string;
  /** Where to send takedown (DMCA) and security reports. */
  abuseContact?: string;
  /** The registry rejects unsigned packages. */
  requireSignatures: boolean;
  version: string;
  /** Trusted publishing: the audience CI must request its OIDC token for. */
  oidc?: { github: { audience: string } };
}

/**
 * Trusted publishing: a plugin owner links a CI workflow to a plugin. That workflow can then
 * exchange its OIDC identity token for a short-lived publish token, with no API key stored in CI.
 */
export interface TrustedPublisher {
  id: string;
  pluginId: string;
  provider: 'github';
  /** `owner/repo`, matched case-insensitively. */
  repository: string;
  /** Workflow file name under `.github/workflows/`, e.g. `release.yml`. */
  workflow: string;
  /** If set, the job must run in this GitHub environment (protection rules apply). */
  environment?: string;
  /** If set, the ref must match this pattern (`*` matches within a path segment), e.g. `refs/tags/v*`. */
  ref?: string;
  /** GitHub's numeric repository id, pinned on first use so a re-created repo of the same name can't publish. */
  repositoryId?: string;
  addedAt: string;
}

export const trustedPublisherInputValidator = v.object({
  provider: v.withDefault(v.literal(['github'] as const), 'github'),
  repository: v.string({ max: 140, pattern: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/ }),
  workflow: v.string({ max: 100, pattern: /^[A-Za-z0-9_.-]+\.ya?ml$/ }),
  environment: v.optional(v.string({ min: 1, max: 100, pattern: /^\S+$/ })),
  ref: v.optional(v.string({ max: 200, pattern: /^refs\/[A-Za-z0-9_.\/*-]+$/ })),
});
export type TrustedPublisherInput = Infer<typeof trustedPublisherInputValidator>;

/** Where a version was built, as verified by the registry from the CI's OIDC token. */
export interface Provenance {
  provider: 'github';
  repository: string;
  repositoryId: string;
  /** Workflow file name. */
  workflow: string;
  ref: string;
  sha: string;
  runId: string;
  runAttempt: string;
  environment?: string;
  actor?: string;
  eventName?: string;
  /** Link to the workflow run. */
  url: string;
}

/** `POST /v1/oidc/github`. */
export interface OidcExchangeResponse {
  /** `ocp_…`, accepted by `PUT /v1/plugins/:id/:version` for the listed plugins until it expires. */
  token: string;
  expiresAt: string;
  plugins: string[];
}

/** Publish tokens minted by trusted publishing. */
export const PUBLISH_TOKEN_PREFIX = 'ocp_';

export interface SigningKeyInfo {
  keyId: string;
  /** minisign public key line (`RWQ…`). */
  publicKey: string;
  label?: string;
  addedAt: string;
  revokedAt?: string;
}

/** `GET /v1/publishers/:name`. */
export interface PublisherInfo {
  name: string;
  signingKeys: SigningKeyInfo[];
  plugins: string[];
}

export const signingKeyInputValidator = v.object({
  /** A minisign public key file or its base64 line. */
  publicKey: v.string({ min: 40, max: 400, trim: true }),
  label: v.optional(v.string({ max: 80 })),
});

export const ADVISORY_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type AdvisorySeverity = (typeof ADVISORY_SEVERITIES)[number];

const rangeV = (value: unknown, path: string): string => {
  const s = v.string({ min: 1, max: 128 })(value, path);
  if (!isValidRange(s)) throw new ValidationError(path, 'must be a version range like <1.2.3');
  return s;
};

export const advisoryInputValidator = v.object({
  severity: v.literal(ADVISORY_SEVERITIES),
  title: v.string({ min: 4, max: 140 }),
  description: v.withDefault(v.string({ max: 4000 }), ''),
  /** Affected versions, e.g. `<1.4.2` or `>=1.0.0 <1.4.2`. */
  affected: rangeV,
  fixedIn: v.optional(versionV),
  url: v.optional(v.string({ max: 300, pattern: /^https:\/\/\S+$/ })),
});
export type AdvisoryInput = Infer<typeof advisoryInputValidator>;

export interface Advisory extends AdvisoryInput {
  id: string;
  pluginId: string;
  publishedAt: string;
  withdrawn: boolean;
}

export const REPORT_REASONS = ['malware', 'copyright', 'broken', 'spam', 'other'] as const;

export const reportInputValidator = v.object({
  reason: v.literal(REPORT_REASONS),
  details: v.string({ min: 10, max: 2000 }),
  /** Optional reply address; never published. */
  contact: v.optional(v.string({ max: 200 })),
  version: v.optional(versionV),
});
export type ReportInput = Infer<typeof reportInputValidator>;

/** What installing each kind of package means, shown at install time and on the registry page. */
export const TRUST_LABELS = {
  host: 'Runs in a WebAssembly sandbox inside citadel-host: no file, process or network access beyond the permissions it declares.',
  deadworks: 'Full trust: runs inside the game server process with full access to the machine.',
  content: 'Content only (VPK files). Files marked for clients are offered to players when they join.',
} as const;
