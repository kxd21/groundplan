/**
 * Structural edits for the Direct Selection tool.
 *
 * Moving a point can patch an existing point array in place, but changing a
 * line into a cubic changes both the Room Viewer class and the point count.
 * Rebuilding the segment is safer than resizing an unknown binary header. The
 * existing object is updated in place so its parent slot, selection id, and
 * undo transaction all remain stable.
 */

import type { RVDocument, RVNode } from './rv.js';
import type { EditResult } from './edit.js';
import { arcSegmentPoints, createSegment } from './synthesize.js';

export type EditableSegmentKind = 'line' | 'curve';

const lineLike = (node: RVNode): boolean =>
  (node.cls === 'RVSegmentLine' || node.cls === 'RVSegmentPoly') && node.points.length === 2;

/** True when Direct Selection can switch this complete run between line and curve. */
export function canConvertSegmentKind(node: RVNode): boolean {
  return lineLike(node) || (node.cls === 'RVSegmentArc' && node.points.length >= 8);
}

/**
 * Converts a two-anchor run to a cubic Bézier, or collapses a cubic to the
 * straight chord between its anchors.
 *
 * A newly converted curve starts visually straight. Its two control handles
 * are placed at one-third and two-thirds of the chord, ready to drag without
 * unexpectedly changing the drawing merely because Curve was selected.
 */
export function convertSegmentKind(
  doc: RVDocument,
  node: RVNode,
  kind: EditableSegmentKind,
): EditResult {
  if (!canConvertSegmentKind(node)) {
    return {
      ok: false,
      reason: 'Curve and straight options are available for a two-point line or a cubic curve.',
    };
  }

  const currentlyCurve = node.cls === 'RVSegmentArc';
  if ((kind === 'curve') === currentlyCurve) return { ok: true };

  const visible = currentlyCurve ? node.points.slice(-4) : node.points;
  const start = visible[0]!;
  const end = visible[visible.length - 1]!;
  const drawn = kind === 'curve'
    ? [
        { ...start },
        { x: start.x + (end.x - start.x) / 3, y: start.y + (end.y - start.y) / 3 },
        { x: start.x + ((end.x - start.x) * 2) / 3, y: start.y + ((end.y - start.y) * 2) / 3 },
        { ...end },
      ]
    : [{ ...start }, { ...end }];
  const points = kind === 'curve' ? arcSegmentPoints(drawn) : drawn;
  const nextId = doc.nextId;
  const built = createSegment(doc, {
    cls: kind === 'curve' ? 'RVSegmentArc' : 'RVSegmentLine',
    points,
    color: node.color,
  });
  // The synthesized node is only a byte-layout donor; this edit retains the
  // existing node id and therefore must not consume a document id.
  doc.nextId = nextId;
  if (!built.ok || !built.node) return { ok: false, reason: built.reason };

  const stableId = node.id;
  Object.assign(node, built.node, { id: stableId });
  return { ok: true };
}

