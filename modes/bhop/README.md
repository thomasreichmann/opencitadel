# OpenCitadel Bhop

A Counter-Strike: Source bunny-hop mode for Deadlock, and the showcase for OpenCitadel's plugin
system. Classic CS:S bhop maps are ported from their original BSP files, and players move with
CS:S movement, simulated tick for tick: autobhop, air strafing, the 30 u/s air speed cap, ducking,
step-up, sliding along walls and ramps, the original collision brushes, teleports, boosters and
bhop blocks.

| Part | What it is |
|---|---|
| `src/OpenCitadel.Bhop.Core` | Game-independent library: CS:S player movement, Source 1 brush collision, the bhop map format, triggers, the run timer and records, VPK reading and writing. Unit-tested. |
| `src/OpenCitadel.Bhop.Plugin` | The [Deadworks](https://github.com/Deadworks-net/deadworks) plugin that runs the mode on a server. |
| `src/OpenCitadel.Bhop.Porter` | `citadel-port`: CS:S BSP → Hammer map → compiled Deadlock map package. |
| `native/` | `rclaunch.exe`, which runs Deadlock's map compiler, and a stub used while setting it up. |
| `../../plugins/bhop-records` | The `citadel-host` plugin for leaderboards, record announcements and Discord. |

## How players move

Deadlock's own movement is not CS:S movement: heroes are capsules, ground acceleration is
Deadlock's, jumping is an ability, and air drag, dashes, mantling and wall jumps all exist. So
the plugin offers two modes.

* **Exact (default).** For every usercmd, the plugin runs CS:S movement itself, against the map's
  original BSP brushes, then strips the movement out of the command so Deadlock's movement leaves
  the hero alone. The hero is put in noclip and given the velocity that makes the engine's own
  move land on the simulated position. Because `sv_noclipaccelerate` and `sv_noclipfriction` are
  replicated and set to 0, the client's prediction of a noclipping hero is the same straight-line
  motion, so movement stays smooth on screen. The result is CS:S physics exactly, as a timer
  server runs them.
* **Native.** Deadlock's own predicted movement, pushed toward CS:S with replicated convars
  (`sv_airaccelerate`, the air speed cap through `citadel_aircontrol_speed_*`, friction), with
  dashing, double jumps and wall riding off. It responds instantly but is only close to CS:S, and
  it can't autobhop: Deadlock has no client-predicted autobhop, so jumps must be timed, like
  bhoptimer's scroll style.

Defaults are CS:S's engine values plus a standard bhop server's settings (bhoptimer's "Normal"
style): `sv_accelerate 5`, `sv_airaccelerate 1000`, `sv_friction 4`, `sv_stopspeed 75`, gravity
800, 250 u/s run speed, a 32×32×62 hull (45 ducked), no stamina, and autobhop the way bhoptimer
does it (holding jump counts as a fresh press on landing, except on ladders and when swimming,
where holding jump pushes off the ladder or swims up). Ladders and water follow CGameMovement,
with CS:S's ladder damping. Deadlock servers tick
at 64 Hz; CS:S bhop servers usually ran 66 or 100, so speeds gained per strafe differ slightly
from a 100-tick server.

Things that were checked on a live server (build 6842, Deadworks 0.6.3):

* Clients send every usercmd twice, as a backup against packet loss, and Deadlock leaves the
  command number at 0; commands are deduplicated by their client tick.
* The jump key arrives as the mantle and zipline bits, not `IN_JUMP`.
* `sv_client_predict 0` does not stop client prediction, which is why exact mode works through
  noclip instead.
* Heroes spawn about 0.2 units inside the floor; the CS:S box is moved free first.

## Running a server

You need a Deadlock install with the Deadworks server (`game/bin/win64/deadworks.exe`).

### Zero-install: players need nothing but Deadlock

Deadlock has no way to send a client a map it doesn't have: a stock install mounts no addons, and
there is no Deadlock Workshop to download them from, so a client without the map's VPK drops with
`NETWORK_DISCONNECT_CLIENT_NO_MAP`. So the server can run its courses on a **stock map** every
install has (`new_player_basics`) and draw them with stock content. A player joins from the
server browser or with `connect`, with nothing installed, and plays.

* **The course** is the ported map's data: collision, triggers, zones, spawns, and its visible
  faces as flat coloured rectangles (each face takes its texture's average colour, shaded by the
  way it faces). It is moved clear of the stock map's own geometry (`CoursePlacement`), which the
  plugin measures with rays; right after the server starts that geometry isn't loaded yet, so the
  course waits for it (up to 20 seconds) rather than being drawn through the map.
* **Drawing.** Each rectangle is one or two `point_worldtext` entities: a row of full-block glyphs
  (█) in the panel's colour, scaled so its ink is exactly the panel's height, with a whole number
  of blocks along it (or two rows, one from each end, overlapping). Glyphs draw from both sides,
  so the plugin culls back faces per player: panels near a player's camera that face away from it
  aren't sent to them (Deadlock's third-person camera passes through drawn walls). Rows go out a
  few dozen per server frame.
* **Budget.** A player who joins is sent everything they can see in one update, which the engine
  builds in a fixed 1,280,000-byte buffer; past it the server drops them with
  `NETWORK_DISCONNECT_DELTAENTMSG_OVERFLOW` (what happened to the first players to join
  bhop_kz_ocean, whose drawn rows came to about 2.7 MB). So a course is drawn within
  `MaxPanelKilobytes` (640 KiB: each row's text, 3 bytes a block, plus an estimated 64 bytes) and
  `MaxPanelEntities` (8000), leaving the rest of the buffer to the stock map and the players. A
  course within both is drawn whole; a bigger one keeps its largest panels drawn (72–97% of the
  surface of the maps here) and streams the smaller ones within `DetailRadius` of players, never
  going over. `citadel-port course` prints what a course costs.
* **Slower PCs.** Every panel a client is sent costs it work. Players whose client was sent a
  thousand detail panels while still taking in its first update fell behind, were sent the whole
  update again, and timed out (every outside player who joined surf_utopia_njv on its first day).
  So details start `DetailDelaySeconds` (10) after a player joins or the course changes, and rows
  go out `PanelsPerFrame` (30) per server frame. A test client held to one CPU core went silent
  for 12 s while details streamed around it, and not while standing still.
* **Players who leave.** Deadlock keeps a departed player's controller and hero for a reconnect,
  where they left and under their name. Courses lie outside the stock map's play area, so the game
  then tries to kill that hero every tick (the mode blocks all damage) and logs "Player … was out
  of the play area" 64 times a second, for good; and each one adds to every later joiner's first
  update. The plugin removes a leaver's controller and hero as they leave (Deadworks'
  `RemoveWithPawns`; `citadel_kick_disconnected_players` doesn't reach them).
* **HUD.** Without the Deadworks client bootstrap the panorama HUD can't show, so the timer and
  speed float above the player's hero in world text that only they are sent. Deadworks' own UI
  talks to its client add-on in closed captions, which players without it see as garbled
  subtitles. Deadworks repeats its handshake every second until the add-on answers; a player who
  hasn't answered gets one every 4 seconds, 2 to 15 seconds after joining, and nothing after that
  (a stock client sees four brief flashes).

Set it up:

1. Port each map as a course (no compile, so no SDK needed):
   ```sh
   citadel-port course bhop_eazy.bsp --from bhop_eazy.vpk -o game/bin/win64/configs/BhopPlugin/maps
   ```
   `--from` takes the credits and zones of an earlier port; `--zones srcwr` fetches zones.
2. In `configs/BhopPlugin/BhopPlugin.jsonc`, `"Course": "bhop_eazy"`: the course the server
   starts with when it is on a map that isn't a ported one.
3. Start the server on a stock map, and let `citadel-host` switch courses in place:
   ```jsonc
   "game": { "executable": "deadworks", "map": "new_player_basics",
             "mapChange": "command", "mapCommand": "dw_bhopmap {map}" },
   "plugins": { "map-rotation": { "maps": ["bhop_eazy", "bhop_badges", "surf_utopia_njv"] } }
   ```
   With the OpenCitadel bridge, the host and listings name the course players are on
   (`dw_ocmap`); Steam's server browser still shows the stock map.

How it looks: flat colours rather than the original textures, slanted edges (ramp sides) drawn as
steps, and on the biggest maps the smallest details appear as you come near. Players who do have a
map's package can still be sent to it the old way (`mapChange: changelevel` to the real map).

Measured on build 6844: clients don't draw entities above about 16384 units (drawn at 15000, gone
at 20000), and clamp positions at ±32767; `point_worldtext` draws nothing for blank text, ignores
`font_name`, and is culled by the size of its text on screen, so a row's text spans the panel.

### From a registry

The mode is a set of OpenCitadel packages: `bhop` (the Deadworks plugin), one content package
per map (`bhop-eazy`, `bhop-arcane-v1`, …, each depending on `bhop`), and the host plugins
`bhop-records` (also depending on `bhop`) and `map-rotation`. In a `citadel-host` server folder:

```sh
citadel-host plugin install bhop-records     # pulls in bhop
citadel-host plugin install map-rotation
citadel-host plugin install bhop-eazy        # and any other maps
```

The plugin lands in `game/bin/win64/managed/plugins/`, the maps in `game/citadel/maps/`, and
players who join from `citadel-browser` get the map files offered to them. `citadel-pkg` installs
Deadworks and content packages without `citadel-host` (not yet tried with these). Publishing to a
registry and installing with dependencies was tested against a local `citadel-master`; the
packages are not on a public registry yet.

### By hand

1. Build and install the plugin:
   ```sh
   cd modes/bhop
   dotnet build src/OpenCitadel.Bhop.Plugin -c Release -p:DeployToGame=true
   ```
   (`-p:DeadlockManagedDir=...` if Deadlock isn't in the default Steam library.)
2. Put ported maps in `game/citadel/maps/` (each is one `<map>.vpk`; see below).
3. Start the server on a map: `deadworks.exe -dedicated ... +map bhop_eazy`. Players need the same
   map file; `citadel-browser` installs it for them when the map comes from the registry.
4. Settings live in `game/bin/win64/configs/BhopPlugin/BhopPlugin.jsonc` (mode, movement values,
   extra convars, zone beam width).

### Under citadel-host

Run it under `citadel-host` with the OpenCitadel bridge and the `bhop-records` and `map-rotation`
host plugins for cross-server records, Discord posts and a map playlist:

```jsonc
// server.json (excerpt)
"game": { "executable": "deadworks", "map": "bhop_eazy", "mapChange": "changelevel" },
"bridge": { "enabled": true },
"plugins": {
  "bhop-records": { "webhookUrl": "https://discord.com/api/webhooks/..." },
  "map-rotation": { "maps": ["bhop_eazy", "bhop_bubblegum", "bhop_eazy_v2"], "intervalMinutes": 30 }
}
```

`mapChange: changelevel` switches maps inside the running server instead of restarting it. It
works under Deadworks (build 6842), where the plugin reloads the new map's bhop data and zones on
the spot; a stock server crashed on `changelevel` in build 6796, which is why the host defaults
to restarting.

### In game

| Console command | |
|---|---|
| `dw_r` | Back to the start (and the timer resets) |
| `dw_b [n]` | To bonus `n`'s start (default 1), on maps with bonus courses |
| `dw_spawn` | Back to the map's spawn point, where you appeared when you joined |
| `dw_top` | The fastest times on the course you are running |
| `dw_bhopmode exact\|native` | Switch movement mode for everyone |
| `dw_bhopmap <map>` | Admins (`bhop.map`): switch to another course without changing the Deadlock map |
| `dw_zone start\|end a`, then `... b` | Admins: draw a zone between two corners where you stand |
| `dw_zone cp <n> a\|b`, `dw_zone list`, `dw_zone clear` | Checkpoints and zone housekeeping |
| `dw_bhopstat` | Movement diagnostics |
| `dw_bhoptour <seconds>` | Server console, for testing clients under load: sends every player to random spots of the course four times a second |
| `dw_bhopleavers [remove\|all]` | Server console: list player controllers and heroes, remove those of players who left; `all` also counts every entity by class |

The timer starts when a player leaves the start zone (speed above 290 u/s is clipped there, so
runs can't be pre-built) and stops in the end zone. Zones are drawn with beams: green start, red
end (paler for bonuses), yellow checkpoints. Players with the Deadworks client bootstrap
(installed by the Deadworks launcher) get a HUD: run time, speed, jumps, strafe sync, personal
best, map record, and the movement keys being held.

**Zones.** Classic maps carry no zone data. bhoptimer servers share theirs, and
[srcwr/zones](https://github.com/srcwr/zones) collects them for thousands of CS:S maps. Ported
maps keep their CS:S coordinates, so those zones fit as they are. A server reads zones from:
1. `configs/BhopPlugin/zones/<map>.zones.json`: what admins draw with `dw_zone`, or a bhoptimer
   zone file dropped in as it is;
2. the zones stored in the map (`citadel-port zones <map.vpk> srcwr`, or a file);
3. failing both, a start zone around the spawns, and no end zone until an admin draws one.

The bhoptimer zone types that work: start and end (bonus courses included, with their own
records), stages (as checkpoints), stop zones (they stop a running timer), and slide zones
(bhoptimer's fix for parts like bhop_arcane's fifth stage: a player in the air with ground
within 8 units below is held up at 8 u/s, so they slide without friction).

Records are kept per map, style and course in `configs/BhopPlugin/records/`. Each finished run is also
published to `citadel-host` as the `bhop.run_finished` game event (through the bridge's `ocemit`
command), where `bhop-records` keeps a leaderboard, announces records and posts to Discord.

## Porting a map

```sh
citadel-port build bhop_eazy.bsp --sdk C:\opencitadel-sdk -o out/ --credit "31K4L" \
    --textures "C:\...\Counter-Strike Source\cstrike" --textures "C:\...\Counter-Strike Source\hl2"
citadel-port zones out/bhop_eazy.vpk srcwr                    # community zones (or a file, or a URL)
citadel-port package out/bhop_eazy.vpk                        # -> out/packages/bhop-eazy, for the registry
```

`build` does the whole port:

1. Reads the BSP (VBSP 19–21) and extracts the bhop data: every brush with its bevel planes for
   collision, spawns, `trigger_teleport` and their destinations, `trigger_push` and
   `trigger_gravity`, and the sinking `func_door`/`func_button` platforms (bhop blocks) with the
   teleport beneath them. It also keeps the entity I/O maps build mechanics from: trigger
   filters (`filter_activator_name`) and the outputs that act on the player
   (`!activator AddOutput targetname|gravity|basevelocity`, with their delays). That is how
   "multihop" platforms work in maps like bhop_arcane, bhop_badges and bhop_kz_ocean: touching
   one renames you after 0.09 s, and a teleport filtered on that name catches you only if you
   are still standing there. "basevelocity" boosters (bhop_bubblegum) kick on the next tick, as
   in Source.
2. Converts the materials the map uses: the base textures (from the BSP's own pakfile, then any
   `--textures` folders or VPKs, e.g. CS:S's `cstrike/`) become TGAs and Deadlock `pbr.vfx`
   materials, with alpha test and translucency kept. Textures that can't be found become a
   neutral material tinted with the texture's average colour, which every BSP stores.
3. Writes a Hammer map: the world and visible brush entities as meshes, player clips as clip
   meshes, team spawns, a sun and a sky.
4. Compiles materials and the map with Deadlock's own compiler (geometry, physics and visibility;
   lighting is not baked yet).
5. Packs one `maps/<map>.vpk` holding the compiled map, its materials and `maps/<map>/bhop.json.gz`,
   the bhop data the plugin reads from the installed map.

`citadel-port inspect <bsp>` lists what a map contains, `extract` writes only the bhop data,
`vmap` only the Hammer map, and `simulate <bhop.json.gz>` runs a scripted player through the
map's collision and triggers without the game.

### The compiler SDK

Deadlock ships its resource compiler as `resourcecompiler.dll` without a program to run it, and
without three tool modules a map build needs. The SDK folder puts the pieces together. Set it
up once, and again after each Deadlock update (a second run copies only what changed):

```sh
citadel-port sdk "C:\Program Files (x86)\Steam\steamapps\common\Deadlock" --sdk C:\opencitadel-sdk \
    --dota-tools <folder with the three Dota 2 modules> --cs2 "C:\...\Counter-Strike Global Offensive"
```

It needs, from outside Deadlock:

* **`modeldoc_utils.dll`, `exportsystem.dll`, `smartprops.dll` from Dota 2's Workshop Tools.**
  CS2's copies do not work: their schemas differ from Deadlock's and the compiler aborts. Fetch
  them with [DepotDownloader](https://github.com/SteamRE/DepotDownloader) (needs a Steam login;
  Dota 2 is free): `-app 570 -depot 381450 373301 373303 -os windows -osarch 64` with a file
  list of `regex:^game/bin/win64/(modeldoc_utils|exportsystem|smartprops)\.dll$`, then pass the
  download folder as `--dota-tools`.
* **`bc7e.dll` and `ispc_texcomp.dll`**, the texture compressors, from a CS2 install with the
  Workshop Tools (`--cs2`). Without them, maps still build with `--no-textures`.
* Visual Studio's C++ tools, once, to build `rclaunch.exe` from `native/rclaunch.c`. Or build it
  yourself (`cl rclaunch.c user32.lib`) and put it in `game/bin/win64/`.

What ends up in the folder:

| Path | Contents |
|---|---|
| `game/bin/win64/` | A copy of Deadlock's `game/bin/win64` (without Deadworks), `rclaunch.exe`, and the five modules above |
| `game/bin/assettypes_common.txt` | Dota 2's, from [SteamDB's GameTracking-Dota2](https://github.com/SteamDatabase/GameTracking-Dota2) |
| `game/citadel/gameinfo.gi` | A tools game info: no mod app systems, Deadlock's packages on the search path, no baked lighting |
| `game/citadel/*.fgd` | `base.fgd`, `models_base.fgd`, `lights*.fgd`, `markup_volumes.fgd`, `postprocessing.fgd`, `ai_defaultnpc.fgd` from GameTracking-Dota2's `game/core`, and `citadel.fgd` from [Modlock Tools](https://github.com/paralin/modlock-sdk) (MIT) |
| `game/citadel/materials/tools/handle_generic_aligned*.vmat_c` | Copies of Deadlock's `handle_generic*.vmat_c`, which the compiler loads at startup |
| `game/citadel_assets`, `game/core` | Junctions to Deadlock's `game/citadel` and `game/core` (no copies of its packages) |
| `content/citadel_addons/<addon>/` | Where the porter writes maps and materials |

`rclaunch.exe` runs the compiler on a hidden desktop (it opens a window and reports errors in
dialogs), prints any dialog's text and stops the compile. The one exception is the compiler's
"Low Available Memory" warning, which shows up when the machine is busy (with the game running,
say): rclaunch answers it with OK and the compile carries on. `RCLAUNCH_TRACE=1` lists every DLL the compiler loads,
which is how a missing module shows up. Two details the compiler is strict about, handled by the
porter: maps must be binary DMX at `vmap` format version 40 (older versions need `dmxconvert.exe`,
which Deadlock lacks), and faces must be counter-clockwise (BSP faces are clockwise).

## Limitations

* The camera stays third person: neither Deadworks' camera messages nor `citadel_camera_dist`
  reach the client on build 6842.
* In exact mode the hero shows Deadlock's noclip pose.
* Water and ladders follow Source's CGameMovement (CS:S's ladder damping included) but have
  only been tested against the code, not side by side with CS:S. Displacements are converted
  but lightly tested.
* Entity I/O is modelled only as far as bhop maps use it on players (renames, gravity, base
  velocity, name filters). A `trigger_multiple`'s wait and a `trigger_once` count per player,
  where Source shares them between players. Outputs that need weapons (shootable boost buttons
  in bhop_badges) do nothing. Of bhoptimer's zone types, only start, end, stage, stop and slide
  are used.
* Lighting isn't baked: maps use the sun and sky only.
* HL2 base textures aren't in any anonymous download; they need a CS:S or HL2 install
  (`--textures` pointing at its `hl2` folder). Portal 2's packages don't have them. CS:S's own
  textures come from the free CS:S dedicated server depot (app 232330). Without them, a map
  like bhop_arcane_v1 draws 54 of its 200 materials as tinted placeholders.
* Chat didn't reach Deadworks on the tutorial map used for early tests (no match runs there); on
  ported maps it is untested. The `dw_` console commands always work.
* Drawn (zero-install) courses: the camera can't collide with them, so near walls it looks
  through them (backs are culled instead); displacements are drawn flat; maps over the budget
  show their small details only near players, and with several players far apart those details
  are shared out between them. On `new_player_basics` the game adds four target dummies (they show
  as bots in server browsers) and its "Testing Tools" hint. A stock client sees a few flashes of
  garbled subtitle in its first 15 seconds (Deadworks' UI handshake, above).

## Credits and rights

Ported maps belong to their authors. Every map package records its credits, and the plugin
prints them when the map loads. Textures from CS:S and HL2 are Valve's. If you are a map's author
and want a port changed or taken down, open an issue.

## Tests

```sh
dotnet test OpenCitadel.Bhop.slnx
```
