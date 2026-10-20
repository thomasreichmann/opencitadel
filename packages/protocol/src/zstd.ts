/**
 * zstd frames for Deadworks-compatible downloads. The Deadworks launcher only accepts
 * `.vpk.zst` (or `.vpk.bz2`) files, and Node only gained zstd in 22.15. This module uses
 * `zlib.zstdCompressSync` when the runtime has it and otherwise writes a valid zstd frame made
 * of raw (stored) blocks, which every zstd decoder accepts; it is just not smaller. VPKs are
 * mostly already-compressed assets, so the size difference is usually modest.
 *
 * Frame layout (RFC 8878): magic, header descriptor (8-byte content size, no single-segment,
 * no checksum, no dictionary), a window descriptor for a 128 KiB window, then raw blocks of at
 * most 128 KiB, the last one flagged.
 */

import * as zlib from 'node:zlib';
import { Transform, type TransformCallback } from 'node:stream';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const BLOCK_MAX = 128 * 1024;
/** Frame_Content_Size_flag = 3 (8 bytes), everything else off. */
const HEADER_DESCRIPTOR = 0xc0;
/** Window_Log 17 (Exponent 7, Mantissa 0) = 128 KiB, which equals the maximum block size. */
const WINDOW_DESCRIPTOR = 0x38;

export function zstdFrameHeader(contentSize: number): Buffer {
  const header = Buffer.alloc(14);
  MAGIC.copy(header, 0);
  header[4] = HEADER_DESCRIPTOR;
  header[5] = WINDOW_DESCRIPTOR;
  header.writeBigUInt64LE(BigInt(contentSize), 6);
  return header;
}

function blockHeader(size: number, last: boolean): Buffer {
  // Bit 0: Last_Block. Bits 1-2: Block_Type (0 = raw). Bits 3-23: Block_Size.
  const value = (size << 3) | (last ? 1 : 0);
  return Buffer.from([value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff]);
}

/** A zstd frame that stores `data` uncompressed. */
export function zstdStoredFrame(data: Buffer): Buffer {
  const parts: Buffer[] = [zstdFrameHeader(data.length)];
  if (data.length === 0) parts.push(blockHeader(0, true));
  for (let off = 0; off < data.length; off += BLOCK_MAX) {
    const chunk = data.subarray(off, Math.min(off + BLOCK_MAX, data.length));
    parts.push(blockHeader(chunk.length, off + chunk.length >= data.length), chunk);
  }
  return Buffer.concat(parts);
}

const native = (zlib as unknown as { zstdCompressSync?: (b: Buffer) => Buffer }).zstdCompressSync;

/** Real zstd compression when the runtime supports it, else a stored frame. */
export function zstdCompress(data: Buffer): Buffer {
  return native ? native(data) : zstdStoredFrame(data);
}

/**
 * Streams `contentSize` bytes into a stored zstd frame without buffering the whole file. The
 * input must be exactly `contentSize` bytes long; the stream errors otherwise.
 */
export function createZstdStoredStream(contentSize: number): Transform {
  let seen = 0;
  let pending: Buffer = Buffer.alloc(0);
  let headerSent = false;
  const emitBlocks = (stream: Transform, final: boolean) => {
    while (pending.length >= BLOCK_MAX || (final && pending.length > 0)) {
      const chunk = pending.subarray(0, Math.min(BLOCK_MAX, pending.length));
      pending = pending.subarray(chunk.length);
      const last = final && pending.length === 0;
      stream.push(Buffer.concat([blockHeader(chunk.length, last), chunk]));
    }
  };
  return new Transform({
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      if (!headerSent) {
        this.push(zstdFrameHeader(contentSize));
        headerSent = true;
      }
      seen += chunk.length;
      if (seen > contentSize) return cb(new Error(`zstd stream got more than the declared ${contentSize} bytes`));
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      // Hold back the tail so the final block can carry the Last_Block flag.
      if (seen < contentSize) emitBlocks(this, false);
      else emitBlocks(this, true);
      cb();
    },
    flush(cb: TransformCallback) {
      if (!headerSent) {
        this.push(zstdFrameHeader(contentSize));
        headerSent = true;
      }
      if (seen !== contentSize) return cb(new Error(`zstd stream got ${seen} bytes, expected ${contentSize}`));
      if (contentSize === 0) this.push(blockHeader(0, true));
      cb();
    },
  });
}
