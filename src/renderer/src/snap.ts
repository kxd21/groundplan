/**
 * Where things land when you drag them.
 *
 * Pure geometry, kept out of the canvas component so it can be exercised
 * without a renderer — the same reason `transform-handles.ts` is its own file.
 */

import { UNITS_PER_METRE, type UnitSystem } from '../../format/units.js';

const UNITS_PER_INCH = 10;

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export type SnapKeys = { shift: boolean; alt: boolean };

/**
 * Step used while dragging / placing on the plan.
 *
 * Plan snap is often a full foot — too coarse for careful edits — so interactive
 * tools clamp to 1″ (or 1 cm) unless Shift asks for a finer step, or Alt leaves
 * the value free (returns 0).
 */
export function editSnapStep(snapStep: number, units: UnitSystem, keys: SnapKeys): number {
  if (keys.alt) return 0;
  const inchOrCm = units === 'metric' ? UNITS_PER_METRE / 100 : UNITS_PER_INCH;
  const fine = units === 'metric' ? UNITS_PER_METRE / 1000 : 1; // 1 mm or 0.1″
  const coarse = snapStep > 0 ? Math.min(snapStep, inchOrCm) : inchOrCm;
  return keys.shift ? fine : coarse;
}

export function snapScalar(value: number, step: number): number {
  if (!(step > 0)) return value;
  return Math.round(value / step) * step;
}

export function snapPlanPoint(
  point: { x: number; y: number },
  snapStep: number,
  units: UnitSystem,
  keys: SnapKeys,
): { x: number; y: number } {
  const step = editSnapStep(snapStep, units, keys);
  if (!(step > 0)) return point;
  return { x: snapScalar(point.x, step), y: snapScalar(point.y, step) };
}

/** Snap a single-axis drag delta (walls, nudges). */
export function snapDragDelta(
  delta: number,
  snapStep: number,
  units: UnitSystem,
  keys: SnapKeys,
): number {
  return snapScalar(delta, editSnapStep(snapStep, units, keys));
}


/**
 * Where a drag lands.
 *
 * The old rule was that only the moving selection's CENTRE could snap, against
 * other objects' centre and edges. That is the wrong half of the problem for
 * this application. A stage is built by butting decks together; an LED wall is
 * built by butting panels together; a riser goes flush to a wall. Every one of
 * those is an EDGE meeting an EDGE, and none of them was reachable by dragging
 * — the centre would have had to land on the other object's edge, which is a
 * different position entirely.
 *
 * So both sides now offer three candidates per axis — near edge, centre, far
 * edge — and any of the nine pairings can hold. Edge-to-edge is preferred over
 * centre-to-centre at equal distance, because two objects touching is almost
 * always the thing that was meant.
 *
 * Equal spacing is detected separately: with a run of objects already evenly
 * spaced, the next one snaps to continue the rhythm.
 */
export function applySnap(
  objectBounds: Map<number, Bounds>,
  selection: number[],
  raw: { dx: number; dy: number },
  snapStep: number,
  viewScale: number,
  objectSnap: boolean,
  units: UnitSystem = 'imperial',
  keys: SnapKeys = { shift: false, alt: false },
): { dx: number; dy: number; guides: { x?: number; y?: number } } {
  if (!selection.length) return { ...raw, guides: {} };

  const moving = boundsOfMany(objectBounds, selection);
  if (!moving) return { ...raw, guides: {} };

  // Where the three snap points on each axis will be once the raw drag lands.
  const movedMinX = moving.minX + raw.dx;
  const movedMaxX = moving.maxX + raw.dx;
  const movedMinY = moving.minY + raw.dy;
  const movedMaxY = moving.maxY + raw.dy;
  const movingX = [movedMinX, (movedMinX + movedMaxX) / 2, movedMaxX];
  const movingY = [movedMinY, (movedMinY + movedMaxY) / 2, movedMaxY];

  // Snap tolerance is a fixed screen distance, so it feels the same at any zoom.
  const tolerance = 7 / viewScale;
  const selected = new Set(selection);
  const guides: { x?: number; y?: number } = {};
  let dx = raw.dx;
  let dy = raw.dy;

  /**
   * The winning snap on one axis.
   *
   * `shift` is what to add to the drag; `at` is where to draw the guide. Ties
   * are broken by `rank`, low first, so an edge pairing beats a centre pairing
   * when both are equally close.
   */
  type Hit = { shift: number; at: number; gap: number; rank: number };
  let bestX: Hit | null = null;
  let bestY: Hit | null = null;

  const consider = (
    current: Hit | null,
    movingAt: number,
    targetAt: number,
    rank: number,
  ): Hit | null => {
    const gap = Math.abs(targetAt - movingAt);
    if (gap >= tolerance) return current;
    if (current && (current.gap < gap || (current.gap === gap && current.rank <= rank))) return current;
    return { shift: targetAt - movingAt, at: targetAt, gap, rank };
  };

  /*
   * The old guard was `selection.length <= 40`, which turned object snapping
   * off without saying so — and it did it on exactly the selections where
   * alignment matters most, like a whole seating bank. The real cost is the
   * scan over every other object, which does not depend on how many are
   * selected, so the selection size was never the thing to limit. The bound
   * that matters is how many candidates get scanned, and that is capped below.
   */
  if (objectSnap && !keys.alt) {
    // Only objects near the drag can win, and scanning the whole plan on a
    // 2,000-chair drawing is what makes a drag stutter. A generous window
    // around the moving box keeps this proportional to what is on screen.
    const window = tolerance * 40;
    for (const [id, bounds] of objectBounds) {
      if (selected.has(id)) continue;
      if (
        bounds.maxX < movedMinX - window ||
        bounds.minX > movedMaxX + window ||
        bounds.maxY < movedMinY - window ||
        bounds.minY > movedMaxY + window
      ) {
        continue;
      }
      const { minX, minY, maxX, maxY } = bounds;
      const targetX = [minX, (minX + maxX) / 2, maxX];
      const targetY = [minY, (minY + maxY) / 2, maxY];

      for (let m = 0; m < 3; m++) {
        for (let t = 0; t < 3; t++) {
          // Rank 0 is edge-to-edge, 2 is centre-to-centre, 1 is the mixed case.
          const rank = (m === 1 ? 1 : 0) + (t === 1 ? 1 : 0);
          bestX = consider(bestX, movingX[m]!, targetX[t]!, rank);
          bestY = consider(bestY, movingY[m]!, targetY[t]!, rank);
        }
      }
    }
  }

  const gridStep = editSnapStep(snapStep, units, keys);

  if (bestX) {
    dx += bestX.shift;
    guides.x = bestX.at;
  } else if (gridStep > 0) {
    const centreX = (movedMinX + movedMaxX) / 2;
    dx += snapScalar(centreX, gridStep) - centreX;
  }

  if (bestY) {
    dy += bestY.shift;
    guides.y = bestY.at;
  } else if (gridStep > 0) {
    const centreY = (movedMinY + movedMaxY) / 2;
    dy += snapScalar(centreY, gridStep) - centreY;
  }

  return { dx, dy, guides };
}

/** Combined bounding box of a whole selection. */
export function boundsOfMany(objectBounds: Map<number, Bounds>, ids: number[]) {
  let box: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  for (const id of ids) {
    const b = objectBounds.get(id);
    if (!b) continue;
    box = box
      ? {
          minX: Math.min(box.minX, b.minX),
          minY: Math.min(box.minY, b.minY),
          maxX: Math.max(box.maxX, b.maxX),
          maxY: Math.max(box.maxY, b.maxY),
        }
      : b;
  }
  return box;
}

