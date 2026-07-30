/**
 * Drawing a solved seating plan into the file.
 *
 * The solver decides where everything goes; this puts real objects there, so a
 * generated layout is selectable, movable and countable exactly like one laid
 * out by hand — which is the property `seating.ts` established and that must not
 * be given up in exchange for being parametric.
 *
 * Replacing a layout is by object id rather than by geometry: the previous
 * render's ids are kept by the caller (in the companion), so regenerating
 * removes precisely what it drew and leaves anything a person added alone.
 */

import { deleteNode, indexDocument, rotateNode, type DocumentIndex } from './edit.js';
import { placeGear } from './place.js';
import type { SeatingSolution } from './seating-plan.js';
import { walk, type RVDocument, type RVNode } from './rv.js';

export interface SeatingRenderResult {
  ok: boolean;
  reason?: string;
  /** Objects created, for the companion to remember. */
  created: number[];
  /** Objects removed from a previous render. */
  removed: number;
  chairs: number;
  tables: number;
}

function byId(doc: RVDocument, id: number): RVNode | null {
  for (const node of walk(doc)) if (node.id === id) return node;
  return null;
}

/**
 * Places every chair and table of a solution.
 *
 * `previous` is the id list from the last render. Those objects are removed
 * first, so calling this repeatedly leaves one layout rather than a pile.
 */
export function renderSeating(
  doc: RVDocument,
  index: DocumentIndex,
  solution: SeatingSolution,
  names: { chair: string; table?: string },
  previous: number[] = [],
): SeatingRenderResult {
  const result: SeatingRenderResult = { ok: true, created: [], removed: 0, chairs: 0, tables: 0 };

  for (const id of previous) {
    const node = byId(doc, id);
    if (!node) continue;
    if (deleteNode(doc, indexDocument(doc), node).ok) result.removed++;
  }

  /**
   * The index has to be rebuilt as we go.
   *
   * `placeGear` looks its template up in the index, and on a plan with nothing
   * to clone it *synthesizes* the first item — which the caller's index has
   * never seen. Every later placement then matches that new shape by name,
   * fails to find it in the stale index, concludes it is a document-level
   * object, and gives up with "object is not part of the document". Rebuilding
   * costs a walk per placement and is what makes seating work on a new plan.
   */
  let live = index;

  const put = (name: string, x: number, y: number, rotation: number, size?: { width: number; height: number }) => {
    const placed = placeGear(doc, live, name, x, y, size);
    if (!placed.ok || !placed.created?.length) return placed;
    result.created.push(...placed.created);
    if (rotation) {
      const node = byId(doc, placed.created[0]);
      if (node) rotateNode(doc, node, rotation);
    }
    live = indexDocument(doc);
    return placed;
  };

  if (names.table) {
    for (const table of solution.tables) {
      const placed = put(names.table, table.x, table.y, table.rotation, {
        width: table.width ?? 600,
        height: table.length ?? 600,
      });
      if (!placed.ok) return { ...result, ok: false, reason: placed.reason };
      result.tables++;
    }
  } else if (solution.tables.length) {
    return { ...result, ok: false, reason: 'this layout needs a table shape to place' };
  }

  for (const seat of solution.seats) {
    const placed = put(names.chair, seat.x, seat.y, seat.rotation);
    if (!placed.ok) return { ...result, ok: false, reason: placed.reason };
    result.chairs++;
  }

  return result;
}
