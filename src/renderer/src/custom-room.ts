/**
 * Preferences chosen in New Plan for the custom (click-to-draw) room path.
 * Applied while the outline tool is armed after Create & draw.
 */

export type CustomRoomAngleLock = 'free' | 'ortho' | '45';

export interface CustomRoomPrefs {
  /** Working footprint in logical units — sizes the empty sheet and optional guide. */
  guideWidth: number;
  guideDepth: number;
  /** Constrain each new corner relative to the previous one. */
  angleLock: CustomRoomAngleLock;
  /** Draw a dashed W×D rectangle on the plan while tracing. */
  showGuide: boolean;
  /** Dimension every wall after the outline is finished. */
  autoDimensions: boolean;
}

/** Snap a point relative to `from` using the active angle lock. */
export function constrainRoomCorner(
  from: { x: number; y: number },
  to: { x: number; y: number },
  lock: CustomRoomAngleLock,
  forceOrtho = false,
): { x: number; y: number } {
  const mode = forceOrtho ? 'ortho' : lock;
  if (mode === 'free') return { x: to.x, y: to.y };
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (!(len > 0)) return { x: from.x, y: from.y };
  if (mode === 'ortho') {
    return Math.abs(dx) >= Math.abs(dy)
      ? { x: from.x + dx, y: from.y }
      : { x: from.x, y: from.y + dy };
  }
  const angle = Math.atan2(dy, dx);
  const step = Math.PI / 4;
  const snapped = Math.round(angle / step) * step;
  return {
    x: from.x + Math.cos(snapped) * len,
    y: from.y + Math.sin(snapped) * len,
  };
}
