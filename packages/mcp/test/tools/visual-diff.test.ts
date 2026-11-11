import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { decodePng } from '../../src/tools/png.js';
import { compareRasters, handleVisualDiff } from '../../src/tools/visual-diff.js';
import { pngOf } from './png-fixture.js';

type Paint = (x: number, y: number) => readonly [number, number, number, number?];
const raster = (width: number, height: number, paint: Paint) =>
  decodePng(pngOf(width, height, paint));
const flat: Paint = () => [20, 24, 30];

describe('compareRasters', () => {
  it('finds nothing between a design and the same picture taken at another size', () => {
    const page: Paint = (x, y) => (y < 48 ? [200, 60, 60] : x < 96 ? [20, 24, 30] : [60, 200, 90]);
    const r = compareRasters(
      raster(192, 96, page),
      raster(384, 192, (x, y) => page(x >> 1, y >> 1)),
    );
    expect(r).toMatchObject({ compared: 8, different: 0, worst: 0, areas: [] });
    expect(r.image.region).toEqual({ x: 0, y: 0, width: 384, height: 192 });
  });

  // The defect a per-pixel score lets through: nothing moved, a whole band is 12 levels lighter.
  it('reports a band that is only lighter as one area, with how much', () => {
    const r = compareRasters(
      raster(192, 144, flat),
      raster(192, 144, (_, y) => (y >= 48 && y < 96 ? [32, 36, 42] : [20, 24, 30])),
    );
    expect(r.compared).toBe(12);
    expect(r.different).toBe(4);
    expect(r.areas).toEqual([
      {
        x: 0,
        y: 48,
        width: 192,
        height: 48,
        cells: 4,
        delta: [12, 12, 12],
        design: [20, 24, 30],
        actual: [32, 36, 42],
      },
    ]);
  });

  it('keeps apart two defects that do not touch, the worse one first', () => {
    const r = compareRasters(
      raster(192, 96, flat),
      raster(192, 96, (x, y) =>
        x < 48 && y < 48 ? [47, 24, 30] : x >= 144 && y >= 48 ? [20, 24, 60] : [20, 24, 30],
      ),
    );
    expect(r.areas.map(a => [a.x, a.y, a.delta])).toEqual([
      [144, 48, [0, 0, 30]],
      [0, 0, [27, 0, 0]],
    ]);
    expect(r.worst).toBe(30);
  });

  it('stays quiet under the threshold, and follows a threshold and a cell size given', () => {
    const lighter = raster(96, 96, () => [26, 30, 36]);
    expect(compareRasters(raster(96, 96, flat), lighter).different).toBe(0);
    const strict = compareRasters(raster(96, 96, flat), lighter, { threshold: 4, cell: 32 });
    expect([strict.compared, strict.different, strict.areas[0]?.cells]).toEqual([9, 9, 9]);
  });

  it('reads the node from a region of a larger image', () => {
    // The node is the 96 × 48 block drawn at (100, 300) of the screenshot, at twice its size.
    const r = compareRasters(
      raster(96, 48, flat),
      raster(400, 500, (x, y) =>
        x >= 100 && x < 292 && y >= 300 && y < 396 ? [20, 24, 30] : [250, 250, 250],
      ),
      { region: { x: 100, y: 300, width: 192, height: 96 } },
    );
    expect(r).toMatchObject({ compared: 2, different: 0 });
  });

  it('leaves out what is ignored, see-through in the design, or past the image, and says so', () => {
    const design = raster(96, 144, (_, y) => (y < 48 ? [20, 24, 30, 0] : [20, 24, 30]));
    // The image is the node's width and only 96 rows tall: the last row of cells has no picture.
    const r = compareRasters(
      design,
      raster(96, 96, () => [90, 90, 90]),
      {
        ignore: [{ x: 0, y: 48, width: 48, height: 48 }],
      },
    );
    expect(r.skipped).toEqual({ outside: 2, ignored: 1, transparent: 2 });
    expect([r.compared, r.different]).toEqual([1, 1]);
    expect(r.areas[0]).toMatchObject({ x: 48, y: 48, width: 48, height: 48 });
  });
});

describe('handleVisualDiff', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'figwright-visual-diff-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const dispatchOf =
    (bytes: Uint8Array | null, calls: unknown[] = []) =>
    async (tool: string, args: unknown) => {
      calls.push([tool, args]);
      return {
        images: [
          bytes === null
            ? { nodeId: '1:2', format: 'PNG', base64: null }
            : { nodeId: '1:2', format: 'PNG', base64: null, bytes },
        ],
      };
    };

  it('renders the node at one px per design px and compares it with the file', async () => {
    const imagePath = join(dir, 'shot.png');
    await writeFile(
      imagePath,
      pngOf(192, 96, x => (x < 96 ? [20, 24, 30] : [50, 24, 30])),
    );
    const calls: unknown[] = [];
    const r = await handleVisualDiff(dispatchOf(pngOf(96, 48, flat), calls), {
      nodeId: '1:2',
      imagePath,
    });
    expect(calls).toEqual([
      ['get_screenshot', { nodeIds: ['1:2'], format: 'PNG', scale: 1, binary: true }],
    ]);
    expect(r).toMatchObject({
      nodeId: '1:2',
      design: { width: 96, height: 48 },
      image: { width: 192, height: 96 },
      compared: 2,
      different: 1,
      areas: [{ x: 48, y: 0, width: 48, height: 48, delta: [30, 0, 0] }],
    });
  });

  it('names the node it could not render and the file it could not read', async () => {
    const imagePath = join(dir, 'shot.png');
    await writeFile(imagePath, pngOf(4, 4, flat));
    await expect(handleVisualDiff(dispatchOf(null), { nodeId: '1:2', imagePath })).rejects.toThrow(
      'node 1:2 was not found or cannot be exported',
    );

    await writeFile(join(dir, 'shot.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    await expect(
      handleVisualDiff(dispatchOf(pngOf(4, 4, flat)), {
        nodeId: '1:2',
        imagePath: join(dir, 'shot.jpg'),
      }),
    ).rejects.toThrow(/could not read .*shot\.jpg: not a PNG/);
    await expect(
      handleVisualDiff(dispatchOf(pngOf(4, 4, flat)), {
        nodeId: '1:2',
        imagePath: join(dir, 'missing.png'),
      }),
    ).rejects.toThrow(/could not read .*missing\.png/);
  });
});
