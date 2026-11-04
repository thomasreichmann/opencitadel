using System.Diagnostics;
using OpenCitadel.Bhop.Map;
using OpenCitadel.Bhop.Porter.Bsp;
using OpenCitadel.Bhop.Porter.Vmap;
using OpenCitadel.Bhop.Vpk;

namespace OpenCitadel.Bhop.Porter;

/// <summary>Where the map compiler lives: an OpenCitadel compiler SDK folder (see docs).</summary>
public sealed record SdkLayout(string Root, string Addon) {
	public string ContentAddon => Path.Combine(Root, "content", "citadel_addons", Addon);
	public string GameAddon => Path.Combine(Root, "game", "citadel_addons", Addon);
	public string Bin => Path.Combine(Root, "game", "bin", "win64");
	public string Launcher => Path.Combine(Bin, "rclaunch.exe");
	public string GameInfoDir => Path.Combine(Root, "game", "citadel");
}

/// <summary>BSP → Hammer map → compiled map package with the bhop data inside.</summary>
public static class MapBuilder {
	public sealed record Result(string Package, BhopMapData Data, VmapExporter.Stats Stats, TimeSpan CompileTime);

	public static Result Build(string bspPath, SdkLayout sdk, IEnumerable<string> credits, VmapOptions options, string outDir, Action<string> log,
		bool textures = true, IEnumerable<string>? textureFolders = null, bool vis = true) {
		var name = Path.GetFileNameWithoutExtension(bspPath).ToLowerInvariant();
		if (!System.Text.RegularExpressions.Regex.IsMatch(name, "^[a-z0-9_]{1,64}$")) {
			throw new InvalidDataException($"map name \"{name}\" must be lowercase letters, digits and underscores");
		}
		if (!File.Exists(sdk.Launcher)) throw new FileNotFoundException($"no map compiler at {sdk.Launcher}; set up the SDK first (see modes/bhop/README.md)");

		log($"reading {bspPath}");
		var bsp = BspFile.Load(bspPath);
		var data = MapExtractor.Extract(bsp, name, credits);

		// Textures: the map's own (embedded in the BSP) and any extra Source 1 content folders.
		using var sourceFiles = new Textures.SourceFiles(bsp.PakFile, textureFolders);
		var materials = new Textures.MaterialConverter(sourceFiles, sdk.ContentAddon, name);
		if (textures) options = options with { MaterialFor = materials.Convert };

		var (root, stats) = VmapExporter.Build(bsp, data, options);
		var vmapPath = Path.Combine(sdk.ContentAddon, "maps", $"{name}.vmap");
		Directory.CreateDirectory(Path.GetDirectoryName(vmapPath)!);
		VmapExporter.Save(root, vmapPath);
		log($"wrote {vmapPath}: {stats.Faces} faces in {stats.Meshes} meshes");
		if (textures) {
			log($"ported {materials.Written.Count} materials" +
			    (materials.Missing.Count > 0 ? $"; {materials.Missing.Count} textures not found, drawn as tinted placeholders: {string.Join(", ", materials.Missing.Take(8))}{(materials.Missing.Count > 8 ? ", ..." : "")}" : ""));
		}

		var watch = Stopwatch.StartNew();
		if (materials.Written.Count > 0) {
			var list = Path.Combine(sdk.ContentAddon, "maps", $"{name}.materials.txt");
			File.WriteAllLines(list, materials.Written.Select(m => WindowsPath(Path.Combine(sdk.ContentAddon, m))));
			log($"compiling {materials.Written.Count} materials");
			RunCompiler(sdk, ["-filelist", WindowsPath(list), "-nop4", "-f"], log);
		}

		var compiled = Path.Combine(sdk.GameAddon, "maps", $"{name}.vpk");
		if (File.Exists(compiled)) File.Delete(compiled);
		log($"compiling {Path.GetFileName(vmapPath)} (this takes a few minutes)");
		// Visibility is most of the compile time on big maps (voxelizing the whole level), and
		// without it the engine just draws everything, which bhop maps' simple geometry allows.
		string[] stages = vis ? ["-world", "-phys", "-vis"] : ["-world", "-phys"];
		RunCompiler(sdk, ["-i", WindowsPath(vmapPath), "-nop4", "-fshallow", .. stages], log);
		watch.Stop();
		if (!File.Exists(compiled)) throw new IOException($"the compiler finished but wrote no {compiled}");

		// Final package: everything the compiler produced, the map's compiled materials, and the bhop data.
		var files = VpkArchive.Open(compiled).ReadAll();
		var compiledMaterials = Path.Combine(sdk.GameAddon, "materials", "ocbhop", name);
		if (Directory.Exists(compiledMaterials)) {
			foreach (var file in Directory.EnumerateFiles(compiledMaterials, "*", SearchOption.AllDirectories)) {
				var rel = Path.GetRelativePath(sdk.GameAddon, file).Replace('\\', '/');
				if (rel.EndsWith("_c", StringComparison.Ordinal)) files[rel] = File.ReadAllBytes(file);
			}
		}
		files[BhopMapData.PathInPackage(name)] = data.ToGzipBytes();
		Directory.CreateDirectory(outDir);
		var package = Path.Combine(outDir, $"{name}.vpk");
		VpkArchive.Write(package, files);
		log($"packed {package}: {files.Count} files, {new FileInfo(package).Length / 1024} KiB");
		return new Result(package, data, stats, watch.Elapsed);
	}

	/// <summary>Runs Deadlock's resource compiler (through rclaunch) with the SDK's game info.</summary>
	private static void RunCompiler(SdkLayout sdk, string[] extraArgs, Action<string> log) {
		string[] args = ["-consoleapp", "-consolelog", "-noassert", "-game", WindowsPath(sdk.GameInfoDir), .. extraArgs];
		var consoleLog = Path.Combine(sdk.GameInfoDir, "console.log");
		try {
			if (File.Exists(consoleLog)) File.Delete(consoleLog);
		} catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) {
			// The running compiler keeps its log open.
			throw new IOException($"another compile is running in {sdk.Root}; one SDK folder compiles one map at a time", ex);
		}
		var psi = new ProcessStartInfo(sdk.Launcher) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
		foreach (var a in args) psi.ArgumentList.Add(a);
		using var process = Process.Start(psi) ?? throw new IOException($"could not start {sdk.Launcher}");
		var errors = new List<string>();
		void OnLine(string? line) {
			if (string.IsNullOrWhiteSpace(line)) return;
			if (line.Contains("ERROR", StringComparison.Ordinal) || line.Contains("rclaunch:", StringComparison.Ordinal)) {
				errors.Add(line);
				log("  " + line);
			}
		}
		process.OutputDataReceived += (_, e) => OnLine(e.Data);
		process.ErrorDataReceived += (_, e) => OnLine(e.Data);
		process.BeginOutputReadLine();
		process.BeginErrorReadLine();
		process.WaitForExit();
		if (process.ExitCode != 0) {
			// The compiler logs to the console it would have opened; -consolelog copies that to a file.
			if (File.Exists(consoleLog)) {
				foreach (var line in File.ReadLines(consoleLog).TakeLast(25)) log("  | " + line);
			}
			throw new IOException($"the map compiler failed (exit {process.ExitCode}){(errors.Count > 0 ? ": " + errors[^1] : "")}");
		}
	}

	/// <summary>A path the Windows compiler understands, converting WSL's /mnt/x/ paths.</summary>
	public static string WindowsPath(string path) {
		var full = Path.GetFullPath(path);
		if (OperatingSystem.IsWindows()) return full;
		if (full.StartsWith("/mnt/", StringComparison.Ordinal) && full.Length > 6 && full[6] == '/') {
			return char.ToUpperInvariant(full[5]) + ":" + full[6..].Replace('/', '\\');
		}
		throw new InvalidOperationException($"{full} is not on a Windows drive; the compiler runs on Windows");
	}
}
