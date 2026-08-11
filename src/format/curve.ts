/**
 * Entering a curve the way people describe one.
 *
 * Nobody specifies a curved wall as a bulge factor. They say "a 25 foot
 * radius", or "it bows out 18 inches", or "a quarter round into the corner", or
 * they point at three places the wall has to pass through. This converts all of
 * those into the one number the model stores, and back again for display.
 *
 * The stored form is the DXF bulge — `tan(theta/4)`, signed counter-clockwise —
 * because it degrades gracefully: zero is a straight line, so a wall does not
 * change type when it stops being curved, and there is no separate centre to
 * keep consistent when the endpoints move.
 *
 * **How curves reach the file.** They are drawn as polylines, flattened to a
 * hundredth of an inch. Room Viewer's own `RVSegmentArc` carries eight points
 * of which only the last four are the drawn cubic — the other four are
 * construction data whose meaning was never recovered from the corpus. Writing
 * one would mean guessing at half an object, so the curve is written as
 * geometry that is certainly right rather than a shape that is probably right.
 * The exact arc survives in the companion, so nothing is lost on our side.
 */

import { arcOf, wallLength, type WallSegment } from './room.js';
import type { Point } from './rv.js';

/** The largest curve that still describes a wall rather than a spiral. */
const MAX_BULGE = 100;

const chordOf = (start: Point, end: Point): number => Math.hypot(end.x - start.x, end.y - start.y);

/**
 * Bulge from a radius.
 *
 * A chord admits two arcs of any given radius — the short way round and the
 * long way — so `major` picks between them, and the sign of the radius picks
 * the side it bows to.
 */
export function bulgeFromRadius(chord: number, radius: number, major = false): number | null {
  if (!Number.isFinite(chord) || !Number.isFinite(radius) || chord <= 0) return null;
  const r = Math.abs(radius);
  // A radius smaller than half the chord cannot reach both ends.
  if (r < chord / 2 - 1e-9) return null;

  const ratio = Math.min(1, chord / (2 * r));
  const half = Math.asin(ratio);
  const theta = major ? 2 * (Math.PI - half) : 2 * half;
  const bulge = Math.tan(theta / 4);
  return radius < 0 ? -bulge : bulge;
}

/** Bulge from how far the wall bows off its chord at the middle. */
export function bulgeFromSagitta(chord: number, sagitta: number): number | null {
  if (!Number.isFinite(chord) || !Number.isFinite(sagitta) || chord <= 0) return null;
  const bulge = (2 * sagitta) / chord;
  return Math.abs(bulge) > MAX_BULGE ? null : bulge;
}

/** Bulge from the included angle in degrees: 90 is a quarter round. */
export function bulgeFromAngle(degrees: number): number | null {
  if (!Number.isFinite(degrees) || Math.abs(degrees) >= 360) return null;
  return Math.tan((degrees * Math.PI) / 180 / 4);
}

/** Bulge from the arc's own length, which is how curved walls are quoted. */
export function bulgeFromArcLength(chord: number, length: number): number | null {
  if (!Number.isFinite(chord) || !Number.isFinite(length) || chord <= 0) return null;
  if (length <= chord + 1e-9) return length < chord ? null : 0;

  // theta / (2 sin(theta/2)) = length / chord has no closed form; it is
  // monotonic in theta over (0, 2pi), so bisect. Twenty rounds settles it to
  // far below the tenth of an inch the format stores.
  const target = length / chord;
  let low = 1e-9;
  let high = 2 * Math.PI - 1e-9;
  for (let i = 0; i < 60; i++) {
    const mid = (low + high) / 2;
    const ratio = mid / (2 * Math.sin(mid / 2));
    if (ratio < target) low = mid;
    else high = mid;
  }
  return Math.tan((low + high) / 8);
}

/**
 * Bulge for an arc from `a` to `c` that passes through `b`.
 *
 * The three-point form, which is how a curve gets traced off a site survey or
 * a photograph.
 */
export function bulgeThroughPoint(a: Point, b: Point, c: Point): number | null {
  if (chordOf(a, c) <= 0) return null;

  // Twice the signed area of the triangle: zero means the three are in line.
  const area2 = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  if (Math.abs(area2) < 1e-9) return 0;

  // Circumcentre. Working from it rather than from the side lengths is what
  // gets the major-versus-minor case right: whether the arc goes the long way
  // is decided by where `b` falls in the sweep, not by how long the sides are.
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-12) return null;

  const sa = a.x * a.x + a.y * a.y;
  const sb = b.x * b.x + b.y * b.y;
  const sc = c.x * c.x + c.y * c.y;
  const centre = {
    x: (sa * (b.y - c.y) + sb * (c.y - a.y) + sc * (a.y - b.y)) / d,
    y: (sa * (c.x - b.x) + sb * (a.x - c.x) + sc * (b.x - a.x)) / d,
  };

  const turn = (from: Point, to: Point): number => {
    const angle =
      Math.atan2(to.y - centre.y, to.x - centre.x) - Math.atan2(from.y - centre.y, from.x - centre.x);
    return ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  };

  const counterClockwise = turn(a, c);
  // Going counter-clockwise from `a`, is `b` reached before `c`?
  const sweep = turn(a, b) < counterClockwise ? counterClockwise : counterClockwise - 2 * Math.PI;

  const bulge = Math.tan(sweep / 4);
  return Math.abs(bulge) > MAX_BULGE ? null : bulge;
}

/**
 * Bulge for an arc that leaves `start` in the given direction and reaches
 * `end` — the fillet that keeps a curve flush with the wall before it.
 */
export function bulgeFromTangent(start: Point, end: Point, direction: Point): number | null {
  const chord = chordOf(start, end);
  if (chord <= 0) return null;
  const heading = Math.hypot(direction.x, direction.y);
  if (heading <= 0) return null;

  // Half the included angle is the angle between the tangent and the chord.
  const cross = (direction.x * (end.y - start.y) - direction.y * (end.x - start.x)) / (heading * chord);
  const dot = (direction.x * (end.x - start.x) + direction.y * (end.y - start.y)) / (heading * chord);
  const half = Math.atan2(cross, dot);
  const bulge = Math.tan(half / 2);
  return Math.abs(bulge) > MAX_BULGE ? null : bulge;
}

/** The direction a wall leaves its end point, following the curve. */
export function exitDirection(segment: WallSegment): Point {
  const arc = arcOf(segment);
  if (!arc) {
    return { x: segment.end.x - segment.start.x, y: segment.end.y - segment.start.y };
  }
  // Tangent at the end of the sweep: the radius turned a quarter, signed.
  const angle = arc.startAngle + arc.sweep;
  const sign = Math.sign(arc.sweep) || 1;
  return { x: -Math.sin(angle) * sign, y: Math.cos(angle) * sign };
}

// ---------------------------------------------------------------------------
// Reading a curve back
// ---------------------------------------------------------------------------

export interface CurveReadout {
  /** Zero for a straight run. */
  bulge: number;
  radius: number | null;
  /** Included angle in degrees, signed. */
  angle: number;
  /**
   * How far the wall bows off its chord, signed the same way as the bulge —
   * *not* by world axis. A positive sagitta means the wall bows to the right of
   * the directed chord (the side opposite the arc centre for a minor arc).
   */
  sagitta: number;
  chord: number;
  length: number;
  /** True when the arc goes the long way round. */
  major: boolean;
}

/** Every number a curve can be described by, for the properties panel. */
export function readCurve(segment: WallSegment): CurveReadout {
  const chord = chordOf(segment.start, segment.end);
  const bulge = segment.bulge ?? 0;
  const arc = arcOf(segment);

  return {
    bulge,
    radius: arc ? arc.radius : null,
    angle: arc ? (arc.sweep * 180) / Math.PI : 0,
    sagitta: (bulge * chord) / 2,
    chord,
    length: wallLength(segment),
    major: Math.abs(bulge) > 1,
  };
}

/**
 * Rounds a radius to something a builder would use.
 *
 * Curved walls get set out on site from a tape, so a radius of 24 ft 11 3/4 in
 * is a drafting artefact rather than a decision. Snapping to the foot — or to
 * `step` — is what makes a traced curve buildable.
 */
export function snapRadius(radius: number, step: number): number {
  if (!Number.isFinite(radius) || step <= 0) return radius;
  return Math.round(radius / step) * step;
}

/** Snaps a bulge so its arc lands on a whole number of degrees. */
export function snapAngle(bulge: number, degreeStep = 15): number {
  if (!bulge) return 0;
  const degrees = (4 * Math.atan(bulge) * 180) / Math.PI;
  const snapped = Math.round(degrees / degreeStep) * degreeStep;
  return bulgeFromAngle(snapped) ?? bulge;
}

/** Common curves, offered as buttons rather than made the user compute them. */
export const CURVE_PRESETS: Array<{ label: string; bulge: number }> = [
  { label: 'Straight', bulge: 0 },
  { label: 'Shallow bow', bulge: Math.tan(Math.PI / 24) },
  { label: 'Quarter round', bulge: Math.tan(Math.PI / 8) },
  { label: 'Half round', bulge: 1 },
];
