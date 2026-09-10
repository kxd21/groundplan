/**
 * Plan-canvas pick testing.
 *
 * Chairs are multi-primitive (seat + back). Distance is the best across every
 * part of an object. Interior body hits beat outline-halo hits so a click on
 * a backrest is not stolen by a neighbour whose seat edge was slightly closer.
 */

import type { ScenePrimitive } from '../../format/scene.js';

const UNITS_PER_INCH = 10;

/**
 * Edge-halo cap for pick tests in world units (tenths of an inch).
 *
 * Screen-pixel tolerance balloons at fit zoom (~1–2′), which is larger than
 * half a chair gap in a dense bank. Interior body hits stay unlimited; this
 * only limits “near the outline” picks so empty clicks between seats miss.
 * Two inches is enough to grab a thin stroke without bridging a banquet gap.
 */
export const PICK_EDGE_TOLERANCE_CAP = 2 * UNITS_PER_INCH;

export interface HitTestBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface HitTestItem extends HitTestBounds {
  primitive: ScenePrimitive;
}

export interface HitCandidate {
  id: number;
  distance: number;
  size: number;
  name: string;
}

/** Distance from a point to a line segment. */
export function distanceToSegment(
  px: number,
  py: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - x0, py - y0);
  let t = ((px - x0) * dx + (py - y0) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

/** Even-odd polygon containment so filled equipment can be selected inside its outline. */
export function pointInPolygon(x: number, y: number, pts: number[]): boolean {
  if (pts.length < 6) return false;
  let inside = false;
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
    const xi = pts[i]!;
    const yi = pts[i + 1]!;
    const xj = pts[j]!;
    const yj = pts[j + 1]!;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Finds every object under a point, nearest first.
 *
 * Same-distance ties break toward the physically smaller object, so a chair
 * that overlaps a table sorts ahead of the table.
 */
export function hitTestCandidates(
  prepared: HitTestItem[],
  visible: Set<string>,
  x: number,
  y: number,
  tolerance: number,
  locked?: Set<string>,
): HitCandidate[] {
  const edgeTolerance = Math.min(tolerance, PICK_EDGE_TOLERANCE_CAP);
  const rejectPad = Math.max(tolerance, edgeTolerance);
  type Acc = {
    id: number;
    distance: number;
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    name: string;
  };
  const best = new Map<number, Acc>();

  for (const item of prepared) {
    const p = item.primitive;
    if (!visible.has(p.discipline)) continue;
    // A locked layer is visible but not touchable: that is the whole point of
    // locking the Architecture layer while placing chairs on top of it.
    if (locked?.has(p.discipline)) continue;

    let distance = Infinity;

    // Cheap reject before the per-segment work.
    if (
      x < item.minX - rejectPad ||
      x > item.maxX + rejectPad ||
      y < item.minY - rejectPad ||
      y > item.maxY + rejectPad
    ) {
      continue;
    }

    if (p.type === 'text') {
      const dx = Math.max(item.minX - x, 0, x - item.maxX);
      const dy = Math.max(item.minY - y, 0, y - item.maxY);
      distance = Math.hypot(dx, dy);
    } else if (p.pts.length === 2) {
      distance = Math.hypot(x - p.pts[0]!, y - p.pts[1]!);
    } else {
      for (let i = 0; i + 3 < p.pts.length; i += 2) {
        distance = Math.min(
          distance,
          distanceToSegment(x, y, p.pts[i]!, p.pts[i + 1]!, p.pts[i + 2]!, p.pts[i + 3]!),
        );
      }
      // Furniture is picked by its BODY, not just its outline.
      //
      // `primitiveTypeFor` maps RVSegmentRect to 'polygon' but RVSegmentPoly to
      // 'polyline', and a Room Viewer round table is a poly. So a stage could be
      // clicked anywhere on its fill while a table could only be hit within the
      // pick tolerance of its 1px edge — 0.56 ft at 12% zoom, which is less than
      // half a chair. A scan of 34 points across a banquet row selected nothing.
      //
      // Walls and regions stay edge-picked on purpose: their rings enclose the
      // whole floor, so an interior test there would swallow every click on
      // empty ground and break marquee selection.
      const closedBody = p.type === 'polygon' || (p.layer === 'furniture' && p.pts.length >= 6);
      if (closedBody && p.pts.length >= 4) {
        distance = Math.min(
          distance,
          distanceToSegment(
            x,
            y,
            p.pts[p.pts.length - 2]!,
            p.pts[p.pts.length - 1]!,
            p.pts[0]!,
            p.pts[1]!,
          ),
        );
        if (pointInPolygon(x, y, p.pts)) distance = 0;
      }
    }

    // Body interiors always count. Outline picks use the capped halo so a
    // zoomed-out banquet row does not select the chair next door.
    if (distance > 0 && distance > edgeTolerance) continue;

    const name = p.owner || p.text || `Object ${p.selectId}`;
    const prev = best.get(p.selectId);
    if (!prev) {
      best.set(p.selectId, {
        id: p.selectId,
        distance,
        minX: item.minX,
        maxX: item.maxX,
        minY: item.minY,
        maxY: item.maxY,
        name,
      });
      continue;
    }
    prev.distance = Math.min(prev.distance, distance);
    prev.minX = Math.min(prev.minX, item.minX);
    prev.maxX = Math.max(prev.maxX, item.maxX);
    prev.minY = Math.min(prev.minY, item.minY);
    prev.maxY = Math.max(prev.maxY, item.maxY);
    if (p.owner) prev.name = name;
  }

  const hits = [...best.values()].map((acc) => {
    const cx = (acc.minX + acc.maxX) / 2;
    const cy = (acc.minY + acc.maxY) / 2;
    return {
      id: acc.id,
      distance: acc.distance,
      size: Math.max(1, (acc.maxX - acc.minX) * (acc.maxY - acc.minY)),
      name: acc.name,
      center: Math.hypot(x - cx, y - cy),
    };
  });

  hits.sort((a, b) => {
    // A click inside a chair must beat a neighbour's outline halo.
    const aIn = a.distance === 0 ? 0 : 1;
    const bIn = b.distance === 0 ? 0 : 1;
    if (aIn !== bIn) return aIn - bIn;
    if (a.distance !== b.distance) return a.distance - b.distance;
    if (a.size !== b.size) return a.size - b.size;
    return a.center - b.center;
  });

  return hits.map(({ id, distance, size, name }) => ({ id, distance, size, name }));
}

/** Finds the object nearest a point (first of `hitTestCandidates`). */
export function hitTest(
  prepared: HitTestItem[],
  visible: Set<string>,
  x: number,
  y: number,
  tolerance: number,
  locked?: Set<string>,
): number | null {
  return hitTestCandidates(prepared, visible, x, y, tolerance, locked)[0]?.id ?? null;
}
