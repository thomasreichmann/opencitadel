using System.Numerics;
using OpenCitadel.Bhop.Collision;
using OpenCitadel.Bhop.Map;
using OpenCitadel.Bhop.Movement;
using OpenCitadel.Bhop.Timing;

namespace OpenCitadel.Bhop.Tests;

/// <summary>Zones in bhoptimer's format, and the zone types they bring: bonuses, stops, slides.</summary>
public class ZoneImportTests {
	private const float Dt = 1f / 64f;
	private static readonly MovementSettings S = MovementSettings.CounterStrikeSource;

	// The shape of github.com/srcwr/zones files (bhop_eazy's start and end, plus other types).
	private const string Json = """
		[
			{ "id": 1, "point_a": [-1120.0, -480.0, 65.031], "point_b": [-736.0, -96.0, 192.031], "track": 0, "type": "end" },
			{ "id": 1, "point_a": [-224.0, -224.0, 192.031], "point_b": [-480.0, -480.0, 65.031], "track": 0, "type": "start" },
			{ "id": 2, "point_a": [4512.0, 2496.0, 49.031], "point_b": [4736.0, 2880.0, 176.031], "track": 1, "type": "start" },
			{ "id": 3, "point_a": [0, 0, 0], "point_b": [10, 10, 10], "track": 0, "type": "stage", "data": 3, "dest": [5, 5, 1] },
			{ "id": 4, "point_a": [0, 0, 0], "point_b": [10, 10, 10], "track": 0, "type": "slay" },
			{ "id": 5, "point_a": [0, 0, 0], "point_b": [10, 10, 10], "track": 0, "type": 10 }
		]
		""";

	[Fact]
	public void BhoptimerZonesConvert() {
		Assert.True(BhoptimerZones.IsBhoptimerJson(Json));
		var (zones, skipped) = BhoptimerZones.Parse(Json);
		var start = Assert.Single(zones, z => z.Kind == ZoneKind.Start && z.Track == 0);
		// Corners in any order become a box.
		Assert.Equal(new Vec3(-480, -480, 65.031f), start.Mins);
		Assert.Equal(new Vec3(-224, -224, 192.031f), start.Maxs);
		// bhoptimer restarts players at the zone's centre, 1 unit above its floor.
		Assert.Equal(new Vec3(-352, -352, 66.031f), start.Teleport);
		Assert.Single(zones, z => z.Kind == ZoneKind.End && z.Track == 0);
		Assert.Single(zones, z => z.Kind == ZoneKind.Start && z.Track == 1);
		var stage = Assert.Single(zones, z => z.Kind == ZoneKind.Checkpoint);
		Assert.Equal(3, stage.Index);
		Assert.Equal(new Vec3(5, 5, 1), stage.Teleport);
		Assert.Single(zones, z => z.Kind == ZoneKind.Slide); // numeric type 10
		Assert.Equal(["slay"], skipped);
	}

	[Fact]
	public void BonusRunsFinishOnlyAtTheirOwnEnd() {
		var zones = new ZoneSet([
			new MapZone { Kind = ZoneKind.Start, Mins = new(-100, -100, 0), Maxs = new(100, 100, 100) },
			new MapZone { Kind = ZoneKind.End, Mins = new(500, -100, 0), Maxs = new(600, 100, 100) },
			new MapZone { Kind = ZoneKind.Start, Track = 1, Mins = new(-100, 900, 0), Maxs = new(100, 1100, 100) },
			new MapZone { Kind = ZoneKind.End, Track = 1, Mins = new(1000, -100, 0), Maxs = new(1100, 100, 100) },
		]);
		Assert.Equal([0, 1], zones.Tracks);
		var timer = new RunTimer();
		timer.Update(new PlayerMoveState { Origin = new(0, 1000, 1) }, S, zones, false, Dt);
		Assert.Equal(1, timer.Track);
		Assert.Equal(RunEventKind.Started, timer.Update(new PlayerMoveState { Origin = new(0, 1200, 1) }, S, zones, false, Dt)?.Kind);
		// Crossing the main course's end does nothing on a bonus run...
		Assert.Null(timer.Update(new PlayerMoveState { Origin = new(550, 0, 1) }, S, zones, false, Dt));
		// ...its own end finishes it, as a bonus finish.
		var done = timer.Update(new PlayerMoveState { Origin = new(1050, 0, 1) }, S, zones, false, Dt);
		Assert.Equal(RunEventKind.Finished, done?.Kind);
		Assert.Equal(1, done?.Track);
	}

	[Fact]
	public void StopZonesStopARunningTimer() {
		var zones = new ZoneSet([
			new MapZone { Kind = ZoneKind.Start, Mins = new(-100, -100, 0), Maxs = new(100, 100, 100) },
			new MapZone { Kind = ZoneKind.Stop, Mins = new(300, -100, 0), Maxs = new(400, 100, 100) },
		]);
		var timer = new RunTimer();
		timer.Update(new PlayerMoveState { Origin = new(0, 0, 1) }, S, zones, false, Dt);
		timer.Update(new PlayerMoveState { Origin = new(150, 0, 1) }, S, zones, false, Dt);
		Assert.Equal(RunState.Running, timer.State);
		Assert.Equal(RunEventKind.Stopped, timer.Update(new PlayerMoveState { Origin = new(350, 0, 1) }, S, zones, false, Dt)?.Kind);
		Assert.Equal(RunState.Idle, timer.State);
	}

	[Fact]
	public void SlideZonesHoldAirbornePlayersJustAboveTheGround() {
		var world = new CollisionWorld([new BrushModel(0, "world", [Brush.Box(new(-8192, -8192, -64), new(8192, 8192, 0))])]);
		var zones = new ZoneSet([new MapZone { Kind = ZoneKind.Slide, Mins = new(-500, -500, 0), Maxs = new(500, 500, 64) }]);

		// In the air, 4 units up: held up at 8 u/s (bhoptimer: 8 × gravity scale × sv_gravity / 800).
		var near = new PlayerMoveState { Origin = new(0, 0, 4), Velocity = new(600, 0, -300) };
		Assert.True(zones.ApplySlide(near, S, world));
		Assert.Equal(8f, near.Velocity.Z);
		Assert.Equal(600f, near.Velocity.X);

		// Too far above the ground, on the ground, or outside the zone: untouched.
		var high = new PlayerMoveState { Origin = new(0, 0, 20), Velocity = new(0, 0, -300) };
		Assert.False(zones.ApplySlide(high, S, world));
		var grounded = new PlayerMoveState { Origin = new(0, 0, 1), GroundEntity = 0 };
		Assert.False(zones.ApplySlide(grounded, S, world));
		var outside = new PlayerMoveState { Origin = new(2000, 0, 4) };
		Assert.False(zones.ApplySlide(outside, S, world));

		// Over a run, the player never lands, so ground friction never slows the slide.
		var move = new CssMovement(S with { AutoBhop = false }, world);
		var p = new PlayerMoveState { Origin = new(-400, 0, 4), Velocity = new(600, 0, 0) };
		for (var i = 0; i < 64; i++) {
			zones.ApplySlide(p, S, world);
			move.Simulate(p, MoveInput.FromKeys(MoveButtons.None, 0, 0, Dt));
		}
		Assert.False(p.OnGround);
		Assert.True(p.Velocity.X > 590f, $"slid without friction, {p.Velocity.X}");
	}
}
