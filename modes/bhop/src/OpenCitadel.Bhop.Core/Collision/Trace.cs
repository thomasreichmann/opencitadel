using System.Numerics;

namespace OpenCitadel.Bhop.Collision;

/// <summary>The result of sweeping a box through the world, with Source 1's trace_t semantics.</summary>
public struct Trace {
	/// <summary>How far along start→end the box got before hitting something, 0..1.</summary>
	public float Fraction;
	/// <summary>Where the box ended: start + Fraction × (end − start), or exactly end when Fraction is 1.</summary>
	public Vector3 EndPos;
	/// <summary>Normal of the plane that was hit. Zero when nothing was hit.</summary>
	public Vector3 Normal;
	/// <summary>Distance of the plane that was hit (unexpanded).</summary>
	public float PlaneDist;
	/// <summary>The box started inside a brush.</summary>
	public bool StartSolid;
	/// <summary>The box was inside brushes for the whole sweep.</summary>
	public bool AllSolid;
	/// <summary>Contents of the brush that was hit.</summary>
	public Contents Contents;
	/// <summary>Id of the model that was hit (0 = world), or -1 for none.</summary>
	public int ModelId;

	/// <summary>Source's DidHit(): the sweep was stopped or started in solid.</summary>
	public readonly bool DidHit => Fraction < 1f || AllSolid || StartSolid;

	public static Trace Clear(Vector3 end) => new() { Fraction = 1f, EndPos = end, ModelId = -1 };
}

/// <summary>Something player movement can sweep a box through.</summary>
public interface ITraceWorld {
	/// <summary>Sweeps the box [mins, maxs] (relative to the origin) from start to end.</summary>
	Trace TraceHull(Vector3 start, Vector3 end, Vector3 mins, Vector3 maxs, Contents mask);
}
