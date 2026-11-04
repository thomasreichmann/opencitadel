using System.Numerics;
using DeadworksManaged.Api;
using OpenCitadel.Bhop.Collision;
using Trace = OpenCitadel.Bhop.Collision.Trace;

namespace OpenCitadel.Bhop.Plugin;

/// <summary>
/// Collision against the loaded Deadlock map, through the engine's own box traces. Used on maps
/// that have no brush data of their own (stock maps); ported maps collide against their original
/// BSP brushes instead, which is what makes edges behave exactly as in CS:S.
/// </summary>
internal sealed class EngineTraceWorld : ITraceWorld {
	/// <summary>Entity index the traces ignore: the player's own hero.</summary>
	public int IgnoreEntity { get; set; } = -1;

	public unsafe Trace TraceHull(Vector3 start, Vector3 end, Vector3 mins, Vector3 maxs, Contents mask) {
		var ray = new Ray_t();
		ray.Init(mins, maxs);
		var filter = new CTraceFilter(true) {
			IterateEntities = true,
			QueryShapeAttributes = new RnQueryShapeAttr_t {
				ObjectSetMask = RnQueryObjectSet.All,
				InteractsWith = InteractionLayer.Solid | InteractionLayer.PlayerClip | InteractionLayer.Window,
				InteractsExclude = InteractionLayer.None,
				InteractsAs = InteractionLayer.Player,
				CollisionGroup = CollisionGroup.PlayerMovement,
				HitSolid = true,
			},
		};
		if (IgnoreEntity >= 0) filter.QueryShapeAttributes.EntityIdsToIgnore[0] = (uint)IgnoreEntity;

		var tr = CGameTrace.Create();
		DeadworksManaged.Api.Trace.TraceShape(start, end, ray, filter, ref tr);

		var result = new Trace {
			Fraction = tr.Fraction,
			EndPos = tr.Fraction >= 1f ? end : tr.EndPos,
			Normal = tr.DidHit ? tr.HitNormal : Vector3.Zero,
			StartSolid = tr.StartInSolid,
			AllSolid = tr.StartInSolid && tr.Fraction <= 0f,
			Contents = Contents.Solid,
			ModelId = tr.DidHit ? 0 : -1,
		};
		if (result.Fraction < 1f) result.PlaneDist = Vector3.Dot(result.Normal, tr.HitPoint);
		return result;
	}
}
