using System.Numerics;
using OpenCitadel.Bhop.Map;

namespace OpenCitadel.Bhop.Tests;

/// <summary>Map panels as rows of full-block glyphs: every row inside its panel, together covering it.</summary>
public class PanelLayoutTests {
	private static readonly PanelLayout.GlyphMetrics M = PanelLayout.Default;

	/// <summary>Where a row's ink ends up: centre, direction along the row and up, length and height.</summary>
	private static (Vector3 Centre, Vector3 Along, Vector3 Up, float Length, float Height) Ink(PanelLayout.GlyphRow row) {
		var (forward, left, _) = PanelLayout.Axes(row.Angles);
		var s = row.UnitsPerPixel;
		return (row.Origin + forward * (M.InkAlong * s) + left * (M.InkUp * s), forward, left, row.Blocks * M.Advance * s, M.InkHeight * s);
	}

	private static MapPanel Panel(Vector3 centre, Vector3 u, Vector3 v, float w, float h) => new() {
		Origin = Vec3.From(centre), U = Vec3.From(u), V = Vec3.From(v), Width = w, Height = h, Color = 0x336699,
	};

	private static void AssertNear(Vector3 expected, Vector3 actual, float tolerance = 0.01f) =>
		Assert.True(Vector3.Distance(expected, actual) <= tolerance, $"expected {expected}, got {actual}");

	[Theory]
	[InlineData(1, 0, 0, 0, 0, 1)] // a wall facing -y, upright
	[InlineData(0, 1, 0, -1, 0, 0)] // a floor seen from above
	[InlineData(0, 0, 1, 1, 0, 0)] // straight up: Source's other branch
	[InlineData(0.6f, 0.8f, 0, 0, 0, -1)] // upside down
	public void AnglesRoundTrip(float fx, float fy, float fz, float lx, float ly, float lz) {
		var forward = Vector3.Normalize(new Vector3(fx, fy, fz));
		var left = Vector3.Normalize(new Vector3(lx, ly, lz));
		var (f, l, u) = PanelLayout.Axes(PanelLayout.Angles(forward, left));
		AssertNear(forward, f, 1e-4f);
		AssertNear(left, l, 1e-4f);
		AssertNear(Vector3.Cross(forward, left), u, 1e-4f);
	}

	[Fact]
	public void AWholeNumberOfBlocksIsOneRow() {
		// 64 tall: a block is 38/58.1 of that wide, so exactly 6 of them make this panel.
		var h = 64f;
		var w = 6 * M.Advance * h / M.InkHeight;
		var rows = PanelLayout.Rows(Panel(new Vector3(100, 200, 300), Vector3.UnitX, Vector3.UnitZ, w, h));
		var row = Assert.Single(rows);
		Assert.Equal(6, row.Blocks);
		var ink = Ink(row);
		AssertNear(new Vector3(100, 200, 300), ink.Centre);
		Assert.Equal(w, ink.Length, 0.01f);
		Assert.Equal(h, ink.Height, 0.01f);
		AssertNear(Vector3.UnitX, ink.Along, 1e-4f);
		AssertNear(Vector3.UnitZ, ink.Up, 1e-4f);
	}

	[Theory]
	[InlineData(256, 64)]
	[InlineData(100, 64)]
	[InlineData(70, 64)]
	[InlineData(2000, 16)]
	[InlineData(64, 256)] // tall: drawn along its height
	public void RowsCoverThePanelExactly(float w, float h) {
		var u = Vector3.UnitY;
		var v = Vector3.UnitZ;
		var centre = new Vector3(-500, 40, 1000);
		var rows = PanelLayout.Rows(Panel(centre, u, v, w, h));
		Assert.NotEmpty(rows);
		// Along the panel's long side: every row inside it, the first starting at one end and the
		// last ending at the other, with no gap between them.
		var (along, across, length, height) = w >= h ? (u, v, w, h) : (v, -u, h, w);
		var spans = rows.Select(r => {
			var ink = Ink(r);
			AssertNear(along, ink.Along, 1e-4f);
			// Exact, or a single row fitted to the length a hair off the height.
			Assert.InRange(ink.Height, height * (1 - M.HeightTolerance) - 0.01f, height * (1 + M.HeightTolerance) + 0.01f);
			Assert.Equal(0f, Vector3.Dot(ink.Centre - centre, across), 0.01f); // centred across the panel
			var mid = Vector3.Dot(ink.Centre - centre, along);
			return (Start: mid - ink.Length / 2, End: mid + ink.Length / 2);
		}).OrderBy(s => s.Start).ToList();
		Assert.All(spans, s => Assert.InRange(s.Start, -length / 2 - M.Tolerance, length / 2 + M.Tolerance));
		Assert.All(spans, s => Assert.InRange(s.End, -length / 2 - M.Tolerance, length / 2 + M.Tolerance));
		Assert.Equal(-length / 2, spans[0].Start, M.Tolerance);
		Assert.Equal(length / 2, spans.Max(s => s.End), M.Tolerance);
		for (var i = 1; i < spans.Count; i++) Assert.True(spans[i].Start <= spans[i - 1].End + 0.01f, "rows leave a gap");
	}

	[Fact]
	public void LongPanelsAreSplitToFitTheMessage() {
		var rows = PanelLayout.Rows(Panel(Vector3.Zero, Vector3.UnitX, Vector3.UnitY, 30000, 8));
		Assert.True(rows.Count > 1);
		Assert.All(rows, r => Assert.InRange(r.Blocks, 1, M.MaxBlocks));
		Assert.All(rows, r => Assert.True(System.Text.Encoding.UTF8.GetByteCount(r.Text) <= 511));
	}

	[Theory]
	[InlineData(1)]
	[InlineData(37)]
	[InlineData(160)]
	public void ARowCostsItsTextAndTheEstimatedRest(int blocks) {
		var row = new PanelLayout.GlyphRow(Vector3.Zero, Vector3.Zero, blocks, 1f, 0);
		// The text as sent: UTF-8 and its terminator.
		Assert.Equal(System.Text.Encoding.UTF8.GetByteCount(row.Text) + 1 + PanelLayout.RowOverhead, row.NetworkBytes);
	}

	[Fact]
	public void TheDefaultBudgetLeavesRoomForTheDeadlockMapAndPlayers() {
		// A joining player's first update is built in 1,280,000 bytes, and the Deadlock map's own
		// entities and every player's hero need their share (640 KiB was checked live, build 6844,
		// on the heaviest courses). Raising the default past 60% of the buffer needs checking again.
		Assert.InRange(PanelLayout.DefaultBudgetKilobytes * 1024, 1, 1_280_000 * 6 / 10);
	}
}
