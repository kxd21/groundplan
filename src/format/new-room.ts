/**
 * Pure room construction shared by New Plan's renderer preview and the main
 * process that writes the file. Keeping one builder on both sides means the
 * preview cannot quietly promise geometry different from the saved plan.
 */

import {
  curveWall,
  roundAllCorners,
  setWallAngle,
  setWallArcLength,
  setWallRadius,
  setWallSagitta,
  type RoomEditResult,
} from './room-edit.js';
import {
  circularRoom,
  rectangularRoom,
  roomArea,
  roomFromPolygon,
  wall,
  type RoomModel,
} from './room.js';

export type NewRoomShape = 'rectangle' | 'rounded' | 'circle' | 'stadium' | 'l-shape' | 'u-shape';
export type NewRoomCurveMethod = 'radius' | 'sagitta' | 'angle' | 'arc-length';

export interface NewRoomCurveSpec {
  /** Zero-based boundary run, following the highlighted wall in the preview. */
  wallIndex: number;
  method: NewRoomCurveMethod;
  /** Logical units, except angle which is stated in degrees. */
  value: number;
  /** Same as the Room panel: true = bay / bulge out of the room. */
  outward?: boolean;
  /** Radius only: use the longer of the two arcs that join the endpoints. */
  major?: boolean;
}

export interface NewRoomSpec {
  shape: NewRoomShape;
  width?: number;
  depth?: number;
  diameter?: number;
  cornerRadius?: number;
  notchWidth?: number;
  notchDepth?: number;
  curve?: NewRoomCurveSpec;
}

export interface NewRoomBuildResult {
  ok: boolean;
  reason?: string;
  room?: RoomModel;
}

const validSize = (value: number | undefined): value is number => Number.isFinite(value) && (value ?? 0) > 0;

function centredRectangle(width: number, depth: number, name: string): RoomModel {
  return rectangularRoom(width, depth, name, { x: -width / 2, y: -depth / 2 });
}

function orthogonalRoom(
  shape: 'l-shape' | 'u-shape',
  width: number,
  depth: number,
  notchWidth: number,
  notchDepth: number,
  name: string,
): NewRoomBuildResult {
  if (!(notchWidth > 0) || !(notchDepth > 0)) {
    return { ok: false, reason: 'Enter a positive recess width and depth.' };
  }
  if (notchWidth >= width || notchDepth >= depth) {
    return { ok: false, reason: 'The recess must be smaller than the outside room dimensions.' };
  }

  const left = -width / 2;
  const right = width / 2;
  const top = -depth / 2;
  const bottom = depth / 2;
  const points = shape === 'l-shape'
    ? [
        { x: left, y: top },
        { x: right, y: top },
        { x: right, y: bottom - notchDepth },
        { x: right - notchWidth, y: bottom - notchDepth },
        { x: right - notchWidth, y: bottom },
        { x: left, y: bottom },
      ]
    : [
        { x: left, y: top },
        { x: right, y: top },
        { x: right, y: bottom },
        { x: notchWidth / 2, y: bottom },
        { x: notchWidth / 2, y: bottom - notchDepth },
        { x: -notchWidth / 2, y: bottom - notchDepth },
        { x: -notchWidth / 2, y: bottom },
        { x: left, y: bottom },
      ];

  return { ok: true, room: roomFromPolygon(points, name) };
}

/** A capsule room with two exact semicircular ends and two straight runs. */
function stadiumRoom(width: number, depth: number, name: string): NewRoomBuildResult {
  if (Math.abs(width - depth) < 1e-6) {
    return { ok: true, room: circularRoom(width, name, { x: -width / 2, y: -depth / 2 }) };
  }

  if (width > depth) {
    const radius = depth / 2;
    const straight = width - depth;
    const left = -straight / 2;
    const right = straight / 2;
    const top = -radius;
    const bottom = radius;
    return {
      ok: true,
      room: {
        id: `new-room-stadium`,
        name,
        holes: [],
        walls: [
          wall({ x: left, y: top }, { x: right, y: top }),
          wall({ x: right, y: top }, { x: right, y: bottom }, 1),
          wall({ x: right, y: bottom }, { x: left, y: bottom }),
          wall({ x: left, y: bottom }, { x: left, y: top }, 1),
        ],
      },
    };
  }

  const radius = width / 2;
  const straight = depth - width;
  const top = -straight / 2;
  const bottom = straight / 2;
  const left = -radius;
  const right = radius;
  return {
    ok: true,
    room: {
      id: `new-room-stadium`,
      name,
      holes: [],
      walls: [
        wall({ x: left, y: top }, { x: right, y: top }, 1),
        wall({ x: right, y: top }, { x: right, y: bottom }),
        wall({ x: right, y: bottom }, { x: left, y: bottom }, 1),
        wall({ x: left, y: bottom }, { x: left, y: top }),
      ],
    },
  };
}

function curveRoom(room: RoomModel, spec: NewRoomCurveSpec): RoomEditResult {
  if (!Number.isInteger(spec.wallIndex) || spec.wallIndex < 0 || spec.wallIndex >= room.walls.length) {
    return { ok: false, reason: 'Choose a wall that exists in this room.' };
  }
  if (!(spec.value > 0) || !Number.isFinite(spec.value)) {
    return { ok: false, reason: 'Enter a positive curve measurement.' };
  }

  const direction = spec.outward ? 1 : -1;
  if (spec.method === 'radius') {
    return setWallRadius(room, spec.wallIndex, direction * spec.value, spec.major === true);
  }
  if (spec.method === 'sagitta') {
    return setWallSagitta(room, spec.wallIndex, direction * spec.value);
  }
  if (spec.method === 'angle') {
    return setWallAngle(room, spec.wallIndex, direction * spec.value);
  }

  const edited = setWallArcLength(room, spec.wallIndex, spec.value);
  if (!edited.ok || !edited.room) return edited;
  const bulge = edited.room.walls[spec.wallIndex]?.bulge ?? 0;
  // setWallArcLength always yields a positive bulge; flip for inward bays.
  return curveWall(edited.room, spec.wallIndex, direction * Math.abs(bulge));
}

/** Build and validate the exact room that New Plan will write. */
export function buildNewRoom(spec: NewRoomSpec, name = 'Room'): NewRoomBuildResult {
  let built: NewRoomBuildResult;

  if (spec.shape === 'circle') {
    if (!validSize(spec.diameter)) return { ok: false, reason: 'Enter a positive room diameter.' };
    built = {
      ok: true,
      room: circularRoom(spec.diameter, name, { x: -spec.diameter / 2, y: -spec.diameter / 2 }),
    };
  } else {
    if (!validSize(spec.width) || !validSize(spec.depth)) {
      return { ok: false, reason: 'Enter a positive width and depth.' };
    }

    if (spec.shape === 'l-shape' || spec.shape === 'u-shape') {
      built = orthogonalRoom(
        spec.shape,
        spec.width,
        spec.depth,
        spec.notchWidth ?? 0,
        spec.notchDepth ?? 0,
        name,
      );
    } else if (spec.shape === 'stadium') {
      built = stadiumRoom(spec.width, spec.depth, name);
    } else {
      built = { ok: true, room: centredRectangle(spec.width, spec.depth, name) };
    }
  }

  if (!built.ok || !built.room) return built;
  let room = built.room;

  if (spec.shape === 'rounded') {
    const rounded = roundAllCorners(room, spec.cornerRadius ?? 0);
    if (!rounded.ok || !rounded.room) return { ok: false, reason: rounded.reason };
    room = rounded.room;
  }

  if (spec.curve) {
    const curved = curveRoom(room, spec.curve);
    if (!curved.ok || !curved.room) return { ok: false, reason: curved.reason };
    room = curved.room;
  }

  if (!(roomArea(room) > 0)) return { ok: false, reason: 'The room outline does not enclose any floor.' };
  return { ok: true, room };
}
