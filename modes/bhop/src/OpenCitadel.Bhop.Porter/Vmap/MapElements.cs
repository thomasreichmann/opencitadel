// Element types of Hammer's .vmap document (DMX "vmap" format 29), as far as a generated map needs
// them. Datamodel.NET names each element after its C# class, so the classes carry Valve's names.
// The attribute layout follows ValveResourceFormat's map exporter (MIT, github.com/ValveResourceFormat).

using System.Numerics;
using Datamodel.Format;
using DMElement = Datamodel.Element;

#pragma warning disable CA1050, IDE1006

namespace OpenCitadel.Bhop.Porter.Vmap;

[LowercaseProperties]
public class CMapRootElement : DMElement {
	public bool IsPrefab { get; set; }
	public int EditorBuild { get; set; } = 8600;
	public int EditorVersion { get; set; } = 400;
	public bool ShowGrid { get; set; } = true;
	public int SnapRotationAngle { get; set; } = 15;
	public float GridSpacing { get; set; } = 64;
	public bool Show3DGrid { get; set; } = true;
	[DMProperty(name: "itemFile")] public string ItemFile { get; set; } = "";
	public CStoredCamera DefaultCamera { get; init; } = [];
	[DMProperty(name: "3dcameras")] public CStoredCameras Cameras { get; init; } = [];
	public CMapWorld World { get; init; } = [];
	[DMProperty(name: "visbility")] public CVisibilityMgr Visibility { get; init; } = [];
	[DMProperty(name: "mapVariables")] public CMapVariableSet MapVariables { get; init; } = [];
	[DMProperty(name: "rootSelectionSet")] public CMapSelectionSet RootSelectionSet { get; init; } = [];
	[DMProperty(name: "m_ReferencedMeshSnapshots")] public Datamodel.ElementArray ReferencedMeshSnapshots { get; init; } = [];
	[DMProperty(name: "m_bIsCordoning")] public bool IsCordoning { get; set; }
	[DMProperty(name: "m_bCordonsVisible")] public bool CordonsVisible { get; set; }
	[DMProperty(name: "nodeInstanceData")] public Datamodel.ElementArray NodeInstanceData { get; init; } = [];
}

[LowercaseProperties]
public class CStoredCamera : DMElement {
	public Vector3 Position { get; set; } = new(0, -1000, 1000);
	public Vector3 LookAt { get; set; }
}

[LowercaseProperties]
public class CStoredCameras : DMElement {
	[DMProperty(name: "activecamera")] public int ActiveCameraIndex { get; set; } = -1;
	public Datamodel.ElementArray Cameras { get; init; } = [];
}

[CamelCaseProperties]
public abstract class MapNode : DMElement {
	public Vector3 Origin { get; set; }
	public Datamodel.QAngle Angles { get; set; }
	public Vector3 Scales { get; set; } = new(1, 1, 1);
	public int NodeID { get; set; }
	public ulong ReferenceID { get; set; }
	public Datamodel.ElementArray Children { get; init; } = [];
	public bool EditorOnly { get; set; }
	[DMProperty(name: "force_hidden")] public bool ForceHidden { get; set; }
	public bool TransformLocked { get; set; }
	public Datamodel.StringArray VariableTargetKeys { get; init; } = [];
	public Datamodel.StringArray VariableNames { get; init; } = [];
}

[CamelCaseProperties]
public abstract class BaseEntity : MapNode {
	public DmePlugList RelayPlugData { get; init; } = [];
	public Datamodel.ElementArray ConnectionsData { get; init; } = [];
	[DMProperty(name: "entity_properties")] public EditGameClassProps EntityProperties { get; init; } = [];

	public BaseEntity Set(string key, string value) {
		EntityProperties[key] = value;
		return this;
	}
}

[CamelCaseProperties]
public class DmePlugList : DMElement {
	public Datamodel.StringArray Names { get; init; } = [];
	public Datamodel.IntArray DataTypes { get; init; } = [];
	public Datamodel.IntArray PlugTypes { get; init; } = [];
	public Datamodel.StringArray Descriptions { get; init; } = [];
}

public class EditGameClassProps : DMElement;

[CamelCaseProperties]
public class CMapWorld : BaseEntity {
	public int NextDecalID { get; set; }
	public bool FixupEntityNames { get; set; } = true;
	public string MapUsageType { get; set; } = "standard";

	public CMapWorld() => EntityProperties["classname"] = "worldspawn";
}

[CamelCaseProperties]
public class CVisibilityMgr : MapNode {
	public Datamodel.ElementArray Nodes { get; init; } = [];
	public Datamodel.IntArray HiddenFlags { get; init; } = [];
}

[CamelCaseProperties]
public class CMapVariableSet : DMElement {
	public Datamodel.StringArray VariableNames { get; init; } = [];
	public Datamodel.StringArray VariableValues { get; init; } = [];
	public Datamodel.StringArray VariableTypeNames { get; init; } = [];
	public Datamodel.StringArray VariableTypeParameters { get; init; } = [];
	[DMProperty(name: "m_ChoiceGroups")] public Datamodel.ElementArray ChoiceGroups { get; init; } = [];
}

[CamelCaseProperties]
public class CMapSelectionSet : DMElement {
	public Datamodel.ElementArray Children { get; init; } = [];
	public string SelectionSetName { get; set; } = "";
	public DMElement? SelectionSetData { get; init; } = new CObjectSelectionSetDataElement();
}

[CamelCaseProperties]
public class CObjectSelectionSetDataElement : DMElement {
	public Datamodel.ElementArray SelectedObjects { get; init; } = [];
}

[CamelCaseProperties]
public class CMapEntity : BaseEntity {
	public Vector3 HitNormal { get; set; }
	public bool IsProceduralEntity { get; set; }
}

[CamelCaseProperties]
public class CMapMesh : MapNode {
	public string CubeMapName { get; set; } = "";
	public string LightGroup { get; set; } = "";
	[DMProperty(name: "visexclude")] public bool VisExclude { get; set; }
	[DMProperty(name: "renderwithdynamic")] public bool RenderWithDynamic { get; set; }
	public bool DisableHeightDisplacement { get; set; }
	[DMProperty(name: "fademindist")] public float FadeMinDist { get; set; } = -1;
	[DMProperty(name: "fademaxdist")] public float FadeMaxDist { get; set; }
	[DMProperty(name: "bakelighting")] public bool BakeLighting { get; set; } = true;
	[DMProperty(name: "precomputelightprobes")] public bool PrecomputeLightProbes { get; set; } = true;
	public bool RenderToCubemaps { get; set; } = true;
	public int DisableShadows { get; set; }
	public float SmoothingAngle { get; set; } = 40f;
	public Datamodel.Color TintColor { get; set; } = new(255, 255, 255, 255);
	[DMProperty(name: "renderAmt")] public int RenderAmount { get; set; } = 255;
	public string PhysicsType { get; set; } = "default";
	public string PhysicsGroup { get; set; } = "";
	public string PhysicsInteractsAs { get; set; } = "";
	public string PhysicsInteractsWith { get; set; } = "";
	public string PhysicsInteractsExclude { get; set; } = "";
	public CDmePolygonMesh MeshData { get; init; } = [];
	public bool UseAsOccluder { get; set; }
	public bool PhysicsSimplificationOverride { get; set; }
	public float PhysicsSimplificationError { get; set; }
}

[CamelCaseProperties]
public class CDmePolygonMesh : DMElement {
	public Datamodel.IntArray VertexEdgeIndices { get; init; } = [];
	public Datamodel.IntArray VertexDataIndices { get; init; } = [];
	public Datamodel.IntArray EdgeVertexIndices { get; init; } = [];
	public Datamodel.IntArray EdgeOppositeIndices { get; init; } = [];
	public Datamodel.IntArray EdgeNextIndices { get; init; } = [];
	public Datamodel.IntArray EdgeFaceIndices { get; init; } = [];
	public Datamodel.IntArray EdgeDataIndices { get; init; } = [];
	public Datamodel.IntArray EdgeVertexDataIndices { get; init; } = [];
	public Datamodel.IntArray FaceEdgeIndices { get; init; } = [];
	public Datamodel.IntArray FaceDataIndices { get; init; } = [];
	public Datamodel.StringArray Materials { get; init; } = [];
	public CDmePolygonMeshDataArray VertexData { get; init; } = [];
	public CDmePolygonMeshDataArray FaceVertexData { get; init; } = [];
	public CDmePolygonMeshDataArray EdgeData { get; init; } = [];
	public CDmePolygonMeshDataArray FaceData { get; init; } = [];
	public CDmePolygonMeshSubdivisionData SubdivisionData { get; init; } = [];
}

[CamelCaseProperties]
public class CDmePolygonMeshDataArray : DMElement {
	public int Size { get; set; }
	public Datamodel.ElementArray Streams { get; init; } = [];
}

[CamelCaseProperties]
public class CDmePolygonMeshSubdivisionData : DMElement {
	public Datamodel.IntArray SubdivisionLevels { get; init; } = [];
	public Datamodel.ElementArray Streams { get; init; } = [];
}

[CamelCaseProperties]
public class CDmePolygonMeshDataStream : DMElement {
	public string StandardAttributeName { get; set; } = "";
	public string SemanticName { get; set; } = "";
	public int SemanticIndex { get; set; }
	public int VertexBufferLocation { get; set; }
	public int DataStateFlags { get; set; }
	public DMElement? SubdivisionBinding { get; init; }
	public System.Collections.IList? Data { get; init; }
}
