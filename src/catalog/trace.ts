/**
 * Turning a picture of a piece of gear into a plan outline.
 *
 * Adding equipment by hand means drawing it, and most people will not. But
 * almost every product has a top-down line drawing on its datasheet, and a
 * photograph of a road case on a warehouse floor is close enough for a plan. So
 * this traces an image into an outline that can be placed, measured and
 * printed.
 *
 * The pipeline, in order:
 *
 *   1. threshold to ink and background
 *   2. keep the largest connected shape, so speckle and stray marks are ignored
 *   3. follow its boundary
 *   4. simplify, so a 4,000-point trace of a rectangle becomes four points
 *   5. centre it and scale to the real dimensions the user typed
 *
 * Step five is what makes it a drawing rather than a picture. The trace decides
 * the shape; the user's measurements decide the size. An outline that is the
 * right shape and the wrong size is worse than useless on a floor plan, so the
 * scale is never inferred from pixels.
 */

import type { SymbolPath } from './symbols.js';

export interface RasterImage {
  /** RGBA, four bytes per pixel, as `ImageData` provides. */
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

export interface TraceOptions {
  /**
   * Luminance below which a pixel counts as ink, 0–255.
   *
   * Line art on white sits well under 128; a photograph usually needs raising.
   */
  threshold?: number;
  /** Treat transparent pixels as background, for cut-out PNGs. */
  useAlpha?: boolean;
  /** How aggressively to simplify, in pixels. Higher is smoother. */
  simplify?: number;
  /** Real footprint in logical units. The trace is scaled to fit exactly. */
  targetWidth?: number;
  targetDepth?: number;
  /** Invert for pale gear photographed against a dark background. */
  invert?: boolean;
}

export interface TraceResult {
  ok: boolean;
  reason?: string;
  paths: SymbolPath[];
  /** Size of the result in logical units. */
  width: number;
  height: number;
  /** Points before and after simplification, to show the tracer is working. */
  rawPoints: number;
  points: number;
  /** Share of the image that was ink, useful for judging the threshold. */
  coverage: number;
}

const EMPTY: TraceResult = {
  ok: false,
  paths: [],
  width: 0,
  height: 0,
  rawPoints: 0,
  points: 0,
  coverage: 0,
};

/**
 * Picks a threshold from the image luma histogram (Otsu).
 * Better starting point than a fixed 128 for photos and line art.
 */
export function estimateThreshold(image: RasterImage): number {
  if (!image.width || !image.height) return 128;
  const hist = new Float64Array(256);
  let total = 0;
  const { data } = image;
  for (let p = 0; p + 3 < data.length; p += 4) {
    if (data[p + 3] < 128) continue;
    const luma = Math.round(0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]);
    hist[Math.max(0, Math.min(255, luma))] += 1;
    total += 1;
  }
  if (total < 16) return 128;

  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];

  let sumBg = 0;
  let weightBg = 0;
  let best = 128;
  let bestVar = -1;
  for (let t = 0; t < 256; t++) {
    weightBg += hist[t];
    if (weightBg === 0) continue;
    const weightFg = total - weightBg;
    if (weightFg === 0) break;
    sumBg += t * hist[t];
    const meanBg = sumBg / weightBg;
    const meanFg = (sumAll - sumBg) / weightFg;
    const between = weightBg * weightFg * (meanBg - meanFg) ** 2;
    if (between > bestVar) {
      bestVar = between;
      best = t;
    }
  }
  return Math.max(20, Math.min(240, best));
}

/** Builds the ink mask. */
function mask(image: RasterImage, options: TraceOptions): Uint8Array {
  const { width, height, data } = image;
  const threshold = options.threshold ?? 128;
  const out = new Uint8Array(width * height);

  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const alpha = data[p + 3];
    if (options.useAlpha && alpha < 128) continue;

    // Rec. 601 luma: closer to perceived brightness than a plain average, which
    // matters for coloured gear against a light floor.
    const luma = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    const ink = options.invert ? luma > threshold : luma < threshold;
    if (ink) out[i] = 1;
  }
  return out;
}

/**
 * Keeps only the largest connected region.
 *
 * A datasheet has dimension arrows, part numbers and a border; a photograph has
 * a floor. Tracing everything would produce a tangle, and the product is
 * essentially always the biggest single thing in the frame.
 */
function largestRegion(m: Uint8Array, width: number, height: number): { region: Uint8Array; size: number } {
  const labels = new Int32Array(m.length).fill(-1);
  const region = new Uint8Array(m.length);
  let best = -1;
  let bestSize = 0;

  const stack: number[] = [];
  let label = 0;

  for (let start = 0; start < m.length; start++) {
    if (m[start] !== 1 || labels[start] !== -1) continue;

    let size = 0;
    stack.push(start);
    labels[start] = label;

    while (stack.length > 0) {
      const at = stack.pop()!;
      size++;
      const x = at % width;
      const y = (at - x) / width;

      // Four-connected: diagonal-only links are usually anti-aliasing rather
      // than real structure, and joining through them merges separate parts.
      if (x > 0) {
        const n = at - 1;
        if (m[n] === 1 && labels[n] === -1) {
          labels[n] = label;
          stack.push(n);
        }
      }
      if (x < width - 1) {
        const n = at + 1;
        if (m[n] === 1 && labels[n] === -1) {
          labels[n] = label;
          stack.push(n);
        }
      }
      if (y > 0) {
        const n = at - width;
        if (m[n] === 1 && labels[n] === -1) {
          labels[n] = label;
          stack.push(n);
        }
      }
      if (y < height - 1) {
        const n = at + width;
        if (m[n] === 1 && labels[n] === -1) {
          labels[n] = label;
          stack.push(n);
        }
      }
    }

    if (size > bestSize) {
      bestSize = size;
      best = label;
    }
    label++;
  }

  if (best === -1) return { region, size: 0 };
  for (let i = 0; i < labels.length; i++) if (labels[i] === best) region[i] = 1;
  return { region, size: bestSize };
}

/**
 * Follows the outside boundary of a filled region.
 *
 * Moore-neighbourhood tracing: from a known edge pixel, walk the eight
 * neighbours in a fixed rotation, always resuming from where the previous step
 * arrived. It closes on itself, so the stop condition is returning to the start
 * heading the same way — checking position alone stops early on shapes with a
 * pinch point.
 */
function traceBoundary(region: Uint8Array, width: number, height: number): number[] {
  const at = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= width || y >= height ? 0 : region[y * width + x];

  let startX = -1;
  let startY = -1;
  for (let y = 0; y < height && startX === -1; y++) {
    for (let x = 0; x < width; x++) {
      if (at(x, y) === 1) {
        startX = x;
        startY = y;
        break;
      }
    }
  }
  if (startX === -1) return [];

  // Neighbour offsets, clockwise from due west.
  //   0 W   1 NW   2 N   3 NE   4 E   5 SE   6 S   7 SW
  const dx = [-1, -1, 0, 1, 1, 1, 0, -1];
  const dy = [0, -1, -1, -1, 0, 1, 1, 1];

  const points: number[] = [];
  let cx = startX;
  let cy = startY;

  // Where the next neighbour scan begins. The start pixel is the topmost then
  // leftmost ink, so the pixel west of it is background — scanning from there
  // walks the outside of the shape rather than cutting across it.
  let from = 0;

  const limit = width * height * 8;

  for (let step = 0; step < limit; step++) {
    points.push(cx, cy);

    let moved = false;
    for (let i = 0; i < 8; i++) {
      const d = (from + i) % 8;
      const nx = cx + dx[d];
      const ny = cy + dy[d];
      if (at(nx, ny) === 1) {
        cx = nx;
        cy = ny;
        // Resume one step clockwise of where we came from, which is what keeps
        // the walk against the edge instead of doubling back into the shape.
        from = (d + 5) % 8;
        moved = true;
        break;
      }
    }

    // An isolated pixel has no neighbours to follow.
    if (!moved) break;
    if (cx === startX && cy === startY && points.length > 4) break;
  }

  return points;
}

/** Ramer–Douglas–Peucker: drops points that sit close to the line they span. */
function simplify(points: number[], tolerance: number): number[] {
  if (points.length <= 6 || tolerance <= 0) return points;

  const n = points.length / 2;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;

  const stack: Array<[number, number]> = [[0, n - 1]];
  const toleranceSquared = tolerance * tolerance;

  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    if (last <= first + 1) continue;

    const ax = points[first * 2];
    const ay = points[first * 2 + 1];
    const bx = points[last * 2];
    const by = points[last * 2 + 1];
    const ex = bx - ax;
    const ey = by - ay;
    const lengthSquared = ex * ex + ey * ey;

    let worst = -1;
    let worstDistance = 0;

    for (let i = first + 1; i < last; i++) {
      const px = points[i * 2];
      const py = points[i * 2 + 1];
      let distance: number;
      if (lengthSquared === 0) {
        distance = (px - ax) ** 2 + (py - ay) ** 2;
      } else {
        const t = Math.max(0, Math.min(1, ((px - ax) * ex + (py - ay) * ey) / lengthSquared));
        distance = (px - (ax + t * ex)) ** 2 + (py - (ay + t * ey)) ** 2;
      }
      if (distance > worstDistance) {
        worstDistance = distance;
        worst = i;
      }
    }

    if (worstDistance > toleranceSquared && worst !== -1) {
      keep[worst] = 1;
      stack.push([first, worst], [worst, last]);
    }
  }

  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i * 2], points[i * 2 + 1]);
  return out;
}

/**
 * Traces an image into a placeable outline.
 *
 * Scaled to the dimensions the caller supplies rather than to anything measured
 * from the image, because pixels say nothing about feet.
 */
export function traceImage(image: RasterImage, options: TraceOptions = {}): TraceResult {
  if (!image.width || !image.height) return { ...EMPTY, reason: 'the image is empty' };

  const ink = mask(image, options);
  let inkCount = 0;
  for (let i = 0; i < ink.length; i++) inkCount += ink[i];
  const coverage = inkCount / ink.length;

  if (inkCount === 0) {
    return { ...EMPTY, coverage, reason: 'nothing was dark enough. Try raising the threshold' };
  }
  if (coverage > 0.98) {
    return { ...EMPTY, coverage, reason: 'everything was dark: try lowering the threshold' };
  }

  const { region, size } = largestRegion(ink, image.width, image.height);
  if (size < 8) return { ...EMPTY, coverage, reason: 'the shape found was too small to trace' };

  const raw = traceBoundary(region, image.width, image.height);
  if (raw.length < 6) return { ...EMPTY, coverage, reason: 'no outline could be followed' };

  const tolerance = options.simplify ?? Math.max(1, Math.min(image.width, image.height) / 200);
  const reduced = simplify(raw, tolerance);

  // Extent of the trace, in pixels.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < reduced.length; i += 2) {
    minX = Math.min(minX, reduced[i]);
    maxX = Math.max(maxX, reduced[i]);
    minY = Math.min(minY, reduced[i + 1]);
    maxY = Math.max(maxY, reduced[i + 1]);
  }
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);

  // The traced points are pixel *centres*, so a region covering pixels 20 to
  // 179 has a centre span of 159 while the object is 160 pixels across. Sizing
  // off the centre span would shrink every outline by a pixel and skew a
  // derived proportion, so the object extent is what everything is based on.
  const extentX = spanX + 1;
  const extentY = spanY + 1;

  // What the object actually measures. Where the user gave one dimension the
  // other follows the traced proportions; where they gave none, a pixel becomes
  // a tenth of an inch so the result is still a sane size to look at.
  const objectWidth =
    options.targetWidth ??
    (options.targetDepth ? (extentX / extentY) * options.targetDepth : extentX);
  const objectDepth =
    options.targetDepth ??
    (options.targetWidth ? (extentY / extentX) * options.targetWidth : extentY);

  const scaleX = objectWidth / extentX;
  const scaleY = objectDepth / extentY;

  const centreX = (minX + maxX) / 2;
  const centreY = (minY + maxY) / 2;
  const round = (n: number): number => Math.round(n * 10) / 10;

  const points: number[] = [];
  for (let i = 0; i < reduced.length; i += 2) {
    points.push(round((reduced[i] - centreX) * scaleX), round((reduced[i + 1] - centreY) * scaleY));
  }

  return {
    ok: true,
    paths: [{ points, closed: true }],
    // The object's size, not the drawn span: the outline follows pixel centres
    // and therefore sits half a pixel inside the real edge.
    width: round(objectWidth),
    height: round(objectDepth),
    rawPoints: raw.length / 2,
    points: points.length / 2,
    coverage,
  };
}
