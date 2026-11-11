import { inflateSync } from 'node:zlib';

/** A decoded image: 8-bit RGBA, rows top to bottom. */
export interface Raster {
  width: number;
  height: number;
  data: Uint8Array;
}

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
/** Channels per pixel by PNG colour type: grey, RGB, palette, grey + alpha, RGBA. */
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
// A screenshot is a few million pixels; this refuses a header that claims far more before any
// memory is asked for.
const MAX_PIXELS = 64_000_000;

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
};

/** Undo the per-row filters in place; returns the rows without their filter bytes. */
const unfilter = (raw: Buffer, height: number, stride: number, bpp: number): Buffer => {
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw.readUInt8(y * (stride + 1));
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const value = raw.readUInt8(src + x);
      const left = x >= bpp ? out.readUInt8(dst + x - bpp) : 0;
      const up = y > 0 ? out.readUInt8(dst - stride + x) : 0;
      const upLeft = y > 0 && x >= bpp ? out.readUInt8(dst - stride + x - bpp) : 0;
      let add = 0;
      if (filter === 1) add = left;
      else if (filter === 2) add = up;
      else if (filter === 3) add = (left + up) >> 1;
      else if (filter === 4) add = paeth(left, up, upLeft);
      else if (filter !== 0) throw new Error(`PNG: unknown row filter ${filter}`);
      out.writeUInt8((value + add) & 0xff, dst + x);
    }
  }
  return out;
};

/**
 * Decode a PNG into 8-bit RGBA. Covers what screenshots and Figma exports are written as — every
 * colour type, 1 to 16 bits, a palette with its transparency — and refuses an interlaced file by
 * name rather than decoding it wrong. Values come out as stored: no gamma or colour-profile
 * conversion, so two images are comparable only when they were saved in the same colour space.
 */
export const decodePng = (bytes: Uint8Array): Raster => {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('not a PNG file (only PNG is read)');
  }
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  let palette: Buffer | undefined;
  let transparency: Buffer | undefined;
  const idat: Buffer[] = [];
  for (let at = 8; at + 8 <= buf.length;) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    const body = buf.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body.readUInt8(8);
      colorType = body.readUInt8(9);
      interlace = body.readUInt8(12);
    } else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') transparency = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    at += 12 + length;
  }
  const channels = CHANNELS[colorType];
  if (channels === undefined || width === 0 || height === 0) {
    throw new Error('PNG: missing or unreadable header');
  }
  if (interlace !== 0)
    throw new Error('PNG: interlaced files are not read; save it non-interlaced');
  if (width * height > MAX_PIXELS) throw new Error(`PNG: ${width}×${height} is too large to read`);

  const bitsPerPixel = channels * bitDepth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const rows = unfilter(
    inflateSync(Buffer.concat(idat)),
    height,
    stride,
    Math.max(1, bitsPerPixel >> 3),
  );

  /** Sample `index` of row `y`, scaled to 0–255 (a palette index is returned as it is). */
  const sample = (y: number, index: number): number => {
    const row = y * stride;
    if (bitDepth === 8) return rows.readUInt8(row + index);
    if (bitDepth === 16) return rows.readUInt8(row + index * 2);
    const bit = index * bitDepth;
    const value =
      (rows.readUInt8(row + (bit >> 3)) >> (8 - bitDepth - (bit & 7))) & ((1 << bitDepth) - 1);
    return colorType === 3 ? value : Math.round((value * 255) / ((1 << bitDepth) - 1));
  };

  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r: number;
      let g: number;
      let b: number;
      let a = 255;
      if (colorType === 3) {
        const index = sample(y, x);
        r = palette?.[index * 3] ?? 0;
        g = palette?.[index * 3 + 1] ?? 0;
        b = palette?.[index * 3 + 2] ?? 0;
        a = transparency?.[index] ?? 255;
      } else if (colorType === 0 || colorType === 4) {
        r = g = b = sample(y, x * channels);
        if (colorType === 4) a = sample(y, x * channels + 1);
      } else {
        r = sample(y, x * channels);
        g = sample(y, x * channels + 1);
        b = sample(y, x * channels + 2);
        if (colorType === 6) a = sample(y, x * channels + 3);
      }
      data.set([r, g, b, a], (y * width + x) * 4);
    }
  }
  return { width, height, data };
};
