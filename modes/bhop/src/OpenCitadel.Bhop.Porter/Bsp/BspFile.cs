using System.Buffers.Binary;
using System.Numerics;
using System.Text;

namespace OpenCitadel.Bhop.Porter.Bsp;

/// <summary>
/// Reads a Source 1 BSP (VBSP versions 19–21: Counter-Strike: Source and CS:GO maps). Only the lumps
/// a port needs are decoded: geometry for rendering, brushes for collision, entities and the
/// embedded pakfile.
/// </summary>
public sealed class BspFile {
	public const int LumpEntities = 0, LumpPlanes = 1, LumpTexData = 2, LumpVertexes = 3, LumpNodes = 5,
		LumpTexInfo = 6, LumpFaces = 7, LumpLeafs = 10, LumpEdges = 12, LumpSurfEdges = 13, LumpModels = 14,
		LumpLeafFaces = 16, LumpLeafBrushes = 17, LumpBrushes = 18, LumpBrushSides = 19, LumpDispInfo = 26,
		LumpDispVerts = 33, LumpGameLump = 35, LumpPakFile = 40, LumpTexDataStringData = 43, LumpTexDataStringTable = 44;

	public int Version { get; }
	public int MapRevision { get; }
	public string EntityText { get; }
	public Plane[] Planes { get; }
	public TexData[] TexData { get; }
	public Vector3[] Vertices { get; }
	public TexInfo[] TexInfos { get; }
	public Face[] Faces { get; }
	public Edge[] Edges { get; }
	public int[] SurfEdges { get; }
	public Model[] Models { get; }
	public BrushDef[] Brushes { get; }
	public BrushSideDef[] BrushSides { get; }
	public Node[] Nodes { get; }
	public Leaf[] Leafs { get; }
	public ushort[] LeafFaces { get; }
	public ushort[] LeafBrushes { get; }
	public DispInfo[] DispInfos { get; }
	public DispVert[] DispVerts { get; }
	public byte[] PakFile { get; }

	private readonly byte[] _data;

	public BspFile(byte[] data) {
		_data = data;
		if (data.Length < 1036 || Encoding.ASCII.GetString(data, 0, 4) != "VBSP") throw new InvalidDataException("Not a Source BSP (no VBSP header).");
		Version = I32(4);
		if (Version is < 19 or > 21) throw new InvalidDataException($"Unsupported BSP version {Version} (supported: 19–21).");
		MapRevision = I32(8 + 64 * 16);

		EntityText = Encoding.UTF8.GetString(Lump(LumpEntities)).TrimEnd('\0');
		Planes = Read(LumpPlanes, 20, (s, o) => new Plane(Vec(s, o), F32(s, o + 12), I32(s, o + 16)));
		var stringData = Lump(LumpTexDataStringData).ToArray();
		var stringTable = Read(LumpTexDataStringTable, 4, (s, o) => I32(s, o));
		TexData = Read(LumpTexData, 32, (s, o) => new TexData(Vec(s, o), CString(stringData, stringTable[I32(s, o + 12)]), I32(s, o + 16), I32(s, o + 20)));
		Vertices = Read(LumpVertexes, 12, (s, o) => Vec(s, o));
		TexInfos = Read(LumpTexInfo, 72, (s, o) => new TexInfo(
			new Vector4(F32(s, o), F32(s, o + 4), F32(s, o + 8), F32(s, o + 12)),
			new Vector4(F32(s, o + 16), F32(s, o + 20), F32(s, o + 24), F32(s, o + 28)),
			(SurfaceFlags)I32(s, o + 64), I32(s, o + 68)));
		Faces = Read(LumpFaces, 56, (s, o) => new Face(U16(s, o), s[o + 2], I32(s, o + 4), I16(s, o + 8), I16(s, o + 10), I16(s, o + 12)));
		Edges = Read(LumpEdges, 4, (s, o) => new Edge(U16(s, o), U16(s, o + 2)));
		SurfEdges = Read(LumpSurfEdges, 4, (s, o) => I32(s, o));
		Models = Read(LumpModels, 48, (s, o) => new Model(Vec(s, o), Vec(s, o + 12), Vec(s, o + 24), I32(s, o + 36), I32(s, o + 40), I32(s, o + 44)));
		Brushes = Read(LumpBrushes, 12, (s, o) => new BrushDef(I32(s, o), I32(s, o + 4), (uint)I32(s, o + 8)));
		BrushSides = Read(LumpBrushSides, 8, (s, o) => new BrushSideDef(U16(s, o), I16(s, o + 2), I16(s, o + 4), s[o + 6] != 0));
		Nodes = Read(LumpNodes, 32, (s, o) => new Node(I32(s, o), I32(s, o + 4), I32(s, o + 8)));
		// Leaves are 56 bytes before version 20 (they carried an ambient light cube), 32 bytes after.
		var leafSize = Version <= 19 ? 56 : 32;
		Leafs = Read(LumpLeafs, leafSize, (s, o) => new Leaf(I32(s, o), U16(s, o + 24), U16(s, o + 26)) {
			Area = U16(s, o + 6) & 0x1FF, FirstLeafFace = U16(s, o + 20), NumLeafFaces = U16(s, o + 22),
		});
		LeafFaces = Read(LumpLeafFaces, 2, (s, o) => U16(s, o));
		LeafBrushes = Read(LumpLeafBrushes, 2, (s, o) => U16(s, o));
		DispInfos = Read(LumpDispInfo, 176, (s, o) => new DispInfo(Vec(s, o), I32(s, o + 12), I32(s, o + 20), I16(s, o + 36)));
		DispVerts = Read(LumpDispVerts, 20, (s, o) => new DispVert(Vec(s, o), F32(s, o + 12), F32(s, o + 16)));
		PakFile = Lump(LumpPakFile).ToArray();
	}

	public static BspFile Load(string path) => new(File.ReadAllBytes(path));

	/// <summary>Brush indices that belong to a model (world = 0), found through its BSP tree.</summary>
	public IReadOnlyList<int> BrushesOfModel(int modelIndex) {
		var result = new SortedSet<int>();
		var stack = new Stack<int>();
		stack.Push(Models[modelIndex].HeadNode);
		while (stack.Count > 0) {
			var n = stack.Pop();
			if (n < 0) {
				var leaf = Leafs[-1 - n];
				for (var i = 0; i < leaf.NumLeafBrushes; i++) result.Add(LeafBrushes[leaf.FirstLeafBrush + i]);
			} else {
				stack.Push(Nodes[n].Child0);
				stack.Push(Nodes[n].Child1);
			}
		}
		return result.ToList();
	}

	/// <summary>The world leaf a point is in, found by walking the BSP tree.</summary>
	public int LeafAt(Vector3 point) {
		var n = Models.Length > 0 ? Models[0].HeadNode : 0;
		while (n >= 0) {
			var node = Nodes[n];
			var plane = Planes[node.PlaneNum];
			n = Vector3.Dot(plane.Normal, point) - plane.Dist >= 0 ? node.Child0 : node.Child1;
		}
		return -1 - n;
	}

	/// <summary>The world faces seen from leaves in an area (a sealed-off part of the map, such as the 3D skybox).</summary>
	public HashSet<int> FacesInArea(int area) {
		var faces = new HashSet<int>();
		foreach (var leaf in Leafs) {
			if (leaf.Area != area) continue;
			for (var i = 0; i < leaf.NumLeafFaces; i++) faces.Add(LeafFaces[leaf.FirstLeafFace + i]);
		}
		return faces;
	}

	/// <summary>The polygon of a face, in winding order.</summary>
	public Vector3[] FaceVertices(in Face face) {
		var result = new Vector3[face.NumEdges];
		for (var i = 0; i < face.NumEdges; i++) {
			var se = SurfEdges[face.FirstEdge + i];
			var edge = Edges[Math.Abs(se)];
			result[i] = Vertices[se >= 0 ? edge.V0 : edge.V1];
		}
		return result;
	}

	// ------------------------------------------------------------------ lump access

	private ReadOnlySpan<byte> Lump(int index) {
		var header = 8 + index * 16;
		var offset = I32(header);
		var length = I32(header + 4);
		if (length <= 0 || offset <= 0 || offset + length > _data.Length) return ReadOnlySpan<byte>.Empty;
		var span = _data.AsSpan(offset, length);
		if (span.Length >= 4 && span[..4].SequenceEqual("LZMA"u8)) {
			throw new InvalidDataException($"Lump {index} is LZMA-compressed; compressed lumps are not supported yet.");
		}
		return span;
	}

	private T[] Read<T>(int lump, int size, Func<byte[], int, T> read) {
		var header = 8 + lump * 16;
		var offset = I32(header);
		var length = I32(header + 4);
		if (length <= 0) return [];
		if (length % size != 0) throw new InvalidDataException($"Lump {lump} is {length} bytes, not a multiple of {size}.");
		_ = Lump(lump); // validates bounds and compression
		var items = new T[length / size];
		for (var i = 0; i < items.Length; i++) items[i] = read(_data, offset + i * size);
		return items;
	}

	private int I32(int o) => BinaryPrimitives.ReadInt32LittleEndian(_data.AsSpan(o));
	private static int I32(byte[] s, int o) => BinaryPrimitives.ReadInt32LittleEndian(s.AsSpan(o));
	private static short I16(byte[] s, int o) => BinaryPrimitives.ReadInt16LittleEndian(s.AsSpan(o));
	private static ushort U16(byte[] s, int o) => BinaryPrimitives.ReadUInt16LittleEndian(s.AsSpan(o));
	private static float F32(byte[] s, int o) => BinaryPrimitives.ReadSingleLittleEndian(s.AsSpan(o));
	private static Vector3 Vec(byte[] s, int o) => new(F32(s, o), F32(s, o + 4), F32(s, o + 8));

	private static string CString(ReadOnlySpan<byte> data, int offset) {
		if (offset < 0 || offset >= data.Length) return "";
		var end = data[offset..].IndexOf((byte)0);
		return Encoding.ASCII.GetString(end < 0 ? data[offset..] : data.Slice(offset, end));
	}
}

public readonly record struct Plane(Vector3 Normal, float Dist, int Type);
/// <summary>A texture used by the map: its name, size, and average colour (reflectivity, linear 0..1).</summary>
public readonly record struct TexData(Vector3 Reflectivity, string Name, int Width, int Height);
public readonly record struct TexInfo(Vector4 S, Vector4 T, SurfaceFlags Flags, int TexData);
public readonly record struct Face(ushort PlaneNum, byte Side, int FirstEdge, short NumEdges, short TexInfo, short DispInfo);
public readonly record struct Edge(ushort V0, ushort V1);
public readonly record struct Model(Vector3 Mins, Vector3 Maxs, Vector3 Origin, int HeadNode, int FirstFace, int NumFaces);
public readonly record struct BrushDef(int FirstSide, int NumSides, uint Contents);
public readonly record struct BrushSideDef(ushort PlaneNum, short TexInfo, short DispInfo, bool Bevel);
public readonly record struct Node(int PlaneNum, int Child0, int Child1);
public readonly record struct Leaf(int Contents, ushort FirstLeafBrush, ushort NumLeafBrushes) {
	/// <summary>The sealed-off region the leaf belongs to (areaportals and the 3D skybox separate them).</summary>
	public int Area { get; init; }
	public ushort FirstLeafFace { get; init; }
	public ushort NumLeafFaces { get; init; }
}
public readonly record struct DispInfo(Vector3 StartPosition, int DispVertStart, int Power, short MapFace);
public readonly record struct DispVert(Vector3 Vector, float Dist, float Alpha);

/// <summary>Source 1 surface flags (SURF_*).</summary>
[Flags]
public enum SurfaceFlags {
	None = 0,
	Light = 0x1,
	Sky2D = 0x2,
	Sky = 0x4,
	Warp = 0x8,
	Trans = 0x10,
	NoPortal = 0x20,
	Trigger = 0x40,
	NoDraw = 0x80,
	Hint = 0x100,
	Skip = 0x200,
	NoLight = 0x400,
	BumpLight = 0x800,
	NoShadows = 0x1000,
	NoDecals = 0x2000,
	NoChop = 0x4000,
	Hitbox = 0x8000,
}
