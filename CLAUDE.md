# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

OpenCitadel: a plugin registry, open server list and host tooling for Deadlock community servers.
It works alongside [Deadworks](https://github.com/Deadworks-net/deadworks), the .NET in-process
server framework, rather than replacing it. The repo has two halves with separate toolchains:

- **TypeScript** (pnpm workspace, Node ≥ 22.13): `packages/*`, the six published `@opencitadel/*`
  packages, and `plugins/*`, private example host plugins.
- **C# / .NET 10**: `bridge/deadworks`, a Deadworks plugin linking the game to `citadel-host`, and
  `modes/bhop`, the CS:S bhop showcase (movement core, Deadworks plugin, `citadel-port` BSP porter).

Reference docs, worth reading before changing an area:
- `docs/ARCHITECTURE.md`: HTTP API, bridge protocol, `server.json` schema, on-disk layouts, and
  observed server behaviour.
- `docs/PLUGINS.md`: plugin authoring, the sandbox, signing.
- `modes/bhop/README.md`: the bhop mode and the engine facts it rests on.

When you change an API route, protocol message, config field or file layout, update
ARCHITECTURE.md in the same change. It is the spec.

## Commands

```sh
pnpm install
pnpm build          # tsc -b over the root tsconfig.json project references
pnpm test           # builds, then node --test over packages/*/dist and plugins/*/dist (~200 tests, ~20 s)
pnpm e2e            # builds, then scripts/e2e.mjs
```

Tests run from compiled `dist/`, so build first. To run one file or one test:

```sh
pnpm build && node --test packages/host/dist/rcon.test.js
node --test --test-name-pattern="nextMap" plugins/map-rotation/dist/rotation.test.js
```

`scripts/e2e.mjs` runs a real master, a real host supervising the fake game, a registry publish and
a browser join with content sync, all on 127.0.0.1 in a temp dir. CI runs `pnpm build`, `pnpm test`,
then `node scripts/e2e.mjs`. The protocol signing test cross-checks against real `minisign` only
when `MINISIGN_BIN` is set or `minisign` is on PATH; otherwise it is skipped.

There is no linter or formatter. Strict `tsc` (`tsconfig.base.json`: `noUncheckedIndexedAccess`,
`verbatimModuleSyntax`, …) is the check. Match the surrounding style: TypeScript uses 2 spaces and
single quotes; C# uses tabs with braces on the same line.

C#:

```sh
cd modes/bhop
dotnet test tests/OpenCitadel.Bhop.Core.Tests                                       # what CI runs
dotnet test tests/OpenCitadel.Bhop.Core.Tests --filter "FullyQualifiedName~MovementTests"
dotnet build src/OpenCitadel.Bhop.Plugin -c Release -p:DeployToGame=true            # copies into the game's managed/plugins
```

The test project covers Core and Porter only. The bhop plugin and the bridge reference
`DeadworksManaged.Api.dll` from a Deadlock install with Deadworks (`DeadlockManagedDir`, by default
the Steam path, or `/mnt/c/...` under WSL). They don't build without one, which is why CI skips
them. `modes/bhop` has `TreatWarningsAsErrors` on.

Releases: `node scripts/release.mjs X.Y.Z && git push --follow-tags` bumps all six packages to one
version, and the tag triggers npm trusted publishing (`docs/RELEASING.md`). Don't hand-edit
published package versions.

## Architecture

Project references: `protocol`, `gamefiles` and `plugin-sdk` are leaves. `host` depends on all
three, `master` on `protocol`, and `client` on `protocol`, `gamefiles` and `master` (it serves the
master's `web/` app locally).

- **`protocol` is the shared contract.** It holds the wire types and the `v` validators that every
  network-facing input goes through, plus SteamID/semver helpers, the `.tar.gz` package format,
  the `plugin.json` schema, minisign-compatible Ed25519 signing, A2S and zstd stored frames. A
  wire change here ripples into master, host and client.
- **Host core** (`packages/host/src`):
  - `supervisor.ts` is the orchestrator. It launches the game (`launch.ts` builds the command line
    plus a generated cfg, so secrets stay off the process list), follows console output
    (`parsers.ts`, `logtail.ts`), polls RCON (`rcon.ts`), accepts the bridge (`bridge.ts`),
    heartbeats the master (`heartbeat.ts`), and handles crash, daily and post-match restarts and
    map changes.
  - Three event sources, bridge > RCON > log, are merged by `eventbus.ts` so each real event fires
    once.
  - `services.ts` (`HostServices`) is the only seam between the core and the plugin runtime.
- **Plugin runtime** (`host/src/plugins/`): `runtime.ts` loads enabled host plugins in dependency
  order, each with a permission-checked `PluginContext`. By default every plugin runs in its own
  QuickJS/WASM worker:
  - `sandbox.ts` is the main-thread controller.
  - `sandbox-worker.ts` and `sandbox-core.ts` hold the interpreter.
  - `sandbox-prelude.ts` is the guest-side context.
  - Synchronous context calls cross threads with `Atomics.wait`.

  A new context capability touches the SDK types (`plugin-sdk`), `runtime.ts`, the prelude and the
  sandbox's host-side handler, plus a `Permission` if it is gated. Install, trust pinning,
  lockfiles, packing and registry access live in the same folder. `pkg-cli.ts` (`citadel-pkg`)
  reuses them for Deadworks operators who don't run `citadel-host`.
- **Master** (`packages/master/src`):
  - `app.ts` holds the routes and `store.ts` the SQLite storage (`node:sqlite`).
  - `registry.ts`, `trust.ts` and `oidc.ts` cover the registry, signatures and GitHub trusted
    publishing; `compat.ts` serves the Deadworks-compatible `/api/servers/*`.
  - `web/` is a dependency-free SPA served at `/`. `citadel-browser ui` reuses it in "local mode",
    adding `/local/*` routes from `client/src/ui.ts`.
- **Bridge** (`bridge/deadworks/BridgePlugin.cs`): newline-delimited JSON over 127.0.0.1 TCP to the
  host. Other Deadworks plugins publish events to host plugins with `dw_ocemit <name> <base64 json>`.
  A mode that draws its own maps names the real map with `dw_ocmap`.
- **Bhop mode** (`modes/bhop`):
  - `Core` is game-independent (movement, collision, map format, triggers, timer, VPK) and is where
    the tests are.
  - `Plugin` compiles Core's source files into its own assembly, because Deadworks loads every DLL
    in `plugins/` as a plugin. Don't replace that with a ProjectReference.
  - `Porter` is the `citadel-port` CLI.
  - The showcase runs through every layer:
    1. `map-rotation` calls `ctx.server.changeMap`.
    2. With `game.mapChange: "command"`, the host runs `dw_bhopmap {map}`.
    3. The bhop plugin redraws the course and calls `dw_ocmap`.
    4. The bridge sends `map.changed {map, base}`, which reaches the host and the listing.
    5. Finished runs go out as `dw_ocemit bhop.run_finished` and reach `bhop-records`.

## Conventions

- ESM everywhere, with `.js` suffixes on relative imports and `import type` for type-only imports.
- No runtime npm dependencies, except `quickjs-emscripten` (pinned exactly) in the host. Use Node
  built-ins (`node:sqlite`, `node:http`, `node:zlib`, `fetch`, and `node:util` `parseArgs` for
  CLIs).
- Tests use `node:test` + `node:assert/strict` and sit next to the code as `*.test.ts`. They touch
  only loopback networking and temp dirs.
  - Host tests drive `host/src/testing/fake-game.ts`, a stand-in for `deadlock.exe -dedicated`
    that speaks RCON, A2S and the bridge and has hooks such as `_crash`, `_chat`, `_join` and
    `_endmatch`. They launch it via `game.wrapper: ["node", FAKE_GAME_SCRIPT]`, on top of the
    fake install from `testing/fake-install.ts`.
  - Plugin tests use a hand-rolled fake context (`plugins/*/src/*.test.ts`) or
    `host/src/plugins/testing.ts`.
- Secrets are `ock_` (account keys), `ocs_` (server tokens) and `ocp_` (15-minute OIDC publish
  tokens). They are stored only as hashes server-side, never logged, and written to files with
  mode 0600.
- Host log format: one line per event, `ISO-time LEVEL [component] message`.
- Deadlock has no official dedicated server, so much of the code encodes behaviour observed on live
  servers. The docs record each observation with its game build. Examples:
  - `say` text goes unquoted, with `//` broken up so it doesn't start a comment.
  - RCON replies can't be framed by the empty-packet terminator.
  - Stock `changelevel` exits with code 5, which is why the host restarts to change maps.
  - The per-frame stdin noise line is dropped.

  Check those notes before "fixing" such code. When you learn something new from the real game,
  record it with the build number and say whether it was observed or inferred.
- The host often runs under WSL driving Windows `deadlock.exe`/`deadworks.exe`. `winproc.ts`
  (stopping the Windows-side process) and `launch.ts` `forwardToWindows` (WSLENV) exist for that.
- The repo is public: keep real SteamIDs, player names and personal machine paths out of fixtures
  and docs.
