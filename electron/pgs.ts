import fs from 'fs';
import zlib from 'zlib';
import crypto from 'crypto';
import type { SubtitleCue, SubtitleBitmapItem } from './types';

export function isPgsCodec(codec?: string): boolean {
  return /\b(?:hdmv_)?pgs(?:_subtitle|sub)?\b/i.test(codec || '');
}

export function isUnsupportedBitmapCodec(codec?: string): boolean {
  return /\b(?:dvd_subtitle|dvdsub|dvb_subtitle|dvbsub|xsub)\b/i.test(codec || '');
}

interface RawOdsState {
  width: number;
  height: number;
  fragments: Buffer[];
  complete: boolean;
}

export interface PgsObjectRenderRef {
  x: number;
  y: number;
  width: number;
  height: number;
  canvasWidth: number;
  canvasHeight: number;
  palette: Uint8Array; // 256 * 4 RGBA snapshot
  rleFragments: Buffer[];
  rawWidth: number;
  rawHeight: number;
  cropX?: number;
  cropY?: number;
  cropWidth?: number;
  cropHeight?: number;
}

export interface PgsCueEntry {
  id: number;
  start: number;
  end: number;
  canvasWidth: number;
  canvasHeight: number;
  objects: PgsObjectRenderRef[];
}

export interface PgsDataset {
  cues: PgsCueEntry[];
}

const SEG_PDS = 0x14;
const SEG_ODS = 0x15;
const SEG_PCS = 0x16;
const SEG_END = 0x80;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(type: string, data: Buffer): Buffer {
  const lengthBuf = Buffer.allocUnsafe(4);
  lengthBuf.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBody = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.allocUnsafe(4);
  crcBuf.writeUInt32BE(crc32(crcBody), 0);
  return Buffer.concat([lengthBuf, crcBody, crcBuf]);
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Encode tight 8-bit non-interlaced RGBA pixels as a valid PNG buffer. */
export function encodeRgbaPng(width: number, height: number, rgba: Buffer): Buffer {
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.allocUnsafe(height * (1 + stride));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + stride);
    raw[rowStart] = 0; // filter None
    rgba.copy(raw, rowStart + 1, y * stride, (y + 1) * stride);
  }

  const compressed = zlib.deflateSync(raw, { level: 1 });
  return Buffer.concat([
    PNG_SIGNATURE,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', compressed),
    makePngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function clampByte(n: number): number {
  return n < 0 ? 0 : n > 255 ? 255 : n;
}

function decodePalette(
  data: Buffer,
  isHd: boolean,
  existing?: Uint8Array
): Uint8Array {
  // Clone prior palette snapshot so partial updates never mutate earlier cues.
  const pal = existing ? new Uint8Array(existing) : new Uint8Array(256 * 4);
  for (let pos = 2; pos + 5 <= data.length; pos += 5) {
    const idx = data[pos];
    const Y = data[pos + 1];
    const Cr = data[pos + 2];
    const Cb = data[pos + 3];
    const A = data[pos + 4];

    const y = (Y - 16) * (255 / 219);
    const cb = (Cb - 128) * (255 / 224);
    const cr = (Cr - 128) * (255 / 224);

    let r: number;
    let g: number;
    let b: number;
    if (isHd) {
      // ITU-R BT.709 (Blu-ray HD graphics)
      r = Math.round(y + 1.5748 * cr);
      g = Math.round(y - 0.187324 * cb - 0.468124 * cr);
      b = Math.round(y + 1.8556 * cb);
    } else {
      // ITU-R BT.601 (SD graphics)
      r = Math.round(y + 1.402 * cr);
      g = Math.round(y - 0.344136 * cb - 0.714136 * cr);
      b = Math.round(y + 1.772 * cb);
    }

    const base = idx * 4;
    pal[base] = clampByte(r);
    pal[base + 1] = clampByte(g);
    pal[base + 2] = clampByte(b);
    pal[base + 3] = A;
  }
  return pal;
}

/** Decompress a Blu-ray PGS RLE bitmap object (and apply optional crop rect) into RGBA. */
export function decodePgsObjectRgba(spec: PgsObjectRenderRef): {
  width: number;
  height: number;
  rgba: Buffer;
} {
  const { rawWidth, rawHeight, palette, rleFragments } = spec;
  const rle = rleFragments.length === 1 ? rleFragments[0] : Buffer.concat(rleFragments);
  const indexed = new Uint8Array(rawWidth * rawHeight);

  let x = 0;
  let y = 0;
  let i = 0;
  while (i < rle.length && y < rawHeight) {
    const b = rle[i++];
    if (b !== 0x00) {
      if (x < rawWidth) indexed[y * rawWidth + x] = b;
      x += 1;
      continue;
    }

    if (i >= rle.length) break;
    const flag = rle[i++];
    if (flag === 0x00) {
      // End of line
      x = 0;
      y += 1;
      continue;
    }

    const mode = flag & 0xc0;
    let count = 0;
    let color = 0;

    if (mode === 0x00) {
      count = flag & 0x3f;
      color = 0;
    } else if (mode === 0x40) {
      if (i >= rle.length) break;
      count = ((flag & 0x3f) << 8) | rle[i++];
      color = 0;
    } else if (mode === 0x80) {
      if (i >= rle.length) break;
      count = flag & 0x3f;
      color = rle[i++];
    } else {
      if (i + 1 >= rle.length) break;
      count = ((flag & 0x3f) << 8) | rle[i++];
      color = rle[i++];
    }

    if (count > 0 && x < rawWidth) {
      const endX = Math.min(rawWidth, x + count);
      if (color !== 0) {
        indexed.fill(color, y * rawWidth + x, y * rawWidth + endX);
      }
      x = endX;
    }
  }

  const outX = Math.max(0, Math.min(rawWidth - 1, spec.cropX ?? 0));
  const outY = Math.max(0, Math.min(rawHeight - 1, spec.cropY ?? 0));
  const outW = Math.max(1, Math.min(rawWidth - outX, spec.cropWidth ?? rawWidth));
  const outH = Math.max(1, Math.min(rawHeight - outY, spec.cropHeight ?? rawHeight));

  const rgba = Buffer.allocUnsafe(outW * outH * 4);
  for (let row = 0; row < outH; row += 1) {
    const srcRowBase = (outY + row) * rawWidth + outX;
    const dstRowBase = row * outW * 4;
    for (let col = 0; col < outW; col += 1) {
      const palOffset = indexed[srcRowBase + col] * 4;
      const dstOffset = dstRowBase + col * 4;
      rgba[dstOffset] = palette[palOffset];
      rgba[dstOffset + 1] = palette[palOffset + 1];
      rgba[dstOffset + 2] = palette[palOffset + 2];
      rgba[dstOffset + 3] = palette[palOffset + 3];
    }
  }

  return { width: outW, height: outH, rgba };
}

/**
 * Parse a raw Blu-ray PGS (.sup) binary buffer into timed cue descriptors
 * without eagerly decompressing every image frame.
 */
export function parsePgsSupBuffer(supBuf: Buffer): PgsDataset {
  const cues: PgsCueEntry[] = [];
  if (!supBuf || supBuf.length < 13) return { cues };

  const palettes = new Map<number, Uint8Array>();
  const objects = new Map<number, { width: number; height: number; fragments: Buffer[] }>();
  const activeOds = new Map<number, RawOdsState>();

  interface PendingPcsObject {
    objectId: number;
    x: number;
    y: number;
    cropX?: number;
    cropY?: number;
    cropWidth?: number;
    cropHeight?: number;
  }

  interface PendingPcs {
    ptsSec: number;
    canvasWidth: number;
    canvasHeight: number;
    paletteId: number;
    objects: PendingPcsObject[];
  }

  let currentPcs: PendingPcs | null = null;
  let openCue: PgsCueEntry | null = null;
  let nextCueId = 1;
  let off = 0;

  while (off + 13 <= supBuf.length) {
    if (supBuf[off] !== 0x50 || supBuf[off + 1] !== 0x47) {
      // Resynchronize if padding/garbage precedes next PG header
      off += 1;
      continue;
    }

    const ptsTicks = supBuf.readUInt32BE(off + 2);
    const ptsSec = ptsTicks / 90000;
    const segType = supBuf[off + 10];
    const segLen = supBuf.readUInt16BE(off + 11);
    const payloadStart = off + 13;
    const payloadEnd = payloadStart + segLen;
    if (payloadEnd > supBuf.length) break;

    const data = supBuf.subarray(payloadStart, payloadEnd);
    off = payloadEnd;

    if (segType === SEG_PCS && data.length >= 11) {
      const canvasWidth = data.readUInt16BE(0) || 1920;
      const canvasHeight = data.readUInt16BE(2) || 1080;
      const compositionState = data[7];
      const paletteId = data[9];
      const numObjects = data[10];

      // Close any preceding visible cue cleanly at this PCS presentation timestamp
      if (openCue) {
        if (ptsSec > openCue.start) {
          openCue.end = ptsSec;
        } else {
          cues.pop();
        }
        openCue = null;
      }

      if (compositionState === 0x80) {
        // Epoch start resets object & palette cache for subsequent segments
        palettes.clear();
        objects.clear();
        activeOds.clear();
      }

      const pcsObjs: PendingPcsObject[] = [];
      let p = 11;
      for (let i = 0; i < numObjects && p + 8 <= data.length; i += 1) {
        const objectId = data.readUInt16BE(p);
        const cropped = (data[p + 3] & 0x80) !== 0;
        const x = data.readUInt16BE(p + 4);
        const y = data.readUInt16BE(p + 6);
        if (cropped && p + 16 <= data.length) {
          pcsObjs.push({
            objectId,
            x,
            y,
            cropX: data.readUInt16BE(p + 8),
            cropY: data.readUInt16BE(p + 10),
            cropWidth: data.readUInt16BE(p + 12),
            cropHeight: data.readUInt16BE(p + 14),
          });
          p += 16;
        } else {
          pcsObjs.push({ objectId, x, y });
          p += 8;
        }
      }

      currentPcs = {
        ptsSec,
        canvasWidth,
        canvasHeight,
        paletteId,
        objects: pcsObjs,
      };
    } else if (segType === SEG_PDS && data.length >= 2) {
      const pid = data[0];
      const isHd =
        !currentPcs || currentPcs.canvasWidth > 720 || currentPcs.canvasHeight > 576;
      const pal = decodePalette(data, isHd, palettes.get(pid));
      palettes.set(pid, pal);
    } else if (segType === SEG_ODS && data.length >= 4) {
      const objectId = data.readUInt16BE(0);
      const seqFlag = data[3];
      const isFirst = (seqFlag & 0x80) !== 0;
      const isLast = (seqFlag & 0x40) !== 0;

      if (isFirst && data.length >= 11) {
        const width = data.readUInt16BE(7);
        const height = data.readUInt16BE(9);
        const state: RawOdsState = {
          width,
          height,
          fragments: [Buffer.from(data.subarray(11))],
          complete: isLast,
        };
        activeOds.set(objectId, state);
        if (isLast && width > 0 && height > 0) {
          objects.set(objectId, { width, height, fragments: state.fragments });
          activeOds.delete(objectId);
        }
      } else if (!isFirst) {
        const prev = activeOds.get(objectId);
        if (prev) {
          prev.fragments.push(Buffer.from(data.subarray(4)));
          if (isLast) {
            prev.complete = true;
            if (prev.width > 0 && prev.height > 0) {
              objects.set(objectId, {
                width: prev.width,
                height: prev.height,
                fragments: prev.fragments,
              });
            }
            activeOds.delete(objectId);
          }
        }
      }
    } else if (segType === SEG_END) {
      if (currentPcs && currentPcs.objects.length > 0) {
        const pal = palettes.get(currentPcs.paletteId);
        if (pal) {
          const renderRefs: PgsObjectRenderRef[] = [];
          for (const po of currentPcs.objects) {
            const obj = objects.get(po.objectId);
            if (!obj || obj.width <= 0 || obj.height <= 0) continue;
            const width =
              po.cropWidth && po.cropWidth > 0
                ? Math.min(obj.width - (po.cropX || 0), po.cropWidth)
                : obj.width;
            const height =
              po.cropHeight && po.cropHeight > 0
                ? Math.min(obj.height - (po.cropY || 0), po.cropHeight)
                : obj.height;
            if (width <= 0 || height <= 0) continue;
            renderRefs.push({
              x: po.x,
              y: po.y,
              width,
              height,
              canvasWidth: currentPcs.canvasWidth,
              canvasHeight: currentPcs.canvasHeight,
              palette: pal,
              rleFragments: obj.fragments,
              rawWidth: obj.width,
              rawHeight: obj.height,
              cropX: po.cropX,
              cropY: po.cropY,
              cropWidth: po.cropWidth,
              cropHeight: po.cropHeight,
            });
          }

          if (renderRefs.length > 0) {
            const entry: PgsCueEntry = {
              id: nextCueId++,
              start: currentPcs.ptsSec,
              end: currentPcs.ptsSec + 5, // Updated as soon as the clear/next PCS arrives
              canvasWidth: currentPcs.canvasWidth,
              canvasHeight: currentPcs.canvasHeight,
              objects: renderRefs,
            };
            cues.push(entry);
            openCue = entry;
          }
        }
      }
      currentPcs = null;
    }
  }

  return { cues };
}

interface RegisteredSupEntry {
  filePath: string;
  dataset: PgsDataset | null;
}

const MAX_PARSED_DATASETS = 4;
const MAX_PNG_CACHE = 160;
const supRegistry = new Map<string, RegisteredSupEntry>();
const pngCache = new Map<string, Buffer>();

function ensureDatasetLoaded(key: string): PgsDataset | null {
  const entry = supRegistry.get(key);
  if (!entry) return null;

  if (entry.dataset) {
    // Refresh LRU order
    supRegistry.delete(key);
    supRegistry.set(key, entry);
    return entry.dataset;
  }

  try {
    if (!fs.existsSync(entry.filePath)) return null;
    const buf = fs.readFileSync(entry.filePath);
    entry.dataset = parsePgsSupBuffer(buf);
    supRegistry.delete(key);
    supRegistry.set(key, entry);

    // Keep at most MAX_PARSED_DATASETS decoded object tables in memory
    let parsedCount = 0;
    for (const v of supRegistry.values()) {
      if (v.dataset) parsedCount += 1;
    }
    if (parsedCount > MAX_PARSED_DATASETS) {
      for (const [k, v] of supRegistry.entries()) {
        if (k !== key && v.dataset) {
          v.dataset = null;
          parsedCount -= 1;
          if (parsedCount <= MAX_PARSED_DATASETS) break;
        }
      }
    }
    return entry.dataset;
  } catch {
    return null;
  }
}

/**
 * Parse and register a cached `.sup` file with the HTTP PNG server and return
 * lightweight `SubtitleCue[]` descriptors pointing to `/pgs?key=...`.
 */
export function registerPgsSupFile(
  supFilePath: string,
  port: number
): { key: string; cues: SubtitleCue[] } {
  const key = crypto.createHash('md5').update(supFilePath).digest('hex').slice(0, 24);
  if (!supFilePath || !fs.existsSync(supFilePath)) {
    return { key, cues: [] };
  }

  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(supFilePath);
  } catch {}

  if (!stat || stat.size < 13) {
    return { key, cues: [] };
  }

  const existing = supRegistry.get(key);
  if (!existing || !existing.dataset) {
    const buf = fs.readFileSync(supFilePath);
    const dataset = parsePgsSupBuffer(buf);
    supRegistry.set(key, { filePath: supFilePath, dataset });
  }

  const dataset = ensureDatasetLoaded(key);
  if (!dataset || dataset.cues.length === 0) {
    return { key, cues: [] };
  }

  const cues: SubtitleCue[] = dataset.cues.map((entry, cueIdx) => {
    const bitmaps: SubtitleBitmapItem[] = entry.objects.map((obj, objIdx) => ({
      url: `http://127.0.0.1:${port}/pgs?key=${key}&cue=${cueIdx}&obj=${objIdx}`,
      x: obj.x,
      y: obj.y,
      width: obj.width,
      height: obj.height,
      canvasWidth: obj.canvasWidth,
      canvasHeight: obj.canvasHeight,
    }));
    return {
      id: entry.id,
      start: entry.start,
      end: entry.end,
      text: '',
      bitmaps,
    };
  });

  return { key, cues };
}

/** Decode and PNG-encode a single PGS object on demand with bounded LRU caching. */
export function getPgsBitmapPng(
  key: string,
  cueIndex: number,
  objIndex: number
): Buffer | null {
  if (!/^[a-f0-9]{16,32}$/i.test(key)) return null;
  if (!Number.isInteger(cueIndex) || cueIndex < 0) return null;
  if (!Number.isInteger(objIndex) || objIndex < 0) return null;

  const cacheKey = `${key}:${cueIndex}:${objIndex}`;
  const cached = pngCache.get(cacheKey);
  if (cached) {
    pngCache.delete(cacheKey);
    pngCache.set(cacheKey, cached);
    return cached;
  }

  const dataset = ensureDatasetLoaded(key);
  const cue = dataset?.cues[cueIndex];
  const obj = cue?.objects[objIndex];
  if (!obj) return null;

  const { width, height, rgba } = decodePgsObjectRgba(obj);
  const png = encodeRgbaPng(width, height, rgba);

  pngCache.set(cacheKey, png);
  if (pngCache.size > MAX_PNG_CACHE) {
    const oldestKey = pngCache.keys().next().value;
    if (oldestKey !== undefined) pngCache.delete(oldestKey);
  }
  return png;
}
