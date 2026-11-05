using System.Numerics;
using OpenCitadel.Bhop.Movement;

namespace OpenCitadel.Bhop.Plugin;

/// <summary>
/// What a player did during one visit, logged when they leave: most outside players left within a
/// minute, and the log said nothing about whether they moved, hopped, fell or ever started a run.
/// </summary>
internal sealed class SessionStats {
	private readonly HashSet<string> _commands = new();
	private int _ticks, _ticksWithKeys, _airTicks, _airStrafeTicks;
	private float _distance, _furthest, _topSpeed, _turned, _lastYaw;
	private int _jumps, _mapTeleports, _runs, _bestCheckpoint, _finishes;
	private Vector3? _origin;
	private bool _haveYaw;

	public int Jumps => _jumps;
	public int MapTeleports => _mapTeleports;
	public float TopSpeed => _topSpeed;

	/// <summary>One simulated usercmd: <paramref name="from"/> is where the player was before it.</summary>
	public void Tick(PlayerMoveState state, in MoveInput input, Vector3 from, bool jumped, bool teleported) {
		_origin ??= from;
		_ticks++;
		if ((input.Buttons & (MoveButtons.Forward | MoveButtons.Back | MoveButtons.MoveLeft | MoveButtons.MoveRight | MoveButtons.Jump)) != 0) _ticksWithKeys++;
		if (!state.OnGround) {
			_airTicks++;
			var left = (input.Buttons & MoveButtons.MoveLeft) != 0;
			var right = (input.Buttons & MoveButtons.MoveRight) != 0;
			if (left != right) _airStrafeTicks++;
		}
		if (jumped) _jumps++;
		if (teleported) _mapTeleports++;
		else _distance += Horizontal(state.Origin - from);
		_furthest = MathF.Max(_furthest, Horizontal(state.Origin - _origin.Value));
		_topSpeed = MathF.Max(_topSpeed, Horizontal(state.Velocity));
		var yaw = input.ViewAngles.Y;
		if (_haveYaw) {
			var delta = MathF.Abs(yaw - _lastYaw) % 360f;
			_turned += delta > 180f ? 360f - delta : delta;
		}
		_lastYaw = yaw;
		_haveYaw = true;
	}

	/// <summary>A player was moved somewhere else (a command, a respawn): not distance travelled.</summary>
	public void Moved() => _haveYaw = false;

	public void RunStarted() => _runs++;
	public void Checkpoint(int checkpoint) => _bestCheckpoint = Math.Max(_bestCheckpoint, checkpoint);
	public void Finished() => _finishes++;
	public void Used(string command) => _commands.Add(command);

	public override string ToString() {
		if (_ticks == 0) return "never moved";
		var seconds = _ticks / 64f;
		var parts = new List<string> {
			$"{seconds:0} s simulated, keys held {Percent(_ticksWithKeys, _ticks)}",
			$"moved {_distance:0} u (at most {_furthest:0} u from where they began), top {_topSpeed:0} u/s",
			$"{_jumps} jumps, {Percent(_airTicks, _ticks)} airborne, strafing {Percent(_airStrafeTicks, _airTicks)} of that",
			$"turned {_turned:0}°",
			$"{_mapTeleports} map teleports",
			_runs == 0 ? "no run started" : $"{_runs} runs started, best checkpoint {_bestCheckpoint}, {_finishes} finished",
		};
		if (_commands.Count > 0) parts.Add("used " + string.Join(" ", _commands.Order().Select(c => "!" + c)));
		return string.Join("; ", parts);
	}

	private static string Percent(int part, int whole) => whole == 0 ? "0 percent" : $"{100.0 * part / whole:0} percent";
	private static float Horizontal(Vector3 v) => MathF.Sqrt(v.X * v.X + v.Y * v.Y);
}
