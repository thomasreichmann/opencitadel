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

### 1. Validate against a real Deadlock server

**Why.** Everything so far has been tested end to end against a stand-in for the game
(`packages/host/src/testing/fake-game.ts`), never a live `deadlock.exe -dedicated`. A few
behaviours are inferred rather than observed, and if any is wrong, hosting or joining breaks.

**Verify.**
* **Status and logs.** RCON `status` output layout: hostname, map, the `steamid` line, the
  player table and the `public` address format. The server's SteamID log lines
  (`SV:  ServerSteamID=[A:1:…] (…)`, `Gameserver logged on to Steam, assigned identity …`) and
  the map-load lines.
* **RCON.** RCON answers on the game port over TCP with `-usercon` and an exec'd
  `rcon_password`.
* **Patching and queries.** The `gameinfo.gi` P2P edits make `connect [A:1:…]` work over Steam
  Datagram Relay, and the client still plays normally with them in place. A2S_INFO answers on
  the game port, so master verification works.
* **Joining.** `steam://run/1422450//+connect [A:1:…]/` launches into the server, and
  `steam://connect/<ip:port>` works for direct addresses.
* **Deadworks bridge.** `say`, `tell`, `kick`, `command` and `players` inside a live server
  (`bridge/deadworks`).
* **Plugins.** Plugins receive real player, chat and map events through the bridge.

**Done when.** A host on a real install:
* lists itself on a master with the right SteamID, map and players;
* a second client joins from `citadel-browser`;
* the welcome plugin greets that client;
* parser fixtures are updated from captured real output.

**Needs.** A machine with Deadlock installed, at a time nobody is playing on it. The test
launches the game in server mode and edits `gameinfo.gi`; `citadel-host gameinfo unpatch`
reverses the edit.

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
* Cross-check self-reported player counts against A2S_PLAYER.
* Bind native heartbeats to the server's source IP, and cap listings per IP.
* Add separate verify, dead and ghost timers, in the style of Northstar's Atlas master server.
* Label explicit trust tiers in the browser: A2S-verified, SDR-only (self-reported) and
  Steam-discovered.

### In-game server browser
Deadlock's Panorama UI can't make ordinary web requests. Deadworks already injects a browser
into the Play page through its client bootstrap. Build on that, or feed it from the open list
via its launcher bridge, rather than reinventing the injection.

## Known limitations (0.1)

* **Real-game behaviour is unverified;** see item 1.
* **Sandbox overhead.** Host plugins run in a WebAssembly sandbox, one worker thread each. That
  costs about 14 MB of memory and 50 ms of load time per plugin.
* **Deadworks addons need a config edit.** Content addons installed by `citadel-pkg` for
  Deadworks still have to be named in `serverbrowser.content_addons` by hand; the command
  prints the lines to add.
* **Relay-only servers can't be verified.** The master can't A2S-probe servers reachable only
  through Steam Datagram Relay, so their player counts are self-reported.
* **No hosted instance yet;** see item 3.
