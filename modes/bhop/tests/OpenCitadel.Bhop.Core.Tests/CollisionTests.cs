using System.Numerics;
using OpenCitadel.Bhop.Collision;

namespace OpenCitadel.Bhop.Tests;

public class CollisionTests {
	private static readonly Vector3 HullMins = new(-16, -16, 0);
	private static readonly Vector3 HullMaxs = new(16, 16, 62);

	private static CollisionWorld World(params Brush[] brushes) => new([new BrushModel(0, "world", brushes)]);

	[Fact]
	public void BoxStopsDistEpsilonShortOfAWall() {
		// Wall occupying x >= 100.
		var world = World(Brush.Box(new(100, -500, -500), new(200, 500, 500)));
		var t = world.TraceHull(new(0, 0, 0), new(150, 0, 0), HullMins, HullMaxs, ContentsMask.PlayerSolid);
		Assert.True(t.Fraction < 1f);
		Assert.False(t.StartSolid);
		// The box's +X face (origin + 16) stops 1/32 unit short of the wall.
		Assert.Equal(84f - 0.03125f, t.EndPos.X, 4);
		Assert.Equal(-1f, t.Normal.X);
		Assert.Equal(0, t.ModelId);
	}

	[Fact]
	public void TraceThatMissesReachesTheEnd() {
		var world = World(Brush.Box(new(100, -500, -500), new(200, 500, 500)));
		var t = world.TraceHull(new(0, 0, 0), new(50, 0, 0), HullMins, HullMaxs, ContentsMask.PlayerSolid);
		Assert.Equal(1f, t.Fraction);
		Assert.Equal(new Vector3(50, 0, 0), t.EndPos);
		Assert.False(t.DidHit);
		Assert.Equal(-1, t.ModelId);
	}

	[Fact]
	public void StationaryBoxInsideABrushIsAllSolid() {
		var world = World(Brush.Box(new(-50, -50, -50), new(50, 50, 50)));
		var t = world.TraceHull(Vector3.Zero, Vector3.Zero, HullMins, HullMaxs, ContentsMask.PlayerSolid);
		Assert.True(t.StartSolid);
		Assert.True(t.AllSolid);
		Assert.Equal(0f, t.Fraction);
	}

	[Fact]
	public void LeavingABrushIsStartSolidButNotAllSolid() {
		var world = World(Brush.Box(new(-50, -50, -50), new(50, 50, 50)));
		var t = world.TraceHull(Vector3.Zero, new(500, 0, 0), HullMins, HullMaxs, ContentsMask.PlayerSolid);
		Assert.True(t.StartSolid);
		Assert.False(t.AllSolid);
	}

	[Fact]
	public void BrushesOutsideTheMaskAreIgnored() {
		var world = World(Brush.Box(new(100, -500, -500), new(200, 500, 500), Contents.Water));
		var t = world.TraceHull(new(0, 0, 0), new(150, 0, 0), HullMins, HullMaxs, ContentsMask.PlayerSolid);
		Assert.Equal(1f, t.Fraction);
	}

	[Fact]
	public void PlayerClipBlocksPlayers() {
		var world = World(Brush.Box(new(100, -500, -500), new(200, 500, 500), Contents.PlayerClip));
		var t = world.TraceHull(new(0, 0, 0), new(150, 0, 0), HullMins, HullMaxs, ContentsMask.PlayerSolid);
		Assert.True(t.Fraction < 1f);
	}

	[Fact]
	public void SlopedBrushGetsBevelsAndTheRightNormal() {
		// A 45 degree ramp rising toward +X: below the plane z = x, inside a 0..256 box.
		var n = Vector3.Normalize(new Vector3(-1, 0, 1));
		var ramp = Brush.FromPlanes([
			(n, 0f),
			(-Vector3.UnitZ, 0f),
			(Vector3.UnitX, 256f),
			(Vector3.UnitY, 256f),
			(-Vector3.UnitY, 256f),
		]);
		Assert.Contains(ramp.Sides, s => s.Bevel);
		Assert.Equal(256f, ramp.Maxs.Z, 3);

		var world = World(ramp);
		var t = world.TraceHull(new(128, 0, 300), new(128, 0, 0), HullMins, HullMaxs, ContentsMask.PlayerSolid);
		Assert.True(t.Fraction < 1f);
		Assert.Equal(n.X, t.Normal.X, 4);
		Assert.Equal(n.Z, t.Normal.Z, 4);
	}

	[Fact]
	public void ModelsCollideAtTheirOrigin() {
		var door = new BrushModel(5, "door", [Brush.Box(new(-10, -10, -10), new(10, 10, 10))], origin: new(200, 0, 0));
		var world = new CollisionWorld([door]);
		var t = world.TraceHull(new(0, 0, 0), new(400, 0, 0), new(-1, -1, -1), new(1, 1, 1), ContentsMask.PlayerSolid);
		Assert.Equal(5, t.ModelId);
		Assert.Equal(189f - 0.03125f, t.EndPos.X, 3);

		door.Solid = false;
		Assert.Equal(1f, world.TraceHull(new(0, 0, 0), new(400, 0, 0), new(-1, -1, -1), new(1, 1, 1), ContentsMask.PlayerSolid).Fraction);
	}

	[Fact]
	public void ManyBrushesUseTheTreeAndFindTheNearestHit() {
		var brushes = new List<Brush>();
		for (var i = 0; i < 200; i++) brushes.Add(Brush.Box(new(i * 100 + 50, -10, -10), new(i * 100 + 60, 10, 10)));
		var world = World(brushes.ToArray());
		var t = world.TraceHull(new(1000, 0, 0), new(20000, 0, 0), new(-1, -1, -1), new(1, 1, 1), ContentsMask.PlayerSolid);
		Assert.Equal(1049f - 0.03125f, t.EndPos.X, 2);
	}
}
