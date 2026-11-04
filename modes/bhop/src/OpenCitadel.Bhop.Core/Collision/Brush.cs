using System.Numerics;

namespace OpenCitadel.Bhop.Collision;

/// <summary>One side of a convex brush: the plane dot(normal, p) = dist, solid behind it.</summary>
public readonly record struct BrushSide(Vector3 Normal, float Dist, bool Bevel = false);

/// <summary>
/// A convex brush: the intersection of the back half-spaces of its sides. Sides marked
/// <see cref="BrushSide.Bevel"/> are the extra axial and edge planes a BSP compiler adds so that box
/// sweeps don't catch on the expanded corners of the brush; point traces ignore them.
/// </summary>
public sealed class Brush {
	public BrushSide[] Sides { get; }
	public Contents Contents { get; }
	public Vector3 Mins { get; }
	public Vector3 Maxs { get; }

	public Brush(BrushSide[] sides, Contents contents, Vector3 mins, Vector3 maxs) {
		Sides = sides;
		Contents = contents;
		Mins = mins;
		Maxs = maxs;
	}

	/// <summary>An axis-aligned box brush.</summary>
	public static Brush Box(Vector3 mins, Vector3 maxs, Contents contents = Contents.Solid) => new([
		new(Vector3.UnitX, maxs.X), new(-Vector3.UnitX, -mins.X),
		new(Vector3.UnitY, maxs.Y), new(-Vector3.UnitY, -mins.Y),
		new(Vector3.UnitZ, maxs.Z), new(-Vector3.UnitZ, -mins.Z),
	], contents, mins, maxs);

	/// <summary>
	/// Builds a brush from its face planes, computing its bounds and adding the bevel planes a BSP
	/// compiler would (vbsp's AddBrushBevels): an axial plane for every axis direction without one,
	/// and planes along edges between non-axial faces. Used for brushes that don't come from a BSP,
	/// such as test geometry; brushes read from a BSP already carry their bevels.
	/// </summary>
	public static Brush FromPlanes(IReadOnlyList<(Vector3 Normal, float Dist)> planes, Contents contents = Contents.Solid) {
		var windings = Winding.ForBrush(planes);
		var mins = new Vector3(float.MaxValue);
		var maxs = new Vector3(float.MinValue);
		foreach (var w in windings) {
			foreach (var p in w) {
				mins = Vector3.Min(mins, p);
				maxs = Vector3.Max(maxs, p);
			}
		}
		if (mins.X > maxs.X) throw new ArgumentException("The planes don't enclose a volume.");

		var sides = new List<BrushSide>();
		foreach (var (n, d) in planes) sides.Add(new(Vector3.Normalize(n), d / n.Length()));

		// Axial bevels: one per axis direction the brush has no face for.
		for (var axis = 0; axis < 3; axis++) {
			for (var dir = -1; dir <= 1; dir += 2) {
				var normal = Vector3.Zero;
				normal[axis] = dir;
				if (sides.Any(s => Vector3.Dot(s.Normal, normal) > 0.9999f)) continue;
				var dist = dir > 0 ? maxs[axis] : -mins[axis];
				sides.Add(new(normal, dist, Bevel: true));
			}
		}

		// Edge bevels: for each edge between two non-axial faces, planes containing the edge and an
		// axis, kept when every brush vertex lies behind them.
		var vertices = windings.SelectMany(w => w).ToList();
		for (var i = 0; i < windings.Count; i++) {
			var w = windings[i];
			for (var j = 0; j < w.Count; j++) {
				var a = w[j];
				var b = w[(j + 1) % w.Count];
				var edge = b - a;
				if (edge.LengthSquared() < 0.25f) continue;
				edge = Vector3.Normalize(edge);
				if (IsAxial(edge)) continue;
				for (var axis = 0; axis < 3; axis++) {
					for (var dir = -1; dir <= 1; dir += 2) {
						var axisVec = Vector3.Zero;
						axisVec[axis] = dir;
						var normal = Vector3.Cross(edge, axisVec);
						if (normal.LengthSquared() < 0.5f) continue;
						normal = Vector3.Normalize(normal);
						var dist = Vector3.Dot(a, normal);
						if (sides.Any(s => Vector3.Dot(s.Normal, normal) > 0.9999f && MathF.Abs(s.Dist - dist) < 0.01f)) continue;
						if (vertices.Any(v => Vector3.Dot(v, normal) - dist > 0.1f)) continue;
						sides.Add(new(normal, dist, Bevel: true));
					}
				}
			}
		}
		return new Brush(sides.ToArray(), contents, mins, maxs);
	}

	private static bool IsAxial(Vector3 v) =>
		MathF.Abs(MathF.Abs(v.X) - 1) < 1e-4f || MathF.Abs(MathF.Abs(v.Y) - 1) < 1e-4f || MathF.Abs(MathF.Abs(v.Z) - 1) < 1e-4f;
}

/// <summary>Convex polygon helpers for turning brush planes into faces.</summary>
public static class Winding {
	private const float MaxCoord = 65536f;

	/// <summary>The face polygon of each plane of a convex brush (empty polygons dropped).</summary>
	public static List<List<Vector3>> ForBrush(IReadOnlyList<(Vector3 Normal, float Dist)> planes) {
		var result = new List<List<Vector3>>();
		for (var i = 0; i < planes.Count; i++) {
			var n = Vector3.Normalize(planes[i].Normal);
			var d = planes[i].Dist / planes[i].Normal.Length();
			var w = ForPlane(n, d);
			for (var j = 0; j < planes.Count && w.Count > 0; j++) {
				if (j == i) continue;
				var nj = Vector3.Normalize(planes[j].Normal);
				var dj = planes[j].Dist / planes[j].Normal.Length();
				w = Clip(w, nj, dj);
			}
			if (w.Count >= 3) result.Add(w);
		}
		return result;
	}

	/// <summary>A huge square lying in the plane, wound clockwise when seen from the front (Source's BaseWindingForPlane).</summary>
	public static List<Vector3> ForPlane(Vector3 normal, float dist) {
		var x = -1;
		var max = -1f;
		for (var i = 0; i < 3; i++) {
			var v = MathF.Abs(normal[i]);
			if (v > max) { x = i; max = v; }
		}
		var up = Vector3.Zero;
		if (x == 2) up.X = 1; else up.Z = 1;
		var v2 = Vector3.Dot(up, normal);
		up = Vector3.Normalize(up - normal * v2);
		var org = normal * dist;
		var right = Vector3.Cross(up, normal);
		up *= MaxCoord;
		right *= MaxCoord;
		return [org - right + up, org + right + up, org + right - up, org - right - up];
	}

	/// <summary>Keeps the part of the polygon behind the plane (dot(n, p) ≤ d).</summary>
	public static List<Vector3> Clip(List<Vector3> w, Vector3 n, float d, float epsilon = 0.01f) {
		var count = w.Count;
		var dists = new float[count];
		var sides = new int[count];
		bool front = false, back = false;
		for (var i = 0; i < count; i++) {
			dists[i] = Vector3.Dot(w[i], n) - d;
			sides[i] = dists[i] > epsilon ? 1 : dists[i] < -epsilon ? -1 : 0;
			if (sides[i] == 1) front = true;
			if (sides[i] == -1) back = true;
		}
		if (!front) return w;
		if (!back) return [];
		var result = new List<Vector3>(count + 4);
		for (var i = 0; i < count; i++) {
			var p1 = w[i];
			if (sides[i] <= 0) result.Add(p1);
			var next = (i + 1) % count;
			if (sides[i] == 0 || sides[next] == 0 || sides[i] == sides[next]) continue;
			var t = dists[i] / (dists[i] - dists[next]);
			result.Add(p1 + (w[next] - p1) * t);
		}
		return result;
	}
}
