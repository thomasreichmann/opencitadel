using System.Numerics;
using OpenCitadel.Bhop.Map;
using OpenCitadel.Bhop.Porter.Bsp;
using OpenCitadel.Bhop.Porter.Vmap;

namespace OpenCitadel.Bhop.Porter.Panels;

/// <summary>
/// A map's visible surfaces as flat coloured rectangles (<see cref="MapPanel"/>): what the plugin
/// draws for players who don't have the map's package. Each face takes its texture's average colour
/// (the BSP stores it), shaded by the way it faces, since panels are drawn fullbright. Coplanar faces
/// of one colour are merged back into large rectangles; slanted edges become fine steps.
/// </summary>
public static class PanelBuilder {
	public sealed record Options {
		/// <summary>The smallest step a slanted edge becomes.</summary>
		public float StepSize { get; init; } = 16f;
		/// <summary>The most steps per slanted polygon: panels are entities, and big ramps would need hundreds.</summary>
		public int MaxSteps { get; init; } = 12;
		/// <summary>Rectangles thinner than this are left out (slivers between faces cost entities for nothing).</summary>
		public float MinSize { get; init; } = 1f;
		/// <summary>Texture colours are rounded to this many levels per channel, so faces of similar textures merge.</summary>
		public int ColorLevels { get; init; } = 24;
		/// <summary>Where the light seems to come from.</summary>
		public Vector3 LightDirection { get; init; } = Vector3.Normalize(new Vector3(0.35f, 0.2f, 0.9f));
	}

	public sealed record Stats(int Faces, int Groups, int Panels, int SkyboxFaces, int Displacements);

	private readonly record struct GroupKey(int Nx, int Ny, int Nz, int Dist, int Color);

	private sealed class Group(Vector3 normal, float dist, int color) {
		public Vector3 Normal { get; } = normal;
		public float Dist { get; } = dist;
		public int Color { get; } = color;
		public List<Vector3[]> Polygons { get; } = new();
	}

	public static (List<MapPanel> Panels, Stats Stats) Build(BspFile bsp, Options? options = null) {
		var o = options ?? new Options();
		var entities = BspEntity.ParseLump(bsp.EntityText);
		var skybox = SkyboxFaces(bsp, entities);
		var groups = new Dictionary<GroupKey, Group>();
		int faces = 0, displacements = 0;
		foreach (var (modelIndex, origin) in VmapExporter.VisibleModels(bsp, entities)) {
			var model = bsp.Models[modelIndex];
			for (var f = model.FirstFace; f < model.FirstFace + model.NumFaces; f++) {
				if (modelIndex == 0 && skybox.Contains(f)) continue;
				var face = bsp.Faces[f];
				if (face.TexInfo < 0) continue;
				var texInfo = bsp.TexInfos[face.TexInfo];
				var texData = texInfo.TexData >= 0 && texInfo.TexData < bsp.TexData.Length ? bsp.TexData[texInfo.TexData] : default;
				var texName = texData.Name ?? "";
				if (VmapExporter.IsHidden(texInfo, texName)) continue;
				if (face.DispInfo >= 0) {
					// Displacements are terrain: hundreds of tilted triangles each. Their base face stands in.
					displacements++;
				}
				var positions = bsp.FaceVertices(face).Select(p => p + origin).ToArray();
				if (positions.Length < 3) continue;
				var plane = bsp.Planes[face.PlaneNum];
				// The front is opposite the counter-clockwise normal (BSP windings are clockwise), as in VmapExporter.
				var normal = Vector3.Dot(VmapExporter.NewellNormal(positions), plane.Normal) <= 0 ? plane.Normal : -plane.Normal;
				var dist = Vector3.Dot(normal, positions[0]);
				var color = Shade(Quantize(BaseColor(texName, texData.Reflectivity), o.ColorLevels), normal, o.LightDirection);
				var key = new GroupKey((int)MathF.Round(normal.X * 1000), (int)MathF.Round(normal.Y * 1000), (int)MathF.Round(normal.Z * 1000),
					(int)MathF.Round(dist * 8), color);
				if (!groups.TryGetValue(key, out var group)) groups[key] = group = new Group(normal, dist, color);
				group.Polygons.Add(positions);
				faces++;
			}
		}
		var panels = new List<MapPanel>();
		foreach (var g in groups.Values) panels.AddRange(Rectangles(g, o));
		return (panels, new Stats(faces, groups.Count, panels.Count, skybox.Count, displacements));
	}

	/// <summary>
	/// Faces of the 3D skybox: a sealed room CS:S draws behind everything, scaled up, as the backdrop.
	/// Drawn where it really is, it would float somewhere off the course.
	/// </summary>
	private static HashSet<int> SkyboxFaces(BspFile bsp, List<BspEntity> entities) {
		var camera = entities.FirstOrDefault(e => e.ClassName.Equals("sky_camera", StringComparison.OrdinalIgnoreCase));
		if (camera == null || bsp.Leafs.Length == 0 || bsp.Nodes.Length == 0) return [];
		var area = bsp.Leafs[bsp.LeafAt(camera.Origin)].Area;
		// Never the area players start in (a map without a separate skybox room).
		foreach (var spawn in entities.Where(e => e.ClassName.StartsWith("info_player", StringComparison.OrdinalIgnoreCase))) {
			if (bsp.Leafs[bsp.LeafAt(spawn.Origin + new Vector3(0, 0, 16))].Area == area) return [];
		}
		return bsp.FacesInArea(area);
	}

	/// <summary>A texture's average colour as sRGB; toolsblack is black, as CS:S draws it.</summary>
	internal static Vector3 BaseColor(string texName, Vector3 reflectivity) {
		if (texName.Equals("TOOLS/TOOLSBLACK", StringComparison.OrdinalIgnoreCase)) return new Vector3(0.06f, 0.06f, 0.07f);
		if (reflectivity == Vector3.Zero) return new Vector3(0.78f);
		static float S(float v) => MathF.Pow(Math.Clamp(v, 0f, 1f), 1f / 2.2f);
		return new Vector3(S(reflectivity.X), S(reflectivity.Y), S(reflectivity.Z));
	}

	private static Vector3 Quantize(Vector3 c, int levels) {
		if (levels <= 1) return c;
		static float Q(float v, int n) => MathF.Round(v * (n - 1)) / (n - 1);
		return new Vector3(Q(c.X, levels), Q(c.Y, levels), Q(c.Z, levels));
	}

	/// <summary>Bakes simple lighting in: full brightness facing the light, 55% facing away.</summary>
	internal static int Shade(Vector3 srgb, Vector3 normal, Vector3 light) {
		var shade = 0.55f + 0.45f * (0.5f + 0.5f * Vector3.Dot(normal, light));
		static int B(float v) => (int)Math.Clamp(MathF.Round(v * 255f), 0f, 255f);
		return (B(srgb.X * shade) << 16) | (B(srgb.Y * shade) << 8) | B(srgb.Z * shade);
	}

	/// <summary>
	/// Axes in a face's plane, with u × v = normal: on floors and ceilings u is x; elsewhere v runs up
	/// the slope (straight up on walls), so the long edges of walls and ramps line up with u.
	/// </summary>
	internal static (Vector3 U, Vector3 V) Basis(Vector3 normal) {
		if (MathF.Abs(normal.Z) > 0.999f) {
			var u = Vector3.UnitX;
			return (u, Vector3.Normalize(Vector3.Cross(normal, u)));
		}
		var v = Vector3.Normalize(Vector3.UnitZ - normal * normal.Z);
		return (Vector3.Normalize(Vector3.Cross(v, normal)), v);
	}

	/// <summary>
	/// The rectangles covering a group of coplanar polygons: sliced at every corner's height (and in
	/// steps where an edge slants), each slice's covered spans taken at its middle, then slices with
	/// the same spans joined back together.
	/// </summary>
	private static List<MapPanel> Rectangles(Group g, Options o) {
		// Sliced one way or the other, whichever takes fewer rectangles (u' × v' still = normal).
		var (u, v) = Basis(g.Normal);
		var a = Sweep(g, u, v, o);
		var b = Sweep(g, v, -u, o);
		return b.Count < a.Count ? b : a;
	}

	private static List<MapPanel> Sweep(Group g, Vector3 u, Vector3 v, Options o) {
		var result = new List<MapPanel>();
		static float Q(float x) => MathF.Round(x * 64f) / 64f;
		var polys = g.Polygons.Select(p => p.Select(x => new Vector2(Q(Vector3.Dot(x, u)), Q(Vector3.Dot(x, v)))).ToArray()).ToList();
		var cuts = new SortedSet<float>();
		foreach (var p in polys) {
			var vmin = p.Min(x => x.Y);
			var vmax = p.Max(x => x.Y);
			foreach (var x in p) cuts.Add(x.Y);
			if (!Slanted(p)) continue;
			var steps = Math.Clamp((int)MathF.Ceiling((vmax - vmin) / o.StepSize), 1, o.MaxSteps);
			for (var i = 1; i < steps; i++) cuts.Add(Q(vmin + (vmax - vmin) * i / steps));
		}
		var levels = cuts.ToArray();
		// Open rectangles: a span and the height it started at, carried up while the next slice has it too.
		var open = new Dictionary<(float, float), float>();
		var done = new List<(float U0, float U1, float V0, float V1)>();
		var top = levels.Length > 0 ? levels[0] : 0f;
		for (var i = 0; i + 1 < levels.Length; i++) {
			var v0 = levels[i];
			var v1 = levels[i + 1];
			if (v1 - v0 < 0.01f) continue;
			var spans = Spans(polys, (v0 + v1) / 2);
			var next = new Dictionary<(float, float), float>();
			foreach (var span in spans) {
				// Carried on only from a slice ending right where this one starts.
				next[span] = open.TryGetValue(span, out var start) && MathF.Abs(top - v0) < 0.01f ? start : v0;
			}
			foreach (var (span, start) in open) {
				if (!next.TryGetValue(span, out var s) || s != start) done.Add((span.Item1, span.Item2, start, top));
			}
			open = next;
			top = v1;
		}
		foreach (var (span, start) in open) done.Add((span.Item1, span.Item2, start, top));

		foreach (var (u0, u1, v0, v1) in done) {
			var w = u1 - u0;
			var h = v1 - v0;
			if (w < o.MinSize || h < o.MinSize) continue;
			var centre = u * ((u0 + u1) / 2) + v * ((v0 + v1) / 2) + g.Normal * g.Dist;
			result.Add(new MapPanel {
				Origin = Vec3.From(centre), U = Vec3.From(u), V = Vec3.From(v), Width = w, Height = h, Color = g.Color,
			});
		}
		return result;
	}

	/// <summary>Whether a polygon has an edge that is neither along u nor along v.</summary>
	private static bool Slanted(Vector2[] p) {
		for (var i = 0; i < p.Length; i++) {
			var d = p[(i + 1) % p.Length] - p[i];
			if (MathF.Abs(d.X) > 0.05f && MathF.Abs(d.Y) > 0.05f) return true;
		}
		return false;
	}

	/// <summary>The merged spans of u the polygons cover along the line at height v.</summary>
	private static List<(float, float)> Spans(List<Vector2[]> polys, float v) {
		var spans = new List<(float A, float B)>();
		foreach (var p in polys) {
			float a = float.MaxValue, b = float.MinValue;
			for (var i = 0; i < p.Length; i++) {
				var p0 = p[i];
				var p1 = p[(i + 1) % p.Length];
				if ((p0.Y - v) * (p1.Y - v) > 0 || p0.Y == p1.Y) continue;
				var x = p0.X + (v - p0.Y) / (p1.Y - p0.Y) * (p1.X - p0.X);
				a = MathF.Min(a, x);
				b = MathF.Max(b, x);
			}
			if (b - a > 0.01f) spans.Add((a, b));
		}
		spans.Sort();
		var merged = new List<(float, float)>();
		foreach (var (a, b) in spans) {
			if (merged.Count > 0 && a <= merged[^1].Item2 + 0.02f) merged[^1] = (merged[^1].Item1, MathF.Max(merged[^1].Item2, b));
			else merged.Add((a, b));
		}
		return merged.Select(s => (MathF.Round(s.Item1 * 64f) / 64f, MathF.Round(s.Item2 * 64f) / 64f)).ToList();
	}
}
