using System.Numerics;

namespace OpenCitadel.Bhop.Collision;

/// <summary>
/// A set of brushes that moves as one: the world (id 0) or a brush entity such as a func_door or
/// func_wall. Brushes are stored relative to <see cref="Origin"/>.
/// </summary>
public sealed class BrushModel {
	public int Id { get; }
	public string Name { get; }
	public Vector3 Origin { get; set; }
	/// <summary>Whether traces collide with this model.</summary>
	public bool Solid { get; set; } = true;
	public IReadOnlyList<Brush> Brushes => _tree.Brushes;
	public Vector3 Mins => _tree.Mins;
	public Vector3 Maxs => _tree.Maxs;

	private readonly BrushTree _tree;

	public BrushModel(int id, string name, IReadOnlyList<Brush> brushes, Vector3 origin = default) {
		Id = id;
		Name = name;
		Origin = origin;
		_tree = new BrushTree(brushes);
	}

	internal void Trace(ref TraceJob job) {
		// Work in model space.
		var start = job.Start - Origin;
		var end = job.End - Origin;
		var sweepMin = Vector3.Min(start, end) - job.Extents;
		var sweepMax = Vector3.Max(start, end) + job.Extents;
		_tree.Query(sweepMin, sweepMax, ref job, start, end, this);
	}
}

/// <summary>A collision world made of brush models, traced with Source 1's brush clipping rules.</summary>
public sealed class CollisionWorld : ITraceWorld {
	private readonly List<BrushModel> _models = new();
	public IReadOnlyList<BrushModel> Models => _models;

	public CollisionWorld() { }
	public CollisionWorld(IEnumerable<BrushModel> models) => _models.AddRange(models);

	public void Add(BrushModel model) => _models.Add(model);
	public BrushModel? Find(int id) => _models.Find(m => m.Id == id);

	public Trace TraceHull(Vector3 start, Vector3 end, Vector3 mins, Vector3 maxs, Contents mask) {
		var job = new TraceJob(start, end, mins, maxs, mask);
		foreach (var model in _models) {
			if (model.Solid) model.Trace(ref job);
		}
		return job.Finish();
	}
}

/// <summary>State of one trace while it is clipped against brushes (Source's TraceInfo_t).</summary>
internal struct TraceJob {
	public const float DistEpsilon = 0.03125f;
	private const float NeverUpdated = -9999f;

	/// <summary>Start and end of the box's center.</summary>
	public Vector3 Start, End;
	public Vector3 Extents;
	public readonly Contents Mask;
	public readonly bool IsPoint;
	private readonly Vector3 _origStart, _origEnd;
	private Trace _trace;
	private float _fractionLeftSolid;

	public TraceJob(Vector3 start, Vector3 end, Vector3 mins, Vector3 maxs, Contents mask) {
		var offset = (mins + maxs) * 0.5f;
		Extents = (maxs - mins) * 0.5f;
		Start = start + offset;
		End = end + offset;
		Mask = mask;
		IsPoint = Extents == Vector3.Zero;
		_origStart = start;
		_origEnd = end;
		_trace = new Trace { Fraction = 1f, ModelId = -1 };
		_fractionLeftSolid = 0f;
	}

	public readonly bool IsAllSolid => _trace.AllSolid;

	public readonly Trace Finish() {
		var t = _trace;
		if (t.AllSolid) t.Fraction = 0f;
		t.EndPos = t.Fraction >= 1f ? _origEnd : _origStart + (_origEnd - _origStart) * t.Fraction;
		if (!t.DidHit) t.ModelId = -1;
		return t;
	}

	/// <summary>CM_ClipBoxToBrush: clips the sweep (in model space) against one brush.</summary>
	public void ClipToBrush(Brush brush, Vector3 start, Vector3 end, BrushModel model) {
		if ((brush.Contents & Mask) == 0) return;
		var sides = brush.Sides;
		if (sides.Length == 0) return;

		var enterFrac = NeverUpdated;
		var leaveFrac = 1f;
		var clipSide = -1;
		var getOut = false;
		var startOut = false;

		for (var i = 0; i < sides.Length; i++) {
			var side = sides[i];
			float dist;
			if (!IsPoint) {
				// Push the plane out by the box's extent along its normal.
				dist = side.Dist + MathF.Abs(side.Normal.X) * Extents.X + MathF.Abs(side.Normal.Y) * Extents.Y + MathF.Abs(side.Normal.Z) * Extents.Z;
			} else {
				if (side.Bevel) continue;
				dist = side.Dist;
			}
			var d1 = Vector3.Dot(start, side.Normal) - dist;
			var d2 = Vector3.Dot(end, side.Normal) - dist;

			if (d1 > 0f) {
				startOut = true;
				if (d2 > 0f) return; // completely in front of this face: no intersection
			} else {
				if (d2 <= 0f) continue;
				getOut = true; // the end point is outside the brush
			}

			if (d1 > d2) {
				// entering
				var f = d1 - DistEpsilon;
				if (f < 0f) f = 0f;
				f /= d1 - d2;
				if (f > enterFrac) {
					enterFrac = f;
					clipSide = i;
				}
			} else {
				// leaving
				var f = (d1 + DistEpsilon) / (d1 - d2);
				if (f < leaveFrac) leaveFrac = f;
			}
		}

		if (IsPoint && startOut && _fractionLeftSolid - enterFrac > 0f) startOut = false;

		if (!startOut) {
			// The sweep started inside this brush.
			_trace.StartSolid = true;
			_trace.Contents = brush.Contents;
			_trace.ModelId = model.Id;
			if (!getOut) {
				_trace.AllSolid = true;
				_trace.Fraction = 0f;
				_fractionLeftSolid = 1f;
			} else if (leaveFrac != 1f && leaveFrac > _fractionLeftSolid) {
				_fractionLeftSolid = leaveFrac;
				if (_trace.Fraction <= leaveFrac) _trace.Fraction = 1f;
			}
			return;
		}

		if (enterFrac < leaveFrac && enterFrac > NeverUpdated && enterFrac < _trace.Fraction) {
			if (enterFrac < 0f) enterFrac = 0f;
			_trace.Fraction = enterFrac;
			_trace.Normal = sides[clipSide].Normal;
			_trace.PlaneDist = sides[clipSide].Dist + Vector3.Dot(sides[clipSide].Normal, model.Origin);
			_trace.Contents = brush.Contents;
			_trace.ModelId = model.Id;
		}
	}
}

/// <summary>A bounding volume hierarchy over a model's brushes.</summary>
internal sealed class BrushTree {
	private struct Node {
		public Vector3 Mins, Maxs;
		public int Left, Right; // child node indices, -1 for a leaf
		public int First, Count; // brush range for leaves
	}

	private const int LeafSize = 4;
	private readonly Brush[] _brushes;
	private readonly List<Node> _nodes = new();

	public IReadOnlyList<Brush> Brushes => _brushes;
	public Vector3 Mins => _nodes.Count > 0 ? _nodes[0].Mins : Vector3.Zero;
	public Vector3 Maxs => _nodes.Count > 0 ? _nodes[0].Maxs : Vector3.Zero;

	public BrushTree(IReadOnlyList<Brush> brushes) {
		_brushes = brushes.ToArray();
		if (_brushes.Length > 0) Build(0, _brushes.Length);
	}

	private int Build(int first, int count) {
		var mins = new Vector3(float.MaxValue);
		var maxs = new Vector3(float.MinValue);
		for (var i = first; i < first + count; i++) {
			mins = Vector3.Min(mins, _brushes[i].Mins);
			maxs = Vector3.Max(maxs, _brushes[i].Maxs);
		}
		var index = _nodes.Count;
		_nodes.Add(new Node { Mins = mins, Maxs = maxs, Left = -1, Right = -1, First = first, Count = count });
		if (count <= LeafSize) return index;

		var size = maxs - mins;
		var axis = size.X >= size.Y && size.X >= size.Z ? 0 : size.Y >= size.Z ? 1 : 2;
		Array.Sort(_brushes, first, count, Comparer<Brush>.Create((a, b) =>
			(a.Mins[axis] + a.Maxs[axis]).CompareTo(b.Mins[axis] + b.Maxs[axis])));
		var half = count / 2;
		var left = Build(first, half);
		var right = Build(first + half, count - half);
		var node = _nodes[index];
		node.Left = left;
		node.Right = right;
		node.Count = 0;
		_nodes[index] = node;
		return index;
	}

	public void Query(Vector3 sweepMin, Vector3 sweepMax, ref TraceJob job, Vector3 start, Vector3 end, BrushModel model) {
		if (_nodes.Count == 0) return;
		Span<int> stack = stackalloc int[64];
		var top = 0;
		stack[top++] = 0;
		while (top > 0) {
			var node = _nodes[stack[--top]];
			// A little slack so brushes touching the sweep's edge still get clipped.
			if (node.Mins.X > sweepMax.X + 1f || node.Maxs.X < sweepMin.X - 1f ||
			    node.Mins.Y > sweepMax.Y + 1f || node.Maxs.Y < sweepMin.Y - 1f ||
			    node.Mins.Z > sweepMax.Z + 1f || node.Maxs.Z < sweepMin.Z - 1f) continue;
			if (node.Left < 0) {
				for (var i = node.First; i < node.First + node.Count; i++) job.ClipToBrush(_brushes[i], start, end, model);
				if (job.IsAllSolid) return;
			} else {
				stack[top++] = node.Left;
				stack[top++] = node.Right;
			}
		}
	}
}
