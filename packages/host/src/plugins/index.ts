/**
 * The host plugin system. The host core uses these entry points:
 *  - `createPluginHost(services, config)` → the runtime it drives with events;
 *  - `installedListing(serverDir, config)` → heartbeat `plugins` and `content`;
 *  - `runPluginCli(argv, ctx)` → `citadel-host plugin …`;
 *  - `checkAdvisories(serverDir, config, logger)` → advisory warnings at start-up.
 */

import type { CreatePluginHost } from '../services.js';
import { PluginRuntime } from './runtime.js';

export const createPluginHost: CreatePluginHost = (services, config) => new PluginRuntime(services, config);

export { installedListing } from './listing.js';
export { runPluginCli, runPackageCli, PLUGIN_USAGE, PKG_USAGE, type PackageCliContext } from './cli.js';
export { PluginRuntime, findPlayer, type PluginStatus, type RuntimeOptions } from './runtime.js';
export { RegistryClient, RegistryError, type PublishResponse } from './registry.js';
export {
  installFromRegistry,
  installFromFile,
  fetchFromRegistry,
  commitPackage,
  removePackage,
  hasServerAddons,
  describePermissions,
  trustLabel,
  type InstallOptions,
  type InstallOutcome,
} from './install.js';
export { readInstalled, packageStore, flatStore, type InstalledIndex, type InstalledPackage, type PackageStore, type StoreLocation } from './installed.js';
export { decideTrust, readTrust, writeTrust, TrustError, type PinnedKey, type TrustStore, type TrustDecision } from './trust.js';
export { auditInstalled, checkAdvisories, formatMatch, type AdvisoryMatch, type AuditResult } from './audit.js';
export { buildLockfile, writeLockfile, readLockfile, syncLockfile, type Lockfile, type LockEntry } from './lock.js';
export { createSigningKey, findSigningKey, readPublicKey, signingDir } from './keys.js';
export { packPlugin, packPluginToFile, publishPlugin, signPackage, signPackageFile } from './pack.js';
export { scaffoldPlugin, releaseWorkflow, PUBLISH_COMMAND } from './scaffold.js';
export { githubActionsOidc, requestGithubOidcToken, trustedPublishToken, describeProvenance } from './oidc.js';
export { ensurePluginEnvironment } from './environment.js';
export { HOST_VERSION } from './version.js';
