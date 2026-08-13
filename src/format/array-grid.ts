/**
 * Place copies of a node on a rectangular grid (Illustrator-style array).
 *
 * The original stays at (0,0) of the grid. Copies are spaced by gapX / gapY
 * from the original centre. Product of columns × rows is capped at 200.
 */

import type { RVDocument, RVNode } from './rv.js';
import { duplicateNode, indexDocument, measureNode, type DocumentIndex, type EditResult } from './edit.js';

export const ARRAY_GRID_MAX = 200;

export interface ArrayGridRequest {
  columns: number;
  rows: number;
  /** Centre-to-centre spacing along X. Defaults to item width when omitted / ≤0. */
  gapX?: number;
  /** Centre-to-centre spacing along Y. Defaults to item height when omitted / ≤0. */
  gapY?: number;
}

export function arrayGrid(
  doc: RVDocument,
  index: DocumentIndex,
  node: RVNode,
  request: ArrayGridRequest,
): EditResult & { created?: number[] } {
  const columns = Math.floor(Number(request.columns));
  const rows = Math.floor(Number(request.rows));
  if (!(columns >= 1 && rows >= 1)) {
    return { ok: false, reason: 'enter at least 1 column and 1 row' };
  }
  const total = columns * rows;
  if (total < 2) {
    return { ok: false, reason: 'array needs at least two cells (try 2×1 or 1×2)' };
  }
  if (total > ARRAY_GRID_MAX) {
    return {
      ok: false,
      reason: `array is capped at ${ARRAY_GRID_MAX} items — use the seating planner for full-room fills`,
    };
  }

  const size = measureNode(node);
  const gapX =
    request.gapX != null && request.gapX > 0
      ? request.gapX
      : size.width > 0
        ? size.width
        : 0;
  const gapY =
    request.gapY != null && request.gapY > 0
      ? request.gapY
      : size.height > 0
        ? size.height
        : 0;
  if (!(gapX > 0) || !(gapY > 0)) {
    return { ok: false, reason: 'that item has no size to space copies by — enter gap X and gap Y' };
  }

  const original = node;
  const created: number[] = [original.id];
  let workingIndex = index;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      if (col === 0 && row === 0) continue;
      const source = workingIndex.byId.get(original.id);
      if (!source) return { ok: false, reason: 'original object no longer exists' };
      const result = duplicateNode(doc, workingIndex, source, col * gapX, row * gapY);
      if (!result.ok) return result;
      if (result.created) created.push(...result.created);
      workingIndex = indexDocument(doc);
    }
  }

  return { ok: true, created };
}
