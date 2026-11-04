# OpenCitadel.Bridge (Deadworks plugin)

Connects a Deadlock server running [Deadworks](https://github.com/Deadworks-net/deadworks) to
`citadel-host`, so host plugins get authoritative in-game events and can act inside the game:

| From the game (events) | From the host (requests) |
|---|---|
| `server.ready`, `map.changed` (`OnStartupServer`) | `command` — runs a server console command and returns what it printed (`Server.ExecuteCommand` with output capture) |
| `player.connected` (`OnClientFullConnect`, not map-change reloads) | `say` — `Chat.PrintToChatAll` |
| `player.disconnected` (`OnClientDisconnecting`, not map changes) | `tell` — `Chat.PrintToChat(slot, …)` |
| `chat.message` (`OnChatMessage`; never blocks the message) | `kick` — `Server.Kick(slot, reason)` |
| `game.event` `player_death` (`[GameEventHandler]`) | `players` — every connected controller |
| `game.event` from other plugins (`ocemit`, below) | |

### Events from other Deadworks plugins

Any plugin on the server can publish an event to host plugins without referencing the bridge:

```csharp
var json = JsonSerializer.Serialize(new { map = "bhop_eazy", time = 83.4 });
Server.ExecuteCommand($"dw_ocemit bhop.run_finished {Convert.ToBase64String(Encoding.UTF8.GetBytes(json))}");
```

Host plugins receive it as `game.event` `{ name: "bhop.run_finished", data: { ... } }`. The
payload must be a JSON object of at most 16 KiB, base64-encoded so the console doesn't split it;
event names are letters, digits, `.`, `_` and `-`. The command is server-only, so players can't
forge events. The bhop mode reports finished runs this way to `plugins/bhop-records`.

### Maps a game mode draws itself

A mode that runs maps of its own on top of a Deadlock map (the bhop mode draws courses into a
stock map, so players need nothing installed) tells the host which map players are really on:

```csharp
Server.ExecuteCommand("dw_ocmap bhop_eazy"); // "dw_ocmap off" to go back to the Deadlock map's name
```

The bridge sends `map.changed` `{ map: "bhop_eazy", base: "<Deadlock map>" }` and names it in its
hello after a reconnect. `citadel-host` then reports that map to plugins and listings, and ignores
the engine naming the base map again (RCON `status`, the log) until the Deadlock map itself
changes, which clears it. Server-only, like `ocemit`.

### Chat commands: Deadworks goes first

Deadworks runs its own plugins' chat commands (`/name` or `!name`) before any plugin's
`OnChatMessage`. When one of them handles a message, it never reaches the bridge, so host
plugins don't see it. A host plugin command therefore only works under a name no Deadworks
plugin registers. For example, `!map` belongs to Deadworks' AdminPlugin when that is installed,
so `map-rotation`'s `!map` never fires there; `!rtv`, `!nextmap` and `bhop-records`' `!wr` and
`!pb` don't collide and reach the host.

Players are sent as `{slot, name, steamId64, team, hero, bot}`. The wire format is the bridge
protocol in [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md#bridge-protocol-host--in-game-plugin).

## How it runs

`citadel-host` starts `deadworks.exe` with `OPENCITADEL_BRIDGE=127.0.0.1:<port>` and a fresh
`OPENCITADEL_BRIDGE_TOKEN` in the environment (set `"game": {"executable": "deadworks"}` and keep
`"bridge": {"enabled": true}` in `server.json`). The plugin connects, says hello with the token,
and reconnects every 5 seconds if the host restarts. Without those variables it does nothing, so
it is safe on a server started some other way.

Deadworks calls plugin hooks on the game thread. Network I/O runs on background tasks: outgoing
messages go through a bounded queue (the game thread never waits on the socket) and host requests
are moved back onto the game thread with `Timer.NextTick`.

## Build and install

Needs the .NET 10 SDK and a Deadlock install with Deadworks (which provides
`game/bin/win64/managed/DeadworksManaged.Api.dll`).

```
dotnet build -c Release
# Deadlock somewhere else:
dotnet build -c Release -p:DeadlockManagedDir="D:\SteamLibrary\steamapps\common\Deadlock\game\bin\win64\managed"
# Copy into managed\plugins after building:
dotnet build -c Release -p:DeployToGame=true
```

or copy `bin/Release/net10.0/OpenCitadel.Bridge.dll` into `game/bin/win64/managed/plugins/`.
Deadworks loads it without a restart.

## What has been verified

* It compiles with no warnings (`-warnaserror`) against `DeadworksManaged.Api` built from
  Deadworks source (commit `120af9b`, Deadworks `v0.6.1`) with the .NET 10.0.402 SDK.
* A harness that loads the compiled plugin outside the game, with Deadworks' timer service
  stubbed, completed the handshake with the real `citadel-host` bridge server. It delivered
  `map.changed` and `server.ready`, and returned an error response to an unknown request routed
  through `NextTick`.
* Inside a running server (Deadlock build 6842, Deadworks v0.6.3, `citadel-host` in WSL starting
  `deadworks.exe` on Windows, 2026-11-03): the plugin connected and stayed connected across a
  `changelevel`. The `command` request ran `changelevel` for `map-rotation` and `dw_ocemit`, and
  the event `ocemit` published reached `bhop-records` as `game.event`.
* Not yet exercised live: `say`, `tell`, `kick`, `players`, and the player and chat events (no
  player was connected during that test). Deadworks' API is pre-1.0 and may change.
