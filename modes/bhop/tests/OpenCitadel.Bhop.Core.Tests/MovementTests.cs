using System.Numerics;
using OpenCitadel.Bhop.Collision;
using OpenCitadel.Bhop.Movement;

namespace OpenCitadel.Bhop.Tests;

public class MovementTests {
	private const float Tick64 = 1f / 64f;
	private const float Tick100 = 1f / 100f;

	/// <summary>A big flat floor with its top at z = 0.</summary>
	private static CollisionWorld Floor(params Brush[] extra) =>
		new([new BrushModel(0, "world", [Brush.Box(new(-8192, -8192, -64), new(8192, 8192, 0)), .. extra])]);

	private static (CssMovement Move, PlayerMoveState Player) Setup(CollisionWorld world, MovementSettings? settings = null, Vector3? origin = null) {
		var move = new CssMovement(settings ?? MovementSettings.CounterStrikeSource, world);
		// Spawn a little above the floor and let the player settle: like Source, a box resting exactly
		// on a plane counts as stuck, and traces leave players 1/32 unit above the ground.
		var player = new PlayerMoveState { Origin = origin ?? new Vector3(0, 0, 1) };
		return (move, player);
	}

	private static float Speed2D(Vector3 v) => new Vector2(v.X, v.Y).Length();

	private static void Run(CssMovement move, PlayerMoveState p, int ticks, MoveButtons buttons, float yaw = 0, float dt = Tick64) {
		for (var i = 0; i < ticks; i++) move.Simulate(p, MoveInput.FromKeys(buttons, 0, yaw, dt));
	}

	[Theory]
	[InlineData(Tick64)]
	[InlineData(Tick100)]
	public void RunningReachesExactlyRunSpeed(float dt) {
		var (move, p) = Setup(Floor());
		Run(move, p, (int)(3 / dt), MoveButtons.Forward, dt: dt);
		Assert.True(p.OnGround);
		Assert.Equal(250f, Speed2D(p.Velocity), 3);
		Assert.Equal(RestHeight, p.Origin.Z, 4);
	}

	/// <summary>Where a player standing on a floor at z = 0 rests: DIST_EPSILON above it.</summary>
	private const float RestHeight = 0.03125f;

	[Fact]
	public void DiagonalInputIsClampedToRunSpeed() {
		var (move, p) = Setup(Floor());
		Run(move, p, 200, MoveButtons.Forward | MoveButtons.MoveRight);
		Assert.Equal(250f, Speed2D(p.Velocity), 3);
	}

	[Fact]
	public void FrictionStopsAPlayerWhoLetsGo() {
		var (move, p) = Setup(Floor());
		Run(move, p, 200, MoveButtons.Forward);
		Run(move, p, 64, MoveButtons.None);
		Assert.Equal(0f, Speed2D(p.Velocity), 3);
	}

	[Theory]
	[InlineData(Tick64)]
	[InlineData(Tick100)]
	public void JumpApexIsAboutFiftySevenUnits(float dt) {
		var (move, p) = Setup(Floor());
		Run(move, p, 4, MoveButtons.None, dt: dt);
		Assert.True(p.OnGround);
		var apex = 0f;
		var jumped = false;
		for (var i = 0; i < (int)(2 / dt); i++) {
			var r = move.Simulate(p, MoveInput.FromKeys(i == 0 ? MoveButtons.Jump : MoveButtons.None, 0, 0, dt));
			jumped |= r.Jumped;
			apex = MathF.Max(apex, p.Origin.Z);
		}
		Assert.True(jumped);
		Assert.InRange(apex, 54f, 57.01f);
		Assert.True(p.OnGround);
	}

	[Fact]
	public void HoldingJumpWithoutAutobhopJumpsOnlyOnce() {
		var settings = MovementSettings.CounterStrikeSource with { AutoBhop = false };
		var (move, p) = Setup(Floor(), settings);
		Run(move, p, 4, MoveButtons.None);
		var jumps = 0;
		for (var i = 0; i < 200; i++) {
			if (move.Simulate(p, MoveInput.FromKeys(MoveButtons.Jump, 0, 0, Tick64)).Jumped) jumps++;
		}
		Assert.Equal(1, jumps);
	}

	[Fact]
	public void AutobhopKeepsSpeedBecauseFrictionNeverApplies() {
		var (move, p) = Setup(Floor());
		Run(move, p, 4, MoveButtons.None);
		p.Velocity = new Vector3(400, 0, 0);
		var jumps = 0;
		for (var i = 0; i < 64 * 5; i++) {
			var r = move.Simulate(p, MoveInput.FromKeys(MoveButtons.Jump, 0, 0, Tick64));
			if (r.Jumped) jumps++;
		}
		Assert.True(jumps >= 6, $"jumps={jumps}");
		Assert.Equal(400f, Speed2D(p.Velocity), 2);
	}

	[Fact]
	public void LandingWithoutJumpLosesSpeedToFriction() {
		var (move, p) = Setup(Floor());
		Run(move, p, 4, MoveButtons.None);
		p.Velocity = new Vector3(400, 0, 0);
		move.Simulate(p, MoveInput.FromKeys(MoveButtons.Jump, 0, 0, Tick64));
		Run(move, p, 64 * 2, MoveButtons.None);
		Assert.True(Speed2D(p.Velocity) < 1f);
	}

	[Theory]
	[InlineData(Tick64)]
	[InlineData(Tick100)]
	public void AirStrafingGainsSpeed(float dt) {
		var (move, p) = Setup(Floor());
		Run(move, p, (int)(1 / dt), MoveButtons.Forward, dt: dt);
		var yaw = 0f;
		// Strafe in long arcs: turn at a steady rate while holding the matching strafe key, swapping
		// direction every second, holding jump throughout.
		const float degreesPerSecond = 220f;
		for (var i = 0; i < (int)(6 / dt); i++) {
			var right = (int)(i * dt) % 2 == 0;
			yaw += (right ? -1 : 1) * degreesPerSecond * dt;
			var keys = MoveButtons.Jump | (right ? MoveButtons.MoveRight : MoveButtons.MoveLeft);
			move.Simulate(p, MoveInput.FromKeys(keys, 0, yaw, dt));
		}
		Assert.True(Speed2D(p.Velocity) > 500f, $"speed={Speed2D(p.Velocity)}");
	}

	[Fact]
	public void AirAccelerationIsCappedAtThirtyUnitsTowardTheWishDirection() {
		var settings = MovementSettings.CounterStrikeSource with { AirAccelerate = 100000f };
		var (move, p) = Setup(new CollisionWorld(), settings, origin: new(0, 0, 1000));
		p.GameCodeMovedPlayer = false;
		// Moving at 300 along +X; strafing right (−Y) at yaw 0 can add at most 30 along −Y.
		p.Velocity = new Vector3(300, 0, 0);
		move.Simulate(p, MoveInput.FromKeys(MoveButtons.MoveRight, 0, 0, Tick64));
		Assert.Equal(-30f, p.Velocity.Y, 3);
		Assert.Equal(300f, p.Velocity.X, 3);
	}

	[Fact]
	public void WalksUpAStepButNotAWall() {
		var step = Brush.Box(new(100, -500, 0), new(4000, 500, 16));
		var (move, p) = Setup(Floor(step));
		Run(move, p, 128, MoveButtons.Forward);
		Assert.Equal(16f + RestHeight, p.Origin.Z, 3);
		Assert.True(p.Origin.X > 200);

		var wall = Brush.Box(new(100, -500, 0), new(400, 500, 20));
		(move, p) = Setup(Floor(wall));
		Run(move, p, 128, MoveButtons.Forward);
		Assert.Equal(RestHeight, p.Origin.Z, 3);
		Assert.InRange(p.Origin.X, 83f, 84f);
	}

	[Fact]
	public void DuckingInTheAirLiftsTheFeet() {
		var (move, p) = Setup(Floor());
		Run(move, p, 4, MoveButtons.None);
		move.Simulate(p, MoveInput.FromKeys(MoveButtons.Jump, 0, 0, Tick64));
		var before = p.Origin.Z;
		move.Simulate(p, MoveInput.FromKeys(MoveButtons.Duck, 0, 0, Tick64));
		Assert.True(p.Ducked);
		Assert.True(p.Origin.Z - before > 17f - 5f, $"lift={p.Origin.Z - before}");
	}

	[Fact]
	public void CrouchJumpReachesALedgeAStandingJumpCannot() {
		// A 64-unit ledge at x = 48. Run up from far back and jump about where the apex meets the
		// ledge; a standing jump peaks near 57, a crouch jump near 57 + 17.
		var ledge = Brush.Box(new(48, -500, 0), new(600, 500, 64));
		bool Reaches(bool crouch) {
			var (move, p) = Setup(Floor(ledge), origin: new(-400, 0, 1));
			var jumped = false;
			for (var i = 0; i < 256; i++) {
				var keys = MoveButtons.Forward;
				if (!jumped && p.Origin.X >= -60f) {
					keys |= MoveButtons.Jump;
					jumped = true;
				} else if (jumped && crouch) {
					keys |= MoveButtons.Duck;
				}
				move.Simulate(p, MoveInput.FromKeys(keys, 0, 0, Tick64));
			}
			return p.Origin.Z > 60f;
		}
		Assert.False(Reaches(crouch: false));
		Assert.True(Reaches(crouch: true));
	}

	[Fact]
	public void SteepRampIsNotGroundAndTheRampDeflectsUpward() {
		// A 60 degree slope (normal z = 0.5 < 0.7), rising toward +X from x = 64.
		var n = Vector3.Normalize(new Vector3(-MathF.Sin(MathF.PI / 3), 0, MathF.Cos(MathF.PI / 3)));
		var ramp = Brush.FromPlanes([
			(n, Vector3.Dot(n, new Vector3(64, 0, 0))),
			(-Vector3.UnitZ, 0f),
			(Vector3.UnitX, 1000f),
			(Vector3.UnitY, 500f),
			(-Vector3.UnitY, 500f),
		]);
		var (move, p) = Setup(Floor(ramp));
		Run(move, p, 4, MoveButtons.None);
		p.Velocity = new Vector3(800, 0, 0);
		move.Simulate(p, MoveInput.FromKeys(MoveButtons.Jump, 0, 0, Tick64));
		var maxZ = 0f;
		for (var i = 0; i < 64; i++) {
			move.Simulate(p, MoveInput.FromKeys(MoveButtons.None, 0, 0, Tick64));
			maxZ = MathF.Max(maxZ, p.Origin.Z);
			Assert.False(p.OnGround && p.Origin.Z > 5f, "a steep ramp must not count as ground");
		}
		Assert.True(maxZ > 100f, $"maxZ={maxZ}");
	}

	[Fact]
	public void TeleportRecategorizesTheGround() {
		var (move, p) = Setup(Floor());
		p.Teleport(new Vector3(0, 0, 0.5f), Vector3.Zero);
		move.Simulate(p, MoveInput.FromKeys(MoveButtons.None, 0, 0, Tick64));
		Assert.True(p.OnGround);
	}
}
