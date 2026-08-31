/**
 * On-canvas transform handles for a selected object.
 *
 * The canvas used to draw a bare bounds rectangle and send anyone who wanted to
 * change a size or an angle to the Properties panel to type a number. That is
 * the right answer for a precise value and the wrong one for the ordinary case:
 * grab a corner and pull. This module owns the handle geometry and the drag
 * maths so PlanCanvas only has to hit-test, preview, and commit.
 *
 * The frame is the object's OWN rectangle — centre, width, height, angle — and
 * not the world-aligned bounding box, so a rotated riser gets handles on its
 * real corners and a corner drag grows it along its own axes.
 *
 * Resize is anchored on the CENTRE, because `resizeNode` in the format layer
 * scales about the object's own centre (`src/format/edit.ts`). Previewing an
 * opposite-corner anchor would show the user a result the engine will not
 * produce, and the drag would jump on commit.
 */

import type { View } from './PlanCanvas.js';

export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rotate';

/** The object's own rectangle, in plan units. Angle follows the plan's Y-up geometry. */
export interface TransformFrame {
  cx: number;
  cy: number;
  width: number;
  height: number;
  angle: number;
}

/** Screen-space gap between the top edge and the rotate grip. */
const ROTATE_GAP = 28;
/** Half-width of a handle square, in screen pixels. */
export const HANDLE_HALF = 4.5;
/** Click tolerance around a handle, in screen pixels. Bigger than it looks. */
const HANDLE_GRAB = 9;
/** Nothing may be resized below this, in plan units (0.2"). */
const MIN_SIZE = 2;

/** Which local axes a handle drives, and by which sign. */
const AXES: Record<Exclude<HandleId, 'rotate'>, { sx: -1 | 0 | 1; sy: -1 | 0 | 1 }> = {
  nw: { sx: -1, sy: -1 },
  n: { sx: 0, sy: -1 },
  ne: { sx: 1, sy: -1 },
  e: { sx: 1, sy: 0 },
  se: { sx: 1, sy: 1 },
  s: { sx: 0, sy: 1 },
  sw: { sx: -1, sy: 1 },
  w: { sx: -1, sy: 0 },
};

export const RESIZE_HANDLES = Object.keys(AXES) as Array<Exclude<HandleId, 'rotate'>>;

/**
 * Rotates a screen-oriented local offset into the plan, then projects it.
 *
 * Local `ly` grows down because handle ids are visual (north/south), while the
 * plan's Y axis grows up. The canvas deliberately flips that axis with
 * `screenY`; transform handles must use the same projection or every frame is
 * mirrored across plan Y=0. An item at -6ft was consequently getting handles
 * at +6ft even though its selected outline was drawn in the right place.
 */
function toScreen(
  frame: TransformFrame,
  view: View,
  lx: number,
  ly: number,
): { x: number; y: number } {
  const a = (frame.angle * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return {
    x: (frame.cx + lx * cos + ly * sin) * view.scale + view.offsetX,
    y: -(frame.cy + lx * sin - ly * cos) * view.scale + view.offsetY,
  };
}

/** The four corners of the frame in screen space, clockwise from north-west. */
export function frameCorners(frame: TransformFrame, view: View): Array<{ x: number; y: number }> {
  const hw = frame.width / 2;
  const hh = frame.height / 2;
  return [
    toScreen(frame, view, -hw, -hh),
    toScreen(frame, view, hw, -hh),
    toScreen(frame, view, hw, hh),
    toScreen(frame, view, -hw, hh),
  ];
}

/**
 * Every handle in screen space.
 *
 * `canRotate` is false for objects whose file stores no absolute angle and
 * which the edit layer refuses to turn; they still resize.
 */
export function handlePoints(
  frame: TransformFrame,
  view: View,
  canRotate: boolean,
): Array<{ id: HandleId; x: number; y: number }> {
  const hw = frame.width / 2;
  const hh = frame.height / 2;
  const points: Array<{ id: HandleId; x: number; y: number }> = [];
  for (const id of RESIZE_HANDLES) {
    const { sx, sy } = AXES[id];
    points.push({ id, ...toScreen(frame, view, sx * hw, sy * hh) });
  }
  if (canRotate) {
    points.push({ id: 'rotate', ...toScreen(frame, view, 0, -hh - ROTATE_GAP / view.scale) });
  }
  return points;
}

/** Below this many screen pixels an edge handle collides with its corners. */
const EDGE_CLEARANCE = 34;

/**
 * Whether an edge handle has room, per axis.
 *
 * The gate is on the span the handle sits along, not on both: a north handle
 * sits between the two top corners and needs WIDTH, while an east handle sits
 * between the two right corners and needs HEIGHT. Gating both on both would
 * strip the end handles off a long thin truss that has plenty of room for them.
 */
export function edgeHandleFits(frame: TransformFrame, view: View, id: HandleId): boolean {
  if (id === 'n' || id === 's') return frame.width * view.scale > EDGE_CLEARANCE;
  if (id === 'e' || id === 'w') return frame.height * view.scale > EDGE_CLEARANCE;
  return true;
}

/**
 * The handle under a screen point, or null.
 *
 * Edge handles are suppressed when the frame is too small to hold them, so a
 * tiny symbol does not turn into a pile of overlapping targets at low zoom.
 */
export function hitHandle(
  frame: TransformFrame,
  view: View,
  screenX: number,
  screenY: number,
  canRotate: boolean,
): HandleId | null {
  let best: { id: HandleId; gap: number } | null = null;
  for (const point of handlePoints(frame, view, canRotate)) {
    if (!edgeHandleFits(frame, view, point.id)) continue;
    const gap = Math.hypot(screenX - point.x, screenY - point.y);
    // The rotate grip sits off the frame, so it never competes with a corner.
    if (gap <= HANDLE_GRAB && (!best || gap < best.gap)) best = { id: point.id, gap };
  }
  return best?.id ?? null;
}

export interface ResizeOptions {
  /** Lock the aspect ratio (Shift). */
  lockAspect: boolean;
  /** Snap the resulting size to this many units. Zero or Alt leaves it free. */
  snapStep: number;
}

/**
 * The size a drag asks for.
 *
 * `dx`/`dy` are the pointer's total movement in PLAN units. They are projected
 * onto the object's own axes so a rotated object grows the way it looks like it
 * should. Both sides move because the resize is centre-anchored, so the grabbed
 * corner tracks the pointer at twice the local delta.
 */
export function resizeFrom(
  frame: TransformFrame,
  handle: Exclude<HandleId, 'rotate'>,
  dx: number,
  dy: number,
  options: ResizeOptions,
): { width: number; height: number } {
  const a = (frame.angle * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const localX = dx * cos + dy * sin;
  // Pointer deltas arrive in Y-up plan coordinates. AXES uses visual screen
  // directions, where south is positive, so project onto the object's local
  // DOWN axis rather than its local plan-Y axis.
  const localDown = dx * sin - dy * cos;
  const { sx, sy } = AXES[handle];

  let width = frame.width + 2 * sx * localX;
  let height = frame.height + 2 * sy * localDown;

  if (options.lockAspect && frame.width > 0 && frame.height > 0) {
    // Whichever axis the drag pushed hardest, in proportion, drives both.
    const ratioX = sx === 0 ? 1 : width / frame.width;
    const ratioY = sy === 0 ? 1 : height / frame.height;
    const factor =
      sx === 0 ? ratioY : sy === 0 ? ratioX : Math.abs(ratioX - 1) >= Math.abs(ratioY - 1) ? ratioX : ratioY;
    width = frame.width * factor;
    height = frame.height * factor;
  }

  if (options.snapStep > 0) {
    // Only round an axis the handle actually drives, or an edge drag would
    // quietly re-round the other side and drift it off a value the user set.
    if (sx !== 0 || options.lockAspect) width = Math.round(width / options.snapStep) * options.snapStep;
    if (sy !== 0 || options.lockAspect) height = Math.round(height / options.snapStep) * options.snapStep;
  }

  return { width: Math.max(MIN_SIZE, width), height: Math.max(MIN_SIZE, height) };
}

/** Absolute pointer angle about the frame centre in the plan's Y-up coordinates. */
export function angleAt(frame: TransformFrame, planX: number, planY: number): number {
  return (Math.atan2(planY - frame.cy, planX - frame.cx) * 180) / Math.PI;
}

/**
 * The rotation a drag asks for, as a delta from the frame's current angle.
 *
 * Shift snaps the RESULT to 15°, not the delta — snapping the delta would let a
 * frame that started at 7° stay 7° off true for the rest of its life.
 */
export function rotateFrom(
  frame: TransformFrame,
  grabAngle: number,
  pointerAngle: number,
  shift: boolean,
): number {
  let delta = pointerAngle - grabAngle;
  if (shift) {
    const target = Math.round((frame.angle + delta) / 15) * 15;
    delta = target - frame.angle;
  }
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;
  return delta;
}

/** Indexed by 45° sector, starting due east and turning clockwise. */
const RESIZE_CURSORS = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'];

/**
 * The CSS cursor for a handle, rotated with the object.
 *
 * A north handle on a frame turned 90° points east, and the cursor has to say
 * so or the arrow contradicts the drag.
 */
export function cursorFor(handle: HandleId, angle: number): string {
  if (handle === 'rotate') return 'grab';
  const { sx, sy } = AXES[handle];
  // Positive plan rotation is visually counter-clockwise after the Y flip, so
  // subtract it from the screen-oriented handle direction.
  const direction = (Math.atan2(sy, sx) * 180) / Math.PI - angle;
  // 8 compass sectors collapse onto 4 double-headed cursors.
  const sector = ((Math.round(direction / 45) % 8) + 8) % 8;
  return RESIZE_CURSORS[sector % 4]!;
}
