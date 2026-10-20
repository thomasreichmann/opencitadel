# OpenCitadel

An open plugin registry, server list and host tooling for
[Deadlock](https://store.steampowered.com/app/1422450/Deadlock/) community servers. It works
alongside [Deadworks](https://github.com/Deadworks-net/deadworks), the in-process server
framework, and with vanilla `deadlock.exe -dedicated` servers.

* **Plugin registry.** Publish and install Deadworks plugins, TypeScript host plugins and
  content packs (maps, VPK mods), with:
  * versioned, immutable packages and dependency resolution;
  * minisign-compatible publisher signatures that hosts pin on first install;
  * trusted publishing from GitHub Actions: no API key stored in CI, and every release links to
    the commit and workflow run that built it;
  * security advisories with `audit`, abuse reports, and lockfiles for reproducible servers.

  Deadworks operators can use it without the rest of OpenCitadel through `citadel-pkg`.
* **Open server list.** `citadel-master` is self-hostable. It does the following:
  * accepts heartbeats from OpenCitadel hosts and from Deadworks servers, using Deadworks' own
    API;
  * checks listed addresses over A2S and leaves player names out by default;
  * serves registry content in the layout the Deadworks launcher downloads;
  * includes a web server browser.
* **Host tooling.** `citadel-host` runs and supervises `deadlock.exe` or `deadworks.exe`. It:
  * keeps `gameinfo.gi` patched across game updates;
  * restarts after crashes;
  * keeps servers listed even while Deadworks waits for an update after a game patch;
  * runs host plugins that keep working across game patches, each in its own WebAssembly
    sandbox with no file, process or network access beyond what its permissions allow.
* **Player tools.** `citadel-browser` lists servers, syncs and verifies the content a server needs,
  and launches Deadlock into it.

> Deadlock has no official dedicated-server release. This project is built on how the game
> behaves today (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#how-deadlock-servers-work-today-the-facts-this-design-rests-on)).
> It is not affiliated with Valve.

## Quick start

Requires Node.js ≥ 22.13 and pnpm.

```sh
pnpm install
pnpm build
pnpm test
```

Run a master server and open the browser at http://localhost:8080:

```sh
node packages/master/dist/cli.js serve --port 8080 --data ./data
node packages/master/dist/cli.js account create my-community   # prints an API key (ock_…)
```

Host a server (on the machine with Deadlock installed):

```sh
mkdir my-server && cd my-server
node ../packages/host/dist/cli.js init
node ../packages/host/dist/cli.js register --api-key ock_… --master http://localhost:8080
node ../packages/host/dist/cli.js start
```

Find and join servers:

```sh
node packages/client/dist/cli.js ui          # local web browser with one-click join + content sync
node packages/client/dist/cli.js list --ping
node packages/client/dist/cli.js join <server-id>
```

## Documentation

| | |
|---|---|
| [docs/HOSTING.md](docs/HOSTING.md) | Running game servers and a master server |
| [docs/PLAYERS.md](docs/PLAYERS.md) | Finding and joining servers |
| [docs/PLUGINS.md](docs/PLUGINS.md) | Writing, signing, packaging and publishing plugins |
| [docs/REGISTRY.md](docs/REGISTRY.md) | Running a registry: signature policy, advisories, takedowns, FastDL for Deadworks |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How it fits together; HTTP API, bridge protocol, file formats |
| [docs/RELEASING.md](docs/RELEASING.md) | Cutting a release: tag, then npm trusted publishing with provenance |
| [docs/ROADMAP.md](docs/ROADMAP.md) | What's next, in priority order, and known limitations |

## Repository layout

```
packages/protocol     wire types, validation, SteamID/semver, package format, A2S
packages/gamefiles    Deadlock install discovery, gameinfo.gi editing
packages/master       citadel-master: REST API, SQLite, web browser (web/), plugin registry
packages/host         citadel-host: supervisor, RCON, log parsing, heartbeat, plugin runtime
packages/plugin-sdk   types + definePlugin() for host plugins
packages/client       citadel-browser: CLI, local web UI, content sync, join
plugins/              example host plugins (welcome, map-rotation, discord-webhook)
bridge/deadworks      OpenCitadel.Bridge: Deadworks plugin that streams game events to the host
```

## License

MIT. See [LICENSE](LICENSE).
