using System.Numerics;
using DeadworksManaged.Api;
using OpenCitadel.Bhop.Map;
using OpenCitadel.Bhop.Movement;
using OpenCitadel.Bhop.Timing;

namespace OpenCitadel.Bhop.Plugin;

/// <summary>
/// A Counter-Strike: Source bunny-hop mode for Deadlock. In exact mode the plugin runs CS:S player
/// movement itself for every usercmd, removes the movement from the command so Deadlock's own
/// movement leaves the hero alone, and moves the hero to the simulated position.
/// </summary>
public sealed class BhopPlugin : DeadworksPluginBase {
	// Deadworks expects a plugin's permissions to start with its name: "bhop.zones".
	public override string Name => "Bhop";

	[PluginConfig]
	public BhopConfig Config { get; set; } = new();

	private const Heroes DefaultHero = Heroes.Haze;

	private readonly BhopPlayer?[] _players = new BhopPlayer?[Players.MaxSlot + 1];
	private readonly EngineTraceWorld _engineWorld = new();
	private CssMovement _movement = null!;
	private float _tickInterval = 1f / 64f;

	/// <summary>The movement values for a map: the configured ones plus any for its name prefix (surf_ maps).</summary>
	private MovementSettings MovementFor(string map) {
		var s = Config.Movement.Apply(MovementSettings.CounterStrikeSource);
		foreach (var (prefix, overrides) in Config.MapMovement) {
			if (map.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) s = overrides.Apply(s);
		}
		return s;
	}

	// ------------------------------------------------------------------ captions

	/// <summary>When each slot joined (Environment.TickCount64), for <see cref="FilterCaptions"/>; 0: before this plugin loaded.</summary>
	private readonly long[] _joinedAt = new long[Players.MaxSlot + 1];
	/// <summary>When each slot was last let through a handshake caption before reporting the add-on.</summary>
	private readonly long[] _probedAt = new long[Players.MaxSlot + 1];
	private readonly Func<OutgoingMessageContext<CUserMessageCloseCaptionPlaceholder>, HookResult> _captionFilter;
	/// <summary>How long after joining a player may still report Deadworks' client add-on.</summary>
	private const long CaptionGraceMs = 15000;
	/// <summary>
	/// Deadworks repeats its handshake every second until the add-on answers; a player who hasn't
	/// answered gets one this often, from <see cref="CaptionFirstProbeMs"/> after joining (captions
	/// sent before the client's HUD is up are lost anyway).
	/// </summary>
	private const long CaptionProbeMs = 4000;
	private const long CaptionFirstProbeMs = 2000;
	/// <summary>A handshake can come in pieces, sent together: all within this of the first go through.</summary>
	private const long CaptionBurstMs = 250;

	public BhopPlugin() => _captionFilter = FilterCaptions;

	/// <summary>
	/// Deadworks' server UI talks to its client add-on in closed captions, and a player without the
	/// add-on (nothing installed) sees each frame as a line of garbled subtitle. Until a player has
	/// reported the add-on, only an occasional handshake reaches them, and none once
	/// <see cref="CaptionGraceMs"/> has passed: a stock client sees a few brief flashes after joining
	/// and nothing after that, while a client with the add-on still answers and gets Deadworks' UI.
	/// </summary>
	private HookResult FilterCaptions(OutgoingMessageContext<CUserMessageCloseCaptionPlaceholder> ctx) {
		var now = Environment.TickCount64;
		var left = 0;
		for (var slot = 0; slot <= Players.MaxSlot; slot++) {
			if (!ctx.Recipients.HasRecipient(slot)) continue;
			if (DeadworksManaged.Api.UI.UI.HasClientBootstrap(slot)) left++;
			else if (CaptionProbe(slot, now)) left++;
			else ctx.Recipients.Remove(slot);
		}
		// Deadworks probes one player per frame; with nobody left to send to, drop it altogether.
		return left == 0 ? HookResult.Stop : HookResult.Continue;
	}

	/// <summary>Whether a handshake caption may go to a player who hasn't reported the add-on yet.</summary>
	private bool CaptionProbe(int slot, long now) {
		var joined = now - _joinedAt[slot];
		if (joined > CaptionGraceMs || joined < CaptionFirstProbeMs) return false;
		var sinceProbe = now - _probedAt[slot];
		if (sinceProbe <= CaptionBurstMs) return true; // the rest of the same handshake
		if (sinceProbe < CaptionProbeMs) return false;
		_probedAt[slot] = now;
		return true;
	}

	public override void OnUnload() {
		NetMessages.UnhookOutgoing(_captionFilter);
		CBeam.RemoveAll(_zoneBeams); // the next load can't tell them apart from the map's own
	}

	public override void OnLoad(bool isReload) {
		NetMessages.HookOutgoing(_captionFilter);
		_movement = new CssMovement(MovementFor(Server.MapName), _engineWorld);
		Log($"{(isReload ? "Reloaded" : "Loaded")}: mode {Config.Mode}, apply {Config.ApplyMethod}, " +
		    $"airaccelerate {_movement.Settings.AirAccelerate}.");
		if (isReload) {
			ApplyConVars();
			_worldHud.Clear();
			RemoveOldZoneBeams();
			var course = RememberedCourse() ?? Config.Course; // read before LoadMapData notes the Deadlock map
			LoadMapData(Server.MapName);
			if (_map == null && course.Length > 0) LoadMapData(course);
			RemoveLeavers(); // any left behind while the plugin wasn't loaded
			// Players already in the server don't connect again: pick them up where they are.
			foreach (var controller in Players.GetAll()) {
				if (controller.IsBot) continue;
				// Carry on from where they are, rather than back at the spawn.
				_players[controller.Slot] = new BhopPlayer(controller.Slot) { ResumeInPlace = true };
			}
		}
	}

	public override void OnConfigReloaded() {
		_movement.Settings = MovementFor(_mapName);
		ApplyConVars();
		foreach (var p in _players) if (p != null) p.Active = false;
		Log($"Config reloaded: mode {Config.Mode}, apply {Config.ApplyMethod}.");
	}

	public override void OnStartupServer() {
		Array.Clear(_players);
		_renderer.Clear(mapChanged: true);
		_worldHud.Clear();
		_movement.Settings = MovementFor(Server.MapName);
		ApplyConVars();
		LoadMapData(Server.MapName);
		// A stock Deadlock map: run the configured course on it, drawn with stock content.
		if (_map == null && Config.Course.Length > 0) LoadMapData(Config.Course);
	}

	private void ApplyConVars() {
		var vars = new Dictionary<string, string> {
			// A movement server, not a match: no lanes, troopers or NPCs, quick respawns.
			["citadel_trooper_spawn_enabled"] = "0",
			["citadel_npc_spawn_enabled"] = "0",
			["citadel_start_players_on_zipline"] = "0",
			["citadel_allow_duplicate_heroes"] = "1",
			["citadel_player_spawn_time_max_respawn_time"] = "1",
			["citadel_voice_all_talk"] = "1",
			["sv_alltalk"] = "1",
			// How many ticks of each client's history the server keeps (128 by default: 2 s). A client
			// that stalls for longer, as slower PCs do while taking in a drawn course, can't be sent a
			// delta any more and is sent everything again, which takes it longer still; such clients
			// went silent and timed out. 10 s lets them catch up.
			["sv_maxclientframes"] = "640",
		};
		if (Config.Mode == MovementMode.Exact) {
			// Clients predict their hero in noclip: a straight line at the networked velocity, which the
			// plugin aims along the simulated path (ClientPrediction). Without it, they show the
			// server's result, interpolated.
			vars["sv_client_predict"] = Config.ClientPrediction ? "1" : "0";
			// NoclipVelocity: with no input and no friction, noclip carries the velocity we set unchanged.
			vars["sv_noclipfriction"] = "0";
			vars["sv_noclipaccelerate"] = "0";
		} else {
			vars["sv_client_predict"] = "-1";
			// Deadlock's own movement, pushed toward CS:S. These are replicated, so clients predict
			// with the same values. Air acceleration follows Source's formula with the wish speed
			// capped by citadel_aircontrol_speed_*, which plays the role of CS:S's 30.
			var s = _movement.Settings;
			vars["sv_airaccelerate"] = s.AirAccelerate.ToString(System.Globalization.CultureInfo.InvariantCulture);
			vars["citadel_aircontrol_speed_fast"] = s.AirSpeedCap.ToString(System.Globalization.CultureInfo.InvariantCulture);
			vars["citadel_aircontrol_speed_slow"] = s.AirSpeedCap.ToString(System.Globalization.CultureInfo.InvariantCulture);
			vars["sv_friction"] = s.Friction.ToString(System.Globalization.CultureInfo.InvariantCulture);
			vars["sv_stopspeed"] = s.StopSpeed.ToString(System.Globalization.CultureInfo.InvariantCulture);
			vars["citadel_air_jumps_enabled"] = "0";
			vars["citadel_wall_ride_enabled"] = "0";
		}
		foreach (var (k, v) in Config.ConVars) vars[k] = v;
		foreach (var (name, value) in vars) {
			var cv = ConVar.Find(name);
			if (cv == null) {
				Log($"convar {name} not found");
				continue;
			}
			cv.SetString(value);
		}
	}

	// ------------------------------------------------------------------ players

	public override void OnClientFullConnect(ClientFullConnectEvent args) {
		var controller = args.Controller;
		if ((uint)args.Slot < _joinedAt.Length) {
			// Bots have no client to show captions: 0 keeps them out of the handshake window.
			_joinedAt[args.Slot] = controller is { IsBot: false } ? Environment.TickCount64 : 0;
			_probedAt[args.Slot] = 0;
		}
		if (controller == null || controller.IsBot) return; // bots: only scripted test bots take part
		Log($"[{args.Slot}] {controller.PlayerName} joined: {_renderer.Spawned} panel entities ({_renderer.SpawnedBytes / 1024} KiB) in their first update");
		_players[args.Slot] = new BhopPlayer(args.Slot);
		controller.ChangeTeam(2);
		controller.SelectHero(DefaultHero);
	}

	public override void OnClientDisconnect(ClientDisconnectedEvent args) {
		if ((uint)args.Slot < _players.Length) {
			if (_players[args.Slot] != null && !args.IsMapChange) LogLeave(args);
			_players[args.Slot] = null;
		}
		_worldHud.Remove(args.Slot);
		if (!args.IsMapChange && args.Controller is { IsBot: false } leaver) leaver.RemoveWithPawns();
	}

	/// <summary>When each slot's client last sent input (Environment.TickCount64).</summary>
	private readonly long[] _lastInputAt = new long[Players.MaxSlot + 1];

	/// <summary>
	/// How long a leaver played and when their client last sent input. A client that crashes or hangs
	/// isn't noticed until the connection times out, about ten seconds later; this tells when it stopped.
	/// </summary>
	private void LogLeave(ClientDisconnectedEvent args) {
		var now = Environment.TickCount64;
		var slot = args.Slot;
		if (_joinedAt[slot] == 0) {
			Log($"[{slot}] {args.Controller?.PlayerName ?? "?"} left ({args.Reason}); joined before the plugin was loaded");
			return;
		}
		var stayed = (now - _joinedAt[slot]) / 1000.0;
		var input = _lastInputAt[slot] >= _joinedAt[slot] && _joinedAt[slot] != 0
			? $"last input {(_lastInputAt[slot] - _joinedAt[slot]) / 1000.0:0.0} s after joining"
			: "no input since joining";
		Log($"[{slot}] {args.Controller?.PlayerName ?? "?"} left ({args.Reason}) after {stayed:0.0} s, {input}; " +
		    $"{_renderer.Spawned} panel entities drawn");
		if (_players[slot] is { } p) Log($"[{slot}] on {_mapName}: {p.Stats}");
	}

	// ------------------------------------------------------------------ leavers

	/// <summary>
	/// Removes players who have left, with their heroes. Deadlock keeps a departed player's controller
	/// and hero for when they reconnect, standing where they left under their name, which a bhop server
	/// has no use for. Worse, the game checks a departed player's hero against its play area again, and
	/// courses lie outside it: it tries to kill the hero every tick, the plugin's damage block stops
	/// it, and the hero stays while the server logs "out of the play area" 64 times a second. Each one
	/// also adds to the first update of every player who joins after (see <see cref="BhopConfig.MaxPanelKilobytes"/>).
	/// Leavers are removed as they leave; this catches any left while the plugin wasn't loaded.
	/// </summary>
	private static void RemoveLeavers() {
		foreach (var controller in Players.GetAllControllers().ToList())
			if (!controller.IsBot && !Players.IsConnected(controller.Slot)) controller.RemoveWithPawns();
	}

	public override void OnPawnHeroInitialized(CCitadelPlayerPawn pawn) {
		var controller = pawn.Controller;
		if (controller == null) return;
		if (_players[controller.Slot] is not { } p) {
			if (controller.IsBot) return;
			p = _players[controller.Slot] = new BhopPlayer(controller.Slot);
		}
		p.Active = false; // re-activated from the hero's spawn position on the next usercmd
		if (Config.FirstPerson) SetFirstPerson(controller, true);
	}

	[GameEventHandler("player_respawned")]
	public HookResult OnPlayerRespawned(PlayerRespawnedEvent args) {
		var pawn = args.Userid?.As<CCitadelPlayerPawn>();
		var controller = pawn?.Controller;
		if (controller != null && _players[controller.Slot] is { } p) p.Active = false;
		return HookResult.Continue;
	}

	public override HookResult OnTakeDamage(TakeDamageEvent args) => HookResult.Stop;

	public override void OnAbilityAttempt(AbilityAttemptEvent args) {
		// No abilities or items in a bhop mode.
		args.BlockedButtons |= InputButton.AllAbilities | InputButton.AllItems | InputButton.AllInnates | InputButton.Teleport;
		// Native mode keeps Deadlock's movement, minus the sprint/dash key. The jump key also sends the
		// mantle and zipline bits, so those stay: blocking them blocks jumping.
		if (Config.Mode == MovementMode.Native) args.BlockedButtons |= InputButton.Speed;
	}

	private static void SetFirstPerson(CCitadelPlayerController controller, bool on) {
		var camera = controller.Camera;
		camera.Clear();
		if (!on) return;
		camera.LerpDistance(0f, 0f, 0.01f);
		camera.Maintain(CameraSetting.Distance, 1e7f, delay: 0.01f);
	}

	// ------------------------------------------------------------------ movement

	public override void OnProcessUsercmds(ProcessUsercmdsEvent args) {
		if ((uint)args.PlayerSlot < _lastInputAt.Length && args.Usercmds.Count > 0) _lastInputAt[args.PlayerSlot] = Environment.TickCount64;
		if (Config.Mode != MovementMode.Exact || _freeFly || args.Paused || args.Usercmds.Count == 0) return;
		if ((uint)args.PlayerSlot >= _players.Length || _players[args.PlayerSlot] is not { } p) return;
		var pawn = args.Controller?.GetHeroPawn();
		if (pawn == null || !pawn.IsAlive) return;

		var frameTime = GlobalVars.FrameTime;
		if (frameTime > 0.001f && frameTime < 0.1f) _tickInterval = frameTime;

		if (!p.Active) Activate(p, pawn);
		if (p.Script != null) {
			foreach (var cmd in args.Usercmds) p.Script.Write(cmd, ++p.ScriptTick, _tickInterval);
		}

		_engineWorld.IgnoreEntity = pawn.EntityIndex;
		var before = p.State.Origin;
		var simulated = 0;
		var teleported = false;
		Vector3? teleportAngles = null;
		foreach (var cmd in args.Usercmds) {
			// Clients resend recent commands in case packets are lost, and the engine runs each one
			// once. Deadlock leaves the command number at 0, and the client tick doesn't tell commands
			// apart either: a client drawing fewer frames than the server's 64 ticks makes two commands
			// in some frames and gives both that frame's tick. Each command has its own random seed.
			var number = cmd.Base?.ClientTick ?? 0;
			if (p.Script == null && cmd.Base != null && !p.Seen.Add(number, cmd.Base.RandomSeed)) {
				Usercmds.Neutralize(cmd);
				continue;
			}
			simulated++;
			if (Config.LogMovement && p.Script == null) {
				var bs = cmd.Base?.ButtonsPb;
				var subticks = string.Join(",", cmd.Base?.SubtickMoves.Select(s => $"{s.Button:X}{(s.Pressed ? "+" : "-")}@{s.When:0.00}") ?? []);
				Log($"[{p.Slot}] raw #{number} tick={cmd.Base?.ClientTick} held={bs?.Buttonstate1:X} changed={bs?.Buttonstate2:X} fwd={cmd.Base?.Forwardmove:0.00} left={cmd.Base?.Leftmove:0.00} subticks=[{subticks}]");
			}
			var input = Usercmds.Decode(cmd, _tickInterval, _movement.Settings.InputSpeed);
			p.LastInput = input;
			// How far ahead of the server's last answer the client draws its hero, in 1/256 ticks.
			p.PredictionTicks = (int)Math.Min(((cmd.Base?.PredictionOffsetTicksX256 ?? 0u) + 128u) / 256u, PredictionForecast.MaxTicks);
			TrackSync(p, input);
			_zones?.ApplySlide(p.State, _movement.Settings, _movement.World);
			var from = p.State.Origin;
			var result = _movement.Simulate(p.State, input);
			if (_probeSlot >= 0) LogProbe(p, cmd, number, pawn);
			Usercmds.Neutralize(cmd);
			var mapTeleport = false;
			if (_map != null) {
				p.SimTime += _tickInterval;
				var touch = _map.Touch(p.State, _movement.Settings, p.Triggers, p.SimTime);
				if (touch.Teleported) {
					mapTeleport = true;
					teleported = true;
					teleportAngles = touch.NewViewAngles;
					if (Config.LogMovement) Log($"[{p.Slot}] {touch.Reason} -> {Fmt(p.State.Origin)}");
				}
				if (_zones != null && p.Script == null) {
					var ev = p.Timer.Update(p.State, _movement.Settings, _zones, result.Jumped, _tickInterval);
					if (ev is { } e) OnRunEvent(p, args.Controller!, e);
				}
			}
			if (p.Script == null) p.Stats.Tick(p.State, input, from, result.Jumped, mapTeleport);
			if (Config.LogMovement) {
				Log($"[{p.Slot}] cmd fwd={input.ForwardMove:0} side={input.SideMove:0} btn={input.Buttons} yaw={input.ViewAngles.Y:0.0} " +
				    $"-> o={Fmt(p.State.Origin)} v={Fmt(p.State.Velocity)} spd={Speed2D(p.State.Velocity):0.0} g={p.State.GroundEntity}" +
				    (result.Jumped ? " JUMP" : "") + (result.Landed ? " LAND" : ""));
			}
		}
		if (simulated == 0) return;
		p.PendingCmds = simulated;

		if (teleported) {
			if (p.Script == null) TeleportTip(p, args.Controller);
			// A map teleport snaps the hero (and the view, when the destination sets one).
			if (teleportAngles is { } angles) pawn.TeleportWithView(p.State.Origin, angles);
			else pawn.Teleport(position: p.State.Origin);
			pawn.AbsVelocity = p.State.Velocity;
			p.NetworkVelocity = p.State.Velocity;
			return;
		}
		p.NetworkVelocity = NetworkVelocity(p);

		switch (Config.ApplyMethod) {
			case ApplyMethod.NoclipVelocity: {
				// The engine moves the hero velocity × tick once per usercmd; aim that at the simulated position.
				var steps = Math.Max(1, simulated);
				if (Config.ClientPrediction) {
					// The hero must be networked with one velocity throughout (some ticks are sent straight
					// after the engine runs these commands, others after OnGameFrame), so the engine moves
					// it with that velocity, from wherever that lands it on the simulated position.
					PlaceForMove(pawn, p.State.Origin - p.NetworkVelocity * (steps * _tickInterval), p.NetworkVelocity);
					break;
				}
				var delta = p.State.Origin - pawn.Position;
				pawn.AbsVelocity = delta / (steps * _tickInterval);
				break;
			}
			case ApplyMethod.Teleport:
				pawn.Teleport(position: p.State.Origin, velocity: p.State.Velocity);
				break;
		}
		p.LastSimulated = before;
	}

	/// <summary>
	/// Moves a hero without the teleport showing: Teleport also bumps the entity's interpolation
	/// counter, and every client that sees it change snaps the hero there instead of gliding, so done
	/// each tick, everyone else would see the player stutter. The counter is put back.
	/// </summary>
	private static void PlaceForMove(CCitadelPlayerPawn pawn, Vector3 position, Vector3 velocity) {
		var frame = pawn.GetField<byte>("CBaseEntity"u8, "m_ubInterpolationFrame"u8);
		pawn.Teleport(position: position, velocity: velocity);
		pawn.SetField<byte>("CBaseEntity"u8, "m_ubInterpolationFrame"u8, frame);
	}

	/// <summary>Movement for forecasting only (see PredictionForecast), so the real one's state is untouched.</summary>
	private CssMovement? _forecastMovement;
	private readonly System.Diagnostics.Stopwatch _forecastClock = new();
	private long _forecastTicks;

	/// <summary>The velocity a player's hero is networked with: see <see cref="BhopConfig.ClientPrediction"/>.</summary>
	private Vector3 NetworkVelocity(BhopPlayer p) {
		if (!Config.ClientPrediction || p.Script != null || p.PredictionTicks <= 0) return p.State.Velocity + p.State.BaseVelocity;
		var forecast = _forecastMovement ??= new CssMovement(_movement.Settings, _movement.World);
		forecast.Settings = _movement.Settings;
		forecast.World = _movement.World;
		_forecastClock.Start();
		var velocity = PredictionForecast.NetworkVelocity(forecast, p.State, p.LastInput, p.PredictionTicks);
		_forecastClock.Stop();
		_forecastTicks += Math.Min(p.PredictionTicks, PredictionForecast.MaxTicks);
		return velocity;
	}

	/// <summary>
	/// Strafe sync, as bhop timers measure it: of the airborne ticks where the view turns, the share
	/// turning toward the held strafe key (left with A, right with D).
	/// </summary>
	private static void TrackSync(BhopPlayer p, MoveInput input) {
		var yaw = input.ViewAngles.Y;
		var delta = yaw - p.LastYaw;
		if (delta > 180) delta -= 360;
		if (delta < -180) delta += 360;
		p.LastYaw = yaw;
		p.Keys = input.Buttons;
		if (p.State.OnGround || p.Timer.State != RunState.Running || MathF.Abs(delta) < 0.001f) return;
		var left = (input.Buttons & MoveButtons.MoveLeft) != 0;
		var right = (input.Buttons & MoveButtons.MoveRight) != 0;
		if (left == right) return;
		p.SyncTotal++;
		if ((left && delta > 0) || (right && delta < 0)) p.SyncGood++;
	}

	private int _hudTick;
	/// <summary>Each track's record, as the HUD shows it.</summary>
	private readonly Dictionary<int, string> _recordTexts = new();

	private readonly WorldHud _worldHud = new();

	private void UpdateHuds() {
		foreach (var p in _players) {
			if (p is not { Active: true } || p.Script != null) continue;
			var controller = Players.FromSlot(p.Slot);
			if (controller == null) continue;
			var finished = p.FinishedText != null && p.SimTime < p.FinishedUntil ? p.FinishedText : null;
			var speed = MathF.Sqrt(p.State.Velocity.X * p.State.Velocity.X + p.State.Velocity.Y * p.State.Velocity.Y);
			var sync = p.SyncTotal > 0 ? (int)MathF.Round(100f * p.SyncGood / p.SyncTotal) : 0;
			var track = p.Timer.Track;
			var state = new HudState(p.Timer.State, p.Timer.Time(_tickInterval), speed, p.Timer.Jumps, sync,
				p.PersonalBests.GetValueOrDefault(track), _recordTexts.GetValueOrDefault(track), StyleFor(track), p.Keys, finished);
			if (!Hud.Available(p.Slot)) {
				// No Deadworks client bootstrap (nothing installed): the timer in world text instead.
				if (controller.GetHeroPawn() is { } pawn) _worldHud.Show(p.Slot, pawn, WorldHud.Text(state with { Hint = Hint(p) }));
				continue;
			}
			_worldHud.Remove(p.Slot);
			if (!p.HudBuilt) {
				Hud.Build(controller);
				p.HudBuilt = true;
				p.HudKeys = MoveButtons.None;
			}
			var shown = p.HudKeys;
			Hud.Update(controller, state, ref shown);
			p.HudKeys = shown;
		}
	}

	/// <summary>
	/// How to play, under the timer, until the player has the hang of it. Of the first outside players
	/// on bhop_badges, none jumped more than 24 times; they walked onto its blocks, were sent back to
	/// the start five to nine times, and left. The welcome in chat is easily missed.
	/// </summary>
	private string? Hint(BhopPlayer p) {
		if (_freeFly || Config.Mode != MovementMode.Exact) return null;
		if (_mapName.StartsWith("surf_", StringComparison.OrdinalIgnoreCase))
			return p.Stats.TopSpeed < 700 ? "Land on a ramp's slope, hold A or D into it" : null;
		if (p.Stats.Jumps < 12) return _movement.Settings.AutoBhop ? "Hold SPACE: you hop as you land" : "Press SPACE as you land";
		if (p.Stats.TopSpeed < 400) return "In the air: A + mouse left, D + mouse right";
		return null;
	}

	/// <summary>
	/// Said in chat to a player who keeps being sent back while barely jumping: on multihop maps
	/// (badges, arcane, kz_ocean), standing on a block for a moment teleports you back.
	/// </summary>
	private static void TeleportTip(BhopPlayer p, CCitadelPlayerController? controller) {
		if (p.TeleportTipped || controller == null || p.Stats.MapTeleports < 2 || p.Stats.Jumps >= 30) return;
		p.TeleportTipped = true;
		Chat.PrintToChat(controller, "Sent back? Keep SPACE held the whole way: you hop again the moment you land. On maps like this one, standing on a block sends you back.");
	}

	private void RefreshRecords() {
		var store = _records ??= new RecordStore(RecordsDir);
		_recordTexts.Clear();
		foreach (var p in _players) p?.PersonalBests.Clear();
		foreach (var track in _zones?.Tracks ?? [0]) {
			var top = store.Top(_mapName, StyleFor(track));
			if (top.Count > 0) _recordTexts[track] = $"{RecordStore.Format(top[0].Time)} ({top[0].Name})";
			foreach (var p in _players) {
				if (p == null) continue;
				var id = Players.FromSlot(p.Slot)?.PlayerSteamId ?? 0;
				if (top.FirstOrDefault(r => r.SteamId == id) is { } best) p.PersonalBests[track] = best.Time;
			}
		}
	}

	private readonly List<Vector3> _playerSpots = new();

	private readonly System.Diagnostics.Stopwatch _drawClock = new();
	/// <summary>A frame of drawing worth logging: a sixth of a 64-tick frame.</summary>
	private const double DrawSlowMs = 2.5;
	private double _drawWorstMs;
	private int _drawFrames;
	private long _drawCreated, _drawRemoved;

	public override void OnGameFrame(bool simulating, bool firstTick, bool lastTick) {
		Tour();
		if (_renderer.Total > 0) {
			_drawClock.Restart();
			_playerSpots.Clear();
			// Details only around players whose client has had time to take in the course (see DetailDelaySeconds).
			var settled = Environment.TickCount64 - (long)(Config.DetailDelaySeconds * 1000);
			if (Config.StreamDetails)
				foreach (var p in _players)
					if (p is { Active: true } && _joinedAt[p.Slot] <= settled && _courseShownAt <= settled) _playerSpots.Add(p.State.Origin);
			if (_renderer.Tick(Config.PanelsPerFrame, _playerSpots, Config.DetailRadius) is { } line) Log($"{_mapName}: {line}");
			if (Config.BackFaceRadius > 0) CullBackFaces();
			// What drawing costs the server per frame (a 64-tick frame is 15.6 ms), checked every 30 s
			// and logged when something changed or a frame took long.
			_drawWorstMs = Math.Max(_drawWorstMs, _drawClock.Elapsed.TotalMilliseconds);
			if (++_drawFrames >= 64 * 30) {
				var churned = _renderer.Created != _drawCreated || _renderer.Removed != _drawRemoved;
				if (churned || _drawWorstMs >= DrawSlowMs) {
					var churn = churned ? $", {_renderer.Created - _drawCreated} created and {_renderer.Removed - _drawRemoved} removed since" : "";
					Log($"drawing {_mapName}: {_renderer.Spawned} panel entities ({_renderer.SpawnedBytes / 1024} KiB){churn}, worst frame {_drawWorstMs:0.0} ms");
				}
				_drawFrames = 0;
				_drawWorstMs = 0;
				_drawCreated = _renderer.Created;
				_drawRemoved = _renderer.Removed;
			}
		}
		if (!simulating || Config.Mode != MovementMode.Exact) return;
		if (++_hudTick % 6 == 0) UpdateHuds();
		if (_hudTick % (64 * 600) == 0 && _forecastTicks > 0) {
			// What client prediction costs the server, logged every 10 minutes while anyone predicts.
			Log($"prediction: {_forecastTicks} ticks forecast in the last 10 min, {_forecastClock.Elapsed.TotalMilliseconds:0} ms");
			_forecastTicks = 0;
			_forecastClock.Reset();
		}
		if (_freeFly) return; // the engine's noclip moves everyone
		foreach (var p in _players) {
			if (p is not { Active: true } || p.PendingCmds == 0) continue;
			var pawn = Players.FromSlot(p.Slot)?.GetHeroPawn();
			if (pawn == null) continue;
			var error = Vector3.Distance(pawn.Position, p.State.Origin);
			p.MaxError = MathF.Max(p.MaxError, error);
			if (Config.LogMovement && error > 0.5f) Log($"[{p.Slot}] hero at {Fmt(pawn.Position)}, simulated {Fmt(p.State.Origin)} (off by {error:0.00})");
			if (Config.ApplyMethod == ApplyMethod.NoclipVelocity) {
				// The client predicts its own hero in noclip, which with sv_noclipaccelerate and
				// sv_noclipfriction at 0 (both replicated) just carries the networked velocity forward:
				// network the one that makes that follow the simulation (NetworkVelocity), in place of
				// the catch-up velocity that moved the hero when clients don't predict.
				pawn.AbsVelocity = p.NetworkVelocity;
			}
			p.PendingCmds = 0;
		}
	}

	/// <summary>
	/// For each player, the drawn panels near their camera that face away from it: left out of what
	/// the player is sent (OnCheckTransmit), so panels are one-sided. The camera is where Deadlock's
	/// third-person camera sits for the hero's view; it doesn't collide with drawn courses.
	/// </summary>
	private void CullBackFaces() {
		foreach (var p in _players) {
			if (p == null) continue;
			var pawn = p.Active ? Players.FromSlot(p.Slot)?.GetHeroPawn() : null;
			if (pawn == null) {
				p.Culled.Clear();
				continue;
			}
			var a = pawn.ViewAngles;
			var (sp, cp) = MathF.SinCos(a.X * MathF.PI / 180f);
			var (sy, cy) = MathF.SinCos(a.Y * MathF.PI / 180f);
			var forward = new Vector3(cp * cy, cp * sy, -sp);
			var right = new Vector3(sy, -cy, 0);
			var camera = pawn.EyePosition - forward * Config.CameraBehind + right * Config.CameraRight;
			_renderer.BackFacing(camera, Config.BackFaceRadius, p.Culled);
		}
	}

	/// <summary>
	/// What a newcomer needs to know, in chat, once a visit. Players arrive from Deadlock's server
	/// browser expecting Deadlock, and most left within a minute without trying a run.
	/// </summary>
	private void Welcome(int slot) {
		if (_players[slot] is not { Active: true, Script: null } || Players.FromSlot(slot) is not { } controller) return;
		var surf = _mapName.StartsWith("surf_", StringComparison.OrdinalIgnoreCase);
		Chat.PrintToChat(controller, "Welcome! This server plays Counter-Strike: Source bunny hopping and surfing, on maps ported from CS:S. No abilities, just movement.");
		Chat.PrintToChat(controller, surf
			? "Surf: land on a ramp's slope, hold A or D toward the ramp to ride it, and steer with the mouse."
			: "Hold jump to keep hopping. In the air, hold A or D and turn the mouse the same way to gain speed.");
		Chat.PrintToChat(controller, "Type !r to go back to the start, !top for the fastest times.");
	}

	private void Activate(BhopPlayer p, CCitadelPlayerPawn pawn) {
		p.State = new PlayerMoveState();
		p.Triggers = new TriggerState();
		Vector3? viewAngles = null;
		if (_map?.Spawn is { } spawn) {
			// A ported map starts players at its own spawn, in its own collision.
			p.State.Teleport(spawn.Origin.ToVector3(), Vector3.Zero);
			viewAngles = new Vector3(0, spawn.Angles.Y, 0);
		} else {
			p.State.Teleport(pawn.Position, Vector3.Zero);
		}
		// Deadlock rests heroes slightly inside the floor; a CS:S box starting there would be stuck.
		_engineWorld.IgnoreEntity = pawn.EntityIndex;
		if (!_movement.Unstick(p.State)) Log($"[{p.Slot}] spawned stuck at {Fmt(p.State.Origin)}");
		p.Spawn = p.State.Origin;
		p.SpawnAngles = viewAngles;
		if (!p.ResumeInPlace && _zones?.StartOf(0) is { Teleport: { } start } startZone) {
			// Start in the start zone, as bhop servers do, rather than at the map's spawn: some
			// spawns face a wall, or lie away from the course with nothing to say where it begins.
			p.State.Teleport(start.ToVector3(), Vector3.Zero);
			_movement.Unstick(p.State);
			if (startZone.TeleportYaw is { } yaw) viewAngles = new Vector3(0, yaw, 0);
		}
		if (p.ResumeInPlace) {
			// After a plugin reload: remember the spawn for !spawn, but keep the player where they are.
			p.ResumeInPlace = false;
			p.State.Teleport(pawn.Position, Vector3.Zero);
			_movement.Unstick(p.State);
			viewAngles = null;
		}
		p.Active = true;
		p.Stats.Moved();
		p.MaxError = 0;
		p.ScriptTick = 0;
		p.HudBuilt = false;
		if (p.Script == null) RefreshRecords();
		if (p.Script == null && _map != null && p.GreetedMap != _mapName) {
			// Credit the map's authors to everyone who plays it.
			p.GreetedMap = _mapName;
			var by = _map.Data.Credits.Count > 0 ? "by " + string.Join(", ", _map.Data.Credits) : "Ported CS:S bhop map";
			pawn.Controller?.HudAnnounce(_mapName, by);
		}
		if (p.Script == null && !p.Welcomed) {
			p.Welcomed = true;
			var slot = p.Slot;
			Timer.Once(4.Seconds(), () => Welcome(slot));
		}
		pawn.SetMoveType(Config.ApplyMethod == ApplyMethod.Teleport ? MoveType.None : MoveType.NoClip);
		pawn.SetGravityScale(0f);
		// Ported maps can be far bigger than Deadlock's play area (bhop_arcane spans 30,000 units),
		// and the game then flags the player as out of bounds every tick.
		if (_map != null) {
			try {
				pawn.AddModifier("modifier_citadel_ignore_out_of_play_area");
			} catch (Exception ex) {
				Log($"[{p.Slot}] could not add the out-of-play-area exemption: {ex.Message}");
			}
		}
		if (viewAngles is { } a) pawn.TeleportWithView(p.State.Origin, a);
		else pawn.Teleport(position: p.State.Origin);
		pawn.AbsVelocity = Vector3.Zero;
		// Heroes respawn two or three times as a player joins; one line says it.
		var activated = $"exact movement on at {Fmt(p.State.Origin)}{(_map != null ? $" on {_map.Data.Name}" : "")}, tick {_tickInterval * 1000:0.000} ms";
		if (activated != p.LastActivation) Log($"[{p.Slot}] {activated}");
		p.LastActivation = activated;
	}

	// ------------------------------------------------------------------ timer and records

	private ZoneSet? _zones;
	private RecordStore? _records;
	private string _mapName = "";

	private string Style => Config.Mode == MovementMode.Exact
		? $"exact aa{_movement.Settings.AirAccelerate:0}{(_movement.Settings.AutoBhop ? "" : " scroll")}"
		: "native";

	/// <summary>The style records are kept under: bonus courses have their own leaderboards.</summary>
	private string StyleFor(int track) => track > 0 ? $"{Style} bonus {track}" : Style;

	private string Course(int track) => track > 0 ? $"{_mapName} (bonus {track})" : _mapName;

	private void OnRunEvent(BhopPlayer p, CCitadelPlayerController controller, RunEvent e) {
		switch (e.Kind) {
			case RunEventKind.Started:
				p.SyncGood = p.SyncTotal = 0;
				p.FinishedText = null;
				p.Stats.RunStarted();
				if (Config.LogMovement) Log($"[{p.Slot}] run started at {e.Speed:0} u/s");
				break;
			case RunEventKind.Checkpoint:
				p.Stats.Checkpoint(e.Checkpoint);
				controller.HudAnnounce($"Checkpoint {e.Checkpoint}", RecordStore.Format(e.Time));
				break;
			case RunEventKind.Stopped:
				// bhoptimer's stop zones: the map marks this spot as off the course.
				Chat.PrintToChat(controller, "Your timer was stopped: this area is off the course.");
				break;
			case RunEventKind.Finished: {
				var run = new RunRecord {
					SteamId = controller.PlayerSteamId, Name = controller.PlayerName, Time = e.Time,
					Jumps = e.Jumps, MaxSpeed = p.Timer.MaxSpeed, Style = StyleFor(e.Track),
				};
				var result = (_records ??= new RecordStore(RecordsDir)).Submit(_mapName, run);
				p.Stats.Finished();
				var time = RecordStore.Format(e.Time);
				var detail = result.MapRecord ? "New map record!"
					: result.PersonalBest ? (result.PreviousBest is { } prev ? $"Personal best, {RecordStore.Format(prev - e.Time)} faster. Rank {result.Rank}" : $"First finish. Rank {result.Rank}")
					: $"Personal best {RecordStore.Format(result.PreviousBest ?? e.Time)}";
				controller.HudAnnounce($"Finished in {time}", detail);
				Chat.PrintToChatAll($"{run.Name} finished {Course(e.Track)} in {time} ({e.Jumps} jumps). {detail}");
				Log($"[{p.Slot}] {run.Name} finished {Course(e.Track)} in {time}, {e.Jumps} jumps, max {p.Timer.MaxSpeed:0} u/s, {run.Style}: {detail}");
				LastFinish = (run, result);
				p.FinishedText = $"Finished {time}";
				p.FinishedUntil = p.SimTime + 4f;
				RefreshRecords();
				Emit("bhop.run_finished", new Dictionary<string, object> {
					["map"] = _mapName, ["style"] = run.Style, ["steamId64"] = run.SteamId.ToString(System.Globalization.CultureInfo.InvariantCulture),
					["name"] = run.Name, ["time"] = run.Time, ["jumps"] = run.Jumps, ["maxSpeed"] = run.MaxSpeed,
					["track"] = e.Track,
				});
				break;
			}
		}
	}

	/// <summary>
	/// Publishes an event to citadel-host host plugins through the OpenCitadel bridge's ocemit command
	/// (a no-op when the bridge isn't installed). The payload travels base64-encoded so the console
	/// doesn't split the JSON.
	/// </summary>
	private static void Emit(string name, Dictionary<string, object> payload) {
		var json = System.Text.Json.JsonSerializer.Serialize(payload);
		Server.ExecuteCommand($"dw_ocemit {name} {Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(json))}");
	}

	// ------------------------------------------------------------------ zone outlines

	private readonly List<CBeam> _zoneBeams = new();

	/// <summary>
	/// Outlines the timer zones with glowing beams the way bhop servers do: green start, red end
	/// (paler for bonuses), yellow checkpoints. Stop and slide zones stay invisible, as in bhoptimer.
	/// Redrawn whenever zones change; beams vanish by themselves on map change.
	/// </summary>
	private void DrawZones() {
		CBeam.RemoveAll(_zoneBeams);
		if (_zones == null || Config.ZoneBeamWidth <= 0) return;
		foreach (var z in _zones.Zones) {
			var bonus = z.Track > 0;
			System.Drawing.Color? shown = z.Kind switch {
				ZoneKind.Start => bonus ? System.Drawing.Color.FromArgb(255, 150, 255, 170) : System.Drawing.Color.FromArgb(255, 40, 255, 80),
				ZoneKind.End => bonus ? System.Drawing.Color.FromArgb(255, 255, 150, 150) : System.Drawing.Color.FromArgb(255, 255, 50, 50),
				ZoneKind.Checkpoint or ZoneKind.Stage => System.Drawing.Color.FromArgb(255, 255, 210, 40),
				_ => null,
			};
			if (shown is not { } color) continue;
			// Lift the floor edges a little so they don't sink into the ground they sit on.
			var mins = z.Mins.ToVector3() + new Vector3(0, 0, 2);
			_zoneBeams.AddRange(CBeam.CreateBox(mins, z.Maxs.ToVector3(), Config.ZoneBeamWidth, color));
		}
	}

	/// <summary>Draws the zones once the map's entities exist.</summary>
	private void DrawZonesSoon() => Timer.Once(1.Seconds(), DrawZones);

	/// <summary>
	/// Zone outlines left by a version of the plugin that didn't remove them when unloaded: every
	/// reload left a set, each sent to every player who joins. Told apart from the map's own beams by width.
	/// </summary>
	private void RemoveOldZoneBeams() {
		var removed = 0;
		foreach (var beam in Entities.ByDesignerName("env_beam").ToList()) {
			// Deadworks doesn't resolve env_beam to CBeam here, so the width is read from the schema.
			if (!beam.IsValid || MathF.Abs(beam.GetField<float>("CBeam"u8, "m_fWidth"u8) - Config.ZoneBeamWidth) > 0.01f) continue;
			beam.Remove();
			removed++;
		}
		if (removed > 0) Log($"removed {removed} zone beams left by an earlier load");
	}

	/// <summary>The most recent finished run.</summary>
	internal (RunRecord Run, RecordResult Result)? LastFinish { get; private set; }

	private string RecordsDir => Path.GetFullPath(Path.Combine(Config.MapDataDir, "..", "records"));
	private string ZonesPath(string map) => Path.GetFullPath(Path.Combine(Config.MapDataDir, "..", "zones", $"{map}.zones.json"));

	/// <summary>A map's zone file, moved by the course's lift (files keep the map's own coordinates).</summary>
	private List<MapZone>? LoadZones(string map) {
		var path = ZonesPath(map);
		if (!File.Exists(path)) return null;
		try {
			var json = File.ReadAllText(path);
			// A zone file from a bhoptimer server (or github.com/srcwr/zones) works as it is.
			var zones = BhoptimerZones.IsBhoptimerJson(json)
				? BhoptimerZones.Parse(json).Zones
				: System.Text.Json.JsonSerializer.Deserialize<List<MapZone>>(json, BhopMapData.Json);
			foreach (var z in zones ?? []) z.Translate(_offset);
			return zones;
		} catch (Exception ex) when (ex is IOException or System.Text.Json.JsonException or InvalidDataException) {
			Log($"could not read zones {path}: {ex.Message}");
			return null;
		}
	}

	private void SaveZones(string map, IEnumerable<MapZone> zones) {
		var path = ZonesPath(map);
		Directory.CreateDirectory(Path.GetDirectoryName(path)!);
		// Back to the map's own coordinates, so the file stays right however the course is placed.
		var saved = zones.Select(z => {
			var copy = new MapZone { Kind = z.Kind, Index = z.Index, Track = z.Track, Mins = z.Mins, Maxs = z.Maxs, Teleport = z.Teleport, TeleportYaw = z.TeleportYaw };
			copy.Translate(-_offset);
			return copy;
		}).ToList();
		File.WriteAllText(path, System.Text.Json.JsonSerializer.Serialize(saved, BhopMapData.Json));
	}

	[Command("top", Description = "Fastest times on this map (or on the bonus you are running)")]
	public void CmdTop(CCitadelPlayerController caller) {
		_players[caller.Slot]?.Stats.Used("top");
		var track = _players[caller.Slot]?.Timer.Track ?? 0;
		var top = (_records ??= new RecordStore(RecordsDir)).Top(_mapName, StyleFor(track)).Take(10).ToList();
		var lines = top.Count == 0 ? ["No times yet."] : top.Select((r, i) => $"{i + 1}. {RecordStore.Format(r.Time)}  {r.Name}  ({r.Jumps} jumps)").ToList();
		foreach (var line in lines) caller.PrintToConsole(line);
		caller.HudAnnounce($"{Course(track)}: top {top.Count}", string.Join("  ", lines.Take(3)));
	}

	/// <summary>
	/// Zone editing for admins: stand at one corner and run "zone start a", at the opposite corner
	/// "zone start b" (likewise end, or "cp 1" for checkpoint 1); "zone clear" and "zone list".
	/// The box spans the two corners and reaches 128 units above the higher one. Zones are saved per
	/// map next to the map data.
	/// </summary>
	[Command("zone", Description = "Edit timer zones: zone start|end|cp <n> a|b, zone clear, zone list", Permission = "bhop.zones")]
	public void CmdZone(CCitadelPlayerController caller, string kind, string arg = "", string corner = "") {
		if (_map == null) {
			caller.PrintToConsole("No ported map loaded.");
			return;
		}
		var zones = (LoadZones(_mapName) ?? _map.Data.Zones).ToList();
		if (kind == "list") {
			foreach (var z in zones) caller.PrintToConsole($"{(z.Track > 0 ? $"bonus {z.Track} " : "")}{z.Kind} {z.Index}: {z.Mins} .. {z.Maxs}");
			if (zones.Count == 0) caller.PrintToConsole("No zones; the start zone is made up around the spawns.");
			return;
		}
		if (kind == "clear") {
			SaveZones(_mapName, []);
			_zones = ZoneSet.For(_map.Data, []);
			DrawZones();
			caller.PrintToConsole("Zones cleared.");
			return;
		}
		var zoneKind = kind switch { "start" => ZoneKind.Start, "end" => ZoneKind.End, "cp" => ZoneKind.Checkpoint, _ => (ZoneKind?)null };
		if (zoneKind == null) {
			caller.PrintToConsole("usage: zone start|end a|b, zone cp <n> a|b, zone clear, zone list");
			return;
		}
		var index = 0;
		if (zoneKind == ZoneKind.Checkpoint) {
			if (!int.TryParse(arg, out index)) {
				caller.PrintToConsole("usage: zone cp <n> a|b");
				return;
			}
		} else {
			corner = arg;
		}
		if (_players[caller.Slot] is not { Active: true } p) return;
		var pos = p.State.Origin;
		var key = (zoneKind.Value, index);
		if (corner == "a") {
			p.ZoneCorner = (key, pos);
			caller.PrintToConsole($"Corner A of {zoneKind} {index} at {Fmt(pos)}. Now the opposite corner: b.");
			return;
		}
		if (corner != "b" || p.ZoneCorner is not { } first || first.Key != key) {
			caller.PrintToConsole("Set corner a first, then b.");
			return;
		}
		var mins = Vector3.Min(first.Pos, pos);
		var maxs = Vector3.Max(first.Pos, pos) + new Vector3(0, 0, 128);
		zones.RemoveAll(z => z.Kind == zoneKind && z.Index == index && z.Track == 0); // drawn zones are the main course's
		zones.Add(new MapZone {
			Kind = zoneKind.Value, Index = index, Mins = Vec3.From(mins), Maxs = Vec3.From(maxs),
			Teleport = zoneKind == ZoneKind.Start ? new Vec3((mins.X + maxs.X) * 0.5f, (mins.Y + maxs.Y) * 0.5f, mins.Z) : null,
		});
		SaveZones(_mapName, zones);
		_zones = ZoneSet.For(_map.Data, zones);
		DrawZones();
		p.ZoneCorner = null;
		caller.PrintToConsole($"Saved {zoneKind} {index}: {Fmt(mins)} .. {Fmt(maxs)}");
		Log($"zones for {_mapName} updated by {caller.PlayerName}: {zoneKind} {index}");
	}

	// ------------------------------------------------------------------ maps

	private MapRuntime? _map;
	private readonly CourseRenderer _renderer = new();
	/// <summary>How far the current course is moved from its own coordinates (lifted clear of the Deadlock map it is drawn into).</summary>
	private Vector3 _offset;
	/// <summary>A course load waiting for the Deadlock map's collision (see <see cref="LoadMapData"/>).</summary>
	private IHandle? _retryLoad;
	private int _boundsTries;
	/// <summary>When the current course started being drawn (Environment.TickCount64).</summary>
	private long _courseShownAt;

	/// <summary>Where ported map data lives: &lt;map&gt;.bhop.json.gz files.</summary>
	private string MapDataDir => Path.GetFullPath(Config.MapDataDir);

	/// <summary>
	/// Loads a map's bhop data: for the running map itself (from its package, or a loose file), or a
	/// course run on another map (a stock Deadlock map, so players need nothing installed). A course
	/// on another map is lifted clear of it and drawn with stock content.
	/// </summary>
	private void LoadMapData(string mapName) {
		_retryLoad?.Cancel(); // a newer course wins over one still waiting for the map
		_retryLoad = null;
		_map = null;
		_zones = null;
		_mapName = mapName;
		_offset = Vector3.Zero;
		_renderer.Clear();
		_movement.World = _engineWorld;
		// A ported map carries its data inside its own package; a loose file overrides it (for testing).
		var loose = Path.Combine(MapDataDir, $"{mapName}.bhop.json.gz");
		var package = Path.GetFullPath(Path.Combine(Config.GameDir, "citadel", "maps", $"{mapName}.vpk"));
		var drawnCourse = "";
		try {
			BhopMapData? data = null;
			if (File.Exists(loose)) data = BhopMapData.Load(loose);
			else if (File.Exists(package)) data = BhopMapData.LoadFromPackage(package, mapName);
			if (data == null) {
				Log($"no bhop data for {mapName} (looked in {package} and {loose}); colliding with the Deadlock map itself");
				foreach (var p in _players) if (p != null) p.Active = false;
				return;
			}
			var drawn = !data.Name.Equals(Server.MapName, StringComparison.OrdinalIgnoreCase);
			if (drawn && DeadlockMapBounds() == null && ++_boundsTries <= 20) {
				// Right after the server starts, the map's collision isn't there to measure yet, and a
				// course placed without it would be drawn through the map.
				Log($"{Server.MapName}'s collision isn't loaded yet: {data.Name} in a second");
				_retryLoad = Timer.Once(1.Seconds(), () => LoadMapData(mapName));
				return;
			}
			_boundsTries = 0;
			if (drawn && data.Bounds() is { } bounds) {
				_offset = CoursePlacement.Choose(bounds, DeadlockMapBounds(), Config.CourseMargin);
				data.Translate(_offset);
			}
			_map = new MapRuntime(data);
			_movement.World = _map.World;
			_movement.Settings = MovementFor(data.Name);
			_mapName = data.Name;
			_zones = ZoneSet.For(data, LoadZones(data.Name));
			if (drawn) {
				if (Config.DrawCourses) _renderer.Show(data.Panels, Config.MaxPanelKilobytes * 1024L, Config.MaxPanelEntities, Config.FixedPanelShare, Config.StreamDetails);
				_courseShownAt = Environment.TickCount64;
				Log($"{data.Name} runs on {Server.MapName}, moved by {Fmt(_offset)}" +
				    (!Config.DrawCourses ? "; not drawn (DrawCourses is off)"
					    : _renderer.Fixed < _renderer.Rows ? $"; {data.Panels.Count} panels as {_renderer.Rows} entities ({_renderer.TotalBytes / 1024} KiB), over the budget of " +
					                            $"{Config.MaxPanelKilobytes} KiB or {Config.MaxPanelEntities} entities: the largest {_renderer.Fixed} ({_renderer.FixedBytes / 1024} KiB) " +
					                            (Config.StreamDetails ? $"drawn, the rest streamed within {Config.DetailRadius:0} units of players" : "drawn, the rest left out (StreamDetails is off)")
					    : $"; drawing {data.Panels.Count} panels as {_renderer.Total} entities ({_renderer.TotalBytes / 1024} KiB)"));
				if (Config.DrawCourses && data.Panels.Count == 0) Log($"{data.Name} has no panels: port it again with citadel-port course so players see it");
				// Tell OpenCitadel's bridge (if installed) which map players are on, for listings and rotation.
				Server.ExecuteCommand($"dw_ocmap {data.Name}");
				drawnCourse = data.Name;
			}
			Log($"zones: {string.Join(", ", _zones.Zones.Select(z => $"{(z.Track > 0 ? $"bonus {z.Track} " : "")}{z.Kind}{(z.Kind == ZoneKind.Checkpoint ? z.Index.ToString() : "")}"))}" +
			    (_zones.End == null ? " (no end zone yet: an admin can draw one with \"dw_zone end a|b\")" : ""));
			Log($"loaded {data.Name}: {data.Models.Sum(m => m.Brushes.Count)} brushes, {data.Triggers.Count} triggers, " +
			    $"{data.Spawns.Count} spawns{(data.Credits.Count > 0 ? $"; by {string.Join(", ", data.Credits)}" : "")}; " +
			    $"airaccelerate {_movement.Settings.AirAccelerate}");
		} catch (Exception ex) when (ex is IOException or InvalidDataException or System.Text.Json.JsonException) {
			Log($"could not load bhop data for {mapName}: {ex.Message}");
		}
		if (_map == null) _movement.World = _engineWorld;
		foreach (var p in _players) {
			if (p == null) continue;
			// Everyone starts over on the new map: from its spawn, with no run going.
			p.Active = false;
			p.Timer.Reset();
			p.Triggers = new TriggerState();
			p.Culled.Clear();
		}
		RememberCourse(drawnCourse);
		DrawZonesSoon();
		RefreshRecords();
	}

	/// <summary>
	/// Where the course being drawn is noted, "&lt;Deadlock map&gt; &lt;course&gt;", so that a plugin reload
	/// carries on with it rather than with <see cref="BhopConfig.Course"/> (the server's first course).
	/// </summary>
	private string CoursePath => Path.GetFullPath(Path.Combine(Config.MapDataDir, "..", "current-course.txt"));

	private void RememberCourse(string course) {
		try {
			File.WriteAllText(CoursePath, $"{Server.MapName} {course}".TrimEnd());
		} catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) {
			Log($"could not note the current course: {ex.Message}");
		}
	}

	/// <summary>The course that was drawn into the running Deadlock map before a reload, if any.</summary>
	private string? RememberedCourse() {
		try {
			var parts = File.ReadAllText(CoursePath).Split(' ', StringSplitOptions.RemoveEmptyEntries);
			return parts.Length == 2 && parts[0].Equals(Server.MapName, StringComparison.OrdinalIgnoreCase) ? parts[1] : null;
		} catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) {
			return null;
		}
	}

	private (Vector3 Mins, Vector3 Maxs)? _mapBounds;
	private string _mapBoundsOf = "";

	/// <summary>
	/// Where the running Deadlock map's own geometry is, from rays cast straight down on a grid over
	/// the whole world (measured once per map). Courses drawn into the map keep clear of it.
	/// </summary>
	private (Vector3 Mins, Vector3 Maxs)? DeadlockMapBounds() {
		if (_mapBoundsOf == Server.MapName && _mapBounds != null) return _mapBounds; // a miss is measured again
		_mapBoundsOf = Server.MapName;
		var mins = new Vector3(float.MaxValue);
		var maxs = new Vector3(float.MinValue);
		var hits = 0;
		for (var x = -32000f; x <= 32000f; x += 1000f)
		for (var y = -32000f; y <= 32000f; y += 1000f) {
			// From above (maps have invisible lids over them) and from below (the ground's underside).
			foreach (var (from, to) in ((float, float)[])[(16000f, -16000f), (-16000f, 16000f)]) {
				var ray = DeadworksManaged.Api.Trace.Ray(new Vector3(x, y, from), new Vector3(x, y, to));
				if (!ray.DidHit) continue;
				hits++;
				mins = Vector3.Min(mins, ray.HitPosition);
				maxs = Vector3.Max(maxs, ray.HitPosition);
			}
		}
		// Rays a grid step apart can miss an edge; the ground is the lowest top surface.
		_mapBounds = hits == 0 ? null : (mins - new Vector3(1000, 1000, 500), maxs + new Vector3(1000, 1000, 0));
		Log(_mapBounds is { } b ? $"{Server.MapName} fills {Fmt(b.Mins)} .. {Fmt(b.Maxs)} ({hits} rays hit)" : $"{Server.MapName}: no geometry found");
		return _mapBounds;
	}

	/// <summary>
	/// Switches the course without changing the Deadlock map: the server keeps running a stock map
	/// that every player has, and the course is drawn into it. citadel-host's map rotation uses it
	/// (game.mapChange "command").
	/// </summary>
	[Command("bhopmap", Description = "Switch to another course in place: bhopmap <map> (off: back to the Deadlock map)", Permission = "bhop.map")]
	public void CmdMap(Caller caller, string name) {
		if (name is "off" or "none") {
			LoadMapData(Server.MapName);
			Log("course off");
			return;
		}
		if (!System.Text.RegularExpressions.Regex.IsMatch(name, "^[A-Za-z0-9_]+$")) {
			caller.Reply("Usage: bhopmap <map>");
			return;
		}
		var before = _mapName;
		LoadMapData(name);
		if (_retryLoad != null) {
			Log($"course {name} by {caller}, once the Deadlock map has loaded");
			return;
		}
		if (_map == null) {
			caller.Reply($"There is no course called {name}.");
			if (before != name && before.Length > 0) LoadMapData(before);
			return;
		}
		foreach (var p in _players) if (p != null) p.ResumeInPlace = false;
		Chat.PrintToChatAll($"Map: {_mapName}" + (_map.Data.Credits.Count > 0 ? $" by {string.Join(", ", _map.Data.Credits)}" : ""));
		Log($"course {_mapName} by {caller}");
	}

	// ------------------------------------------------------------------ commands

	[Command("r", "restart", Description = "Back to the start")]
	public void CmdRestart(CCitadelPlayerController caller) {
		_players[caller.Slot]?.Stats.Used("r");
		SendToStart(caller, 0);
	}

	[Command("b", "bonus", Description = "To a bonus course's start: b [number]")]
	public void CmdBonus(CCitadelPlayerController caller, int bonus = 1) {
		_players[caller.Slot]?.Stats.Used("b");
		if (_zones?.StartOf(bonus) == null || bonus < 1) {
			var bonuses = _zones?.Tracks.Where(t => t > 0).ToList() ?? [];
			Chat.PrintToChat(caller, bonuses.Count == 0 ? $"{_mapName} has no bonus." : $"Bonuses on {_mapName}: {string.Join(", ", bonuses)}.");
			return;
		}
		SendToStart(caller, bonus);
	}

	[Command("spawn", Description = "Back to where you spawned on this map (not the start zone)")]
	public void CmdSpawn(CCitadelPlayerController caller) {
		if (_players[caller.Slot] is not { Active: true } p) return;
		p.Stats.Used("spawn");
		SendTo(caller, p, p.Spawn, p.SpawnAngles);
	}

	private void SendToStart(CCitadelPlayerController caller, int track) {
		if (_players[caller.Slot] is not { Active: true } p) return;
		var start = _zones?.StartOf(track);
		var target = start?.Teleport?.ToVector3() ?? p.Spawn;
		Vector3? angles = start?.TeleportYaw is { } yaw ? new Vector3(0, yaw, 0) : track == 0 ? p.SpawnAngles : null;
		SendTo(caller, p, target, angles);
	}

	/// <summary>Moves a player (and their simulated state) somewhere, stopping their run.</summary>
	private void SendTo(CCitadelPlayerController caller, BhopPlayer p, Vector3 target, Vector3? angles) {
		p.Stats.Moved();
		p.State.Teleport(target, Vector3.Zero);
		_movement.Unstick(p.State);
		p.Triggers = new TriggerState();
		p.Timer.Reset();
		var pawn = caller.GetHeroPawn();
		if (pawn == null) return;
		if (angles is { } a) pawn.TeleportWithView(p.State.Origin, a);
		else pawn.Teleport(position: p.State.Origin, velocity: Vector3.Zero);
		pawn.AbsVelocity = Vector3.Zero;
	}

	[Command("bhopmode", Description = "Switch movement mode for everyone: exact or native", Permission = "bhop.mode")]
	public void CmdMode(CCitadelPlayerController caller, string mode) {
		if (!Enum.TryParse<MovementMode>(mode, ignoreCase: true, out var m)) {
			Chat.PrintToChat(caller, "usage: !bhopmode exact|native");
			return;
		}
		Config.Mode = m;
		ApplyConVars();
		foreach (var p in _players) {
			if (p == null) continue;
			p.Active = false;
			var pawn = Players.FromSlot(p.Slot)?.GetHeroPawn();
			if (pawn == null || m != MovementMode.Native) continue;
			pawn.SetMoveType(MoveType.Walk);
			pawn.SetGravityScale(1f);
		}
		Chat.PrintToChatAll($"Movement mode: {m}");
		Log($"mode switched to {m} by slot {caller.Slot}");
	}

	[Command("bhopapply", Description = "How exact mode moves the hero, for everyone: teleport or noclip", Permission = "bhop.mode")]
	public void CmdApply(CCitadelPlayerController caller, string method) {
		ApplyMethod m;
		if (method.StartsWith("tele", StringComparison.OrdinalIgnoreCase)) m = ApplyMethod.Teleport;
		else if (method.StartsWith("noclip", StringComparison.OrdinalIgnoreCase)) m = ApplyMethod.NoclipVelocity;
		else {
			Chat.PrintToChat(caller, "usage: !bhopapply teleport|noclip");
			return;
		}
		Config.ApplyMethod = m;
		foreach (var p in _players) if (p != null) p.Active = false;
		Chat.PrintToChatAll($"Exact mode now applies movement by {m}");
		Log($"apply method switched to {m} by slot {caller.Slot}");
	}

	[Command("cam", Description = "Camera test: cam <distance> [fov] [vertical offset]")]
	public void CmdCam(CCitadelPlayerController caller, float distance, float fov = 0f, float vertical = 0f) {
		var camera = caller.Camera;
		camera.Clear();
		camera.LerpDistance(150f, distance, 0.3f);
		camera.Maintain(CameraSetting.Distance, 3600f, delay: 0.3f);
		if (fov > 0) {
			camera.LerpFov(90f, fov, 0.3f);
			camera.Maintain(CameraSetting.Fov, 3600f, delay: 0.3f);
		}
		if (vertical != 0) {
			camera.Lerp(CameraSetting.VerticalOffset, 0f, vertical, 0.3f);
			camera.Maintain(CameraSetting.VerticalOffset, 3600f, delay: 0.3f);
		}
		Log($"[{caller.Slot}] camera distance {distance}, fov {fov}, vertical {vertical}");
	}

	[Command("fp", Description = "First-person camera")]
	public void CmdFirstPerson(CCitadelPlayerController caller) => SetFirstPerson(caller, true);

	[Command("tp", Description = "Third-person camera")]
	public void CmdThirdPerson(CCitadelPlayerController caller) => SetFirstPerson(caller, false);

	[Command("bhopstat", Description = "Show movement state")]
	public void CmdStat(CCitadelPlayerController caller) {
		if (_players[caller.Slot] is not { } p) return;
		var pawn = caller.GetHeroPawn();
		var msg = $"sim {Fmt(p.State.Origin)} spd {Speed2D(p.State.Velocity):0.0} ground {p.State.GroundEntity} | hero {Fmt(pawn?.Position ?? default)} " +
		          $"| max error {p.MaxError:0.00} | tick {_tickInterval * 1000:0.000} ms";
		Chat.PrintToChat(caller, msg);
		Log($"[{p.Slot}] {msg}");
	}

	private long _tourUntil;
	private int _tourTicks;
	private readonly Random _tourRandom = new(1);

	/// <summary>
	/// For testing clients under load: moves every player to a random spot of the course four times a
	/// second, so a streamed course swaps its details around them far faster than real play does.
	/// </summary>
	[Command("bhoptour", Description = "Testing: send every player to random spots of the course for a while: bhoptour <seconds>", ServerOnly = true)]
	public void CmdTour(int seconds) {
		_tourUntil = seconds > 0 ? Environment.TickCount64 + seconds * 1000L : 0;
		Log(seconds > 0 ? $"touring {_mapName} for {seconds} s" : "tour stopped");
	}

	private void Tour() {
		if (_tourUntil == 0 || _map == null || ++_tourTicks % 16 != 0) return;
		if (Environment.TickCount64 > _tourUntil) {
			_tourUntil = 0;
			Log("tour over");
			return;
		}
		var panels = _map.Data.Panels;
		if (panels.Count == 0) return;
		foreach (var p in _players) {
			if (p is not { Active: true } || Players.FromSlot(p.Slot) is not { } controller) continue;
			SendTo(controller, p, panels[_tourRandom.Next(panels.Count)].Origin.ToVector3() + new Vector3(0, 0, 100), null);
		}
	}

	private int _probeSlot = -1;
	private long _probeUntil;

	/// <summary>
	/// For measuring what a player sees: throws the first player upward and logs, for every command
	/// their client sends, the simulated height beside the height of the camera the client drew that
	/// frame from, how many ticks ahead the client predicts, and the velocity the hero is networked
	/// with. With prediction off, the camera curve trails the simulated one by the client's delay.
	/// With it on, launch the client with +cl_showerror 2 and -condebug: its console.log lists every
	/// prediction miss (the throw itself is one, being nothing the client could foresee).
	/// </summary>
	[Command("bhopprobe", Description = "Testing: throw the first player upward and log where their client draws them: bhopprobe <speed> [seconds]", ServerOnly = true)]
	public void CmdProbe(float speed, float seconds = 2f) {
		if (_players.FirstOrDefault(p => p is { Active: true, Script: null }) is not { } p) {
			Log("probe: no player");
			return;
		}
		p.State.Velocity = new Vector3(0, 0, speed);
		p.State.GroundEntity = -1;
		_probeSlot = p.Slot;
		_probeUntil = Environment.TickCount64 + (long)(seconds * 1000);
		Log($"probe: [{p.Slot}] thrown up at {speed} u/s from z {p.State.Origin.Z:0.0}");
	}

	private void LogProbe(BhopPlayer p, CCitadelUserCmdPB cmd, int number, CCitadelPlayerPawn pawn) {
		if (_probeSlot != p.Slot) return;
		if (Environment.TickCount64 > _probeUntil) {
			_probeSlot = -1;
			Log("probe over");
			return;
		}
		var camera = cmd.VecCameraPosition;
		Log($"probe #{number} sim {p.State.Origin.Z:0.0} hero {pawn.Position.Z:0.0} camera {(camera != null ? camera.Z.ToString("0.0") : "-")} at {Environment.TickCount64 % 100000} " +
		    $"predicting {cmd.Base?.PredictionOffsetTicksX256 / 256f:0.00} ticks, networked {p.NetworkVelocity.Z:0.0}, simulated {p.State.Velocity.Z:0.0}");
	}

	/// <summary>
	/// Spawns an entity next to the first player, following them, to try stock entities live:
	/// keyvalues as key=value|key=value; a value of three or four numbers split by commas is a colour,
	/// a whole number an int, a number a float, anything else a string. "clear" removes them all.
	/// Only with nobody else on the server: some stock classes crash every client that is sent them
	/// (light_omni or light_dynamic did, build 6848).
	/// </summary>
	[Command("bhopent", Description = "Testing: spawn an entity by the first player: bhopent <class|clear> [back] [up] [key=value|...]", ServerOnly = true)]
	public void CmdEnt(string classname, float back = 0f, float up = 0f, string keyvalues = "") {
		const string name = "bhop_test";
		if (classname == "clear") {
			foreach (var old in Entities.ByName(name).ToList()) old.Remove();
			return;
		}
		if (_players.FirstOrDefault(p => p is { Active: true, Script: null }) is not { } p ||
		    Players.FromSlot(p.Slot)?.GetHeroPawn() is not { } pawn) {
			Log("ent: no player");
			return;
		}
		var e = CBaseEntity.CreateByName(classname);
		if (e == null) {
			Log($"ent: no class {classname}");
			return;
		}
		var yaw = p.LastInput.ViewAngles.Y * MathF.PI / 180f;
		var at = pawn.Position - new Vector3(MathF.Cos(yaw), MathF.Sin(yaw), 0) * back + new Vector3(0, 0, up);
		var kv = new CEntityKeyValues();
		kv.SetString("targetname", name);
		var inv = System.Globalization.CultureInfo.InvariantCulture;
		foreach (var pair in keyvalues.Split('|', StringSplitOptions.RemoveEmptyEntries)) {
			var eq = pair.IndexOf('=');
			if (eq <= 0) continue;
			var (key, value) = (pair[..eq], pair[(eq + 1)..]);
			var parts = value.Split(',');
			if (parts.Length is 3 or 4 && parts.All(s => byte.TryParse(s, out _))) {
				var c = parts.Select(byte.Parse).ToArray();
				kv.SetColor(key, c[0], c[1], c[2], c.Length == 4 ? c[3] : (byte)255);
			} else if (int.TryParse(value, inv, out var i)) kv.SetInt(key, i);
			else if (float.TryParse(value, inv, out var f)) kv.SetFloat(key, f);
			else kv.SetString(key, value);
		}
		kv.SetVector("origin", at);
		e.Spawn(kv);
		e.Teleport(at, new Vector3(90, 0, 0), null);
		e.SetParent(pawn);
		Log($"ent: {classname} #{e.EntityIndex} at {Fmt(at)} with {keyvalues}");
	}

	[Command("bhopleavers", Description = "List players and heroes; remove those of players who have left: bhopleavers [remove]", ServerOnly = true)]
	public void CmdLeavers(string action = "") {
		var remove = action.Equals("remove", StringComparison.OrdinalIgnoreCase);
		foreach (var c in Players.GetAllControllers().ToList()) {
			var connected = Players.IsConnected(c.Slot);
			var hero = c.GetHeroPawn();
			Log($"controller [{c.Slot}] {c.PlayerName}: {(c.IsBot ? "bot" : connected ? "connected" : "left")}, " +
			    $"hero {(hero != null ? $"#{hero.EntityIndex} at {Fmt(hero.Position)}, alive {hero.IsAlive}" : "none")}");
			if (remove && !c.IsBot && !connected) c.RemoveWithPawns();
		}
		foreach (var pawn in Entities.ByClass<CCitadelPlayerPawn>().ToList()) {
			var c = pawn.Controller;
			if (c != null && (c.IsBot || Players.IsConnected(c.Slot))) continue;
			Log($"hero #{pawn.EntityIndex} at {Fmt(pawn.Position)}, alive {pawn.IsAlive}, controller {(c == null ? "none" : $"[{c.Slot}] {c.PlayerName}")}");
			if (remove && c == null) pawn.Remove();
		}
		if (action.Equals("all", StringComparison.OrdinalIgnoreCase)) {
			var classes = Entities.All.Where(e => e.IsValid).GroupBy(e => $"{e.Classname}/{e.DesignerName}").OrderBy(g => g.Key).ToList();
			for (var i = 0; i < classes.Count; i += 12)
				Log("entities: " + string.Join(", ", classes.Skip(i).Take(12).Select(g => $"{g.Key} {g.Count()}")));
			foreach (var e in Entities.All.Where(e => e.IsValid && (e.Classname.Contains("player", StringComparison.OrdinalIgnoreCase) || e.Classname.Contains("pawn", StringComparison.OrdinalIgnoreCase))))
				Log($"#{e.EntityIndex} {e.Classname}/{e.DesignerName} '{e.Name}' at {Fmt(e.Position)}");
		}
	}

	/// <summary>Free flight for everyone: the plugin stops simulating and the engine's noclip flies.</summary>
	private bool _freeFly;

	[Command("bhopnoclip", Description = "Free flight for all players (admins): bhopnoclip on|off", Permission = "bhop.zones")]
	public void CmdNoclip(CCitadelPlayerController caller, string state) => SetFreeFly(state, caller);

	[Command("bhopnoclip_server", Description = "Free flight for all players: bhopnoclip_server on|off", ServerOnly = true)]
	public void CmdNoclipServer(string state) => SetFreeFly(state, null);

	private void SetFreeFly(string state, CCitadelPlayerController? caller) {
		var on = state.Equals("on", StringComparison.OrdinalIgnoreCase) || state == "1";
		if (on == _freeFly) return;
		_freeFly = on;
		// Noclip at Source's usual speed while flying; back to the exact-mode values afterwards.
		Server.ExecuteCommand(on ? "sv_noclipaccelerate 5; sv_noclipfriction 4" : "sv_noclipaccelerate 0; sv_noclipfriction 0");
		foreach (var p in _players) {
			if (p is not { Active: true } || p.Script != null) continue;
			p.Timer.Reset(); // no records from a flight
			if (on) continue;
			// Carry on with CS:S movement from wherever the player flew to.
			var pawn = Players.FromSlot(p.Slot)?.GetHeroPawn();
			if (pawn == null) continue;
			p.State.Teleport(pawn.Position, Vector3.Zero);
			_movement.Unstick(p.State);
			p.Triggers = new TriggerState();
			pawn.AbsVelocity = Vector3.Zero;
		}
		Chat.PrintToChatAll(on ? "Noclip on: fly anywhere (runs are stopped)." : "Noclip off: back to CS:S movement.");
		Log($"free flight {(on ? "on" : "off")}{(caller != null ? $" by {caller.PlayerName}" : "")}");
	}

	[Command("where", Description = "Show (and log) where you are and which way you look, to report map problems")]
	public void CmdWhereAmI(CCitadelPlayerController caller) {
		var pawn = caller.GetHeroPawn();
		if (pawn == null) return;
		var text = $"{_mapName} at {Fmt(pawn.Position - _offset)} looking {Fmt(pawn.CameraAngles)}" +
		           (_offset != Vector3.Zero ? $" (moved by {Fmt(_offset)}: {Fmt(pawn.Position)} in the world)" : "");
		Chat.PrintToChat(caller, text);
		Log($"[{caller.Slot}] {caller.PlayerName} marked {text}");
	}

	[Command("bhopwhere", Description = "Log where every player is and which way they look", ServerOnly = true)]
	public void CmdWhere() {
		foreach (var p in _players) {
			if (p is not { Active: true }) continue;
			var controller = Players.FromSlot(p.Slot);
			var pawn = controller?.GetHeroPawn();
			if (pawn == null) continue;
			Log($"[{p.Slot}] {controller!.PlayerName} at {Fmt(pawn.Position)} looking {Fmt(pawn.CameraAngles)}, simulated {Fmt(p.State.Origin)}");
		}
	}

	[Command("bhoptestbot", Description = "Add a bot that runs a scripted bhop, for testing", ServerOnly = true)]
	public void CmdTestBot() {
		var spawn = _players.FirstOrDefault(p => p is { Active: true, Script: null })?.Spawn ??
		            _players.FirstOrDefault(p => p is { Active: true })?.Spawn ?? new Vector3(0, 0, 0);
		var pawn = Bots.Add(DefaultHero, 2, spawn, assignLane: false);
		if (pawn?.Controller is not { } controller) {
			Log("could not add a bot");
			return;
		}
		ConVar.Find("citadel_solo_bot_match")?.SetInt(0); // the script drives it, not the bot AI
		var p =_players[controller.Slot] = new BhopPlayer(controller.Slot) { Script = new StrafeScript() };
		Log($"[{p.Slot}] test bot added");
	}

	[Command("bhoptrace", Description = "Trace straight down from a point and print the results", ServerOnly = true)]
	public void CmdTrace(float x, float y, float z) {
		var start = new Vector3(x, y, z);
		var end = start - new Vector3(0, 0, 4096);
		var line = DeadworksManaged.Api.Trace.Ray(start, end);
		Log($"line: hit={line.DidHit} frac={line.Fraction:0.0000} pos={Fmt(line.HitPosition)}");
		var hull = _engineWorld.TraceHull(start, end, _movement.Settings.HullMins, _movement.Settings.HullMaxs, Collision.ContentsMask.PlayerSolid);
		Log($"hull: frac={hull.Fraction:0.0000} end={Fmt(hull.EndPos)} n={Fmt(hull.Normal)} ss={hull.StartSolid}");
		var point = _engineWorld.TraceHull(start, end, Vector3.Zero, Vector3.Zero, Collision.ContentsMask.PlayerSolid);
		Log($"point: frac={point.Fraction:0.0000} end={Fmt(point.EndPos)} n={Fmt(point.Normal)} ss={point.StartSolid}");
	}

	[Command("bhoplog", Description = "Toggle per-tick movement logging", ServerOnly = true)]
	public void CmdLog() {
		Config.LogMovement = !Config.LogMovement;
		Log($"movement logging {(Config.LogMovement ? "on" : "off")}");
	}

	// ------------------------------------------------------------------ drawn courses, per player

	/// <summary>What each player isn't sent: backs of drawn panels facing their camera, and other players' world-text timers.</summary>
	public override void OnCheckTransmit(CheckTransmitEvent args) {
		if ((uint)args.PlayerSlot < _players.Length && _players[args.PlayerSlot] is { Culled.Count: > 0 } p) {
			foreach (var e in p.Culled) args.Hide(e);
		}
		if (_worldHud.Any) foreach (var e in _worldHud.OthersOf(args.PlayerSlot)) args.Hide(e);
	}

	[Command("bhopview", Description = "Put the first player at a point looking a given way: bhopview x y z yaw [pitch]", ServerOnly = true)]
	public void CmdView(float x, float y, float z, float yaw, float pitch = 0f) {
		var controller = Players.GetAllControllers().FirstOrDefault(c => !c.IsBot);
		var pawn = controller?.GetHeroPawn();
		if (controller == null || pawn == null || _players[controller.Slot] is not { } p) {
			Log("view: no player");
			return;
		}
		var target = new Vector3(x, y, z);
		p.State.Teleport(target, Vector3.Zero);
		pawn.TeleportWithView(target, new Vector3(pitch, yaw, 0));
		pawn.AbsVelocity = Vector3.Zero;
		Log($"view: {controller.PlayerName} at {Fmt(target)} yaw {yaw} pitch {pitch}");
	}

	// ------------------------------------------------------------------ helpers

	private static float Speed2D(Vector3 v) => MathF.Sqrt(v.X * v.X + v.Y * v.Y);
	private static string Fmt(Vector3 v) => $"({v.X:0.00} {v.Y:0.00} {v.Z:0.00})";
	/// <summary>
	/// The server console formats what it is given printf-style: "4% airborne" came out as
	/// "4 0x0.07ff65de4e998p-1022irborne", and a player named "%s%s" could crash it. So % is escaped.
	/// </summary>
	private static void Log(string message) => Console.WriteLine($"[OpenCitadel.Bhop] {message.Replace("%", "%%")}");
}

internal sealed class BhopPlayer(int slot) {
	public int Slot { get; } = slot;
	public PlayerMoveState State { get; set; } = new();
	public bool Active { get; set; }
	public Vector3 Spawn { get; set; }
	public Vector3? SpawnAngles { get; set; }
	public TriggerState Triggers { get; set; } = new();
	public RunTimer Timer { get; } = new();
	/// <summary>First corner of a zone being drawn.</summary>
	public ((ZoneKind Kind, int Index) Key, Vector3 Pos)? ZoneCorner { get; set; }
	/// <summary>Seconds of simulated movement, the clock the map's triggers use.</summary>
	public float SimTime { get; set; }
	public int PendingCmds { get; set; }
	/// <summary>Usercmds already simulated, to skip the copies clients resend.</summary>
	public CommandHistory Seen { get; } = new();
	/// <summary>The last input simulated, held for the prediction forecast.</summary>
	public MoveInput LastInput { get; set; }
	/// <summary>How many ticks ahead of the server the client draws its hero (0: it doesn't predict).</summary>
	public int PredictionTicks { get; set; }
	/// <summary>The velocity the hero is networked with after each tick of new commands.</summary>
	public Vector3 NetworkVelocity { get; set; }
	public Vector3 LastSimulated { get; set; }
	public float MaxError { get; set; }
	public bool HudBuilt { get; set; }
	public string? GreetedMap { get; set; }
	/// <summary>Told how the server plays (see Welcome), once a visit.</summary>
	public bool Welcomed { get; set; }
	/// <summary>Told why they keep being sent back (see TeleportTip), once a visit.</summary>
	public bool TeleportTipped { get; set; }
	/// <summary>The last "exact movement on" line logged for them.</summary>
	public string? LastActivation { get; set; }
	public MoveButtons HudKeys { get; set; }
	public MoveButtons Keys { get; set; }
	public float LastYaw { get; set; }
	public int SyncGood { get; set; }
	public int SyncTotal { get; set; }
	/// <summary>The player's best time per track (0 = main course).</summary>
	public Dictionary<int, float> PersonalBests { get; } = new();
	/// <summary>Picked up after a plugin reload: start from where the hero is, not the spawn.</summary>
	public bool ResumeInPlace { get; set; }
	public string? FinishedText { get; set; }
	public float FinishedUntil { get; set; }
	/// <summary>What they did this visit, for the log when they leave.</summary>
	public SessionStats Stats { get; } = new();
	/// <summary>Scripted input, for test bots.</summary>
	public StrafeScript? Script { get; set; }
	public int ScriptTick { get; set; }
	/// <summary>Drawn panels this player isn't sent this tick: backs facing their camera.</summary>
	public List<CBaseEntity> Culled { get; } = new();
}

/// <summary>
/// Test input: run forward for a second, then bunny-hop while strafing in alternating arcs,
/// turning at a steady rate, the way a player gains speed.
/// </summary>
internal sealed class StrafeScript {
	private float _yaw;

	public void Write(CCitadelUserCmdPB cmd, int tick, float dt) {
		var t = tick * dt;
		ulong buttons;
		if (t < 1f) {
			buttons = (ulong)InputButton.Forward;
		} else {
			var right = (int)(t - 1f) % 2 == 0;
			_yaw += (right ? -1 : 1) * 220f * dt;
			buttons = (ulong)(InputButton.Jump | (right ? InputButton.MoveRight : InputButton.MoveLeft));
		}
		var b = cmd.Base ??= new CBaseUserCmdPB();
		b.Viewangles = new CMsgQAngle { X = 0, Y = _yaw, Z = 0 };
		b.Forwardmove = 0;
		b.Leftmove = 0;
		var state = b.ButtonsPb ??= new CInButtonStatePB();
		state.Buttonstate1 = buttons;
		state.Buttonstate2 = 0;
	}
}
