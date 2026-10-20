# OpenCitadel architecture

OpenCitadel is a community server stack for Deadlock: run your own servers, list them in an
open, self-hostable server browser, let players find and join them, and extend servers with
plugins distributed through a registry.

```
                          ┌────────────────────────────────────────────┐
                          │ citadel-master  (packages/master)          │
  server owners ──REST──▶ │  accounts · server registry · heartbeats   │ ◀──REST── players / web
                          │  plugin registry · web server browser      │           browsers
                          │  Deadworks-compatible /api/servers/*       │
                          └───────▲──────────────────────▲─────────────┘
                     heartbeat    │                      │ list / detail / packages
                ┌─────────────────┴───────────┐   ┌──────┴──────────────────────────┐
                │ citadel-host (packages/host)│   │ citadel-browser (packages/client)│
                │  supervises deadlock.exe /  │   │  CLI + local web UI              │
                │  deadworks.exe              │   │  content sync (VPK, sha256)      │
                │  RCON · console.log · bridge│   │  join: steam://run … +connect    │
                │  host plugin runtime        │   └──────────────────────────────────┘
                └──────┬───────────────▲──────┘
          spawns, RCON │               │ JSON lines over 127.0.0.1 TCP
                ┌──────▼───────────────┴──────┐
                │ Deadlock dedicated server   │
                │  (+ optional Deadworks with │
                │   the OpenCitadel.Bridge    │
                │   plugin, bridge/deadworks) │
                └─────────────────────────────┘
```

## How Deadlock servers work today (the facts this design rests on)

* Valve ships no separate dedicated-server app, but the client's `deadlock.exe` runs as one:
  `deadlock.exe -dedicated -insecure -condebug -allow_no_lobby_connect +tv_citadel_auto_record 0 +map dl_midtown`.
* To accept Steam P2P (Steam Datagram Relay) connections, `game/citadel/gameinfo.gi` needs
  `CreateListenSocketP2P 2` under `NetworkSystem` and `"net_p2p_listen_dedicated" "1"` under `ConVars`.
  Valve's updates overwrite the file, so the host re-checks and re-applies these on every start.
* The server logs on to Steam anonymously and gets a new `[A:1:<account>:<instance>]` id each launch.
  Players join with `connect [A:1:…]` over SDR — no port forwarding — or with `connect ip:port`
  when UDP 27015 is reachable. The listing therefore carries both, and the host re-publishes the
  SteamID after every restart.
* `engine2.dll` contains `rcon_password`, `-usercon`, `sv_password`, `hostname`, `sv_tags`,
  `sv_visiblemaxplayers`, `sv_setsteamaccount` and `hostport` — the standard Source 2 server
  surface, including Source RCON over TCP.
* [Deadworks](https://github.com/Deadworks-net/deadworks) (MIT) is a .NET in-process plugin
  framework for Deadlock servers, launched as `game/bin/win64/deadworks.exe`. It is the right
  place for gameplay-level plugins; OpenCitadel builds around it rather than duplicating it.

Checked against a live stock server (build 6796, October 2026) and handled by the host:

* console.log lines start with `MM/DD HH:MM:SS [Channel] `; the same lines on stdout don't.
* The server prints `CTextConsoleWin::GetLine: !GetNumberOfConsoleInputEvents` every frame
  when its stdin isn't a console, with or without `-console`: about 400 MB a day in console.log.
  The host reads stdout by default and drops the line.
* RCON's TCP listener binds to one local address of the engine's choosing (a VirtualBox adapter,
  on the test machine); `+ip 127.0.0.1` pins it to loopback without affecting UDP or SDR.
* RCON output arrives on a later tick, stamped with the id of the most recent packet the server
  received, so the classic empty-packet terminator can't mark the end of a reply.
* The server doesn't answer A2S queries.
* `say` shows quotes verbatim, and an unquoted `//` starts a comment.
* `status` shows an SDR player's SteamID where the address would be: `[U:1:22202]:0`.
* `ChangeGameState: <Name> (<n>)` lines trace the match. After `PostGame (8)` and `End (11)`
  the server stays on the finished match; a client reconnecting to it loops through loading
  every 10 s, and each rejoin resets the server's own 120 s shutdown timer.
* `changelevel` kills the process (exit code 5) during the level load.

## Packages

| Path | Name | What it is |
|---|---|---|
| `packages/protocol` | `@opencitadel/protocol` | Wire types and validators, SteamID and semver helpers, the `.tar.gz` package format, `plugin.json` schema |
| `packages/gamefiles` | `@opencitadel/gamefiles` | Install discovery, formatting-preserving `gameinfo.gi` editing, launch helpers |
| `packages/master` | `@opencitadel/master` | Master server: REST API, SQLite storage, web server browser, plugin registry |
| `packages/host` | `@opencitadel/host` | `citadel-host`: server supervisor, RCON, log parsing, heartbeats, plugin runtime, bridge |
| `packages/plugin-sdk` | `@opencitadel/plugin-sdk` | Types and `definePlugin()` for host plugins |
| `packages/client` | `@opencitadel/client` | `citadel-browser`: list/search/join from the terminal or a local web UI, content sync |
| `plugins/*` | | Example host plugins |
| `bridge/deadworks` | `OpenCitadel.Bridge` | Deadworks plugin that streams in-game events to the host and executes its requests |

Everything is TypeScript on Node ≥ 22.13 with no runtime dependencies beyond Node itself
(`node:sqlite`, `node:http`, `node:zlib`, `fetch`). Build with `pnpm build`, test with `pnpm test`.

## Conventions

* ESM everywhere, `.js` suffixes in relative imports, strict TypeScript (see `tsconfig.base.json`).
* No runtime npm dependencies, with one deliberate exception: the host's plugin sandbox uses
  `quickjs-emscripten` (MIT, pinned exactly), because Node has no sound in-process JavaScript
  sandbox. CLIs parse arguments with `node:util` `parseArgs`.
* Tests use `node:test` + `node:assert/strict`, live next to the code as `*.test.ts`, and must not
  touch the network beyond loopback or write outside a temp dir.
* Every network-facing input is validated with `@opencitadel/protocol`'s `v` validators.
* Secrets: account keys start `ock_`, server tokens `ocs_`; stored server-side only as SHA-256
  hashes; never logged. Config files holding secrets are written with mode `0600`.
* Logs: one line per event, `ISO-time LEVEL [component] message`.

## Master server (`citadel-master`)

`citadel-master serve [--port 8080] [--data ./data] [--public-url https://…]` stores everything
in `<data>/master.db` (SQLite via `node:sqlite`) and plugin packages in `<data>/packages/`.
Environment: `OPENCITADEL_ADMIN_TOKEN` (enables `/v1/admin/*`), `OPENCITADEL_REGISTRATION`
(`open` (default) | `closed`), `OPENCITADEL_TRUST_PROXY=1` (honour `X-Forwarded-For`),
`OPENCITADEL_DEADWORKS_COMPAT` (`1` default). Admin CLI: `citadel-master account create <name>`,
`citadel-master account disable <name>`, `citadel-master server delist <id>`.

All responses are JSON (`{ "error": { "code", "message" } }` on failure) unless noted.
Auth is `Authorization: Bearer <secret>`. Every route is rate-limited per client IP
(token bucket; writes stricter than reads). Request bodies are capped (64 KiB JSON, 256 MiB packages).
`GET` routes send `Access-Control-Allow-Origin: *`.

### Accounts and servers

| Method & path | Auth | Body → Response |
|---|---|---|
| `POST /v1/accounts` | none (open registration) | `{name}` → `201 {account:{id,name,createdAt}, apiKey}` |
| `GET /v1/accounts/me` | account key | → `{account, servers: OwnedServer[]}` |
| `POST /v1/accounts/me/rotate-key` | account key | → `{apiKey}` (old key stops working) |
| `POST /v1/servers` | account key | `{name}` → `201 {server: OwnedServer, token}` |
| `DELETE /v1/servers/:id` | account key (owner) | → `204` |
| `POST /v1/servers/:id/rotate-token` | account key (owner) | → `{token}` |
| `POST /v1/servers/:id/heartbeat` | server token | `Heartbeat` → `HeartbeatResponse` |
| `POST /v1/servers/:id/offline` | server token | → `204` (delists immediately) |

`OwnedServer = {id, name, createdAt, online, lastHeartbeat?}`. Server ids are 16-char base32.
`Heartbeat`, `HeartbeatResponse` and validation live in `protocol/src/listing.ts`.

Verification: when a heartbeat carries `connect.address`, the master queries A2S_INFO at that
address (at most once per 5 minutes per server, 1.5 s timeout, in the background so the heartbeat
response is not delayed). `verified` becomes true when it answers; while verified, the A2S
player count and map override the self-reported ones. An address that resolves to a private,
loopback or link-local IP is never verified (and never probed) unless the master runs with
`--allow-private`.

### Browsing

| Method & path | Response |
|---|---|
| `GET /v1/servers?q&region&map&mode&tags&notFull&notEmpty&noPassword&modded&verified&sort&limit&offset` | `ServerListResponse` (online servers only; `limit` ≤ 200, default 100; booleans are `1`/`true`) |
| `GET /v1/servers/:id` | `ServerDetail` (also for recently offline servers, with `online:false`; 404 after 24 h) |
| `GET /v1/stats` | `{servers, players, plugins}` |
| `GET /healthz` | `{ok:true}` |

### Plugin registry

| Method & path | Auth | Notes |
|---|---|---|
| `GET /v1/plugins?q&kind&tag&limit&offset` | none | `{plugins: PluginSummary[], total}` |
| `GET /v1/plugins/:id` | none | `{plugin: PluginSummary, manifest (latest), versions: PluginVersionInfo[]}` |
| `GET /v1/plugins/:id/:version` | none | `{manifest, ...PluginVersionInfo}`; `:version` may be `latest` |
| `GET /v1/plugins/:id/:version/package` | none | the `.tar.gz` (`application/gzip`), `X-Checksum-Sha256` header; counts a download |
| `GET /v1/plugins/:id/:version/files/*path` | none | one file out of the package (used as content download URLs) |
| `PUT /v1/plugins/:id/:version` | account key | body = package `.tar.gz`. The first account to publish an id owns it. Versions are immutable (409 on re-publish). `plugin.json` id/version must match the URL. |
| `POST /v1/plugins/:id/:version/yank` | account key (owner) or admin | hidden from `latest` and range resolution; still downloadable by exact version |

### Registry trust and moderation

The registry is meant to be the safe way to share Deadlock server plugins, so packages carry
publisher signatures that hosts can check without trusting the registry, and the registry
publishes advisories and takes reports. Types live in `protocol/src/registry.ts`; signing in
`protocol/src/signing.ts`.

**Signatures.** Publishers sign the exact package bytes with an Ed25519 key. Public keys and
`.minisig` files are minisign-compatible, so `minisign -Vm pkg.tgz -P RWQ…` verifies a package
with no OpenCitadel code. The trusted comment is
`opencitadel package <id>@<version> sha256:<hex> timestamp:<unix>`.

| Method & path | Auth | Notes |
|---|---|---|
| `GET /v1/registry` | none | `RegistryInfo` |
| `POST /v1/accounts/me/signing-keys` | account key | `{publicKey, label?}` → `201 {key: SigningKeyInfo}`. At most 10 active keys per account; a key id registered by another account → 409. |
| `GET /v1/accounts/me/signing-keys` | account key | `{keys: SigningKeyInfo[]}` (revoked keys included) |
| `DELETE /v1/accounts/me/signing-keys/:keyId` | account key | revokes (`revokedAt` set; kept for history) → 204 |
| `GET /v1/publishers/:name` | none | `PublisherInfo` (the account's keys, revoked ones included, and its plugin ids) |
| `PUT /v1/plugins/:id/:version` | account key | optional header `X-OpenCitadel-Signature: <base64 of the .minisig text>`. Verified against the publisher's active keys; a bad or unknown-key signature → 400. With `OPENCITADEL_REQUIRE_SIGNATURES=1`, unsigned → 422. |
| `PUT /v1/plugins/:id/:version/signature` | account key (owner) | body = `.minisig` text; only when that version has no signature yet |
| `GET /v1/plugins/:id/:version/package.minisig` | none | `text/plain` signature or 404 |

`PluginVersionInfo` gains `signature: {keyId, trustedComment}` and `keyChanged` (signed by a
different key than the previous signed version, or unsigned after a signed one). Version
detail responses also include the owner's name so hosts can fetch `/v1/publishers/:name`.

**Trusted publishing (CI).** A plugin owner links a GitHub Actions workflow to a plugin; that
workflow then publishes without any API key in CI, and each version records where it was built.

| Method & path | Auth | Notes |
|---|---|---|
| `POST /v1/plugins/:id/trusted-publishers` | account key (owner, or anyone for an id nobody owns yet, which reserves it) | `TrustedPublisherInput` → `201 {publisher: TrustedPublisher}`; at most 10 per plugin |
| `GET /v1/plugins/:id/trusted-publishers` | account key (owner) | `{publishers}` |
| `DELETE /v1/plugins/:id/trusted-publishers/:tpId` | account key (owner) | → 204 |
| `PUT /v1/plugins/:id/settings` | account key (owner) | `{requireTrustedPublishing: boolean}` → `{settings}`. When true, account keys can no longer publish versions of this plugin (403); only its trusted publishers can. |
| `POST /v1/oidc/github` | none | `{token: <GitHub Actions OIDC JWT>}` → `OidcExchangeResponse`, or 401 explaining why no publisher matched |

Exchange rules:
* **Verify the token.** It must be RS256, signed by a key from the issuer's JWKS (fetched from
  `<issuer>/.well-known/jwks`, cached, re-fetched for unknown `kid`s at most once a minute).
* **Check the claims.** `iss` must equal the configured issuer; `aud` must contain the
  registry's audience; `exp`/`nbf`/`iat` are checked with 60 s of leeway.
* **Match a publisher.** A trusted publisher matches when:
  * `repository` matches case-insensitively;
  * the workflow file in `job_workflow_ref` (`<repo>/.github/workflows/<file>@<ref>`) equals
    `workflow`;
  * if set, `environment` equals the token's `environment`;
  * if set, `ref` matches the token's `ref` (`*` within a path segment).
* **Pin the repository.** On first use the publisher pins `repository_id`; later tokens with a
  different id are refused.
* **Issue the token.** It is `ocp_…`, valid 15 minutes, multi-use, and scoped to every matching
  plugin. It is stored hashed with the token's claims.

Publishing with `Authorization: Bearer ocp_…` works for the plugins in the token's scope, on
behalf of the account that owns the trusted publisher (a reserved id becomes owned on first
publish). The version stores `provenance` (`Provenance`), returned in `PluginVersionInfo` and shown
on the plugin page with a link to the workflow run. Signature rules are unchanged: the
`X-OpenCitadel-Signature` must verify against the owning account's keys.

Configuration: `OPENCITADEL_GITHUB_OIDC_ISSUER` (default `https://token.actions.githubusercontent.com`;
set it for GitHub Enterprise Server), `OPENCITADEL_GITHUB_OIDC_JWKS_URL` (default
`<issuer>/.well-known/jwks`), `OPENCITADEL_OIDC_AUDIENCE` (default: the public URL, else
`opencitadel`). `RegistryInfo.oidc.github.audience` publishes the audience CI must request.

**Advisories.** `POST /v1/plugins/:id/advisories` (owner or admin) with `AdvisoryInput` →
`201 {advisory}`; `GET /v1/plugins/:id/advisories` → `{advisories}`;
`GET /v1/advisories?since=<ISO>` → `{advisories}` across all plugins (newest first, ≤ 500);
`POST /v1/advisories/:id/withdraw` (owner or admin) → `{advisory}`.

**Reports.** `POST /v1/plugins/:id/reports` with `ReportInput` → `202 {id}` (no auth; at most
5 per IP per hour). Admin: `GET /v1/admin/reports?status=open|resolved`,
`POST /v1/admin/reports/:id/resolve {note}`. `citadel-master serve --abuse-contact <address>`
(or `OPENCITADEL_ABUSE_CONTACT`) is published in `RegistryInfo` and on the web UI.

**Deadworks FastDL.** Content VPKs from registry packages are indexed at publish time
(`{pluginId, version, path, kind, name, sha256, size}`; addon names follow the host's
`<id with - as _>_<file stem>` rule, map names are the map stem). The master serves them in the
layout the Deadworks launcher downloads from:
`GET /fastdl/maps/<name>_<sha256[0:16]>.vpk.zst` and `GET /fastdl/addons/<name>_<sha256[0:16]>.vpk.zst`,
streamed as zstd (stored frames via `createZstdStoredStream`, see `protocol/src/zstd.ts`).
A Deadworks server can then set `dw_fastdl` to `<master>/fastdl`.

**Privacy.** Hosts publish player names only when `privacy.showPlayerNames` is set (default
off; the list still carries count, heroes and teams). Deadworks heartbeats always include names,
so the master drops them from Deadworks listings unless `OPENCITADEL_DEADWORKS_PLAYER_NAMES=1`.

### Admin (`Authorization: Bearer $OPENCITADEL_ADMIN_TOKEN`)

`DELETE /v1/admin/servers/:id` (delist + block its token), `POST /v1/admin/accounts/:id/disable`,
`POST /v1/admin/plugins/:id/:version/yank`, `GET /v1/admin/servers` (includes owner + IP).

### Deadworks compatibility (`/api/servers/*`)

So a Deadworks server can list here by setting `serverbrowser.api_url` in
`game/bin/win64/configs/deadworks.jsonc`, and a Deadworks launcher built with
`DEADWORKS_API_URL` can browse this list:

| Deadworks route | Behaviour |
|---|---|
| `POST /api/servers/register` `{name, port, max_players}` | No auth (rate-limited per IP; disabled when registration is closed). Address = request source IP + `port`. → `{id, token}` (strings). |
| `POST /api/servers/:id/heartbeat` (Bearer token) | Body `{name, version, port, player_count, max_players, map, game_mode, players[{name,hero,team,kills,deaths,assists,level}], mods[{name,type,version}], content_addons[], extra_maps[]}` → stored as a listing with `source:"deadworks"`, `software:{name:"deadworks",version}`, `connect.address` = source IP + port, TTL 240 s. |
| `GET /api/servers` | `{servers:[DwServer]}` across online listings that have a dotted-quad `ip:port` (Deadworks clients can only connect that way; SDR-only servers are omitted) |
| `GET /api/servers/:id` | `DwServer` or 404 (also 404 for SDR-only servers) |
| `GET /api/servers/lookup?address=ip:port` | `DwServer` or 404 |
| `GET /api/servers/:id/content` | `{items:[{filename, kind, version, download_url, sha256, size}]}` from the listing's `content` |

`DwServer = {id, registered:true, name, address, raw_address, country, online, player_count,
max_players, map, players, mods, content_addons, extra_maps, content, last_heartbeat}`.
The image-encoded `/api/browse/*` feed used by Deadworks' in-game Panorama browser is not
implemented.

### Web server browser

`GET /` serves a dependency-free single-page app from `packages/master/web/` (`index.html`,
`app.js`, `style.css`). Hash routes: `#/` (servers), `#/server/<id>`, `#/plugins`,
`#/plugin/<id>`, `#/host` (how to host). It reads only the public `GET /v1/*` routes, relative to
its own origin.

**Local mode.** On load the app requests `GET /local/info`
(`{ok, version, masterUrl, gameFound, gamePath, favorites}`). If that answers JSON, the page is
being served by `citadel-browser ui` and:
* "Join" calls `POST /local/join/<id>` with a JSON body `{password?, force?}`; the response is
  `{ok, launched, steamUrl, command, contentInstalled: string[], restartRequired, message}`.
  Failures keep that shape and add `error: {code, message}` with status 401 (password needed),
  404 (unknown server), 409 (offline, full, no connect target, game not found) or 502 (content
  download failed).
* Ping comes from `GET /local/ping?ids=<id,id,…>` → `{pings: {<id>: ms | null}}`.
* Favourites: `GET /local/favorites` → `{ids}`, `PUT|DELETE /local/favorites/<id>`.

Without local mode, "Join" opens `steamJoinUrl()` for the server and shows the console command
with a copy button; servers with `requiresContent` explain that `citadel-browser` installs
the content.

## Host (`citadel-host`)

### Files

`citadel-host` works out of a server directory (default: cwd, `--dir` to override):

```
server.json                 config (mode 0600: holds the server token and RCON password)
.opencitadel/
  state.json                written by the running supervisor every few seconds (ServerState + pid)
  installed.json            installed packages: {id: {version, kind, sha256, files[]}}
  plugins/<id>/             unpacked host plugins
  data/<id>/                each plugin's dataDir; storage.json lives here
  cache/<sha256>.tgz        downloaded packages
  logs/host.log
```

`server.json`:

```jsonc
{
  "name": "My Deadlock Server",
  "description": "",
  "region": "eu-west",            // optional, protocol REGIONS
  "country": "DE",                // optional
  "tags": ["casual"],
  "links": {},                    // {website?, discord?}
  "game": {
    "path": null,                 // Deadlock install root; null = auto-detect
    "executable": "deadlock",     // "deadlock" | "deadworks"
    "wrapper": [],                // e.g. ["wine"] on Linux
    "map": "dl_midtown",
    "port": 27015,
    "password": "",
    "maxPlayers": 12,             // passed as -maxplayers when not 12
    "convars": {},                // written into the generated cfg
    "extraArgs": [],
    "patchGameinfo": true,        // re-apply the P2P edits before every start
    "logSource": "stdout",        // "stdout" | "condebug" (tail citadel/console.log)
    "mapChange": "restart"        // "restart" (relaunch on the new map) | "changelevel"
  },
  "rcon": { "enabled": true, "password": "<generated>" },
  "publicAddress": null,          // "203.0.113.5:27015" to advertise a direct address; null = SDR only
  "master": { "url": "http://localhost:8080", "serverId": null, "token": null, "listed": true },
  "restart": { "onCrash": true, "maxBackoffSeconds": 300, "dailyAt": null, "afterMatch": true, "afterMatchDelaySeconds": 20 },
  "admins": [],                   // SteamIDs ([U:1:…] or 7656…) allowed to run admin chat commands
  "bridge": { "enabled": true, "port": 27100 },
  "privacy": { "showPlayerNames": false },
  "security": { "requireSignatures": false, "trustedKeys": {} },
  "plugins": { "<id>": { "enabled": true, "config": {}, "sandbox": true, "memoryMb": 64, "timeLimitMs": 1000, "allowPrivateNetwork": false } }
}
```

### Launch

The host writes `game/citadel/cfg/opencitadel_server.cfg` (hostname, sv_password,
rcon_password, convars) so secrets stay off the process command line, then runs from
`game/bin/win64`:

```
[wrapper…] deadlock.exe|deadworks.exe -dedicated -console -dev -insecure -allow_no_lobby_connect
  [-usercon] [-condebug] [-maxplayers N] +tv_citadel_auto_record 0 +spec_replay_enable 0
  +tv_enable 0 +citadel_upload_replay_enabled 0 +hostport <port> +exec opencitadel_server.cfg
  [extraArgs…] +map <map>
```

with `OPENCITADEL_BRIDGE=127.0.0.1:<bridge.port>` and `OPENCITADEL_BRIDGE_TOKEN=<random per launch>`
in the environment. Crashes restart with exponential backoff (5 s doubling to
`maxBackoffSeconds`, reset after 10 minutes of uptime). `dailyAt: "05:00"` restarts at that
local time, announcing it in chat 5 and 1 minutes before when `server.chat` is possible.
`ChangeGameState: PostGame` emits `match.ended` and, with `afterMatch`, schedules a restart
`afterMatchDelaySeconds` later. `changeMap()` is a restart with `+map <new map>` (kept for later
crash restarts); inside the post-match window it only sets that map.

### Event sources

All three feed one event bus (`PluginEvents` in the SDK); each event is emitted once even when
several sources see it (the bridge wins, then RCON, then the log; RCON never sees chat, so log
chat lines are dropped only while the bridge is connected).

1. **Console log** (stdout, or with `logSource: "condebug"` `game/citadel/console.log` tailed
   from the launch offset). Parsers recognise the server SteamID (whole engine lines only, so a
   player name can't fake one), map loads, match phases, and Source-style
   `"Name<uid><[U:1:…]><team>" say "text"` chat lines. Unknown lines are just `console.line`
   events; the per-frame stdin noise line is dropped.
2. **RCON** (`-usercon`, `rcon_password`): connects once the server is up and polls `status`
   every 10 s. The parser is tolerant of the Source 2 `status` layout (`hostname`, `map`/`spawn`,
   `steamid`, `players : N humans, M bots (K max)`, then a player table). Player-list diffs produce
   `player.connected` / `player.disconnected` when the bridge is absent.
3. **Bridge** (`bridge/deadworks`): see below. Authoritative player, chat and map events.

### Heartbeat

Every 30 s while `master.listed` and the server is running, `POST /v1/servers/:id/heartbeat` with
the state merged with plugin listing contributions. `connect.steamId` comes from the log or
`status`; `connect.address` from `publicAddress`. `software = {name: "citadel-host", version}`.
`plugins` lists installed enabled packages; `content` lists `client: true` VPKs from installed
content packages, with URLs pointing at the registry's `/files/` route. On stop: `POST …/offline`.

### Bridge protocol (host ⇄ in-game plugin)

Newline-delimited JSON over TCP. The host listens on `127.0.0.1:<bridge.port>` only; the
in-game plugin connects (and reconnects every 5 s) to the address in `OPENCITADEL_BRIDGE`.

```
plugin → host  {"type":"hello","token":"…","bridge":"0.1.0","deadworks":"0.6.1","map":"dl_midtown"}
host → plugin  {"type":"welcome","host":"0.1.0"}             (or closes the socket on a bad token)
plugin → host  {"type":"event","name":"player.connected","data":{"slot":3,"name":"…","steamId64":"7656…"}}
               names: server.ready {map} · map.changed {map} · player.connected · player.disconnected {…,reason}
                      chat.message {slot,name,steamId64,message,teamOnly} · game.event {name,data}
host → plugin  {"type":"request","id":7,"method":"say","params":{"message":"hi"}}
               methods: command {command} · say {message} · tell {slot,message} · kick {slot,reason}
                        players {} → [{slot,name,steamId64,team,hero,bot}]
plugin → host  {"type":"response","id":7,"ok":true,"result":…}  |  {"type":"response","id":7,"ok":false,"error":"…"}
either way     {"type":"ping"} → {"type":"pong"}   (every 15 s; 45 s of silence closes the link)
```

Lines are at most 64 KiB; anything else closes the connection.

### Plugins

Installed packages are tracked in `.opencitadel/installed.json` and enabled in `server.json`.

* `host` packages are unpacked to `.opencitadel/plugins/<id>/`. By default each runs in its own
  QuickJS/WebAssembly interpreter on its own worker thread:
  * `plugins/sandbox.ts` is the main-thread controller and context operations;
    `plugins/sandbox-worker.ts` and `plugins/sandbox-core.ts` hold the interpreter;
    `plugins/sandbox-prelude.ts` is the guest-side context.
  * Synchronous context calls block only the worker. It posts the request and waits with
    `Atomics.wait` on a shared counter, and the main thread answers on a dedicated MessagePort
    that the worker reads with `receiveMessageOnPort`. Replies carry sequence numbers. Async
    operations answer `pending` and deliver their result as a normal message.
  * A watchdog pings each worker every 250 ms and terminates one that is quiet for longer than
    `timeLimitMs` + 2 s. That case only arises inside uninterruptible native code or GC.

  The guest itself works like this:
  * The guest gets a JavaScript implementation of the PluginContext. Every call crosses one
    JSON-string bridge into the host's permission-checked context, so permissions are enforced
    at a real boundary.
  * There is no filesystem, process or raw network access.
  * Imports are limited to the package's own files and the virtual `@opencitadel/plugin-sdk`.
  * `ctx.fetch` is proxied: http(s) only, public addresses only (re-checked per redirect),
    15 s, 1 MiB.
  * Limits are per plugin: `memoryMb` (64) and `timeLimitMs` per call (1000). Three overruns,
    or a terminated or crashed worker, unload the plugin and record the reason as a load failure.

  With `"sandbox": false` the plugin is instead imported as a Node module (cache-busted), with
  `.opencitadel/plugins/node_modules/@opencitadel/plugin-sdk` linked to the host's SDK. Typing
  `reload [id]` at the `citadel-host start` console reloads either kind without restarting the
  game. The
  default export must be a `definePlugin()` result. Plugins load in dependency order
  (`dependencies` ranges are checked against installed versions; a missing or mismatched
  dependency disables the dependent with an error). Every handler runs inside try/catch with a
  5 s timeout warning; a throwing plugin is logged, never fatal.
* `deadworks` packages copy `assemblies` into `game/bin/win64/managed/plugins/` (Deadworks
  hot-loads them); files are tracked so `remove` deletes exactly what was installed.
* `content` packages copy VPKs to the server: `maps` → `game/citadel/maps/<name>.vpk`, other
  VPKs → `game/citadel/opencitadel_server/pakNN_dir.vpk`, mounted through the
  `citadel/opencitadel_server` search path. That is deliberately separate from the player-side
  `citadel/opencitadel`, so hosting and playing on one install never clear each other's files.
* `plugin enable|disable` applies to host plugins; deadworks and content packages are active
  (and listed) while installed.

**Package trust on the host.** On install and update the host:

1. Downloads the version's `.minisig`, if there is one.
2. Fetches the publisher's keys from `/v1/publishers/:name` (or `--key-file` for a local
   `.tgz` with a sibling `.minisig`).
3. Verifies the archive.
4. Records the signing key id in `installed.json`.

Trust is pinned per plugin in `.opencitadel/trust.json`. The first signed install pins its key
(trust on first use) unless `security.trustedKeys[<id>]` or `["*"]` lists the keys allowed. An
update signed by a key outside the pinned set is refused unless `--accept-new-key` is given. A
previously signed plugin arriving unsigned is refused unless `--allow-unsigned` is given.
Unsigned packages install with a warning, or are refused when `security.requireSignatures` is
true.

The host prints each package's trust label (`TRUST_LABELS`) at install time. `citadel-host start`
runs a background advisory check and logs any installed version an advisory affects.

**Lockfile.** `plugin lock` writes `plugins.lock.json` (id, version, sha256, registry, keyId) in the
server directory. `plugin sync` installs exactly that set, failing on any sha256 or key mismatch,
so several servers can share one reviewed plugin set.

**`citadel-pkg`.** A second binary in the host package for Deadworks operators who don't run
`citadel-host`. It works against a Deadlock install (`--game <path>` or auto-detected) and keeps
its state in `game/bin/win64/configs/opencitadel/`. It supports the same `search`, `info`,
`install`, `remove`, `list`, `audit`, `lock` and `sync` commands for `deadworks` and `content`
packages; `host` packages require `citadel-host`.

CLI: `citadel-host init`, `register --api-key <ock_…> [--master URL]`, `start`, `status`,
`rcon <command…>`, `gameinfo status|patch|unpatch`, `plugin search <q>`, `plugin info <id>`,
`plugin install <id>[@range]` (resolves dependencies, verifies sha256, prints requested
permissions), `plugin remove <id>`, `plugin list`, `plugin enable|disable <id>`,
`plugin new <dir> [--kind host]` (scaffold), `plugin pack <dir>` (→ `<id>-<version>.tgz`),
`plugin publish <dir|tgz> --api-key <ock_…> [--key <file>] [--no-sign]` (signs automatically
when a key is available), `plugin keygen [--out <file>]` (default
`~/.opencitadel/signing/<keyId>.key`, mode 0600; `OPENCITADEL_SIGNING_PASSPHRASE` encrypts it),
`plugin key register [<file>] --api-key <ock_…>`, `plugin sign <tgz> [--key <file>]` (writes
`<tgz>.minisig`), `plugin audit`, `plugin lock`, `plugin sync`. A key is found from `--key`,
then `OPENCITADEL_SIGNING_KEY` (a path, or the key file's JSON itself, for CI secrets; its
passphrase in `OPENCITADEL_SIGNING_PASSPHRASE`), then the only file in `~/.opencitadel/signing/`.

**Publishing from CI.**
* `plugin publish … --oidc` uses trusted publishing. It is also the default inside GitHub
  Actions when no API key is given and `ACTIONS_ID_TOKEN_REQUEST_URL`/`ACTIONS_ID_TOKEN_REQUEST_TOKEN`
  are set (the job needs `permissions: id-token: write`).
* The flow:
  1. Read the audience from `/v1/registry`.
  2. Request a GitHub OIDC token (`GET $ACTIONS_ID_TOKEN_REQUEST_URL&audience=<aud>` with
     `Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN` → `{value}`).
  3. Exchange it at `/v1/oidc/github`, then publish with the `ocp_` token.
* Owner commands, all with `--api-key`:
  * `plugin trusted-publisher add <id> --repo <owner/repo> --workflow <file> [--environment <name>] [--ref <pattern>] [--require]`
  * `plugin trusted-publisher list <id>`
  * `plugin trusted-publisher remove <id> <publisher-id>`
  * `plugin trusted-publisher require <id> [--off]`
* `plugin new` scaffolds `.github/workflows/release.yml`. It builds, signs and publishes on
  `v*` tags, through a `release` environment.

## Browser (`citadel-browser`)

Config and state in `~/.opencitadel/client.json` (`{masterUrl, gamePath, favorites[], history[]}`)
and content cache in `~/.opencitadel/cache/<sha256>`. `OPENCITADEL_MASTER` / `--master` override
the master URL.

* `list [--search] [--region] [--map] [--mode] [--tags] [--not-full] [--not-empty] [--no-password] [--modded|--vanilla] [--sort] [--ping] [--json]`
* `info <id>` — details, players, plugins, required content.
* `join <id> [--password] [--no-content] [--print]` — sync content, then launch.
* `connect <address|steamid>` — join an unlisted server directly.
* `favorites [add|remove <id>]`, `history`
* `content status|clear` — show or remove installed server content (and the search path).
* `ui [--port 47900] [--no-open]` — serve the web browser locally with local mode on.

**Content sync.** For each `content` item: reuse the cache when its sha256 matches, otherwise
download (`.gz` URLs are gunzipped while streaming), check size + sha256 + the VPK magic
`34 12 AA 55`, then install. URLs that resolve to private or loopback addresses are refused at
every redirect hop, except the configured master's own host. Joining a server without content
still runs the sync, so the previous server's addons are unmounted (maps stay). Maps go to `game/citadel/maps/<name>.vpk` (refusing to overwrite a
map OpenCitadel did not install); addons go to `game/citadel/opencitadel/` as
`pak01_dir.vpk`, `pak02_dir.vpk`, … (the community addon naming convention) after clearing that
directory, and the content search path is added to `gameinfo.gi`. What is installed is
recorded in `game/citadel/opencitadel/installed.json`. Search paths are read at startup, so if
addon content changed while the game is running the browser says a restart is needed.
`content clear` removes only the player content line from `gameinfo.gi`, leaving any
hosting edits on the same install alone.

**Launch.** Opens the `steamJoinUrl()` with the platform opener (`rundll32 url.dll,FileProtocolHandler`
on Windows and WSL, because `cmd.exe /c start` would expand the `%`-escapes in `steam://run`
URLs; `open` on macOS; `xdg-open` on Linux), and prints the console command (also copied to the
clipboard where a clipboard tool exists) as the fallback for when the game is already running.
`join --print` installs content but opens nothing.
