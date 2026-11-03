# Hot-swapping client mods

Design notes for enabling and disabling Deadlock client mods (VPK skins, models, sounds)
**while the game keeps running**, with no restart. This is research toward a feature for
[Deadlock Mod Manager](https://github.com/deadlock-mod-manager/deadlock-mod-manager) (DMM), with a side
benefit for OpenCitadel community servers. Nothing here ships in an OpenCitadel package yet.

Everything below was checked against a live client, build 6839 (October 2026), on Windows 11
25H2. Addresses refer to that build.

## Result

Mods can be swapped while the game keeps running, and the swap works in normal VAC-secure play,
without code inside the game process. The working design:
* A **slot VPK** whose directory lists every file any installed mod touches.
* The slot is served from a **user-space SMB share** that the game reads through an ordinary
  search path. Our own process controls the share's backing file.
* To enable or disable a mod, we rewrite the slot's data. The game's next load of that resource
  returns the new bytes.

Verified in one game session with a current skin: stock → mod → stock across sandbox loads, with
correct models, camera and abilities. **An official matchmaking game has not been tested yet.**
See [Open questions](#open-questions).

## Constraints

* **No restart.** Toggling a mod must not require closing the game.
* **Works in official matchmaking.** Anything that only works in the menu or on private servers
  falls short of the goal.
* **Nothing inside the game process.** No DLL injection or memory patching: VAC bans for injected
  code regardless of intent, and every DMM user would carry that risk.
* **No driver installs.** WinFsp, Dokan and similar were ruled out.
* **Low stability is acceptable at first**, but crashes during a match are not.

## How the client loads mods today

* `gameinfo.gi` lists search paths. DMM adds `Game citadel/addons` and places mods there as
  `pakNN_dir.vpk`.
* **Mount.** At startup the filesystem mounts every `pak*_dir.vpk` (the pattern is in
  `filesystem_stdio.dll`) in each `Game` path. DMM disables a mod by renaming it so the pattern
  no longer matches, e.g. `653713_pak01_dir.vpk`.
* **Lookup order.** Every VPK on every path is checked before any loose directory, including the
  base game's `citadel/pak01_dir.vpk`. A loose file can add content but never override a file
  that a VPK contains.
* **File locks.**
  * `*_dir.vpk` files are opened at mount with read-only sharing. No other process can write to
    or rename them until the game exits.
  * Data chunks (`*_NNN.vpk`) are opened on first read and held until the game exits. At the
    main menu, 305 of the 329 base-game chunks were already locked, and the count didn't change
    across map loads.
* **Re-reads.** The resource system re-reads a resource from the filesystem when a map load
  needs it again, e.g. a hero model when a match or the sandbox loads.

## Approaches

| Approach | Hot | Survives official matchmaking | Outcome |
|---|---|---|---|
| Loose-file overlay on a swappable junction | ✅ | — | ❌ Can't override files inside VPKs |
| Engine addon system (`AddonRoot` + `map … customgamemode=`) | ✅ | ❌ | Works locally; servers decide the addon list; the unmount crashed |
| Rewriting a mounted VPK in place | — | ✅ | ❌ Blocked by Windows file locks |
| Remounting the UI-language path | — | ✅ | ❌ No runtime language switch exists |
| **Slot VPK on a user-space SMB share** | ✅ | ✅ (expected) | ✅ **Works** |

### Loose-file overlay

A `Game citadel/dmm_live` path pointing at a directory junction, flipped between staging
directories. The game does read files through the junction: a probe cfg reached `exec`. But
loose files rank below every VPK, so an overlaid model never replaced the stock one.

### Engine addon system

Source 2's CS2/Dota addon machinery is present in Deadlock:
* `AddonRoot citadel_addons` inside `SearchPaths` creates an `ADDONS` path
  (`game/citadel_addons/<name>/pak01_dir.vpk`).
* `map <map> customgamemode=<addon>[,<addon>…]` mounts the listed addons during that map load,
  and their files override base VPKs.
* An addon folder created after launch can be mounted.
* `snd_sos_capture_soundevent_overwrites` exists specifically to restore sound events that an
  addon overwrote during a game.

Why it isn't the answer:
* **Servers decide.** Connecting to a server switches the client to the server's addon list,
  unconditionally (see [Engine reference](#engine-reference)). `UpdateAddons` unmounts
  everything and mounts the new list. An official server's list is empty, so connecting strips
  every runtime addon. The menu map is loaded with an empty list too.
* **Unmounting crashed the client.** Loading a map without the addon unmounted it, and about
  5 s later the client crashed with an access violation in `soundsystem.dll`, right after
  `Addon unloaded, unloading sound resources.`
  * The faulting function walks a sound event's file list through a pointer into freed
    sound-event data.
  * Untested mitigations: `snd_sos_capture_soundevent_overwrites 0`, stopping sounds first, or
    unmounting through an empty map such as `start`.

The addon system is still the right tool for **community servers**; see
[Community servers](#community-servers).

### Rewriting a mounted VPK in place

Write a slot VPK with a fixed directory, then overwrite its data regions on disk. Native Windows
`CreateFile` calls fail with sharing violations even when they allow full sharing:
* the `*_dir.vpk` is locked from mount;
* chunk files are locked from the first read until the game exits.

At most one change is possible, before the asset is first read, which in practice means before
launch.

### Remounting the UI-language path

The `Game_UILanguage citadel_*LANGUAGE*` path would be remounted if the language could change at
runtime. `find language` shows no such switch.

### Slot VPK on a user-space SMB share (the working design)

The locks are enforced by the Windows file system on the game's side, not on the data behind it.
If the VPK lives on an SMB share served by our own process:
* the game opens it with read-only sharing, and Windows still refuses other Windows processes
  write access;
* the server's backing file is ordinary storage that we rewrite at will;
* reads on the game's existing handle return the new bytes. There is no client-side caching
  without an oplock or lease. This was verified directly: a handle held open with
  `FileShare.Read` read `VERSION-A`, the backing file was rewritten, and the same handle then
  read `VERSION-B`.

## Design

### Slot VPK

* **Entries.** One entry per path that any mod in the library touches, enabled or not. The
  directory (paths, offsets, lengths) is fixed for the whole game session.
* **Slot size.** Each entry is sized `max(len(mod), len(stock))` and zero-padded. The engine
  tolerates trailing zeros after compiled resources. This was verified in both directions: a
  3.5 MB stock model padded to 34 MB, and mod files smaller than stock padded to stock size.
* **Disabled state.** The entry holds the stock bytes, read from the base `pak01_dir.vpk` at
  build time.
* **Mod-only files.** Files the base game doesn't have, such as a mod's new textures, keep the
  mod's bytes permanently. Nothing references them while the mod is off.
* **Format.** A single-file VPK v2 (data embedded, archive index `0x7fff`) with the standard
  48-byte MD5 section. Rewriting data invalidates the CRCs and MD5s, and the game doesn't check
  them on read.
* **Rebuild at every launch.** Stock bytes change when the game updates.

### Plumbing

1. **SMB server.** A user-space SMB2 server on `127.0.0.1:<port>`. The prototype used
   [impacket](https://github.com/fortra/impacket)'s `smbserver.py` in WSL on port 8445, since
   Windows' own SMB server holds 445. The share serves the slot as `pak01_dir.vpk`.
2. **Drive mapping:**
   `New-SmbMapping -LocalPath Z: -RemotePath \\127.0.0.1\<share> -TcpPort <port> …`.
   * It needs a client that supports alternative SMB ports (Windows 11 24H2 or later).
   * It must run in the user's **non-elevated** session, the one Steam and the game run in.
     Drive mappings are per logon session, and a mapping made from an elevated shell is invisible
     to the game. From an elevated process, starting a script through `explorer.exe` runs it
     non-elevated.
3. **Symlink:** `citadel/dmm_smb` → `Z:\`.
   * `gameinfo.gi` doesn't accept absolute paths: `Game Z:/` became `game\Z:\`.
   * A directory junction can't target a network path, so a symbolic link is needed. Creating one
     needs admin rights or Developer Mode.
   * Windows evaluates local-to-remote links by default.
4. **gameinfo.gi:** `Game citadel/dmm_smb` as the **first** entry in `SearchPaths`, so the slot
   outranks DMM's `addons` and the base game. The engine resolves the link and logs
   `GAME "Z:\\pak01.vpk" (vpk)`.

### When to write

Only rewrite the slot while the game is idle in a menu, never during a load: a read halfway
through a rewrite would mix old and new bytes. The prototype followed `console.log` (launch
option `-condebug`) for `Loading map` lines and wrote 15 s after the menu map loaded.

A change takes effect the next time the engine loads the resource:
* entering a match or the sandbox;
* reloading the menu map.

Whether the menu's hero preview picks up a change without a map load is untested.

## Verification

All runs were on build 6839, in one launch each unless noted.

| Mode | Mod | Steps | Result |
|---|---|---|---|
| `-insecure` + console bridge | Mina skin (outdated) | stock → mod → stock via `map dl_hideout` | ✅ Both directions in the menu |
| Normal (VAC-secure) | Mina skin (outdated) | flip to mod in the menu, enter the sandbox | ✅ Skin loaded. ❌ Broken camera (see below) |
| Normal (VAC-secure) | Sinclair skin (current) | stock → mod → stock across two sandbox loads | ✅ Correct each time: models, abilities and camera |

The Mina camera failure was the mod's own fault. The modded model has no camera-pose nodes: the
log showed no `VMDL Camera Pose Success!` for it, while the stock model and Sinclair's mod both
produced one. The same mod also logged `no sequence named: ui_pose_alt` and missing
`g_tAltColor_Reveal` textures, which means it was built for an older game version.

## Productising in DMM

| Piece | Prototype | In DMM |
|---|---|---|
| SMB server | impacket in WSL | Built-in SMB2 server (the app is Rust/Tauri), serving the slot from memory or a backing file |
| Drive mapping | `New-SmbMapping` started via Explorer | Done by DMM at startup in the user session |
| Symlink | Created from an elevated shell | One-time setup step behind a UAC prompt |
| gameinfo.gi line | Manual edit | DMM already patches gameinfo.gi |
| Slot contents | One mod | Every mod in the library |
| Write timing | A `console.log` watcher | Same, with DMM adding `-condebug` to the launch options |

### Failure modes

* **The server dies while the game runs.** The next read from the share fails, which probably
  means a crash, and during a match an abandon penalty. The server has to outlive the game, and
  DMM should warn before queueing if it isn't running.
* **A write during a load.** Prevented by writing only when idle, as above.
* **A new mod mid-session.** Its paths aren't in the directory, so it needs one restart. Mods
  already in the library toggle hot.
* **Resident resources.** Anything the engine keeps loaded (e.g. a hero showing in the menu)
  changes only at its next load.
* **Game updates.** Stock bytes change. Rebuilding the slot at every launch covers this.
* **Windows versions.** Older than 11 24H2 lacks alternative SMB ports, so this needs a fallback,
  such as the current restart flow.

## Open questions

* **An official matchmaking game.** The slot is a static search path, which official servers
  don't touch (unlike engine addons), so it should behave exactly as in the sandbox. It hasn't
  been run.
* **Performance.** A whole model is read over loopback SMB. No stutter was noticed with ~35 MB
  slots, but nothing was measured.
* **Many mods.** A slot covering a large library means many entries and a large padded file.
  Entries could be shared when mods override the same path; the toggle then has to pick a
  winner.
* **SMB server choice.** Whether a minimal embedded SMB2 server can satisfy the Windows client's
  signing and auth defaults (impacket with a username and password did) without a
  WSL dependency.

## Community servers

For OpenCitadel and Deadworks servers, the engine addon system already gives hot-swapping:
* a server's map load can carry an addon list (`map <map> customgamemode=a,b`);
* clients receive it in `S2C_CONNECTION` (`[addons:'a,b']`);
* clients mount those addons on connect or map change, with no restart.

The files must already be on the client, which `citadel-browser`'s content sync can provide.
Before relying on this, the unmount crash above needs a fix or a workaround, because every
disconnect or map change to a different list unmounts addons.

## Engine reference

### Command-line flags are hashed

The engine looks up launch flags by hash, not by string, so flag names never appear in the
binaries. The hash is MurmurHash2 of the lowercased flag with seed `0x31415926` (Valve's
`CUtlStringToken`).

| Flag | Hash | Checked in |
|---|---|---|
| `-netconport` | `0xe04399b8` | engine2 (netconsole; never opened on a client) |
| `-netconpassword` | `0x4c07cae7` | engine2 |
| `-vconsole` | `0x45cb5cb0` | engine2, vconcomm |
| `-vconport` | `0xb34b4e6a` | engine2, vconcomm |
| `-tools` | `0x0bc4f1a2` | engine2, vconcomm, filesystem, resourcesystem, client |
| `-insecure` | `0x8f74045f` | engine2, tier0 |
| `-novconsole` | `0x00c5513f` | engine2 |
| `-condebug` | `0x1ae13a16` | engine2 |
| `-concommandpipe` | `0x6e6cda1d` | engine2 (requires `-insecure`) |
| `-addon` | `0x4ebeac3f` | engine2 |

### Console access from outside the game

* **VConsole2.** `vconcomm.dll` is loaded only with (`-tools` **or** `-insecure`) **and**
  (`-vconsole` or `-vconport`). It listens on `0.0.0.0:<vconport>` (default 29000).
  * Frame layout: `type[4] | version u16 BE (0x00d4) | length u32 BE (whole frame) | handle u16`.
  * Send `CMND` with the command plus a NUL.
  * Output arrives as `PRNT`, with the text starting at payload offset 28.
  * The initial `CVRB` (convar dump) frame is ~415 KB.
* **`-concommandpipe`** requires `-insecure`.
* **Netconsole.** The `-netconport` code binds `0.0.0.0` but never ran on a client. Its strings
  sit with the dedicated-server text console.

So external console control exists only with VAC off, and a product feature can't depend on it.
The console itself works in normal play: users can type or bind `map`, `exec`, etc.

### Console output and `console.log`

Command output (`echo`, `find`, `help`) goes to the `DeveloperConsole` log channel, which has
`ConsoleOnly` set by default, so `-condebug` never writes it to `console.log`. Running
`log_flags DeveloperConsole -consoleonly` fixes that for the session. (The log message says
"Enabling" either way.)

### Functions in engine2.dll (build 6839, image base `0x180000000`)

| Address | What |
|---|---|
| `0x1801ca160` | `map` command handler. `customgamemode=` becomes the addon list passed to the host-state request; without it, the addon is looked up from the map name |
| `0x1801c9700` | Map-name resolution / "map %s is ambiguous" (stock maps only) |
| `0x180054ad0` | Receives `S2C_CONNECTION` and stores the server's addon string as-is |
| `0x18013c310` | `CLoopModeRemoteConnect::OnClientFrameSimulate`: switches to `levelload` with the server's addon string |
| `0x1802122c0` | `CEngineServiceMgr::UpdateAddons`: unmounts all addons, stores the new list, mounts each |
| `0x18018e520` | Gate that loads `vconcomm` (`-tools`/`-insecure` + `-vconsole`/`-vconport`) |
| `0x180021840` | Netconsole init (`-netconport`, `-netconpassword`) |

`soundsystem.dll` `0x18006c490` (fault at RVA `0x6c59f`) is the crash site for an addon unmount.

## Reproducing the prototype

1. Back up `gameinfo.gi` and note its sha256. DMM rewrites its own block, so re-hash before each
   test.
2. Build the slot VPK:
   * extract the mod;
   * for each compiled file, size its entry `max(mod, stock)`, with stock bytes from
     `citadel/pak01_dir.vpk`;
   * write a single-file VPK v2 in the stock state;
   * record each entry's absolute data offset.
3. Serve it:
   `smbserver.py -smb2support -port 8445 -ip 127.0.0.1 -username <u> -password <p> DMM <dir>`.
4. In the **non-elevated** session:
   `New-SmbMapping -LocalPath Z: -RemotePath \\127.0.0.1\DMM -TcpPort 8445 -UserName <u> -Password <p> -Persistent $false`.
5. Create the link `citadel\dmm_smb` → `Z:\` and add `Game citadel/dmm_smb` as the first line of
   `SearchPaths`.
6. Launch with `-condebug`. While in the menu, rewrite the entries in the backing file (mod or
   stock bytes, zero-padded), then load a map.
7. Clean up:
   * restore `gameinfo.gi` and check the hash;
   * delete the link (not its target);
   * run `Remove-SmbMapping` in both sessions;
   * stop the server.
