/**
 * Authoring a room: changing its shape after it has been drawn.
 *
 * The operations here are the ones an event room actually needs. A ballroom is
 * a rectangle until the air wall opens and it is two rectangles; a hall has a
 * service corridor cut out of one end; a foyer has a bay added along a window
 * line. All of that is boundary editing, and none of it was possible while the
 * room was a bounding box.
 *
 * **On the boolean operations.** They work by cutting both outlines against a
 * grid of every x and y coordinate either one uses, testing each cell for
 * membership, and tracing the boundary of the cells that survive. That is exact
 * for axis-aligned outlines and needs no tolerance, no intersection arithmetic
 * and no special cases for touching or coincident edges — which is where a
 * general polygon clipper spends its bugs.
 *
 * The price is that it is exact *only* for axis-aligned outlines, so a diagonal
 * or curved boundary is refused rather than approximated. Rooms in this trade
 * are overwhelmingly rectilinear, and a refusal that says why is worth more
 * than a result that is quietly a few inches wrong. Vertex editing below has no
 * such restriction.
 */

import { combinePolygons, type Point as BooleanPoint } from './polygon-boolean.js';
import {
  bulgeFromAngle,
  bulgeFromArcLength,
  bulgeFromRadius,
  bulgeFromSagitta,
  bulgeFromTangent,
  bulgeThroughPoint,
  exitDirection,
} from './curve.js';
import {
  chainLoops,
  containsPoint,
  roomArea,
  roomFromPolygon,
  roomPolygon,
  simplifyCollinear,
  wall,
  type Edge,
  type RoomModel,
  type WallSegment,
} from './room.js';
import type { Point } from './rv.js';

export type BooleanOp = 'union' | 'difference' | 'intersection';

export interface RoomEditResult {
  ok: boolean;
  reason?: string;
  room?: RoomModel;
}

const AXIS_TOLERANCE = 1e-6;

/** True when every run is straight and either horizontal or vertical. */
export function isAxisAligned(walls: WallSegment[]): boolean {
  return walls.every((w) => {
    if (w.bulge) return false;
    const dx = Math.abs(w.end.x - w.start.x);
    const dy = Math.abs(w.end.y - w.start.y);
    return dx <= AXIS_TOLERANCE || dy <= AXIS_TOLERANCE;
  });
}

function allWalls(room: RoomModel): WallSegment[] {
  return [...room.walls, ...room.holes.flat()];
}

function uniqueSorted(values: number[]): number[] {
  const out = [...new Set(values.map((v) => Number(v.toFixed(6))))].sort((a, b) => a - b);
  return out;
}

/**
 * Combines two rooms.
 *
 * `union` opens an air wall between adjoining rooms, `difference` cuts a
 * corridor or plant room out of one, `intersection` is the overlap of a room
 * and a licensed area. Holes in either operand are honoured, and holes that
 * appear in the result — a doughnut left by a union around a core — come back
 * as holes rather than being flattened away.
 */
export function combineRooms(a: RoomModel, b: RoomModel, op: BooleanOp): RoomEditResult {
  /*
   * Anything that is not two rectilinear outlines goes to the general clipper.
   *
   * The grid decomposition below is exact for horizontal and vertical walls and
   * cannot represent anything else, which is why it used to refuse. It is kept
   * as the fast path for the commonest case — adding or cutting a rectangle —
   * and everything it cannot do now has somewhere to go instead of a message
   * saying no.
   */
  if (!isAxisAligned(allWalls(a)) || !isAxisAligned(allWalls(b))) {
    return combineRoomsGeneral(a, b, op);
  }
  if (a.walls.length < 3 || b.walls.length < 3) {
    return { ok: false, reason: 'Both rooms need a closed outline before they can be combined.' };
  }

  const points = [...roomPolygon(allWalls(a)), ...roomPolygon(allWalls(b))];
  const xs = uniqueSorted(points.map((p) => p.x));
  const ys = uniqueSorted(points.map((p) => p.y));
  if (xs.length < 2 || ys.length < 2) {
    return { ok: false, reason: 'These outlines do not enclose any floor.' };
  }
  // A pathological outline could otherwise build a grid of millions of cells.
  if ((xs.length - 1) * (ys.length - 1) > 250_000) {
    return { ok: false, reason: 'These outlines are too complicated to combine.' };
  }

  const cols = xs.length - 1;
  const rows = ys.length - 1;
  const keep = new Uint8Array(cols * rows);

  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const centre = { x: (xs[i] + xs[i + 1]) / 2, y: (ys[j] + ys[j + 1]) / 2 };
      const inA = containsPoint(a, centre);
      const inB = containsPoint(b, centre);
      const selected = op === 'union' ? inA || inB : op === 'intersection' ? inA && inB : inA && !inB;
      if (selected) keep[i * rows + j] = 1;
    }
  }

  const selectedAt = (i: number, j: number): boolean =>
    i >= 0 && j >= 0 && i < cols && j < rows && keep[i * rows + j] === 1;

  // A cell contributes each side its neighbour does not share. Wound so the
  // outside stays on the same hand throughout, which keeps the loops closed.
  const edges: Edge[] = [];
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      if (!selectedAt(i, j)) continue;
      const x0 = xs[i];
      const x1 = xs[i + 1];
      const y0 = ys[j];
      const y1 = ys[j + 1];
      if (!selectedAt(i, j - 1)) edges.push({ a: { x: x0, y: y0 }, b: { x: x1, y: y0 } });
      if (!selectedAt(i + 1, j)) edges.push({ a: { x: x1, y: y0 }, b: { x: x1, y: y1 } });
      if (!selectedAt(i, j + 1)) edges.push({ a: { x: x1, y: y1 }, b: { x: x0, y: y1 } });
      if (!selectedAt(i - 1, j)) edges.push({ a: { x: x0, y: y1 }, b: { x: x0, y: y0 } });
    }
  }

  if (!edges.length) {
    return {
      ok: false,
      reason:
        op === 'intersection'
          ? 'These rooms do not overlap.'
          : 'That would leave no floor at all.',
    };
  }

  const loops = chainLoops(edges)
    .map((loop) => simplifyCollinear(loop))
    .filter((loop) => loop.length >= 3);
  if (!loops.length) return { ok: false, reason: 'The combined outline did not close.' };

  const withArea = loops
    .map((loop) => ({ loop, area: Math.abs(roomArea(roomFromPolygon(loop))) }))
    .sort((p, q) => q.area - p.area);

  const room = roomFromPolygon(withArea[0].loop, a.name);
  room.ceilingHeight = a.ceilingHeight ?? b.ceilingHeight;

  for (const { loop } of withArea.slice(1)) {
    const centroid = loop.reduce(
      (acc, p) => ({ x: acc.x + p.x / loop.length, y: acc.y + p.y / loop.length }),
      { x: 0, y: 0 },
    );
    if (containsPoint(room, centroid)) room.holes.push(roomFromPolygon(loop, 'hole').walls);
  }

  return { ok: true, room };
}

/** A rectangle as a room, for combining with one. */
export function rectRoom(x: number, y: number, width: number, height: number, name = 'area'): RoomModel {
  return roomFromPolygon(
    [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ],
    name,
  );
}

// ---------------------------------------------------------------------------
// Vertex editing — no axis-alignment restriction
// ---------------------------------------------------------------------------

/** The corners of a room, in order. Each is the start of the wall of that index. */
export function corners(room: RoomModel): Point[] {
  return room.walls.map((w) => ({ ...w.start }));
}

/**
 * Moves one corner, dragging the two walls that meet there.
 *
 * The only operation that has to exist: everything else about editing an
 * irregular room can be built from moving corners, adding them and removing
 * them.
 */
export function moveCorner(room: RoomModel, index: number, to: Point): RoomEditResult {
  if (index < 0 || index >= room.walls.length) return { ok: false, reason: 'no such corner' };
  if (!Number.isFinite(to.x) || !Number.isFinite(to.y)) return { ok: false, reason: 'invalid position' };

  const walls = room.walls.map((w) => ({ ...w, start: { ...w.start }, end: { ...w.end } }));
  const previous = (index - 1 + walls.length) % walls.length;
  walls[index].start = { ...to };
  walls[previous].end = { ...to };

  return { ok: true, room: { ...room, walls, holes: room.holes.map((h) => h.map((w) => ({ ...w }))) } };
}

/** Splits a wall in two, putting a new corner at `at` — or at its midpoint. */
export function addCorner(room: RoomModel, wallIndex: number, at?: Point): RoomEditResult {
  if (wallIndex < 0 || wallIndex >= room.walls.length) return { ok: false, reason: 'no such wall' };
  const target = room.walls[wallIndex];
  if (target.bulge) {
    return { ok: false, reason: 'Split a curved wall by straightening it first.' };
  }

  const point = at ?? {
    x: (target.start.x + target.end.x) / 2,
    y: (target.start.y + target.end.y) / 2,
  };

  const walls = room.walls.map((w) => ({ ...w }));
  const first = wall(target.start, point);
  const second = wall(point, target.end);
  first.thickness = target.thickness;
  second.thickness = target.thickness;
  walls.splice(wallIndex, 1, first, second);

  return { ok: true, room: { ...room, walls } };
}

/** Removes a corner, joining the walls either side of it into one run. */
export function removeCorner(room: RoomModel, index: number): RoomEditResult {
  if (room.walls.length <= 3) {
    return { ok: false, reason: 'A room needs at least three corners.' };
  }
  if (index < 0 || index >= room.walls.length) return { ok: false, reason: 'no such corner' };

  const walls = room.walls.map((w) => ({ ...w, start: { ...w.start }, end: { ...w.end } }));
  const previous = (index - 1 + walls.length) % walls.length;
  walls[previous].end = { ...walls[index].end };
  walls[previous].bulge = undefined;
  walls.splice(index, 1);

  return { ok: true, room: { ...room, walls } };
}

/**
 * Replaces a sharp corner with a tangent circular fillet.
 *
 * The adjoining straight walls are trimmed by `r / tan(angle / 2)` and a new
 * arc is inserted between them. That makes the radius genuine geometry rather
 * than a visual smoothing effect: area, perimeter, dimensions, print and DXF
 * all see the same rounded corner.
 */
export function roundCorner(room: RoomModel, index: number, radius: number): RoomEditResult {
  if (index < 0 || index >= room.walls.length) return { ok: false, reason: 'no such corner' };
  if (!(radius > 0) || !Number.isFinite(radius)) return { ok: false, reason: 'enter a positive corner radius' };

  const previousIndex = (index - 1 + room.walls.length) % room.walls.length;
  const previous = room.walls[previousIndex];
  const next = room.walls[index];
  if (previous.bulge || next.bulge) {
    return { ok: false, reason: 'Round a corner where both adjoining walls are straight.' };
  }

  const corner = next.start;
  const previousLength = Math.hypot(previous.start.x - corner.x, previous.start.y - corner.y);
  const nextLength = Math.hypot(next.end.x - corner.x, next.end.y - corner.y);
  if (previousLength < 2 || nextLength < 2) return { ok: false, reason: 'The adjoining walls are too short to round.' };

  const incoming = {
    x: (previous.start.x - corner.x) / previousLength,
    y: (previous.start.y - corner.y) / previousLength,
  };
  const outgoing = {
    x: (next.end.x - corner.x) / nextLength,
    y: (next.end.y - corner.y) / nextLength,
  };
  const angle = Math.acos(Math.max(-1, Math.min(1, incoming.x * outgoing.x + incoming.y * outgoing.y)));
  if (angle < 0.01 || Math.PI - angle < 0.01) {
    return { ok: false, reason: 'This corner is too sharp or too straight to round.' };
  }

  const trim = radius / Math.tan(angle / 2);
  const maxTrim = Math.min(previousLength, nextLength) * 0.49;
  if (trim > maxTrim) {
    return { ok: false, reason: 'That radius is too large for the adjoining walls.' };
  }

  const start = { x: corner.x + incoming.x * trim, y: corner.y + incoming.y * trim };
  const end = { x: corner.x + outgoing.x * trim, y: corner.y + outgoing.y * trim };
  const turn = incoming.x * outgoing.y - incoming.y * outgoing.x;
  const sweep = Math.PI - angle;
  const bulge = -Math.sign(turn || 1) * Math.tan(sweep / 4);

  const walls = room.walls.map((segment) => ({
    ...segment,
    start: { ...segment.start },
    end: { ...segment.end },
  }));
  walls[previousIndex].end = start;
  walls[index].start = end;
  const fillet = wall(start, end, bulge);
  fillet.thickness = previous.thickness ?? next.thickness;
  fillet.label = 'Rounded corner';
  walls.splice(index, 0, fillet);

  return { ok: true, room: { ...room, walls } };
}

/** Replaces every sharp corner with the same exact-radius tangent fillet. */
export function roundAllCorners(room: RoomModel, radius: number): RoomEditResult {
  if (!(radius > 0) || !Number.isFinite(radius)) return { ok: false, reason: 'enter a positive corner radius' };
  if (room.walls.length < 3) return { ok: false, reason: 'the room needs at least three corners' };
  if (room.walls.some((segment) => segment.bulge)) {
    return { ok: false, reason: 'Straighten the curved plot lines before rounding every corner.' };
  }

  const trims: Array<{
    before: Point;
    after: Point;
    bulge: number;
    distance: number;
  }> = [];

  for (let index = 0; index < room.walls.length; index++) {
    const previous = room.walls[(index - 1 + room.walls.length) % room.walls.length];
    const next = room.walls[index];
    const corner = next.start;
    const previousLength = Math.hypot(previous.start.x - corner.x, previous.start.y - corner.y);
    const nextLength = Math.hypot(next.end.x - corner.x, next.end.y - corner.y);
    if (previousLength < 2 || nextLength < 2) {
      return { ok: false, reason: `Corner ${index + 1} has adjoining lines that are too short to round.` };
    }

    const incoming = {
      x: (previous.start.x - corner.x) / previousLength,
      y: (previous.start.y - corner.y) / previousLength,
    };
    const outgoing = {
      x: (next.end.x - corner.x) / nextLength,
      y: (next.end.y - corner.y) / nextLength,
    };
    const angle = Math.acos(Math.max(-1, Math.min(1, incoming.x * outgoing.x + incoming.y * outgoing.y)));
    if (angle < 0.01 || Math.PI - angle < 0.01) {
      return { ok: false, reason: `Corner ${index + 1} is too sharp or too straight to round.` };
    }

    const distance = radius / Math.tan(angle / 2);
    if (distance > Math.min(previousLength, nextLength) * 0.49) {
      return { ok: false, reason: `That radius is too large at corner ${index + 1}.` };
    }
    const turn = incoming.x * outgoing.y - incoming.y * outgoing.x;
    trims.push({
      before: { x: corner.x + incoming.x * distance, y: corner.y + incoming.y * distance },
      after: { x: corner.x + outgoing.x * distance, y: corner.y + outgoing.y * distance },
      bulge: -Math.sign(turn || 1) * Math.tan((Math.PI - angle) / 4),
      distance,
    });
  }

  for (let index = 0; index < room.walls.length; index++) {
    const next = (index + 1) % room.walls.length;
    const length = Math.hypot(
      room.walls[index].end.x - room.walls[index].start.x,
      room.walls[index].end.y - room.walls[index].start.y,
    );
    if (trims[index].distance + trims[next].distance >= length * 0.98) {
      return { ok: false, reason: `That radius leaves no straight run on plot line ${index + 1}.` };
    }
  }

  const walls: WallSegment[] = [];
  for (let index = 0; index < room.walls.length; index++) {
    const next = (index + 1) % room.walls.length;
    const source = room.walls[index];
    const fillet = wall(trims[index].before, trims[index].after, trims[index].bulge);
    fillet.thickness = room.walls[(index - 1 + room.walls.length) % room.walls.length].thickness ?? source.thickness;
    fillet.label = `Rounded corner ${index + 1}`;
    const straight = wall(trims[index].after, trims[next].before);
    straight.thickness = source.thickness;
    straight.label = source.label;
    walls.push(fillet, straight);
  }

  return { ok: true, room: { ...room, walls } };
}

/**
 * Moves a whole wall along its own normal.
 *
 * Positive is outward for a counter-clockwise outline. The neighbouring walls
 * stretch to follow, which is what "make this room two feet deeper" means.
 */
export function offsetWall(room: RoomModel, index: number, distance: number): RoomEditResult {
  if (index < 0 || index >= room.walls.length) return { ok: false, reason: 'no such wall' };
  if (!Number.isFinite(distance)) return { ok: false, reason: 'invalid distance' };
  const target = room.walls[index];
  if (target.bulge) return { ok: false, reason: 'A curved wall cannot be offset yet.' };

  const dx = target.end.x - target.start.x;
  const dy = target.end.y - target.start.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) return { ok: false, reason: 'that wall has no length' };

  // Right normal, which is the outward one for a counter-clockwise outline —
  // the orientation `roomFromPolygon` produces. Positive therefore grows the
  // room, which is what "move this wall out two feet" has to mean.
  const nx = (dy / length) * distance;
  const ny = (-dx / length) * distance;

  const moved = moveCorner(room, index, { x: target.start.x + nx, y: target.start.y + ny });
  if (!moved.ok) return moved;
  const next = (index + 1) % room.walls.length;
  return moveCorner(moved.room!, next, { x: target.end.x + nx, y: target.end.y + ny });
}

/**
 * Sets a wall's chord length, keeping its start corner fixed.
 *
 * Curved walls must be straightened first — changing the chord under a bulge
 * silently changes the arc in a way that is hard to explain in the UI.
 */
export function setWallLength(room: RoomModel, index: number, length: number): RoomEditResult {
  if (index < 0 || index >= room.walls.length) return { ok: false, reason: 'no such wall' };
  if (!(length > 0) || !Number.isFinite(length)) return { ok: false, reason: 'enter a positive length' };
  const target = room.walls[index];
  if (target.bulge) return { ok: false, reason: 'Straighten the wall before changing its length.' };

  const dx = target.end.x - target.start.x;
  const dy = target.end.y - target.start.y;
  const current = Math.hypot(dx, dy);
  if (current < 1e-6) return { ok: false, reason: 'that wall has no direction to extend' };

  const endCorner = (index + 1) % room.walls.length;
  return moveCorner(room, endCorner, {
    x: target.start.x + (dx / current) * length,
    y: target.start.y + (dy / current) * length,
  });
}

/** Bows a straight wall into an arc, or straightens one. */
export function curveWall(room: RoomModel, index: number, bulge: number): RoomEditResult {
  if (index < 0 || index >= room.walls.length) return { ok: false, reason: 'no such wall' };
  if (!Number.isFinite(bulge)) return { ok: false, reason: 'invalid curve' };
  // Beyond a full turn the arc would wrap onto itself.
  if (Math.abs(bulge) > 100) return { ok: false, reason: 'that curve is too tight to draw' };

  const walls = room.walls.map((w, i) => (i === index ? { ...w, bulge: bulge || undefined } : { ...w }));
  return { ok: true, room: { ...room, walls } };
}

/**
 * Curves a wall by naming its radius, in logical units.
 *
 * A negative radius bows it the other way; `major` takes the long way round.
 * Returns a reason rather than a room when the radius cannot reach both ends,
 * which is the mistake people actually make.
 */
export function setWallRadius(room: RoomModel, index: number, radius: number, major = false): RoomEditResult {
  const target = room.walls[index];
  if (!target) return { ok: false, reason: 'no such wall' };
  const chord = Math.hypot(target.end.x - target.start.x, target.end.y - target.start.y);
  const bulge = bulgeFromRadius(chord, radius, major);
  if (bulge == null) {
    return {
      ok: false,
      reason: `A radius that small cannot reach both ends of a ${Math.round(chord / 120)} ft wall.`,
    };
  }
  return curveWall(room, index, bulge);
}

/** Curves a wall by how far it bows off the straight line between its ends. */
export function setWallSagitta(room: RoomModel, index: number, sagitta: number): RoomEditResult {
  const target = room.walls[index];
  if (!target) return { ok: false, reason: 'no such wall' };
  const chord = Math.hypot(target.end.x - target.start.x, target.end.y - target.start.y);
  const bulge = bulgeFromSagitta(chord, sagitta);
  if (bulge == null) return { ok: false, reason: 'that bow is too deep to draw as one arc' };
  return curveWall(room, index, bulge);
}

/** Curves a wall by its included angle: 90 degrees is a quarter round. */
export function setWallAngle(room: RoomModel, index: number, degrees: number): RoomEditResult {
  const bulge = bulgeFromAngle(degrees);
  if (bulge == null) return { ok: false, reason: 'an arc cannot turn a full circle between two points' };
  return curveWall(room, index, bulge);
}

/** Curves a wall so it runs a given distance rather than a given shape. */
export function setWallArcLength(room: RoomModel, index: number, length: number): RoomEditResult {
  const target = room.walls[index];
  if (!target) return { ok: false, reason: 'no such wall' };
  const chord = Math.hypot(target.end.x - target.start.x, target.end.y - target.start.y);
  const bulge = bulgeFromArcLength(chord, length);
  if (bulge == null) return { ok: false, reason: 'a wall cannot be shorter than the straight line between its ends' };
  return curveWall(room, index, bulge);
}

/** Curves a wall so it passes through a point — tracing a survey or a photo. */
export function fitWallThroughPoint(room: RoomModel, index: number, through: Point): RoomEditResult {
  const target = room.walls[index];
  if (!target) return { ok: false, reason: 'no such wall' };
  const bulge = bulgeThroughPoint(target.start, through, target.end);
  if (bulge == null) return { ok: false, reason: 'no arc passes through that point' };
  return curveWall(room, index, bulge);
}

/**
 * Curves a wall so it leaves flush with the wall before it.
 *
 * The join people notice: a curve that meets a straight run at an angle reads
 * as a mistake even when the radius is right.
 */
export function makeWallTangent(room: RoomModel, index: number): RoomEditResult {
  const target = room.walls[index];
  if (!target) return { ok: false, reason: 'no such wall' };
  const before = room.walls[(index - 1 + room.walls.length) % room.walls.length];
  if (before === target) return { ok: false, reason: 'there is no wall before this one' };

  const bulge = bulgeFromTangent(target.start, target.end, exitDirection(before));
  if (bulge == null) return { ok: false, reason: 'these walls cannot be joined smoothly' };
  return curveWall(room, index, bulge);
}

/**
 * Reports what is wrong with a room, in the order worth fixing.
 *
 * Returned as text meant for a person: an outline that has not closed and one
 * that crosses itself are both ordinary states while drawing, not errors, so
 * they are described rather than thrown.
 */
export function roomProblems(room: RoomModel): string[] {
  const problems: string[] = [];
  if (room.walls.length < 3) {
    problems.push('The room needs at least three walls.');
    return problems;
  }

  for (let i = 0; i < room.walls.length; i++) {
    const here = room.walls[i];
    const next = room.walls[(i + 1) % room.walls.length];
    if (Math.hypot(next.start.x - here.end.x, next.start.y - here.end.y) > 1) {
      problems.push(`Wall ${i + 1} does not meet wall ${((i + 1) % room.walls.length) + 1}.`);
      break;
    }
  }

  if (room.walls.some((w) => Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y) < 1)) {
    problems.push('One of the walls has no length.');
  }
  if (roomArea(room) <= 0) problems.push('The outline encloses no floor.');

  for (const hole of room.holes) {
    const centre = roomPolygon(hole).reduce(
      (acc, p, _i, all) => ({ x: acc.x + p.x / all.length, y: acc.y + p.y / all.length }),
      { x: 0, y: 0 },
    );
    if (!containsPoint(room, centre)) {
      problems.push('A cut-out sits outside the room.');
      break;
    }
  }

  return problems;
}


/**
 * Combines two outlines of any shape.
 *
 * Arcs are flattened to polylines first, at the same tolerance the renderer
 * uses, and the result comes back as straight segments. That is a real loss —
 * a bowed wall unioned with a foyer comes out as a fine polyline rather than
 * an arc — and it is the honest trade: the alternative on offer before was
 * refusing to combine them at all. A wall the operation did not touch keeps
 * its bulge, because the fast path above handles those cases untouched.
 */
function combineRoomsGeneral(a: RoomModel, b: RoomModel, op: BooleanOp): RoomEditResult {
  if (a.walls.length < 3 || b.walls.length < 3) {
    return { ok: false, reason: 'Both rooms need a closed outline before they can be combined.' };
  }

  const subject = roomPolygon(allWalls(a));
  const clip = roomPolygon(allWalls(b));
  if (subject.length < 3 || clip.length < 3) {
    return { ok: false, reason: 'These outlines do not enclose any floor.' };
  }

  const result = combinePolygons(subject, clip, op);
  if (!result || !result.outers.length) {
    return {
      ok: false,
      reason:
        op === 'intersection'
          ? 'These outlines do not overlap, so there is no room in common.'
          : 'That would remove the whole room.',
    };
  }

  // The room model carries one outer boundary. Several disjoint pieces is a
  // legitimate geometric answer and not a legitimate ROOM, so say so rather
  // than silently keeping the biggest and dropping the rest.
  if (result.outers.length > 1) {
    return {
      ok: false,
      reason:
        `That would leave ${result.outers.length} separate areas. ` +
        'A room has to be one enclosed space; combine them one at a time.',
    };
  }

  const room = roomFromPolygon(result.outers[0]!, a.name);
  room.holes = result.holes.map((hole: BooleanPoint[]) => roomFromPolygon(hole, 'hole').walls);
  room.ceilingHeight = a.ceilingHeight;

  return { ok: true, room };
}
