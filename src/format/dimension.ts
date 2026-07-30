/**
 * The dimension types a floor plan needs beyond a straight measurement.
 *
 * Groundplan could already draw a linear dimension and keep it attached to the
 * objects it measures (`main/dimension-associations.ts`). What it could not do
 * is dimension anything curved — and a room with a bowed back wall is dimensioned
 * by its radius, not by the straight line across the bay.
 *
 * Everything here is pure geometry: a dimension is worked out as a set of
 * polylines plus a piece of text, and only then drawn. That split is what lets
 * the same code measure a wall on screen, print it to a sheet, and write it into
 * the plan without three versions of the arithmetic.
 *
 * **Text stays latin-1.** Room Viewer is a 1990s MFC application and its strings
 * are single-byte, so a diameter is `DIA 50 ft  0 in` rather than a `⌀` that
 * would come back as a question mark. The degree sign survives, being 0xB0.
 */

import { arcOf, flattenWall, wallLength, type RoomModel, type WallSegment } from './room.js';
import type { Point } from './rv.js';
import { formatDistance } from './annotate.js';
import type { UnitSystem } from './units.js';

export type DimensionKind = 'linear' | 'aligned' | 'radius' | 'diameter' | 'arc' | 'angle';

export interface DimensionDrawing {
  kind: DimensionKind;
  /** Polylines making up the dimension: witness lines, leaders, the arc. */
  lines: Point[][];
  /** The measurement, ready to draw. */
  text: string;
  /** Where the text goes. */
  at: Point;
  /**
   * The measured quantity: logical units for lengths, degrees for angles. Kept
   * separate from `text` so a schedule can total dimensions without reparsing
   * them out of their own labels.
   */
  value: number;
}

/** How far a dimension line sits off the thing it measures, by default. */
const DEFAULT_OFFSET = 240; // two feet

const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

function unit(from: Point, to: Point): Point | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) return null;
  return { x: dx / length, y: dy / length };
}

/**
 * A true distance between two points, drawn parallel to them.
 *
 * The witness lines run from each point out to the dimension line, which is the
 * convention that makes it clear what is being measured when the dimension sits
 * away from the geometry.
 */
export function alignedDimension(
  a: Point,
  b: Point,
  offset = DEFAULT_OFFSET,
  system: UnitSystem = 'imperial',
): DimensionDrawing | null {
  const along = unit(a, b);
  if (!along) return null;
  const normal = { x: -along.y, y: along.x };

  const shift = (p: Point): Point => ({ x: p.x + normal.x * offset, y: p.y + normal.y * offset });
  const a2 = shift(a);
  const b2 = shift(b);
  const value = Math.hypot(b.x - a.x, b.y - a.y);

  return {
    kind: 'aligned',
    lines: [
      [a2, b2],
      [a, a2],
      [b, b2],
    ],
    text: formatDistance(value, system),
    at: midpoint(a2, b2),
    value,
  };
}

/**
 * The horizontal or vertical component of a distance.
 *
 * What a builder sets out from: a room is `40 ft` wide even when the corner it
 * was measured from is not square.
 */
export function linearDimension(
  a: Point,
  b: Point,
  axis: 'horizontal' | 'vertical',
  offset = DEFAULT_OFFSET,
  system: UnitSystem = 'imperial',
): DimensionDrawing | null {
  const value = axis === 'horizontal' ? Math.abs(b.x - a.x) : Math.abs(b.y - a.y);
  if (value < 1e-9) return null;

  const line =
    axis === 'horizontal'
      ? [
          { x: a.x, y: Math.max(a.y, b.y) + offset },
          { x: b.x, y: Math.max(a.y, b.y) + offset },
        ]
      : [
          { x: Math.max(a.x, b.x) + offset, y: a.y },
          { x: Math.max(a.x, b.x) + offset, y: b.y },
        ];

  return {
    kind: 'linear',
    lines: [line, [a, line[0]], [b, line[1]]],
    text: formatDistance(value, system),
    at: midpoint(line[0], line[1]),
    value,
  };
}

/**
 * A radius, drawn as a leader from the centre out through the arc.
 *
 * The one dimension a curved wall genuinely needs: it is what gets set out on
 * site, and it is not recoverable by eye from the drawn polyline.
 */
export function radiusDimension(segment: WallSegment, system: UnitSystem = 'imperial'): DimensionDrawing | null {
  const arc = arcOf(segment);
  if (!arc) return null;

  const at = arc.startAngle + arc.sweep / 2;
  const onArc = { x: arc.centre.x + arc.radius * Math.cos(at), y: arc.centre.y + arc.radius * Math.sin(at) };

  return {
    kind: 'radius',
    lines: [[arc.centre, onArc]],
    text: `R ${formatDistance(arc.radius, system)}`,
    at: midpoint(arc.centre, onArc),
    value: arc.radius,
  };
}

/** A diameter, drawn straight across the circle the wall belongs to. */
export function diameterDimension(segment: WallSegment, system: UnitSystem = 'imperial'): DimensionDrawing | null {
  const arc = arcOf(segment);
  if (!arc) return null;

  const at = arc.startAngle + arc.sweep / 2;
  const near = { x: arc.centre.x + arc.radius * Math.cos(at), y: arc.centre.y + arc.radius * Math.sin(at) };
  const far = { x: arc.centre.x - arc.radius * Math.cos(at), y: arc.centre.y - arc.radius * Math.sin(at) };

  return {
    kind: 'diameter',
    lines: [[far, near]],
    text: `DIA ${formatDistance(arc.radius * 2, system)}`,
    at: arc.centre,
    value: arc.radius * 2,
  };
}

/**
 * The distance along a curve rather than across it.
 *
 * This is the number that buys material: a curved wall is quoted by the metre
 * or foot of run, and its chord is always shorter than what gets built.
 */
export function arcDimension(segment: WallSegment, system: UnitSystem = 'imperial'): DimensionDrawing | null {
  const arc = arcOf(segment);
  if (!arc) return null;

  const value = wallLength(segment);
  const at = arc.startAngle + arc.sweep / 2;

  return {
    kind: 'arc',
    lines: [flattenWall(segment)],
    text: `ARC ${formatDistance(value, system)}`,
    at: { x: arc.centre.x + arc.radius * Math.cos(at), y: arc.centre.y + arc.radius * Math.sin(at) },
    value,
  };
}

/**
 * The angle between two directions from a corner.
 *
 * Drawn as a short arc between the two rays, which is how a splayed corner or
 * an angled stage gets specified.
 */
export function angleDimension(
  vertex: Point,
  toward: Point,
  other: Point,
  radius = DEFAULT_OFFSET,
  _system: UnitSystem = 'imperial',
): DimensionDrawing | null {
  const a = unit(vertex, toward);
  const b = unit(vertex, other);
  if (!a || !b) return null;

  const from = Math.atan2(a.y, a.x);
  const to = Math.atan2(b.y, b.x);
  // The angle at a corner is the one under 180 degrees; the reflex is never
  // what somebody means by "what angle is that wall".
  let sweep = to - from;
  while (sweep <= -Math.PI) sweep += 2 * Math.PI;
  while (sweep > Math.PI) sweep -= 2 * Math.PI;

  const degrees = Math.abs((sweep * 180) / Math.PI);
  const steps = Math.max(4, Math.ceil(Math.abs(sweep) / 0.1));
  const curve: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const angle = from + (sweep * i) / steps;
    curve.push({ x: vertex.x + radius * Math.cos(angle), y: vertex.y + radius * Math.sin(angle) });
  }

  const middle = from + sweep / 2;
  return {
    kind: 'angle',
    lines: [curve, [vertex, curve[0]], [vertex, curve[curve.length - 1]]],
    // 0xB0 is the degree sign in latin-1, which these files can carry.
    text: `${degrees.toFixed(degrees % 1 < 0.05 ? 0 : 1)}°`,
    at: { x: vertex.x + radius * 1.3 * Math.cos(middle), y: vertex.y + radius * 1.3 * Math.sin(middle) },
    value: degrees,
  };
}

/**
 * Dimensions every wall of a room in one go.
 *
 * Straight runs get their length; curved ones get a radius, because that is
 * what a curved wall is built from. The offsets push each dimension outward,
 * away from the floor where the furniture goes.
 */
export function dimensionRoom(
  room: RoomModel,
  system: UnitSystem = 'imperial',
  offset = DEFAULT_OFFSET,
): DimensionDrawing[] {
  const out: DimensionDrawing[] = [];

  for (const segment of room.walls) {
    if (segment.virtual) continue;
    if (segment.bulge) {
      const radius = radiusDimension(segment, system);
      if (radius) out.push(radius);
      continue;
    }
    // Negative offset: `roomFromPolygon` winds counter-clockwise, so the left
    // normal that `alignedDimension` uses points into the room.
    const aligned = alignedDimension(segment.start, segment.end, -offset, system);
    if (aligned) out.push(aligned);
  }

  return out;
}

/** The angle at each corner, for a room that is not square. */
export function dimensionCorners(room: RoomModel, radius = DEFAULT_OFFSET): DimensionDrawing[] {
  const out: DimensionDrawing[] = [];

  for (let i = 0; i < room.walls.length; i++) {
    const incoming = room.walls[(i - 1 + room.walls.length) % room.walls.length];
    const outgoing = room.walls[i];
    if (incoming.bulge || outgoing.bulge) continue;

    const drawing = angleDimension(outgoing.start, incoming.start, outgoing.end, radius);
    // A square corner is not worth annotating; it is the assumption.
    if (drawing && Math.abs(drawing.value - 90) > 0.5) out.push(drawing);
  }

  return out;
}
