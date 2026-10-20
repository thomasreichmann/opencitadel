# Writing OpenCitadel plugins

OpenCitadel servers are extended with **packages**: one archive format, one manifest
(`plugin.json`), one registry, three kinds.

| Kind | Runs where | Written in | Good for |
|---|---|---|---|
| `host` | Inside `citadel-host`, next to the game process | JavaScript / TypeScript | Chat commands, map rotation, Discord relays, listings, schedules, admin tools, anything that reacts to server events and runs console commands |
| `deadworks` | Inside the game server process, through [Deadworks](https://github.com/Deadworks-net/deadworks) | C# (.NET 10) | Gameplay: heroes, damage, entities, items, UI panels, net messages |
| `content` | Mounted by the game (server and players) | Compiled VPKs | Custom maps, VData changes, models, sounds |

A host plugin can't see a hero's health. A Deadworks plugin can, but it is tied to Deadworks'
hooks and to whatever game build Deadworks supports. Many features need both: the
**OpenCitadel bridge** (`bridge/deadworks`) is a Deadworks plugin that streams in-game events
(players with SteamIDs, chat, map changes, named game events) to the host and runs the host's
requests (`say`, `tell`, `kick`, `command`). So when the bridge is installed, host plugins get
authoritative events without writing any C#.

## Quickstart

```sh
citadel-host plugin new my-plugin          # host plugin (default); --kind deadworks|content
cd my-plugin
npm install && npm run build               # compiles src/ to dist/
citadel-host plugin pack .                 # → my-plugin-0.1.0.tgz
cd ../my-server
citadel-host plugin install ../my-plugin/my-plugin-0.1.0.tgz
citadel-host start                         # or type `reload` in a running host's console
```

`src/index.ts`:

```ts
import { definePlugin } from '@opencitadel/plugin-sdk';

interface Config {
  greeting: string;
}

export default definePlugin<Config>({
  setup(ctx) {
    ctx.on('player.connected', ({ player }) => {
      void ctx.server.tell(player, `${ctx.config.greeting}, ${player.name}!`);
    });

    ctx.commands.register('hello', {
      description: 'Say hello back',
      handler: (cmd) => cmd.reply(`${ctx.config.greeting}, ${cmd.player?.name ?? 'console'}!`),
    });

    return () => ctx.log.info('unloading'); // optional cleanup
  },
});
```

For quick iteration you can skip packing: copy (or symlink) your plugin folder to
`<server>/.opencitadel/plugins/<id>/`, add `"<id>": {}` under `plugins` in `server.json`, and
type `reload <id>` in the host console. `citadel-host plugin list` shows it as a "local copy".

Three complete examples live in [`plugins/`](../plugins): `welcome` (greetings, `!rules`,
`!discord`), `map-rotation` (empty-server and scheduled rotation, `!rtv` votes, admin `!map`),
and `discord-webhook` (batched, rate-limited Discord notifications).

## plugin.json

```jsonc
{
  "id": "map-rotation",              // 3-48 chars: a-z 0-9 -. Unique on the registry; the first publisher owns it.
  "name": "Map Rotation",
  "version": "0.1.0",                // semver
  "kind": "host",                    // host | deadworks | content
  "description": "…",
  "author": "…", "license": "MIT", "homepage": "https://…",
  "repository": "https://github.com/…",   // shown on the registry so reviewers can compare package and source
  "tags": ["maps", "voting"],        // registry search
  "main": "dist/index.js",           // host: ES module entry point
  "assemblies": ["bin/Release/net10.0/MyPlugin.dll"],          // deadworks
  "content": [{ "file": "maps/arena.vpk", "client": true }],  // content
  "maps": ["arena"],                 // content: map names this package adds
  "engines": { "opencitadel": "^0.1.0", "deadworks": ">=0.6" },
  "dependencies": { "other-plugin": "^1.2.0" },
  "permissions": ["server.command", "server.chat"],
  "config": {
    "maps": { "type": "string[]", "default": ["dl_midtown"], "description": "…" },
    "webhookUrl": { "type": "string", "default": "", "secret": true }
  }
}
```

* **Version ranges** support `*`, exact versions, `^1.2.0`, `~1.2.0`, comparators
  (`>=1.0.0 <2.0.0`) and `||`.
* **`engines.opencitadel`** is checked against the running `citadel-host`; a mismatch keeps the
  plugin from loading. Other engine keys are informational.
* **`dependencies`** are installed automatically by `plugin install` and loaded first. A
  missing, disabled or mismatched dependency (or a cycle) stops the dependent from loading
  with a clear error; it never takes down the host.
* **`config`** declares settings with a type (`string`, `number`, `integer`, `boolean`,
  `string[]`, `object`), a default and a description. Admins set values in `server.json`:

  ```json
  "plugins": { "map-rotation": { "enabled": true, "config": { "maps": ["dl_midtown", "dl_hideout"] } } }
  ```

  The plugin receives `ctx.config` with defaults filled in; a value of the wrong type stops the
  plugin from loading. Mark credentials `"secret": true`. Secret values belong in `server.json`
  (mode 0600) and never in the listing.

## Permissions and the sandbox

| Permission | Unlocks |
|---|---|
| `server.command` | `ctx.server.command()`, `ctx.server.changeMap()` |
| `server.chat` | `ctx.server.say()`, `ctx.server.tell()` |
| `players.manage` | `ctx.server.kick()` |
| `listing.write` | `ctx.listing.*` |
| `network` | `ctx.fetch()` |
| `storage` | `ctx.storage.*` |

Calling a gated method without its permission throws `PermissionError` straight away. `plugin
install` prints the permissions before enabling a plugin, and `plugin info` shows them before
you install.

Each kind carries a trust label, printed by `plugin install` and shown on the registry:
* **Host plugins** run sandboxed (below).
* **Deadworks plugins** have full trust, because they run inside the game server process.
* **Content packages** are files only.

Publisher signatures ([below](#signing-and-trust)) tell you *who* published a package. The
sandbox limits what a host plugin can *do*.

### The sandbox

Every host plugin runs in its own [QuickJS](https://bellard.org/quickjs/) interpreter, compiled
to WebAssembly ([quickjs-emscripten](https://github.com/justjake/quickjs-emscripten)).

**What a plugin can and can't touch:**
* There is no `require`, `process`, `Buffer`, filesystem, `child_process`, raw sockets or global
  `fetch`.
* It has standard JavaScript, `console` (routed to `ctx.log`), `setTimeout`/`setInterval`
  (tracked like `ctx.timers`), and the context.
* It can import its own package's files and `@opencitadel/plugin-sdk`. Anything else must be
  bundled in.

**How permissions are enforced:** each context call crosses the sandbox boundary as JSON into
the host, which checks the permission before acting. Permissions are a real boundary, not a
promise.

**How `ctx.fetch` is restricted:**
* Only `http` and `https` URLs.
* A 15-second timeout.
* Text bodies of up to 1 MiB.
* No loopback, private or link-local addresses. This is checked again on every redirect, so a
  plugin can't reach your LAN or the host's RCON port. To allow it for one plugin, set
  `"allowPrivateNetwork": true` under `plugins.<id>` in `server.json`.

**Limits per plugin**, set under `plugins.<id>` in `server.json`:

| Setting | Default | Meaning |
|---|---|---|
| `memoryMb` | 64 | Heap cap. Hitting it throws inside the plugin. |
| `timeLimitMs` | 1000 | CPU time per call into the plugin: an event handler, timer, command, or the work an awaited reply wakes up. Overrunning interrupts the call. |
| `sandbox` | `true` | `false` runs the plugin as a normal Node.js module with **full access** to the machine. The host logs a warning on every load. Use it only for plugins you wrote or fully trust. |

**Each plugin has its own worker thread.** A plugin that spins or thrashes slows only itself.
RCON, heartbeats, the bridge and every other plugin keep running.
* QuickJS enforces the CPU limit between instructions.
* For time spent inside native builtins or garbage collection, which QuickJS can't interrupt,
  a watchdog pings each worker. It terminates any worker that stays quiet for more than 2
  seconds past its CPU limit.

**When a plugin is shut off:** if it hits its CPU or memory limit three times, or its worker has
to be terminated, it is unloaded. The reason is logged and appears in the host's plugin status;
`reload <id>` brings it back. Every call into plugin code is also wrapped, so a throwing or
rejecting handler is logged and the server and other plugins carry on.

**Cost:** each sandboxed plugin costs about 14 MB of memory and 50 ms to load (the first one
about 30 MB, because it loads the shared code). Context calls cross threads in microseconds.
Synchronous ones (like `ctx.server.state` or `ctx.storage.get`) use a shared-memory handshake,
so they stay synchronous inside the plugin.

## Events

`ctx.on(event, handler)` returns a `Disposable`. Handlers can be async. Events come from three
sources, and each event is delivered once even if several sources see it:

| Event | Payload | Comes from |
|---|---|---|
| `server.starting` | `{ attempt }` | host |
| `server.ready` | `{ map, steamId? }` | console log / bridge |
| `server.stopped` | `{ code, crashed }` | host |
| `map.changed` | `{ map, previous? }` | console log / RCON `status` / bridge |
| `match.ended` | `{ map }` | console log (`ChangeGameState: PostGame`) |
| `player.connected` | `{ player }` | RCON `status` diff / bridge |
| `player.disconnected` | `{ player, reason? }` | RCON `status` diff / bridge |
| `chat.message` | `{ player, message, teamOnly }` | bridge, or a server that logs chat |
| `console.line` | `{ line }` | console log |
| `game.event` | `{ name, data }` | bridge only |
| `tick` | `{ now }` | host, about once a second while running |

`ctx.server.state.sources` tells you which sources are live: `{ rcon, log, bridge }`. Without
the bridge, players are known by name and slot from `status`, and by SteamID only when they came
in over Steam Datagram Relay (their `status` row shows it in place of an address). Chat, and so
chat commands, depends on what the server logs. Plugins should degrade gracefully. For example,
`welcome` still greets without SteamIDs.

After `match.ended` the host starts a fresh server (unless the admin turned
`restart.afterMatch` off). Calling `ctx.server.changeMap()` from the handler picks the map it
starts on, which is how `map-rotation` rotates after each match.

Prefer `tick`'s `now` over `Date.now()` for time-based logic. It makes plugins trivially
testable (see `plugins/map-rotation`).

## The context

```ts
ctx.id, ctx.version, ctx.config, ctx.dataDir, ctx.log   // log.debug/info/warn/error
ctx.on(event, handler) → Disposable

ctx.server.state                  // phase, map, steamId, address, hostname, players[], maxPlayers, sources, startedAt
ctx.server.command('status')      // → output; via the bridge when connected, else RCON
ctx.server.say('Hello all')
ctx.server.tell(player, 'Hi')     // private via the bridge, else falls back to say
ctx.server.kick(player, 'reason')
ctx.server.changeMap('dl_hideout') // restarts the server on that map by default (game.mapChange)
ctx.server.findPlayer('#3' | '[U:1:123]' | '7656…' | 'ann')   // slot, SteamID, exact or unique name prefix

ctx.commands.register(name, { description, access: 'everyone' | 'admin', aliases, handler })
ctx.listing.setTags(['casual']); ctx.listing.setGameMode('Arena'); ctx.listing.setMetadata('nextMap', 'dl_hideout')
ctx.storage.get(key) / set(key, value) / delete(key) / keys()
ctx.timers.setTimeout(fn, ms) / setInterval(fn, ms) → Disposable
ctx.plugins.expose(api); ctx.plugins.get<Api>('other-plugin')   // methods are async across plugins
ctx.fetch(url, init)              // http(s), string bodies, public addresses only (see the sandbox)
```

Everything a plugin registers (handlers, timers, commands, its exposed API) is torn down
automatically when it unloads, after its cleanup function runs. Storage is flushed at the same
time.

### Chat commands

Players type `!name args` or `/name args`. Arguments split on whitespace, with `"double"` or
`'single'` quotes grouping words, so `!kick "Some Player" afk` gives `args = ['Some Player', 'afk']`
and `raw = '"Some Player" afk'`. `access: 'admin'` commands are refused, before your handler
runs, for anyone whose SteamID is not in `server.json` `admins`. Admins can also type commands
into the `citadel-host` console. `!help` is built in: it lists the commands available to the
caller, and `!help <command>` shows a description. If two plugins claim the same name, the
first to load keeps it and the second gets a warning. `cmd.reply()` answers privately when
possible.

### Listing contributions

Each plugin's tags, game mode and metadata are merged into the server's browser listing on the
next heartbeat. Tags are unioned (max 16), the most recent `setGameMode` wins (clearing yours
falls back to another plugin's), and metadata is capped at 32 keys host-wide.

### Storage and data

`ctx.storage` is a small JSON key/value store in `<server>/.opencitadel/data/<id>/storage.json`.
Values are copied in and out (JSON round-trip), and writes are debounced and atomic. Storage
survives upgrades and `plugin remove`. `ctx.dataDir` names the plugin's data folder, but only
unsandboxed plugins can write files there.

### Cross-plugin APIs

```ts
// stats-core
ctx.plugins.expose({ kills: (steamId: string) => table.get(steamId) ?? 0 });

// stats-hud, with "dependencies": { "stats-core": "^1.0.0" }
const stats = ctx.plugins.get<{ kills(id: string): number }>('stats-core');
const n = await stats?.kills(player.steamId!);   // Remote<T>: every method returns a promise
```

Each plugin lives in its own sandbox, so cross-plugin calls are asynchronous and their arguments
and results travel as JSON: no functions, class instances or circular objects. Declare the
dependency, so the provider loads first and `reload stats-core` also reloads you.

### Reloading

`reload [id]` in the host console re-reads `server.json` and reloads the plugin (plus its
dependents) in a fresh sandbox, so every module is read again. (Unsandboxed plugins re-import
only their entry module; Node caches the modules it imports.)

### Testing

Plugins are plain objects with a `setup(ctx)` function, so a hand-rolled fake context is
enough. The examples' `*.test.ts` files show the pattern: record `on()` handlers, call them
with payloads, and assert on what the plugin said or stored.

## Packaging, publishing, versions

```sh
citadel-host plugin pack .                         # reproducible .tgz (same input → same bytes)
citadel-host plugin publish . --api-key ock_…      # signed when you have a key (see below); --master <url>
citadel-host plugin search rotation
citadel-host plugin info map-rotation
citadel-host plugin install map-rotation@^0.1.0
```

What goes into the archive:

* always `plugin.json`, plus `README.md`, `LICENSE` and `CHANGELOG.md` if present;
* **host**: the directory holding `main` (e.g. all of `dist/`), minus `*.test.js`, source maps,
  `.d.ts` files, dotfiles and `node_modules`. If `main` sits at the root, only that file.
  Bundle runtime dependencies into your output (there is no `npm install` step on the
  server). `@opencitadel/plugin-sdk` is the exception: the host provides it;
* **deadworks**: exactly the files in `assemblies`;
* **content**: exactly the files in `content` (each must be a real VPK).

Symlinks are refused. Archives are ordinary `.tar.gz` (inspect with `tar -tzf`). The installer
accepts only regular files with safe relative paths, and checks the archive's SHA-256 against
the registry before unpacking.

Published versions are immutable. To fix a release, publish a new version. To pull a broken
one, **yank** it (`POST /v1/plugins/<id>/<version>/yank` as the owner). Yanked versions are
skipped by `latest` and range resolution but stay installable by exact version, so servers
pinned to them keep working.

## Signing and trust

A checksum proves a download matches what the registry holds. A signature proves *you*
published it, so a stolen account key or a compromised registry can't slip a different package
onto servers that already trust you. Signatures are minisign-compatible.

### Signing your packages

```sh
citadel-host plugin keygen                              # ~/.opencitadel/signing/<KEYID>.key (0600) + .pub
citadel-host plugin key register --api-key ock_…        # tell your registry account about the public key
citadel-host plugin publish . --api-key ock_…           # signs automatically
```

* **Passphrase.** Set `OPENCITADEL_SIGNING_PASSPHRASE` when you run `keygen` to encrypt the
  secret key. Set it again whenever you sign or publish.
* **Which key is used.** `--key <file>`, then `OPENCITADEL_SIGNING_KEY`, then the only `.key`
  file in `~/.opencitadel/signing/` (`OPENCITADEL_HOME` moves that directory). With several
  keys and no choice made, publishing stops rather than guessing. `OPENCITADEL_SIGNING_KEY` holds
  either a path or, for CI secrets, the key file's contents (its JSON).
* **Publishing unsigned.** `--no-sign` publishes without a signature.
* **Out-of-band signatures.** `plugin sign pkg.tgz` writes `pkg.tgz.minisig`, for packages you
  hand out yourself.

Back up the secret key. Publish your public key (the `RWQ…` line) somewhere you control too,
such as the plugin's README or repository, so operators can check it independently of the
registry.

The registry rejects a signature it can't verify against your registered keys. A registry run
with `OPENCITADEL_REQUIRE_SIGNATURES=1` rejects unsigned uploads too.

### How servers verify

On every install and update, `citadel-host` (and `citadel-pkg`) does the following:

1. Downloads the version's `.minisig`.
2. Fetches the publisher's keys from `/v1/publishers/<name>`.
3. Verifies the archive.

The result is printed next to the package's trust label:

```
Installed map-rotation@0.2.0 (host)
  signed by EF2804DE8EA66621 (pinned on first use)
  Runs in a WebAssembly sandbox inside citadel-host: no file, process or network access beyond the permissions it declares.
```

* **Trust on first use.** The first signed install pins the plugin to that key in
  `.opencitadel/trust.json`. The pin stores the full public key, not just its 16-digit id.
  Key ids are random labels anyone can copy, so later updates are verified against the pinned
  key whatever the registry says.
* **Key changes are refused.** An update signed by a different key stops with an explanation.
  Confirm the rotation with the author out of band, then rerun with `--accept-new-key`, which
  re-pins to the new key only.
* **Signed, then unsigned, is refused.** A plugin that was signed and arrives unsigned is
  refused unless you pass `--allow-unsigned`. The pin is kept for the next signed version.
* **Revoked keys are refused.** A signature by a key the publisher revoked on the registry is
  refused.
* **Unsigned packages** install with a warning. To refuse them, set
  `"security": { "requireSignatures": true }` in `server.json`.
* **Pre-approved keys.** `"security": { "trustedKeys": { "map-rotation": ["EF2804DE8EA66621"], "*": ["…"] } }`
  allows exactly those keys, per plugin or for every plugin. This replaces trust on first use
  for those plugins.
* **Local packages.** A local `.tgz` is verified against a sibling `.minisig` when there is one,
  using `--key-file <pub>`, a pinned or configured key, or the publisher's keys on the
  registry.

Dependencies go through the same checks, and nothing is installed unless all of them pass.

### Rotating a key

1. Generate and register the new key.
2. Publish with it.
3. Announce the change where your users will see it, with both key ids.
4. Revoke the old key: `DELETE /v1/accounts/me/signing-keys/<keyId>`.

Servers pinned to the old key need `--accept-new-key` once. That is deliberate: a silent key
change is exactly what an attacker would attempt.

### Verifying without OpenCitadel

```sh
curl -O https://registry.example/v1/plugins/map-rotation/0.2.0/package
curl -o package.minisig https://registry.example/v1/plugins/map-rotation/0.2.0/package.minisig
minisign -Vm package -P RWQ…the-author's-public-key…
```

## Publishing from CI (trusted publishing)

Release from GitHub Actions without storing a registry API key anywhere:

1. The job asks GitHub for an OIDC identity token addressed to the registry.
2. The registry checks that token and confirms the repository and workflow are ones you linked
   to the plugin.
3. It hands back a publish token that works for 15 minutes and only for that plugin.
4. The package is still signed with your key, and the registry records which commit and
   workflow run built each version.

### One-time setup

1. **Signing key.** Create one with a passphrase, register it, and keep a backup:

   ```sh
   OPENCITADEL_SIGNING_PASSPHRASE=… citadel-host plugin keygen
   citadel-host plugin key register --api-key ock_…
   ```

2. **Repository secrets and variable** (Settings → Secrets and variables → Actions):
   * `OPENCITADEL_SIGNING_KEY`: the contents of the `.key` file;
   * `OPENCITADEL_SIGNING_PASSPHRASE`: its passphrase;
   * the variable `OPENCITADEL_MASTER`: your registry's URL.

3. **A `release` environment** (Settings → Environments). Add required reviewers so a release
   needs a human click, and make the signing secrets environment secrets so only that job can
   read them.

4. **Link the workflow to the plugin:**

   ```sh
   citadel-host plugin trusted-publisher add my-plugin \
     --repo you/my-plugin --workflow release.yml --environment release --api-key ock_…
   ```

   `--ref 'refs/tags/v*'` additionally limits publishing to version tags. You can link a plugin
   id before its first release; that reserves it for your account.

5. **Optional: CI only.** `citadel-host plugin trusted-publisher require my-plugin` (or `--require`
   on `add`) makes the registry refuse new versions published with an account key. A leaked
   `ock_` key then can't push a release of this plugin. `--off` undoes it.

`trusted-publisher list <id>` and `trusted-publisher remove <id> <publisher-id>` manage the links.

### The workflow

`citadel-host plugin new` writes `.github/workflows/release.yml`. The publishing job looks like this:

```yaml
on:
  push:
    tags: ['v*']
jobs:
  publish:
    runs-on: ubuntu-latest
    environment: release
    permissions:
      contents: read
      id-token: write          # lets the job request its OIDC token
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - uses: actions/setup-node@v7
        with:
          node-version: 22
      - run: npm install
      - run: npm run build --if-present
      - run: npx --yes --package=@opencitadel/host@0.1 citadel-host plugin publish . --oidc
        env:
          OPENCITADEL_MASTER: ${{ vars.OPENCITADEL_MASTER }}
          OPENCITADEL_SIGNING_KEY: ${{ secrets.OPENCITADEL_SIGNING_KEY }}
          OPENCITADEL_SIGNING_PASSPHRASE: ${{ secrets.OPENCITADEL_SIGNING_PASSPHRASE }}
```

Inside GitHub Actions, `plugin publish` uses trusted publishing by default when no API key is
set; `--oidc` makes it explicit. It reads the audience from the registry's `/v1/registry`,
requests the token, exchanges it, and publishes. If anything doesn't line up, the error says
what: missing `id-token: write`, a registry without trusted publishing, the registry's reason
for rejecting the token, or a package this workflow isn't linked to. Tokens are never printed.

### What the registry checks

* The token is signed by GitHub (its published keys) and addressed to this registry.
* It hasn't expired.
* The repository and workflow file match a trusted publisher you added.
* The environment and ref also match, if you set them.
* The first successful publish pins GitHub's numeric repository id. Someone who later
  re-creates a deleted repository under the same name can't publish as you.

### Provenance

Each version published this way records where it was built: repository, commit, workflow file,
ref, environment and a link to the workflow run. The registry's plugin page shows it, and
`citadel-host plugin info` prints it per version. Installed packages carry it too: the BUILT BY
column in `plugin list`.

Provenance is the registry's statement, made after it verified GitHub's token. Your signature
is the statement servers verify on their own. Together they say who published a release and
which source produced it.

### Why not an API key in CI?

An `ock_` key is long-lived and can publish any of your plugins from anywhere. A key in CI
secrets leaks through a malicious dependency, a compromised action, or a debug log, and keeps
working until you notice. Trusted publishing tokens:
* last 15 minutes;
* work only from your repository's workflow;
* cover only the plugins linked to it;
* can be gated behind environment reviewers.

With `require` set, even a stolen account key can't publish a release.

## Advisories

Publishers (and registry admins) post advisories for affected version ranges:
`POST /v1/plugins/<id>/advisories` with `{severity, title, description, affected: "<1.4.2", fixedIn: "1.4.2", url}`.

```sh
citadel-host plugin audit          # lists affected installed packages; exits 1 for high or critical
```

`citadel-host start` runs the same check in the background and logs a warning (an error for
high or critical) for each affected package. Withdrawn advisories are ignored.

## Lockfiles

```sh
citadel-host plugin lock           # writes plugins.lock.json: id, version, sha256, registry, signing key
citadel-host plugin sync           # on another server: install exactly that set
```

`sync` does the following:

1. Downloads and verifies everything first, and only then changes the server.
2. Removes installed packages the lockfile doesn't list.
3. Stops on any mismatch: a different archive checksum, a different signing key, or a
   dependency the lockfile doesn't satisfy.

The lockfile carries each signer's public key, so a fresh server pins the reviewed key rather
than whatever the registry offers. Commit `plugins.lock.json` next to your server configs to
roll the same reviewed set out to every server. `--lockfile <file>` reads or writes another
path.

## Deadworks plugins

`citadel-host plugin new my-dw --kind deadworks` scaffolds a C# project against
`DeadworksManaged.Api` (`DeadworksPluginBase`, `[Command]`, `OnLoad`, etc.; see the
[Deadworks docs](https://docs.deadworks.net/)). Build with the .NET 10 SDK and list the
outputs under `assemblies`. `plugin install` copies them into
`game/bin/win64/managed/plugins/`, where Deadworks hot-loads them, and records them so
`plugin remove` deletes exactly those files. Set `game.executable` to `deadworks` in
`server.json` for the host to launch `deadworks.exe`.

## Content packages

Maps go under `maps/<name>.vpk` (and in `maps`). They install to `game/citadel/maps/<name>.vpk`,
and a server can run them with `game.map` or `!map <name>`. Other VPKs (VData, models, sounds) install as
`game/citadel/opencitadel_server/pakNN_dir.vpk`, the community addon naming. The installer mounts
that directory in `gameinfo.gi` (the host keeps it mounted across game updates). It is separate
from `game/citadel/opencitadel/`, where `citadel-browser` puts a player's downloaded content. Nothing
already on disk is overwritten: an existing map or addon that OpenCitadel did not install
makes the install fail instead.

Files marked `"client": true` are advertised in the server's listing with their size, SHA-256
and a download URL on the registry (`/v1/plugins/<id>/<version>/files/<path>`).
`citadel-browser` downloads, verifies and installs them before a player joins. Only content
installed *from a registry* is advertised, since a local `.tgz` has no public URL. A client
file modified on the server after install is left out of the listing, because players would
receive the registry's copy, not yours.

## citadel-pkg for Deadworks servers

Servers that run Deadworks on their own, without `citadel-host`, can still use the registry:

```sh
citadel-pkg --game "C:\Program Files (x86)\Steam\steamapps\common\Deadlock" --registry https://registry.example search
citadel-pkg install deathmatch         # Deadworks plugin → game/bin/win64/managed/plugins/
citadel-pkg install arena-map          # maps → game/citadel/maps/, addons → game/citadel/opencitadel_server/
citadel-pkg list
citadel-pkg audit
citadel-pkg lock && citadel-pkg sync
citadel-pkg remove deathmatch
```

* **Finding the game.** `--game` defaults to the auto-detected install (or `DEADLOCK_PATH`).
* **Choosing the registry.** `--registry` defaults to `OPENCITADEL_MASTER`, then to the
  registry remembered from the first run.
* **State.** Everything lives in `game/bin/win64/configs/opencitadel/`, next to Deadworks' own
  configs: `installed.json`, `trust.json`, `cache/`, `plugins.lock.json` and `config.json`.
  `config.json` holds the registry URL and a `security` block with the same `requireSignatures`
  and `trustedKeys` settings as `server.json`.
* **Same checks as citadel-host.** Signatures, pinning, advisories and lockfiles all work as
  described above.
* **No host plugins.** These run inside `citadel-host`, so `citadel-pkg` refuses them, along
  with the authoring commands (`new`, `pack`, `keygen`, `sign`, `publish`). Use
  `citadel-host plugin` for those; it works from any directory with a `server.json`.

Deadworks loads new assemblies from `managed/plugins/` without a restart. New maps and addons
need a server restart, because search paths are read at startup.
