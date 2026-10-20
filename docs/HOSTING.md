# Hosting

This guide covers running Deadlock game servers with `citadel-host` and running your own
master server with `citadel-master`. Paths below assume you cloned this repository and ran
`pnpm install && pnpm build`. Add `alias citadel-host="node /path/to/packages/host/dist/cli.js"`
(and the same for the other CLIs) to save typing.

## Game servers

### Requirements

* A machine with Deadlock installed through Steam. Valve ships no separate server download;
  the client install contains the dedicated server.
  * **Windows:** runs natively.
  * **Linux:** runs the Windows build under Wine. Set `"wrapper": ["wine"]` in `server.json`.
    Deadworks' Docker image is a working reference for the Wine setup.
* Node.js ≥ 22.13.
* About 4 cores and 4–8 GB RAM per 12-player server.

### 1. Create the server directory

```sh
mkdir ~/deadlock-server && cd ~/deadlock-server
citadel-host init
```

`init` finds the Deadlock install (set `DEADLOCK_PATH` if it can't), generates an RCON password
and writes `server.json` with owner-only permissions. Edit it to set the name, region, tags, map
and password. Every field is documented in [ARCHITECTURE.md](ARCHITECTURE.md#host-citadel-host).

### 2. Patch gameinfo.gi

```sh
citadel-host gameinfo status
citadel-host gameinfo patch
```

The dedicated server only accepts Steam P2P connections with two extra lines in
`game/citadel/gameinfo.gi`. `citadel-host`:

* adds them, tagging each line with `// opencitadel:added`;
* backs up the file first, to `gameinfo.gi.opencitadel.bak`;
* re-applies them before every start, because Steam restores the file on each game update.

`citadel-host gameinfo unpatch` removes exactly the tagged lines. When you play on the same
install the lines are harmless, but you can unpatch whenever you like.

### 3. List it on a master server

Get an account API key from the master's operator. If you run your own master:
`citadel-master account create <name>`. On a master with open registration, you can instead
`POST /v1/accounts`. Then:

```sh
citadel-host register --api-key ock_… --master https://servers.example.org
```

This creates the server on the master and stores its id and server token in `server.json`. The
token can only update this one server. Rotate it with `POST /v1/servers/<id>/rotate-token` if it
leaks.

### 4. Start

```sh
citadel-host start
```

The host does the following:

* Launches the game with the flags in [ARCHITECTURE.md](ARCHITECTURE.md#launch).
* Writes secrets to `citadel/cfg/opencitadel_server.cfg` instead of the command line.
* Reads the server's console output.
* Connects over RCON.
* Learns the server's Steam ID.
* Heartbeats the master every 30 seconds.

The terminal stays a console. Typing works as follows:

| You type | Effect |
|---|---|
| `!command` | Runs a plugin chat command |
| `reload [plugin]` | Reloads plugins |
| `status` | Shows server status |
| `quit` | Stops the server |
| anything else | Sent to the server as a console command |

From another terminal, `citadel-host status` and `citadel-host rcon <command>` work too.

Ctrl+C stops the server cleanly and tells the master it went offline. Crashes restart with
exponential backoff. Set `restart.dailyAt` (e.g. `"05:00"`) for a daily restart; players get
warnings in chat beforehand.

**After a match.** A stock server stays on a finished match. Players who reconnect to it (the
game retries on its own) load in, see the match is over and drop out again, every 10 seconds.
So 20 seconds after a match ends, once the post-game screen has had its time, the host starts a
fresh server. Tune that with `restart.afterMatchDelaySeconds`, or turn it off with
`restart.afterMatch: false`. The `map-rotation` plugin uses this restart to move on to the next
map.

**Map changes** restart the server on the new map, because `changelevel` crashes a stock server
(build 6796). Everyone is disconnected, and an anonymous server comes back with a new Steam ID,
which the listing picks up. If your server handles `changelevel` (a later game build, or
Deadworks), set `game.mapChange: "changelevel"`.

### How players reach you

Each listing carries one or both of these connect targets:

| Target | What it is | What you need |
|---|---|---|
| **Steam Datagram Relay** (default) | The server's anonymous Steam ID `[A:1:…]`; players join through Valve's relay network. | No port forwarding. |
| **Direct address** | Set `"publicAddress": "203.0.113.5:27015"`. Players connect directly. The master probes the address over A2S, marks the listing *verified*, and from then on trusts the probe's player count over the host's report. A stock server doesn't answer A2S (checked on build 6796), so in practice only servers that do, such as Deadworks ones, get verified. | UDP 27015 forwarded to the server. |

The anonymous Steam ID changes on every launch. The host re-reads it and re-publishes it after
each restart, so listings stay joinable.

RCON listens on the game port over **TCP**. The host binds it to 127.0.0.1 (`+ip 127.0.0.1`), so
it isn't reachable from the network; players' UDP traffic is unaffected. For remote RCON, pass
your own `-ip` in `game.extraArgs` and firewall TCP 27015 to the addresses you use: the
generated password is strong, but nothing beyond it guards RCON.

### Deadworks servers

[Deadworks](https://github.com/Deadworks-net/deadworks) runs .NET plugins inside the server
process. To use it with OpenCitadel:

1. Install Deadworks into the game folder by following its README, so that
   `game/bin/win64/deadworks.exe` exists.
2. Set `"game": { "executable": "deadworks" }`.
3. Install the bridge plugin: build `bridge/deadworks` (see its README) and copy
   `OpenCitadel.Bridge.dll` into `game/bin/win64/managed/plugins/`.
4. With the bridge connected, host plugins get exact player, chat and map events. They can also
   message individual players and kick by slot.

A plain Deadworks server can also list on a `citadel-master` without `citadel-host`. Set
`serverbrowser.api_url` in `game/bin/win64/configs/deadworks.jsonc` to your master's URL; the
master accepts Deadworks' own registration and heartbeat calls.

### Plugins

```sh
citadel-host plugin search rotation
citadel-host plugin install map-rotation
citadel-host plugin list
```

`install` does the following:

* Resolves dependencies.
* Verifies each package's sha256.
* Shows the permissions the plugin asks for.
* Enables it in `server.json`, under `plugins.<id>.config`, where you set its options.

Type `reload` in the host console to apply changes without restarting the game. Writing your
own plugin is covered in [PLUGINS.md](PLUGINS.md).

**Sandbox.** Host plugins run in a WebAssembly sandbox by default, each on its own thread. They
have no file, process or network access beyond their declared permissions, and each has memory
and CPU limits. A misbehaving plugin can't slow the server down: it is shut off and logged.
Budget about 14 MB of memory per sandboxed plugin.
* `plugins.<id>.memoryMb` and `timeLimitMs` raise the limits for a demanding plugin.
* `allowPrivateNetwork: true` lets a plugin's `fetch` reach your LAN.
* `sandbox: false` runs a plugin with full access. Reserve it for code you wrote.

Deadworks plugins always run with full trust inside the game server, so review those
especially carefully.

**Trust.** When a package is signed, the host verifies the signature and pins the publisher's
key the first time it installs that plugin. After that, an update signed by a different key is
refused unless you pass `--accept-new-key`. To control this in `server.json`:
* Set `security.requireSignatures: true` to refuse unsigned packages entirely.
* List keys you have checked out-of-band under `security.trustedKeys` (per plugin id, or `"*"`
  for all plugins).

`citadel-host plugin audit` lists installed versions with security advisories; `start` runs
the same check in the background. `plugin lock` and `plugin sync` keep several servers on
exactly the same reviewed plugin set.

**Privacy.** Listings show player counts, heroes and teams, but not player names, unless you set
`privacy.showPlayerNames: true`.

### Several servers on one machine

The generated cfg (and `console.log`, with `logSource: "condebug"`) lives inside the game folder, so each running server needs its
own copy of the game folder. The copy can be a symlink tree like the one Deadworks' Docker setup
uses. In each server's `server.json`:

* give each server a different `game.port` and `bridge.port`;
* point `game.path` at its own tree.

## Master server

```sh
citadel-master serve --port 8080 --data /var/lib/opencitadel --public-url https://servers.example.org
```

* **Storage.** A single SQLite file (`master.db`) plus plugin packages under `packages/`. Back
  up the data directory.
* **TLS.** Put it behind a reverse proxy that terminates TLS, and set
  `OPENCITADEL_TRUST_PROXY=1` so rate limits and Deadworks address detection see the client's
  real IP.
* **Registration.** `OPENCITADEL_REGISTRATION=closed` stops self-service sign-ups; you then
  create accounts with `citadel-master account create`.
* **Moderation.** `OPENCITADEL_ADMIN_TOKEN=<long random string>` enables `/v1/admin/*` for
  delisting servers, disabling accounts and yanking plugin versions. The CLI equivalents are
  `citadel-master server delist <id>` and `citadel-master account disable <name>`.
* **Deadworks.** `OPENCITADEL_DEADWORKS_COMPAT=0` turns off the Deadworks routes.

The web browser is served at `/`. All of its data comes from the public `GET /v1/*` API, which
also allows cross-origin reads, so other sites and tools can build on your list.

## Troubleshooting

| Symptom | Check |
|---|---|
| Listing never appears | `citadel-host status`: is the server running and is a Steam ID known? Watch the host log for heartbeat errors (401 means a wrong token; re-run `register`). |
| Players can't connect via Steam ID | `citadel-host gameinfo status` must report the P2P edits as present. Restart after patching. |
| Not marked verified | `publicAddress` must be reachable over UDP from the master; private/LAN addresses are never probed. |
| RCON never connects | `rcon.enabled` must be true and the port free; check the console log for the bind error. |
| Players stuck on a loading screen after a match | Keep `restart.afterMatch` on (the default after 0.1.1). |
| `game/citadel/console.log` grows by hundreds of MB a day | The server prints a line every frame because its input isn't a console. Set `game.logSource: "stdout"` (the default after 0.1.1; servers set up with 0.1.0 or 0.1.1 have `"condebug"` written in `server.json`). |
| `deadworks.exe` exits with code 78 | That Deadworks release doesn't support the current game build yet; wait for an update. |
