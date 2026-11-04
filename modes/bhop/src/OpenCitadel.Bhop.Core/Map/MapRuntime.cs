using System.Numerics;
using OpenCitadel.Bhop.Collision;
using OpenCitadel.Bhop.Movement;

namespace OpenCitadel.Bhop.Map;

/// <summary>What touching the map's triggers did to a player this tick.</summary>
public readonly record struct TouchOutcome(bool Teleported, Vector3? NewViewAngles, string? Reason);

/// <summary>An output waiting for its delay to pass (Source's event queue, for one player).</summary>
public readonly record struct PendingOutput(float At, TriggerOutput Output);

/// <summary>Per-player state the map's triggers keep.</summary>
public sealed class TriggerState {
	/// <summary>Bhop block the player stands on, and since when (seconds of game time).</summary>
	public int BlockModel = -1;
	public float BlockSince;
	/// <summary>Triggers the player's box overlapped last tick (the engine's touch links).</summary>
	public HashSet<int> Touching = new();
	/// <summary>Triggers whose StartTouch passed their filter; only these get EndTouch (m_hTouchingEntities).</summary>
	public HashSet<int> Entered = new();
	/// <summary>The player's targetname, which outputs set and filters test.</summary>
	public string Name = "";
	/// <summary>Earliest time each trigger_multiple may fire OnTrigger again.</summary>
	public Dictionary<int, float> NextTrigger = new();
	/// <summary>How often each limited output has fired.</summary>
	public Dictionary<TriggerOutput, int> Fired = new();
	public List<PendingOutput> Pending = new();
}

/// <summary>
/// A loaded ported map at runtime: collision for exact movement plus the behaviour of its
/// triggers, applied to a player after each movement tick. Kept free of game APIs so it can be
/// tested on its own.
/// </summary>
public sealed class MapRuntime {
	public BhopMapData Data { get; }
	public CollisionWorld World { get; }

	private readonly List<(MapTrigger Trigger, Brush[] Brushes, Vector3 Mins, Vector3 Maxs)> _triggers;
	private readonly Dictionary<string, MapDestination> _destinations;
	private readonly Dictionary<int, BhopBlock> _blocks;
	/// <summary>Teleport targets changed by map logic (SetTeleportTarget), by teleport name. Shared by everyone, as entity state is.</summary>
	private readonly Dictionary<string, string> _currentTargets = new(StringComparer.OrdinalIgnoreCase);
	private readonly Random _random = new();

	public MapRuntime(BhopMapData data) {
		Data = data;
		World = data.BuildCollisionWorld();
		_triggers = data.Triggers.Select(t => (t, t.Brushes.Select(b => b.ToBrush()).ToArray(), t.Mins.ToVector3(), t.Maxs.ToVector3())).ToList();
		_destinations = data.Destinations.GroupBy(d => d.Name, StringComparer.OrdinalIgnoreCase)
			.ToDictionary(g => g.Key, g => g.First(), StringComparer.OrdinalIgnoreCase);
		_blocks = data.Models.Where(m => m.BhopBlock != null).ToDictionary(m => m.Id, m => m.BhopBlock!);
	}

	/// <summary>The spawn players start at (the first one, which bhop maps cluster at the start).</summary>
	public MapSpawn? Spawn => Data.Spawns.FirstOrDefault();

	/// <summary>
	/// Applies the triggers the player touches after moving, the way Source's trigger entities do:
	/// teleports, pushes (base velocity), gravity, outputs that rename the player or change their
	/// gravity or velocity (with their delays), filters on the player's name, and bhop blocks that
	/// give way under a player who stays on them. <paramref name="time"/> is game time in seconds.
	/// </summary>
	/// <remarks>
	/// A trigger_multiple's wait and a trigger_once are kept per player; in Source they are shared
	/// by everyone, so two players on the same platform within the wait could differ from CS:S.
	/// </remarks>
	public TouchOutcome Touch(PlayerMoveState p, MovementSettings settings, TriggerState state, float time) {
		var mins = p.Origin + (p.Ducked ? settings.DuckHullMins : settings.HullMins);
		var maxs = p.Origin + (p.Ducked ? settings.DuckHullMaxs : settings.HullMaxs);
		var nowTouching = new HashSet<int>();
		TouchOutcome outcome = default;

		for (var i = 0; i < _triggers.Count && !outcome.Teleported; i++) {
			var (t, brushes, tmins, tmaxs) = _triggers[i];
			if (t.StartDisabled) continue;
			if (tmins.X > maxs.X || tmaxs.X < mins.X || tmins.Y > maxs.Y || tmaxs.Y < mins.Y || tmins.Z > maxs.Z || tmaxs.Z < mins.Z) continue;
			if (!BoxTouchesBrushes(mins, maxs, brushes, t.Origin.ToVector3())) continue;
			nowTouching.Add(i);
			var passes = t.Filter?.Passes(state.Name) ?? true;

			// StartTouch: only a player passing the filter counts as inside (and later gets EndTouch).
			var started = !state.Touching.Contains(i);
			if (started && passes) {
				state.Entered.Add(i);
				Fire(t, OutputEvent.StartTouch, state, time);
			}
			// Every trigger's Touch checks the filter again, so a rename takes effect while inside.
			if (!passes) continue;

			switch (t.Kind) {
				case TriggerKind.Teleport:
					var target = t.Name.Length > 0 && _currentTargets.TryGetValue(t.Name, out var current) ? current : t.Target;
					if (target != null && _destinations.TryGetValue(target, out var dest)) {
						p.Teleport(dest.Origin.ToVector3(), Vector3.Zero);
						state.BlockModel = -1;
						outcome = new TouchOutcome(true, t.KeepAngles ? null : dest.Angles.ToVector3(), $"teleport {t.Name}->{target}");
					}
					break;
				case TriggerKind.Push:
					if (t.Once && !started) break;
					var push = t.Vector.ToVector3();
					if (push.Z > 0 && p.OnGround) {
						p.GroundEntity = -1;
						p.Origin.Z += 1f;
					}
					if (t.Once) {
						p.Velocity += push;
					} else {
						// CTriggerPush::Touch: base velocity for the next move (FL_BASEVELOCITY).
						p.BaseVelocity = push;
						p.InBaseVelocityTrigger = true;
					}
					break;
				case TriggerKind.Gravity:
					p.GravityScale = t.Value;
					break;
				case TriggerKind.Velocity:
					if (started) p.Velocity = t.Vector.ToVector3();
					break;
				case TriggerKind.Outputs:
					// CTriggerMultiple::ActivateMultiTrigger: OnTrigger, then nothing until the wait is over.
					if (!state.NextTrigger.TryGetValue(i, out var next) || time >= next) {
						Fire(t, OutputEvent.Trigger, state, time);
						state.NextTrigger[i] = t.Wait > 0 ? time + t.Wait : float.PositiveInfinity;
					}
					break;
			}
		}

		// EndTouch for triggers the player left (or was teleported out of).
		foreach (var i in state.Touching) {
			if (!nowTouching.Contains(i) && state.Entered.Remove(i)) Fire(_triggers[i].Trigger, OutputEvent.EndTouch, state, time);
		}
		state.Touching = nowTouching;

		// Bhop blocks: standing on one too long drops you (through its teleport).
		if (outcome.Teleported) {
			state.BlockModel = -1;
		} else if (p.OnGround && _blocks.TryGetValue(p.GroundEntity, out var block)) {
			if (state.BlockModel != p.GroundEntity) {
				state.BlockModel = p.GroundEntity;
				state.BlockSince = time;
			} else if (time - state.BlockSince > block.Delay && block.Destination != null &&
			           _destinations.TryGetValue(block.Destination, out var dest)) {
				p.Teleport(dest.Origin.ToVector3(), Vector3.Zero);
				state.BlockModel = -1;
				outcome = new TouchOutcome(true, dest.Angles.ToVector3(), $"bhop block {p.GroundEntity}");
			}
		} else {
			state.BlockModel = -1;
		}

		ServiceOutputs(p, state, time);
		return outcome;
	}

	private static void Fire(MapTrigger t, OutputEvent ev, TriggerState state, float time) {
		foreach (var o in t.Outputs) {
			if (o.Event != ev) continue;
			if (o.Times >= 0) {
				state.Fired.TryGetValue(o, out var fired);
				if (fired >= o.Times) continue;
				state.Fired[o] = fired + 1;
			}
			state.Pending.Add(new PendingOutput(time + o.Delay, o));
		}
	}

	/// <summary>
	/// Runs the outputs whose delay has passed, in the order they are due, as the server's event
	/// queue does at the end of each tick.
	/// </summary>
	private void ServiceOutputs(PlayerMoveState p, TriggerState state, float time) {
		if (state.Pending.Count == 0) return;
		// Tolerance for game time kept as a float sum of tick intervals.
		var due = state.Pending.Where(e => e.At <= time + 1e-4f).OrderBy(e => e.At).ToList();
		if (due.Count == 0) return;
		state.Pending.RemoveAll(e => e.At <= time + 1e-4f);
		foreach (var (_, o) in due) {
			switch (o.Action) {
				case OutputAction.SetName:
					state.Name = o.Text ?? "";
					break;
				case OutputAction.SetGravity:
					p.GravityScale = o.Number;
					break;
				case OutputAction.SetBaseVelocity:
					p.BaseVelocity = o.Vector.ToVector3();
					break;
				case OutputAction.SetTeleportTarget:
					if (o.Text != null && o.Choices is { Count: > 0 } choices) _currentTargets[o.Text] = choices[_random.Next(choices.Count)];
					break;
			}
		}
	}

	private static bool BoxTouchesBrushes(Vector3 mins, Vector3 maxs, Brush[] brushes, Vector3 origin) {
		var center = (mins + maxs) * 0.5f - origin;
		var extents = (maxs - mins) * 0.5f;
		foreach (var b in brushes) {
			var inside = true;
			foreach (var side in b.Sides) {
				var d = Vector3.Dot(center, side.Normal) - side.Dist -
				        (MathF.Abs(side.Normal.X) * extents.X + MathF.Abs(side.Normal.Y) * extents.Y + MathF.Abs(side.Normal.Z) * extents.Z);
				if (d > 0) {
					inside = false;
					break;
				}
			}
			if (inside) return true;
		}
		return false;
	}
}
