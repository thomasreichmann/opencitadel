using System.Globalization;
using System.Numerics;
using OpenCitadel.Bhop.Collision;
using OpenCitadel.Bhop.Map;
using OpenCitadel.Bhop.Porter.Bsp;

namespace OpenCitadel.Bhop.Porter;

/// <summary>Turns a CS:S/CS:GO BSP into <see cref="BhopMapData"/>: collision, spawns, triggers.</summary>
public static class MapExtractor {
	/// <summary>Brush entities players collide with.</summary>
	private static readonly HashSet<string> SolidClasses = new(StringComparer.OrdinalIgnoreCase) {
		"func_wall", "func_wall_toggle", "func_brush", "func_breakable", "func_breakable_surf", "func_door",
		"func_door_rotating", "func_button", "func_rot_button", "func_movelinear", "func_rotating", "func_tracktrain",
		"func_train", "func_physbox", "func_physbox_multiplayer", "func_lookdoor", "func_tanktrain", "func_conveyor",
		"func_platrot", "func_plat", "momentary_rot_button", "func_guntarget",
	};

	public static BhopMapData Extract(BspFile bsp, string name, IEnumerable<string> credits) {
		var entities = BspEntity.ParseLump(bsp.EntityText);
		var data = new BhopMapData {
			Name = name,
			Source = $"{name}.bsp (VBSP {bsp.Version}, revision {bsp.MapRevision})",
			Credits = credits.ToList(),
		};

		// World collision: every brush of model 0.
		data.Models.Add(new MapModel {
			Id = 0, ClassName = "worldspawn", Name = "world",
			Brushes = bsp.BrushesOfModel(0).Select(i => ToMapBrush(bsp, i)).Where(b => b != null).Select(b => b!).ToList(),
		});

		var byName = entities.Where(e => e.TargetName.Length > 0).GroupBy(e => e.TargetName, StringComparer.OrdinalIgnoreCase)
			.ToDictionary(g => g.Key, g => g.First(), StringComparer.OrdinalIgnoreCase);
		var teleportTargets = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

		foreach (var e in entities) {
			var cls = e.ClassName;
			var model = e.BrushModel;
			if (model > 0 && model < bsp.Models.Length) {
				var brushes = bsp.BrushesOfModel(model).Select(i => ToMapBrush(bsp, i)).Where(b => b != null).Select(b => b!).ToList();
				if (brushes.Count == 0) continue;
				var origin = e.Origin;

				if (cls.StartsWith("trigger_", StringComparison.OrdinalIgnoreCase)) {
					var trigger = ToTrigger(e, model, brushes, origin, byName);
					if (trigger != null) {
						data.Triggers.Add(trigger);
						if (trigger.Target != null) teleportTargets.Add(trigger.Target);
						// Destinations map logic may point teleports at later.
						foreach (var o in trigger.Outputs) if (o.Choices != null) teleportTargets.UnionWith(o.Choices);
					}
					continue;
				}
				if (!SolidClasses.Contains(cls)) continue;
				if (cls.Equals("func_brush", StringComparison.OrdinalIgnoreCase) && e.Int("Solidity") == 1) continue; // never solid
				if (cls.Equals("func_rotating", StringComparison.OrdinalIgnoreCase) && (e.Int("spawnflags") & 64) != 0) continue; // not solid

				data.Models.Add(new MapModel {
					Id = model,
					ClassName = cls,
					Name = e.TargetName,
					Origin = Vec3.From(origin),
					Brushes = brushes,
				});
				continue;
			}

			switch (cls.ToLowerInvariant()) {
				case "info_player_terrorist":
				case "info_player_counterterrorist":
				case "info_player_start":
				case "info_player_deathmatch":
					data.Spawns.Add(new MapSpawn {
						Origin = Vec3.From(e.Origin), Angles = Vec3.From(e.Angles),
						Team = cls.Contains("counter", StringComparison.OrdinalIgnoreCase) ? 3 : 2,
					});
					break;
			}
		}

		// Destinations: whatever the teleports point at.
		foreach (var target in teleportTargets) {
			if (!byName.TryGetValue(target, out var e)) continue;
			data.Destinations.Add(new MapDestination { Name = target, Origin = Vec3.From(e.Origin), Angles = Vec3.From(e.Angles) });
		}

		MarkBhopBlocks(data);
		// What to draw for players without the map's package.
		data.Panels = Panels.PanelBuilder.Build(bsp).Panels;
		return data;
	}

	private static MapTrigger? ToTrigger(BspEntity e, int model, List<MapBrush> brushes, Vector3 origin, Dictionary<string, BspEntity> byName) {
		var (mins, maxs) = Bounds(brushes, origin);
		var t = new MapTrigger {
			ModelId = model,
			Name = e.TargetName,
			Origin = Vec3.From(origin),
			StartDisabled = e.Int("StartDisabled") != 0,
			Brushes = brushes,
			Mins = Vec3.From(mins),
			Maxs = Vec3.From(maxs),
			Outputs = ParseOutputs(e, byName),
		};
		var flags = e.Int("spawnflags", 1);
		if ((flags & 1) == 0 && (flags & 0x40) == 0) return null; // affects neither clients nor everything
		if (!ResolveFilter(e, byName, out var filter)) return null; // filtered so that players never pass
		t.Filter = filter;

		switch (e.ClassName.ToLowerInvariant()) {
			case "trigger_teleport":
				t.Kind = TriggerKind.Teleport;
				t.Target = e["target"];
				if (string.IsNullOrEmpty(t.Target)) return null;
				return t;
			case "trigger_push": {
				t.Kind = TriggerKind.Push;
				var dir = AnglesToForward(BspEntity.ParseVector(e["pushdir"]));
				t.Vector = Vec3.From(dir * e.Float("speed", 40f));
				t.Once = (flags & 0x80) != 0;
				return t;
			}
			case "trigger_gravity":
				t.Kind = TriggerKind.Gravity;
				t.Value = e.Float("gravity", 1f);
				return t;
			case "trigger_multiple":
			case "trigger_once":
				// Only their outputs do anything: renames for multihop platforms, gravity and
				// "basevelocity" boosters.
				if (t.Outputs.Count == 0) return null;
				t.Kind = TriggerKind.Outputs;
				// CTriggerOnce sets wait -1; CTriggerMultiple turns a wait of 0 into 0.2.
				var wait = e.Float("wait", 0f);
				t.Wait = e.ClassName.Equals("trigger_once", StringComparison.OrdinalIgnoreCase) ? -1f : wait == 0f ? 0.2f : wait;
				return t;
			default:
				return null;
		}
	}

	private static readonly (string Key, OutputEvent Event)[] OutputKeys = [
		("OnStartTouch", OutputEvent.StartTouch), ("OnEndTouch", OutputEvent.EndTouch), ("OnTrigger", OutputEvent.Trigger),
	];

	/// <summary>
	/// The outputs that act on the player who fired them: "!activator,AddOutput,targetname X|gravity X|basevelocity X Y Z,delay,times".
	/// </summary>
	/// <summary>An output's fields: "target,input,parameter,delay,times" (ESC-separated since the CS:GO era).</summary>
	private static string[] SplitOutput(string output) => output.Split(output.Contains('\u001b') ? '\u001b' : ',');

	public static List<TriggerOutput> ParseOutputs(BspEntity e, Dictionary<string, BspEntity>? byName = null) {
		var outputs = new List<TriggerOutput>();
		foreach (var (key, ev) in OutputKeys) {
			foreach (var output in e.All(key)) {
				var parts = SplitOutput(output);
				if (parts.Length < 2) continue;
				var target = parts[0].Trim();
				var input = parts[1].Trim();
				var delay = parts.Length > 3 && float.TryParse(parts[3], NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? MathF.Max(0f, d) : 0f;
				var times = parts.Length > 4 && int.TryParse(parts[4], NumberStyles.Integer, CultureInfo.InvariantCulture, out var n) ? n : -1;

				// Map logic that re-points teleports: a logic_case whose cases "AddOutput target X" to
				// them, picked at random (surf_utopia's jail cells).
				if (byName != null && (input.Equals("PickRandom", StringComparison.OrdinalIgnoreCase) || input.Equals("PickRandomShuffle", StringComparison.OrdinalIgnoreCase)) &&
				    byName.TryGetValue(target, out var logicCase) && logicCase.ClassName.Equals("logic_case", StringComparison.OrdinalIgnoreCase)) {
					foreach (var group in RetargetsOf(logicCase).GroupBy(r => r.Teleport, StringComparer.OrdinalIgnoreCase)) {
						outputs.Add(new TriggerOutput {
							Event = ev, Action = OutputAction.SetTeleportTarget, Text = group.Key,
							Choices = group.Select(r => r.Destination).Distinct(StringComparer.OrdinalIgnoreCase).ToList(), Delay = delay, Times = times,
						});
					}
					continue;
				}

				if (parts.Length < 3 || !input.Equals("AddOutput", StringComparison.OrdinalIgnoreCase)) continue;
				var arg = parts[2].Trim();
				var space = arg.IndexOf(' ');
				if (space <= 0) continue;
				var name = arg[..space];
				var value = arg[(space + 1)..].Trim();

				// A named entity's target changed directly ("teleport,AddOutput,target X").
				if (!target.Equals("!activator", StringComparison.OrdinalIgnoreCase)) {
					if (name.Equals("target", StringComparison.OrdinalIgnoreCase) && !target.StartsWith('!')) {
						outputs.Add(new TriggerOutput { Event = ev, Action = OutputAction.SetTeleportTarget, Text = target, Choices = [value], Delay = delay, Times = times });
					}
					continue;
				}

				var o = new TriggerOutput { Event = ev, Delay = delay, Times = times };
				switch (name.ToLowerInvariant()) {
					case "targetname":
						o.Action = OutputAction.SetName;
						o.Text = value;
						break;
					case "gravity" when float.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var g):
						o.Action = OutputAction.SetGravity;
						o.Number = g;
						break;
					case "basevelocity":
						o.Action = OutputAction.SetBaseVelocity;
						o.Vector = Vec3.From(BspEntity.ParseVector(value));
						break;
					default:
						continue;
				}
				outputs.Add(o);
			}
		}
		return outputs;
	}

	/// <summary>The "teleport,AddOutput,target X" outputs among a logic_case's OnCaseNN outputs.</summary>
	private static IEnumerable<(string Teleport, string Destination)> RetargetsOf(BspEntity logicCase) {
		foreach (var (key, value) in logicCase.Pairs) {
			if (!key.StartsWith("OnCase", StringComparison.OrdinalIgnoreCase)) continue;
			var parts = SplitOutput(value);
			if (parts.Length < 3 || !parts[1].Trim().Equals("AddOutput", StringComparison.OrdinalIgnoreCase)) continue;
			var arg = parts[2].Trim();
			if (!arg.StartsWith("target ", StringComparison.OrdinalIgnoreCase)) continue;
			yield return (parts[0].Trim(), arg[7..].Trim());
		}
	}

	/// <summary>
	/// The trigger's filter as far as players are concerned. Returns false when no player can ever
	/// pass it (the trigger is then left out); <paramref name="filter"/> is null when every player
	/// passes. Filters other than name and class let everyone through, as a missing filter does.
	/// </summary>
	private static bool ResolveFilter(BspEntity e, Dictionary<string, BspEntity> byName, out TriggerFilter? filter) {
		filter = null;
		var name = e["filtername"];
		if (string.IsNullOrEmpty(name) || !byName.TryGetValue(name, out var f)) return true;
		var negated = IsNegated(f["Negated"]);
		switch (f.ClassName.ToLowerInvariant()) {
			case "filter_activator_name":
				var wanted = f["filtername"] ?? "";
				if (wanted.Equals("!player", StringComparison.OrdinalIgnoreCase)) return !negated;
				filter = new TriggerFilter { Name = wanted, Negated = negated };
				return true;
			case "filter_activator_class":
				var isPlayer = (f["filterclass"] ?? "").Equals("player", StringComparison.OrdinalIgnoreCase);
				return isPlayer != negated;
			default:
				return true;
		}
	}

	/// <summary>"Negated" is 0/1, or the FGD's text in maps compiled from some editors.</summary>
	private static bool IsNegated(string? value) =>
		value != null && (value.Trim() == "1" || value.TrimStart().StartsWith("Disallow", StringComparison.OrdinalIgnoreCase));

	/// <summary>
	/// Doors and buttons that move down when touched, with a teleport underneath, are bhop blocks:
	/// stand on one too long and it drops you. They stay solid; the plugin does the dropping.
	/// </summary>
	private static void MarkBhopBlocks(BhopMapData data) {
		var teleports = data.Triggers.Where(t => t.Kind == TriggerKind.Teleport).ToList();
		foreach (var m in data.Models) {
			if (!m.ClassName.Equals("func_door", StringComparison.OrdinalIgnoreCase) &&
			    !m.ClassName.Equals("func_button", StringComparison.OrdinalIgnoreCase)) continue;
			var (mins, maxs) = Bounds(m.Brushes, m.Origin.ToVector3());
			MapTrigger? below = null;
			foreach (var t in teleports) {
				var tmins = t.Mins.ToVector3();
				var tmaxs = t.Maxs.ToVector3();
				var overlapsXY = tmins.X < maxs.X && tmaxs.X > mins.X && tmins.Y < maxs.Y && tmaxs.Y > mins.Y;
				if (overlapsXY && tmaxs.Z <= mins.Z + 1f && tmaxs.Z >= mins.Z - 512f) {
					if (below == null || tmaxs.Z > below.Maxs.Z) below = t;
				}
			}
			if (below != null) m.BhopBlock = new BhopBlock { Destination = below.Target };
		}
	}

	private static MapBrush? ToMapBrush(BspFile bsp, int index) {
		var b = bsp.Brushes[index];
		if (b.NumSides <= 0) return null;
		var sides = new float[b.NumSides][];
		var planes = new List<(Vector3, float)>();
		for (var i = 0; i < b.NumSides; i++) {
			var side = bsp.BrushSides[b.FirstSide + i];
			var plane = bsp.Planes[side.PlaneNum];
			sides[i] = [plane.Normal.X, plane.Normal.Y, plane.Normal.Z, plane.Dist, side.Bevel ? 1f : 0f];
			if (!side.Bevel) planes.Add((plane.Normal, plane.Dist));
		}
		// Bounds from the brush's actual polygon.
		var mins = new Vector3(float.MaxValue);
		var maxs = new Vector3(float.MinValue);
		foreach (var w in Winding.ForBrush(planes)) {
			foreach (var p in w) {
				mins = Vector3.Min(mins, p);
				maxs = Vector3.Max(maxs, p);
			}
		}
		if (mins.X > maxs.X) return null; // degenerate
		return new MapBrush { Contents = b.Contents, Sides = sides, Mins = Vec3.From(mins), Maxs = Vec3.From(maxs) };
	}

	private static (Vector3 Mins, Vector3 Maxs) Bounds(IEnumerable<MapBrush> brushes, Vector3 origin) {
		var mins = new Vector3(float.MaxValue);
		var maxs = new Vector3(float.MinValue);
		foreach (var b in brushes) {
			mins = Vector3.Min(mins, b.Mins.ToVector3());
			maxs = Vector3.Max(maxs, b.Maxs.ToVector3());
		}
		return (mins + origin, maxs + origin);
	}

	/// <summary>Source AngleVectors forward for (pitch, yaw, roll) in degrees.</summary>
	public static Vector3 AnglesToForward(Vector3 angles) {
		var (sp, cp) = MathF.SinCos(angles.X * MathF.PI / 180f);
		var (sy, cy) = MathF.SinCos(angles.Y * MathF.PI / 180f);
		return new Vector3(cp * cy, cp * sy, -sp);
	}
}
