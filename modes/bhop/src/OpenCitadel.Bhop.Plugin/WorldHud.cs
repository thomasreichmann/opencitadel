using System.Numerics;
using DeadworksManaged.Api;

namespace OpenCitadel.Bhop.Plugin;

/// <summary>
/// The timer for players without Deadworks' client bootstrap, which the panorama <see cref="Hud"/>
/// needs: a few lines of world text above their hero, turned toward their camera and sent only to
/// them. Stock content only, so it works for players with nothing installed.
/// </summary>
internal sealed class WorldHud {
	public const string Name = "bhop_hud";
	/// <summary>How far above the hero's origin the text sits.</summary>
	private const float Height = 96f;

	private readonly Dictionary<int, (CBaseEntity Entity, string Text)> _texts = new();

	/// <summary>The text for a HUD state: time on top, speed under it.</summary>
	public static string Text(HudState s) {
		var lines = new List<string> { Hud.Headline(s), $"{(int)MathF.Round(s.Speed)} u/s" };
		if (s.Run == Timing.RunState.Running) lines.Add($"{s.Jumps} jumps  {s.SyncPercent}% sync");
		return string.Join("\n", lines);
	}

	public void Show(int slot, CCitadelPlayerPawn pawn, string text) {
		if (_texts.TryGetValue(slot, out var hud) && hud.Entity.IsValid) {
			if (hud.Text == text) return;
			hud.Entity.AcceptInput("SetMessage", hud.Entity, hud.Entity, text);
			_texts[slot] = (hud.Entity, text);
			return;
		}
		if (Create(pawn, text) is { } e) _texts[slot] = (e, text);
	}

	public void Remove(int slot) {
		if (!_texts.Remove(slot, out var hud)) return;
		if (hud.Entity.IsValid) hud.Entity.Remove();
	}

	/// <summary>Forgets every text; their entities are gone with the map (or removed here if not).</summary>
	public void Clear() {
		foreach (var e in Entities.ByName(Name).ToList()) e.Remove();
		_texts.Clear();
	}

	/// <summary>Everyone else's texts, which <paramref name="slot"/> isn't sent.</summary>
	public IEnumerable<CBaseEntity> OthersOf(int slot) {
		foreach (var (owner, hud) in _texts) {
			if (owner != slot && hud.Entity.IsValid) yield return hud.Entity;
		}
	}

	public bool Any => _texts.Count > 0;

	private static CBaseEntity? Create(CCitadelPlayerPawn pawn, string text) {
		var e = CBaseEntity.CreateByName("point_worldtext");
		if (e == null) return null;
		var at = pawn.Position + new Vector3(0, 0, Height);
		var angles = new Vector3(0, 0, 90); // standing up; reorient_mode turns it to the viewer
		var kv = new CEntityKeyValues();
		kv.SetString("targetname", Name);
		kv.SetString("message", text);
		kv.SetBool("enabled", true);
		kv.SetBool("fullbright", true);
		kv.SetColor("color", 255, 239, 215, 255);
		kv.SetFloat("world_units_per_pixel", 0.12f);
		kv.SetFloat("font_size", 64f);
		kv.SetInt("justify_horizontal", 1);
		kv.SetInt("justify_vertical", 0); // bottom: extra lines grow upward, away from the hero
		kv.SetInt("reorient_mode", 1);
		kv.SetFloat("depth_render_offset", 0f);
		kv.SetBool("draw_background", false);
		kv.SetVector("origin", at);
		kv.SetVector("angles", angles);
		e.Spawn(kv);
		e.Teleport(at, angles, null);
		e.SetParent(pawn);
		return e;
	}
}
