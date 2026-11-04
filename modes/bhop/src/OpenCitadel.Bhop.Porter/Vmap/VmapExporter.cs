using System.Globalization;
using System.Numerics;
using OpenCitadel.Bhop.Collision;
using OpenCitadel.Bhop.Map;
using OpenCitadel.Bhop.Porter.Bsp;

namespace OpenCitadel.Bhop.Porter.Vmap;

/// <summary>Choices for turning a BSP into a Hammer map.</summary>
public sealed record VmapOptions {
	/// <summary>
	/// The Deadlock material every visible face uses until real textures are ported. Faces are tinted
	/// with their original texture's average colour, which the BSP stores per texture.
	/// </summary>
	public string BaseMaterial { get; init; } = "materials/dev/white_paint.vmat";
	/// <summary>Material for player-clip brushes, so Deadlock's own collision matches the original.</summary>
	public string ClipMaterial { get; init; } = "materials/tools/toolsplayerclip.vmat";
	/// <summary>Sky for env_sky.</summary>
	public string SkyMaterial { get; init; } = "materials/skybox/dl_midtown_dusk_02.vmat";
	/// <summary>
	/// Ported material for a BSP texture name, or null to fall back to <see cref="BaseMaterial"/>
	/// tinted with the texture's average colour.
	/// </summary>
	public Func<string, string?>? MaterialFor { get; init; }
	/// <summary>
	/// Reverse each face's corner order. BSP faces are clockwise seen from the front; Source 2 meshes
	/// are counter-clockwise (checked against Deadlock's own maps, whose floor triangles' right-hand
	/// normals point up), so this is on by default.
	/// </summary>
	public bool ReverseWinding { get; init; } = true;
}

/// <summary>Builds a Hammer .vmap (Deadlock content) from a CS:S/CS:GO BSP and its extracted map data.</summary>
public static class VmapExporter {
	/// <summary>Brush entities drawn as part of the world. The plugin handles their behaviour.</summary>
	private static readonly HashSet<string> VisibleBrushClasses = new(StringComparer.OrdinalIgnoreCase) {
		"func_wall", "func_wall_toggle", "func_brush", "func_breakable", "func_door", "func_door_rotating",
		"func_button", "func_rot_button", "func_movelinear", "func_rotating", "func_illusionary", "func_lod",
		"func_physbox", "func_physbox_multiplayer", "func_tracktrain", "func_train", "func_conveyor",
		"func_detail_blocker", "momentary_rot_button",
	};

	public sealed record Stats(int Faces, int Meshes, int SkippedFaces, int Displacements, int ClipBrushes);

	public static (CMapRootElement Root, Stats Stats) Build(BspFile bsp, BhopMapData data, VmapOptions options) {
		var root = new CMapRootElement();
		var entities = BspEntity.ParseLump(bsp.EntityText);

		var groups = new Dictionary<string, (PolygonMeshBuilder Builder, Vector3 Color, bool Ported)>(StringComparer.OrdinalIgnoreCase);
		int faces = 0, skipped = 0, displacements = 0;
		foreach (var (modelIndex, origin) in VisibleModels(bsp, entities)) {
			var model = bsp.Models[modelIndex];
			for (var f = model.FirstFace; f < model.FirstFace + model.NumFaces; f++) {
				var face = bsp.Faces[f];
				if (face.TexInfo < 0) { skipped++; continue; }
				var texInfo = bsp.TexInfos[face.TexInfo];
				var texData = texInfo.TexData >= 0 && texInfo.TexData < bsp.TexData.Length ? bsp.TexData[texInfo.TexData] : default;
				var texName = texData.Name ?? "";
				if (IsHidden(texInfo, texName)) { skipped++; continue; }

				if (!groups.TryGetValue(texName, out var group)) {
					var ported = options.MaterialFor?.Invoke(texName);
					group = (new PolygonMeshBuilder(), texData.Reflectivity, ported != null);
					group.Builder.Material(ported ?? options.BaseMaterial);
					groups[texName] = group;
				}
				const int material = 0;

				if (face.DispInfo >= 0) {
					foreach (var poly in Displacement(bsp, face, texInfo, texData, origin, material, options)) group.Builder.Add(poly);
					displacements++;
					continue;
				}

				var positions = bsp.FaceVertices(face).Select(p => p + origin).ToArray();
				var plane = bsp.Planes[face.PlaneNum];
				// The front is where the winding says: BSP faces are clockwise seen from the front, so
				// the counter-clockwise (Newell) normal points away. Don't flip by the face's side
				// flag: windings face the stored plane either way (checked on bhop_eazy and
				// surf_utopia), and flipping lit 40% of faces from behind.
				var normal = Vector3.Dot(NewellNormal(positions), plane.Normal) <= 0 ? plane.Normal : -plane.Normal;
				foreach (var piece in CompilerSafe(positions, plane, origin)) group.Builder.Add(Polygon(piece, normal, texInfo, texData, origin, material, options));
				faces++;
			}
		}

		var meshes = 0;
		foreach (var (name, (builder, color, ported)) in groups.OrderBy(g => g.Key)) {
			if (builder.PolygonCount == 0) continue;
			root.World.Children.Add(new CMapMesh {
				Name = MeshName(name),
				MeshData = builder.Build(),
				TintColor = ported ? new Datamodel.Color(255, 255, 255, 255) : ToColor(color),
				BakeLighting = false,
			});
			meshes++;
		}

		var clipBrushes = AddClips(root, data, options);
		AddEntities(root, data, entities, options);
		return (root, new Stats(faces, meshes, skipped, displacements, clipBrushes));
	}

	/// <summary>The brush models drawn in game, with their origins: the world plus visible brush entities.</summary>
	internal static List<(int Model, Vector3 Origin)> VisibleModels(BspFile bsp, List<BspEntity> entities) {
		var models = new List<(int Model, Vector3 Origin)> { (0, Vector3.Zero) };
		foreach (var e in entities) {
			var m = e.BrushModel;
			if (m > 0 && m < bsp.Models.Length && VisibleBrushClasses.Contains(e.ClassName)) {
				if (e.ClassName.Equals("func_brush", StringComparison.OrdinalIgnoreCase) && e.Int("rendermode") == 10) continue; // don't render
				models.Add((m, e.Origin));
			}
		}
		return models;
	}

	/// <summary>
	/// Whether CS:S leaves a face undrawn: sky, nodraw, hint, skip and trigger surfaces, and tool
	/// textures, except toolsblack, which it draws solid black (surf maps build whole ramps from it).
	/// </summary>
	internal static bool IsHidden(TexInfo texInfo, string texName) {
		const SurfaceFlags hidden = SurfaceFlags.NoDraw | SurfaceFlags.Sky | SurfaceFlags.Sky2D | SurfaceFlags.Hint |
		                            SurfaceFlags.Skip | SurfaceFlags.Trigger;
		if ((texInfo.Flags & hidden) != 0) return true;
		return texName.StartsWith("TOOLS/", StringComparison.OrdinalIgnoreCase) &&
		       !texName.Equals("TOOLS/TOOLSBLACK", StringComparison.OrdinalIgnoreCase);
	}

	/// <summary>
	/// The vmap format revision Deadlock's compiler reads natively (its format descriptor reports 40);
	/// older revisions go through an upgrade step that needs dmxconvert.exe, which Deadlock lacks.
	/// </summary>
	public const int VmapFormatVersion = 40;

	public static void Save(CMapRootElement root, string path) {
		using var dm = new Datamodel.Datamodel("vmap", VmapFormatVersion);
		dm.Root = root;
		using var file = File.Create(path);
		// Binary DMX, as Hammer saves maps: the compiler reads text maps only through dmxconvert.exe,
		// which Deadlock doesn't ship.
		dm.Save(file, "binary", 9);
	}

	// ------------------------------------------------------------------ faces

	/// <summary>
	/// A face as polygons Deadlock's compiler accepts. Most BSP faces pass through whole. Faces with
	/// slivers of edges (under a unit) or corners off their plane (decompiled maps such as
	/// surf_utopia_v3 are full of them) are split into a triangle fan: the compiler drops such
	/// polygons when it triangulates them itself, and a triangle is always flat. Duplicate corners
	/// are removed either way; T-junction corners are kept so neighbouring faces stay crack-free.
	/// </summary>
	internal static IEnumerable<Vector3[]> CompilerSafe(Vector3[] positions, Bsp.Plane plane, Vector3 origin) {
		var points = new List<Vector3>(positions.Length);
		foreach (var p in positions) {
			if (points.Count == 0 || Vector3.DistanceSquared(points[^1], p) > 1e-4f) points.Add(p);
		}
		if (points.Count > 1 && Vector3.DistanceSquared(points[0], points[^1]) <= 1e-4f) points.RemoveAt(points.Count - 1);
		if (points.Count < 3) yield break;

		var risky = false;
		for (var i = 0; i < points.Count && !risky; i++) {
			if (Vector3.Distance(points[i], points[(i + 1) % points.Count]) < 1f) risky = true;
			if (MathF.Abs(Vector3.Dot(points[i] - origin, plane.Normal) - plane.Dist) > 0.01f) risky = true; // planes are model-local
		}
		if (!risky || points.Count == 3) {
			yield return points.ToArray();
			yield break;
		}
		for (var i = 1; i + 1 < points.Count; i++) {
			var a = points[0];
			var b = points[i];
			var c = points[i + 1];
			if (Vector3.Cross(b - a, c - a).LengthSquared() < 1e-6f) continue; // zero area
			yield return [a, b, c];
		}
	}

	/// <summary>Newell's method: the (unnormalised) normal of a polygon, counter-clockwise front.</summary>
	internal static Vector3 NewellNormal(IReadOnlyList<Vector3> p) {
		var n = Vector3.Zero;
		for (var i = 0; i < p.Count; i++) {
			var a = p[i];
			var b = p[(i + 1) % p.Count];
			n.X += (a.Y - b.Y) * (a.Z + b.Z);
			n.Y += (a.Z - b.Z) * (a.X + b.X);
			n.Z += (a.X - b.X) * (a.Y + b.Y);
		}
		return n;
	}

	private static MeshPolygon Polygon(Vector3[] positions, Vector3 normal, TexInfo texInfo, TexData texData, Vector3 origin, int material, VmapOptions options) {
		if (options.ReverseWinding) Array.Reverse(positions);
		var width = Math.Max(1, texData.Width);
		var height = Math.Max(1, texData.Height);
		var uvs = positions.Select(p => TexCoord(p - origin, texInfo, width, height)).ToArray();
		return new MeshPolygon {
			Positions = positions,
			TexCoords = uvs,
			Normal = normal,
			MaterialIndex = material,
			AxisU = Axis(texInfo.S),
			AxisV = Axis(texInfo.T),
			Scale = new Vector2(Scale(texInfo.S), Scale(texInfo.T)),
		};
	}

	private static Vector2 TexCoord(Vector3 p, TexInfo t, int width, int height) => new(
		(Vector3.Dot(p, new Vector3(t.S.X, t.S.Y, t.S.Z)) + t.S.W) / width,
		(Vector3.Dot(p, new Vector3(t.T.X, t.T.Y, t.T.Z)) + t.T.W) / height);

	/// <summary>Hammer stores a texture axis as a unit vector plus the offset, with the scale apart.</summary>
	private static Vector4 Axis(Vector4 v) {
		var axis = new Vector3(v.X, v.Y, v.Z);
		var len = axis.Length();
		return len > 0 ? new Vector4(axis / len, v.W) : new Vector4(1, 0, 0, 0);
	}

	private static float Scale(Vector4 v) {
		var len = new Vector3(v.X, v.Y, v.Z).Length();
		return len > 0 ? 1f / len : 0.25f;
	}

	/// <summary>
	/// A displacement surface as triangles: the base quad subdivided into a (2^power + 1)² grid, each
	/// vertex pushed out along its stored offset.
	/// </summary>
	private static IEnumerable<MeshPolygon> Displacement(BspFile bsp, Face face, TexInfo texInfo, TexData texData, Vector3 origin, int material, VmapOptions options) {
		var info = bsp.DispInfos[face.DispInfo];
		var corners = bsp.FaceVertices(face);
		if (corners.Length != 4) yield break;
		// The grid starts at the corner nearest the stored start position.
		var start = 0;
		var best = float.MaxValue;
		for (var i = 0; i < 4; i++) {
			var d = Vector3.DistanceSquared(corners[i], info.StartPosition);
			if (d < best) { best = d; start = i; }
		}
		var c0 = corners[start];
		var c1 = corners[(start + 1) % 4];
		var c2 = corners[(start + 2) % 4];
		var c3 = corners[(start + 3) % 4];
		var size = (1 << info.Power) + 1;
		var verts = new Vector3[size * size];
		for (var y = 0; y < size; y++) {
			var ty = y / (float)(size - 1);
			var left = Vector3.Lerp(c0, c3, ty);
			var right = Vector3.Lerp(c1, c2, ty);
			for (var x = 0; x < size; x++) {
				var tx = x / (float)(size - 1);
				var dv = bsp.DispVerts[info.DispVertStart + y * size + x];
				verts[y * size + x] = Vector3.Lerp(left, right, tx) + dv.Vector * dv.Dist + origin;
			}
		}
		var width = Math.Max(1, texData.Width);
		var height = Math.Max(1, texData.Height);
		for (var y = 0; y < size - 1; y++) {
			for (var x = 0; x < size - 1; x++) {
				var a = verts[y * size + x];
				var b = verts[y * size + x + 1];
				var c = verts[(y + 1) * size + x + 1];
				var d = verts[(y + 1) * size + x];
				foreach (var tri in (Vector3[][])[[a, b, c], [a, c, d]]) {
					var n = Vector3.Cross(tri[1] - tri[0], tri[2] - tri[0]);
					if (n.LengthSquared() < 1e-6f) continue;
					var positions = options.ReverseWinding ? tri.Reverse().ToArray() : tri;
					yield return new MeshPolygon {
						Positions = positions,
						TexCoords = positions.Select(p => TexCoord(p - origin, texInfo, width, height)).ToArray(),
						Normal = Vector3.Normalize(n),
						MaterialIndex = material,
						AxisU = Axis(texInfo.S),
						AxisV = Axis(texInfo.T),
						Scale = new Vector2(Scale(texInfo.S), Scale(texInfo.T)),
					};
				}
			}
		}
	}

	// ------------------------------------------------------------------ clips and entities

	/// <summary>Player-clip brushes become invisible clip meshes, so Deadlock's own collision has them too.</summary>
	private static int AddClips(CMapRootElement root, BhopMapData data, VmapOptions options) {
		var builder = new PolygonMeshBuilder();
		var material = builder.Material(options.ClipMaterial);
		var count = 0;
		foreach (var model in data.Models) {
			var origin = model.Origin.ToVector3();
			foreach (var brush in model.Brushes) {
				var contents = (Contents)brush.Contents;
				if ((contents & Contents.PlayerClip) == 0 || (contents & Contents.Solid) != 0) continue;
				var planes = brush.Sides.Where(s => s.Length < 5 || s[4] == 0).Select(s => (new Vector3(s[0], s[1], s[2]), s[3])).ToList();
				// Brush windings are clockwise seen from the front, like BSP faces, so the right-handed
				// normal points into the brush; the outward normal is its negation.
				foreach (var w in Winding.ForBrush(planes)) {
					var positions = w.Select(p => p + origin).ToArray();
					var n = -Vector3.Normalize(Vector3.Cross(positions[1] - positions[0], positions[2] - positions[0]));
					if (options.ReverseWinding) Array.Reverse(positions);
					builder.Add(new MeshPolygon {
						Positions = positions,
						TexCoords = new Vector2[positions.Length],
						Normal = n,
						MaterialIndex = material,
						AxisU = new Vector4(1, 0, 0, 0),
						AxisV = new Vector4(0, 0, -1, 0),
					});
				}
				count++;
			}
		}
		if (builder.PolygonCount > 0) root.World.Children.Add(new CMapMesh { Name = "playerclip", MeshData = builder.Build(), BakeLighting = false });
		return count;
	}

	private static void AddEntities(CMapRootElement root, BhopMapData data, List<BspEntity> entities, VmapOptions options) {
		// Deadlock spawns heroes at info_team_spawn, one team each.
		var spawn = data.Spawns.FirstOrDefault();
		var spawnOrigin = spawn?.Origin.ToVector3() ?? Vector3.Zero;
		var spawnYaw = spawn?.Angles.Y ?? 0f;
		foreach (var team in (int[])[2, 3]) {
			root.World.Children.Add(Entity("info_team_spawn", spawnOrigin, new Vector3(0, spawnYaw, 0),
				("teamnumber", team.ToString(CultureInfo.InvariantCulture)), ("lanenum", "0"), ("initialspawn", "0")));
		}

		// Sun and sky, from the original light_environment where there is one.
		var sun = entities.FirstOrDefault(e => e.ClassName.Equals("light_environment", StringComparison.OrdinalIgnoreCase));
		var sunAngles = sun?.Angles ?? new Vector3(-50, 30, 0);
		if (sun?["pitch"] is { } pitch && float.TryParse(pitch, NumberStyles.Float, CultureInfo.InvariantCulture, out var p)) sunAngles.X = p;
		var light = ParseLight(sun?["_light"]) ?? new Vector4(255, 245, 230, 400);
		var ambient = ParseLight(sun?["_ambient"]) ?? new Vector4(150, 170, 200, 100);
		root.World.Children.Add(Entity("light_environment", new Vector3(0, 0, data.Models.Count > 0 ? 512 : 0), new Vector3(-sunAngles.X, sunAngles.Y, 0),
			("enabled", "1"), ("color", $"{light.X:0} {light.Y:0} {light.Z:0}"), ("brightness", "1.5"), ("directlight", "2"),
			("castshadows", "1"), ("skycolor", $"{ambient.X:0} {ambient.Y:0} {ambient.Z:0}"), ("skyintensity", "0.8"), ("bouncescale", "1.0")));
		root.World.Children.Add(Entity("env_sky", Vector3.Zero, Vector3.Zero, ("skyname", options.SkyMaterial), ("tint_color", "255 255 255"),
			("brightnessscale", "1.0"), ("fog_type", "0")));
		root.World.Set("skyname", options.SkyMaterial);
	}

	private static CMapEntity Entity(string className, Vector3 origin, Vector3 angles, params (string Key, string Value)[] keys) {
		var e = new CMapEntity { Origin = origin, Angles = new Datamodel.QAngle(angles.X, angles.Y, angles.Z) };
		e.Set("classname", className);
		foreach (var (k, v) in keys) e.Set(k, v);
		return e;
	}

	/// <summary>Source's "_light" format: "r g b brightness".</summary>
	private static Vector4? ParseLight(string? text) {
		if (string.IsNullOrWhiteSpace(text)) return null;
		var parts = text.Split(' ', StringSplitOptions.RemoveEmptyEntries)
			.Select(s => float.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var v) ? v : 0f).ToArray();
		return parts.Length >= 4 ? new Vector4(parts[0], parts[1], parts[2], parts[3]) :
			parts.Length == 3 ? new Vector4(parts[0], parts[1], parts[2], 200) : null;
	}

	/// <summary>Reflectivity is a linear 0..1 colour; Hammer tints are sRGB bytes.</summary>
	private static Datamodel.Color ToColor(Vector3 linear) {
		static byte C(float v) => (byte)Math.Clamp(MathF.Round(MathF.Pow(Math.Clamp(v, 0f, 1f), 1f / 2.2f) * 255f), 0f, 255f);
		if (linear == Vector3.Zero) return new Datamodel.Color(200, 200, 200, 255);
		return new Datamodel.Color(C(linear.X), C(linear.Y), C(linear.Z), 255);
	}

	private static string MeshName(string texture) {
		var name = texture.Replace('\\', '/').Split('/').Last().ToLowerInvariant();
		return name.Length > 0 ? name : "untextured";
	}
}
