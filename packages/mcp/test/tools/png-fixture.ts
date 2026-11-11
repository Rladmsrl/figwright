import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes: Buffer): number => {
  let c = 0xffffffff;
  for (const byte of bytes) c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type: string, body: Buffer): Buffer => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, tail]);
};

export interface PngOptions {
  bitDepth?: number;
  colorType?: number;
  interlace?: number;
  palette?: Buffer;
  transparency?: Buffer;
}

/** A PNG from already-filtered scanlines (each row: its filter byte, then its samples). */
export const pngFromRows = (
  width: number,
  height: number,
  rows: Buffer,
  { bitDepth = 8, colorType = 6, interlace = 0, palette, transparency }: PngOptions = {},
): Buffer => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(bitDepth, 8);
  header.writeUInt8(colorType, 9);
  header.writeUInt8(interlace, 12);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    ...(palette === undefined ? [] : [chunk('PLTE', palette)]),
    ...(transparency === undefined ? [] : [chunk('tRNS', transparency)]),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

/** An 8-bit RGBA PNG painted by a function of the pixel's position. */
export const pngOf = (
  width: number,
  height: number,
  paint: (x: number, y: number) => readonly [number, number, number, number?],
): Buffer => {
  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a = 255] = paint(x, y);
      rows.set([r, g, b, a], y * (width * 4 + 1) + 1 + x * 4);
    }
  }
  return pngFromRows(width, height, rows);
};
