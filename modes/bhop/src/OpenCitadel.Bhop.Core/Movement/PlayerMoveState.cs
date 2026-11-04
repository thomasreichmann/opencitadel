using System.Numerics;
using OpenCitadel.Bhop.Collision;

namespace OpenCitadel.Bhop.Movement;

/// <summary>Everything about a player that persists between movement ticks.</summary>
public sealed class PlayerMoveState {
	public Vector3 Origin;
	public Vector3 Velocity;
	/// <summary>Velocity added by triggers (trigger_push) or the ground, applied during the move only.</summary>
	public Vector3 BaseVelocity;
	/// <summary>
	/// A trigger_push renewed <see cref="BaseVelocity"/> this tick (FL_BASEVELOCITY). Without it, the
	/// next command turns the base velocity into a one-off kick, as leaving a push or a
	/// "basevelocity" output does in Source.
	/// </summary>
	public bool InBaseVelocityTrigger;
	/// <summary>Model id of what the player stands on, or -1 in the air.</summary>
	public int GroundEntity = -1;
	/// <summary>Plane normal of the ground, when on ground.</summary>
	public Vector3 GroundNormal;
	/// <summary>Buttons held during the previous tick, as movement tracks them.</summary>
	public MoveButtons OldButtons;
	/// <summary>Fully ducked: uses the duck hull (FL_DUCKING / m_bDucked).</summary>
	public bool Ducked;
	/// <summary>In the middle of a duck or unduck transition.</summary>
	public bool Ducking;
	/// <summary>Duck transition timer in milliseconds, counting down from 1000.</summary>
	public float DuckTimeMs;
	/// <summary>Surface friction, 1 on normal ground.</summary>
	public float SurfaceFriction = 1f;
	/// <summary>Speed a fall started with, for landing checks.</summary>
	public float FallVelocity;
	/// <summary>Game code moved the player since the last tick (a teleport): re-check the ground first.</summary>
	public bool GameCodeMovedPlayer = true;
	/// <summary>The player's own gravity multiplier (an entity's "gravity" key), 1 by default. 0 counts as 1, as in Source.</summary>
	public float GravityScale = 1f;
	/// <summary>How deep in water: 0 not, 1 feet, 2 waist, 3 eyes (m_nWaterLevel).</summary>
	public int WaterLevel;
	/// <summary>Contents of the water the player is in (water or slime).</summary>
	public Contents WaterType;
	/// <summary>Climbing out of water: milliseconds left (m_flWaterJumpTime) and the push.</summary>
	public float WaterJumpTime;
	public Vector3 WaterJumpVelocity;
	/// <summary>Climbing a ladder (MOVETYPE_LADDER), and the ladder surface's normal.</summary>
	public bool OnLadder;
	public Vector3 LadderNormal;

	public bool OnGround => GroundEntity >= 0;

	/// <summary>Current eye height above the origin.</summary>
	public float ViewHeight(MovementSettings s) => Ducked ? s.DuckViewHeight : s.ViewHeight;

	public PlayerMoveState Clone() => (PlayerMoveState)MemberwiseClone();

	/// <summary>Moves the player as game code would (spawn, teleport), keeping or clearing velocity.</summary>
	public void Teleport(Vector3 origin, Vector3? velocity = null) {
		Origin = origin;
		if (velocity is { } v) Velocity = v;
		BaseVelocity = Vector3.Zero;
		InBaseVelocityTrigger = false;
		GroundEntity = -1;
		GameCodeMovedPlayer = true;
	}
}
