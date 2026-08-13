/**
 * Two-point background calibrate — click two plan points that match a known
 * real length on the site plan, then scale the underlay about that segment.
 */

import type { PlanBackground } from '../../format/companion.js';

export type PlanPoint = { x: number; y: number };

/** Scale and re-centre a background so the segment A→B becomes `knownLength`. */
export function scaleBackgroundToSegment(
  background: PlanBackground,
  a: PlanPoint,
  b: PlanPoint,
  knownLength: number,
): PlanBackground | { error: string } {
  if (!(knownLength > 0)) return { error: 'Enter a known real length greater than zero.' };
  const measured = Math.hypot(b.x - a.x, b.y - a.y);
  if (!(measured > 1e-6)) return { error: 'Click two distinct points on the drawing.' };
  const factor = knownLength / measured;
  if (!(factor > 0.01 && factor < 100)) {
    return { error: 'That scale is out of range — check the known length.' };
  }
  // Scale about the midpoint of the measured segment so the clicked wall stays put.
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const scaleAbout = (v: number, origin: number) => origin + (v - origin) * factor;
  return {
    ...background,
    x: scaleAbout(background.x, mx),
    y: scaleAbout(background.y, my),
    width: background.width * factor,
    height: background.height * factor,
  };
}
