using System.Numerics;

namespace OpenCitadel.Bhop.Movement;

/// <summary>
/// Movement parameters. Defaults are Counter-Strike: Source's engine values with the settings a
/// standard CS:S bhop server uses on top (bhoptimer's "Normal" style: autobhop, no stamina,
/// sv_airaccelerate 1000).
/// </summary>
public sealed record MovementSettings {
	/// <summary>sv_gravity.</summary>
	public float Gravity { get; init; } = 800f;
	/// <summary>sv_accelerate (CS:S default 5).</summary>
	public float Accelerate { get; init; } = 5f;
	/// <summary>sv_airaccelerate (CS:S default 10; bhop servers use 1000, or 100 for scroll styles).</summary>
	public float AirAccelerate { get; init; } = 1000f;
	/// <summary>sv_friction.</summary>
	public float Friction { get; init; } = 4f;
	/// <summary>sv_stopspeed (CS:S default 75).</summary>
	public float StopSpeed { get; init; } = 75f;
	/// <summary>Player run speed: the held weapon's max speed (knife 250).</summary>
	public float RunSpeed { get; init; } = 250f;
	/// <summary>sv_maxspeed, which caps <see cref="RunSpeed"/>.</summary>
	public float MaxSpeed { get; init; } = 320f;
	/// <summary>sv_maxvelocity: the per-axis velocity clamp.</summary>
	public float MaxVelocity { get; init; } = 3500f;
	/// <summary>sv_stepsize.</summary>
	public float StepSize { get; init; } = 18f;
	/// <summary>sv_bounce.</summary>
	public float Bounce { get; init; } = 0f;
	/// <summary>The cap on wish speed used for air acceleration (GetAirSpeedCap).</summary>
	public float AirSpeedCap { get; init; } = 30f;
	/// <summary>Upward speed of a jump: sqrt(2 × 800 × 57), as CS:S hard-codes it.</summary>
	public float JumpImpulse { get; init; } = MathF.Sqrt(2f * 800f * 57f);
	/// <summary>Speed multiplier while ducking (DUCK_SPEED_MULTIPLIER).</summary>
	public float DuckSpeedMultiplier { get; init; } = 0.34f;
	/// <summary>Seconds a duck takes on the ground (TIME_TO_DUCK).</summary>
	public float TimeToDuck { get; init; } = 0.4f;
	/// <summary>Seconds an unduck takes on the ground (TIME_TO_UNDUCK).</summary>
	public float TimeToUnduck { get; init; } = 0.2f;
	/// <summary>Holding jump jumps again on landing (bhop servers' autobhop).</summary>
	public bool AutoBhop { get; init; } = true;
	/// <summary>cl_forwardspeed / cl_sidespeed: the speed a full key press asks for.</summary>
	public float InputSpeed { get; init; } = 400f;

	/// <summary>Standing hull (CS:S: 32 × 32 × 62).</summary>
	public Vector3 HullMins { get; init; } = new(-16, -16, 0);
	public Vector3 HullMaxs { get; init; } = new(16, 16, 62);
	/// <summary>Ducked hull (CS:S: 32 × 32 × 45).</summary>
	public Vector3 DuckHullMins { get; init; } = new(-16, -16, 0);
	public Vector3 DuckHullMaxs { get; init; } = new(16, 16, 45);
	/// <summary>Eye heights, for cameras.</summary>
	public float ViewHeight { get; init; } = 64f;
	public float DuckViewHeight { get; init; } = 47f;

	public static MovementSettings CounterStrikeSource { get; } = new();
}
