using System.Numerics;
using OpenCitadel.Bhop.Collision;
using OpenCitadel.Bhop.Map;
using OpenCitadel.Bhop.Movement;

namespace OpenCitadel.Bhop.Timing;

public enum RunState {
	/// <summary>Not in a run: outside the start zone without having left it since spawning.</summary>
	Idle,
	/// <summary>Standing in the start zone; the clock starts on leaving it.</summary>
	InStart,
	Running,
}

public enum RunEventKind { Started, Finished, Checkpoint, Stopped }

/// <summary>Something that happened to a run this tick, on track 0 (the main course) or a bonus.</summary>
public readonly record struct RunEvent(RunEventKind Kind, float Time, int Jumps, float Speed, int Checkpoint = 0, int Track = 0);

/// <summary>A map's timer zones as boxes, with the start zone made up from the spawns when none is set.</summary>
public sealed class ZoneSet {
	public IReadOnlyList<MapZone> Zones { get; }
	/// <summary>The main course's start zone.</summary>
	public MapZone? Start => StartOf(0);
	/// <summary>The main course's end zone.</summary>
	public MapZone? End => EndOf(0);
	public MapZone? StartOf(int track) => Zones.FirstOrDefault(z => z.Kind == ZoneKind.Start && z.Track == track);
	public MapZone? EndOf(int track) => Zones.FirstOrDefault(z => z.Kind == ZoneKind.End && z.Track == track);
	/// <summary>The tracks with a start zone: 0 and any bonuses.</summary>
	public IReadOnlyList<int> Tracks => Zones.Where(z => z.Kind == ZoneKind.Start).Select(z => z.Track).Distinct().Order().ToList();

	public ZoneSet(IEnumerable<MapZone> zones) => Zones = zones.ToList();

	public bool Inside(ZoneKind kind, Vector3 mins, Vector3 maxs) => Zones.Any(z => z.Kind == kind && Overlaps(z, mins, maxs));

	/// <summary>
	/// bhoptimer's slide zones (Shavit_OnUserCmdPre), applied before a movement tick: a player in
	/// the air inside one, with ground within 8 units straight below, gets an upward speed of
	/// 8 × gravity scale, so they never land and slide over the surface without friction.
	/// </summary>
	public bool ApplySlide(PlayerMoveState p, MovementSettings s, ITraceWorld world) {
		if (p.OnGround || !Zones.Any(z => z.Kind == ZoneKind.Slide)) return false;
		var mins = p.Origin + (p.Ducked ? s.DuckHullMins : s.HullMins);
		var maxs = p.Origin + (p.Ducked ? s.DuckHullMaxs : s.HullMaxs);
		if (!Inside(ZoneKind.Slide, mins, maxs)) return false;
		var down = world.TraceHull(p.Origin, p.Origin - new Vector3(0, 0, 8), Vector3.Zero, Vector3.Zero, ContentsMask.PlayerSolid);
		if (!down.DidHit) return false;
		p.Velocity.Z = 8f * p.GravityScale * (s.Gravity / 800f);
		return true;
	}

	/// <summary>
	/// The zones to use for a map: the configured ones, or else a start zone around the spawns
	/// (classic maps have no zone data; bhop servers draw zones by hand).
	/// </summary>
	public static ZoneSet For(BhopMapData data, IEnumerable<MapZone>? configured) {
		var zones = (configured ?? data.Zones).ToList();
		if (zones.All(z => z.Kind != ZoneKind.Start || z.Track != 0) && data.Spawns.Count > 0) {
			var mins = new Vector3(float.MaxValue);
			var maxs = new Vector3(float.MinValue);
			foreach (var s in data.Spawns) {
				mins = Vector3.Min(mins, s.Origin.ToVector3());
				maxs = Vector3.Max(maxs, s.Origin.ToVector3());
			}
			mins -= new Vector3(64, 64, 16);
			maxs += new Vector3(64, 64, 128);
			var first = data.Spawns[0];
			zones.Add(new MapZone {
				Kind = ZoneKind.Start, Mins = Vec3.From(mins), Maxs = Vec3.From(maxs),
				Teleport = first.Origin, TeleportYaw = first.Angles.Y,
			});
		}
		return new ZoneSet(zones);
	}

	public static bool Overlaps(MapZone z, Vector3 mins, Vector3 maxs) =>
		z.Mins.X <= maxs.X && z.Maxs.X >= mins.X && z.Mins.Y <= maxs.Y && z.Maxs.Y >= mins.Y && z.Mins.Z <= maxs.Z && z.Maxs.Z >= mins.Z;
}

/// <summary>
/// One player's run timer, bhop-server style: the clock starts when the player leaves the start zone
/// and stops when they enter the end zone. Leaving the start zone faster than
/// <see cref="MaxStartSpeed"/> clips the speed, so runs can't be pre-built inside the zone.
/// Time is counted in ticks, so it is exact and independent of the server's frame timing.
/// </summary>
public sealed class RunTimer {
	public RunState State { get; private set; } = RunState.Idle;
	public int Ticks { get; private set; }
	public int Jumps { get; private set; }
	public float MaxSpeed { get; private set; }
	public int Checkpoint { get; private set; }
	/// <summary>The course being run: 0 for the main one, set by the start zone the run began in.</summary>
	public int Track { get; private set; }
	/// <summary>Horizontal speed allowed when leaving the start zone (bhoptimer's prestrafe limit).</summary>
	public float MaxStartSpeed { get; set; } = 290f;

	public float Time(float tickInterval) => Ticks * tickInterval;

	/// <summary>Cancels the current run (a restart or a teleport out of the course).</summary>
	public void Reset() {
		State = RunState.Idle;
		Ticks = 0;
		Jumps = 0;
		MaxSpeed = 0;
		Checkpoint = 0;
	}

	/// <summary>Advances the timer after a movement tick.</summary>
	public RunEvent? Update(PlayerMoveState p, MovementSettings s, ZoneSet zones, bool jumped, float tickInterval) {
		var mins = p.Origin + (p.Ducked ? s.DuckHullMins : s.HullMins);
		var maxs = p.Origin + (p.Ducked ? s.DuckHullMaxs : s.HullMaxs);
		var start = zones.Zones.FirstOrDefault(z => z.Kind == ZoneKind.Start && ZoneSet.Overlaps(z, mins, maxs));
		var speed = new Vector2(p.Velocity.X, p.Velocity.Y).Length();

		if (start != null) {
			State = RunState.InStart;
			Track = start.Track;
			Ticks = 0;
			Jumps = 0;
			MaxSpeed = 0;
			Checkpoint = 0;
			return null;
		}

		if (State == RunState.InStart) {
			// Left the start zone: the run begins now.
			if (speed > MaxStartSpeed) {
				var scale = MaxStartSpeed / speed;
				p.Velocity.X *= scale;
				p.Velocity.Y *= scale;
				speed = MaxStartSpeed;
			}
			State = RunState.Running;
			Ticks = 0;
			Jumps = 0;
			MaxSpeed = speed;
			return new RunEvent(RunEventKind.Started, 0, 0, speed, Track: Track);
		}

		if (State != RunState.Running) return null;
		Ticks++;
		if (jumped) Jumps++;
		MaxSpeed = MathF.Max(MaxSpeed, speed);

		if (zones.Inside(ZoneKind.Stop, mins, maxs)) {
			State = RunState.Idle;
			return new RunEvent(RunEventKind.Stopped, Time(tickInterval), Jumps, speed, Track: Track);
		}
		foreach (var z in zones.Zones) {
			if (z.Kind == ZoneKind.Checkpoint && z.Track == Track && z.Index > Checkpoint && ZoneSet.Overlaps(z, mins, maxs)) {
				Checkpoint = z.Index;
				return new RunEvent(RunEventKind.Checkpoint, Time(tickInterval), Jumps, speed, z.Index, Track);
			}
		}
		if (zones.EndOf(Track) is { } end && ZoneSet.Overlaps(end, mins, maxs)) {
			var result = new RunEvent(RunEventKind.Finished, Time(tickInterval), Jumps, speed, Track: Track);
			State = RunState.Idle;
			return result;
		}
		return null;
	}
}
