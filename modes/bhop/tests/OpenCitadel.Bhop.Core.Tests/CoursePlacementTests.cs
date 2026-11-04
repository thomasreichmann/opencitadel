using System.Numerics;
using OpenCitadel.Bhop.Map;

namespace OpenCitadel.Bhop.Tests;

/// <summary>Courses drawn into a Deadlock map: clear of its geometry, inside what clients draw.</summary>
public class CoursePlacementTests {
	// new_player_basics, roughly: a city block around the origin.
	private static readonly (Vector3, Vector3) City = (new Vector3(-6000, -6000, -500), new Vector3(6000, 6000, 3000));

	private static void AssertInside((Vector3 Mins, Vector3 Maxs) course, Vector3 move) {
		Assert.True(Vector3.Min(course.Mins + move, -CoursePlacement.Limit) == -CoursePlacement.Limit, $"{course.Mins + move} is past the edge");
		Assert.True(Vector3.Max(course.Maxs + move, CoursePlacement.Limit) == CoursePlacement.Limit, $"{course.Maxs + move} is past the edge");
	}

	[Fact]
	public void NothingToAvoidMeansNoMove() =>
		Assert.Equal(Vector3.Zero, CoursePlacement.Choose((new Vector3(-100), new Vector3(100)), null, 500));

	[Fact]
	public void ASmallCourseClearsTheMapCompletely() {
		var eazy = (Mins: new Vector3(-2272, -1920, 0), Maxs: new Vector3(2784, 704, 704));
		var move = CoursePlacement.Choose(eazy, City, 500);
		AssertInside(eazy, move);
		Assert.Equal(0f, CoursePlacement.Overlap(eazy.Mins + move, eazy.Maxs + move, City.Item1 - new Vector3(500), City.Item2 + new Vector3(500)));
	}

	[Fact]
	public void AWholeWorldCourseOverlapsAsLittleAsItCan() {
		// bhop_arcane spans nearly all of CS:S's world on every axis.
		var arcane = (Mins: new Vector3(-15424, -15424, -14976), Maxs: new Vector3(13376, 15872, 15936));
		var move = CoursePlacement.Choose(arcane, City, 500);
		AssertInside(arcane, move);
		var left = CoursePlacement.Overlap(arcane.Mins + move, arcane.Maxs + move, City.Item1, City.Item2);
		var unmoved = CoursePlacement.Overlap(arcane.Mins, arcane.Maxs, City.Item1, City.Item2);
		// It can't clear a 13000-unit city while 28800 wide in a 64000-unit world, but it gets to a corner.
		Assert.True(left < unmoved / 5, $"overlap {left} vs {unmoved} unmoved");
	}

	[Fact]
	public void HeightStaysWhereClientsDraw() {
		// Lifting this one above the city would take it past the height clients still draw.
		var tall = (Mins: new Vector3(-1000, -1000, -8000), Maxs: new Vector3(1000, 1000, 15000));
		var move = CoursePlacement.Choose(tall, City, 500);
		AssertInside(tall, move);
		Assert.True(tall.Maxs.Z + move.Z <= CoursePlacement.Limit.Z);
		Assert.Equal(0f, CoursePlacement.Overlap(tall.Mins + move, tall.Maxs + move, City.Item1, City.Item2));
	}
}
