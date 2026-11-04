using System.Numerics;
using OpenCitadel.Bhop.Collision;
using OpenCitadel.Bhop.Map;
using OpenCitadel.Bhop.Movement;

namespace OpenCitadel.Bhop.Tests;

/// <summary>Map triggers as CS:S bhop maps build them from entity I/O: multihop platforms, boosters.</summary>
public class TriggerTests {
	private const float Dt = 1f / 64f;
	private static readonly MovementSettings Settings = MovementSettings.CounterStrikeSource with { AutoBhop = true };

	private static MapBrush ToMap(Brush b) => new() {
		Contents = (uint)b.Contents,
		Sides = b.Sides.Select(s => new[] { s.Normal.X, s.Normal.Y, s.Normal.Z, s.Dist, s.Bevel ? 1f : 0f }).ToArray(),
		Mins = Vec3.From(b.Mins),
		Maxs = Vec3.From(b.Maxs),
	};

	private static MapTrigger Volume(TriggerKind kind, Vector3 mins, Vector3 maxs) => new() {
		Kind = kind,
		Brushes = [ToMap(Brush.Box(mins, maxs, Contents.Empty))],
		Mins = Vec3.From(mins),
		Maxs = Vec3.From(maxs),
	};

	/// <summary>
	/// A floor (top at z = 0) whose middle strip is a row of multihop platforms the way bhop_arcane,
	/// bhop_badges and bhop_kz_ocean build them: touching renames you "teleport" after 0.09 s and
	/// "default" after 0.1 s, and a teleport filtered on "teleport" covers the same strip.
	/// </summary>
	private static MapRuntime MultihopStrip() {
		var data = new BhopMapData { Name = "test" };
		data.Models.Add(new MapModel { Id = 0, Name = "world", Brushes = [ToMap(Brush.Box(new(-8192, -8192, -64), new(8192, 8192, 0)))] });
		var stones = Volume(TriggerKind.Outputs, new(-4000, -64, 0), new(4000, 64, 2));
		stones.Wait = 0.2f; // a trigger_multiple with wait 0
		stones.Outputs = [
			new TriggerOutput { Event = OutputEvent.Trigger, Action = OutputAction.SetName, Text = "teleport", Delay = 0.09f },
			new TriggerOutput { Event = OutputEvent.Trigger, Action = OutputAction.SetName, Text = "default", Delay = 0.1f },
		];
		var drop = Volume(TriggerKind.Teleport, new(-4000, -64, 0), new(4000, 64, 2));
		drop.Target = "fall";
		drop.Filter = new TriggerFilter { Name = "teleport" };
		data.Triggers.AddRange([stones, drop]);
		data.Destinations.Add(new MapDestination { Name = "fall", Origin = new Vec3(0, 2000, 1) });
		return new MapRuntime(data);
	}

	private static (int Tick, string? Reason)? Play(MapRuntime map, PlayerMoveState p, int ticks, MoveButtons buttons) {
		var move = new CssMovement(Settings, map.World);
		var state = new TriggerState();
		for (var i = 0; i < ticks; i++) {
			move.Simulate(p, MoveInput.FromKeys(buttons, 0, 0, Dt));
			var touch = map.Touch(p, Settings, state, (i + 1) * Dt);
			if (touch.Teleported) return (i, touch.Reason);
		}
		return null;
	}

	[Fact]
	public void StandingOnAMultihopPlatformDropsYouAfterItsDelay() {
		var p = new PlayerMoveState { Origin = new Vector3(0, 0, 1) };
		var dropped = Play(MultihopStrip(), p, 64, MoveButtons.None);
		Assert.NotNull(dropped);
		// Renamed at the end of the first tick ≥ 0.09 s after landing, caught on the next one.
		Assert.InRange(dropped!.Value.Tick, 6, 8);
		Assert.Equal(new Vector3(0, 2000, 1), p.Origin);
	}

	[Fact]
	public void BhoppingOverMultihopPlatformsNeverDropsYou() {
		// Hold jump (autobhop) and run along the strip for five seconds: each landing touches the
		// platform for a tick or two, far less than the 0.09 s it takes to be renamed.
		var p = new PlayerMoveState { Origin = new Vector3(-3000, 0, 1), Velocity = new Vector3(300, 0, 0) };
		Assert.Null(Play(MultihopStrip(), p, 5 * 64, MoveButtons.Jump | MoveButtons.Forward));
		Assert.True(p.Origin.X > -3000 + 800, "the player kept moving along the strip");
	}

	[Fact]
	public void BaseVelocityOutputsKickOnTheNextCommand() {
		// bhop_bubblegum's boosters: "OnEndTouch !activator AddOutput basevelocity 0 0 300".
		var data = new BhopMapData { Name = "test" };
		data.Models.Add(new MapModel { Id = 0, Name = "world", Brushes = [ToMap(Brush.Box(new(-8192, -8192, -64), new(8192, 8192, 0)))] });
		var pad = Volume(TriggerKind.Outputs, new(-64, -64, 0), new(64, 64, 2));
		pad.Outputs = [new TriggerOutput { Event = OutputEvent.EndTouch, Action = OutputAction.SetBaseVelocity, Vector = new Vec3(0, 0, 300) }];
		data.Triggers.Add(pad);
		var map = new MapRuntime(data);
		var move = new CssMovement(Settings, map.World);
		var state = new TriggerState();
		var p = new PlayerMoveState { Origin = new Vector3(0, 0, 1) };

		var tick = 0;
		void Step(MoveButtons b) {
			move.Simulate(p, MoveInput.FromKeys(b, 0, 0, Dt));
			map.Touch(p, Settings, state, ++tick * Dt);
		}
		for (var i = 0; i < 8; i++) Step(MoveButtons.None); // settle on the pad
		Step(MoveButtons.Jump); // jump: still inside the 2-unit pad this tick? leaves on the next
		var before = 0f;
		for (var i = 0; i < 4 && p.BaseVelocity == Vector3.Zero; i++) {
			before = p.Velocity.Z;
			Step(MoveButtons.None);
		}
		Assert.Equal(300f, p.BaseVelocity.Z); // the output ran when the player left the pad
		before = p.Velocity.Z;
		Step(MoveButtons.None); // the next command turns it into a kick: 300 * (1 + dt/2), minus a tick of gravity
		var expected = before + 300f * (1f + Dt * 0.5f) - 800f * Dt;
		Assert.InRange(p.Velocity.Z, expected - 1f, expected + 1f);
		Assert.Equal(Vector3.Zero, p.BaseVelocity);
	}

	[Fact]
	public void LeavingAPushKeepsItsMomentumOnceThenClears() {
		var data = new BhopMapData { Name = "test" };
		data.Models.Add(new MapModel { Id = 0, Name = "world", Brushes = [ToMap(Brush.Box(new(-8192, -8192, -64), new(8192, 8192, 0)))] });
		var push = Volume(TriggerKind.Push, new(-64, -64, 0), new(64, 64, 128));
		push.Vector = new Vec3(400, 0, 0);
		data.Triggers.Add(push);
		var map = new MapRuntime(data);
		var move = new CssMovement(Settings, map.World);
		var state = new TriggerState();
		var p = new PlayerMoveState { Origin = new Vector3(0, 0, 1) };
		// Until the box (16 units either side) is clear of the push, which ends at x = 64.
		for (var i = 0; i < 64 && p.Origin.X <= 64 + 16; i++) {
			move.Simulate(p, MoveInput.FromKeys(MoveButtons.None, 0, 0, Dt));
			map.Touch(p, Settings, state, (i + 1) * Dt);
		}
		Assert.True(p.Origin.X > 64 + 16, "the push carried the player out");
		Assert.Equal(400f, p.BaseVelocity.X); // still the push's, not renewed this tick
		// Out of the push: one more command converts the base velocity, after which it is gone.
		move.Simulate(p, MoveInput.FromKeys(MoveButtons.None, 0, 0, Dt));
		Assert.Equal(Vector3.Zero, p.BaseVelocity);
		Assert.True(p.Velocity.X > 300f, "the exit kept the push's momentum as velocity");
	}

	[Fact]
	public void MapLogicCanRetargetATeleport() {
		// surf_utopia's ground: teleports aimed at a placeholder ("asd") that, on touch, pick a jail
		// cell at random through a logic_case; the teleport fires on the next tick.
		var data = new BhopMapData { Name = "test" };
		data.Models.Add(new MapModel { Id = 0, Name = "world", Brushes = [ToMap(Brush.Box(new(-8192, -8192, -64), new(8192, 8192, 0)))] });
		var ground = Volume(TriggerKind.Teleport, new(-512, -512, 0), new(512, 512, 32));
		ground.Name = "jail_teleport";
		ground.Target = "asd";
		ground.Outputs = [new TriggerOutput { Event = OutputEvent.StartTouch, Action = OutputAction.SetTeleportTarget, Text = "jail_teleport", Choices = ["jail1", "jail2"] }];
		data.Triggers.Add(ground);
		data.Destinations.Add(new MapDestination { Name = "jail1", Origin = new Vec3(3000, 0, 1) });
		data.Destinations.Add(new MapDestination { Name = "jail2", Origin = new Vec3(-3000, 0, 1) });
		var map = new MapRuntime(data);
		var state = new TriggerState();
		var p = new PlayerMoveState { Origin = new Vector3(0, 0, 1) };

		Assert.False(map.Touch(p, Settings, state, Dt).Teleported); // the touch only re-points it
		var next = map.Touch(p, Settings, state, 2 * Dt);
		Assert.True(next.Teleported);
		Assert.Contains(p.Origin.X, new[] { 3000f, -3000f });
	}

	[Theory]
	[InlineData("teleport", false, "teleport", true)]
	[InlineData("teleport", false, "TELEPORT", true)]
	[InlineData("teleport", false, "default", false)]
	[InlineData("teleport", true, "default", true)]
	[InlineData("activator*", false, "activator_boost", true)]
	[InlineData("activator", false, "", false)]
	public void NameFiltersMatchLikeSource(string filter, bool negated, string name, bool passes) =>
		Assert.Equal(passes, new TriggerFilter { Name = filter, Negated = negated }.Passes(name));
}
