using DeadworksManaged.Api;
using DeadworksManaged.Api.UI;
using OpenCitadel.Bhop.Movement;
using OpenCitadel.Bhop.Timing;

namespace OpenCitadel.Bhop.Plugin;

/// <summary>What the HUD shows for one player.</summary>
internal readonly record struct HudState(
	RunState Run, float Time, float Speed, int Jumps, int SyncPercent, float? PersonalBest, string? Record, string Style,
	MoveButtons Keys, string? Finished);

/// <summary>
/// The bhop HUD, drawn with Deadworks' panorama panels (players need the Deadworks client
/// bootstrap, which its launcher installs): a timer box under the crosshair in the style of CS:S
/// bhop servers, and a row of the movement keys being held.
/// </summary>
internal static class Hud {
	private const string Panel = "ocbhop_hud";
	private const string Text = "#FFEFD7";
	private const string Dim = "#FFEFD799";

	private static readonly (string Id, string Label, MoveButtons Key)[] KeyCaps = [
		("kW", "W", MoveButtons.Forward), ("kA", "A", MoveButtons.MoveLeft), ("kS", "S", MoveButtons.Back),
		("kD", "D", MoveButtons.MoveRight), ("kJ", "JUMP", MoveButtons.Jump), ("kC", "DUCK", MoveButtons.Duck),
	];

	public static bool Available(int slot) => UI.HasClientBootstrap(slot);

	public static void Build(CCitadelPlayerController controller) {
		var keys = UI.Horizontal("keys").WithStyles(("horizontal-align", "center"), ("margin-top", "6px"));
		foreach (var (id, label, _) in KeyCaps) {
			keys.Add(UI.Label(id, label).WithStyles(
				("font-size", "13px"), ("color", Text), ("opacity", "0.25"), ("margin", "0px 5px"),
				("padding", "2px 6px"), ("background-color", "#00000066"), ("border-radius", "3px")));
		}
		var root = UI.Vertical("box").WithStyles(
				("horizontal-align", "center"), ("vertical-align", "bottom"), ("margin-bottom", "210px"),
				("padding", "6px 18px 8px 18px"), ("background-color", "#0B0D12B0"), ("border-radius", "6px"),
				("min-width", "260px"))
			.Add(
				UI.Label("time", "").WithStyles(("font-size", "26px"), ("color", Text), ("horizontal-align", "center"), ("font-weight", "bold")),
				UI.Label("speed", "").WithStyles(("font-size", "18px"), ("color", Text), ("horizontal-align", "center")),
				UI.Label("line", "").WithStyles(("font-size", "13px"), ("color", Dim), ("horizontal-align", "center"), ("margin-top", "2px")),
				keys);
		UI.Panel(Panel).BuildLayout(controller.Recipients, root);
	}

	public static void Update(CCitadelPlayerController controller, HudState s, ref MoveButtons shownKeys) {
		var panel = UI.Panel(Panel);
		var to = controller.Recipients;
		panel.SetUnreliable(to, "time", Headline(s));
		panel.SetUnreliable(to, "speed", $"{(int)MathF.Round(s.Speed)} u/s");
		var parts = new List<string>();
		if (s.Run == RunState.Running) parts.Add($"Jumps {s.Jumps}  ·  Sync {s.SyncPercent}%");
		parts.Add($"PB {(s.PersonalBest is { } pb ? RecordStore.Format(pb) : "-")}  ·  WR {s.Record ?? "-"}");
		parts.Add(s.Style);
		panel.SetUnreliable(to, "line", string.Join("\n", parts));

		if (s.Keys != shownKeys) {
			foreach (var (id, _, key) in KeyCaps) {
				var down = (s.Keys & key) != 0;
				if (down == ((shownKeys & key) != 0)) continue;
				panel.SetStyles(to, id, ("opacity", down ? "1" : "0.25"), ("background-color", down ? "#E8B54ACC" : "#00000066"));
			}
			shownKeys = s.Keys;
		}
	}

	public static void Destroy(CCitadelPlayerController controller) => UI.Panel(Panel).DestroyLayout(controller.Recipients);

	/// <summary>The big line: the run's time, or where the player is in it.</summary>
	public static string Headline(HudState s) => s.Finished ?? s.Run switch {
		RunState.InStart => "Start Zone",
		RunState.Running => FormatLive(s.Time),
		_ => "No timer",
	};

	/// <summary>"0:12.34": centiseconds while running (the HUD updates ten times a second).</summary>
	internal static string FormatLive(float seconds) {
		var cs = (long)(seconds * 100);
		return $"{cs / 6000}:{cs / 100 % 60:00}.{cs % 100:00}";
	}
}
