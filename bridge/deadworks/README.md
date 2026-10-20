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
* Not verified inside a running Deadlock server. Requests that call into the engine (`command`,
  `say`, `tell`, `kick`, `players`) and the event hooks have only been checked against the
  Deadworks API surface, not exercised live. Deadworks' API is pre-1.0 and may change.
