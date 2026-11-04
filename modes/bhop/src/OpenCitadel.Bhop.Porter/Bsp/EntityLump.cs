using System.Globalization;
using System.Numerics;
using System.Text;

namespace OpenCitadel.Bhop.Porter.Bsp;

/// <summary>One entity from a BSP's entity lump: its key/value pairs in file order (keys can repeat, e.g. outputs).</summary>
public sealed class BspEntity {
	public List<KeyValuePair<string, string>> Pairs { get; } = new();

	public string? this[string key] => Pairs.FirstOrDefault(p => p.Key.Equals(key, StringComparison.OrdinalIgnoreCase)).Value;
	public string ClassName => this["classname"] ?? "";
	public string TargetName => this["targetname"] ?? "";

	public IEnumerable<string> All(string key) =>
		Pairs.Where(p => p.Key.Equals(key, StringComparison.OrdinalIgnoreCase)).Select(p => p.Value);

	public Vector3 Origin => ParseVector(this["origin"]);
	public Vector3 Angles => ParseVector(this["angles"]);

	/// <summary>The brush model index for "*N" models, or -1.</summary>
	public int BrushModel {
		get {
			var m = this["model"];
			return m != null && m.StartsWith('*') && int.TryParse(m.AsSpan(1), NumberStyles.Integer, CultureInfo.InvariantCulture, out var n) ? n : -1;
		}
	}

	public float Float(string key, float fallback = 0) =>
		float.TryParse(this[key], NumberStyles.Float, CultureInfo.InvariantCulture, out var v) ? v : fallback;

	public int Int(string key, int fallback = 0) =>
		int.TryParse(this[key], NumberStyles.Integer, CultureInfo.InvariantCulture, out var v) ? v : fallback;

	public static Vector3 ParseVector(string? text) {
		if (string.IsNullOrWhiteSpace(text)) return Vector3.Zero;
		var parts = text.Split(' ', StringSplitOptions.RemoveEmptyEntries);
		float P(int i) => i < parts.Length && float.TryParse(parts[i], NumberStyles.Float, CultureInfo.InvariantCulture, out var v) ? v : 0f;
		return new Vector3(P(0), P(1), P(2));
	}

	/// <summary>Parses a BSP entity lump (Source's "{ "key" "value" ... }" text).</summary>
	public static List<BspEntity> ParseLump(string text) {
		var result = new List<BspEntity>();
		BspEntity? current = null;
		var i = 0;
		string? pendingKey = null;
		while (i < text.Length) {
			var c = text[i];
			if (char.IsWhiteSpace(c)) { i++; continue; }
			if (c == '{') { current = new BspEntity(); pendingKey = null; i++; continue; }
			if (c == '}') {
				if (current != null) result.Add(current);
				current = null;
				i++;
				continue;
			}
			if (c == '"') {
				var end = text.IndexOf('"', i + 1);
				if (end < 0) break;
				var token = text.Substring(i + 1, end - i - 1);
				i = end + 1;
				if (current == null) continue;
				if (pendingKey == null) pendingKey = token;
				else {
					current.Pairs.Add(new(pendingKey, token));
					pendingKey = null;
				}
				continue;
			}
			// Unquoted token (rare): read to whitespace.
			var sb = new StringBuilder();
			while (i < text.Length && !char.IsWhiteSpace(text[i]) && text[i] != '"' && text[i] != '{' && text[i] != '}') sb.Append(text[i++]);
			if (current == null) continue;
			if (pendingKey == null) pendingKey = sb.ToString();
			else {
				current.Pairs.Add(new(pendingKey, sb.ToString()));
				pendingKey = null;
			}
		}
		return result;
	}
}
