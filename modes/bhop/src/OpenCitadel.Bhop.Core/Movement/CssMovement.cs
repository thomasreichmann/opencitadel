using System.Numerics;
using OpenCitadel.Bhop.Collision;

namespace OpenCitadel.Bhop.Movement;

/// <summary>What happened during one movement tick.</summary>
public readonly record struct MoveResult(bool Jumped, bool Landed, IReadOnlyList<int> Touched);

/// <summary>
/// Counter-Strike: Source player movement (CGameMovement with CCSGameMovement's overrides), tick for
/// tick. This is an independent implementation of the algorithm, written to reproduce its results
/// exactly, including the quirks that shape bhop: friction is skipped on the tick a held jump fires,
/// gravity is applied in two halves around the move (and twice on the jump tick), air acceleration
/// is capped at a 30 u/s wish speed, ducking in the air lifts the feet, and with
/// sv_optimizedmovement the ground is only re-checked at the end of a tick.
///
/// Not implemented yet: water, ladders, stamina (bhop servers disable it), fall damage and moving
/// ground entities (all ground is treated as static).
/// </summary>
public sealed class CssMovement {
	private const float NonJumpVelocity = 140f;
	private const float CoordResolution = 1f / 32f;
	private const float DistEpsilon = 0.03125f;
	private const int MaxClipPlanes = 5;

	public MovementSettings Settings { get; set; }
	public ITraceWorld World { get; set; }
	public Contents SolidMask { get; set; } = ContentsMask.PlayerSolid;

	// Per-tick state (Source's CMoveData plus locals).
	private PlayerMoveState _p = null!;
	private float _dt;
	private float _forwardMove, _sideMove;
	private float _maxSpeed;
	private MoveButtons _buttons;
	private Vector3 _viewAngles;
	private bool _speedCroppedDuck;
	private bool _jumped;
	private Vector3 _forward, _right;
	private int _oldWaterLevel;
	private readonly List<int> _touched = new();

	public CssMovement(MovementSettings settings, ITraceWorld world) {
		Settings = settings;
		World = world;
	}

	/// <summary>Runs one tick of movement for a player, updating <paramref name="player"/> in place.</summary>
	public MoveResult Simulate(PlayerMoveState player, in MoveInput input) {
		_p = player;
		_dt = input.FrameTime;
		_forwardMove = input.ForwardMove;
		_sideMove = input.SideMove;
		_buttons = input.Buttons;
		_viewAngles = input.ViewAngles;
		_speedCroppedDuck = false;
		_jumped = false;
		_touched.Clear();
		var wasOnGround = _p.OnGround;

		// CPlayerMove::CheckMovingGround: base velocity that no trigger_push renewed since the last
		// command becomes a velocity kick (with half a frame of extra momentum) and is cleared.
		if (!_p.InBaseVelocityTrigger && _p.BaseVelocity != Vector3.Zero) {
			_p.Velocity += (1f + _dt * 0.5f) * _p.BaseVelocity;
			_p.BaseVelocity = Vector3.Zero;
		}
		_p.InBaseVelocityTrigger = false;

		// Autobhop as bhoptimer does it: while walking (not climbing a ladder or swimming), holding jump
		// forgets it was held the tick before, so landing counts as a fresh press. Ladders and water
		// keep normal jump handling: holding jump jumps off a ladder and swims up.
		if (Settings.AutoBhop && (_buttons & MoveButtons.Jump) != 0 && !_p.OnLadder && _p.WaterLevel < 2) {
			_p.OldButtons &= ~MoveButtons.Jump;
		}

		PlayerMove();
		_p.GameCodeMovedPlayer = false;

		return new MoveResult(_jumped, !wasOnGround && _p.OnGround, _touched.ToArray());
	}

	/// <summary>
	/// Frees a player whose box starts inside something, as Source's CheckStuck does after spawns and
	/// teleports: tries small offsets, nearest first, and settles onto the ground beneath if possible.
	/// Returns false when no nearby free spot exists.
	/// </summary>
	public bool Unstick(PlayerMoveState player) {
		_p = player;
		if (!TestPlayerPosition(_p.Origin)) return true;

		// Up first (the common case: spawned with the feet in the floor), then sideways.
		for (var dz = 1; dz <= 36; dz++) {
			var candidate = _p.Origin + new Vector3(0, 0, dz);
			if (!TestPlayerPosition(candidate)) {
				_p.Origin = candidate;
				var down = TracePlayerBBox(candidate, candidate - new Vector3(0, 0, dz + 1));
				if (!down.StartSolid) _p.Origin = down.EndPos;
				return true;
			}
		}
		for (var r = 1; r <= 16; r++) {
			foreach (var dir in (ReadOnlySpan<Vector3>)[Vector3.UnitX, -Vector3.UnitX, Vector3.UnitY, -Vector3.UnitY]) {
				var candidate = _p.Origin + dir * r;
				if (!TestPlayerPosition(candidate)) {
					_p.Origin = candidate;
					return true;
				}
			}
		}
		return false;
	}

	// ---------------------------------------------------------------- top level

	private void PlayerMove() {
		CheckParameters();
		ReduceTimers();
		AngleVectors(_viewAngles, out _forward, out _right);

		// With sv_optimizedmovement (on by default) a walking player keeps the ground state from the
		// end of the previous tick; it's only re-checked after game code moved them, or on a ladder.
		if (_p.OnLadder || _p.GameCodeMovedPlayer) {
			CategorizePosition();
		} else if (_p.Velocity.Z > 250f) {
			SetGroundEntity(null);
		}

		_oldWaterLevel = _p.WaterLevel;
		if (!_p.OnGround) _p.FallVelocity = -_p.Velocity.Z;

		Duck();

		// Off a ladder once no ladder is in reach; the next tick re-attaches if one is.
		if (!LadderMove() && _p.OnLadder) _p.OnLadder = false;

		if (_p.OnLadder) FullLadderMove();
		else FullWalkMove();
	}

	private void CheckParameters() {
		_maxSpeed = MathF.Min(Settings.RunSpeed, Settings.MaxSpeed);
		var spd = _forwardMove * _forwardMove + _sideMove * _sideMove;
		if (spd != 0f && spd > _maxSpeed * _maxSpeed) {
			var ratio = _maxSpeed / MathF.Sqrt(spd);
			_forwardMove *= ratio;
			_sideMove *= ratio;
		}
	}

	private void ReduceTimers() {
		var frameMsec = 1000f * _dt;
		if (_p.DuckTimeMs > 0) {
			_p.DuckTimeMs -= frameMsec;
			if (_p.DuckTimeMs < 0) _p.DuckTimeMs = 0;
		}
	}

	private void FullWalkMove() {
		if (!CheckWater()) StartGravity();

		// Leaping out of the water: just carry on with the push.
		if (_p.WaterJumpTime != 0f) {
			WaterJump();
			TryPlayerMove(null, null);
			CheckWater();
			return;
		}

		if (_p.WaterLevel >= 2) {
			// Swimming. At the surface, nudging against a ledge starts a jump out of the water.
			if (_p.WaterLevel == 2) CheckWaterJump();
			if (_p.Velocity.Z < 0f && _p.WaterJumpTime != 0f) _p.WaterJumpTime = 0f;

			if ((_buttons & MoveButtons.Jump) != 0) CheckJumpButton();
			else _p.OldButtons &= ~MoveButtons.Jump;

			WaterMove();
			CategorizePosition();
			if (_p.OnGround) _p.Velocity.Z = 0f;
			return;
		}

		if ((_buttons & MoveButtons.Jump) != 0) {
			CheckJumpButton();
		} else {
			_p.OldButtons &= ~MoveButtons.Jump;
		}

		// Friction comes before base velocity is added, so a conveyor doesn't slow a player down.
		if (_p.OnGround) {
			_p.Velocity.Z = 0f;
			Friction();
		}

		CheckVelocity();

		if (_p.OnGround) WalkMove();
		else AirMove();

		CategorizePosition();
		CheckVelocity();
		if (!CheckWater()) FinishGravity();

		if (_p.OnGround) _p.Velocity.Z = 0f;
	}

	// ---------------------------------------------------------------- water

	private const Contents MaskWater = Contents.Water | Contents.Moveable | Contents.Slime;

	/// <summary>What the world holds at a point (enginetrace->GetPointContents).</summary>
	private Contents PointContents(Vector3 point, Contents mask) {
		var t = World.TraceHull(point, point, Vector3.Zero, Vector3.Zero, mask);
		return t.StartSolid || t.AllSolid ? t.Contents : Contents.Empty;
	}

	/// <summary>
	/// CGameMovement::CheckWater: how deep the player is, tested at the feet, the middle of the box
	/// and the eyes. Returns true when the water is above the feet (no gravity then).
	/// </summary>
	private bool CheckWater() {
		var mins = PlayerMins;
		var maxs = PlayerMaxs;
		var point = new Vector3(_p.Origin.X + (mins.X + maxs.X) * 0.5f, _p.Origin.Y + (mins.Y + maxs.Y) * 0.5f, _p.Origin.Z + mins.Z + 1f);
		_p.WaterLevel = 0;
		_p.WaterType = Contents.Empty;

		var cont = PointContents(point, MaskWater);
		if ((cont & MaskWater) != 0) {
			_p.WaterType = cont;
			_p.WaterLevel = 1;
			point.Z = _p.Origin.Z + (mins.Z + maxs.Z) * 0.5f;
			cont = PointContents(point, MaskWater);
			if ((cont & MaskWater) != 0) {
				_p.WaterLevel = 2;
				point.Z = _p.Origin.Z + _p.ViewHeight(Settings);
				cont = PointContents(point, MaskWater);
				if ((cont & MaskWater) != 0) _p.WaterLevel = 3;
			}
			// Water currents push the player harder the deeper they are.
			const Contents currents = (Contents)0xFC0000;
			if ((cont & currents) != 0) {
				var v = Vector3.Zero;
				if ((cont & (Contents)0x40000) != 0) v.X += 1;
				if ((cont & (Contents)0x80000) != 0) v.Y += 1;
				if ((cont & (Contents)0x100000) != 0) v.X -= 1;
				if ((cont & (Contents)0x200000) != 0) v.Y -= 1;
				if ((cont & (Contents)0x400000) != 0) v.Z += 1;
				if ((cont & (Contents)0x800000) != 0) v.Z -= 1;
				_p.BaseVelocity += 50f * _p.WaterLevel * v;
			}
		}
		return _p.WaterLevel > 1;
	}

	/// <summary>CGameMovement::CheckWaterJump: at the surface facing a ledge with room above it, pop up and out.</summary>
	private void CheckWaterJump() {
		if (_p.WaterJumpTime != 0f) return;
		if (_p.Velocity.Z < -180f) return; // just jumped in

		var flatVelocity = new Vector3(_p.Velocity.X, _p.Velocity.Y, 0);
		var curSpeed = flatVelocity.Length();
		flatVelocity = Normalize(flatVelocity);
		var flatForward = Normalize(new Vector3(_forward.X, _forward.Y, 0));

		// Backing into the water from steps: don't pop forward.
		if (curSpeed != 0f && Vector3.Dot(flatVelocity, flatForward) < 0f) return;

		var start = _p.Origin + (PlayerMins + PlayerMaxs) * 0.5f;
		var end = start + 24f * flatForward;
		var tr = TracePlayerBBox(start, end);
		if (tr.Fraction >= 1f) return; // nothing solid at the waist

		start.Z = _p.Origin.Z + _p.ViewHeight(Settings) + 8f; // WATERJUMP_HEIGHT
		end = start + 24f * flatForward;
		_p.WaterJumpVelocity = -50f * tr.Normal;
		tr = TracePlayerBBox(start, end);
		if (tr.Fraction != 1f) return; // not open at eye level

		// Only if there is ground to land on.
		start = end;
		end.Z -= 1024f;
		tr = TracePlayerBBox(start, end);
		if (tr.Fraction < 1f && tr.Normal.Z >= 0.7f) {
			_p.Velocity.Z = 256f;
			_p.OldButtons |= MoveButtons.Jump;
			_p.WaterJumpTime = 2000f;
		}
	}

	private void WaterJump() {
		if (_p.WaterJumpTime > 10000f) _p.WaterJumpTime = 10000f;
		if (_p.WaterJumpTime == 0f) return;
		_p.WaterJumpTime -= 1000f * _dt;
		if (_p.WaterJumpTime <= 0f || _p.WaterLevel == 0) _p.WaterJumpTime = 0f;
		_p.Velocity.X = _p.WaterJumpVelocity.X;
		_p.Velocity.Y = _p.WaterJumpVelocity.Y;
	}

	/// <summary>CGameMovement::WaterMove: swimming, with water friction and a slow sink when idle.</summary>
	private void WaterMove() {
		var wishVel = _forward * _forwardMove + _right * _sideMove;
		if ((_buttons & MoveButtons.Jump) != 0) {
			wishVel.Z += _maxSpeed; // swim up
		} else if (_forwardMove == 0f && _sideMove == 0f) {
			wishVel.Z -= 60f; // drift towards the bottom
		} else {
			// Looking up or down while moving swims that way (there is no up-move key here).
			wishVel.Z += Math.Clamp(_forwardMove * _forward.Z * 2f, 0f, _maxSpeed);
		}

		var wishSpeed = wishVel.Length();
		if (wishSpeed > _maxSpeed) {
			wishVel *= _maxSpeed / wishSpeed;
			wishSpeed = _maxSpeed;
		}
		wishSpeed *= 0.8f;

		// Water friction.
		var speed = _p.Velocity.Length();
		float newSpeed;
		if (speed != 0f) {
			newSpeed = speed - _dt * speed * Settings.Friction * _p.SurfaceFriction;
			if (newSpeed < 0.1f) newSpeed = 0f;
			_p.Velocity *= newSpeed / speed;
		} else {
			newSpeed = 0f;
		}

		// Water acceleration.
		if (wishSpeed >= 0.1f) {
			var addSpeed = wishSpeed - newSpeed;
			if (addSpeed > 0f) {
				wishVel = Normalize(wishVel);
				var accelSpeed = Settings.Accelerate * wishSpeed * _dt * _p.SurfaceFriction;
				if (accelSpeed > addSpeed) accelSpeed = addSpeed;
				_p.Velocity += accelSpeed * wishVel;
			}
		}

		_p.Velocity += _p.BaseVelocity;

		// Assume a stair or a slope: try pressing down from a step height above.
		var dest = _p.Origin + _dt * _p.Velocity;
		var pm = TracePlayerBBox(_p.Origin, dest);
		if (pm.Fraction == 1f) {
			var start = dest;
			start.Z += Settings.StepSize + 1f;
			pm = TracePlayerBBox(start, dest);
			if (!pm.StartSolid && !pm.AllSolid) {
				// Walked up the step: keep it.
				_p.Origin = pm.EndPos;
				_p.Velocity -= _p.BaseVelocity;
				return;
			}
			TryPlayerMove(null, null);
		} else {
			if (!_p.OnGround) {
				TryPlayerMove(null, null);
				_p.Velocity -= _p.BaseVelocity;
				return;
			}
			StepMove(dest, pm);
		}
		_p.Velocity -= _p.BaseVelocity;
	}

	// ---------------------------------------------------------------- ladders

	/// <summary>
	/// CGameMovement::LadderMove with Counter-Strike's sideways damping: attaches to a ladder in
	/// reach (2 units in the direction the player moves, or back onto the one they're on) and turns
	/// the movement keys into climbing at 200 u/s. Jump pushes off at 270 u/s.
	/// </summary>
	private bool LadderMove() {
		Vector3 wishDir;
		if (_p.OnLadder) {
			wishDir = -_p.LadderNormal;
		} else if (_forwardMove != 0f || _sideMove != 0f) {
			wishDir = Normalize(_forward * _forwardMove + _right * _sideMove);
		} else {
			return false; // not trying to move: no ladder behaviour
		}

		var end = _p.Origin + 2f * wishDir; // LadderDistance
		var pm = TracePlayerBBox(_p.Origin, end);
		if (pm.Fraction == 1f || (pm.Contents & Contents.Ladder) == 0) return false;

		_p.OnLadder = true;
		_p.LadderNormal = pm.Normal;

		var floor = _p.Origin;
		floor.Z += PlayerMins.Z - 1f;
		var onFloor = PointContents(floor, ~Contents.Empty) == Contents.Solid || _p.OnGround;

		_p.GravityScale = 0f; // player->SetGravity(0): back to normal gravity once off

		const float climbSpeed = 200f; // MAX_CLIMB_SPEED
		float forwardSpeed = 0f, rightSpeed = 0f;
		if ((_buttons & MoveButtons.Back) != 0) forwardSpeed -= climbSpeed;
		if ((_buttons & MoveButtons.Forward) != 0) forwardSpeed += climbSpeed;
		if ((_buttons & MoveButtons.MoveLeft) != 0) rightSpeed -= climbSpeed;
		if ((_buttons & MoveButtons.MoveRight) != 0) rightSpeed += climbSpeed;

		if ((_buttons & MoveButtons.Jump) != 0) {
			_p.OnLadder = false;
			_p.Velocity = 270f * pm.Normal;
		} else if (forwardSpeed != 0f || rightSpeed != 0f) {
			var velocity = _forward * forwardSpeed + _right * rightSpeed;
			var perp = Normalize(Vector3.Cross(Vector3.UnitZ, pm.Normal));
			var normal = Vector3.Dot(velocity, pm.Normal);
			var cross = pm.Normal * normal;
			var lateral = velocity - cross;
			var tmp = Vector3.Cross(pm.Normal, perp);

			// Counter-Strike: damp sideways movement when moving into the ladder at a steep angle
			// (sv_ladder_dampen 0.2, sv_ladder_angle -0.707).
			var tmpDist = Vector3.Dot(tmp, lateral);
			var perpDist = Vector3.Dot(perp, lateral);
			var angleVec = Normalize(perp * perpDist + cross);
			if (Vector3.Dot(angleVec, pm.Normal) < -0.707f) lateral = tmp * tmpDist + perp * 0.2f * perpDist;

			_p.Velocity = lateral - normal * tmp;
			if (onFloor && normal > 0f) _p.Velocity += climbSpeed * pm.Normal; // stepping off away from the ladder
		} else {
			_p.Velocity = Vector3.Zero;
		}
		return true;
	}

	private void FullLadderMove() {
		CheckWater();
		if ((_buttons & MoveButtons.Jump) != 0) CheckJumpButton();
		else _p.OldButtons &= ~MoveButtons.Jump;

		_p.Velocity += _p.BaseVelocity;
		TryPlayerMove(null, null);
		_p.Velocity -= _p.BaseVelocity;
	}

	// ---------------------------------------------------------------- gravity and velocity

	private float EntityGravity => _p.GravityScale != 0f ? _p.GravityScale : 1f;

	private void StartGravity() {
		// Half the gravity now, half after the move, so the position is right during the move.
		_p.Velocity.Z -= EntityGravity * Settings.Gravity * 0.5f * _dt;
		_p.Velocity.Z += _p.BaseVelocity.Z * _dt;
		_p.BaseVelocity.Z = 0f;
		CheckVelocity();
	}

	private void FinishGravity() {
		_p.Velocity.Z -= EntityGravity * Settings.Gravity * _dt * 0.5f;
		CheckVelocity();
	}

	private void CheckVelocity() {
		var max = Settings.MaxVelocity;
		for (var i = 0; i < 3; i++) {
			if (float.IsNaN(_p.Velocity[i])) _p.Velocity[i] = 0;
			if (float.IsNaN(_p.Origin[i])) _p.Origin[i] = 0;
			if (_p.Velocity[i] > max) _p.Velocity[i] = max;
			else if (_p.Velocity[i] < -max) _p.Velocity[i] = -max;
		}
	}

	// ---------------------------------------------------------------- jumping

	private void CheckJumpButton() {
		// Leaping out of water: count it down (Source subtracts seconds from milliseconds here).
		if (_p.WaterJumpTime != 0f) {
			_p.WaterJumpTime -= _dt;
			if (_p.WaterJumpTime < 0f) _p.WaterJumpTime = 0f;
			return;
		}
		// Waist deep: swimming up, not jumping.
		if (_p.WaterLevel >= 2) {
			SetGroundEntity(null);
			if ((_p.WaterType & Contents.Water) != 0) _p.Velocity.Z = 100f;
			else if ((_p.WaterType & Contents.Slime) != 0) _p.Velocity.Z = 80f;
			return;
		}

		if (!_p.OnGround) {
			_p.OldButtons |= MoveButtons.Jump; // in the air: no effect
			return;
		}
		if ((_p.OldButtons & MoveButtons.Jump) != 0) return; // don't pogo stick

		// Can't jump during the unduck transition.
		if (_p.Ducking && _p.Ducked) return;

		SetGroundEntity(null);

		const float groundFactor = 1f;
		if (_p.Ducking || _p.Ducked) {
			_p.Velocity.Z = groundFactor * Settings.JumpImpulse;
		} else {
			_p.Velocity.Z += groundFactor * Settings.JumpImpulse;
		}

		FinishGravity();
		_p.OldButtons |= MoveButtons.Jump;
		_jumped = true;
	}

	// ---------------------------------------------------------------- friction and acceleration

	private void Friction() {
		var speed = _p.Velocity.Length();
		if (speed < 0.1f) return;

		var drop = 0f;
		if (_p.OnGround) {
			var friction = Settings.Friction * _p.SurfaceFriction;
			var control = speed < Settings.StopSpeed ? Settings.StopSpeed : speed;
			drop += control * friction * _dt;
		}

		var newSpeed = speed - drop;
		if (newSpeed < 0) newSpeed = 0;
		if (newSpeed != speed) {
			newSpeed /= speed;
			_p.Velocity *= newSpeed;
		}
	}

	private void Accelerate(Vector3 wishDir, float wishSpeed, float accel) {
		var currentSpeed = Vector3.Dot(_p.Velocity, wishDir);
		var addSpeed = wishSpeed - currentSpeed;
		if (addSpeed <= 0) return;
		var accelSpeed = accel * _dt * wishSpeed * _p.SurfaceFriction;
		if (accelSpeed > addSpeed) accelSpeed = addSpeed;
		_p.Velocity += accelSpeed * wishDir;
	}

	private void AirAccelerate(Vector3 wishDir, float wishSpeed, float accel) {
		var wishSpd = wishSpeed;
		if (wishSpd > Settings.AirSpeedCap) wishSpd = Settings.AirSpeedCap;
		var currentSpeed = Vector3.Dot(_p.Velocity, wishDir);
		var addSpeed = wishSpd - currentSpeed;
		if (addSpeed <= 0) return;
		var accelSpeed = accel * wishSpeed * _dt * _p.SurfaceFriction;
		if (accelSpeed > addSpeed) accelSpeed = addSpeed;
		_p.Velocity += accelSpeed * wishDir;
	}

	/// <summary>The horizontal wish velocity from the view angles and movement input.</summary>
	private (Vector3 Dir, float Speed) WishVelocity() {
		AngleVectors(_viewAngles, out var forward, out var right);
		forward.Z = 0;
		right.Z = 0;
		forward = Normalize(forward);
		right = Normalize(right);
		var wishVel = new Vector3(
			forward.X * _forwardMove + right.X * _sideMove,
			forward.Y * _forwardMove + right.Y * _sideMove,
			0);
		var wishSpeed = wishVel.Length();
		var wishDir = wishSpeed > 0 ? wishVel / wishSpeed : Vector3.Zero;
		if (wishSpeed != 0 && wishSpeed > _maxSpeed) wishSpeed = _maxSpeed;
		return (wishDir, wishSpeed);
	}

	// ---------------------------------------------------------------- air and ground moves

	private void AirMove() {
		var (wishDir, wishSpeed) = WishVelocity();
		AirAccelerate(wishDir, wishSpeed, Settings.AirAccelerate);
		_p.Velocity += _p.BaseVelocity;
		TryPlayerMove(null, null);
		_p.Velocity -= _p.BaseVelocity;
	}

	private void WalkMove() {
		var oldGround = _p.GroundEntity;
		var (wishDir, wishSpeed) = WishVelocity();

		_p.Velocity.Z = 0;
		Accelerate(wishDir, wishSpeed, Settings.Accelerate);
		_p.Velocity.Z = 0;

		_p.Velocity += _p.BaseVelocity;
		var spd = _p.Velocity.Length();
		if (spd < 1f) {
			_p.Velocity = Vector3.Zero;
			_p.Velocity -= _p.BaseVelocity;
			return;
		}

		// First try moving straight to the destination.
		var dest = new Vector3(
			_p.Origin.X + _p.Velocity.X * _dt,
			_p.Origin.Y + _p.Velocity.Y * _dt,
			_p.Origin.Z);
		var pm = TracePlayerBBox(_p.Origin, dest);
		if (pm.Fraction == 1f) {
			_p.Origin = pm.EndPos;
			_p.Velocity -= _p.BaseVelocity;
			StayOnGround();
			return;
		}

		// Don't walk up stairs when not on ground.
		if (oldGround < 0) {
			_p.Velocity -= _p.BaseVelocity;
			return;
		}

		StepMove(dest, pm);
		_p.Velocity -= _p.BaseVelocity;
		StayOnGround();
	}

	private void StepMove(Vector3 destination, Trace firstTrace) {
		var pos = _p.Origin;
		var vel = _p.Velocity;

		// Slide move along the ground.
		TryPlayerMove(destination, firstTrace);
		var downPos = _p.Origin;
		var downVel = _p.Velocity;

		// Reset, move up a step, slide, and move back down.
		_p.Origin = pos;
		_p.Velocity = vel;

		var end = _p.Origin;
		end.Z += Settings.StepSize + DistEpsilon;
		var trace = TracePlayerBBox(_p.Origin, end);
		if (!trace.StartSolid && !trace.AllSolid) _p.Origin = trace.EndPos;

		TryPlayerMove(null, null);

		end = _p.Origin;
		end.Z -= Settings.StepSize + DistEpsilon;
		trace = TracePlayerBBox(_p.Origin, end);

		// Not on ground any more: use the plain slide.
		if (trace.Normal.Z < 0.7f) {
			_p.Origin = downPos;
			_p.Velocity = downVel;
			return;
		}

		if (!trace.StartSolid && !trace.AllSolid) _p.Origin = trace.EndPos;
		var upPos = _p.Origin;

		// Keep whichever went farther horizontally.
		var downDist = (downPos.X - pos.X) * (downPos.X - pos.X) + (downPos.Y - pos.Y) * (downPos.Y - pos.Y);
		var upDist = (upPos.X - pos.X) * (upPos.X - pos.X) + (upPos.Y - pos.Y) * (upPos.Y - pos.Y);
		if (downDist > upDist) {
			_p.Origin = downPos;
			_p.Velocity = downVel;
		} else {
			_p.Velocity.Z = downVel.Z;
		}
	}

	private void StayOnGround() {
		var start = _p.Origin;
		var end = _p.Origin;
		start.Z += 2;
		end.Z -= Settings.StepSize;

		// See how far up we can go without getting stuck, then trace down from there.
		var trace = TracePlayerBBox(_p.Origin, start);
		start = trace.EndPos;
		trace = TracePlayerBBox(start, end);
		if (trace.Fraction > 0f && trace.Fraction < 1f && !trace.StartSolid && trace.Normal.Z >= 0.7f) {
			var delta = MathF.Abs(_p.Origin.Z - trace.EndPos.Z);
			if (delta > 0.5f * CoordResolution) _p.Origin = trace.EndPos;
		}
	}

	/// <summary>Moves along the velocity for one tick, sliding along whatever it hits.</summary>
	private int TryPlayerMove(Vector3? firstDest, Trace? firstTrace) {
		const int numBumps = 4;
		var blocked = 0;
		var numPlanes = 0;
		Span<Vector3> planes = stackalloc Vector3[MaxClipPlanes];
		var originalVelocity = _p.Velocity;
		var primalVelocity = _p.Velocity;
		var newVelocity = Vector3.Zero;
		var allFraction = 0f;
		var timeLeft = _dt;

		for (var bump = 0; bump < numBumps; bump++) {
			if (_p.Velocity.Length() == 0f) break;

			var end = _p.Origin + timeLeft * _p.Velocity;
			Trace pm;
			if (firstDest is { } fd && firstTrace is { } ft && end == fd) pm = ft;
			else pm = TracePlayerBBox(_p.Origin, end);

			allFraction += pm.Fraction;

			if (pm.AllSolid) {
				_p.Velocity = Vector3.Zero;
				return 4;
			}

			if (pm.Fraction > 0) {
				if (pm.Fraction == 1f) {
					// Guard against a sweep that ends embedded in something.
					var stuck = TracePlayerBBox(pm.EndPos, pm.EndPos);
					if (stuck.StartSolid || stuck.Fraction != 1f) {
						_p.Velocity = Vector3.Zero;
						break;
					}
				}
				_p.Origin = pm.EndPos;
				originalVelocity = _p.Velocity;
				numPlanes = 0;
			}

			if (pm.Fraction == 1f) break;

			AddToTouched(pm.ModelId);

			if (pm.Normal.Z > 0.7f) blocked |= 1; // floor
			if (pm.Normal.Z == 0f) blocked |= 2; // step or wall

			timeLeft -= timeLeft * pm.Fraction;

			if (numPlanes >= MaxClipPlanes) {
				_p.Velocity = Vector3.Zero;
				break;
			}
			planes[numPlanes++] = pm.Normal;

			if (numPlanes == 1 && !_p.OnGround) {
				// In the air, first impact: reflect (with overbounce 1, so slide) off the plane.
				for (var i = 0; i < numPlanes; i++) {
					if (planes[i].Z > 0.7f) {
						ClipVelocity(originalVelocity, planes[i], out newVelocity, 1f);
						originalVelocity = newVelocity;
					} else {
						ClipVelocity(originalVelocity, planes[i], out newVelocity, 1f + Settings.Bounce * (1f - _p.SurfaceFriction));
					}
				}
				_p.Velocity = newVelocity;
				originalVelocity = newVelocity;
			} else {
				int i;
				for (i = 0; i < numPlanes; i++) {
					ClipVelocity(originalVelocity, planes[i], out _p.Velocity, 1f);
					int j;
					for (j = 0; j < numPlanes; j++) {
						if (j != i && Vector3.Dot(_p.Velocity, planes[j]) < 0) break;
					}
					if (j == numPlanes) break;
				}

				if (i == numPlanes) {
					// Go along the crease between two planes, or stop.
					if (numPlanes != 2) {
						_p.Velocity = Vector3.Zero;
						break;
					}
					var dir = Normalize(Vector3.Cross(planes[0], planes[1]));
					var d = Vector3.Dot(dir, _p.Velocity);
					_p.Velocity = dir * d;
				}

				// Moving against the original velocity: stop dead to avoid oscillating in corners.
				if (Vector3.Dot(_p.Velocity, primalVelocity) <= 0) {
					_p.Velocity = Vector3.Zero;
					break;
				}
			}
		}

		if (allFraction == 0) _p.Velocity = Vector3.Zero;
		return blocked;
	}

	private static int ClipVelocity(Vector3 input, Vector3 normal, out Vector3 output, float overbounce) {
		var angle = normal.Z;
		var blocked = 0;
		if (angle > 0) blocked |= 1;
		if (angle == 0) blocked |= 2;

		var backoff = Vector3.Dot(input, normal) * overbounce;
		output = input - normal * backoff;

		// Make sure we aren't still moving through the plane.
		var adjust = Vector3.Dot(output, normal);
		if (adjust < 0f) output -= normal * adjust;
		return blocked;
	}

	// ---------------------------------------------------------------- ground

	private void CategorizePosition() {
		_p.SurfaceFriction = 1f;
		CheckWater();

		var point = _p.Origin;
		point.Z -= 2f;
		var zvel = _p.Velocity.Z;
		var movingUp = zvel > 0f;
		var movingUpRapidly = zvel > NonJumpVelocity;

		if (movingUpRapidly || (movingUp && _p.OnLadder)) {
			SetGroundEntity(null);
			return;
		}

		var pm = TryTouchGround(_p.Origin, point, PlayerMins, PlayerMaxs);
		if (!pm.DidHit || pm.Normal.Z < 0.7f) {
			// Maybe one quarter of the box finds a slope we could stand on.
			pm = TryTouchGroundInQuadrants(_p.Origin, point, pm);
			if (!pm.DidHit || pm.Normal.Z < 0.7f) {
				SetGroundEntity(null);
				if (movingUp) _p.SurfaceFriction = 0.25f;
			} else {
				SetGroundEntity(pm);
			}
		} else {
			SetGroundEntity(pm);
		}
	}

	private Trace TryTouchGround(Vector3 start, Vector3 end, Vector3 mins, Vector3 maxs) =>
		World.TraceHull(start, end, mins, maxs, SolidMask);

	private Trace TryTouchGroundInQuadrants(Vector3 start, Vector3 end, Trace pm) {
		var minsSrc = PlayerMins;
		var maxsSrc = PlayerMaxs;
		var fraction = pm.Fraction;
		var endPos = pm.EndPos;

		(Vector3 Mins, Vector3 Maxs)[] quadrants = [
			(minsSrc, new Vector3(MathF.Min(0, maxsSrc.X), MathF.Min(0, maxsSrc.Y), maxsSrc.Z)),
			(new Vector3(MathF.Max(0, minsSrc.X), MathF.Max(0, minsSrc.Y), minsSrc.Z), maxsSrc),
			(new Vector3(minsSrc.X, MathF.Max(0, minsSrc.Y), minsSrc.Z), new Vector3(MathF.Min(0, maxsSrc.X), maxsSrc.Y, maxsSrc.Z)),
			(new Vector3(MathF.Max(0, minsSrc.X), minsSrc.Y, minsSrc.Z), new Vector3(maxsSrc.X, MathF.Min(0, maxsSrc.Y), maxsSrc.Z)),
		];
		foreach (var (mins, maxs) in quadrants) {
			pm = TryTouchGround(start, end, mins, maxs);
			if (pm.DidHit && pm.Normal.Z >= 0.7f) {
				pm.Fraction = fraction;
				pm.EndPos = endPos;
				return pm;
			}
		}
		pm.Fraction = fraction;
		pm.EndPos = endPos;
		return pm;
	}

	private void SetGroundEntity(Trace? pm) {
		var newGround = pm is { } t && t.DidHit ? Math.Max(t.ModelId, 0) : -1;
		var oldGround = _p.GroundEntity;

		// All ground is static, so only the vertical part of base velocity changes hands.
		if (oldGround < 0 && newGround >= 0) _p.BaseVelocity.Z = 0f;
		else if (oldGround >= 0 && newGround < 0) _p.BaseVelocity.Z = 0f;

		_p.GroundEntity = newGround;
		if (newGround >= 0) {
			_p.GroundNormal = pm!.Value.Normal;
			if (newGround != 0) AddToTouched(newGround);
			_p.Velocity.Z = 0f;
		} else {
			_p.GroundNormal = Vector3.Zero;
		}
	}

	// ---------------------------------------------------------------- ducking

	private void Duck() {
		var buttonsChanged = _p.OldButtons ^ _buttons;
		var buttonsPressed = buttonsChanged & _buttons;
		var buttonsReleased = buttonsChanged & _p.OldButtons;

		if ((_buttons & MoveButtons.Duck) != 0) _p.OldButtons |= MoveButtons.Duck;
		else _p.OldButtons &= ~MoveButtons.Duck;

		HandleDuckingSpeedCrop();

		var holding = (_buttons & MoveButtons.Duck) != 0;
		if (!holding && !_p.Ducking && !_p.Ducked) return;

		if (holding) {
			var alreadyDucked = _p.Ducked;
			if ((buttonsPressed & MoveButtons.Duck) != 0 && !_p.Ducked) {
				_p.DuckTimeMs = 1000;
				_p.Ducking = true;
			}
			var duckSeconds = MathF.Max(0f, 1000f - _p.DuckTimeMs) / 1000f;
			if (_p.Ducking) {
				// Finish immediately when the time is up or in the air.
				if (duckSeconds > Settings.TimeToDuck || !_p.OnGround || alreadyDucked) FinishDuck();
			}
		} else {
			// Not holding duck: try to stand up. In the air that's always allowed.
			if ((buttonsReleased & MoveButtons.Duck) != 0 && _p.Ducked) {
				_p.DuckTimeMs = 1000;
				_p.Ducking = true;
			}
			var duckSeconds = MathF.Max(0f, 1000f - _p.DuckTimeMs) / 1000f;
			if (CanUnduck()) {
				if (_p.Ducking || _p.Ducked) {
					if (duckSeconds > Settings.TimeToUnduck || !_p.OnGround) FinishUnDuck();
				}
			} else {
				// Still under something: restart the timer so we stand up once clear.
				_p.DuckTimeMs = 1000;
			}
		}
	}

	private void HandleDuckingSpeedCrop() {
		if (_speedCroppedDuck) return;
		if ((_buttons & MoveButtons.Duck) != 0 || _p.Ducking || _p.Ducked) {
			_forwardMove *= Settings.DuckSpeedMultiplier;
			_sideMove *= Settings.DuckSpeedMultiplier;
			_speedCroppedDuck = true;
		}
	}

	private Vector3 HullHeightDelta =>
		(Settings.HullMaxs - Settings.HullMins) - (Settings.DuckHullMaxs - Settings.DuckHullMins);

	private void FinishDuck() {
		if (_p.Ducked) return;
		_p.Ducked = true;
		_p.Ducking = false;

		if (_p.OnGround) {
			_p.Origin -= Settings.DuckHullMins - Settings.HullMins;
		} else {
			// In the air the head stays put and the feet come up.
			_p.Origin += HullHeightDelta;
		}

		FixPlayerCrouchStuck(upward: true);
		CategorizePosition();
	}

	private Vector3 UnduckOrigin() {
		var origin = _p.Origin;
		if (_p.OnGround) origin += Settings.DuckHullMins - Settings.HullMins;
		else origin -= HullHeightDelta;
		return origin;
	}

	private bool CanUnduck() {
		var newOrigin = UnduckOrigin();
		var saved = _p.Ducked;
		_p.Ducked = false;
		var trace = TracePlayerBBox(_p.Origin, newOrigin);
		_p.Ducked = saved;
		return !trace.StartSolid && trace.Fraction == 1f;
	}

	private void FinishUnDuck() {
		var newOrigin = UnduckOrigin();
		_p.Ducked = false;
		_p.Ducking = false;
		_p.DuckTimeMs = 0;
		_p.Origin = newOrigin;
		CategorizePosition();
	}

	private void FixPlayerCrouchStuck(bool upward) {
		if (!TestPlayerPosition(_p.Origin)) return;
		var test = _p.Origin;
		// Source steps 0 units per try when fixing downward; kept for fidelity.
		var direction = upward ? 1 : 0;
		for (var i = 0; i < 36; i++) {
			_p.Origin.Z += direction;
			if (!TestPlayerPosition(_p.Origin)) return;
		}
		_p.Origin = test;
	}

	// ---------------------------------------------------------------- traces

	private Vector3 PlayerMins => _p.Ducked ? Settings.DuckHullMins : Settings.HullMins;
	private Vector3 PlayerMaxs => _p.Ducked ? Settings.DuckHullMaxs : Settings.HullMaxs;

	private Trace TracePlayerBBox(Vector3 start, Vector3 end) =>
		World.TraceHull(start, end, PlayerMins, PlayerMaxs, SolidMask);

	/// <summary>True when the player's box at <paramref name="origin"/> is inside something.</summary>
	private bool TestPlayerPosition(Vector3 origin) {
		var t = TracePlayerBBox(origin, origin);
		return t.StartSolid || t.AllSolid;
	}

	private void AddToTouched(int modelId) {
		if (modelId > 0 && !_touched.Contains(modelId)) _touched.Add(modelId);
	}

	// ---------------------------------------------------------------- math

	/// <summary>Source's AngleVectors (forward and right only).</summary>
	public static void AngleVectors(Vector3 angles, out Vector3 forward, out Vector3 right) {
		var (sp, cp) = MathF.SinCos(angles.X * (MathF.PI / 180f));
		var (sy, cy) = MathF.SinCos(angles.Y * (MathF.PI / 180f));
		var (sr, cr) = MathF.SinCos(angles.Z * (MathF.PI / 180f));
		forward = new Vector3(cp * cy, cp * sy, -sp);
		right = new Vector3(-1 * sr * sp * cy + -1 * cr * -sy, -1 * sr * sp * sy + -1 * cr * cy, -1 * sr * cp);
	}

	private static Vector3 Normalize(Vector3 v) {
		var len = v.Length();
		return len > 0 ? v / len : Vector3.Zero;
	}
}
