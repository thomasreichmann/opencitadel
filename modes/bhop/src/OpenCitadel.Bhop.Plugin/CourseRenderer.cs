using System.Numerics;
using DeadworksManaged.Api;
using OpenCitadel.Bhop.Map;

namespace OpenCitadel.Bhop.Plugin;

/// <summary>
/// Draws a ported map for players who don't have its package, with nothing but stock content: each
/// <see cref="MapPanel"/> becomes one or more point_worldtext rows of full blocks (see
/// <see cref="PanelLayout"/>). Rows are spawned a batch per server frame, so a big map doesn't stall
/// the server.
/// </summary>
/// <remarks>
/// <para>
/// A map is drawn within a budget of bytes. A player who joins is sent every entity they can see in
/// one update, which Deadlock builds in a fixed buffer of 1,280,000 bytes: a bigger one and the
/// server drops the player (NETWORK_DISCONNECT_DELTAENTMSG_OVERFLOW). So the rows drawn at any time
/// must leave room in it for the Deadlock map's own entities and the players. Every row is also a
/// networked entity, and the server has a fixed number of those, so there is a ceiling on rows too.
/// </para>
/// <para>
/// A map within both budgets is drawn whole. A bigger one keeps its largest panels (the floors,
/// walls and ramps that give its shape from afar) drawn all the time and streams the rest: the
/// smaller details nearest the players, within a radius, refreshed twice a second.
/// </para>
/// </remarks>
internal sealed class CourseRenderer {
	/// <summary>Every row's targetname, so they can all be found again (also after a plugin reload).</summary>
	public const string Name = "bhop_course";

	private sealed class Item {
		public Item(PanelLayout.GlyphRow row, float importance) {
			Row = row;
			Importance = importance;
			Bytes = row.NetworkBytes;
			var m = PanelLayout.Default;
			var (along, up, _) = PanelLayout.Axes(row.Angles);
			Along = along;
			Up = up;
			HalfLength = row.Blocks * m.Advance * row.UnitsPerPixel / 2;
			HalfHeight = m.InkHeight * row.UnitsPerPixel / 2;
			Centre = row.Origin + along * (m.InkAlong * row.UnitsPerPixel) + up * (m.InkUp * row.UnitsPerPixel);
		}

		public PanelLayout.GlyphRow Row { get; }
		public float Importance { get; }
		/// <summary>What creating it adds to a player's update.</summary>
		public int Bytes { get; }
		public bool IsFixed { get; set; }
		public CBaseEntity? Entity { get; set; }
		// The drawn rectangle, for culling.
		public Vector3 Centre { get; }
		public Vector3 Along { get; }
		public Vector3 Up { get; }
		public float HalfLength { get; }
		public float HalfHeight { get; }
	}

	// Every row by where it is, for back-face culling: big ones in a list, the rest in a grid.
	private readonly List<Item> _cullBig = new();
	private readonly Dictionary<(int, int, int), List<Item>> _cullGrid = new();
	private const float CullCell = 512f;

	private static (int, int, int) Key(Vector3 p, float cell) =>
		((int)MathF.Floor(p.X / cell), (int)MathF.Floor(p.Y / cell), (int)MathF.Floor(p.Z / cell));

	/// <summary>
	/// The drawn rows within <paramref name="radius"/> of <paramref name="camera"/> that face away from
	/// it. Glyphs draw from both sides, so a wall Deadlock's third-person camera has slipped behind
	/// (it doesn't collide with drawn courses) would hide the player; leaving these out for that player
	/// makes panels one-sided, as the map's own surfaces are.
	/// </summary>
	public void BackFacing(Vector3 camera, float radius, List<CBaseEntity> into) {
		into.Clear();
		var r2 = radius * radius;
		void Test(Item item) {
			if (item.Entity is not { } e) return;
			var local = camera - item.Centre;
			var outward = Vector3.Dot(local, item.Row.Normal);
			if (outward >= -1f) return; // in front, or on the plane
			var dx = MathF.Max(0f, MathF.Abs(Vector3.Dot(local, item.Along)) - item.HalfLength);
			var dy = MathF.Max(0f, MathF.Abs(Vector3.Dot(local, item.Up)) - item.HalfHeight);
			if (dx * dx + dy * dy + outward * outward <= r2) into.Add(e);
		}
		foreach (var item in _cullBig) Test(item);
		var (cx, cy, cz) = Key(camera, CullCell);
		var reach = (int)MathF.Ceiling(radius / CullCell) + 1;
		for (var x = cx - reach; x <= cx + reach; x++)
		for (var y = cy - reach; y <= cy + reach; y++)
		for (var z = cz - reach; z <= cz + reach; z++) {
			if (_cullGrid.TryGetValue((x, y, z), out var list)) foreach (var item in list) Test(item);
		}
	}

	private List<Item> _fixed = new();
	private List<Item> _details = new();
	private Dictionary<(int, int, int), List<Item>> _grid = new();
	private readonly HashSet<Item> _shown = new();
	private List<Item> _wanted = new();
	private int _fixedNext;
	private int _ticks;
	private bool _full;
	private const float Cell = 1024f;
	// What the streamed details may use: the budgets minus the fixed rows.
	private long _detailBytes;
	private int _detailCount;

	/// <summary>Rows drawn right now.</summary>
	public int Spawned => _shown.Count;
	/// <summary>What the rows drawn right now cost a player who joins (see <see cref="PanelLayout.GlyphRow.NetworkBytes"/>).</summary>
	public long SpawnedBytes { get; private set; }
	/// <summary>Rows the current map has in all.</summary>
	public int Total => _fixed.Count + _details.Count;
	/// <summary>Rows of the whole course, drawn or not.</summary>
	public int Rows { get; private set; }
	/// <summary>What all of the current map's rows would cost at once.</summary>
	public long TotalBytes { get; private set; }
	/// <summary>Rows always drawn (all of them for a map within the budget).</summary>
	public int Fixed => _fixed.Count;
	public long FixedBytes { get; private set; }
	public bool Streaming => _details.Count > 0;
	/// <summary>Rows created and removed so far: what players have been sent besides their first update.</summary>
	public long Created { get; private set; }
	public long Removed { get; private set; }

	/// <summary>
	/// Starts drawing a map's panels, replacing whatever was drawn: never more than
	/// <paramref name="budgetBytes"/> (see <see cref="PanelLayout.GlyphRow.NetworkBytes"/>) or
	/// <paramref name="maxEntities"/> rows at once, of which <paramref name="fixedShare"/> for the
	/// largest panels when the map needs more. The rest is streamed in near players, or with
	/// <paramref name="stream"/> off, left out.
	/// </summary>
	public void Show(IEnumerable<MapPanel> panels, long budgetBytes, int maxEntities, float fixedShare, bool stream = true) {
		Clear();
		var items = new List<Item>();
		foreach (var p in panels) {
			var rows = PanelLayout.Rows(p);
			foreach (var r in rows) items.Add(new Item(r, p.Width * p.Height / rows.Count));
		}
		items.Sort((a, b) => b.Importance.CompareTo(a.Importance));
		foreach (var item in items) {
			if (MathF.Max(item.HalfLength, item.HalfHeight) > CullCell / 2) {
				_cullBig.Add(item);
				continue;
			}
			var key = Key(item.Centre, CullCell);
			if (!_cullGrid.TryGetValue(key, out var cell)) _cullGrid[key] = cell = new List<Item>();
			cell.Add(item);
		}
		TotalBytes = items.Sum(i => (long)i.Bytes);
		Rows = items.Count;
		var keep = 0;
		long kept = 0;
		if (TotalBytes <= budgetBytes && items.Count <= maxEntities) {
			keep = items.Count;
			kept = TotalBytes;
		} else {
			var share = Math.Clamp(fixedShare, 0f, 1f);
			var byteLimit = (long)(budgetBytes * share);
			var countLimit = (int)(maxEntities * share);
			while (keep < items.Count && keep < countLimit && kept + items[keep].Bytes <= byteLimit) kept += items[keep++].Bytes;
		}
		FixedBytes = kept;
		_detailBytes = Math.Max(0, budgetBytes - kept);
		_detailCount = Math.Max(0, maxEntities - keep);
		_fixed = items.GetRange(0, keep);
		foreach (var item in _fixed) item.IsFixed = true;
		_details = stream ? items.GetRange(keep, items.Count - keep) : new List<Item>();
		foreach (var item in _details) {
			var o = item.Row.Origin;
			var key = ((int)MathF.Floor(o.X / Cell), (int)MathF.Floor(o.Y / Cell), (int)MathF.Floor(o.Z / Cell));
			if (!_grid.TryGetValue(key, out var list)) _grid[key] = list = new List<Item>();
			list.Add(item);
		}
	}

	/// <summary>Rows on their way out, removed a batch per frame.</summary>
	private readonly Queue<CBaseEntity> _dying = new();

	/// <summary>
	/// Removes everything drawn (rows left over from before a plugin reload too), a batch per frame:
	/// players are sent every removal and creation of a frame in one update, and a course's worth at
	/// once overflows it (the server drops them with NETWORK_DISCONNECT_DELTAENTMSG_OVERFLOW).
	/// </summary>
	public void Clear(bool mapChanged = false) {
		// A new Deadlock map took the old rows with it; nothing to remove (or to mistake for them).
		if (mapChanged) _dying.Clear();
		else foreach (var e in Entities.ByName(Name).ToList()) _dying.Enqueue(e);
		_fixed = new List<Item>();
		_details = new List<Item>();
		_grid = new Dictionary<(int, int, int), List<Item>>();
		_cullBig.Clear();
		_cullGrid.Clear();
		_shown.Clear();
		_wanted = new List<Item>();
		_fixedNext = 0;
		_full = false;
		_detailBytes = 0;
		_detailCount = 0;
		SpawnedBytes = 0;
		TotalBytes = 0;
		FixedBytes = 0;
	}

	/// <summary>
	/// Spawns (and for streamed maps, removes) up to <paramref name="batch"/> rows. Returns a line to
	/// log when the fixed part has just been drawn, else null.
	/// </summary>
	public string? Tick(int batch, IReadOnlyList<Vector3> players, float radius) {
		string? done = null;
		var left = Math.Max(1, batch);
		// The old course goes first, all of it before anything new is drawn, so the two together
		// never exceed the budget. A removal is a few bytes of an update, a creation up to ~550.
		for (var removals = left * 4; _dying.Count > 0 && removals > 0; removals--) {
			var e = _dying.Dequeue();
			if (e.IsValid) e.Remove();
		}
		if (_dying.Count > 0) return null;
		if (_fixedNext < _fixed.Count) {
			for (; _fixedNext < _fixed.Count && left > 0 && !_full; _fixedNext++, left--) Show(_fixed[_fixedNext]);
			if (_fixedNext >= _fixed.Count || _full) {
				_fixedNext = _fixed.Count;
				done = $"{_shown.Count} panel entities drawn ({Kib(SpawnedBytes)})" +
				       (_details.Count > 0 ? $", {_details.Count} more streamed near players, up to {Kib(_detailBytes)} at once" : "") +
				       $"; {Entities.All.Count()} entities on the server{(_full ? " (out of entity slots: stopped)" : "")}";
			}
			return done;
		}
		if (_details.Count == 0 || _full) return null;
		if (++_ticks % 32 == 0) {
			_wanted = Nearest(players, radius, _detailBytes, _detailCount);
			// What's no longer wanted goes before anything new is added, so the budget holds at every frame.
			var keep = new HashSet<Item>(_wanted);
			foreach (var item in _shown.Where(i => !i.IsFixed && !keep.Contains(i)).ToList()) Hide(item);
		}
		// Then what is wanted is added, a batch at a time.
		foreach (var item in _wanted) {
			if (left <= 0 || _full) break;
			if (_shown.Contains(item)) continue;
			Show(item);
			left--;
		}
		return null;
	}

	/// <summary>
	/// The detail rows nearest any player within the radius, nearest first, at most
	/// <paramref name="maxBytes"/> and <paramref name="maxCount"/> of them.
	/// </summary>
	private List<Item> Nearest(IReadOnlyList<Vector3> players, float radius, long maxBytes, int maxCount) {
		if (maxBytes <= 0 || maxCount <= 0 || players.Count == 0) return new List<Item>();
		var reach = (int)MathF.Ceiling(radius / Cell);
		var scored = new Dictionary<Item, float>();
		foreach (var p in players) {
			var cx = (int)MathF.Floor(p.X / Cell);
			var cy = (int)MathF.Floor(p.Y / Cell);
			var cz = (int)MathF.Floor(p.Z / Cell);
			for (var x = cx - reach; x <= cx + reach; x++)
			for (var y = cy - reach; y <= cy + reach; y++)
			for (var z = cz - reach; z <= cz + reach; z++) {
				if (!_grid.TryGetValue((x, y, z), out var list)) continue;
				foreach (var item in list) {
					var d = Vector3.Distance(item.Row.Origin, p);
					if (d > radius) continue;
					// Bigger details count as nearer, so they show from further away.
					var score = d / MathF.Sqrt(MathF.Max(1f, item.Importance) / 1024f + 1f);
					if (!scored.TryGetValue(item, out var s) || score < s) scored[item] = score;
				}
			}
		}
		var wanted = new List<Item>();
		long bytes = 0;
		foreach (var item in scored.OrderBy(kv => kv.Value).Select(kv => kv.Key)) {
			if (wanted.Count >= maxCount || maxBytes - bytes < SmallestRow) break;
			if (bytes + item.Bytes > maxBytes) continue; // a smaller one further out may still fit
			bytes += item.Bytes;
			wanted.Add(item);
		}
		return wanted;
	}

	/// <summary>What the cheapest row (a single block) costs.</summary>
	private static readonly int SmallestRow = new PanelLayout.GlyphRow(default, default, 1, 1f, 0).NetworkBytes;

	private static string Kib(long bytes) => $"{bytes / 1024.0:0} KiB";

	private void Show(Item item) {
		var e = Spawn(item.Row);
		if (e == null) {
			_full = true;
			return;
		}
		item.Entity = e;
		_shown.Add(item);
		SpawnedBytes += item.Bytes;
		Created++;
	}

	private void Hide(Item item) {
		if (item.Entity != null) Removed++;
		item.Entity?.Remove();
		item.Entity = null;
		if (_shown.Remove(item)) SpawnedBytes -= item.Bytes;
	}

	private static CBaseEntity? Spawn(PanelLayout.GlyphRow row) {
		var e = CBaseEntity.CreateByName("point_worldtext");
		if (e == null) return null;
		var m = PanelLayout.Default;
		var kv = new CEntityKeyValues();
		kv.SetString("targetname", Name);
		kv.SetString("message", row.Text);
		kv.SetBool("enabled", true);
		kv.SetBool("fullbright", true);
		kv.SetColor("color", (byte)(row.Color >> 16), (byte)(row.Color >> 8), (byte)row.Color, 255);
		kv.SetFloat("world_units_per_pixel", row.UnitsPerPixel);
		kv.SetFloat("font_size", m.FontSize);
		kv.SetInt("justify_horizontal", 1);
		kv.SetInt("justify_vertical", 1);
		kv.SetInt("reorient_mode", 0);
		kv.SetFloat("depth_render_offset", 0f);
		kv.SetBool("draw_background", false);
		kv.SetVector("origin", row.Origin);
		kv.SetVector("angles", row.Angles);
		e.Spawn(kv);
		e.Teleport(row.Origin, row.Angles, null);
		return e;
	}

}
