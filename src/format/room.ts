/**
 * The room as an object rather than a bounding box.
 *
 * `Scene.roomExtent` is four numbers — the axis-aligned box around whatever
 * wall primitives a file happens to contain. That is enough to frame a view and
 * nothing else. It cannot say how big the room is, because a 40x30 box around
 * an L-shaped ballroom reports 1,200 sq ft of floor that does not exist; it
 * cannot say where the walls are, so nothing can be fitted against them; and it
 * has no notion of a column, a bay, or a curved back wall.
 *
 * A room here is an ordered boundary of wall segments, optionally with holes
 * cut out of it. Curved walls are carried as arcs using the bulge convention —
 * `tan(theta/4)`, signed counter-clockwise — which is what DXF uses, so a curve
 * survives export without being flattened to a polyline first.
 *
 * The model lives in the companion document. Its *rendered* walls are ordinary
 * `RVSegmentLine` objects in the `.rv4`, so a legacy Room Viewer opening the
 * same file sees a normal room.
 */

import type { Point, RVDocument } from './rv.js';
import { UNITS_PER_FOOT } from './rv.js';
import { buildScene, type Scene } from './scene.js';
import { toSquareFeet } from './units.js';

/**
 * One run of wall.
 *
 * `bulge` is zero for a straight run. Otherwise it is `tan(theta/4)` where
 * `theta` is the included angle of the arc, positive counter-clockwise: 0 is a
 * straight line, 1 is a half circle, and the sign says which way it bows.
 */
export interface WallSegment {
  id: string;
  start: Point;
  end: Point;
  bulge?: number;
  /** Wall thickness in logical units, for plans that draw both faces. */
  thickness?: number;
  /** Excluded from capacity and fitting — a curtain line, a room divider. */
  virtual?: boolean;
  label?: string;
}

export interface RoomModel {
  id: string;
  name: string;
  /** Boundary, in order. A closed room ends where it starts. */
  walls: WallSegment[];
  /** Columns and cut-outs, each an ordered loop subtracted from the floor. */
  holes: WallSegment[][];
  /** Ceiling height in logical units, when known. */
  ceilingHeight?: number;
  /** Floor area the plan cannot use, in square logical units (service, stage). */
  reservedArea?: number;
}

/** How close two endpoints must be to count as joined: one tenth of an inch. */
const JOIN_TOLERANCE = 1;
/** Flattening error budget for arcs: a hundredth of an inch. */
const ARC_TOLERANCE = 0.1;

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter.toString(36)}`;
}

export function wall(start: Point, end: Point, bulge = 0): WallSegment {
  return { id: nextId('w'), start, end, bulge: bulge || undefined };
}

/** Geometry of an arc segment, or `null` when the run is straight. */
export function arcOf(segment: WallSegment): {
  centre: Point;
  radius: number;
  startAngle: number;
  sweep: number;
} | null {
  const b = segment.bulge;
  if (!b || !Number.isFinite(b)) return null;

  const vx = segment.end.x - segment.start.x;
  const vy = segment.end.y - segment.start.y;
  const chord = Math.hypot(vx, vy);
  if (chord < 1e-9) return null;

  const sweep = 4 * Math.atan(b);
  const half = sweep / 2;
  const sinHalf = Math.sin(half);
  if (Math.abs(sinHalf) < 1e-12) return null;

  const radius = Math.abs(chord / (2 * sinHalf));
  // Left normal of the chord, with the centre r*cos(theta/2) along it. That
  // sign is what makes the sweep counter-clockwise for a positive bulge: it
  // puts the centre opposite the bow on a minor arc and flips it past the
  // half circle, where cos goes negative on its own.
  const nx = -vy / chord;
  const ny = vx / chord;
  const h = radius * Math.cos(half);
  const centre = {
    x: (segment.start.x + segment.end.x) / 2 + nx * h,
    y: (segment.start.y + segment.end.y) / 2 + ny * h,
  };

  return {
    centre,
    radius,
    startAngle: Math.atan2(segment.start.y - centre.y, segment.start.x - centre.x),
    sweep,
  };
}

/** Length of one wall run, following the curve where there is one. */
export function wallLength(segment: WallSegment): number {
  const arc = arcOf(segment);
  if (arc) return arc.radius * Math.abs(arc.sweep);
  return Math.hypot(segment.end.x - segment.start.x, segment.end.y - segment.start.y);
}

/** Splits an arc into straight runs no further than `tolerance` from the curve. */
export function flattenWall(segment: WallSegment, tolerance = ARC_TOLERANCE): Point[] {
  const arc = arcOf(segment);
  if (!arc) return [segment.start, segment.end];

  const { centre, radius, startAngle, sweep } = arc;
  // Sagitta of one step must stay under the tolerance.
  const ratio = Math.max(-1, Math.min(1, 1 - tolerance / radius));
  const maxStep = 2 * Math.acos(ratio);
  const steps = Math.max(2, Math.min(2048, Math.ceil(Math.abs(sweep) / Math.max(maxStep, 1e-6))));

  const out: Point[] = [segment.start];
  for (let i = 1; i < steps; i++) {
    const a = startAngle + (sweep * i) / steps;
    out.push({ x: centre.x + radius * Math.cos(a), y: centre.y + radius * Math.sin(a) });
  }
  out.push(segment.end);
  return out;
}

/** The room boundary as a plain polygon, arcs flattened. */
export function roomPolygon(walls: WallSegment[], tolerance = ARC_TOLERANCE): Point[] {
  const out: Point[] = [];
  for (const segment of walls) {
    const points = flattenWall(segment, tolerance);
    // Consecutive runs share an endpoint; emit it once.
    for (let i = out.length ? 1 : 0; i < points.length; i++) out.push(points[i]);
  }
  return out;
}

/** Signed area of a polygon, positive counter-clockwise. */
function shoelace(points: Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

/**
 * Signed area enclosed by a wall loop, exactly.
 *
 * Flattening the arcs first and measuring the polygon would make the answer a
 * function of the flattening tolerance — a round room would come out under by
 * a tenth of a percent, and the error would change if the tolerance ever did.
 * Instead the chords are measured as a polygon and each arc contributes its
 * circular segment, `(r^2 / 2)(theta - sin theta)`, which is exact: an arc
 * bowing outward adds floor, one bowing inward takes it away.
 */
function signedLoopArea(walls: WallSegment[]): number {
  if (walls.length < 2) return 0;

  const chords = walls.map((w) => w.start);
  let area = shoelace(chords);

  for (const segment of walls) {
    const arc = arcOf(segment);
    if (!arc) continue;
    area += (arc.radius * arc.radius * (arc.sweep - Math.sin(arc.sweep))) / 2;
  }
  return area;
}

export function isClosed(walls: WallSegment[], tolerance = JOIN_TOLERANCE): boolean {
  if (walls.length < 3) return false;
  const first = walls[0].start;
  const last = walls[walls.length - 1].end;
  return Math.hypot(first.x - last.x, first.y - last.y) <= tolerance;
}

/** Distance around the room, following curves. */
export function roomPerimeter(room: RoomModel): number {
  return room.walls.reduce((sum, w) => sum + wallLength(w), 0);
}

/**
 * Floor area in square logical units, holes removed.
 *
 * An open boundary is treated as closed by joining the last point back to the
 * first; a half-drawn room reports the area it would enclose rather than zero,
 * which is what someone mid-draw expects to see.
 */
export function roomArea(room: RoomModel): number {
  if (room.walls.length < 3) return 0;
  const outer = Math.abs(signedLoopArea(room.walls));
  const holes = room.holes.reduce((sum, loop) => sum + Math.abs(signedLoopArea(loop)), 0);
  return Math.max(0, outer - holes);
}

/** Area left once reserved floor — stage, buffet, dance floor — is taken out. */
export function usableArea(room: RoomModel): number {
  return Math.max(0, roomArea(room) - (room.reservedArea ?? 0));
}

/** Axis-aligned bounds of the boundary, for framing a view. */
export function roomBounds(room: RoomModel): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const points = roomPolygon(room.walls);
  if (!points.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** True when a point is inside the room and not inside one of its holes. */
export function containsPoint(room: RoomModel, point: Point): boolean {
  const inside = (polygon: Point[]): boolean => {
    let hit = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const a = polygon[i];
      const b = polygon[j];
      if (a.y > point.y !== b.y > point.y) {
        const x = ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
        if (point.x < x) hit = !hit;
      }
    }
    return hit;
  };

  if (!inside(roomPolygon(room.walls))) return false;
  return !room.holes.some((loop) => inside(roomPolygon(loop)));
}

// ---------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------

export type SeatingLayout =
  | 'theatre'
  | 'schoolroom'
  | 'banquet'
  | 'cabaret'
  | 'reception'
  | 'conference'
  | 'hollow-square'
  | 'u-shape';

/**
 * Square feet per person, by layout.
 *
 * These are the planning figures the events trade works from, not a measured
 * property of a particular room, so they are given as a range and the caller is
 * expected to show it as one. They already allow for aisles and circulation but
 * not for anything the room is also doing: stage, dance floor, buffet, bars and
 * back-of-house all have to come off the area first, which is what
 * `RoomModel.reservedArea` is for.
 */
const SQ_FT_PER_PERSON: Record<SeatingLayout, { low: number; high: number }> = {
  theatre: { low: 6, high: 8 },
  schoolroom: { low: 15, high: 18 },
  banquet: { low: 12, high: 15 },
  cabaret: { low: 15, high: 18 },
  reception: { low: 5, high: 8 },
  conference: { low: 23, high: 30 },
  'hollow-square': { low: 30, high: 35 },
  'u-shape': { low: 30, high: 35 },
};

export interface Capacity {
  layout: SeatingLayout;
  /** Fewest people, using the most generous allowance. */
  low: number;
  /** Most people, using the tightest allowance. */
  high: number;
  /** Square feet each person is allowed at the midpoint of the range. */
  squareFeetEach: number;
}

/**
 * Estimates how many people a room seats in a given layout.
 *
 * This is an estimate from floor area, and deliberately not presented as a
 * number the fire marshal would recognise — occupancy is a code question that
 * depends on exits, sprinklers and local amendments, none of which are in the
 * drawing.
 */
export function roomCapacity(room: RoomModel, layout: SeatingLayout): Capacity {
  const squareFeet = toSquareFeet(usableArea(room));
  const { low, high } = SQ_FT_PER_PERSON[layout];
  return {
    layout,
    low: Math.floor(squareFeet / high),
    high: Math.floor(squareFeet / low),
    squareFeetEach: (low + high) / 2,
  };
}

/** Capacity in every layout, for the summary panel. */
export function allCapacities(room: RoomModel): Capacity[] {
  return (Object.keys(SQ_FT_PER_PERSON) as SeatingLayout[]).map((layout) => roomCapacity(room, layout));
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export function emptyRoom(name = 'Room'): RoomModel {
  return { id: nextId('room'), name, walls: [], holes: [] };
}

/** A plain rectangular room, the starting point for most plans. */
export function rectangularRoom(width: number, height: number, name = 'Room', origin: Point = { x: 0, y: 0 }): RoomModel {
  const { x, y } = origin;
  const corners: Point[] = [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];
  return roomFromPolygon(corners, name);
}

/**
 * A true circular room, kept as four exact quarter-circle wall arcs.
 *
 * Using four arcs instead of a many-sided polygon matters downstream: area and
 * perimeter stay exact, the Room panel reports four curved walls rather than
 * dozens of tiny straight ones, and DXF export can retain the curves.
 */
export function circularRoom(diameter: number, name = 'Room', origin: Point = { x: 0, y: 0 }): RoomModel {
  const radius = diameter / 2;
  const centre = { x: origin.x + radius, y: origin.y + radius };
  const points: Point[] = [
    { x: centre.x, y: origin.y },
    { x: origin.x + diameter, y: centre.y },
    { x: centre.x, y: origin.y + diameter },
    { x: origin.x, y: centre.y },
  ];
  // tan(90° / 4), the DXF bulge for a quarter circle.
  const quarterCircle = Math.tan(Math.PI / 8);
  return {
    id: nextId('room'),
    name,
    walls: points.map((start, index) => wall(start, points[(index + 1) % points.length], quarterCircle)),
    holes: [],
  };
}

/**
 * Drops corners that are not corners.
 *
 * Tracing a boundary out of grid cells — which is how the boolean operations
 * work — puts a vertex at every cell edge, so a plain 40ft wall comes back as
 * five collinear points. Removing them is what makes the result look like a
 * room somebody drew rather than the output of an algorithm.
 */
export function simplifyCollinear(points: Point[], tolerance = 1e-6): Point[] {
  if (points.length < 3) return points.slice();
  const out: Point[] = [];

  for (let i = 0; i < points.length; i++) {
    const prev = points[(i - 1 + points.length) % points.length];
    const here = points[i];
    const next = points[(i + 1) % points.length];
    // Twice the triangle area: zero when the three are in line.
    const cross = (here.x - prev.x) * (next.y - prev.y) - (here.y - prev.y) * (next.x - prev.x);
    const scale = Math.hypot(next.x - prev.x, next.y - prev.y);
    if (scale > 0 && Math.abs(cross) / scale <= tolerance) continue;
    out.push(here);
  }

  return out.length >= 3 ? out : points.slice();
}

/** A room from an ordered list of corners; the loop is closed automatically. */
export function roomFromPolygon(corners: Point[], name = 'Room'): RoomModel {
  const walls: WallSegment[] = [];
  for (let i = 0; i < corners.length; i++) {
    const start = corners[i];
    const end = corners[(i + 1) % corners.length];
    if (Math.hypot(end.x - start.x, end.y - start.y) < 1e-9) continue;
    walls.push(wall(start, end));
  }
  return { id: nextId('room'), name, walls, holes: [] };
}

/** A rectangular hole — a column, a service cupboard, a structural core. */
export function rectangularHole(x: number, y: number, width: number, height: number): WallSegment[] {
  return roomFromPolygon(
    [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ],
    'hole',
  ).walls;
}

// ---------------------------------------------------------------------------
// Deriving a room from a legacy plan
// ---------------------------------------------------------------------------

const key = (p: Point): string => `${Math.round(p.x / JOIN_TOLERANCE)},${Math.round(p.y / JOIN_TOLERANCE)}`;

export interface Edge {
  a: Point;
  b: Point;
  used?: boolean;
}

/**
 * Chains loose segments into closed loops.
 *
 * Room Viewer files store a room as unconnected line and polyline objects with
 * no ordering, so a boundary has to be recovered by matching endpoints. Where
 * more than one loop closes — a room with an inner core, or two adjoining
 * rooms — the caller decides which is the boundary and which are holes.
 *
 * Also used by the boolean operations, which produce a bag of unordered cell
 * edges that has to become an outline the same way.
 */
export function chainLoops(input: Edge[]): Point[][] {
  const edges = input.map((e) => ({ a: e.a, b: e.b, used: false }));
  const byPoint = new Map<string, number[]>();
  edges.forEach((edge, i) => {
    for (const p of [edge.a, edge.b]) {
      const k = key(p);
      const list = byPoint.get(k);
      if (list) list.push(i);
      else byPoint.set(k, [i]);
    }
  });

  const loops: Point[][] = [];

  for (let seed = 0; seed < edges.length; seed++) {
    if (edges[seed].used) continue;
    edges[seed].used = true;

    const loop: Point[] = [edges[seed].a, edges[seed].b];
    const startKey = key(edges[seed].a);
    let head = edges[seed].b;

    // Follow whichever unused edge continues from the current end.
    for (let guard = 0; guard < edges.length + 1; guard++) {
      if (key(head) === startKey) break;
      const candidates = byPoint.get(key(head)) ?? [];
      const nextIndex = candidates.find((i) => !edges[i].used);
      if (nextIndex == null) break;
      const edge = edges[nextIndex];
      edge.used = true;
      head = key(edge.a) === key(head) ? edge.b : edge.a;
      loop.push(head);
    }

    if (loop.length >= 4 && key(head) === startKey) {
      loop.pop(); // the closing point repeats the first
      loops.push(loop);
    }
  }

  return loops;
}

export interface DerivedRoom {
  room: RoomModel;
  /** How the boundary was arrived at, so the UI can be honest about it. */
  source: 'walls' | 'region' | 'extent' | 'none';
  /** True when the boundary closed; an open one is a best guess. */
  closed: boolean;
}

/**
 * Recovers a room model from a plan that has no companion document.
 *
 * This is what makes the model useful on the 1,955 files that already exist:
 * open any of them and the area, perimeter and capacity are there, without
 * anyone having redrawn the room. Where no wall geometry can be chained into a
 * loop it falls back to the extent — honestly labelled, because a bounding box
 * over-reports an irregular room.
 */
export function deriveRoom(doc: RVDocument, scene?: Scene): DerivedRoom {
  const built = scene ?? buildScene(doc);

  for (const layer of ['walls', 'region'] as const) {
    const edges: Edge[] = [];
    for (const primitive of built.primitives) {
      if (primitive.layer !== layer) continue;
      if (primitive.type === 'text' || primitive.type === 'dimension') continue;
      const pts = primitive.pts;
      for (let i = 0; i + 3 < pts.length; i += 2) {
        const a = { x: pts[i], y: pts[i + 1] };
        const b = { x: pts[i + 2], y: pts[i + 3] };
        if (Math.hypot(b.x - a.x, b.y - a.y) < JOIN_TOLERANCE) continue;
        edges.push({ a, b, used: false });
      }
      // A closed outline stores its corners without repeating the first.
      if (primitive.type === 'polygon' && pts.length >= 6) {
        const a = { x: pts[pts.length - 2], y: pts[pts.length - 1] };
        const b = { x: pts[0], y: pts[1] };
        if (Math.hypot(b.x - a.x, b.y - a.y) >= JOIN_TOLERANCE) edges.push({ a, b, used: false });
      }
    }
    if (!edges.length) continue;

    const loops = chainLoops(edges).sort((p, q) => Math.abs(shoelace(q)) - Math.abs(shoelace(p)));
    // Straight-sided loops only at this point: a derived boundary has no arcs
    // until curve authoring puts them there, so the polygon form is exact.
    if (!loops.length) continue;

    const room = roomFromPolygon(loops[0], built.title ?? 'Room');
    // Anything the boundary fully contains is a hole, not a second room.
    for (const loop of loops.slice(1)) {
      const centroid = loop.reduce(
        (acc, p) => ({ x: acc.x + p.x / loop.length, y: acc.y + p.y / loop.length }),
        { x: 0, y: 0 },
      );
      if (containsPoint(room, centroid)) room.holes.push(roomFromPolygon(loop, 'hole').walls);
    }
    return { room, source: layer, closed: true };
  }

  const extent = built.roomExtent;
  if (extent) {
    const room = rectangularRoom(
      extent.maxX - extent.minX,
      extent.maxY - extent.minY,
      built.title ?? 'Room',
      { x: extent.minX, y: extent.minY },
    );
    return { room, source: 'extent', closed: false };
  }

  return { room: emptyRoom(built.title ?? 'Room'), source: 'none', closed: false };
}

/** A one-line summary of a room, for the status bar. */
export function describeRoom(room: RoomModel): string {
  const bounds = roomBounds(room);
  if (!bounds) return 'no room';
  const w = (bounds.maxX - bounds.minX) / UNITS_PER_FOOT;
  const h = (bounds.maxY - bounds.minY) / UNITS_PER_FOOT;
  return `${w.toFixed(0)} x ${h.toFixed(0)} ft, ${Math.round(toSquareFeet(roomArea(room))).toLocaleString('en-US')} sq ft`;
}
