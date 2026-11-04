using System.Numerics;

namespace OpenCitadel.Bhop.Map;

/// <summary>
/// Where to put a course drawn into a Deadlock map: moved clear of that map's own geometry, inside
/// the part of the world clients still draw. Deadlock clamps entity positions at ±32767 and stops
/// drawing them past about ±16384 in height (measured on build 6844: drawn at 15000, gone at 20000),
/// and CS:S maps can be 32768 units across, so a big course can't always clear the map entirely;
/// it then goes where the two overlap least.
/// </summary>
public static class CoursePlacement {
	/// <summary>How far from the world's edge a course stays, per axis.</summary>
	public static readonly Vector3 Limit = new(32000f, 32000f, 16000f);

	/// <summary>
	/// The move for a course with bounds <paramref name="course"/> into a world whose own geometry
	/// fills <paramref name="obstacle"/> (null: nothing to avoid), kept <paramref name="margin"/> clear.
	/// </summary>
	public static Vector3 Choose((Vector3 Mins, Vector3 Maxs) course, (Vector3 Mins, Vector3 Maxs)? obstacle, float margin) {
		if (obstacle is not { } o) return Vector3.Zero;
		var lo = -Limit - course.Mins; // the smallest move per axis that keeps the course inside
		var hi = Limit - course.Maxs; // and the largest
		var blocked = (Mins: o.Mins - new Vector3(margin), Maxs: o.Maxs + new Vector3(margin));
		// Per axis: no move, or as far as allowed either way, or just clear of the obstacle either way.
		float[] Options(int axis) {
			var options = new List<float> { 0f, Get(lo, axis), Get(hi, axis),
				Get(blocked.Maxs, axis) - Get(course.Mins, axis), Get(blocked.Mins, axis) - Get(course.Maxs, axis) };
			return options.Where(t => t >= Get(lo, axis) - 0.5f && t <= Get(hi, axis) + 0.5f).Distinct().ToArray();
		}
		var best = Vector3.Zero;
		var bestOverlap = float.MaxValue;
		var bestDistance = float.MaxValue;
		foreach (var x in Options(0))
		foreach (var y in Options(1))
		foreach (var z in Options(2)) {
			var t = new Vector3(x, y, z);
			var overlap = Overlap(course.Mins + t, course.Maxs + t, blocked.Mins, blocked.Maxs);
			var distance = t.Length();
			if (overlap < bestOverlap - 1f || (MathF.Abs(overlap - bestOverlap) <= 1f && distance < bestDistance)) {
				best = t;
				bestOverlap = overlap;
				bestDistance = distance;
			}
		}
		return new Vector3(MathF.Round(best.X), MathF.Round(best.Y), MathF.Round(best.Z));
	}

	private static float Get(Vector3 v, int axis) => axis switch { 0 => v.X, 1 => v.Y, _ => v.Z };

	/// <summary>Volume shared by two boxes.</summary>
	public static float Overlap(Vector3 aMins, Vector3 aMaxs, Vector3 bMins, Vector3 bMaxs) {
		var d = Vector3.Min(aMaxs, bMaxs) - Vector3.Max(aMins, bMins);
		return d.X <= 0 || d.Y <= 0 || d.Z <= 0 ? 0f : d.X * d.Y * d.Z;
	}
}
