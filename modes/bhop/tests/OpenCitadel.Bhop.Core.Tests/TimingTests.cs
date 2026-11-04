using System.Numerics;
using OpenCitadel.Bhop.Map;
using OpenCitadel.Bhop.Movement;
using OpenCitadel.Bhop.Timing;

namespace OpenCitadel.Bhop.Tests;

public class TimingTests {
	private const float Dt = 1f / 64f;
	private static readonly MovementSettings S = MovementSettings.CounterStrikeSource;

	private static ZoneSet Zones() => new([
		new MapZone { Kind = ZoneKind.Start, Mins = new(-100, -100, 0), Maxs = new(100, 100, 100) },
		new MapZone { Kind = ZoneKind.Checkpoint, Index = 1, Mins = new(500, -100, 0), Maxs = new(600, 100, 100) },
		new MapZone { Kind = ZoneKind.End, Mins = new(1000, -100, 0), Maxs = new(1100, 100, 100) },
	]);

	private static PlayerMoveState At(float x, Vector3? velocity = null) => new() { Origin = new(x, 0, 1), Velocity = velocity ?? new(250, 0, 0) };

	[Fact]
	public void RunStartsOnLeavingTheStartZoneAndFinishesInTheEndZone() {
		var timer = new RunTimer();
		var zones = Zones();
		Assert.Null(timer.Update(At(0), S, zones, false, Dt));
		Assert.Equal(RunState.InStart, timer.State);

		var started = timer.Update(At(120), S, zones, false, Dt);
		Assert.Equal(RunEventKind.Started, started?.Kind);

		RunEvent? cp = null, finish = null;
		for (var i = 0; i < 64 * 4; i++) {
			var e = timer.Update(At(120 + i * 4), S, zones, i % 10 == 0, Dt);
			if (e?.Kind == RunEventKind.Checkpoint) cp = e;
			if (e?.Kind == RunEventKind.Finished) { finish = e; break; }
		}
		Assert.Equal(1, cp?.Checkpoint);
		Assert.NotNull(finish);
		// The box's +X face (origin + 16) reaches x = 1000 at origin 984: (984 - 120) / 4 = 216 ticks.
		Assert.Equal(217 * Dt, finish!.Value.Time, 4);
		Assert.Equal(RunState.Idle, timer.State);
	}

	[Fact]
	public void LeavingTheStartZoneTooFastClipsTheSpeed() {
		var timer = new RunTimer();
		var zones = Zones();
		timer.Update(At(0), S, zones, false, Dt);
		var p = At(120, new Vector3(600, 800, 0));
		timer.Update(p, S, zones, false, Dt);
		Assert.Equal(290f, new Vector2(p.Velocity.X, p.Velocity.Y).Length(), 3);
	}

	[Fact]
	public void WithoutVisitingTheStartZoneThereIsNoRun() {
		var timer = new RunTimer();
		Assert.Null(timer.Update(At(1050), S, Zones(), false, Dt));
		Assert.Equal(RunState.Idle, timer.State);
	}

	[Fact]
	public void DefaultStartZoneSurroundsTheSpawns() {
		var data = new BhopMapData { Spawns = [new MapSpawn { Origin = new(10, 20, 30) }, new MapSpawn { Origin = new(10, 120, 30) }] };
		var zones = ZoneSet.For(data, null);
		var start = Assert.IsType<MapZone>(zones.Start);
		Assert.True(start.Mins.Y < 20 && start.Maxs.Y > 120);
		Assert.Null(zones.End);
	}

	[Fact]
	public void RecordsKeepEachPlayersBestAndRankThem() {
		var dir = Path.Combine(Path.GetTempPath(), "ocbhop-records-" + Guid.NewGuid().ToString("N"));
		try {
			var store = new RecordStore(dir);
			var r1 = store.Submit("bhop_test", new RunRecord { SteamId = 1, Name = "a", Time = 30f, Style = "exact" });
			Assert.True(r1.PersonalBest && r1.MapRecord);
			var r2 = store.Submit("bhop_test", new RunRecord { SteamId = 2, Name = "b", Time = 25f, Style = "exact" });
			Assert.True(r2.MapRecord);
			Assert.Equal(30f, r2.PreviousRecord);
			var r3 = store.Submit("bhop_test", new RunRecord { SteamId = 1, Name = "a", Time = 35f, Style = "exact" });
			Assert.False(r3.PersonalBest);
			Assert.Equal(2, r3.Rank);

			var reloaded = new RecordStore(dir).Top("bhop_test", "exact");
			Assert.Equal([2ul, 1ul], reloaded.Select(r => r.SteamId).ToArray());
			Assert.Empty(new RecordStore(dir).Top("bhop_test", "native"));
		} finally {
			if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
		}
	}

	[Theory]
	[InlineData(83.4567f, "1:23.457")]
	[InlineData(5.5f, "0:05.500")]
	[InlineData(3725.25f, "1:02:05.250")]
	public void TimesFormatLikeTimers(float seconds, string expected) => Assert.Equal(expected, RecordStore.Format(seconds));
}
