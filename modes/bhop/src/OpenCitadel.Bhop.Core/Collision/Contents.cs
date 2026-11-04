namespace OpenCitadel.Bhop.Collision;

/// <summary>Source 1 brush contents flags (bspflags.h), as stored in a BSP's brush lump.</summary>
[Flags]
public enum Contents : uint {
	Empty = 0,
	Solid = 0x1,
	Window = 0x2,
	Aux = 0x4,
	Grate = 0x8,
	Slime = 0x10,
	Water = 0x20,
	BlockLos = 0x40,
	Opaque = 0x80,
	TestFogVolume = 0x100,
	Team1 = 0x800,
	Team2 = 0x1000,
	IgnoreNodrawOpaque = 0x2000,
	Moveable = 0x4000,
	AreaPortal = 0x8000,
	PlayerClip = 0x10000,
	MonsterClip = 0x20000,
	Origin = 0x1000000,
	Monster = 0x2000000,
	Debris = 0x4000000,
	Detail = 0x8000000,
	Translucent = 0x10000000,
	Ladder = 0x20000000,
	Hitbox = 0x40000000,
}

/// <summary>Trace masks used by player movement.</summary>
public static class ContentsMask {
	/// <summary>MASK_PLAYERSOLID: everything a player collides with.</summary>
	public const Contents PlayerSolid =
		Contents.Solid | Contents.Moveable | Contents.PlayerClip | Contents.Window | Contents.Monster | Contents.Grate;
}
