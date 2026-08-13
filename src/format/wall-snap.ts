/**
 * Snap a placement to the nearest room wall, or inset a set distance inside.
 *
 * Doors and openings belong on the perimeter: free-floating door symbols look
 * wrong on a ballroom plan and never match a print. Project the click onto the
 * closest wall run and return the facing angle along that wall.
 *
 * `wallSetback` places furniture a fixed distance *in from* the nearest wall —
 * speakers, lecterns, cable ends — without moving the wall itself.
 */

import type { Point } from './rv.js';
import { UNITS_PER_FOOT } from './rv.js';
import type { RoomModel, WallSegment } from './room.js';
import { arcOf, containsPoint, flattenWall } from './room.js';

export interface WallSnap {
  x: number;
  y: number;
  /** Radians — door/opening should face into the room, along the wall tangent. */
  angle: number;
  distance: number;
  wallIndex?: number;
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

  for (let wallIndex = 0; wallIndex < walls.length; wallIndex++) {
    const segment = walls[wallIndex]!;
    const points = flattenWall(segment);
    if (points.length < 2) {
      const hit = projectOntoSegment(segment.start, segment.end, x, y, wallIndex);
      if (hit && (!best || hit.distance < best.distance)) best = hit;
      continue;
    }
    for (let i = 0; i + 1 < points.length; i++) {
      const hit = projectOntoSegment(points[i]!, points[i + 1]!, x, y, wallIndex);
      if (hit && (!best || hit.distance < best.distance)) best = hit;
    }
    // Also try the raw chord when the segment is an arc — keeps endpoints exact.
    if (arcOf(segment)) {
      const hit = projectOntoSegment(segment.start, segment.end, x, y, wallIndex);
      if (hit && (!best || hit.distance < best.distance)) best = hit;
    }
  }

  if (!best || best.distance > reach) return null;
  return best;
}

/**
 * Moves a point to sit `distance` inside the room from the nearest wall.
 *
 * Returns the setback centre and a wall-tangent angle (face along the wall).
 * When `room` is provided, the inset side is chosen so the result stays inside
 * the floor; otherwise the offset prefers the side closer to the current point.
 */
export function wallSetback(
  walls: WallSegment[],
  x: number,
  y: number,
  distance: number,
  room?: RoomModel | null,
): WallSnap | null {
  if (!(distance >= 0) || !Number.isFinite(distance)) return null;
  // Unlimited reach — setback is intentional, not a casual snap.
  const onWall = nearestWallSnap(walls, x, y, Number.POSITIVE_INFINITY);
  if (!onWall) return null;

  const tangent = onWall.angle;
  const leftNx = -Math.sin(tangent);
  const leftNy = Math.cos(tangent);

  const trySide = (sign: 1 | -1): WallSnap => ({
    x: onWall.x + leftNx * distance * sign,
    y: onWall.y + leftNy * distance * sign,
    angle: tangent,
    distance: onWall.distance,
    wallIndex: onWall.wallIndex,
  });

  if (distance === 0) {
    return { ...onWall, x: onWall.x, y: onWall.y };
  }

  const a = trySide(1);
  const b = trySide(-1);

  if (room && room.walls.length >= 3) {
    const aIn = containsPoint(room, { x: a.x, y: a.y });
    const bIn = containsPoint(room, { x: b.x, y: b.y });
    if (aIn && !bIn) return a;
    if (bIn && !aIn) return b;
    if (aIn && bIn) {
      return Math.hypot(a.x - x, a.y - y) <= Math.hypot(b.x - x, b.y - y) ? a : b;
    }
  }

  // No room test: prefer the side the point already leans toward.
  const toPointX = x - onWall.x;
  const toPointY = y - onWall.y;
  const alongLeft = toPointX * leftNx + toPointY * leftNy;
  return alongLeft >= 0 ? a : b;
}

function projectOntoSegment(
  a: Point,
  b: Point,
  x: number,
  y: number,
  wallIndex?: number,
): WallSnap | null {
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
    wallIndex,
  };
}

/** True when a catalogue name should prefer wall placement. */
export function wantsWallSnap(description: string): boolean {
  return /\bdoors?\b/i.test(description) || /\bopening\b/i.test(description);
}
