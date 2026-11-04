using System.Text;
using OpenCitadel.Bhop.Vpk;

namespace OpenCitadel.Bhop.Tests;

public class VpkTests {
	[Fact]
	public void WrittenPackagesReadBack() {
		var path = Path.Combine(Path.GetTempPath(), $"ocbhop-{Guid.NewGuid():N}.vpk");
		try {
			var files = new Dictionary<string, byte[]> {
				["maps/test.vmap_c"] = Encoding.UTF8.GetBytes("vmap"),
				["maps/test/world.vwrld_c"] = new byte[5000],
				["maps/test/bhop.json.gz"] = [1, 2, 3],
				["readme"] = Encoding.UTF8.GetBytes("no extension"),
			};
			VpkArchive.Write(path, files);
			var reader = VpkArchive.Open(path);
			Assert.Equal(files.Keys.OrderBy(k => k), reader.Files.OrderBy(k => k));
			foreach (var (name, data) in files) Assert.Equal(data, reader.Read(name));
			Assert.Null(reader.Read("maps/missing.vmap_c"));
		} finally {
			File.Delete(path);
		}
	}

	[Fact]
	public void ZonesAndCreditsAreStoredInBuiltMaps() {
		var dir = Path.Combine(Path.GetTempPath(), $"ocbhop-{Guid.NewGuid():N}");
		Directory.CreateDirectory(dir);
		try {
			var vpk = Path.Combine(dir, "bhop_test.vpk");
			var data = new OpenCitadel.Bhop.Map.BhopMapData { Name = "bhop_test" };
			VpkArchive.Write(vpk, new Dictionary<string, byte[]> {
				["maps/bhop_test.vmap_c"] = [9, 9],
				[OpenCitadel.Bhop.Map.BhopMapData.PathInPackage("bhop_test")] = data.ToGzipBytes(),
			});
			// The file the plugin's dw_zone command writes.
			var zones = Path.Combine(dir, "bhop_test.zones.json");
			File.WriteAllText(zones, """[{"kind":"end","index":0,"mins":{"x":-10,"y":-10,"z":0},"maxs":{"x":10,"y":10,"z":128}}]""");

			Assert.Equal(0, Cli.Run(["zones", vpk, zones]));
			Assert.Equal(0, Cli.Run(["credit", vpk, "someone"]));

			var back = OpenCitadel.Bhop.Map.BhopMapData.LoadFromPackage(vpk, "bhop_test");
			Assert.NotNull(back);
			var end = Assert.Single(back!.Zones);
			Assert.Equal(OpenCitadel.Bhop.Map.ZoneKind.End, end.Kind);
			Assert.Equal(128, end.Maxs.Z);
			Assert.Equal(["someone"], back.Credits);
			Assert.Equal([9, 9], VpkArchive.Open(vpk).Read("maps/bhop_test.vmap_c")); // the rest is untouched
		} finally {
			Directory.Delete(dir, recursive: true);
		}
	}

	[Fact]
	public void ReadsDeadlocksOwnMapPackages() {
		const string start = "/mnt/c/Program Files (x86)/Steam/steamapps/common/Deadlock/game/citadel/maps/start.vpk";
		if (!File.Exists(start)) return; // only on a machine with Deadlock installed
		var reader = VpkArchive.Open(start);
		Assert.Contains("maps/start.vmap_c", reader.Files);
		Assert.Contains("maps/start/world_physics.vphys_c", reader.Files);
		var physics = reader.Read("maps/start/world_physics.vphys_c");
		Assert.NotNull(physics);
		Assert.True(physics!.Length > 100_000);
	}
}
