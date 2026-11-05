using System.Numerics;
using OpenCitadel.Bhop.Collision;
using OpenCitadel.Bhop.Movement;

namespace OpenCitadel.Bhop.Tests;

public class PredictionTests {
	private const float Tick = 1f / 64f;

	private static CollisionWorld Floor() =>
		new([new BrushModel(0, "world", [Brush.Box(new(-8192, -8192, -64), new(8192, 8192, 0))])]);

	private static CssMovement Movement(MovementSettings? settings = null) => new(settings ?? MovementSettings.CounterStrikeSource, Floor());

	/// <summary>Where a client predicting <paramref name="ticks"/> ahead draws the player: a straight line.</summary>
	private static Vector3 Drawn(PlayerMoveState p, Vector3 networked, int ticks) => p.Origin + networked * (ticks * Tick);

	[Fact]
	public void AFallingPlayerIsDrawnOnTheFloorNotInIt() {
		var player = new PlayerMoveState { Origin = new Vector3(0, 0, 20), Velocity = new Vector3(0, 0, -500) };
		var input = MoveInput.FromKeys(MoveButtons.None, 0, 0, Tick);
		const int ticks = 16; // 250 ms: a player across an ocean

		// Their own velocity carried on for 250 ms puts them 105 units into the floor.
		Assert.True(Drawn(player, player.Velocity, ticks).Z < -100);

		var networked = PredictionForecast.NetworkVelocity(Movement(), player, input, ticks);
		var drawn = Drawn(player, networked, ticks);
		var real = player.Clone();
		var move = Movement();
		for (var i = 0; i < ticks; i++) move.Simulate(real, input);
		Assert.Equal(real.Origin.Z, drawn.Z, 3);
		Assert.True(real.OnGround);
	}

	[Fact]
	public void AJumpIsDrawnOnItsArc() {
		var move = Movement();
		var player = new PlayerMoveState { Origin = new Vector3(0, 0, 1) };
		var stand = MoveInput.FromKeys(MoveButtons.None, 0, 0, Tick);
		for (var i = 0; i < 4; i++) move.Simulate(player, stand);
		move.Simulate(player, MoveInput.FromKeys(MoveButtons.Jump, 0, 0, Tick));
		Assert.False(player.OnGround);

		// Every tick of the jump, the drawn position 10 ticks ahead is where the jump really is then.
		var forecast = Movement();
		var path = new List<Vector3>();
		var states = new List<(PlayerMoveState State, Vector3 Networked)>();
		for (var i = 0; i < 40; i++) {
			states.Add((player.Clone(), PredictionForecast.NetworkVelocity(forecast, player, stand, 10)));
			move.Simulate(player, stand);
			path.Add(player.Origin);
		}
		for (var i = 0; i + 10 <= path.Count; i++) {
			var (state, networked) = states[i];
			Assert.Equal(path[i + 9].Z, Drawn(state, networked, 10).Z, 2);
		}
	}

	[Fact]
	public void StrafingIsDrawnCloserThanByAStraightLine() {
		// A bhop with strafes: hold jump, alternate A and D each half second while turning 220°/s.
		// The forecast can't know the turn, but it does know the hops and the strafe already held.
		var settings = MovementSettings.CounterStrikeSource with { AirAccelerate = 1000, AutoBhop = true };
		var move = Movement(settings);
		var forecast = Movement(settings);
		var player = new PlayerMoveState { Origin = new Vector3(0, 0, 1) };
		var yaw = 0f;
		var inputs = new List<MoveInput>();
		var states = new List<PlayerMoveState>();
		for (var i = 0; i < 64 * 6; i++) {
			var right = i / 32 % 2 == 0;
			var buttons = i < 64 ? MoveButtons.Forward : MoveButtons.Jump | (right ? MoveButtons.MoveRight : MoveButtons.MoveLeft);
			if (i >= 64) yaw += (right ? -220f : 220f) * Tick;
			inputs.Add(MoveInput.FromKeys(buttons, 0, yaw, Tick));
			move.Simulate(player, inputs[^1]);
			states.Add(player.Clone());
		}
		Assert.True(new Vector2(player.Velocity.X, player.Velocity.Y).Length() > 500); // gaining speed

		const int ticks = 17; // a round trip of about 200 ms
		var forecastErrors = new List<float>();
		var lineErrors = new List<float>();
		for (var i = 128; i + ticks < states.Count; i++) {
			var networked = PredictionForecast.NetworkVelocity(forecast, states[i], inputs[i], ticks);
			forecastErrors.Add(Vector3.Distance(Drawn(states[i], networked, ticks), states[i + ticks].Origin));
			lineErrors.Add(Vector3.Distance(Drawn(states[i], states[i].Velocity, ticks), states[i + ticks].Origin));
		}
		forecastErrors.Sort();
		lineErrors.Sort();
		Assert.True(forecastErrors[^1] < lineErrors[^1] * 0.75f, $"worst {forecastErrors[^1]} vs {lineErrors[^1]}");
		Assert.True(forecastErrors[forecastErrors.Count * 9 / 10] < lineErrors[lineErrors.Count * 9 / 10] * 0.85f);
	}

	[Fact]
	public void WithoutPredictionTheVelocityIsThePlayers() {
		var player = new PlayerMoveState { Origin = new Vector3(0, 0, 50), Velocity = new Vector3(300, 0, 100), BaseVelocity = new Vector3(0, 0, 20) };
		var input = MoveInput.FromKeys(MoveButtons.None, 0, 0, Tick);
		Assert.Equal(new Vector3(300, 0, 120), PredictionForecast.NetworkVelocity(Movement(), player, input, 0));
	}

	[Fact]
	public void TheForecastLeavesThePlayerAlone() {
		var player = new PlayerMoveState { Origin = new Vector3(0, 0, 50), Velocity = new Vector3(300, 0, 100) };
		var before = player.Clone();
		PredictionForecast.NetworkVelocity(Movement(), player, MoveInput.FromKeys(MoveButtons.Jump, 0, 0, Tick), 20);
		Assert.Equal(before.Origin, player.Origin);
		Assert.Equal(before.Velocity, player.Velocity);
		Assert.Equal(before.GroundEntity, player.GroundEntity);
	}
}

public class CommandHistoryTests {
	[Fact]
	public void ResentCommandsAreSkippedAndSameTickCommandsAreNot() {
		var seen = new CommandHistory();
		// What a client under 64 fps sends: each packet repeats the last commands, and two commands
		// made in one frame share its tick.
		Assert.True(seen.Add(20670, 801105330));
		Assert.True(seen.Add(20671, 2013586732));
		Assert.True(seen.Add(20672, 284681914));
		Assert.False(seen.Add(20671, 2013586732));
		Assert.False(seen.Add(20672, 284681914));
		Assert.True(seen.Add(20672, 756050782));
		Assert.False(seen.Add(20672, 756050782));
		Assert.True(seen.Add(20673, 1111322956));
	}

	[Fact]
	public void OnlyRecentCommandsAreRemembered() {
		var seen = new CommandHistory(4);
		for (var i = 0; i < 5; i++) Assert.True(seen.Add(i, i));
		Assert.True(seen.Add(0, 0)); // forgotten: long gone from what a client resends
		Assert.False(seen.Add(4, 4));
	}
}
