import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { GetScreenshotResult } from '@figwright/shared';
import { z } from 'zod';

import { binaryPayload } from './binary-payload.js';
import { GET_SCREENSHOT_TOOL_NAME } from './get-screenshot.js';
import { decodePng, type Raster } from './png.js';
import type { ToolSpec } from './spec.js';

export const VISUAL_DIFF_TOOL_NAME = 'visual_diff';

// A cell wide enough that a glyph's edge or a one-pixel shift averages out, and a limit under which
// two renderers' own differences (anti-aliasing, image resampling, compression) stay. Both were
// set on a real app against its Figma frames: at 48 / 8 every known colour defect was reported and
// a matching screen reported none.
const DEFAULT_CELL = 48;
const DEFAULT_THRESHOLD = 8;
/**
 * A cell is compared when at least this share of it is opaque design, inside the image, and not
 * ignored.
 */
const COMPARED_SHARE = 0.95;
const MAX_AREAS = 12;

const rectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
});
type Rect = z.infer<typeof rectSchema>;

const inputSchema = z.object({
  nodeId: z.string().describe('The Figma node the image shows (a pasted Figma URL also works)'),
  imagePath: z
    .string()
    .describe('A PNG of what was built: a simulator, device or browser screenshot'),
  region: rectSchema
    .describe(
      'Where the node sits in the image, in image pixels. Omit when the image shows the node edge ' +
        'to edge from its top: the image is then fitted to the node by width and read from the top',
    )
    .optional(),
  ignore: z
    .array(rectSchema)
    .describe(
      'Parts of the node left out, in design px from its top-left: content that differs on purpose ' +
        '(sample text, a random picture, a status bar)',
    )
    .optional(),
  cell: z.number().min(4).describe(`Cell size in design px (default ${DEFAULT_CELL})`).optional(),
  threshold: z
    .number()
    .min(0)
    .describe(
      `Largest allowed difference of a cell's mean colour, per channel 0–255 (default ${DEFAULT_THRESHOLD})`,
    )
    .optional(),
});

export const visualDiffTool: ToolSpec = {
  name: VISUAL_DIFF_TOOL_NAME,
  description:
    "Compare a node's Figma render with a PNG of what was built, by colour: both are cut into " +
    'cells and each cell’s mean colour is compared, so the result says where the build is lighter, ' +
    'darker or another hue than the design, and by how much. This is the check a side-by-side ' +
    'look misses and a position check cannot make: a background taken from a covered layer, a ' +
    'fill that lost its opacity or overlay, a gradient running the other way, a blend mode not ' +
    'applied, a glow drawn too strong — all leave every element in the right place. Returns ' +
    '{ design, image, cell, threshold, compared, different, worst, areas: [{ x, y, width, height, ' +
    'cells, delta, design, actual }], skipped }: areas are neighbouring cells over the threshold ' +
    'merged, in design px from the node’s top-left, worst first; delta is actual − design per ' +
    'channel ([+12, +12, +12] is lighter, [+27, 0, 0] redder), with the two mean colours beside it. ' +
    'An empty areas with compared > 0 is a match. It does not measure position or size — a shifted ' +
    'element shows only as the colour it moved over — and reads values as stored, so the image ' +
    'and the file should be in the same colour space. The image must be a PNG. Pass region when ' +
    'the image shows more than the node, and ignore for content that differs on purpose; skipped ' +
    'counts the cells left out and why.',
  inputSchema,
  kind: 'local',
  // No sandbox handler of its own; its plugin arguments are recorded under the tool it reuses.
  serverOnlyArgs: null,
};

type Rgb = [number, number, number];

interface VisualDiffArea {
  x: number;
  y: number;
  width: number;
  height: number;
  /** How many cells the area covers. */
  cells: number;
  /** Actual − design of the area's worst cell, per channel. */
  delta: Rgb;
  design: Rgb;
  actual: Rgb;
}

export interface VisualDiffResult {
  nodeId: string;
  /** The node's render, in design px. */
  design: { width: number; height: number };
  /** The image, and the part of it the node was read from, in image px. */
  image: { width: number; height: number; region: Rect };
  cell: number;
  threshold: number;
  compared: number;
  different: number;
  /** The largest per-channel difference found, 0 when nothing differs. */
  worst: number;
  areas: VisualDiffArea[];
  /** Cells not compared: `outside` the image, `ignored` by the caller, `transparent` in the design. */
  skipped: { outside: number; ignored: number; transparent: number };
}

interface CellMean {
  rgb: Rgb;
  /** Share of the cell's pixels that were read (inside the raster and, for the design, opaque). */
  share: number;
}

/** Mean colour of a raster rectangle given in raster px; `opaqueOnly` leaves out see-through pixels. */
const meanOf = (raster: Raster, rect: Rect, opaqueOnly: boolean): CellMean => {
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const x1 = Math.min(raster.width, Math.round(rect.x + rect.width));
  const y1 = Math.min(raster.height, Math.round(rect.y + rect.height));
  const asked = Math.max(1, Math.round(rect.width) * Math.round(rect.height));
  let r = 0;
  let g = 0;
  let b = 0;
  let read = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const at = (y * raster.width + x) * 4;
      if (opaqueOnly && (raster.data[at + 3] ?? 0) < 255) continue;
      r += raster.data[at] ?? 0;
      g += raster.data[at + 1] ?? 0;
      b += raster.data[at + 2] ?? 0;
      read++;
    }
  }
  if (read === 0) return { rgb: [0, 0, 0], share: 0 };
  return { rgb: [r / read, g / read, b / read], share: read / asked };
};

const overlapShare = (cell: Rect, rects: readonly Rect[]): number => {
  let covered = 0;
  for (const rect of rects) {
    const w = Math.min(cell.x + cell.width, rect.x + rect.width) - Math.max(cell.x, rect.x);
    const h = Math.min(cell.y + cell.height, rect.y + rect.height) - Math.max(cell.y, rect.y);
    if (w > 0 && h > 0) covered += w * h;
  }
  return Math.min(1, covered / (cell.width * cell.height));
};

const worstOf = (delta: Rgb): number => Math.max(...delta.map(Math.abs));

interface CompareOptions {
  region?: Rect | undefined;
  ignore?: readonly Rect[] | undefined;
  cell?: number | undefined;
  threshold?: number | undefined;
}

/**
 * The comparison itself, free of Figma and the filesystem. `design` is the node's render at one
 * raster px per design px; `actual` is the image of the build, at whatever size it was taken.
 */
export const compareRasters = (
  design: Raster,
  actual: Raster,
  options: CompareOptions = {},
): Omit<VisualDiffResult, 'nodeId'> => {
  const cell = options.cell ?? DEFAULT_CELL;
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const ignore = options.ignore ?? [];
  // Edge to edge from the top: the image's width is the node's width, and its rows follow at the
  // same scale. A screen taller than the frame simply has rows left over; a shorter one leaves the
  // frame's last cells outside the image.
  const region = options.region ?? {
    x: 0,
    y: 0,
    width: actual.width,
    height: (actual.width * design.height) / design.width,
  };
  const scaleX = region.width / design.width;
  const scaleY = region.height / design.height;

  const skipped = { outside: 0, ignored: 0, transparent: 0 };
  const off = new Map<string, { rect: Rect; delta: Rgb; design: Rgb; actual: Rgb }>();
  let compared = 0;
  for (let row = 0, y = 0; y < design.height; row++, y += cell) {
    for (let col = 0, x = 0; x < design.width; col++, x += cell) {
      const rect: Rect = {
        x,
        y,
        width: Math.min(cell, design.width - x),
        height: Math.min(cell, design.height - y),
      };
      if (overlapShare(rect, ignore) > 1 - COMPARED_SHARE) {
        skipped.ignored++;
        continue;
      }
      const want = meanOf(design, rect, true);
      if (want.share < COMPARED_SHARE) {
        skipped.transparent++;
        continue;
      }
      const got = meanOf(
        actual,
        {
          x: region.x + rect.x * scaleX,
          y: region.y + rect.y * scaleY,
          width: rect.width * scaleX,
          height: rect.height * scaleY,
        },
        false,
      );
      if (got.share < COMPARED_SHARE) {
        skipped.outside++;
        continue;
      }
      compared++;
      const delta = got.rgb.map((value, i) => value - (want.rgb[i] ?? 0)) as Rgb;
      if (worstOf(delta) > threshold) {
        off.set(`${col},${row}`, { rect, delta, design: want.rgb, actual: got.rgb });
      }
    }
  }

  // Neighbouring cells over the threshold are one defect, not many: merge them and keep the
  // worst cell's numbers.
  const areas: VisualDiffArea[] = [];
  const seen = new Set<string>();
  for (const start of off.keys()) {
    if (seen.has(start)) continue;
    seen.add(start);
    const stack = [start];
    const group: string[] = [];
    while (stack.length > 0) {
      const key = stack.pop() as string;
      group.push(key);
      const [col = 0, row = 0] = key.split(',').map(Number);
      for (const next of [
        `${col + 1},${row}`,
        `${col - 1},${row}`,
        `${col},${row + 1}`,
        `${col},${row - 1}`,
      ]) {
        if (off.has(next) && !seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    const cells = group.flatMap(key => off.get(key) ?? []);
    const worst = cells.reduce((a, b) => (worstOf(b.delta) > worstOf(a.delta) ? b : a));
    const x = Math.min(...cells.map(c => c.rect.x));
    const y = Math.min(...cells.map(c => c.rect.y));
    const round = (rgb: Rgb): Rgb => rgb.map(Math.round) as Rgb;
    areas.push({
      x,
      y,
      width: Math.max(...cells.map(c => c.rect.x + c.rect.width)) - x,
      height: Math.max(...cells.map(c => c.rect.y + c.rect.height)) - y,
      cells: cells.length,
      delta: round(worst.delta),
      design: round(worst.design),
      actual: round(worst.actual),
    });
  }
  areas.sort((a, b) => worstOf(b.delta) - worstOf(a.delta) || b.cells - a.cells);

  return {
    design: { width: design.width, height: design.height },
    image: {
      width: actual.width,
      height: actual.height,
      region: {
        x: region.x,
        y: region.y,
        width: Math.round(region.width),
        height: Math.round(region.height),
      },
    },
    cell,
    threshold,
    compared,
    different: off.size,
    worst: areas[0] === undefined ? 0 : worstOf(areas[0].delta),
    areas: areas.slice(0, MAX_AREAS),
    skipped,
  };
};

export type ToolDispatcher = (toolName: string, args: unknown) => Promise<unknown>;

/**
 * Renders the node through the plugin's get_screenshot (no handler of its own), reads the image
 * from disk, and compares the two here.
 */
export const handleVisualDiff = async (
  dispatch: ToolDispatcher,
  rawArgs: unknown,
): Promise<VisualDiffResult> => {
  const args = inputSchema.parse(rawArgs);
  // Scale 1: one raster px per design px, so the areas come back in the design's own coordinates.
  // A mean over a cell does not get more exact from more pixels.
  const { images } = (await dispatch(GET_SCREENSHOT_TOOL_NAME, {
    nodeIds: [args.nodeId],
    format: 'PNG',
    scale: 1,
    binary: true,
  })) as GetScreenshotResult;
  const exported = images.find(image => image.nodeId === args.nodeId) ?? images[0];
  const payload = exported === undefined ? null : binaryPayload(exported);
  if (payload === null) {
    throw new Error(`visual_diff: node ${args.nodeId} was not found or cannot be exported`);
  }
  const design = decodePng(payload);

  const imagePath = resolve(args.imagePath);
  let actual: Raster;
  try {
    actual = decodePng(await readFile(imagePath));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`visual_diff: could not read ${imagePath}: ${reason}`, { cause: error });
  }

  return {
    nodeId: args.nodeId,
    ...compareRasters(design, actual, {
      region: args.region,
      ignore: args.ignore,
      cell: args.cell,
      threshold: args.threshold,
    }),
  };
};
