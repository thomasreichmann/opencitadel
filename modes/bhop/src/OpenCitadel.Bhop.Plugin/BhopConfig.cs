using OpenCitadel.Bhop.Map;
using OpenCitadel.Bhop.Movement;

namespace OpenCitadel.Bhop.Plugin;

/// <summary>How player movement is produced.</summary>
public enum MovementMode {
	/// <summary>
	/// Counter-Strike: Source movement simulated by the plugin, tick for tick, with client prediction
	/// turned off. Exact, at the cost of seeing your own movement one round trip late.
	/// </summary>
	Exact,
	/// <summary>
	/// Deadlock's own movement, client-predicted, tuned toward CS:S with server convars and with
	/// Deadlock's extra moves disabled. Responsive, but only as close to CS:S as the convars allow.
	/// </summary>
	Native,
}

/// <summary>How exact mode moves the hero to the simulated position.</summary>
public enum ApplyMethod {
	/// <summary>
	/// Noclip with friction off, and a velocity that makes the engine's own move land on the
	/// simulated position. Keeps the engine's interpolation, so it looks smooth.
	/// </summary>
	NoclipVelocity,
	/// <summary>Freeze the hero and teleport it every tick. Simple, but resets interpolation each tick.</summary>
	Teleport,
}

/// <summary>Plugin settings, read from configs/BhopPlugin/BhopPlugin.jsonc.</summary>
public sealed class BhopConfig {
	public MovementMode Mode { get; set; } = MovementMode.Exact;
	public ApplyMethod ApplyMethod { get; set; } = ApplyMethod.NoclipVelocity;

	/// <summary>Put the camera in the hero's head, as in Counter-Strike.</summary>
	public bool FirstPerson { get; set; } = true;

	/// <summary>Movement values for exact mode; anything left out keeps the CS:S bhop default.</summary>
	public MovementOverrides Movement { get; set; } = new();

	/// <summary>
	/// Movement for maps whose name starts with a prefix, on top of <see cref="Movement"/>. Surf
	/// servers run air acceleration around 150; bhop's 1000 makes ramps feel wrong.
	/// </summary>
	public Dictionary<string, MovementOverrides> MapMovement { get; set; } = new() {
		["surf_"] = new MovementOverrides { AirAccelerate = 150 },
	};

	/// <summary>Extra convars set when a map starts (after the mode's own).</summary>
	public Dictionary<string, string> ConVars { get; set; } = new();

	/// <summary>
	/// Folder of ported map data (&lt;map&gt;.bhop.json.gz, written by citadel-port), relative to the
	/// server's working directory (game/bin/win64).
	/// </summary>
	public string MapDataDir { get; set; } = "configs/BhopPlugin/maps";

	/// <summary>Deadlock's game folder, relative to the server's working directory (game/bin/win64).</summary>
	public string GameDir { get; set; } = "../..";

	/// <summary>Thickness of the beams outlining timer zones (0 hides them).</summary>
	public float ZoneBeamWidth { get; set; } = 2f;

	/// <summary>
	/// The course to run when the server starts on a map that isn't a ported one (a stock Deadlock
	/// map), so players need nothing but the game: the course is drawn with stock content (see
	/// <see cref="DrawCourses"/>). Empty: no course, Deadlock's own map. Changed live with dw_bhopmap.
	/// </summary>
	public string Course { get; set; } = "";

	/// <summary>
	/// Draw courses with stock content (flat coloured panels from point_worldtext entities) when they
	/// run on a Deadlock map rather than their own package. Clients then need nothing installed.
	/// </summary>
	public bool DrawCourses { get; set; } = true;

	/// <summary>
	/// A course drawn into a Deadlock map is moved clear of that map's own geometry, by at least this
	/// much (as far as the part of the world clients draw allows; see CoursePlacement).
	/// </summary>
	public float CourseMargin { get; set; } = 1000f;

	/// <summary>
	/// Panel entities spawned per server frame while a course is being drawn (and four times as many
	/// removed). Players get each frame's creations in one update, which has a size limit, and every
	/// one costs their client work: slower PCs fall behind when too many arrive at once.
	/// </summary>
	public int PanelsPerFrame { get; set; } = 30;

	/// <summary>
	/// Seconds after a player joins, or the course changes, before a streamed course draws its details
	/// around them. Their client is still taking in the course's first update; players on slower PCs
	/// who were sent a thousand more panels on top of it fell behind, were sent everything again by the
	/// server, and timed out.
	/// </summary>
	public float DetailDelaySeconds { get; set; } = 10f;

	/// <summary>
	/// The most a drawn course may send a player at once, in KiB (1024 bytes; counted as described
	/// at PanelLayout.GlyphRow.NetworkBytes). A player who joins gets everything they can see in one
	/// update, built in a fixed buffer of 1,280,000 bytes (1250 KiB) that the Deadlock map's own
	/// entities and the players share; when it overflows the server drops the player
	/// (NETWORK_DISCONNECT_DELTAENTMSG_OVERFLOW). A course needing more is streamed (see
	/// <see cref="DetailRadius"/>).
	/// </summary>
	public int MaxPanelKilobytes { get; set; } = PanelLayout.DefaultBudgetKilobytes;

	/// <summary>
	/// The most panel entities a drawn course may use: the server has a fixed number of networked
	/// entities, shared with everything else, and each one adds to a joining player's first update
	/// however small it is (the bytes per row beyond its text are an estimate; this bounds the error).
	/// A course needing more is streamed (see <see cref="DetailRadius"/>).
	/// </summary>
	public int MaxPanelEntities { get; set; } = 8000;

	/// <summary>Of a streamed course's budgets, the share drawn all the time: its largest panels.</summary>
	public float FixedPanelShare { get; set; } = 0.6f;

	/// <summary>How far from players the smaller details of a streamed course are drawn.</summary>
	public float DetailRadius { get; set; } = 3000f;

	/// <summary>
	/// Drawn panels show from both sides and Deadlock's third-person camera passes through them, so
	/// each player stops seeing the backs of panels within this distance of their camera (0: off).
	/// </summary>
	public float BackFaceRadius { get; set; } = 450f;

	/// <summary>Where Deadlock puts the third-person camera: behind the eyes, and over the right shoulder.</summary>
	public float CameraBehind { get; set; } = 150f;
	public float CameraRight { get; set; } = 30f;

	/// <summary>Log every simulated tick to the server console (noisy; for testing).</summary>
	public bool LogMovement { get; set; }
}

/// <summary>Optional overrides of <see cref="MovementSettings"/>.</summary>
public sealed class MovementOverrides {
	public float? Gravity { get; set; }
	public float? Accelerate { get; set; }
	public float? AirAccelerate { get; set; }
	public float? Friction { get; set; }
	public float? StopSpeed { get; set; }
	public float? RunSpeed { get; set; }
	public float? MaxVelocity { get; set; }
	public bool? AutoBhop { get; set; }

	public MovementSettings Apply(MovementSettings s) => s with {
		Gravity = Gravity ?? s.Gravity,
		Accelerate = Accelerate ?? s.Accelerate,
		AirAccelerate = AirAccelerate ?? s.AirAccelerate,
		Friction = Friction ?? s.Friction,
		StopSpeed = StopSpeed ?? s.StopSpeed,
		RunSpeed = RunSpeed ?? s.RunSpeed,
		MaxVelocity = MaxVelocity ?? s.MaxVelocity,
		AutoBhop = AutoBhop ?? s.AutoBhop,
	};
}
