namespace OpenCitadel.Bhop.Movement;

/// <summary>
/// The usercmds a player's client has sent lately, to run each one once. Clients send every
/// command again with the next few, in case a packet is lost. Deadlock's commands have no command
/// number, and their client tick doesn't tell them apart either: a client drawing fewer frames
/// than the server runs ticks makes two commands in some frames and labels both with that frame's
/// tick. Each command does carry its own random seed.
/// </summary>
public sealed class CommandHistory {
	private readonly (int Tick, int Seed)[] _recent;
	private int _next;
	private int _count;

	/// <param name="size">How many commands to remember; clients resend only the last few.</param>
	public CommandHistory(int size = 64) => _recent = new (int, int)[size];

	/// <summary>Records a command; false if it was already recorded (a resent copy).</summary>
	public bool Add(int clientTick, int randomSeed) {
		for (var i = 0; i < _count; i++) {
			if (_recent[i] == (clientTick, randomSeed)) return false;
		}
		_recent[_next] = (clientTick, randomSeed);
		_next = (_next + 1) % _recent.Length;
		_count = Math.Min(_count + 1, _recent.Length);
		return true;
	}

	public void Clear() {
		_next = 0;
		_count = 0;
	}
}
