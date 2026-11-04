using System.Numerics;

namespace OpenCitadel.Bhop.Porter.Vmap;

/// <summary>One face to put in a Hammer mesh: a convex polygon with its texturing.</summary>
public sealed class MeshPolygon {
	/// <summary>Corners in the order Hammer expects for a front face.</summary>
	public required Vector3[] Positions { get; init; }
	/// <summary>Texture coordinates per corner (in texture widths/heights).</summary>
	public required Vector2[] TexCoords { get; init; }
	public required Vector3 Normal { get; init; }
	public required int MaterialIndex { get; init; }
	/// <summary>Hammer's texture projection: U and V axes (xyz) with the offset in w, and the scale.</summary>
	public Vector4 AxisU { get; init; }
	public Vector4 AxisV { get; init; }
	public Vector2 Scale { get; init; } = new(0.25f, 0.25f);
}

/// <summary>
/// Builds a Hammer polygon mesh (CDmePolygonMesh) from separate polygons. Each polygon is its own
/// island of the half-edge structure, so faces from a BSP never have to share edges cleanly
/// (BSP faces have T-junctions and edges shared by more than two faces).
/// </summary>
/// <remarks>
/// Half-edge layout, as Hammer stores it: every edge is a pair of half-edges at indices 2k (inside
/// the face) and 2k+1 (the open boundary, face -1); a half-edge records the vertex it points to, the
/// next half-edge around its loop, and its twin. A vertex records one outgoing half-edge. Per-corner
/// data (texcoords, normals) lives on the half-edge that points at the corner.
/// </remarks>
public sealed class PolygonMeshBuilder {
	private readonly List<string> _materials = new();
	private readonly List<MeshPolygon> _polygons = new();

	public int PolygonCount => _polygons.Count;

	public int Material(string path) {
		var i = _materials.IndexOf(path);
		if (i >= 0) return i;
		_materials.Add(path);
		return _materials.Count - 1;
	}

	public void Add(MeshPolygon polygon) {
		if (polygon.Positions.Length < 3) return;
		_polygons.Add(polygon);
	}

	public CDmePolygonMesh Build() {
		var mesh = new CDmePolygonMesh();

		var faceTextureScale = Stream<Datamodel.Vector2Array>(mesh.FaceData, 0, "textureScale:0");
		var faceAxisU = Stream<Datamodel.Vector4Array>(mesh.FaceData, 0, "textureAxisU:0");
		var faceAxisV = Stream<Datamodel.Vector4Array>(mesh.FaceData, 0, "textureAxisV:0");
		var faceMaterial = Stream<Datamodel.IntArray>(mesh.FaceData, 8, "materialindex:0");
		var faceFlags = Stream<Datamodel.IntArray>(mesh.FaceData, 3, "flags:0");
		var faceLightmap = Stream<Datamodel.IntArray>(mesh.FaceData, 1, "lightmapScaleBias:0");

		var texcoord = Stream<Datamodel.Vector2Array>(mesh.FaceVertexData, 1, "texcoord:0");
		var texcoord1 = Stream<Datamodel.Vector2Array>(mesh.FaceVertexData, 1, "texcoord:1", "texcoord1");
		var paintBlend = Stream<Datamodel.Vector4Array>(mesh.FaceVertexData, 1, "VertexPaintBlendParams:0");
		var paintTint = Stream<Datamodel.Vector4Array>(mesh.FaceVertexData, 1, "VertexPaintTintColor:0");
		var normal = Stream<Datamodel.Vector3Array>(mesh.FaceVertexData, 1, "normal:0");
		var tangent = Stream<Datamodel.Vector4Array>(mesh.FaceVertexData, 1, "tangent:0");

		var position = Stream<Datamodel.Vector3Array>(mesh.VertexData, 3, "position:0");
		var edgeFlags = Stream<Datamodel.IntArray>(mesh.EdgeData, 3, "flags:0");

		var faceIndex = 0;
		foreach (var poly in _polygons) {
			var n = poly.Positions.Length;
			var firstVertex = mesh.VertexData.Size;
			var firstHalfEdge = mesh.EdgeVertexIndices.Count;

			// Vertices: one per corner, each pointing at its inner outgoing half-edge.
			for (var i = 0; i < n; i++) {
				mesh.VertexEdgeIndices.Add(firstHalfEdge + 2 * i);
				mesh.VertexDataIndices.Add(mesh.VertexData.Size);
				mesh.VertexData.Size++;
				position.Add(poly.Positions[i]);
			}

			var tan = poly.AxisU.AsVector3();
			tan = tan.LengthSquared() > 0 ? Vector3.Normalize(tan) : Vector3.UnitX;
			for (var i = 0; i < n; i++) {
				var next = (i + 1) % n;
				var prev = (i + n - 1) % n;
				var inner = firstHalfEdge + 2 * i;
				var outer = inner + 1;

				// Inner half-edge i runs corner i -> corner i+1, around the face.
				mesh.EdgeVertexIndices.Add(firstVertex + next);
				mesh.EdgeOppositeIndices.Add(outer);
				mesh.EdgeNextIndices.Add(firstHalfEdge + 2 * next);
				mesh.EdgeFaceIndices.Add(faceIndex);
				mesh.EdgeDataIndices.Add(inner / 2);
				mesh.EdgeVertexDataIndices.Add(inner);

				// Its twin runs corner i+1 -> corner i along the open boundary, which loops the other way.
				mesh.EdgeVertexIndices.Add(firstVertex + i);
				mesh.EdgeOppositeIndices.Add(inner);
				mesh.EdgeNextIndices.Add(firstHalfEdge + 2 * prev + 1);
				mesh.EdgeFaceIndices.Add(-1);
				mesh.EdgeDataIndices.Add(inner / 2);
				mesh.EdgeVertexDataIndices.Add(outer);

				mesh.EdgeData.Size++;
				edgeFlags.Add(0);

				// Corner data: the inner half-edge carries the corner it points at; the boundary one is unused.
				mesh.FaceVertexData.Size += 2;
				texcoord.Add(poly.TexCoords[next]);
				texcoord1.Add(Vector2.Zero);
				paintBlend.Add(Vector4.Zero);
				paintTint.Add(Vector4.One);
				normal.Add(poly.Normal);
				tangent.Add(new Vector4(tan, 1f));

				texcoord.Add(Vector2.Zero);
				texcoord1.Add(Vector2.Zero);
				paintBlend.Add(Vector4.Zero);
				paintTint.Add(Vector4.One);
				normal.Add(Vector3.Zero);
				tangent.Add(Vector4.Zero);
			}

			mesh.FaceEdgeIndices.Add(firstHalfEdge);
			mesh.FaceDataIndices.Add(mesh.FaceData.Size);
			mesh.FaceData.Size++;
			faceTextureScale.Add(poly.Scale);
			faceAxisU.Add(poly.AxisU);
			faceAxisV.Add(poly.AxisV);
			faceMaterial.Add(poly.MaterialIndex);
			faceFlags.Add(0);
			faceLightmap.Add(0);
			faceIndex++;
		}

		foreach (var m in _materials) mesh.Materials.Add(m);
		mesh.SubdivisionData.SubdivisionLevels.AddRange(Enumerable.Repeat(0, 8));
		return mesh;
	}

	private static TArray Stream<TArray>(CDmePolygonMeshDataArray array, int flags, string name, string? standardName = null)
		where TArray : System.Collections.IList, new() {
		var data = new TArray();
		var colon = name.LastIndexOf(':');
		array.Streams.Add(new CDmePolygonMeshDataStream {
			Name = name,
			StandardAttributeName = standardName ?? name[..colon],
			SemanticName = name[..colon],
			SemanticIndex = int.Parse(name[(colon + 1)..], System.Globalization.CultureInfo.InvariantCulture),
			VertexBufferLocation = 0,
			DataStateFlags = flags,
			Data = data,
		});
		return data;
	}
}
