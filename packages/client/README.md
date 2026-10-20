# @opencitadel/client

`citadel-browser` finds and joins [Deadlock](https://store.steampowered.com/app/1422450/Deadlock/)
community servers from the terminal or a local web UI. Before joining, it downloads and verifies
any maps or mods a server needs, then launches the game into the server through Steam.

```sh
npm install -g @opencitadel/client
citadel-browser ui                 # local server browser with one-click join
citadel-browser list --ping
citadel-browser join <server-id>
```

Requires Node.js 22.13 or newer. See the [player guide](https://github.com/thomasreichmann/opencitadel/blob/main/docs/PLAYERS.md).
Not affiliated with Valve.
