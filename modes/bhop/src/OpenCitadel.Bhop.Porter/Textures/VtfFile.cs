using System.Buffers.Binary;

namespace OpenCitadel.Bhop.Porter.Textures;

/// <summary>An RGBA8 image, rows top to bottom.</summary>
public sealed record Image(int Width, int Height, byte[] Rgba) {
	public bool HasAlpha {
		get {
			for (var i = 3; i < Rgba.Length; i += 4) if (Rgba[i] != 255) return true;
			return false;
		}
	}
}

/// <summary>
/// Reads Source 1 textures (VTF 7.0–7.5): the largest mip of the first frame, decoded to RGBA8.
/// Covers the formats maps use: DXT1/3/5 and the 8-bit-per-channel and packed RGB layouts.
/// </summary>
public static class VtfFile {
	private enum Format {
		RGBA8888 = 0, ABGR8888 = 1, RGB888 = 2, BGR888 = 3, RGB565 = 4, I8 = 5, IA88 = 6, P8 = 7, A8 = 8,
		RGB888Bluescreen = 9, BGR888Bluescreen = 10, ARGB8888 = 11, BGRA8888 = 12, DXT1 = 13, DXT3 = 14, DXT5 = 15,
		BGRX8888 = 16, BGR565 = 17, BGRX5551 = 18, BGRA4444 = 19, DXT1OneBitAlpha = 20, BGRA5551 = 21, UV88 = 22,
		UVWQ8888 = 23, RGBA16161616F = 24, RGBA16161616 = 25, UVLX8888 = 26,
	}

	private const int EnvMapFlag = 0x4000;

	public static Image Decode(byte[] data) {
		if (data.Length < 64 || data[0] != 'V' || data[1] != 'T' || data[2] != 'F') throw new InvalidDataException("Not a VTF file.");
		var minor = BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(8));
		var headerSize = BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(12));
		int width = BinaryPrimitives.ReadUInt16LittleEndian(data.AsSpan(16));
		int height = BinaryPrimitives.ReadUInt16LittleEndian(data.AsSpan(18));
		var flags = BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(20));
		int frames = Math.Max((ushort)1, BinaryPrimitives.ReadUInt16LittleEndian(data.AsSpan(24)));
		var format = (Format)BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(52));
		int mipCount = data[56];
		var lowFormat = BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(57));
		int lowWidth = data[61], lowHeight = data[62];
		var depth = minor >= 2 ? Math.Max((ushort)1, BinaryPrimitives.ReadUInt16LittleEndian(data.AsSpan(63))) : 1;
		var faces = (flags & EnvMapFlag) != 0 ? (minor < 5 ? 7 : 6) : 1;

		int imageStart;
		if (minor >= 3) {
			var resources = BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(68));
			imageStart = -1;
			for (var i = 0; i < resources; i++) {
				var entry = 80 + i * 8;
				if (data[entry] == 0x30 && data[entry + 1] == 0 && data[entry + 2] == 0) {
					imageStart = BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(entry + 4));
				}
			}
			if (imageStart < 0) throw new InvalidDataException("VTF has no high-resolution image.");
		} else {
			var lowSize = lowFormat < 0 || lowWidth == 0 ? 0 : ImageSize((Format)lowFormat, lowWidth, lowHeight);
			imageStart = headerSize + lowSize;
		}

		// Mips are stored smallest first; the full-size one is last.
		var offset = imageStart;
		for (var mip = mipCount - 1; mip >= 1; mip--) {
			offset += frames * faces * depth * ImageSize(format, Math.Max(1, width >> mip), Math.Max(1, height >> mip));
		}
		var size = ImageSize(format, width, height);
		if (offset + size > data.Length) throw new InvalidDataException("VTF image data is truncated.");
		return new Image(width, height, DecodeImage(format, data.AsSpan(offset, size), width, height));
	}

	private static int ImageSize(Format f, int w, int h) => f switch {
		Format.DXT1 or Format.DXT1OneBitAlpha => Math.Max(1, (w + 3) / 4) * Math.Max(1, (h + 3) / 4) * 8,
		Format.DXT3 or Format.DXT5 => Math.Max(1, (w + 3) / 4) * Math.Max(1, (h + 3) / 4) * 16,
		_ => w * h * BytesPerPixel(f),
	};

	private static int BytesPerPixel(Format f) => f switch {
		Format.RGBA8888 or Format.ABGR8888 or Format.ARGB8888 or Format.BGRA8888 or Format.BGRX8888 or Format.UVWQ8888 or Format.UVLX8888 => 4,
		Format.RGB888 or Format.BGR888 or Format.RGB888Bluescreen or Format.BGR888Bluescreen => 3,
		Format.RGB565 or Format.BGR565 or Format.BGRX5551 or Format.BGRA4444 or Format.BGRA5551 or Format.IA88 or Format.UV88 => 2,
		Format.I8 or Format.A8 or Format.P8 => 1,
		Format.RGBA16161616F or Format.RGBA16161616 => 8,
		_ => throw new InvalidDataException($"Unsupported VTF format {f}."),
	};

	private static byte[] DecodeImage(Format f, ReadOnlySpan<byte> src, int w, int h) {
		var dst = new byte[w * h * 4];
		switch (f) {
			case Format.DXT1:
			case Format.DXT1OneBitAlpha:
			case Format.DXT3:
			case Format.DXT5:
				DecodeDxt(f, src, w, h, dst);
				return dst;
		}
		for (int i = 0, p = 0; i < w * h; i++, p += 4) {
			byte r, g, b, a = 255;
			switch (f) {
				case Format.RGBA8888: r = src[i * 4]; g = src[i * 4 + 1]; b = src[i * 4 + 2]; a = src[i * 4 + 3]; break;
				case Format.ABGR8888: a = src[i * 4]; b = src[i * 4 + 1]; g = src[i * 4 + 2]; r = src[i * 4 + 3]; break;
				case Format.ARGB8888: a = src[i * 4]; r = src[i * 4 + 1]; g = src[i * 4 + 2]; b = src[i * 4 + 3]; break;
				case Format.BGRA8888: b = src[i * 4]; g = src[i * 4 + 1]; r = src[i * 4 + 2]; a = src[i * 4 + 3]; break;
				case Format.BGRX8888: b = src[i * 4]; g = src[i * 4 + 1]; r = src[i * 4 + 2]; break;
				case Format.RGB888: r = src[i * 3]; g = src[i * 3 + 1]; b = src[i * 3 + 2]; break;
				case Format.RGB888Bluescreen:
					r = src[i * 3]; g = src[i * 3 + 1]; b = src[i * 3 + 2];
					if (r == 0 && g == 0 && b == 255) a = 0;
					break;
				case Format.BGR888: b = src[i * 3]; g = src[i * 3 + 1]; r = src[i * 3 + 2]; break;
				case Format.BGR888Bluescreen:
					b = src[i * 3]; g = src[i * 3 + 1]; r = src[i * 3 + 2];
					if (r == 0 && g == 0 && b == 255) a = 0;
					break;
				case Format.RGB565: {
					var v = BinaryPrimitives.ReadUInt16LittleEndian(src[(i * 2)..]);
					r = Expand5((v >> 11) & 31); g = Expand6((v >> 5) & 63); b = Expand5(v & 31);
					break;
				}
				case Format.BGR565: {
					var v = BinaryPrimitives.ReadUInt16LittleEndian(src[(i * 2)..]);
					b = Expand5((v >> 11) & 31); g = Expand6((v >> 5) & 63); r = Expand5(v & 31);
					break;
				}
				case Format.BGRA5551:
				case Format.BGRX5551: {
					var v = BinaryPrimitives.ReadUInt16LittleEndian(src[(i * 2)..]);
					b = Expand5(v & 31); g = Expand5((v >> 5) & 31); r = Expand5((v >> 10) & 31);
					if (f == Format.BGRA5551) a = (byte)((v & 0x8000) != 0 ? 255 : 0);
					break;
				}
				case Format.BGRA4444: {
					var v = BinaryPrimitives.ReadUInt16LittleEndian(src[(i * 2)..]);
					b = (byte)((v & 15) * 17); g = (byte)(((v >> 4) & 15) * 17); r = (byte)(((v >> 8) & 15) * 17); a = (byte)(((v >> 12) & 15) * 17);
					break;
				}
				case Format.I8: r = g = b = src[i]; break;
				case Format.A8: r = g = b = 255; a = src[i]; break;
				case Format.IA88: r = g = b = src[i * 2]; a = src[i * 2 + 1]; break;
				case Format.UV88: r = src[i * 2]; g = src[i * 2 + 1]; b = 255; break;
				case Format.UVWQ8888:
				case Format.UVLX8888: r = src[i * 4]; g = src[i * 4 + 1]; b = src[i * 4 + 2]; a = src[i * 4 + 3]; break;
				case Format.RGBA16161616F: {
					// HDR: tone down to 8 bits with a plain clamp.
					r = HalfToByte(src[(i * 8)..]); g = HalfToByte(src[(i * 8 + 2)..]); b = HalfToByte(src[(i * 8 + 4)..]);
					break;
				}
				case Format.RGBA16161616:
					r = src[i * 8 + 1]; g = src[i * 8 + 3]; b = src[i * 8 + 5]; a = src[i * 8 + 7];
					break;
				default: throw new InvalidDataException($"Unsupported VTF format {f}.");
			}
			dst[p] = r; dst[p + 1] = g; dst[p + 2] = b; dst[p + 3] = a;
		}
		return dst;
	}

	private static byte Expand5(int v) => (byte)((v << 3) | (v >> 2));
	private static byte Expand6(int v) => (byte)((v << 2) | (v >> 4));
	private static byte HalfToByte(ReadOnlySpan<byte> s) =>
		(byte)Math.Clamp((int)MathF.Round((float)BitConverter.UInt16BitsToHalf(BinaryPrimitives.ReadUInt16LittleEndian(s)) * 255f), 0, 255);

	private static void DecodeDxt(Format f, ReadOnlySpan<byte> src, int w, int h, byte[] dst) {
		var blockSize = f is Format.DXT1 or Format.DXT1OneBitAlpha ? 8 : 16;
		var bw = Math.Max(1, (w + 3) / 4);
		var bh = Math.Max(1, (h + 3) / 4);
		Span<byte> colors = stackalloc byte[16];
		Span<byte> alpha = stackalloc byte[16];
		for (var by = 0; by < bh; by++) {
			for (var bx = 0; bx < bw; bx++) {
				var block = src.Slice((by * bw + bx) * blockSize, blockSize);
				var colorBlock = blockSize == 16 ? block[8..] : block;
				alpha.Fill(255);
				if (f == Format.DXT3) {
					for (var i = 0; i < 16; i++) alpha[i] = (byte)(((block[i / 2] >> ((i & 1) * 4)) & 15) * 17);
				} else if (f == Format.DXT5) {
					DecodeDxt5Alpha(block, alpha);
				}
				var c0 = BinaryPrimitives.ReadUInt16LittleEndian(colorBlock);
				var c1 = BinaryPrimitives.ReadUInt16LittleEndian(colorBlock[2..]);
				Rgb565(c0, colors[..4]);
				Rgb565(c1, colors.Slice(4, 4));
				var fourColor = c0 > c1 || f is Format.DXT3 or Format.DXT5;
				for (var k = 0; k < 3; k++) {
					if (fourColor) {
						colors[8 + k] = (byte)((2 * colors[k] + colors[4 + k]) / 3);
						colors[12 + k] = (byte)((colors[k] + 2 * colors[4 + k]) / 3);
					} else {
						colors[8 + k] = (byte)((colors[k] + colors[4 + k]) / 2);
						colors[12 + k] = 0;
					}
				}
				colors[11] = 255;
				colors[15] = (byte)(fourColor ? 255 : 0);
				var indices = BinaryPrimitives.ReadUInt32LittleEndian(colorBlock[4..]);
				for (var i = 0; i < 16; i++) {
					var x = bx * 4 + (i & 3);
					var y = by * 4 + (i >> 2);
					if (x >= w || y >= h) continue;
					var idx = (int)((indices >> (2 * i)) & 3);
					var p = (y * w + x) * 4;
					dst[p] = colors[idx * 4];
					dst[p + 1] = colors[idx * 4 + 1];
					dst[p + 2] = colors[idx * 4 + 2];
					dst[p + 3] = (byte)(colors[idx * 4 + 3] == 0 ? 0 : alpha[i]);
				}
			}
		}
	}

	private static void Rgb565(ushort v, Span<byte> rgba) {
		rgba[0] = Expand5((v >> 11) & 31);
		rgba[1] = Expand6((v >> 5) & 63);
		rgba[2] = Expand5(v & 31);
		rgba[3] = 255;
	}

	private static void DecodeDxt5Alpha(ReadOnlySpan<byte> block, Span<byte> alpha) {
		int a0 = block[0], a1 = block[1];
		Span<byte> table = stackalloc byte[8];
		table[0] = (byte)a0;
		table[1] = (byte)a1;
		if (a0 > a1) {
			for (var i = 1; i <= 6; i++) table[i + 1] = (byte)(((7 - i) * a0 + i * a1) / 7);
		} else {
			for (var i = 1; i <= 4; i++) table[i + 1] = (byte)(((5 - i) * a0 + i * a1) / 5);
			table[6] = 0;
			table[7] = 255;
		}
		ulong bits = 0;
		for (var i = 0; i < 6; i++) bits |= (ulong)block[2 + i] << (8 * i);
		for (var i = 0; i < 16; i++) alpha[i] = table[(int)((bits >> (3 * i)) & 7)];
	}
}

/// <summary>Writes uncompressed 32-bit TGA files, which Source 2's texture compiler reads.</summary>
public static class Tga {
	public static void Write(string path, Image image) {
		var header = new byte[18];
		header[2] = 2; // uncompressed true-colour
		BinaryPrimitives.WriteUInt16LittleEndian(header.AsSpan(12), (ushort)image.Width);
		BinaryPrimitives.WriteUInt16LittleEndian(header.AsSpan(14), (ushort)image.Height);
		header[16] = 32;
		header[17] = 0x28; // 8 alpha bits, rows top to bottom
		var pixels = new byte[image.Rgba.Length];
		for (var i = 0; i < pixels.Length; i += 4) {
			pixels[i] = image.Rgba[i + 2];
			pixels[i + 1] = image.Rgba[i + 1];
			pixels[i + 2] = image.Rgba[i];
			pixels[i + 3] = image.Rgba[i + 3];
		}
		using var f = File.Create(path);
		f.Write(header);
		f.Write(pixels);
	}
}
