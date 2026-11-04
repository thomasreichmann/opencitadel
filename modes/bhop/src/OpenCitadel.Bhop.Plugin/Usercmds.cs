using System.Numerics;
using DeadworksManaged.Api;
using OpenCitadel.Bhop.Movement;

namespace OpenCitadel.Bhop.Plugin;

/// <summary>Reads movement input out of Deadlock usercmds and strips it so the game doesn't act on it.</summary>
internal static class Usercmds {
	/// <summary>Buttons that drive Deadlock's own movement and abilities of movement.</summary>
	private const ulong MovementButtons = (ulong)(InputButton.Jump | InputButton.Duck | InputButton.Forward | InputButton.Back |
		InputButton.MoveLeft | InputButton.MoveRight | InputButton.Speed | InputButton.Mantle | InputButton.MoveUp |
		InputButton.MoveDown | InputButton.DuckToggle | InputButton.JoyAutoSprint | InputButton.Zipline);

	/// <summary>
	/// Bits the jump key sets. Deadlock shares the key between jumping, mantling and grabbing
	/// ziplines, and (build 6842) a player's space press arrives as the mantle and zipline bits
	/// rather than IN_JUMP, so any of them counts as jump.
	/// </summary>
	private const ulong JumpBits = (ulong)(InputButton.Jump | InputButton.Mantle | InputButton.Zipline);

	/// <summary>
	/// The CS:S input for one usercmd. Keyboard players hold direction keys, which become a full
	/// cl_forwardspeed / cl_sidespeed press as in CS:S; analog input scales the same speed.
	/// </summary>
	public static MoveInput Decode(CCitadelUserCmdPB cmd, float frameTime, float inputSpeed) {
		var b = cmd.Base;
		ulong held = b?.ButtonsPb?.Buttonstate1 ?? 0;
		var buttons = MoveButtons.None;
		if ((held & JumpBits) != 0) buttons |= MoveButtons.Jump;
		if ((held & (ulong)InputButton.Duck) != 0) buttons |= MoveButtons.Duck;
		if ((held & (ulong)InputButton.Forward) != 0) buttons |= MoveButtons.Forward;
		if ((held & (ulong)InputButton.Back) != 0) buttons |= MoveButtons.Back;
		if ((held & (ulong)InputButton.MoveLeft) != 0) buttons |= MoveButtons.MoveLeft;
		if ((held & (ulong)InputButton.MoveRight) != 0) buttons |= MoveButtons.MoveRight;

		float forward, side;
		const MoveButtons keys = MoveButtons.Forward | MoveButtons.Back | MoveButtons.MoveLeft | MoveButtons.MoveRight;
		if ((buttons & keys) != 0) {
			forward = ((buttons & MoveButtons.Forward) != 0 ? inputSpeed : 0) - ((buttons & MoveButtons.Back) != 0 ? inputSpeed : 0);
			side = ((buttons & MoveButtons.MoveRight) != 0 ? inputSpeed : 0) - ((buttons & MoveButtons.MoveLeft) != 0 ? inputSpeed : 0);
		} else {
			forward = Math.Clamp(b?.Forwardmove ?? 0f, -1f, 1f) * inputSpeed;
			side = -Math.Clamp(b?.Leftmove ?? 0f, -1f, 1f) * inputSpeed;
		}

		var angles = b?.Viewangles is { } a ? new Vector3(a.X, a.Y, 0) : Vector3.Zero;
		return new MoveInput {
			ViewAngles = angles,
			ForwardMove = forward,
			SideMove = side,
			Buttons = buttons,
			FrameTime = frameTime,
		};
	}

	/// <summary>Removes movement input from a usercmd, so Deadlock's own movement sees a player standing still.</summary>
	public static void Neutralize(CCitadelUserCmdPB cmd) {
		var b = cmd.Base;
		if (b == null) return;
		b.Forwardmove = 0f;
		b.Leftmove = 0f;
		b.Upmove = 0f;
		if (b.ButtonsPb is { } s) {
			s.Buttonstate1 &= ~MovementButtons;
			s.Buttonstate2 &= ~MovementButtons;
			s.Buttonstate3 &= ~MovementButtons;
		}
		// Subtick steps carry button presses and analog movement too.
		for (var i = b.SubtickMoves.Count - 1; i >= 0; i--) {
			var step = b.SubtickMoves[i];
			if ((step.Button & MovementButtons) != 0 || step.AnalogForwardDelta != 0f || step.AnalogLeftDelta != 0f) {
				b.SubtickMoves.RemoveAt(i);
			}
		}
	}
}
