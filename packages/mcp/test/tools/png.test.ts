import { describe, expect, it } from 'vitest';

import { decodePng } from '../../src/tools/png.js';
import { pngFromRows, pngOf } from './png-fixture.js';

describe('decodePng', () => {
  it('reads an 8-bit RGBA image as written', () => {
    const png = pngOf(3, 2, (x, y) => [x * 100, y * 200, 7, 255 - x]);
    const raster = decodePng(png);
    expect([raster.width, raster.height]).toEqual([3, 2]);
    expect([...raster.data.subarray(0, 8)]).toEqual([0, 0, 7, 255, 100, 0, 7, 254]);
    expect([...raster.data.subarray(20, 24)]).toEqual([200, 200, 7, 253]);
  });

  it('undoes every row filter', () => {
    // One RGB row per filter type, each encoding the same pixels (10, 20, 30) (13, 24, 35).
    const rows = Buffer.from(
      [
        [0, 10, 20, 30, 13, 24, 35], // none
        [1, 10, 20, 30, 3, 4, 5], // sub: left
        [2, 0, 0, 0, 0, 0, 0], // up
        [3, 5, 10, 15, 2, 2, 3], // average of left and up, floored
        [4, 0, 0, 0, 0, 0, 0], // paeth: picks up here
      ].flat(),
    );
    const { data } = decodePng(pngFromRows(2, 5, rows, { colorType: 2 }));
    for (let y = 0; y < 5; y++) {
      expect([...data.subarray(y * 8, y * 8 + 8)]).toEqual([10, 20, 30, 255, 13, 24, 35, 255]);
    }
  });

  it('reads grey, grey + alpha, 16-bit and palette images', () => {
    const grey = decodePng(pngFromRows(2, 1, Buffer.from([0, 0, 200]), { colorType: 0 }));
    expect([...grey.data]).toEqual([0, 0, 0, 255, 200, 200, 200, 255]);

    const greyAlpha = decodePng(pngFromRows(1, 1, Buffer.from([0, 90, 128]), { colorType: 4 }));
    expect([...greyAlpha.data]).toEqual([90, 90, 90, 128]);

    // 16 bits per sample: the high byte is the 8-bit value.
    const deep = decodePng(
      pngFromRows(1, 1, Buffer.from([0, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc]), {
        colorType: 2,
        bitDepth: 16,
      }),
    );
    expect([...deep.data]).toEqual([0x12, 0x56, 0x9a, 255]);

    // A 2-bit palette: four pixels in one byte, the second entry half transparent.
    const indexed = decodePng(
      pngFromRows(4, 1, Buffer.from([0, 0b00011011]), {
        colorType: 3,
        bitDepth: 2,
        palette: Buffer.from([1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4]),
        transparency: Buffer.from([255, 128]),
      }),
    );
    expect([...indexed.data]).toEqual([1, 1, 1, 255, 2, 2, 2, 128, 3, 3, 3, 255, 4, 4, 4, 255]);

    // 1-bit grey scales to black and white.
    const bilevel = decodePng(
      pngFromRows(3, 1, Buffer.from([0, 0b10100000]), { colorType: 0, bitDepth: 1 }),
    );
    expect([...bilevel.data].filter((_, i) => i % 4 === 0)).toEqual([255, 0, 255]);
  });

  it('refuses what it cannot read, by name', () => {
    expect(() => decodePng(Buffer.from('GIF89a'))).toThrow('not a PNG');
    expect(() =>
      decodePng(pngFromRows(1, 1, Buffer.from([0, 1, 2, 3, 4]), { interlace: 1 })),
    ).toThrow('interlaced');
    expect(() => decodePng(pngFromRows(1, 1, Buffer.from([9, 1, 2, 3, 4])))).toThrow(
      'unknown row filter 9',
    );
  });
});
