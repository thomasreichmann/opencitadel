using System.Numerics;

namespace OpenCitadel.Bhop.Movement;

/// <summary>Source's IN_* button bits that movement reads.</summary>
[Flags]
public enum MoveButtons {
	None = 0,
	Jump = 1 << 1,
	Duck = 1 << 2,
	Forward = 1 << 3,
	Back = 1 << 4,
	MoveLeft = 1 << 9,
	MoveRight = 1 << 10,
}

/// <summary>One tick of player input (a CUserCmd's movement part).</summary>
public readonly record struct MoveInput {
	/// <summary>View angles in degrees: X = pitch (down is positive), Y = yaw, Z = roll.</summary>
	public Vector3 ViewAngles { get; init; }
	/// <summary>Forward speed requested, in units per second (positive forward).</summary>
	public float ForwardMove { get; init; }
	/// <summary>Sideways speed requested, in units per second (positive right).</summary>
	public float SideMove { get; init; }
	public MoveButtons Buttons { get; init; }
	/// <summary>Length of the tick in seconds.</summary>
	public float FrameTime { get; init; }

	/// <summary>Input as a keyboard player produces it: full speed for each held movement key.</summary>
	public static MoveInput FromKeys(MoveButtons buttons, float pitch, float yaw, float frameTime, float inputSpeed = 400f) {
		float forward = 0, side = 0;
		if ((buttons & MoveButtons.Forward) != 0) forward += inputSpeed;
		if ((buttons & MoveButtons.Back) != 0) forward -= inputSpeed;
		if ((buttons & MoveButtons.MoveRight) != 0) side += inputSpeed;
		if ((buttons & MoveButtons.MoveLeft) != 0) side -= inputSpeed;
		return new MoveInput {
			ViewAngles = new Vector3(pitch, yaw, 0),
			ForwardMove = forward,
			SideMove = side,
			Buttons = buttons,
			FrameTime = frameTime,
		};
	}
}
