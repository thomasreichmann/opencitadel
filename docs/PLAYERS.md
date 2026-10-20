# Playing on community servers

`citadel-browser` finds community Deadlock servers, installs any custom content a server needs
(maps, mods), and launches Deadlock straight into the server. You can use it from your web
browser or from the terminal.

You don't need it just to look around: any OpenCitadel master serves a web server browser at
its root URL, and its **Join** button works without installing anything. The tool adds three
things the web page can't do alone: it downloads and installs required content, measures ping
from your machine, and keeps favourites and history.

## Install

You need [Node.js](https://nodejs.org/) 22.13 or newer and Deadlock installed through Steam.

```
git clone <this repository> opencitadel && cd opencitadel
pnpm install && pnpm build
pnpm browser --help            # or: node packages/client/dist/cli.js --help
```

Point it at a master server once, with whichever of these suits you:

```
export OPENCITADEL_MASTER=https://servers.example.org       # environment
citadel-browser list --master https://servers.example.org   # per command
```

Or set `"masterUrl"` in `~/.opencitadel/client.json`.

The tool finds Deadlock automatically in every Steam library, including from WSL. If it
picks the wrong one, set `DEADLOCK_PATH` to the folder that contains `game/`, set `"gamePath"`
in `client.json`, or pass `--game <path>`.

## The web browser: `citadel-browser ui`

```
citadel-browser ui
```

This opens the server browser at `http://127.0.0.1:47900/`. It's the master's page running in
local mode:

* **Join** installs the server's content and then launches Deadlock.
* The ping column is measured from your machine. Only servers that publish a direct address
  can be pinged.
* Favourites (★) are saved in `~/.opencitadel/client.json`.

Options: `--port <n>`, and `--no-open` to stop it opening a browser tab. The server only
listens on `127.0.0.1`, and it refuses requests from other websites.

## The terminal

```
citadel-browser list                         # online servers
citadel-browser list --region eu-west --not-full --no-password --ping
citadel-browser list --search arena --modded --sort name
citadel-browser info <id>                    # players, plugins, required content
citadel-browser join <id>                    # install content, launch, connect
citadel-browser join <id> --password secret
citadel-browser connect 203.0.113.5:27015    # a server that isn't listed
citadel-browser connect "[A:1:1234567:8901]"
citadel-browser favorites add <id>           # favorites | favorites remove <id>
citadel-browser history
citadel-browser content status               # what's installed for which server
citadel-browser content clear [--cache]      # remove it all again
```

Every listing command accepts `--json`. `list` filters: `--search`, `--region`, `--map`,
`--mode`, `--tags a,b`, `--not-full`, `--not-empty`, `--no-password`, `--modded`, `--vanilla`,
`--verified`, `--sort players|name|newest`, `--limit`.

In the list:

* **locked**: the server needs a password.
* **content**: you'll download files before joining.
* **modded**: the server runs plugins but needs nothing from you.
* **verified**: the master reached the server at its published address.

## How joining works

Servers can be reached two ways, and a listing may offer both:

* **SteamID** (`[A:1:…]`). The connection goes through Steam's relay network, so the host
  doesn't need to forward any ports. Most community servers work like this. The join uses
  `steam://run/1422450//+connect [A:1:…]/`, which starts Deadlock with a `connect` command.
  Steam asks you to confirm the launch options the first time.
* **Address** (`host:port`). A direct connection, used when the master has verified the
  address. The join uses `steam://connect/host:port`.

If Deadlock is already running, Steam won't pass the join on to the game. In that case the tool
shows the console command and copies it to your clipboard when it can. Then:

1. In Deadlock, open **Settings** and turn on **Dev command console**. You only do this once.
2. Press **F7** to open the console.
3. Paste and run the command, for example `connect [A:1:1234567:8901]`. Password-protected
   servers need `password "…"; connect …`.

`join --print` still installs the server's content, but it only prints the Steam URL and the
console command instead of launching.

## Custom content

Some servers run custom maps or mods that every player needs. They're listed under **Required
content** in `info`. On `join` the tool:

1. Downloads each file to `~/.opencitadel/cache/`, or reuses a copy it already downloaded.
2. Checks the exact size, the SHA-256 checksum the server published, and that the file really is
   a VPK. A file that fails any check is deleted and never installed.
3. Installs it:
   * Maps go to `Deadlock/game/citadel/maps/<name>.vpk`. It never replaces a map it didn't
     install itself, so stock maps and maps from other mod tools are safe. If a server's map
     clashes with one of those, the join stops and tells you which file is in the way.
   * Mods go to `Deadlock/game/citadel/opencitadel/` as `pak01_dir.vpk`, `pak02_dir.vpk`, … That
     folder always holds exactly the joined server's mods. Joining a different server swaps them,
     and joining a vanilla server removes them.
   * The first time, one line is added to `game/citadel/gameinfo.gi` so the game loads that
     folder. It's tagged `// opencitadel:added`, and a backup is saved as
     `gameinfo.gi.opencitadel.bak`. Steam updates can overwrite gameinfo.gi; the tool notices
     and adds the line back on your next join.

Deadlock only reads mod folders at startup. If the mods change while the game is running, the
tool installs them but doesn't launch. Quit Deadlock and join again.

Downloads are capped at 4 GiB per file and 16 GiB per server. Content URLs that point into
your own network (router pages, `localhost`) are refused, including through redirects. The one
exception is the master you configured, so a master on your LAN can still serve content.

### Undoing everything

```
citadel-browser content clear          # remove installed maps/mods and the gameinfo.gi line
citadel-browser content clear --cache  # …and delete the download cache too
```

`clear` removes only files the tool installed and still match what it installed. It also removes
only its own gameinfo.gi line. If you also host a server from the same install, the
dedicated-server edits stay in place. Steam's **Verify integrity of game files** restores
a stock gameinfo.gi as well.

## Troubleshooting

| Problem | What to do |
|---|---|
| `Cannot reach the master server` | Check the URL (`--master`, `OPENCITADEL_MASTER`, or `masterUrl` in client.json) and that the master is up. |
| `No Deadlock install found` | Pass `--game "C:\Program Files (x86)\Steam\steamapps\common\Deadlock"` (from WSL: `/mnt/c/...`) or set `DEADLOCK_PATH`. |
| Steam opened but nothing happened | Deadlock was probably already running. Use the F7 console command from the message. |
| `failed its checksum` / `not a VPK file` | The server's files don't match what it advertises. Tell the server owner. Nothing was installed. |
| `Refusing to replace maps/<name>.vpk` | A map with that name already exists and OpenCitadel didn't install it. Move it aside if you want to play that server. |
| Joined, but the custom content isn't there | Restart Deadlock. Mods load at startup. |
| `is full` / `is password protected` | `--force` tries anyway; `--password <pw>` supplies the password. |

## Privacy and safety

* The tool only contacts the master you configured and the content URLs listed by the server you
  join. Pings go directly to servers that publish an address.
* Server owners choose what content they list, and checksums only prove you got the files they
  intended. Only join servers whose custom content you trust, as you would with any game mod.
* Everything it writes stays in `~/.opencitadel/` and the Deadlock folder locations listed above.
