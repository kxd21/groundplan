/**
 * Snap a placement to the nearest room wall.
 *
 * Doors and openings belong on the perimeter: free-floating door symbols look
 * wrong on a ballroom plan and never match a print. Project the click onto the
 * closest wall run and return the facing angle along that wall.
 */

import type { Point } from './rv.js';
import { UNITS_PER_FOOT } from './rv.js';
import type { WallSegment } from './room.js';
import { arcOf, flattenWall } from './room.js';

export interface WallSnap {
  x: number;
  y: number;
  /** Radians — door/opening should face into the room, along the wall tangent. */
  angle: number;
  distance: number;
}

/** How far a click may be from a wall and still snap (five feet). */
export const WALL_SNAP_REACH = 5 * UNITS_PER_FOOT;

/**
 * Projects (x, y) onto the nearest wall polyline.
 *
 * Curved walls are flattened so the projection stays on the drawn perimeter.
 */
export function nearestWallSnap(
  walls: WallSegment[],
  x: number,
  y: number,
  reach = WALL_SNAP_REACH,
): WallSnap | null {
  let best: WallSnap | null = null;

  for (const segment of walls) {
    const points = flattenWall(segment);
    if (points.length < 2) {
      const hit = projectOntoSegment(segment.start, segment.end, x, y);
      if (hit && (!best || hit.distance < best.distance)) best = hit;
      continue;
    }
    for (let i = 0; i + 1 < points.length; i++) {
      const hit = projectOntoSegment(points[i], points[i + 1], x, y);
      if (hit && (!best || hit.distance < best.distance)) best = hit;
    }
    // Also try the raw chord when the segment is an arc — keeps endpoints exact.
    if (arcOf(segment)) {
      const hit = projectOntoSegment(segment.start, segment.end, x, y);
      if (hit && (!best || hit.distance < best.distance)) best = hit;
    }
  }

  if (!best || best.distance > reach) return null;
  return best;
}

function projectOntoSegment(a: Point, b: Point, x: number, y: number): WallSnap | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return null;
  let t = ((x - a.x) * dx + (y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const px = a.x + t * dx;
  const py = a.y + t * dy;
  return {
    x: px,
    y: py,
    angle: Math.atan2(dy, dx),
    distance: Math.hypot(x - px, y - py),
  };
}

/** True when a catalogue name should prefer wall placement. */
export function wantsWallSnap(description: string): boolean {
  return /\bdoors?\b/i.test(description) || /\bopening\b/i.test(description);
}
