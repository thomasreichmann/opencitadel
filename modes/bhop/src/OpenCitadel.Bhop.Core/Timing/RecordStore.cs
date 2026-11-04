using System.Text.Json;

namespace OpenCitadel.Bhop.Timing;

/// <summary>A finished run.</summary>
public sealed record RunRecord {
	public required ulong SteamId { get; init; }
	public required string Name { get; init; }
	public required float Time { get; init; }
	public int Jumps { get; init; }
	public float MaxSpeed { get; init; }
	public DateTimeOffset Date { get; init; } = DateTimeOffset.UtcNow;
	/// <summary>Movement mode and settings the run was made with, e.g. "exact aa1000".</summary>
	public string Style { get; init; } = "";
}

/// <summary>How a finished run compares to what was there before.</summary>
public readonly record struct RecordResult(bool PersonalBest, bool MapRecord, float? PreviousBest, float? PreviousRecord, int Rank);

/// <summary>Best time per player per map, kept as one JSON file per map.</summary>
public sealed class RecordStore {
	private readonly string _dir;
	private readonly Dictionary<string, List<RunRecord>> _cache = new(StringComparer.OrdinalIgnoreCase);

	private static readonly JsonSerializerOptions Json = new() { WriteIndented = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

	public RecordStore(string dir) => _dir = dir;

	/// <summary>Leaderboard for a map, fastest first.</summary>
	public IReadOnlyList<RunRecord> Top(string map, string style) =>
		Load(map).Where(r => r.Style == style).OrderBy(r => r.Time).ToList();

	public RecordResult Submit(string map, RunRecord run) {
		var all = Load(map);
		var board = all.Where(r => r.Style == run.Style).OrderBy(r => r.Time).ToList();
		var previousRecord = board.Count > 0 ? board[0].Time : (float?)null;
		var mine = board.FirstOrDefault(r => r.SteamId == run.SteamId);
		var pb = mine == null || run.Time < mine.Time;
		if (pb) {
			if (mine != null) all.Remove(mine);
			all.Add(run);
			Save(map, all);
		}
		var rank = all.Where(r => r.Style == run.Style).OrderBy(r => r.Time).ToList().FindIndex(r => r.SteamId == run.SteamId) + 1;
		return new RecordResult(pb, previousRecord == null || run.Time < previousRecord, mine?.Time, previousRecord, rank);
	}

	private List<RunRecord> Load(string map) {
		if (_cache.TryGetValue(map, out var list)) return list;
		var path = PathFor(map);
		list = File.Exists(path) ? JsonSerializer.Deserialize<List<RunRecord>>(File.ReadAllText(path), Json) ?? new() : new();
		_cache[map] = list;
		return list;
	}

	private void Save(string map, List<RunRecord> list) {
		Directory.CreateDirectory(_dir);
		var path = PathFor(map);
		var tmp = path + ".tmp";
		File.WriteAllText(tmp, JsonSerializer.Serialize(list.OrderBy(r => r.Style).ThenBy(r => r.Time), Json));
		File.Move(tmp, path, overwrite: true);
	}

	private string PathFor(string map) {
		var safe = string.Concat(map.Where(c => char.IsLetterOrDigit(c) || c is '_' or '-'));
		return Path.Combine(_dir, $"{safe}.records.json");
	}

	/// <summary>"1:23.456" style time.</summary>
	public static string Format(float seconds) {
		var t = TimeSpan.FromMilliseconds(Math.Round(seconds * 1000.0));
		return t.TotalHours >= 1 ? $"{(int)t.TotalHours}:{t.Minutes:00}:{t.Seconds:00}.{t.Milliseconds:000}"
			: $"{t.Minutes}:{t.Seconds:00}.{t.Milliseconds:000}";
	}
}
