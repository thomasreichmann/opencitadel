using System.Numerics;

namespace OpenCitadel.Bhop.Movement;

/// <summary>
/// The velocity to network for a player so that their own client draws them where they are.
/// <para>
/// With prediction on, a Deadlock client draws its hero ahead of the last state the server sent:
/// it runs the commands the server hasn't answered yet through its own movement, which for a hero
/// in noclip (as exact mode keeps them) is a straight line at the networked velocity. A player far
/// from the server predicts many ticks ahead, and their real path bends away from that line: a
/// falling player's line goes through the floor, by their fall speed times the prediction time,
/// before the server's answer pulls them back up.
/// </para>
/// <para>
/// So instead of the player's velocity, the server sends the one that takes the line to where the
/// simulation takes the player over the client's prediction time, with the last input held. The
/// client then draws the player on their real path, and only what they do differently in that time
/// (a new strafe, letting go of jump) shows up late.
/// </para>
/// </summary>
public static class PredictionForecast {
	/// <summary>The most ticks forecast: half a second at 64 ticks.</summary>
	public const int MaxTicks = 32;

	/// <param name="movement">
	/// A movement instance for forecasting only, with the same settings and world as the real one
	/// (movement keeps a little state between ticks that a forecast mustn't disturb).
	/// </param>
	/// <param name="player">The player's state now; not changed.</param>
	/// <param name="input">The player's last input, held for the whole forecast.</param>
	/// <param name="ticks">How many ticks ahead the client predicts.</param>
	public static Vector3 NetworkVelocity(CssMovement movement, PlayerMoveState player, in MoveInput input, int ticks) {
		var velocity = player.Velocity + player.BaseVelocity;
		ticks = Math.Min(ticks, MaxTicks);
		if (ticks <= 0 || input.FrameTime <= 0) return velocity;
		var future = player.Clone();
		for (var i = 0; i < ticks; i++) movement.Simulate(future, input);
		return (future.Origin - player.Origin) / (ticks * input.FrameTime);
	}
}
