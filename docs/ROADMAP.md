# Roadmap

Where OpenCitadel goes after 0.1. The direction:
* OpenCitadel is the open plugin registry, server list and host tooling for Deadlock community
  servers;
* it works alongside [Deadworks](https://github.com/Deadworks-net/deadworks) and vanilla
  dedicated servers;
* it is not a rival launcher.

Items are in priority order. Each says why it matters, what "done" looks like, and what a
maintainer has to decide or provide.

## Now

### 1. Finish validating against a real Deadlock server

**Why.** Until October 2026 everything was tested against a stand-in for the game
(`packages/host/src/testing/fake-game.ts`). Behaviour that was inferred rather than observed
breaks hosting or joining when it's wrong.

**Verified** on a stock server, build 6796, with the host running under WSL:
* The host launches the server, patches `gameinfo.gi`, and reads the SteamID, map and match
  phases from its output.
* It drives the server over RCON (`status`, `say`, `quit`) and lists it on a master.
* A client on the same machine joined over Steam Datagram Relay with the password, and the
  welcome plugin greeted it.
* A crash restart and a graceful stop both worked.
* Parser fixtures now come from captured output.

The test found eleven bugs, all fixed; ARCHITECTURE.md lists the server behaviour behind them.
It also showed that a stock server doesn't answer A2S (see the limitations below).

**Still to verify.**
* **Joining from the browser.** The test client was started by
  `steam://run/1422450//+connect [A:1:…]/`, but whether `+connect` alone completes the join
  wasn't isolated. `steam://connect/<ip:port>` for direct addresses is untested.
* **A remote player.** Every client so far ran on the server's machine.
* **Chat on a stock server.** No player chat appeared in the server output during the test. If
  a stock server never prints chat, chat commands need the bridge.
* **`map <name>`.** It is untested; `changelevel` crashes the server.
* **Deadworks bridge.** `say`, `tell`, `kick`, `command` and `players` inside a live server
  (`bridge/deadworks`), and plugins receiving real player, chat and map events through it.

**Done when.**
* A client on another network joins from `citadel-browser`.
* The bridge works on a live Deadworks server.

**Needs.**
* A second machine or a friend for the remote join.
* A Deadworks install for the bridge.
* `citadel-host gameinfo unpatch` reverses the `gameinfo.gi` edit afterwards.

### 2. Coordinate with Deadworks and Deadlock Mod Manager

**Why.** The community-server scene is small, and Deadworks already ships the in-process
framework, a server list and a launcher. A third, parallel stack would split it. Interop
benefits everyone.

**Propose.**
* OpenCitadel as an open, self-hostable registry and server list that speaks Deadworks'
  protocol (heartbeats, `/api/servers`, FastDL layout).
* A signed plugin registry for Deadworks plugins: minisign signatures, advisories, lockfiles and
  `citadel-pkg`.
* Small upstream changes:
  * a configurable or multi-registry API base in the launcher;
  * signed content manifests alongside `dw_*` A2S rules;
  * opt-in telemetry;
  * no player names in public listings.
* Aligning `gameinfo.gi` patching conventions, since several tools edit that file.

**Done when.** A short pitch is sent with the public repo and the npm packages as evidence,
and there is a reply or a decision to proceed independently.

**Needs.** A maintainer to send it. A draft can be prepared.

### 3. Run a public registry

**Why.** Nobody can browse servers or publish plugins until a `citadel-master` is reachable.

**Work.**
* **Deploy.** Deploy `citadel-master` on a small VPS, Fly.io or Railway, with TLS behind a
  reverse proxy. Set `OPENCITADEL_TRUST_PROXY=1`, `--public-url`, an abuse contact and an admin
  token. Back up the data directory.
* **Ingest Deadworks servers.** Read Steam's master list filtered to `dw1`-tagged Deadlock
  servers, then read their `dw_*` A2S rules. That way the browser shows the existing Deadworks
  servers from day one, marked by source and trust tier.
* **Dogfood the registry.** Publish the example plugins (welcome, map-rotation,
  discord-webhook) to it through trusted publishing.

**Done when.** A public URL shows real servers, and the example plugins install from it with
`citadel-host plugin install`.

**Needs.**
* A hosting choice and a domain.
* Whether to require signatures from day one (`OPENCITADEL_REQUIRE_SIGNATURES`).
* Whether registration is open or closed.

## Quick wins

### Lock down publishing on npm
In each package's npm settings, choose "Require two-factor authentication and disallow tokens".
Trusted publishing from the release workflow is unaffected, and a stolen npm token can no longer
publish. **Needs:** one 2FA code.

### Repository hardening
* Protect `main`: require the CI check, and disallow force pushes.
* Dependabot for npm and GitHub Actions updates.
* Pin actions to commit SHAs instead of major tags.
* Optionally, a required reviewer on the `npm` environment, so each release waits for a click.

### Windows in CI
The host mainly runs on Windows, but CI only runs on Ubuntu. Add a `windows-latest` job (build,
unit tests, the end-to-end script) to exercise the Windows-specific paths: path handling,
launching with `rundll32`, process detection.

### Name review
Check whether "Citadel" (Deadlock's internal codename) is a registered Valve mark before
promoting the project widely. The packages already carry nominative "for Deadlock" wording and
a "not affiliated with Valve" note.

## Bigger bets

### One-command Linux hosting
A Docker image that runs `citadel-host` with the Windows server build under Wine, like
Deadworks' image. It should reuse a mounted game install, make the master URL, token and RCON
password configurable through the environment, and be healthy only once A2S answers.

### Registry accounts with 2FA and a dashboard
Accounts are API-key only today. Add a web sign-in (passkeys or TOTP), and a dashboard for:
* servers and tokens;
* signing keys;
* trusted publishers;
* advisories and reports.

Account keys could then be scoped and short-lived.

### Harder-to-spoof listings
* Cross-check self-reported player counts against A2S_PLAYER, for servers that answer A2S.
* Bind native heartbeats to the server's source IP, and cap listings per IP.
* Add separate verify, dead and ghost timers, in the style of Northstar's Atlas master server.
* Label explicit trust tiers in the browser: A2S-verified, SDR-only (self-reported) and
  Steam-discovered.

### In-game server browser
Deadlock's Panorama UI can't make ordinary web requests. Deadworks already injects a browser
into the Play page through its client bootstrap. Build on that, or feed it from the open list
via its launcher bridge, rather than reinventing the injection.

## Known limitations (0.1)

* **Partly verified on the real game.** Stock servers work on build 6796; see item 1 for what is
  left.
* **Map changes restart a stock server.** `changelevel` crashes it, so changing maps (including
  after a match) disconnects everyone, and players reconnect from the browser.
* **Sandbox overhead.** Host plugins run in a WebAssembly sandbox, one worker thread each. That
  costs about 14 MB of memory and 50 ms of load time per plugin.
* **Deadworks addons need a config edit.** Content addons installed by `citadel-pkg` for
  Deadworks still have to be named in `serverbrowser.content_addons` by hand; the command
  prints the lines to add.
* **Stock servers can't be verified.** The master's A2S probe gets no answer from a stock
  server, even with its port forwarded, and can't reach relay-only servers at all. Their
  player counts are self-reported. Deadworks servers answer A2S. One idea is to check stock
  servers against Steam's own server list (Web API `IGameServersService/GetServerList`) by
  SteamID instead, if anonymous Deadlock servers show up there.
* **No hosted instance yet;** see item 3.
