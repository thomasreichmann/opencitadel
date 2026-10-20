# Running a registry

Every `citadel-master` is also a plugin registry. This guide is for the people who run one:
- what signatures do and don't protect;
- how trusted publishing lets CI publish without API keys, and what provenance proves;
- how to publish advisories;
- how to handle reports and takedowns;
- how Deadworks servers can use the registry as their FastDL host;
- which privacy settings apply.

The HTTP routes are listed in [ARCHITECTURE.md](ARCHITECTURE.md#registry-trust-and-moderation).

## Starting it

```sh
OPENCITADEL_ADMIN_TOKEN=$(openssl rand -hex 32) \
citadel-master serve --port 8080 --data /var/lib/opencitadel \
  --public-url https://registry.example.org \
  --abuse-contact abuse@example.org \
  --name "Example Community Registry"
```

| Setting | Effect |
|---|---|
| `--abuse-contact` / `OPENCITADEL_ABUSE_CONTACT` | Shown in the web UI footer and in `GET /v1/registry`. Set it: it is where takedown notices and security reports go. |
| `--name` / `OPENCITADEL_NAME` | Display name in `GET /v1/registry`. |
| `OPENCITADEL_REQUIRE_SIGNATURES=1` | Rejects unsigned packages with `422 signature_required`. |
| `OPENCITADEL_ADMIN_TOKEN` | Enables `/v1/admin/*` (yanks, reports, delisting, disabling accounts). Keep it long and secret. |
| `OPENCITADEL_REGISTRATION=closed` | Only you create accounts (`citadel-master account create <name>`). |
| `OPENCITADEL_DEADWORKS_PLAYER_NAMES=1` | Keeps player names from Deadworks heartbeats (dropped by default; see [Privacy](#privacy)). |
| `OPENCITADEL_TRUST_PROXY=1` | Behind a TLS-terminating reverse proxy, uses `X-Forwarded-For` for rate limits and report IPs. |
| `OPENCITADEL_OIDC_AUDIENCE` | The audience CI must request its OIDC token for. Defaults to `--public-url`, else `opencitadel`. See [Trusted publishing](#trusted-publishing). |
| `OPENCITADEL_GITHUB_OIDC_ISSUER` / `OPENCITADEL_GITHUB_OIDC_JWKS_URL` | Only for GitHub Enterprise Server; the defaults are github.com's. |

## Signatures

Publishers sign the exact `.tgz` they upload with an Ed25519 key. Signatures and public keys use
the [minisign](https://jedisct1.github.io/minisign/) format, so anyone can check a download
without OpenCitadel:

```sh
minisign -Vm map-rotation-1.2.0.tgz -P RWQ…   # reads map-rotation-1.2.0.tgz.minisig
```

A publisher registers a public key on their account
(`POST /v1/accounts/me/signing-keys`, or `citadel-host plugin key register`). From then on:
- `citadel-host plugin publish` signs automatically;
- the registry verifies each signature against the account's active keys before storing
  anything;
- the registry rejects signatures from unknown or revoked keys, signatures over different bytes,
  and OpenCitadel trusted comments that name a different package or version.

Each key id belongs to one account, and an account can hold up to 10 active keys. Revoking a key
(`DELETE /v1/accounts/me/signing-keys/<id>`) stops it signing new versions. Revoked keys stay
listed on the publisher page, `GET /v1/publishers/<name>`, so older signatures can still be
judged.

### What signatures protect, and what they don't

- **Protected: the files on disk.** A signed package checked by a host matches what the
  publisher built. Someone who tampers with stored packages (a stolen disk, a bad mirror, a
  compromised CDN in front of you) can't get a modified package past hosts that verify
  signatures.
- **Protected: stolen account keys.** An attacker holding only an account's API key (`ock_…`)
  can publish, but can't sign with the publisher's existing key.
  - Hosts pin each plugin to the key it was first installed with (trust on first use, in
    `.opencitadel/trust.json`).
  - They refuse an update signed by a different key until the admin passes `--accept-new-key`.
  - They refuse an unsigned update to a previously signed plugin unless `--allow-unsigned` is given.
- **Not protected: a fully compromised registry, for first installs.** An attacker who controls
  the registry can serve a new plugin signed with a key they registered. Pinning only helps from
  the second install on. Two things close the gap:
  - Server admins can pre-trust keys in `server.json` under `security.trustedKeys`.
  - Publishers should post their key id somewhere they control (repository README, website), so
    admins can compare.
- **Not protected: malicious publishers.** A signature says who built a package, not that it is
  safe. `deadworks` plugins run with full access to the machine. Host plugins run in citadel-host's
  sandbox by default, but a server admin can turn that off per plugin.

The registry marks a version `keyChanged` when it is signed by a different key than the nearest
lower signed version, or is unsigned after a signed one. Hosts and the web UI show a warning for
those versions.

### Turning on `OPENCITADEL_REQUIRE_SIGNATURES`

Requiring signatures stops anyone uploading unsigned code.

1. Ask publishers to register keys first.
2. Have publishers attach signatures to existing unsigned versions with
   `PUT /v1/plugins/<id>/<version>/signature` (body: the `.minisig` text). This works once per
   version, for the owner only.
3. Turn the setting on. Existing unsigned versions stay downloadable.

## Trusted publishing

Trusted publishing lets a plugin's GitHub Actions workflow publish without an API key stored in
CI. It works like PyPI's and npm's:

1. **The owner links a workflow.** They add a trusted publisher to the plugin: repository,
   workflow file, and optionally a GitHub environment and a ref pattern. For an id nobody has
   published yet, this reserves the id for their account.
2. **CI proves who it is.** The workflow asks GitHub for an OIDC token (`permissions: id-token: write`)
   with this registry's audience. It sends the token to `POST /v1/oidc/github`.
3. **The registry checks the token.** If a trusted publisher matches, it returns a publish token
   (`ocp_…`): valid 15 minutes, usable for several uploads, limited to the matching plugins.
4. **CI publishes with it.** The version records its provenance: repository, commit, workflow,
   ref, environment and a link to the run. The web UI shows it on every version.

Signatures work as before. Publishers who sign in CI keep their minisign key as an encrypted CI
secret, and the registry verifies the signature against the owning account's keys.

### What the registry verifies

- **The token itself.** It must be RS256, signed by a key from GitHub's published JWKS
  (`<issuer>/.well-known/jwks`). The registry caches those keys and fetches them again, at most
  once a minute, when it sees an unknown key id. The issuer and audience must match, and expiry
  is checked with 60 s of leeway. `alg: none`, HMAC and other algorithms are refused.
- **The match against the trusted publisher.**
  - The repository must match (case-insensitively).
  - The workflow file named in `job_workflow_ref` must be the configured file, in that same
    repository. Reusable workflows from other repositories aren't accepted.
  - The job's environment and ref must match, if those were configured.
- **The repository id.** On first use the registry pins GitHub's numeric repository id. A
  repository deleted and re-created under the same name, possibly by someone else, can't publish.
- **The account.** Publishers belonging to disabled accounts stop working.

Failed exchanges answer `401` with the reason, for example `workflow is deploy.yml, expected release.yml`,
so authors can fix their configuration.

### "Trusted publishing only"

An owner can set `PUT /v1/plugins/<id>/settings {"requireTrustedPublishing": true}`. After that,
account keys can no longer publish versions of that plugin (`403 trusted_publishing_required`);
only its trusted publishers can. This is the main defence against a stolen API key: the attack
behind Minecraft's 2023 malware incident was exactly that. The owner's API key can still change
the setting, manage publishers and yank versions.

### What provenance proves, and what it doesn't

- **It proves** that GitHub vouched, at publish time, for this exact workflow run of this
  repository and commit. The registry checked the run's identity before accepting the bytes.
- **It doesn't prove** that the uploaded package was built only from that commit's source. A
  workflow can download or generate anything. For that, publishers should keep builds
  reproducible and keep the release workflow small, behind a protected `release` environment.
- **It is attested by this registry, not signed by GitHub.** Hosts verify publisher signatures
  independently, but provenance is only as trustworthy as the registry that recorded it.
  Keeping both is deliberate: a signature binds the bytes to a key the publisher controls, and
  provenance ties a release to a public, auditable run.

### GitHub Enterprise Server

Set `OPENCITADEL_GITHUB_OIDC_ISSUER=https://<host>/_services/token`. The JWKS URL defaults to
`<issuer>/.well-known/jwks`; set `OPENCITADEL_GITHUB_OIDC_JWKS_URL` if your instance publishes
keys elsewhere. Provenance links then point at your instance.

The master fetches the JWKS outbound over HTTPS, so allow egress to the issuer.

## Advisories

When a plugin version has a security problem, its owner or an admin publishes an advisory:

```sh
curl -X POST https://registry.example.org/v1/plugins/map-rotation/advisories \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"severity":"high","title":"!map passes names to the console unescaped",
       "affected":"<1.1.0","fixedIn":"1.1.0","url":"https://github.com/example/map-rotation/security"}'
```

The fields:

| Field | Meaning |
|---|---|
| `severity` | `low`, `medium`, `high` or `critical` |
| `affected` | A semver range |
| `fixedIn` | Must fall outside `affected` |

Advisories reach hosts in three ways:
- `citadel-host plugin audit` and `citadel-pkg audit`;
- the background check `citadel-host start` runs;
- the plugin's page in the web UI.

A host that keeps a cursor can poll `GET /v1/advisories?since=<asOf from the last response>`. The
response includes advisories created *or withdrawn* since that time. Withdraw a mistaken advisory
with `POST /v1/advisories/<id>/withdraw`.

For an actively exploited problem, combine an advisory with a yank
(`POST /v1/admin/plugins/<id>/<version>/yank`). Yanked versions drop out of `latest` and range
resolution, but stay downloadable by exact version, so lockfiles keep working.

## Reports and takedowns

Anyone can report a plugin from its page, or with `POST /v1/plugins/<id>/reports`. The reasons
are `malware`, `copyright`, `broken`, `spam` and `other`. A report can include a contact address,
which is never published. Each IP can send 5 reports per hour.

Admins work through the queue:

```sh
curl -H "authorization: Bearer $OPENCITADEL_ADMIN_TOKEN" https://registry.example.org/v1/admin/reports
curl -X POST -H "authorization: Bearer $OPENCITADEL_ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"note":"Yanked 1.0.0; account disabled"}' https://registry.example.org/v1/admin/reports/<id>/resolve
```

Suggested process:

1. **Malware or backdoors.** Yank every affected version, publish a `critical` advisory so
   installed copies show up in audits, and disable the account
   (`POST /v1/admin/accounts/<name>/disable`).
2. **Copyright (DMCA) notices.** Check that the notice identifies the work and the infringing
   package, yank the versions named, and tell the publisher, who may send a counter-notice.
   Publish your designated agent and process alongside the abuse contact if you operate in the
   US. Yanking keeps exact versions downloadable. For content you must remove completely, also
   delete `<data>/packages/<sha256>.tgz` and `<data>/files/<sha256>/` for that version.
3. **Broken or misleading packages.** Contact the publisher first; yank only when the package
   harms servers.
4. Resolve the report with a note of what you did, so other admins can see it.

## FastDL for Deadworks servers

Content packages published here are also served in the layout the Deadworks launcher
downloads:

```
https://registry.example.org/fastdl/maps/<map>_<sha256[0:16]>.vpk.zst
https://registry.example.org/fastdl/addons/<id_with_underscores>_<file stem>_<sha256[0:16]>.vpk.zst
```

Files are streamed as zstd. They are stored zstd frames, so they are about the size of the VPK;
VPKs are mostly already-compressed assets. `X-Checksum-Sha256` carries the hash of the
decompressed VPK.

To use this from a Deadworks server:

1. Publish the server's maps and addons as a `content` package.
2. Set `serverbrowser.fastdl_url` in `game/bin/win64/configs/deadworks.jsonc`. Deadworks
   advertises it to players as `dw_fastdl` in its A2S rules, and the URL must be at most 128
   bytes:

   ```jsonc
   "serverbrowser": { "fastdl_url": "https://registry.example.org/fastdl" }
   ```

Players running the Deadworks launcher then fetch `<fastdl_url>/{maps|addons}/<name>_<hash>.vpk.zst`
from your registry. `citadel-browser` users get the same content through the server's listing.

Deadworks derives each name from the server's file, and the names must match the registry's:

| Kind | Deadworks reads it from | Matching rule |
|---|---|---|
| Map | `citadel/maps/<name>.vpk` | The same stem as in the package. Matches as is. |
| Addon | `citadel/deadworks_server_addons/vpks/<name>.vpk` | Name the file as the registry indexes it, e.g. `pak01_dir.vpk` in package `arena-map` becomes `arena_map_pak01_dir.vpk`. |

## Privacy

- **Hosts.** OpenCitadel hosts publish player names only when their operator sets
  `privacy.showPlayerNames`. Listings still show the player count, heroes and teams.
- **Deadworks servers.** Deadworks heartbeats always include player names. The master drops them
  before storing anything unless `OPENCITADEL_DEADWORKS_PLAYER_NAMES=1`.
- **IP addresses.** Report IPs and server IPs are visible only to admins.

## Backups

Everything lives in the data directory:

| Path | What it holds |
|---|---|
| `master.db` (+ `-wal`, `-shm`) | Accounts, servers, signing keys, trusted publishers, versions (with provenance), advisories, reports. Back it up with `sqlite3 master.db ".backup master.bak"`, or stop the master and copy the files. Publish tokens are short-lived and need no backup. |
| `packages/<sha256>.tgz` | Published packages (immutable, content-addressed) |
| `files/<sha256>/` | Unpacked package files, used for `/files/` and `/fastdl/`. You can rebuild them from `packages/`, but back them up anyway; restoring is faster. |

Losing `master.db` loses the signing-key registrations. Hosts keep their pinned keys and still
refuse packages signed by unexpected keys, but publishers have to register their keys again.
