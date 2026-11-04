using System.Numerics;
using OpenCitadel.Bhop.Porter;
using OpenCitadel.Bhop.Porter.Textures;
using OpenCitadel.Bhop.Porter.Vmap;

namespace OpenCitadel.Bhop.Tests;

public class PorterTests {
	[Fact]
	public void VmtPatchesMergeOverTheirInclude() {
		var patch = Vmt.Parse("""
			"patch"
			{
				"include" "materials/brick/wall.vmt"
				"insert"
				{
					"$envmap" "maps/x/c0_0_0"
				}
			}
			""");
		Assert.Equal("patch", patch.Shader);
		Assert.Equal("materials/brick/wall.vmt", patch["include"]);
		Assert.Equal("maps/x/c0_0_0", patch["$envmap"]);

		var plain = Vmt.Parse("LightmappedGeneric { $basetexture brick/wall // comment\n \"$alphatest\" 1 Proxies { AnimatedTexture { animatedtexturevar $basetexture } } }");
		Assert.Equal("brick/wall", plain["$basetexture"]);
		Assert.True(plain.Flag("$alphatest"));
		Assert.Null(plain["animatedtexturevar"]);
	}

	[Fact]
	public void DecodesDxt1() {
		// A 4x4 VTF 7.2, DXT1, one mip: colour 0 = pure red (0xF800), colour 1 = pure blue (0x001F),
		// first row picks colour 0, second colour 1, third the 2/3-1/3 mix, fourth the 1/3-2/3 mix.
		var header = new byte[80];
		"VTF\0"u8.CopyTo(header);
		BitConverter.GetBytes(7).CopyTo(header, 4);
		BitConverter.GetBytes(2).CopyTo(header, 8);
		BitConverter.GetBytes(80).CopyTo(header, 12);
		BitConverter.GetBytes((ushort)4).CopyTo(header, 16);
		BitConverter.GetBytes((ushort)4).CopyTo(header, 18);
		BitConverter.GetBytes((ushort)1).CopyTo(header, 24);
		BitConverter.GetBytes(13).CopyTo(header, 52); // DXT1
		header[56] = 1; // mips
		BitConverter.GetBytes(-1).CopyTo(header, 57); // no thumbnail
		BitConverter.GetBytes((ushort)1).CopyTo(header, 63);
		byte[] block = [0x00, 0xF8, 0x1F, 0x00, 0b00_00_00_00, 0b01_01_01_01, 0b10_10_10_10, 0b11_11_11_11];
		var image = VtfFile.Decode([.. header, .. block]);
		Assert.Equal(4, image.Width);
		Assert.Equal([255, 0, 0, 255], image.Rgba[0..4]);
		Assert.Equal([0, 0, 255, 255], image.Rgba[16..20]);
		Assert.Equal([170, 0, 85, 255], image.Rgba[32..36]);
		Assert.Equal([85, 0, 170, 255], image.Rgba[48..52]);
	}

	[Fact]
	public void PolygonMeshHalfEdgesAreConsistent() {
		var b = new PolygonMeshBuilder();
		var m = b.Material("materials/dev/white_paint.vmat");
		b.Add(new MeshPolygon { Positions = [new(0, 0, 0), new(64, 0, 0), new(64, 64, 0), new(0, 64, 0)], TexCoords = new Vector2[4], Normal = Vector3.UnitZ, MaterialIndex = m });
		b.Add(new MeshPolygon { Positions = [new(0, 0, 10), new(64, 0, 10), new(0, 64, 10)], TexCoords = new Vector2[3], Normal = Vector3.UnitZ, MaterialIndex = m });
		var mesh = b.Build();

		var halfEdges = mesh.EdgeVertexIndices.Count;
		Assert.Equal(2 * (4 + 3), halfEdges);
		Assert.Equal(7, mesh.VertexEdgeIndices.Count);
		Assert.Equal(2, mesh.FaceEdgeIndices.Count);
		for (var e = 0; e < halfEdges; e++) {
			var twin = mesh.EdgeOppositeIndices[e];
			Assert.Equal(e, mesh.EdgeOppositeIndices[twin]);
			// The next half-edge in the loop starts where this one ends: its twin points at that vertex.
			var next = mesh.EdgeNextIndices[e];
			Assert.Equal(mesh.EdgeVertexIndices[e], mesh.EdgeVertexIndices[mesh.EdgeOppositeIndices[next]]);
		}
		// Walking a face's loop returns to its first edge after as many steps as it has corners.
		foreach (var (face, corners) in new[] { (0, 4), (1, 3) }) {
			var start = mesh.FaceEdgeIndices[face];
			var e = start;
			for (var i = 0; i < corners; i++) {
				Assert.Equal(face, mesh.EdgeFaceIndices[e]);
				e = mesh.EdgeNextIndices[e];
			}
			Assert.Equal(start, e);
		}
		// Boundary loops close too, with no face.
		var boundary = mesh.EdgeOppositeIndices[mesh.FaceEdgeIndices[0]];
		var walk = boundary;
		for (var i = 0; i < 4; i++) {
			Assert.Equal(-1, mesh.EdgeFaceIndices[walk]);
			walk = mesh.EdgeNextIndices[walk];
		}
		Assert.Equal(boundary, walk);
		// Each vertex's edge leaves it: the edge's twin points at the vertex.
		for (var v = 0; v < mesh.VertexEdgeIndices.Count; v++) {
			Assert.Equal(v, mesh.EdgeVertexIndices[mesh.EdgeOppositeIndices[mesh.VertexEdgeIndices[v]]]);
		}
	}

	[Theory]
	[InlineData("/mnt/c/Users/x/sdk/game", @"C:\Users\x\sdk\game")]
	[InlineData("/mnt/d/a b/c.vmap", @"D:\a b\c.vmap")]
	public void ConvertsWslPathsForTheCompiler(string wsl, string windows) {
		if (OperatingSystem.IsWindows()) return;
		Assert.Equal(windows, MapBuilder.WindowsPath(wsl));
	}

	[Fact]
	public void SafeMaterialNamesKeepFoldersAndDropSpaces() =>
		Assert.Equal("hammer_textures/bhop_eazy/31_e_tile_1", MaterialConverter.Safe("HAMMER TEXTURES/BHOP_EAZY/31_E_TILE_1"));
}
