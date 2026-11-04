using System.Numerics;

namespace OpenCitadel.Bhop.Map;

/// <summary>
/// How a <see cref="MapPanel"/> is drawn with nothing but what every Deadlock install has: rows of
/// full-block glyphs (█, U+2588) in point_worldtext entities, without their background.
/// </summary>
/// <remarks>
/// <para>
/// A point_worldtext draws its text with a stock font, sized by font_size and scaled to the world
/// by world_units_per_pixel. A full block's ink is a solid rectangle in the text colour, so a row
/// of them is a flat rectangle of any colour, drawn fullbright and depth-tested like any model. Its
/// height follows the scale continuously; its length comes in whole blocks, so a row that doesn't
/// fit a whole number of blocks is drawn as two rows, one from each end, overlapping in the middle
/// (in the same colour and plane, where the overlap can't be seen).
/// </para>
/// <para>
/// The text background (draw_background) can't be used instead: Deadlock draws half of its quads
/// with the other winding, so from either side half of it is culled, and with it on the glyph cells
/// turn opaque black where they have no ink. Whitespace-only text draws nothing at all, and the
/// entity is culled by the size of its text on screen, so the text must span the panel.
/// </para>
/// </remarks>
public static class PanelLayout {
	/// <summary>The full block, U+2588.</summary>
	public const char Block = '█';

	/// <summary>
	/// Where the ink of a row of full blocks lands, at a font size where the stock font's metrics
	/// were measured in game (Deadlock build 6844): per world unit per pixel, a block advances
	/// <see cref="Advance"/> along the row and is <see cref="InkHeight"/> tall, and the ink's centre
	/// sits <see cref="InkAlong"/> along the row and <see cref="InkUp"/> up from the entity's origin
	/// (text justified to the centre both ways).
	/// </summary>
	public sealed record GlyphMetrics {
		public float FontSize { get; init; } = 64f;
		public float Advance { get; init; } = 38f;
		public float InkHeight { get; init; } = 58.1f;
		public float InkAlong { get; init; } = 1.4f;
		public float InkUp { get; init; } = -2.73f;
		/// <summary>Blocks per row: the message holds 511 bytes and a block takes 3 in UTF-8.</summary>
		public int MaxBlocks { get; init; } = 160;
		/// <summary>A row that misses the panel's length by no more than this (world units) is drawn alone.</summary>
		public float Tolerance { get; init; } = 0.25f;
		/// <summary>
		/// Or, a row that fits the length exactly may be this much (a fraction of the height) too tall
		/// or too short: a hair past the panel's edge isn't seen, and it saves a second row.
		/// </summary>
		public float HeightTolerance { get; init; } = 0.025f;
	}

	/// <summary>
	/// One point_worldtext: a row of <see cref="Blocks"/> full blocks. <see cref="Normal"/> is the
	/// panel's (its seen side): glyphs draw from both sides, so the plugin culls back faces itself.
	/// </summary>
	public readonly record struct GlyphRow(Vector3 Origin, Vector3 Angles, int Blocks, float UnitsPerPixel, int Color, Vector3 Normal = default) {
		public string Text => new(Block, Blocks);

		/// <summary>
		/// What sending this row to a player costs, before compression: the text (3 bytes a block in
		/// UTF-8, and its terminator) plus <see cref="RowOverhead"/> for the rest of the entity.
		/// </summary>
		public int NetworkBytes => Blocks * 3 + 1 + RowOverhead;
	}

	/// <summary>
	/// An estimate of what a new point_worldtext costs in a player's update besides its text: its
	/// header (index, class, serial) and the fields that differ from its class's baseline (position,
	/// angles, colour, scale, field paths). Generous, as the budget it feeds must not be exceeded.
	/// </summary>
	public const int RowOverhead = 64;

	/// <summary>
	/// How much of a course (in <see cref="GlyphRow.NetworkBytes"/>, KiB) a server draws at once by
	/// default. A joining player is sent everything they can see in one update, which Deadlock builds
	/// in a 1,280,000-byte buffer (1250 KiB) shared with the Deadlock map's own entities and the
	/// players; past it the server drops the player. A course needing more is drawn in part: its
	/// largest panels, and the rest near players.
	/// </summary>
	public const int DefaultBudgetKilobytes = 640;

	public static readonly GlyphMetrics Default = new();

	/// <summary>The rows that draw a panel.</summary>
	public static List<GlyphRow> Rows(MapPanel panel, GlyphMetrics? metrics = null) {
		var m = metrics ?? Default;
		var rows = new List<GlyphRow>();
		var u = panel.U.ToVector3();
		var v = panel.V.ToVector3();
		var w = panel.Width;
		var h = panel.Height;
		if (w <= 0.01f || h <= 0.01f) return rows;
		// Rows run along the long side: the block's height sets the short one exactly.
		if (w < h) (u, v, w, h) = (v, -u, h, w);
		Add(rows, panel.Origin.ToVector3(), u, v, w, h, panel.Color, m);
		return rows;
	}

	private static void Add(List<GlyphRow> rows, Vector3 centre, Vector3 u, Vector3 v, float w, float h, int color, GlyphMetrics m) {
		var scale = h / m.InkHeight;
		var cell = m.Advance * scale;
		var cells = w / cell;
		if (cells > m.MaxBlocks) {
			// Too long for one message: equal pieces end to end.
			var pieces = (int)MathF.Ceiling(cells / m.MaxBlocks);
			var piece = w / pieces;
			for (var i = 0; i < pieces; i++) Add(rows, centre + u * (-w / 2 + piece * (i + 0.5f)), u, v, piece, h, color, m);
			return;
		}
		var angles = Angles(u, v);
		var whole = (int)MathF.Round(cells);
		if (whole >= 1 && MathF.Abs(whole * cell - w) <= m.Tolerance) {
			rows.Add(Row(centre, u, v, whole, scale, angles, color, m));
			return;
		}
		// Exactly the length with a whole number of blocks, at a height just off the panel's.
		foreach (var blocks in (int[])[(int)MathF.Floor(cells), (int)MathF.Ceiling(cells)]) {
			if (blocks < 1) continue;
			var fitted = w / (blocks * m.Advance);
			if (MathF.Abs(fitted * m.InkHeight - h) <= m.HeightTolerance * h) {
				rows.Add(Row(centre, u, v, blocks, fitted, angles, color, m));
				return;
			}
		}
		// A whole number of blocks doesn't fit: one row from each end. Each is at most the panel's
		// length (cells ≥ 1.5, as w ≥ h and a block is 0.65 of its height wide), together they cover it.
		var n = Math.Max(1, (int)MathF.Ceiling(cells / 2));
		var len = n * cell;
		rows.Add(Row(centre + u * (-w / 2 + len / 2), u, v, n, scale, angles, color, m));
		rows.Add(Row(centre + u * (w / 2 - len / 2), u, v, n, scale, angles, color, m));
	}

	private static GlyphRow Row(Vector3 inkCentre, Vector3 u, Vector3 v, int blocks, float scale, Vector3 angles, int color, GlyphMetrics m) =>
		new(inkCentre - u * (m.InkAlong * scale) - v * (m.InkUp * scale), angles, blocks, scale, color, Vector3.Cross(u, v));

	/// <summary>
	/// Source's MatrixAngles: the pitch, yaw and roll of an entity whose forward (local x) is
	/// <paramref name="forward"/> and whose left (local y) is <paramref name="left"/>. Text reads
	/// along forward with its top toward left.
	/// </summary>
	public static Vector3 Angles(Vector3 forward, Vector3 left) {
		var up = Vector3.Cross(forward, left);
		var xy = MathF.Sqrt(forward.X * forward.X + forward.Y * forward.Y);
		const float deg = 180f / MathF.PI;
		return xy > 0.001f
			? new Vector3(MathF.Atan2(-forward.Z, xy) * deg, MathF.Atan2(forward.Y, forward.X) * deg, MathF.Atan2(left.Z, up.Z) * deg)
			: new Vector3(MathF.Atan2(-forward.Z, xy) * deg, MathF.Atan2(-left.X, left.Y) * deg, 0f);
	}

	/// <summary>Source's AngleVectors: forward, left and up of the given pitch, yaw and roll (degrees).</summary>
	public static (Vector3 Forward, Vector3 Left, Vector3 Up) Axes(Vector3 angles) {
		const float rad = MathF.PI / 180f;
		var (sp, cp) = MathF.SinCos(angles.X * rad);
		var (sy, cy) = MathF.SinCos(angles.Y * rad);
		var (sr, cr) = MathF.SinCos(angles.Z * rad);
		var forward = new Vector3(cp * cy, cp * sy, -sp);
		var right = new Vector3(-sr * sp * cy + cr * sy, -sr * sp * sy - cr * cy, -sr * cp);
		var up = new Vector3(cr * sp * cy + sr * sy, cr * sp * sy - sr * cy, cr * cp);
		return (forward, -right, up);
	}
}
