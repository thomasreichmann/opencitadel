using System.Numerics;
using OpenCitadel.Bhop.Collision;
using OpenCitadel.Bhop.Movement;

namespace OpenCitadel.Bhop.Tests;

/// <summary>CS:S ladders (func_ladder: solid brushes with CONTENTS_LADDER) and water.</summary>
public class WaterLadderTests {
	private const float Dt = 1f / 64f;
	private static readonly MovementSettings S = MovementSettings.CounterStrikeSource;

	private static CollisionWorld World(params Brush[] extra) =>
		new([new BrushModel(0, "world", [Brush.Box(new(-8192, -8192, -64), new(8192, 8192, 0)), .. extra])]);

	/// <summary>A ladder face at x = 100, facing -X, 512 units tall.</summary>
	private static Brush Ladder() => Brush.Box(new(100, -64, 0), new(116, 64, 512), Contents.Solid | Contents.Ladder);

	private static void Run(CssMovement move, PlayerMoveState p, int ticks, MoveButtons buttons, float pitch = 0) {
		for (var i = 0; i < ticks; i++) move.Simulate(p, MoveInput.FromKeys(buttons, pitch, 0, Dt));
	}

	[Fact]
	public void WalkingIntoALadderClimbsItAt200() {
		var move = new CssMovement(S, World(Ladder()));
		var p = new PlayerMoveState { Origin = new(40, 0, 1) };
		Run(move, p, 32, MoveButtons.Forward); // walk up to it and attach
		Assert.True(p.OnLadder);
		var z = p.Origin.Z;
		Run(move, p, 64, MoveButtons.Forward);
		Assert.InRange(p.Origin.Z - z, 195f, 205f); // one second of climbing
		Assert.True(p.Origin.X < 100 - 16 + 0.1f, "stays against the ladder, not inside it");
	}

	[Fact]
	public void LettingGoHoldsTheLadderAndJumpPushesOff() {
		var move = new CssMovement(S, World(Ladder()));
		var p = new PlayerMoveState { Origin = new(40, 0, 1) };
		Run(move, p, 64, MoveButtons.Forward);
		Assert.True(p.OnLadder);
		var z = p.Origin.Z;
		Run(move, p, 32, MoveButtons.None);
		Assert.Equal(z, p.Origin.Z, 2); // no keys on a ladder: you stay put
		Assert.True(p.OnLadder);

		// Jump (held, even with autobhop): pushed off 270 u/s straight away from the face.
		move.Simulate(p, MoveInput.FromKeys(MoveButtons.Jump, 0, 0, Dt));
		Assert.False(p.OnLadder);
		Assert.True(p.Velocity.X < -260f, $"pushed off the ladder: {p.Velocity}");
	}

	[Fact]
	public void WaterSlowsFallsAndJumpSwimsUp() {
		var water = Brush.Box(new(-500, -500, 0), new(500, 500, 300), Contents.Water | Contents.Translucent);
		var move = new CssMovement(S, World(water));

		// Dropped into deep water with no input: sinks slowly instead of falling.
		var p = new PlayerMoveState { Origin = new(0, 0, 200), Velocity = Vector3.Zero };
		Run(move, p, 64, MoveButtons.None);
		Assert.Equal(3, p.WaterLevel);
		Assert.InRange(p.Velocity.Z, -60f, 0f);

		// Holding jump swims up.
		var z = p.Origin.Z;
		Run(move, p, 64, MoveButtons.Jump);
		Assert.True(p.Origin.Z > z + 50f, $"swam up from {z} to {p.Origin.Z}");
	}

	[Fact]
	public void ShallowWaterDoesNotChangeWalking() {
		// Ankle-deep (level 1): normal ground movement and autobhop.
		var puddle = Brush.Box(new(-500, -500, 0), new(500, 500, 10), Contents.Water | Contents.Translucent);
		var move = new CssMovement(S, World(puddle));
		var p = new PlayerMoveState { Origin = new(0, 0, 1) };
		var jumps = 0;
		for (var i = 0; i < 3 * 64; i++) {
			if (move.Simulate(p, MoveInput.FromKeys(MoveButtons.Jump, 0, 0, Dt)).Jumped) jumps++;
		}
		Assert.True(p.WaterLevel <= 1, $"ankle deep at most ({p.WaterLevel})");
		Assert.True(jumps >= 4, $"autobhop kept jumping in a puddle ({jumps})");
	}
}
