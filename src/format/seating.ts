/**
 * Seating layouts.
 *
 * The corpus makes the case on its own: 305,784 chairs across 1,486 plans, an
 * average of 206 a drawing. Nobody places those by hand, and Room Viewer did
 * not make them by hand either — it wrote `RVTableAndChairBanquet` and
 * `RVTableAndChairSchoolroom` groups. This builds the same arrangements from
 * the plan's own table and chair shapes.
 *
 * Every chair is a real placed shape, so the result is indistinguishable from
 * one laid out in the original application: selectable, movable, countable in
 * the inventory.
 */

import type { RVDocument } from './rv.js';
import { UNITS_PER_FOOT } from './rv.js';
import { rotateNode, type DocumentIndex, type EditResult } from './edit.js';
import { placeGear, type PlaceResult } from './place.js';

export type SeatingKind = 'round' | 'theatre' | 'schoolroom';

export interface SeatingRequest {
  kind: SeatingKind;
  /** Centre of a round, or the front-left corner of rows. */
  x: number;
  y: number;
  /** Catalogue name of the chair to use. */
  chair: string;
  /** Catalogue name of the table, for rounds and schoolroom. */
  table?: string;
  /** Seats around a round table. */
  seats?: number;
  /** Rows and seats per row, for theatre and schoolroom. */
  rows?: number;
  perRow?: number;
  /** Overrides for spacing, in logical units. */
  seatSpacing?: number;
  rowSpacing?: number;
  /**
   * Rotation of the whole block, in degrees.
   *
   * Angled banks are how real houses are laid out: the Riverbend Hall arena
   * plan has 227 chairs at +30 degrees and 227 at -30, flanking a straight
   * centre block.
   */
  angle?: number;
}

export interface SeatingResult extends EditResult {
  placed?: number;
}

/** Comfortable defaults, in logical units (tenths of an inch). */
const DEFAULT_SEAT_SPACING = 2 * UNITS_PER_FOOT;
const DEFAULT_ROW_SPACING = 3 * UNITS_PER_FOOT;
/** Gap between the table edge and the chair's centre. */
const CHAIR_STANDOFF = 1.1 * UNITS_PER_FOOT;

function sizeOf(result: PlaceResult, fallback: number): { width: number; height: number } {
  if (result.size) return { width: result.size.width, height: result.size.height };
  return { width: fallback, height: fallback };
}

/**
 * Builds a seating arrangement.
 *
 * Chairs are placed then turned to face where the audience looks: inward at a
 * round, forward in rows. A chair's stored outline faces up the page, so the
 * rotation needed is the bearing to the focus plus a quarter turn.
 */
export function addSeating(doc: RVDocument, index: DocumentIndex, request: SeatingRequest): SeatingResult {
  const created: number[] = [];
  let placed = 0;

  const put = (name: string, x: number, y: number, rotate: number, known?: { width: number; height: number }) => {
    const result = placeGear(doc, index, name, x, y, known);
    if (!result.ok || !result.created?.length) return result;

    created.push(...result.created);
    placed++;

    if (rotate) {
      // The freshly placed copy is the last object created.
      const node = findNode(doc, result.created[0]);
      if (node) rotateNode(doc, node, rotate);
    }
    return result;
  };

  if (request.kind === 'round') {
    const seats = Math.max(1, Math.min(24, request.seats ?? 10));
    if (!request.table) return { ok: false, reason: 'choose a table for a round' };

    const table = put(request.table, request.x, request.y, 0);
    if (!table.ok) return table;

    const size = sizeOf(table as PlaceResult, 5 * UNITS_PER_FOOT);
    const radius = Math.max(size.width, size.height) / 2 + CHAIR_STANDOFF;

    for (let i = 0; i < seats; i++) {
      // Start at the top of the table and work clockwise.
      const bearing = -Math.PI / 2 + (i * 2 * Math.PI) / seats;
      const x = request.x + radius * Math.cos(bearing);
      const y = request.y + radius * Math.sin(bearing);
      // A chair drawn facing up must turn to face the centre.
      const result = put(request.chair, x, y, bearing + Math.PI / 2);
      if (!result.ok) return { ...result, created, placed };
    }

    return { ok: true, created, placed };
  }

  const blockAngle = ((request.angle ?? 0) * Math.PI) / 180;
  const ca = Math.cos(blockAngle);
  const sa = Math.sin(blockAngle);
  /** Rotates a seat position about the block's origin. */
  const placeAt = (dx: number, dy: number): [number, number] => [
    request.x + dx * ca - dy * sa,
    request.y + dx * sa + dy * ca,
  ];

  const rows = Math.max(1, Math.min(60, request.rows ?? 5));
  const perRow = Math.max(1, Math.min(80, request.perRow ?? 10));
  const seatGap = request.seatSpacing ?? DEFAULT_SEAT_SPACING;
  const rowGap = request.rowSpacing ?? (request.kind === 'schoolroom' ? 5 * UNITS_PER_FOOT : DEFAULT_ROW_SPACING);

  // Centre the block on the point the user clicked, then turn the whole thing.
  const width = (perRow - 1) * seatGap;
  const height = (rows - 1) * rowGap;

  for (let r = 0; r < rows; r++) {
    const dy = r * rowGap - height / 2;

    if (request.kind === 'schoolroom' && request.table) {
      // One long table per row, with the chairs behind it.
      const [tx, ty] = placeAt(0, dy - 0.9 * UNITS_PER_FOOT);
      const result = put(request.table, tx, ty, blockAngle);
      if (!result.ok) return { ...result, created, placed };
    }

    for (let c = 0; c < perRow; c++) {
      const [x, y] = placeAt(c * seatGap - width / 2, dy);
      const result = put(request.chair, x, y, blockAngle);
      if (!result.ok) return { ...result, created, placed };
    }
  }

  return { ok: true, created, placed };
}

function findNode(doc: RVDocument, id: number) {
  const seen = new Set<unknown>();
  const stack = [...doc.roots];
  while (stack.length) {
    const n = stack.pop()!;
    if (seen.has(n)) continue;
    seen.add(n);
    if (n.id === id) return n;
    for (const c of n.children) stack.push(c);
  }
  return null;
}
