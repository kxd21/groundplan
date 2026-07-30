/**
 * Drawing a dimension into the plan.
 *
 * A dimension in this format is two objects: an `RVDimensionLine` for the
 * geometry and a separate `RVLabel` carrying the measurement. Both are now
 * built from scratch where the plan has nothing to copy, which is what makes it
 * possible to dimension a drawing that has never been dimensioned.
 *
 * The whole dimension goes in or none of it does. A line with no value beside
 * it is worse than no dimension at all, because it reads as a wall.
 */

import { addRoot, appendChild, type EditResult } from './edit.js';
import type { DimensionDrawing } from './dimension.js';
import { walk, type Point, type RVDocument, type RVNode } from './rv.js';
import { createLabel, createSegment } from './synthesize.js';

function host(doc: RVDocument): RVNode | null {
  for (const node of walk(doc)) {
    if (node.fields.childCountAt == null) continue;
    if (node.cls === 'RVRoomDef' || node.cls === 'RVRoom') return node;
  }
  return null;
}

/** Splits a polyline into the class that can carry it. */
function classOf(points: Point[]): 'RVDimensionLine' | 'RVSegmentPoly' {
  return points.length === 2 ? 'RVDimensionLine' : 'RVSegmentPoly';
}

export interface DimensionRenderResult extends EditResult {
  /** Objects created, in the order they were added. */
  created: number[];
}

/**
 * Draws one dimension.
 *
 * Builds every object first and only attaches them once all of them exist, so a
 * failure part-way through leaves the document untouched rather than holding
 * half a dimension.
 */
export function renderDimension(doc: RVDocument, drawing: DimensionDrawing): DimensionRenderResult {
  const built: RVNode[] = [];

  for (const line of drawing.lines) {
    if (line.length < 2) continue;
    const segment = createSegment(doc, { cls: classOf(line), points: line });
    if (!segment.ok || !segment.node) {
      return { ok: false, reason: segment.reason ?? 'the dimension geometry could not be built', created: [] };
    }
    built.push(segment.node);
  }

  if (!built.length) return { ok: false, reason: 'that dimension has no geometry', created: [] };

  const label = createLabel(doc, { text: drawing.text, x: drawing.at.x, y: drawing.at.y });
  if (!label.ok || !label.node) {
    return { ok: false, reason: label.reason ?? 'the dimension value could not be built', created: [] };
  }
  built.push(label.node);

  const container = host(doc);
  const created: number[] = [];
  for (const node of built) {
    const added = container ? appendChild(doc, container, node) : addRoot(doc, node);
    if (!added.ok) {
      // Everything built so far is still only in memory except what has already
      // been attached; report rather than leave a partial dimension.
      return { ok: false, reason: added.reason, created };
    }
    created.push(node.id);
  }

  return { ok: true, created };
}

/** Draws a set of dimensions, stopping at the first one that cannot be drawn. */
export function renderDimensions(doc: RVDocument, drawings: DimensionDrawing[]): DimensionRenderResult {
  const created: number[] = [];
  for (const drawing of drawings) {
    const result = renderDimension(doc, drawing);
    created.push(...result.created);
    if (!result.ok) return { ok: false, reason: result.reason, created };
  }
  return { ok: true, created };
}
