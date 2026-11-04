using System.Globalization;
using System.Text.Json;
using OpenCitadel.Bhop.Map;

namespace OpenCitadel.Bhop.Timing;

/// <summary>
/// Reads zones in bhoptimer's JSON format: what shavit-zones-json loads, and what the community
/// zone collections such as https://github.com/srcwr/zones publish for thousands of CS:S maps.
/// Ported maps keep their CS:S coordinates, so these zones apply unchanged.
/// </summary>
public static class BhoptimerZones {
	/// <summary>Where the srcwr collection serves a map's zones.</summary>
	public const string SrcwrUrl = "https://srcwr.github.io/zones-cstrike/z/{map}.json";

	/// <summary>bhoptimer's zone types, in its enum order (numeric types in older dumps).</summary>
	private static readonly string[] TypeNames = [
		"start", "end", "respawn", "stop", "slay", "freestyle", "customspeedlimit", "teleport", "customspawn",
		"easybhop", "slide", "airaccelerate", "stage", "notimergravity", "gravity", "speedmod", "nojump", "autobhop",
	];

	public sealed record Result(List<MapZone> Zones, List<string> Skipped);

	/// <summary>
	/// Converts the zones the timer here understands: start and end (every track), stages (as
	/// checkpoints), stop and slide. Other types are listed in <see cref="Result.Skipped"/>.
	/// Start zones get bhoptimer's restart position: the zone's centre, 1 unit above its floor.
	/// </summary>
	public static Result Parse(string json) {
		using var doc = JsonDocument.Parse(json);
		if (doc.RootElement.ValueKind != JsonValueKind.Array) throw new InvalidDataException("bhoptimer zones are a JSON array");
		var zones = new List<MapZone>();
		var skipped = new List<string>();
		foreach (var e in doc.RootElement.EnumerateArray()) {
			var type = TypeOf(e);
			var track = e.TryGetProperty("track", out var t) && t.TryGetInt32(out var tv) ? tv : 0;
			if (!e.TryGetProperty("point_a", out var a) || !e.TryGetProperty("point_b", out var b)) {
				skipped.Add($"{type} (no corners)");
				continue;
			}
			var pa = Vec(a);
			var pb = Vec(b);
			var mins = new Vec3(MathF.Min(pa.X, pb.X), MathF.Min(pa.Y, pb.Y), MathF.Min(pa.Z, pb.Z));
			var maxs = new Vec3(MathF.Max(pa.X, pb.X), MathF.Max(pa.Y, pb.Y), MathF.Max(pa.Z, pb.Z));
			var zone = new MapZone { Track = track, Mins = mins, Maxs = maxs };
			switch (type) {
				case "start":
					zone.Kind = ZoneKind.Start;
					zone.Teleport = new Vec3((mins.X + maxs.X) / 2, (mins.Y + maxs.Y) / 2, mins.Z + 1f);
					break;
				case "end":
					zone.Kind = ZoneKind.End;
					break;
				case "stage":
					zone.Kind = ZoneKind.Checkpoint;
					zone.Index = e.TryGetProperty("data", out var d) && d.TryGetInt32(out var dv) ? dv : 0;
					if (e.TryGetProperty("dest", out var dest) && dest.ValueKind == JsonValueKind.Array) zone.Teleport = Vec(dest);
					break;
				case "stop":
					zone.Kind = ZoneKind.Stop;
					break;
				case "slide":
					zone.Kind = ZoneKind.Slide;
					break;
				default:
					skipped.Add(track > 0 ? $"{type} (bonus {track})" : type);
					continue;
			}
			zones.Add(zone);
		}
		return new Result(zones, skipped);
	}

	private static string TypeOf(JsonElement e) {
		if (!e.TryGetProperty("type", out var t)) return "?";
		if (t.ValueKind == JsonValueKind.Number && t.TryGetInt32(out var n)) return n >= 0 && n < TypeNames.Length ? TypeNames[n] : n.ToString(CultureInfo.InvariantCulture);
		return (t.GetString() ?? "?").ToLowerInvariant();
	}

	private static Vec3 Vec(JsonElement a) {
		var v = a.EnumerateArray().Select(x => x.GetSingle()).ToArray();
		if (v.Length != 3) throw new InvalidDataException("a zone corner needs three coordinates");
		return new Vec3(v[0], v[1], v[2]);
	}

	/// <summary>True when the text looks like bhoptimer's format rather than the plugin's own zone files.</summary>
	public static bool IsBhoptimerJson(string json) => json.Contains("\"point_a\"", StringComparison.Ordinal);
}
