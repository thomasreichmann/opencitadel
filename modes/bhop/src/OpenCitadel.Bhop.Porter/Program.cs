using System.Numerics;
using OpenCitadel.Bhop.Map;
using OpenCitadel.Bhop.Porter;
using OpenCitadel.Bhop.Porter.Bsp;

return Cli.Run(args);

internal static class Cli {
	private const string Usage = """
		citadel-port: port Counter-Strike: Source bunny-hop maps to Deadlock.

		Usage:
		  citadel-port sdk <Deadlock folder> --dota-tools <dir> [--cs2 <CS2 folder>] [--sdk <dir>]
		  citadel-port build <map.bsp> [--sdk <dir>] [-o <dir>] [--credit "<name>"]... [--textures <dir|vpk>]...
		                     [--no-textures] [--no-vis] [--install <Deadlock game folder>] [--addon <name>]
		  citadel-port package <map.vpk> [-o <dir>] [--version <x.y.z>]
		  citadel-port credit <map.vpk> "<credit>"...
		  citadel-port zones <map.vpk> <zones.json | URL | srcwr>
		  citadel-port course <map.bsp> [--from <map.vpk | map.bhop.json.gz>] [-o <dir>] [--credit "<name>"]...
		                      [--zones <zones.json | URL | srcwr>]
		  citadel-port inspect <map.bsp>
		  citadel-port extract <map.bsp> [-o <dir>] [--credit "<name>"]...
		  citadel-port vmap <map.bsp> -o <addon content folder>
		  citadel-port simulate <map.bhop.json.gz> [seconds]

		sdk       Set up (or refresh after a game update) the folder maps are compiled in.
		build     Port a map: bhop data, Hammer map, materials, compile, and <map>.vpk for citadel/maps.
		package   Wrap a built map in an OpenCitadel content package for the registry.
		credit    Replace the credits stored in a built map.
		zones     Store timer zones in a built map: a file dw_zone wrote, bhoptimer JSON, or "srcwr"
		          for the community zones at github.com/srcwr/zones.
		course    Write <map>.bhop.json.gz with the map drawn as coloured panels, for servers that run
		          maps without packages (zero-install: players need nothing but Deadlock). --from takes
		          the credits and zones of an earlier port.
		inspect   Print what the BSP contains: models, brushes, entities, textures.
		extract   Write <map>.bhop.json.gz: collision brushes, spawns, teleports, boosters, bhop blocks.
		vmap      Write only the Hammer map.
		simulate  Drop a player at the first spawn and run the movement for a while (a smoke test).

		--sdk defaults to OPENCITADEL_SDK. See modes/bhop/README.md.
		""";

	public static int Run(string[] args) {
		if (args.Length < 2) {
			Console.Error.WriteLine(Usage);
			return 2;
		}
		try {
			return args[0] switch {
				"inspect" => Inspect(args[1]),
				"extract" => Extract(args[1], args.Skip(2).ToArray()),
				"simulate" => Simulate(args[1], args.Length > 2 ? float.Parse(args[2], System.Globalization.CultureInfo.InvariantCulture) : 5f),
				"vmap" => Vmap(args[1], args.Skip(2).ToArray()),
				"build" => Build(args[1], args.Skip(2).ToArray()),
				"credit" => Credit(args[1], args.Skip(2).ToArray()),
				"package" => Package(args[1], args.Skip(2).ToArray()),
				"sdk" => Sdk(args[1], args.Skip(2).ToArray()),
				"zones" => Zones(args[1], args.Skip(2).ToArray()),
				"course" => Course(args[1], args.Skip(2).ToArray()),
				_ => Fail($"unknown command '{args[0]}'\n\n{Usage}"),
			};
		} catch (Exception ex) when (ex is IOException or InvalidDataException or UnauthorizedAccessException or HttpRequestException) {
			return Fail(ex.Message);
		}
	}

	private static int Sdk(string deadlock, string[] options) {
		string? sdk = null, dota = null, cs2 = null;
		for (var i = 0; i < options.Length; i++) {
			switch (options[i]) {
				case "--sdk": sdk = options[++i]; break;
				case "--dota-tools": dota = options[++i]; break;
				case "--cs2": cs2 = options[++i]; break;
				default: return Fail($"unknown option '{options[i]}'");
			}
		}
		sdk ??= Environment.GetEnvironmentVariable("OPENCITADEL_SDK");
		if (sdk == null) return Fail("sdk needs --sdk <folder to create> (or OPENCITADEL_SDK)");
		if (dota == null) return Fail("sdk needs --dota-tools <folder with Dota 2's modeldoc_utils.dll, exportsystem.dll and smartprops.dll>");
		SdkSetup.Run(new SdkSetup.Options(deadlock, sdk, dota, cs2), Console.WriteLine);
		return 0;
	}

	private static int Fail(string message) {
		Console.Error.WriteLine($"citadel-port: {message}");
		return 1;
	}

	private static int Inspect(string path) {
		var bsp = BspFile.Load(path);
		var entities = BspEntity.ParseLump(bsp.EntityText);
		Console.WriteLine($"{Path.GetFileName(path)}: VBSP {bsp.Version}, revision {bsp.MapRevision}");
		Console.WriteLine($"  models {bsp.Models.Length}, brushes {bsp.Brushes.Length}, brush sides {bsp.BrushSides.Length}, planes {bsp.Planes.Length}");
		Console.WriteLine($"  faces {bsp.Faces.Length}, vertices {bsp.Vertices.Length}, displacements {bsp.DispInfos.Length}, textures {bsp.TexData.Length}");
		Console.WriteLine($"  world brushes {bsp.BrushesOfModel(0).Count}, pakfile {bsp.PakFile.Length / 1024} KiB");
		var w = bsp.Models[0];
		Console.WriteLine($"  world bounds {w.Mins} .. {w.Maxs}");
		Console.WriteLine("  entities:");
		foreach (var g in entities.GroupBy(e => e.ClassName).OrderByDescending(g => g.Count())) {
			Console.WriteLine($"    {g.Count(),5} {g.Key}");
		}
		return 0;
	}

	/// <summary>
	/// Smoke-tests ported map data without the game: spawns a player, lets them settle, then runs
	/// forward holding jump (autobhop) at 64 tick and reports landings and teleports.
	/// </summary>
	private static int Simulate(string path, float seconds) {
		const float dt = 1f / 64f;
		var data = BhopMapData.Load(path);
		var runtime = new MapRuntime(data);
		var settings = OpenCitadel.Bhop.Movement.MovementSettings.CounterStrikeSource;
		var move = new OpenCitadel.Bhop.Movement.CssMovement(settings, runtime.World);
		var spawn = runtime.Spawn ?? throw new InvalidDataException("the map has no spawns");
		var p = new OpenCitadel.Bhop.Movement.PlayerMoveState();
		p.Teleport(spawn.Origin.ToVector3(), Vector3.Zero);
		if (!move.Unstick(p)) Console.WriteLine("  spawn is stuck in solid");
		var yaw = spawn.Angles.Y;
		var triggers = new TriggerState();
		Console.WriteLine($"{data.Name}: spawn {spawn.Origin.ToVector3()} yaw {yaw}");
		var time = 0f;
		for (var tick = 0; tick < (int)(seconds / dt); tick++) {
			time += dt;
			var keys = tick < 64 ? OpenCitadel.Bhop.Movement.MoveButtons.None
				: OpenCitadel.Bhop.Movement.MoveButtons.Forward | OpenCitadel.Bhop.Movement.MoveButtons.Jump;
			var r = move.Simulate(p, OpenCitadel.Bhop.Movement.MoveInput.FromKeys(keys, 0, yaw, dt));
			var touch = runtime.Touch(p, settings, triggers, time);
			if (tick == 63) Console.WriteLine($"  settled at {p.Origin} on ground {p.OnGround} (model {p.GroundEntity})");
			if (r.Landed && tick >= 64) Console.WriteLine($"  t={time:0.00} landed at {p.Origin} on model {p.GroundEntity}");
			if (touch.Teleported) {
				Console.WriteLine($"  t={time:0.00} {touch.Reason} -> {p.Origin}");
				if (touch.NewViewAngles is { } a) yaw = a.Y;
			}
		}
		Console.WriteLine($"  end {p.Origin} speed {new Vector2(p.Velocity.X, p.Velocity.Y).Length():0.0}");
		return 0;
	}

	/// <summary>
	/// Wraps a built map in an OpenCitadel content package (plugin.json, the map VPK, a README with
	/// the credits), ready for `citadel-host plugin pack/publish`.
	/// </summary>
	private static int Package(string mapVpk, string[] options) {
		string? outDir = null;
		var version = "0.1.0";
		for (var i = 0; i < options.Length; i++) {
			switch (options[i]) {
				case "-o": outDir = options[++i]; break;
				case "--version": version = options[++i]; break;
				default: return Fail($"unknown option '{options[i]}'");
			}
		}
		var name = Path.GetFileNameWithoutExtension(mapVpk).ToLowerInvariant();
		var data = BhopMapData.LoadFromPackage(mapVpk, name) ?? throw new InvalidDataException($"{mapVpk} has no bhop data; build it with citadel-port");
		var id = name.Replace('_', '-');
		if (!id.StartsWith("bhop-", StringComparison.Ordinal)) id = "bhop-" + id;
		outDir ??= Path.Combine(Path.GetDirectoryName(Path.GetFullPath(mapVpk))!, "packages");
		var dir = Path.Combine(outDir, id);
		Directory.CreateDirectory(Path.Combine(dir, "maps"));
		File.Copy(mapVpk, Path.Combine(dir, "maps", $"{name}.vpk"), overwrite: true);

		var credits = data.Credits.Count > 0 ? string.Join("; ", data.Credits) : "unknown (please add with citadel-port credit)";
		var manifest = new System.Text.Json.Nodes.JsonObject {
			["id"] = id,
			["name"] = name,
			["version"] = version,
			["kind"] = "content",
			["description"] = $"{name}, ported from Counter-Strike: Source for the OpenCitadel bhop mode. Original map by {credits}.",
			["author"] = credits,
			["tags"] = new System.Text.Json.Nodes.JsonArray("bhop", "map", "cs-source-port"),
			["content"] = new System.Text.Json.Nodes.JsonArray(new System.Text.Json.Nodes.JsonObject { ["file"] = $"maps/{name}.vpk", ["client"] = true }),
			["maps"] = new System.Text.Json.Nodes.JsonArray(name),
			["engines"] = new System.Text.Json.Nodes.JsonObject { ["opencitadel"] = "^0.1.0" },
			// The map's bhop data (collision, triggers, zones) only does anything with the bhop plugin.
			["dependencies"] = new System.Text.Json.Nodes.JsonObject { ["bhop"] = "^0.1.0" },
		};
		var json = new System.Text.Json.JsonSerializerOptions { WriteIndented = true, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
		File.WriteAllText(Path.Combine(dir, "plugin.json"), manifest.ToJsonString(json) + "\n");
		File.WriteAllText(Path.Combine(dir, "README.md"), $"""
			# {name}

			A Counter-Strike: Source bunny-hop map, ported to Deadlock for the
			[OpenCitadel bhop mode](https://github.com/thomasreichmann/opencitadel/tree/main/modes/bhop).

			* **Original map:** {credits}
			* **Source:** {data.Source}
			* **Contents:** the compiled map, its materials, and the bhop data (collision brushes,
			  {data.Triggers.Count} triggers, {data.Spawns.Count} spawns) the bhop plugin plays it with.

			The map belongs to its author. Textures from CS:S or HL2 are Valve's. To have this port
			changed or removed, open an issue on the repository.

			""");
		Console.WriteLine($"{dir}: {id} {version} ({new FileInfo(mapVpk).Length / 1024} KiB)");
		return 0;
	}

	/// <summary>Sets the credits stored in a built map package (its bhop data), without recompiling.</summary>
	private static int Credit(string package, string[] credits) {
		if (credits.Length == 0) return Fail("credit needs at least one credit line");
		EditData(package, data => data.Credits = credits.ToList());
		Console.WriteLine($"{package}: credits set to {string.Join("; ", credits)}");
		return 0;
	}

	/// <summary>
	/// Stores timer zones in a built map package, so every server gets them. Takes the file the
	/// plugin's <c>dw_zone</c> command writes (configs/BhopPlugin/zones/&lt;map&gt;.zones.json); a
	/// server's own zone file still takes precedence over the package's.
	/// </summary>
	private static int Zones(string package, string[] options) {
		if (options.Length != 1) return Fail("zones needs <zones.json | URL | srcwr>");
		var map = Path.GetFileNameWithoutExtension(package).ToLowerInvariant();
		var source = options[0].Equals("srcwr", StringComparison.OrdinalIgnoreCase)
			? OpenCitadel.Bhop.Timing.BhoptimerZones.SrcwrUrl.Replace("{map}", map, StringComparison.Ordinal)
			: options[0];
		string json;
		if (source.StartsWith("https://", StringComparison.OrdinalIgnoreCase) || source.StartsWith("http://", StringComparison.OrdinalIgnoreCase)) {
			using var http = new HttpClient();
			json = http.GetStringAsync(source).GetAwaiter().GetResult();
		} else {
			json = File.ReadAllText(source);
		}
		var zones = ReadZones(json, source);
		if (zones.All(z => z.Kind != ZoneKind.End || z.Track != 0)) Console.WriteLine("warning: no end zone, so runs on this map can't finish");
		EditData(package, data => data.Zones = zones);
		Console.WriteLine($"{package}: {zones.Count} zones from {source} ({DescribeZones(zones)})");
		return 0;
	}

	/// <summary>Zones in the plugin's own format (what dw_zone saves) or bhoptimer's JSON.</summary>
	private static List<MapZone> ReadZones(string json, string source) {
		if (OpenCitadel.Bhop.Timing.BhoptimerZones.IsBhoptimerJson(json)) {
			var result = OpenCitadel.Bhop.Timing.BhoptimerZones.Parse(json);
			if (result.Skipped.Count > 0) Console.WriteLine($"not supported, left out: {string.Join(", ", result.Skipped)}");
			return result.Zones;
		}
		return System.Text.Json.JsonSerializer.Deserialize<List<MapZone>>(json, BhopMapData.Json)
			?? throw new InvalidDataException($"{source} holds no zones");
	}

	private static string DescribeZones(IEnumerable<MapZone> zones) => string.Join(", ", zones
		.GroupBy(z => (z.Kind, z.Track))
		.Select(g => $"{(g.Key.Track > 0 ? $"bonus {g.Key.Track} " : "")}{g.Key.Kind.ToString().ToLowerInvariant()}{(g.Count() > 1 ? $" ×{g.Count()}" : "")}"));

	/// <summary>
	/// A map as a course a server runs without its package: the map data with the map drawn as
	/// panels (<see cref="OpenCitadel.Bhop.Porter.Panels.PanelBuilder"/>), as a loose file for the
	/// plugin's map folder.
	/// </summary>
	private static int Course(string path, string[] options) {
		string? from = null, outDir = null, zonesSource = null;
		var credits = new List<string>();
		for (var i = 0; i < options.Length; i++) {
			switch (options[i]) {
				case "--from": from = options[++i]; break;
				case "-o": outDir = options[++i]; break;
				case "--credit": credits.Add(options[++i]); break;
				case "--zones": zonesSource = options[++i]; break;
				default: return Fail($"unknown option '{options[i]}'");
			}
		}
		var name = Path.GetFileNameWithoutExtension(path).ToLowerInvariant();
		var bsp = BspFile.Load(path);
		BhopMapData data;
		if (from == null) {
			data = MapExtractor.Extract(bsp, name, credits);
		} else {
			// An earlier port keeps its credits and zones; its collision and triggers are re-extracted
			// only if it predates them, so they always match this BSP.
			var earlier = from.EndsWith(".vpk", StringComparison.OrdinalIgnoreCase)
				? BhopMapData.LoadFromPackage(from, name) ?? throw new InvalidDataException($"{from} has no map data for {name}")
				: BhopMapData.Load(from);
			data = MapExtractor.Extract(bsp, name, credits.Count > 0 ? credits : earlier.Credits);
			data.Zones = earlier.Zones;
		}
		if (zonesSource != null) {
			var source = zonesSource.Equals("srcwr", StringComparison.OrdinalIgnoreCase)
				? OpenCitadel.Bhop.Timing.BhoptimerZones.SrcwrUrl.Replace("{map}", name, StringComparison.Ordinal)
				: zonesSource;
			string json;
			if (source.StartsWith("https://", StringComparison.OrdinalIgnoreCase) || source.StartsWith("http://", StringComparison.OrdinalIgnoreCase)) {
				using var http = new HttpClient();
				json = http.GetStringAsync(source).GetAwaiter().GetResult();
			} else {
				json = File.ReadAllText(source);
			}
			data.Zones = ReadZones(json, source);
		}
		var stats = OpenCitadel.Bhop.Porter.Panels.PanelBuilder.Build(bsp).Stats;
		outDir ??= Path.GetDirectoryName(Path.GetFullPath(path))!;
		Directory.CreateDirectory(outDir);
		var outPath = Path.Combine(outDir, $"{name}.bhop.json.gz");
		data.Save(outPath);
		var glyphRows = data.Panels.SelectMany(p => PanelLayout.Rows(p)).ToList();
		var kib = glyphRows.Sum(r => (long)r.NetworkBytes) / 1024;
		Console.WriteLine(outPath);
		Console.WriteLine($"  {stats.Faces} faces in {stats.Groups} planes -> {data.Panels.Count} panels, {glyphRows.Count} glyph rows (entities), " +
		                  $"{kib} KiB to send" +
		                  (stats.SkyboxFaces > 0 ? $"; {stats.SkyboxFaces} 3D skybox faces left out" : "") +
		                  (stats.Displacements > 0 ? $"; {stats.Displacements} displacements drawn flat" : ""));
		if (kib > PanelLayout.DefaultBudgetKilobytes)
			Console.WriteLine($"  more than a server draws at once by default ({PanelLayout.DefaultBudgetKilobytes} KiB): " +
			                  "its largest panels are drawn and the rest streamed near players");
		Console.WriteLine($"  credits: {(data.Credits.Count > 0 ? string.Join("; ", data.Credits) : "none")}; zones: {(data.Zones.Count > 0 ? DescribeZones(data.Zones) : "none")}");
		return 0;
	}

	private static void EditData(string package, Action<BhopMapData> edit) {
		var name = Path.GetFileNameWithoutExtension(package).ToLowerInvariant();
		var files = OpenCitadel.Bhop.Vpk.VpkArchive.Open(package).ReadAll();
		var key = BhopMapData.PathInPackage(name);
		if (!files.TryGetValue(key, out var bytes)) throw new InvalidDataException($"{package} has no {key}");
		using var ms = new MemoryStream(bytes);
		var data = BhopMapData.Load(ms, gzip: true, key);
		edit(data);
		files[key] = data.ToGzipBytes();
		OpenCitadel.Bhop.Vpk.VpkArchive.Write(package, files);
	}

	/// <summary>The whole port: map data, Hammer map, compile, and the final package.</summary>
	private static int Build(string path, string[] options) {
		string? sdk = null, outDir = null, install = null;
		var addon = "ocbhop";
		var credits = new List<string>();
		var textureFolders = new List<string>();
		var textures = true;
		var vis = true;
		var vmapOptions = new OpenCitadel.Bhop.Porter.Vmap.VmapOptions();
		for (var i = 0; i < options.Length; i++) {
			switch (options[i]) {
				case "--no-textures": textures = false; break;
				case "--no-vis": vis = false; break;
				case "--textures": textureFolders.Add(options[++i]); break;
				case "--sdk": sdk = options[++i]; break;
				case "--addon": addon = options[++i]; break;
				case "-o": outDir = options[++i]; break;
				case "--credit": credits.Add(options[++i]); break;
				case "--install": install = options[++i]; break;
				case "--keep-winding": vmapOptions = vmapOptions with { ReverseWinding = false }; break;
				case "--material": vmapOptions = vmapOptions with { BaseMaterial = options[++i] }; break;
				default: return Fail($"unknown option '{options[i]}'");
			}
		}
		sdk ??= Environment.GetEnvironmentVariable("OPENCITADEL_SDK");
		if (sdk == null) return Fail("build needs --sdk <compiler SDK folder> (or OPENCITADEL_SDK)");
		outDir ??= Path.GetDirectoryName(Path.GetFullPath(path))!;
		var result = MapBuilder.Build(path, new SdkLayout(sdk, addon), credits, vmapOptions, outDir, Console.WriteLine, textures, textureFolders, vis);
		Console.WriteLine($"done in {result.CompileTime.TotalSeconds:0}s compile: {result.Package}");
		if (install != null) {
			var target = Path.Combine(install, "citadel", "maps", Path.GetFileName(result.Package));
			File.Copy(result.Package, target, overwrite: true);
			Console.WriteLine($"installed {target}");
		}
		return 0;
	}

	/// <summary>Writes the Hammer map (maps/&lt;name&gt;.vmap) into an addon's content folder.</summary>
	private static int Vmap(string path, string[] options) {
		string? outDir = null;
		var vmapOptions = new OpenCitadel.Bhop.Porter.Vmap.VmapOptions();
		for (var i = 0; i < options.Length; i++) {
			switch (options[i]) {
				case "-o": outDir = options[++i]; break;
				case "--keep-winding": vmapOptions = vmapOptions with { ReverseWinding = false }; break;
				case "--material": vmapOptions = vmapOptions with { BaseMaterial = options[++i] }; break;
				default: return Fail($"unknown option '{options[i]}'");
			}
		}
		if (outDir == null) return Fail("vmap needs -o <addon content folder>");
		var name = Path.GetFileNameWithoutExtension(path).ToLowerInvariant();
		var bsp = BspFile.Load(path);
		var data = MapExtractor.Extract(bsp, name, []);
		var (root, stats) = OpenCitadel.Bhop.Porter.Vmap.VmapExporter.Build(bsp, data, vmapOptions);
		var mapsDir = Path.Combine(outDir, "maps");
		Directory.CreateDirectory(mapsDir);
		var outPath = Path.Combine(mapsDir, $"{name}.vmap");
		OpenCitadel.Bhop.Porter.Vmap.VmapExporter.Save(root, outPath);
		Console.WriteLine(outPath);
		Console.WriteLine($"  {stats.Faces} faces in {stats.Meshes} meshes, {stats.Displacements} displacements, " +
		                  $"{stats.ClipBrushes} clip brushes, {stats.SkippedFaces} hidden faces skipped");
		return 0;
	}

	private static int Extract(string path, string[] options) {
		string? outDir = null;
		var credits = new List<string>();
		for (var i = 0; i < options.Length; i++) {
			switch (options[i]) {
				case "-o": outDir = options[++i]; break;
				case "--credit": credits.Add(options[++i]); break;
				default: return Fail($"unknown option '{options[i]}'");
			}
		}
		var name = Path.GetFileNameWithoutExtension(path).ToLowerInvariant();
		var bsp = BspFile.Load(path);
		var data = MapExtractor.Extract(bsp, name, credits);
		outDir ??= Path.GetDirectoryName(Path.GetFullPath(path))!;
		Directory.CreateDirectory(outDir);
		var outPath = Path.Combine(outDir, $"{name}.bhop.json.gz");
		data.Save(outPath);

		var brushes = data.Models.Sum(m => m.Brushes.Count);
		Console.WriteLine($"{outPath}");
		Console.WriteLine($"  {data.Models.Count} solid models ({brushes} brushes), {data.Spawns.Count} spawns, {data.Destinations.Count} destinations");
		foreach (var g in data.Triggers.GroupBy(t => t.Kind)) Console.WriteLine($"  {g.Count()} {g.Key.ToString().ToLowerInvariant()} triggers");
		Console.WriteLine($"  {data.Models.Count(m => m.BhopBlock != null)} bhop blocks");
		return 0;
	}
}
