using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

namespace OpenCitadel.Bhop.Vpk;

/// <summary>
/// Reads and writes single-file Valve packages (VPK version 2 with every file's data inside the
/// directory file, archive index 0x7FFF), the format Source 2 map packages use.
/// </summary>
public static class VpkArchive {
	private const uint Signature = 0x55AA1234;
	private const ushort InlineArchive = 0x7FFF;

	/// <summary>
	/// Lists the files in a VPK and returns a reader for their contents. For a multi-part package
	/// pass its directory file (name_dir.vpk); the data parts (name_000.vpk, ...) are read on demand.
	/// </summary>
	public static VpkReader Open(string path) => new(File.ReadAllBytes(path), path);

	/// <summary>Writes files (keyed by forward-slash path) as a single-file VPK v2 with valid CRCs and MD5s.</summary>
	public static void Write(string path, IReadOnlyDictionary<string, byte[]> files) {
		// Group as the format does: extension, then directory, then file name.
		var tree = new SortedDictionary<string, SortedDictionary<string, SortedDictionary<string, byte[]>>>(StringComparer.Ordinal);
		foreach (var (fullPath, data) in files) {
			var p = fullPath.Replace('\\', '/').TrimStart('/');
			var slash = p.LastIndexOf('/');
			var dir = slash < 0 ? " " : p[..slash];
			var file = slash < 0 ? p : p[(slash + 1)..];
			var dot = file.LastIndexOf('.');
			var ext = dot < 0 ? " " : file[(dot + 1)..];
			var name = dot < 0 ? file : file[..dot];
			if (!tree.TryGetValue(ext, out var dirs)) tree[ext] = dirs = new(StringComparer.Ordinal);
			if (!dirs.TryGetValue(dir, out var names)) dirs[dir] = names = new(StringComparer.Ordinal);
			names[name] = data;
		}

		using var treeStream = new MemoryStream();
		using var dataStream = new MemoryStream();
		Span<byte> entry = stackalloc byte[18];
		foreach (var (ext, dirs) in tree) {
			WriteString(treeStream, ext);
			foreach (var (dir, names) in dirs) {
				WriteString(treeStream, dir);
				foreach (var (name, data) in names) {
					WriteString(treeStream, name);
					BinaryPrimitives.WriteUInt32LittleEndian(entry, Crc32.HashToUInt32(data));
					BinaryPrimitives.WriteUInt16LittleEndian(entry[4..], 0); // preload bytes
					BinaryPrimitives.WriteUInt16LittleEndian(entry[6..], InlineArchive);
					BinaryPrimitives.WriteUInt32LittleEndian(entry[8..], (uint)dataStream.Length);
					BinaryPrimitives.WriteUInt32LittleEndian(entry[12..], (uint)data.Length);
					BinaryPrimitives.WriteUInt16LittleEndian(entry[16..], 0xFFFF);
					treeStream.Write(entry);
					dataStream.Write(data);
				}
				treeStream.WriteByte(0);
			}
			treeStream.WriteByte(0);
		}
		treeStream.WriteByte(0);

		var treeBytes = treeStream.ToArray();
		var dataBytes = dataStream.ToArray();
		var header = new byte[28];
		BinaryPrimitives.WriteUInt32LittleEndian(header, Signature);
		BinaryPrimitives.WriteUInt32LittleEndian(header.AsSpan(4), 2);
		BinaryPrimitives.WriteUInt32LittleEndian(header.AsSpan(8), (uint)treeBytes.Length);
		BinaryPrimitives.WriteUInt32LittleEndian(header.AsSpan(12), (uint)dataBytes.Length);
		BinaryPrimitives.WriteUInt32LittleEndian(header.AsSpan(16), 0); // archive MD5 section (no archives)
		BinaryPrimitives.WriteUInt32LittleEndian(header.AsSpan(20), 48); // other MD5 section
		BinaryPrimitives.WriteUInt32LittleEndian(header.AsSpan(24), 0); // signature section

		// Tree MD5, archive-MD5-section MD5 (of nothing), then the MD5 of everything before it.
		var treeMd5 = MD5.HashData(treeBytes);
		var archiveMd5 = MD5.HashData(ReadOnlySpan<byte>.Empty);
		using var whole = new MemoryStream();
		whole.Write(header);
		whole.Write(treeBytes);
		whole.Write(dataBytes);
		whole.Write(treeMd5);
		whole.Write(archiveMd5);
		var wholeMd5 = MD5.HashData(whole.ToArray());
		whole.Write(wholeMd5);

		var tmp = path + ".tmp";
		File.WriteAllBytes(tmp, whole.ToArray());
		File.Move(tmp, path, overwrite: true);
	}

	private static void WriteString(Stream s, string value) {
		s.Write(Encoding.UTF8.GetBytes(value));
		s.WriteByte(0);
	}
}

/// <summary>CRC-32 (IEEE), as VPK directory entries store it.</summary>
internal static class Crc32 {
	private static readonly uint[] Table = BuildTable();

	private static uint[] BuildTable() {
		var t = new uint[256];
		for (uint i = 0; i < 256; i++) {
			var c = i;
			for (var k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320u ^ (c >> 1) : c >> 1;
			t[i] = c;
		}
		return t;
	}

	public static uint HashToUInt32(ReadOnlySpan<byte> data) {
		var crc = 0xFFFFFFFFu;
		foreach (var b in data) crc = Table[(crc ^ b) & 0xFF] ^ (crc >> 8);
		return ~crc;
	}
}

/// <summary>The files of a VPK whose data is stored inline (or preloaded in the directory).</summary>
public sealed class VpkReader {
	private readonly byte[] _data;
	private readonly int _dataStart;
	private readonly Dictionary<string, (int Offset, int Length, int PreloadOffset, int PreloadLength, ushort Archive)> _entries = new(StringComparer.OrdinalIgnoreCase);

	public IEnumerable<string> Files => _entries.Keys;

	private readonly string? _path;

	internal VpkReader(byte[] data, string? path = null) {
		_data = data;
		_path = path;
		if (data.Length < 12 || BinaryPrimitives.ReadUInt32LittleEndian(data) != 0x55AA1234) throw new InvalidDataException("Not a VPK.");
		var version = BinaryPrimitives.ReadUInt32LittleEndian(data.AsSpan(4));
		var treeSize = (int)BinaryPrimitives.ReadUInt32LittleEndian(data.AsSpan(8));
		var headerSize = version switch { 1 => 12, 2 => 28, _ => throw new InvalidDataException($"VPK version {version} is not supported.") };
		_dataStart = headerSize + treeSize;
		var pos = headerSize;
		while (true) {
			var ext = ReadString(ref pos);
			if (ext.Length == 0) break;
			while (true) {
				var dir = ReadString(ref pos);
				if (dir.Length == 0) break;
				while (true) {
					var name = ReadString(ref pos);
					if (name.Length == 0) break;
					var preload = BinaryPrimitives.ReadUInt16LittleEndian(data.AsSpan(pos + 4));
					var archive = BinaryPrimitives.ReadUInt16LittleEndian(data.AsSpan(pos + 6));
					var offset = (int)BinaryPrimitives.ReadUInt32LittleEndian(data.AsSpan(pos + 8));
					var length = (int)BinaryPrimitives.ReadUInt32LittleEndian(data.AsSpan(pos + 12));
					pos += 18;
					var full = (dir == " " ? "" : dir + "/") + name + (ext == " " ? "" : "." + ext);
					_entries[full] = (offset, length, pos, preload, archive);
					pos += preload;
				}
			}
		}
	}

	public bool Contains(string path) => _entries.ContainsKey(path.Replace('\\', '/'));

	/// <summary>The file's bytes, or null when it isn't in the package (or its data part is missing).</summary>
	public byte[]? Read(string path) {
		if (!_entries.TryGetValue(path.Replace('\\', '/'), out var e)) return null;
		var result = new byte[e.PreloadLength + e.Length];
		_data.AsSpan(e.PreloadOffset, e.PreloadLength).CopyTo(result);
		if (e.Length > 0) {
			if (e.Archive == 0x7FFF) {
				_data.AsSpan(_dataStart + e.Offset, e.Length).CopyTo(result.AsSpan(e.PreloadLength));
			} else {
				var part = PartPath(e.Archive);
				if (part == null || !File.Exists(part)) return null;
				using var f = File.OpenRead(part);
				f.Seek(e.Offset, SeekOrigin.Begin);
				f.ReadExactly(result.AsSpan(e.PreloadLength, e.Length));
			}
		}
		return result;
	}

	/// <summary>name_dir.vpk → name_NNN.vpk.</summary>
	private string? PartPath(int archive) {
		if (_path == null || !_path.EndsWith("_dir.vpk", StringComparison.OrdinalIgnoreCase)) return null;
		return _path[..^"dir.vpk".Length] + archive.ToString("000", System.Globalization.CultureInfo.InvariantCulture) + ".vpk";
	}

	public Dictionary<string, byte[]> ReadAll() {
		var all = new Dictionary<string, byte[]>(StringComparer.OrdinalIgnoreCase);
		foreach (var f in _entries.Keys) {
			if (Read(f) is { } bytes) all[f] = bytes;
		}
		return all;
	}

	private string ReadString(ref int pos) {
		var end = Array.IndexOf(_data, (byte)0, pos);
		if (end < 0) throw new InvalidDataException("VPK directory is truncated.");
		var s = Encoding.UTF8.GetString(_data, pos, end - pos);
		pos = end + 1;
		return s;
	}
}
