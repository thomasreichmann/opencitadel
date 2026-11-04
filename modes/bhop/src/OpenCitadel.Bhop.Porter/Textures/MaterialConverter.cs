using System.Globalization;
using System.IO.Compression;
using System.Text;

namespace OpenCitadel.Bhop.Porter.Textures;

/// <summary>A Source 1 material (VMT): its shader and parameters, with "patch" includes resolved.</summary>
public sealed class Vmt {
	public string Shader { get; init; } = "";
	public Dictionary<string, string> Params { get; } = new(StringComparer.OrdinalIgnoreCase);

	public string? this[string key] => Params.TryGetValue(key, out var v) ? v : null;
	public bool Flag(string key) => this[key] is { } v && v.Trim() != "0";

	/// <summary>Parses VMT text (KeyValues). Nested blocks (proxies, fallbacks) are skipped.</summary>
	public static Vmt Parse(string text) {
		var tokens = Tokenize(text).ToList();
		if (tokens.Count == 0) throw new InvalidDataException("empty VMT");
		var vmt = new Vmt { Shader = tokens[0] };
		var i = 1;
		if (i < tokens.Count && tokens[i] == "{") i++;
		var depth = 1;
		while (i < tokens.Count && depth > 0) {
			var t = tokens[i];
			if (t == "{") { depth++; i++; continue; }
			if (t == "}") { depth--; i++; continue; }
			if (i + 1 < tokens.Count && tokens[i + 1] == "{") {
				// A block: "insert"/"replace" in patches merge into the parameters; others are skipped.
				var block = t.ToLowerInvariant();
				i += 2;
				var inner = 1;
				while (i < tokens.Count && inner > 0) {
					if (tokens[i] == "{") { inner++; i++; continue; }
					if (tokens[i] == "}") { inner--; i++; continue; }
					if (inner == 1 && (block is "insert" or "replace") && i + 1 < tokens.Count && tokens[i + 1] is not ("{" or "}")) {
						vmt.Params[tokens[i]] = tokens[i + 1];
						i += 2;
						continue;
					}
					i++;
				}
				continue;
			}
			if (depth == 1 && i + 1 < tokens.Count) {
				vmt.Params[t] = tokens[i + 1];
				i += 2;
				continue;
			}
			i++;
		}
		return vmt;
	}

	private static IEnumerable<string> Tokenize(string text) {
		var i = 0;
		while (i < text.Length) {
			var c = text[i];
			if (char.IsWhiteSpace(c)) { i++; continue; }
			if (c == '/' && i + 1 < text.Length && text[i + 1] == '/') {
				while (i < text.Length && text[i] != '\n') i++;
				continue;
			}
			if (c is '{' or '}') { yield return c.ToString(); i++; continue; }
			if (c == '"') {
				var end = text.IndexOf('"', i + 1);
				if (end < 0) end = text.Length;
				yield return text.Substring(i + 1, end - i - 1);
				i = end + 1;
				continue;
			}
			var sb = new StringBuilder();
			while (i < text.Length && !char.IsWhiteSpace(text[i]) && text[i] is not ('{' or '}' or '"')) sb.Append(text[i++]);
			yield return sb.ToString();
		}
	}
}

/// <summary>Where a port finds Source 1 files: the BSP's embedded pakfile first, then extra folders or VPKs.</summary>
public sealed class SourceFiles : IDisposable {
	private readonly ZipArchive? _pak;
	private readonly Dictionary<string, ZipArchiveEntry> _pakEntries = new(StringComparer.OrdinalIgnoreCase);
	private readonly List<string> _folders = new();
	private readonly List<Vpk.VpkReader> _vpks = new();

	/// <param name="pakfile">The BSP's embedded zip.</param>
	/// <param name="sources">
	/// Extra Source 1 content, searched in order: loose folders (e.g. a game's materials root's parent)
	/// and packages (*_dir.vpk). A folder's *_dir.vpk files are searched too, so pointing at
	/// cstrike/ or hl2/ picks up the game's texture packs.
	/// </param>
	public SourceFiles(byte[] pakfile, IEnumerable<string>? sources = null) {
		if (pakfile.Length > 0) {
			_pak = new ZipArchive(new MemoryStream(pakfile), ZipArchiveMode.Read);
			foreach (var e in _pak.Entries) _pakEntries[Normalize(e.FullName)] = e;
		}
		foreach (var source in sources ?? []) {
			if (File.Exists(source) && source.EndsWith(".vpk", StringComparison.OrdinalIgnoreCase)) {
				_vpks.Add(Vpk.VpkArchive.Open(source));
			} else if (Directory.Exists(source)) {
				_folders.Add(source);
				foreach (var vpk in Directory.EnumerateFiles(source, "*_dir.vpk").OrderBy(p => p, StringComparer.Ordinal)) {
					_vpks.Add(Vpk.VpkArchive.Open(vpk));
				}
			}
		}
	}

	public static string Normalize(string path) => path.Replace('\\', '/').TrimStart('/').ToLowerInvariant();

	public byte[]? Read(string path) {
		var key = Normalize(path);
		if (_pakEntries.TryGetValue(key, out var entry)) {
			using var s = entry.Open();
			using var ms = new MemoryStream();
			s.CopyTo(ms);
			return ms.ToArray();
		}
		foreach (var folder in _folders) {
			var candidate = Path.Combine(folder, key);
			if (File.Exists(candidate)) return File.ReadAllBytes(candidate);
		}
		foreach (var vpk in _vpks) {
			if (vpk.Read(key) is { } bytes) return bytes;
		}
		return null;
	}

	public void Dispose() => _pak?.Dispose();
}

/// <summary>
/// Converts the materials a map uses into Deadlock materials: the base texture becomes a TGA in the
/// addon's content folder and a pbr.vfx material points at it, with alpha test or translucency
/// carried over. Results are cached per texture name.
/// </summary>
public sealed class MaterialConverter {
	private readonly SourceFiles _files;
	private readonly string _contentRoot;
	private readonly string _folder;
	private readonly Dictionary<string, string?> _done = new(StringComparer.OrdinalIgnoreCase);

	public List<string> Written { get; } = new();
	public List<string> Missing { get; } = new();

	/// <param name="contentRoot">The addon's content folder.</param>
	/// <param name="mapName">Materials go under materials/ocbhop/&lt;map&gt;/.</param>
	public MaterialConverter(SourceFiles files, string contentRoot, string mapName) {
		_files = files;
		_contentRoot = contentRoot;
		_folder = $"materials/ocbhop/{mapName}";
	}

	/// <summary>The Deadlock material for a BSP texture name, or null when its texture can't be found.</summary>
	public string? Convert(string textureName) {
		if (_done.TryGetValue(textureName, out var cached)) return cached;
		string? result = null;
		try {
			result = ConvertCore(textureName);
		} catch (InvalidDataException ex) {
			Console.Error.WriteLine($"  material {textureName}: {ex.Message}");
		}
		if (result == null) Missing.Add(textureName);
		_done[textureName] = result;
		return result;
	}

	private string? ConvertCore(string textureName) {
		var vmt = LoadVmt(textureName, depth: 0);
		var baseTexture = vmt?["$basetexture"] ?? textureName;
		var vtf = _files.Read($"materials/{baseTexture}.vtf");
		if (vtf == null) return null;
		var image = VtfFile.Decode(vtf);

		var safe = Safe(textureName);
		var colorFile = $"{_folder}/{safe}_color.tga";
		Directory.CreateDirectory(Path.GetDirectoryName(Path.Combine(_contentRoot, colorFile))!);
		Tga.Write(Path.Combine(_contentRoot, colorFile), image);

		var alphaTest = vmt?.Flag("$alphatest") == true;
		var translucent = vmt?.Flag("$translucent") == true;
		var transFile = $"{_folder}/{safe}_trans.tga";
		if ((alphaTest || translucent) && image.HasAlpha) {
			var mask = new byte[image.Rgba.Length];
			for (var i = 0; i < mask.Length; i += 4) {
				mask[i] = mask[i + 1] = mask[i + 2] = image.Rgba[i + 3];
				mask[i + 3] = 255;
			}
			Tga.Write(Path.Combine(_contentRoot, transFile), new Image(image.Width, image.Height, mask));
		} else {
			alphaTest = translucent = false;
		}
		var alpha = vmt?["$alpha"] is { } a && float.TryParse(a, NumberStyles.Float, CultureInfo.InvariantCulture, out var av) ? av : 1f;
		if (alpha < 1f && !translucent) translucent = true;

		var sb = new StringBuilder();
		sb.AppendLine("\"Layer0\"");
		sb.AppendLine("{");
		sb.AppendLine("\t\"shader\"\t\"pbr.vfx\"");
		if (alphaTest) sb.AppendLine("\t\"F_ALPHA_TEST\"\t\"1\"");
		if (translucent) sb.AppendLine("\t\"F_TRANSLUCENT\"\t\"1\"");
		sb.AppendLine($"\t\"TextureColor1\"\t\"{colorFile}\"");
		if (alphaTest || translucent) {
			sb.AppendLine(File.Exists(Path.Combine(_contentRoot, transFile))
				? $"\t\"TextureTranslucency1\"\t\"{transFile}\""
				: $"\t\"TextureTranslucency1\"\t\"[{alpha.ToString("0.000", CultureInfo.InvariantCulture)} {alpha.ToString("0.000", CultureInfo.InvariantCulture)} {alpha.ToString("0.000", CultureInfo.InvariantCulture)} 0.000]\"");
			sb.AppendLine($"\t\"g_flOpacityScale1\"\t\"{alpha.ToString("0.000", CultureInfo.InvariantCulture)}\"");
		}
		// Source 1 maps have no PBR data: a rough, non-metallic surface reads closest to the original.
		sb.AppendLine("\t\"TextureRoughness1\"\t\"[0.850000 0.850000 0.850000 0.000000]\"");
		sb.AppendLine("\t\"TextureMetalness1\"\t\"[0.000000 0.000000 0.000000 0.000000]\"");
		sb.AppendLine("\t\"TextureNormal1\"\t\"[0.500000 0.500000 1.000000 0.000000]\"");
		// Every other input as a constant too: left unset they default to materials/default/*.tga
		// source images, which only exist in Valve's own content tree.
		sb.AppendLine("\t\"TextureTintMask1\"\t\"[1.000000 1.000000 1.000000 0.000000]\"");
		sb.AppendLine("\t\"TextureSelfIllumMask1\"\t\"[0.000000 0.000000 0.000000 0.000000]\"");
		sb.AppendLine("\t\"TextureAmbientOcclusion1\"\t\"[1.000000 1.000000 1.000000 0.000000]\"");
		sb.AppendLine("\t\"g_vColorTint1\"\t\"[1.000000 1.000000 1.000000 0.000000]\"");
		sb.AppendLine("}");
		var vmatPath = $"{_folder}/{safe}.vmat";
		File.WriteAllText(Path.Combine(_contentRoot, vmatPath), sb.ToString());
		Written.Add(vmatPath);
		return vmatPath;
	}

	private Vmt? LoadVmt(string name, int depth) {
		if (depth > 4) return null;
		var bytes = _files.Read($"materials/{name}.vmt") ?? _files.Read(name.EndsWith(".vmt", StringComparison.OrdinalIgnoreCase) ? name : name + ".vmt");
		if (bytes == null) return null;
		var vmt = Vmt.Parse(Encoding.UTF8.GetString(bytes));
		if (vmt.Shader.Equals("patch", StringComparison.OrdinalIgnoreCase) && vmt["include"] is { } include) {
			var target = include.Replace('\\', '/');
			if (target.StartsWith("materials/", StringComparison.OrdinalIgnoreCase)) target = target[10..];
			if (target.EndsWith(".vmt", StringComparison.OrdinalIgnoreCase)) target = target[..^4];
			var baseVmt = LoadVmt(target, depth + 1);
			if (baseVmt == null) return vmt;
			foreach (var (k, v) in vmt.Params) if (k != "include") baseVmt.Params[k] = v;
			return baseVmt;
		}
		return vmt;
	}

	/// <summary>A lowercase path segment without spaces, keeping the texture's folders.</summary>
	public static string Safe(string textureName) {
		var sb = new StringBuilder();
		foreach (var c in textureName.Replace('\\', '/').ToLowerInvariant()) {
			sb.Append(char.IsAsciiLetterOrDigit(c) || c is '_' or '/' or '-' ? c : '_');
		}
		return sb.ToString().Trim('/');
	}
}
