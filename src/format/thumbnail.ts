/**
 * Small plan-view previews of a drawn symbol.
 *
 * A row that says "Barco LC w/1.2 Lens" next to a generic glyph tells you
 * nothing about what will land on the drawing. Showing the actual outline —
 * the same geometry that gets placed — makes the list readable at a glance and
 * makes a wrong automatic match obvious before it reaches a sheet.
 *
 * The geometry comes from the plan the symbol was harvested out of, so the
 * preview is the real thing rather than an illustration of it.
 */

import { buildScene, type Scene, type ScenePrimitive } from './scene.js';

export interface Thumbnail {
  /** Polyline point lists, already scaled into `viewBox`. */
  paths: string[];
  /** Closed shapes, drawn with the same stroke but joined up. */
  closed: boolean[];
  width: number;
  height: number;
}

/** How large the preview's coordinate space is. Kept small for terse markup. */
const BOX = 100;

/**
 * Picks one instance of a named symbol out of a plan.
 *
 * A plan holds many copies of the same shape; they share an `owner` but each
 * has its own `selectId`. The most detailed instance is used, because some
 * copies are clipped by the room edge or drawn without their optional parts.
 */
function bestInstance(scene: Scene, name: string): ScenePrimitive[] {
  const want = name.trim().toLowerCase();
  const groups = new Map<number, ScenePrimitive[]>();

  for (const primitive of scene.primitives) {
    if ((primitive.owner ?? '').trim().toLowerCase() !== want) continue;
    // Labels and dimension text are not part of the object's shape.
    if (primitive.layer === 'annotation' || primitive.text) continue;
    const group = groups.get(primitive.selectId);
    if (group) group.push(primitive);
    else groups.set(primitive.selectId, [primitive]);
  }

  let best: ScenePrimitive[] = [];
  for (const group of groups.values()) {
    const points = group.reduce((n, p) => n + p.pts.length, 0);
    const bestPoints = best.reduce((n, p) => n + p.pts.length, 0);
    if (points > bestPoints) best = group;
  }
  return best;
}

/** Builds a preview of one named symbol, or null when it cannot be found. */
export function symbolThumbnail(scene: Scene, name: string): Thumbnail | null {
  const primitives = bestInstance(scene, name);
  if (primitives.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of primitives) {
    for (let i = 0; i < p.pts.length; i += 2) {
      const x = p.pts[i];
      const y = p.pts[i + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  const spanX = maxX - minX;
  const spanY = maxY - minY;
  if (!Number.isFinite(spanX) || !Number.isFinite(spanY) || (spanX <= 0 && spanY <= 0)) return null;

  // Fit the longer side to the box and centre the other, so a wide truss and a
  // square riser both read at the same visual weight.
  const span = Math.max(spanX, spanY);
  const scale = BOX / span;
  const offsetX = (BOX - spanX * scale) / 2;
  const offsetY = (BOX - spanY * scale) / 2;
  const round = (n: number) => Math.round(n * 10) / 10;

  const paths: string[] = [];
  const closed: boolean[] = [];
  for (const p of primitives) {
    const coords: string[] = [];
    for (let i = 0; i < p.pts.length; i += 2) {
      const x = round((p.pts[i] - minX) * scale + offsetX);
      const y = round((p.pts[i + 1] - minY) * scale + offsetY);
      coords.push(`${x},${y}`);
    }
    if (coords.length < 2) continue;
    paths.push(coords.join(' '));
    closed.push(p.type === 'polygon');
  }

  return paths.length > 0 ? { paths, closed, width: BOX, height: BOX } : null;
}

/** Convenience for callers that hold a document rather than a scene. */
export function thumbnailFromDocument(
  doc: Parameters<typeof buildScene>[0],
  name: string,
): Thumbnail | null {
  return symbolThumbnail(buildScene(doc), name);
}
