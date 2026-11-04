using System.Diagnostics;
using OpenCitadel.Bhop.Vpk;

namespace OpenCitadel.Bhop.Porter;

/// <summary>
/// Sets up (or refreshes, after a game update) the folder the porter compiles maps in: Deadlock's
/// binaries and packages, the three Workshop Tools modules Deadlock lacks, the tools' text configs,
/// and rclaunch.exe. See modes/bhop/README.md, "The compiler SDK".
/// </summary>
public static class SdkSetup {
	public sealed record Options(string Deadlock, string Sdk, string DotaTools, string? Cs2);

	private const string GameTracking = "https://raw.githubusercontent.com/SteamDatabase/GameTracking-Dota2/master";
	private const string ModlockFgd = "https://raw.githubusercontent.com/paralin/modlock-sdk/master/metadata/citadel.fgd";
	private static readonly string[] CoreFgds = ["base.fgd", "models_base.fgd", "lights.fgd", "lights2.fgd", "markup_volumes.fgd", "postprocessing.fgd", "ai_defaultnpc.fgd"];
	private static readonly string[] DotaModules = ["modeldoc_utils.dll", "exportsystem.dll", "smartprops.dll"];
	private static readonly string[] Cs2Modules = ["bc7e.dll", "ispc_texcomp.dll"];

	public static void Run(Options o, Action<string> log) {
		var game = Path.Combine(o.Deadlock, "game");
		if (!File.Exists(Path.Combine(game, "bin", "win64", "engine2.dll"))) throw new FileNotFoundException($"{o.Deadlock} doesn't look like a Deadlock install (no game/bin/win64/engine2.dll)");
		var bin = Path.Combine(o.Sdk, "game", "bin", "win64");
		var gameInfoDir = Path.Combine(o.Sdk, "game", "citadel");
		Directory.CreateDirectory(bin);
		Directory.CreateDirectory(gameInfoDir);
		Directory.CreateDirectory(Path.Combine(o.Sdk, "content", "citadel_addons"));
		Directory.CreateDirectory(Path.Combine(o.Sdk, "game", "citadel_addons"));

		// 1. Deadlock's engine and compiler. Copies, refreshed when the game updates.
		var copied = 0;
		foreach (var file in Directory.EnumerateFiles(Path.Combine(game, "bin", "win64"), "*", SearchOption.AllDirectories)) {
			var rel = Path.GetRelativePath(Path.Combine(game, "bin", "win64"), file);
			// Deadworks' own files (managed code, configs, logs) aren't needed to compile.
			if (new[] { "managed", "configs", "logs" }.Any(d => rel.StartsWith(d + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) ||
			    rel.EndsWith(".mdmp", StringComparison.OrdinalIgnoreCase) || rel.Equals("deadworks.exe", StringComparison.OrdinalIgnoreCase)) continue;
			var dest = Path.Combine(bin, rel);
			var stamp = File.GetLastWriteTimeUtc(file);
			// Seconds only: setting a time through WSL's drive mount drops the fraction.
			if (File.Exists(dest) && Math.Abs((File.GetLastWriteTimeUtc(dest) - stamp).TotalSeconds) < 1 && new FileInfo(dest).Length == new FileInfo(file).Length) continue;
			Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
			File.Copy(file, dest, overwrite: true);
			File.SetLastWriteTimeUtc(dest, stamp);
			copied++;
		}
		log($"engine: {copied} files updated in {bin}");

		// 2. The missing tool modules.
		foreach (var m in DotaModules) CopyFrom(o.DotaTools, m, bin, "Dota 2 Workshop Tools", log);
		if (o.Cs2 != null) foreach (var m in Cs2Modules) CopyFrom(Path.Combine(o.Cs2, "game", "bin", "win64"), m, bin, "CS2 Workshop Tools", log);
		else log("no --cs2: textures will fail to compress until bc7e.dll and ispc_texcomp.dll are in place");

		// 3. Text configs and entity definitions.
		using var http = new HttpClient();
		Download(http, $"{GameTracking}/game/bin/assettypes_common.txt", Path.Combine(o.Sdk, "game", "bin", "assettypes_common.txt"), log);
		foreach (var fgd in CoreFgds) Download(http, $"{GameTracking}/game/core/{fgd}", Path.Combine(gameInfoDir, fgd), log);
		Download(http, ModlockFgd, Path.Combine(gameInfoDir, "citadel.fgd"), log);
		File.WriteAllText(Path.Combine(gameInfoDir, "gameinfo.gi"), GameInfo);

		// 4. Gizmo materials the compiler loads at startup, under the names it asks for.
		var core = VpkArchive.Open(Path.Combine(game, "core", "pak01_dir.vpk"));
		var tools = Path.Combine(gameInfoDir, "materials", "tools");
		Directory.CreateDirectory(tools);
		foreach (var (from, to) in new[] { ("handle_generic", "handle_generic_aligned"), ("handle_generic_translucent", "handle_generic_aligned_translucent") }) {
			var bytes = core.Read($"materials/tools/{from}.vmat_c") ?? throw new FileNotFoundException($"materials/tools/{from}.vmat_c not in Deadlock's core package");
			File.WriteAllBytes(Path.Combine(tools, $"{to}.vmat_c"), bytes);
		}

		// 5. Deadlock's packages, through junctions (no copies of the multi-gigabyte VPKs).
		Junction(Path.Combine(o.Sdk, "game", "citadel_assets"), Path.Combine(game, "citadel"), log);
		Junction(Path.Combine(o.Sdk, "game", "core"), Path.Combine(game, "core"), log);

		// 6. The launcher.
		var launcher = Path.Combine(bin, "rclaunch.exe");
		if (!File.Exists(launcher) || LauncherSourceChanged(bin)) BuildLauncher(bin, log);
		log(File.Exists(launcher) ? $"ready: {o.Sdk}" : $"set up {o.Sdk}, but rclaunch.exe is missing: build native/rclaunch.c with MSVC (cl rclaunch.c user32.lib) and put it in {bin}");
	}

	private static void CopyFrom(string dir, string file, string bin, string what, Action<string> log) {
		var src = Directory.Exists(dir) ? Directory.EnumerateFiles(dir, file, SearchOption.AllDirectories).FirstOrDefault() : null;
		if (src == null) throw new FileNotFoundException($"{file} not found under {dir} ({what})");
		File.Copy(src, Path.Combine(bin, file), overwrite: true);
		log($"{file} from {what}");
	}

	private static void Download(HttpClient http, string url, string dest, Action<string> log) {
		var bytes = http.GetByteArrayAsync(url).GetAwaiter().GetResult();
		File.WriteAllBytes(dest, bytes);
		log($"fetched {Path.GetFileName(dest)}");
	}

	/// <summary>A directory junction (works without admin rights; gameinfo.gi can't take absolute paths).</summary>
	private static void Junction(string link, string target, Action<string> log) {
		if (Directory.Exists(link)) return;
		// cmd.exe can't start in a WSL path, so run it from the (Windows-side) parent folder.
		var psi = new ProcessStartInfo("cmd.exe") { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, WorkingDirectory = Path.GetDirectoryName(link)! };
		foreach (var a in new[] { "/c", "mklink", "/J", MapBuilder.WindowsPath(link), MapBuilder.WindowsPath(target) }) psi.ArgumentList.Add(a);
		using var p = Process.Start(psi) ?? throw new IOException("could not run cmd.exe to create a junction");
		p.WaitForExit();
		if (p.ExitCode != 0) throw new IOException($"mklink /J {link} failed: {p.StandardError.ReadToEnd()}");
		log($"junction {link} -> {target}");
	}

	private static string LauncherWorkDir(string bin) => Path.GetFullPath(Path.Combine(bin, "..", "..", "..", "build"));

	private static byte[] EmbeddedLauncherSource() {
		using var src = typeof(SdkSetup).Assembly.GetManifestResourceStream("rclaunch.c") ?? throw new InvalidDataException("rclaunch.c is not embedded in the porter");
		using var ms = new MemoryStream();
		src.CopyTo(ms);
		return ms.ToArray();
	}

	/// <summary>The launcher was built from an older rclaunch.c than this porter carries.</summary>
	private static bool LauncherSourceChanged(string bin) {
		var built = Path.Combine(LauncherWorkDir(bin), "rclaunch.c");
		return File.Exists(built) && !File.ReadAllBytes(built).AsSpan().SequenceEqual(EmbeddedLauncherSource());
	}

	/// <summary>Builds rclaunch.exe (native/rclaunch.c, embedded in the porter) with MSVC when Visual Studio is installed.</summary>
	private static void BuildLauncher(string bin, Action<string> log) {
		var vswhere = Path.Combine(Environment.GetEnvironmentVariable("ProgramFiles(x86)") ?? "/mnt/c/Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe");
		if (!File.Exists(vswhere)) vswhere = "/mnt/c/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe";
		if (!File.Exists(vswhere)) {
			log("Visual Studio not found; can't build rclaunch.exe");
			return;
		}
		var find = new ProcessStartInfo(vswhere) { UseShellExecute = false, RedirectStandardOutput = true };
		foreach (var a in new[] { "-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath" }) find.ArgumentList.Add(a);
		using var fp = Process.Start(find)!;
		var vs = fp.StandardOutput.ReadToEnd().Trim().Split('\n').FirstOrDefault()?.Trim();
		fp.WaitForExit();
		if (string.IsNullOrEmpty(vs)) {
			log("no Visual Studio with the C++ tools; can't build rclaunch.exe");
			return;
		}
		var work = LauncherWorkDir(bin);
		Directory.CreateDirectory(work);
		File.WriteAllBytes(Path.Combine(work, "rclaunch.c"), EmbeddedLauncherSource());
		var bat = Path.Combine(work, "build-rclaunch.bat");
		File.WriteAllText(bat, $"@echo off\r\ncall \"{vs}\\VC\\Auxiliary\\Build\\vcvars64.bat\" >nul\r\ncd /d \"%~dp0\"\r\ncl /nologo /O2 /W3 rclaunch.c /Fe:rclaunch.exe user32.lib\r\n");
		var psi = new ProcessStartInfo("cmd.exe") { UseShellExecute = false, RedirectStandardOutput = true, WorkingDirectory = work };
		psi.ArgumentList.Add("/c");
		psi.ArgumentList.Add(MapBuilder.WindowsPath(bat));
		using var p = Process.Start(psi)!;
		p.StandardOutput.ReadToEnd();
		p.WaitForExit();
		var exe = Path.Combine(work, "rclaunch.exe");
		if (File.Exists(exe)) {
			File.Copy(exe, Path.Combine(bin, "rclaunch.exe"), overwrite: true);
			log("built rclaunch.exe");
		}
	}

	/// <summary>
	/// The compiler's game info: Deadlock's packages on the search path, no mod app systems (they
	/// need game code the compiler doesn't load), and no baked lighting, audio or nav builders.
	/// </summary>
	private const string GameInfo = """
		"GameInfo"
		{
		    game "OpenCitadel map compiler"
		    title "OpenCitadel map compiler"
		    GameData "citadel.fgd"
		    LayeredOnMod core
		    Engine2 { HasModAppSystems 0 }
		    FileSystem
		    {
		        SteamAppId 1422450
		        SearchPaths
		        {
		            Mod citadel
		            Write citadel
		            Game citadel
		            Game core
		            Mod core
		            Game citadel_assets
		            AddonRoot citadel_addons
		        }
		    }
		    ResourceCompiler
		    {
		        DefaultMapBuilders
		        {
		            bakedlighting 0
		            envmap 0
		            nav 0
		            sareverb 0
		            sapaths 0
		            sacustomdata 0
		        }
		        MeshCompiler
		        {
		            OptimizeForMeshlets 1
		            TrianglesPerMeshlet 64
		            UseMikkTSpace 1
		            EncodeVertexBuffer 1
		            EncodeVertexBufferVersion 1
		            EncodeVertexBufferLevel 3
		            EncodeIndexBuffer 1
		            SplitDepthStream 1
		        }
		        WorldRendererBuilder
		        {
		            VisibilityGuidedMeshClustering 1
		            MinimumTrianglesPerClusteredMesh 8192
		            MinimumVerticesPerClusteredMesh 8192
		            MinimumVolumePerClusteredMesh 8192
		            MaxPrecomputedVisClusterMembership 96
		            MaxCullingBoundsGroups 128
		            UseAggregateInstances 1
		            AggregateInstancingMeshlets 1
		            BakePropsWithExtraVertexStreams 1
		            MergeTranslucents 1
		        }
		        TextureCompiler
		        {
		            AllowNP2Textures 1
		        }
		    }
		}

		""";
}
