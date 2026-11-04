using System.IO.Compression;
using System.Numerics;
using System.Text.Json;
using System.Text.Json.Serialization;
using OpenCitadel.Bhop.Collision;

namespace OpenCitadel.Bhop.Map;

/// <summary>
/// Everything the bhop plugin needs to know about a ported map, beyond what Deadlock renders: the
/// original BSP brushes for exact collision, spawns, teleports, boosters, bhop blocks and timer
/// zones. Written by the porter next to the compiled map as &lt;map&gt;.bhop.json.gz.
/// </summary>
public sealed class BhopMapData {
	public const int CurrentFormat = 1;

	public int Format { get; set; } = CurrentFormat;
	public string Name { get; set; } = "";
	/// <summary>Where the map came from, e.g. "bhop_eazy.bsp (VBSP 20, revision 1)".</summary>
	public string Source { get; set; } = "";
	/// <summary>The original authors and anyone else to credit, shown to players.</summary>
	public List<string> Credits { get; set; } = new();

	public List<MapModel> Models { get; set; } = new();
	public List<MapSpawn> Spawns { get; set; } = new();
	public List<MapDestination> Destinations { get; set; } = new();
	public List<MapTrigger> Triggers { get; set; } = new();
	public List<MapZone> Zones { get; set; } = new();
	/// <summary>
	/// The map's visible surfaces as flat coloured rectangles, so the plugin can draw the map for
	/// players who don't have its package (see <see cref="PanelLayout"/>). Empty in older ports.
	/// </summary>
	public List<MapPanel> Panels { get; set; } = new();

	/// <summary>
	/// Moves the whole map: collision, triggers, destinations, spawns, zones and panels. The plugin
	/// uses it to put a map clear of the Deadlock map it is drawn into.
	/// </summary>
	public void Translate(Vector3 offset) {
		if (offset == Vector3.Zero) return;
		var o = Vec3.From(offset);
		// Brushes are stored relative to their model's or trigger's origin.
		foreach (var m in Models) m.Origin = m.Origin + o;
		foreach (var t in Triggers) {
			t.Origin = t.Origin + o;
			t.Mins = t.Mins + o;
			t.Maxs = t.Maxs + o;
		}
		foreach (var d in Destinations) d.Origin = d.Origin + o;
		foreach (var s in Spawns) s.Origin = s.Origin + o;
		foreach (var z in Zones) z.Translate(offset);
		foreach (var p in Panels) p.Origin = p.Origin + o;
	}

	/// <summary>The box around every brush of every model, or null for a map without brushes.</summary>
	public (Vector3 Mins, Vector3 Maxs)? Bounds() {
		var mins = new Vector3(float.MaxValue);
		var maxs = new Vector3(float.MinValue);
		var any = false;
		foreach (var m in Models) {
			var origin = m.Origin.ToVector3();
			foreach (var b in m.Brushes) {
				mins = Vector3.Min(mins, b.Mins.ToVector3() + origin);
				maxs = Vector3.Max(maxs, b.Maxs.ToVector3() + origin);
				any = true;
			}
		}
		return any ? (mins, maxs) : null;
	}

	/// <summary>A collision world of the solid models, ready for <see cref="Movement.CssMovement"/>.</summary>
	public CollisionWorld BuildCollisionWorld() {
		var world = new CollisionWorld();
		foreach (var m in Models) {
			if (!m.Solid || m.Brushes.Count == 0) continue;
			world.Add(new BrushModel(m.Id, m.Name.Length > 0 ? m.Name : m.ClassName, m.Brushes.Select(b => b.ToBrush()).ToList(), m.Origin.ToVector3()));
		}
		return world;
	}

	// ------------------------------------------------------------------ files

	public static readonly JsonSerializerOptions Json = new() {
		PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
		DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
		Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
	};

	public void Save(string path) {
		using var file = File.Create(path);
		using Stream stream = path.EndsWith(".gz", StringComparison.OrdinalIgnoreCase) ? new GZipStream(file, CompressionLevel.SmallestSize) : file;
		JsonSerializer.Serialize(stream, this, Json);
	}

	public static BhopMapData Load(string path) {
		using var file = File.OpenRead(path);
		return Load(file, path.EndsWith(".gz", StringComparison.OrdinalIgnoreCase), path);
	}

	public static BhopMapData Load(Stream input, bool gzip, string name) {
		using Stream stream = gzip ? new GZipStream(input, CompressionMode.Decompress, leaveOpen: true) : input;
		var data = JsonSerializer.Deserialize<BhopMapData>(stream, Json) ?? throw new InvalidDataException($"{name} is empty.");
		if (data.Format > CurrentFormat) throw new InvalidDataException($"{name} uses map format {data.Format}; this plugin reads up to {CurrentFormat}.");
		return data;
	}

	/// <summary>Where a ported map keeps its data inside its own map package.</summary>
	public static string PathInPackage(string map) => $"maps/{map}/bhop.json.gz";

	/// <summary>The map data inside a map package, or null when the package has none.</summary>
	public static BhopMapData? LoadFromPackage(string vpkPath, string map) {
		var bytes = Vpk.VpkArchive.Open(vpkPath).Read(PathInPackage(map));
		if (bytes == null) return null;
		using var ms = new MemoryStream(bytes);
		return Load(ms, gzip: true, $"{vpkPath}:{PathInPackage(map)}");
	}

	public byte[] ToGzipBytes() {
		using var ms = new MemoryStream();
		using (var gz = new GZipStream(ms, CompressionLevel.SmallestSize, leaveOpen: true)) JsonSerializer.Serialize(gz, this, Json);
		return ms.ToArray();
	}
}

/// <summary>A JSON-friendly vector.</summary>
public readonly record struct Vec3(float X, float Y, float Z) {
	public Vector3 ToVector3() => new(X, Y, Z);
	public static Vec3 From(Vector3 v) => new(v.X, v.Y, v.Z);
	public static Vec3 operator +(Vec3 a, Vec3 b) => new(a.X + b.X, a.Y + b.Y, a.Z + b.Z);
}

/// <summary>
/// A flat rectangle of one colour on a map's visible surface: the map as drawn for players without
/// its package. <see cref="U"/> × <see cref="V"/> points out of the surface, toward where it is seen from.
/// </summary>
public sealed class MapPanel {
	/// <summary>Centre of the rectangle.</summary>
	public Vec3 Origin { get; set; }
	/// <summary>Unit direction of the <see cref="Width"/> side.</summary>
	public Vec3 U { get; set; }
	/// <summary>Unit direction of the <see cref="Height"/> side.</summary>
	public Vec3 V { get; set; }
	public float Width { get; set; }
	public float Height { get; set; }
	/// <summary>sRGB colour as 0xRRGGBB, shading included.</summary>
	public int Color { get; set; }
}

/// <summary>A set of brushes: the world (id 0) or a brush entity.</summary>
public sealed class MapModel {
	public int Id { get; set; }
	public string ClassName { get; set; } = "";
	public string Name { get; set; } = "";
	public Vec3 Origin { get; set; }
	/// <summary>Whether players collide with it.</summary>
	public bool Solid { get; set; } = true;
	/// <summary>Set for doors and buttons that sink when stood on and drop players into a teleport.</summary>
	public BhopBlock? BhopBlock { get; set; }
	public List<MapBrush> Brushes { get; set; } = new();
}

/// <summary>A convex brush: contents and sides as [nx, ny, nz, dist, bevel] rows.</summary>
public sealed class MapBrush {
	public uint Contents { get; set; }
	public float[][] Sides { get; set; } = [];
	public Vec3 Mins { get; set; }
	public Vec3 Maxs { get; set; }

	public Brush ToBrush() => new(
		Sides.Select(s => new BrushSide(new Vector3(s[0], s[1], s[2]), s[3], s.Length > 4 && s[4] != 0)).ToArray(),
		(Contents)Contents, Mins.ToVector3(), Maxs.ToVector3());
}

/// <summary>A func_door or func_button bhop platform: it gives way after the player stands on it a moment.</summary>
public sealed class BhopBlock {
	/// <summary>Seconds a player may stand on it before it drops them.</summary>
	public float Delay { get; set; } = 0.1f;
	/// <summary>Where a player who stays too long ends up (the teleport under the block), if known.</summary>
	public string? Destination { get; set; }
}

public sealed class MapSpawn {
	public Vec3 Origin { get; set; }
	public Vec3 Angles { get; set; }
	public int Team { get; set; }
}

/// <summary>An info_teleport_destination (or any named target a teleport points at).</summary>
public sealed class MapDestination {
	public string Name { get; set; } = "";
	public Vec3 Origin { get; set; }
	public Vec3 Angles { get; set; }
}

public enum TriggerKind {
	/// <summary>trigger_teleport.</summary>
	Teleport,
	/// <summary>trigger_push: sets base velocity.</summary>
	Push,
	/// <summary>A gravity change (trigger_gravity or an AddOutput gravity booster).</summary>
	Gravity,
	/// <summary>Sets velocity directly. Only in data ported before outputs were modelled (now <see cref="Outputs"/>).</summary>
	Velocity,
	/// <summary>trigger_multiple / trigger_once: does nothing itself, only fires its <see cref="MapTrigger.Outputs"/>.</summary>
	Outputs,
}

/// <summary>
/// A filter_activator_name: the trigger only reacts to players whose targetname matches. Maps use
/// it for "multihop" platforms: touching a platform renames the player for one tick after a short
/// delay, and a teleport filtered on that name catches only players still standing there.
/// </summary>
public sealed class TriggerFilter {
	public string Name { get; set; } = "";
	public bool Negated { get; set; }

	/// <summary>Source's NameMatches: case-insensitive, with a trailing * as a wildcard.</summary>
	public bool Passes(string playerName) {
		var matches = Name.EndsWith('*')
			? playerName.StartsWith(Name[..^1], StringComparison.OrdinalIgnoreCase)
			: string.Equals(Name, playerName, StringComparison.OrdinalIgnoreCase);
		return matches != Negated;
	}
}

public enum OutputEvent { StartTouch, EndTouch, Trigger }

public enum OutputAction {
	/// <summary>!activator AddOutput "targetname X".</summary>
	SetName,
	/// <summary>!activator AddOutput "gravity X".</summary>
	SetGravity,
	/// <summary>!activator AddOutput "basevelocity X Y Z": a one-off kick on the player's next command.</summary>
	SetBaseVelocity,
	/// <summary>
	/// Points the teleports named <see cref="TriggerOutput.Text"/> at one of <see cref="TriggerOutput.Choices"/>,
	/// picked at random: a logic_case's PickRandom whose cases AddOutput "target X" to them.
	/// </summary>
	SetTeleportTarget,
}

/// <summary>An output that acts on the player who caused it (target !activator).</summary>
public sealed class TriggerOutput {
	public OutputEvent Event { get; set; }
	public OutputAction Action { get; set; }
	public string? Text { get; set; }
	public float Number { get; set; }
	public Vec3 Vector { get; set; }
	/// <summary>SetTeleportTarget: the destinations to pick from.</summary>
	public List<string>? Choices { get; set; }
	public float Delay { get; set; }
	/// <summary>How many times it may fire; -1 is unlimited.</summary>
	public int Times { get; set; } = -1;
}

/// <summary>A trigger volume and what it does to a player who touches it.</summary>
public sealed class MapTrigger {
	public TriggerKind Kind { get; set; }
	public int ModelId { get; set; }
	public string Name { get; set; } = "";
	public Vec3 Origin { get; set; }
	public bool StartDisabled { get; set; }
	public List<MapBrush> Brushes { get; set; } = new();
	public Vec3 Mins { get; set; }
	public Vec3 Maxs { get; set; }
	/// <summary>Teleport: name of the destination.</summary>
	public string? Target { get; set; }
	/// <summary>Teleport: keep the player's view angles (spawnflag), else take the destination's.</summary>
	public bool KeepAngles { get; set; }
	/// <summary>Push / Velocity: the velocity or push direction × speed.</summary>
	public Vec3 Vector { get; set; }
	/// <summary>Push: apply once on touch instead of every tick.</summary>
	public bool Once { get; set; }
	/// <summary>Gravity: the multiplier.</summary>
	public float Value { get; set; }
	/// <summary>Only players passing this filter touch the trigger.</summary>
	public TriggerFilter? Filter { get; set; }
	/// <summary>Seconds before OnTrigger can fire again (trigger_multiple; Source turns 0 into 0.2). Negative: once.</summary>
	public float Wait { get; set; } = 0.2f;
	public List<TriggerOutput> Outputs { get; set; } = new();
}

public enum ZoneKind {
	Start,
	End,
	/// <summary>A split time on entering (bhoptimer's stage zones).</summary>
	Checkpoint,
	Stage,
	/// <summary>Stops a running timer (bhoptimer's Zone_Stop).</summary>
	Stop,
	/// <summary>Players near the ground in the air are held up so they slide without friction (bhoptimer's Zone_Slide).</summary>
	Slide,
}

/// <summary>A timer zone: an axis-aligned box.</summary>
public sealed class MapZone {
	public ZoneKind Kind { get; set; }
	public int Index { get; set; }
	/// <summary>0 for the main course, 1 and up for bonuses.</summary>
	public int Track { get; set; }
	public Vec3 Mins { get; set; }
	public Vec3 Maxs { get; set; }
	/// <summary>Where players respawn for this zone (start / stage teleports).</summary>
	public Vec3? Teleport { get; set; }
	public float? TeleportYaw { get; set; }

	public void Translate(Vector3 offset) {
		var o = Vec3.From(offset);
		Mins = Mins + o;
		Maxs = Maxs + o;
		if (Teleport is { } t) Teleport = t + o;
	}
}
