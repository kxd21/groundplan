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
  names: {
    chair: string;
    table?: string;
    chairWidth?: number;
    chairDepth?: number;
  },
  previous: number[] = [],
): SeatingRenderResult {
  const result: SeatingRenderResult = { ok: true, created: [], removed: 0, chairs: 0, tables: 0 };

  // Walk-based lookup (not a snapshot map): after a parent shape is deleted its
  // child ids vanish from the tree, and must not be counted as extra removals.
  // Sibling chairs share a parent, so one index covers the whole delete loop.
  let live = index;
  for (const id of previous) {
    const node = byId(doc, id);
    if (!node) continue;
    if (deleteNode(doc, live, node).ok) result.removed++;
  }
  if (result.removed > 0) live = indexDocument(doc);

  /**
   * Rebuild the index only when placement synthesizes a new shape.
   *
   * Matched clones copy a template already in the index; the next match walks
   * the live document for the same template, so a full rebuild is wasted work.
   * A synthesized (or template-renamed) first item must enter the index before
   * later placements can clone it by name — that is the only required rebuild.
   */
  const put = (name: string, x: number, y: number, rotation: number, size?: { width: number; height: number }) => {
    const placed = placeGear(doc, live, name, x, y, size);
    if (!placed.ok || !placed.created?.length) return placed;
    result.created.push(...placed.created);
    if (rotation) {
      for (const node of walk(doc)) {
        if (node.id === placed.created[0]) {
          rotateNode(doc, node, rotation);
          break;
        }
      }
    }
    if (placed.method !== 'matched') live = indexDocument(doc);
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
    const placed = put(
      names.chair,
      seat.x,
      seat.y,
      seat.rotation,
      names.chairWidth && names.chairDepth
        ? { width: names.chairWidth, height: names.chairDepth }
        : undefined,
    );
    if (!placed.ok) return { ...result, ok: false, reason: placed.reason };
    result.chairs++;
  }

  return result;
}
