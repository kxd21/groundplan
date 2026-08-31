/**
 * Table stamp, chair redistribute, and auto-number helpers.
 *
 * Round banquet sets are ordinary placed shapes (one table + N chairs). These
 * ops keep that model: stamp creates individuals, redistribute replaces chairs
 * around a table, and auto-number adds RVLabel overlays (not renaming shapes).
 */

import type { RVDocument, RVNode } from './rv.js';
import { UNITS_PER_FOOT, walk } from './rv.js';
import {
  deleteNode,
  indexDocument,
  measureNode,
  moveNode,
  nodeCentre,
  rotateNode,
  type DocumentIndex,
  type EditResult,
} from './edit.js';
import { placeGear } from './place.js';
import { createLabel } from './annotate.js';
import { addSeating } from './seating.js';
import { classify } from '../inventory/classify.js';

/** Gap between table edge and chair centre (matches seating.ts). */
export const DEFAULT_CHAIR_STANDOFF = 1.1 * UNITS_PER_FOOT;

export type TableNumberOrder = 'left-right' | 'top-bottom' | 'right-left' | 'bottom-top';

export interface TableStampRequest {
  /** Centre of the whole grid. */
  x: number;
  y: number;
  columns: number;
  rows: number;
  /** Centre-to-centre spacing between tables. */
  spacingX: number;
  spacingY: number;
  table: string;
  chair: string;
  seats: number;
  chairSize?: { width: number; height: number };
  tableSize?: { width: number; height: number };
}

export interface TableStampResult extends EditResult {
  placed?: number;
  /** Table node ids in stamp order (row-major). */
  tableIds?: number[];
  /** Chair groups parallel to tableIds. */
  chairIdsByTable?: number[][];
}

export interface RedistributeResult extends EditResult {
  seats?: number;
  tableId?: number;
  chairIds?: number[];
}

export interface AutoNumberResult extends EditResult {
  numbered?: number;
  labelIds?: number[];
}

export interface SpaceTablesResult extends EditResult {
  moved?: number;
}

function findNode(doc: RVDocument, id: number): RVNode | null {
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

function nodeName(node: RVNode): string {
  if (node.fields.nameAt != null) {
    const fromLabel = node.labels.find(
      (l) => !/^(Arial|Times|Courier|Helvetica|Tahoma|Verdana|Symbol)/i.test(l),
    );
    if (fromLabel) return fromLabel;
  }
  return node.cls;
}

function isTableName(name: string): boolean {
  const cat = classify(name).category;
  return cat === 'table-round' || cat === 'table-rect' || cat === 'desk' || /\btable\b/i.test(name);
}

function isChairName(name: string): boolean {
  return classify(name).category === 'chair' || /\bchair\b|\bseat\b/i.test(name);
}

/** Stamp a grid of round tables with chairs. Each set stays individual objects. */
export function stampTableGrid(
  doc: RVDocument,
  index: DocumentIndex,
  request: TableStampRequest,
): TableStampResult {
  const columns = Math.max(1, Math.min(40, Math.round(request.columns)));
  const rows = Math.max(1, Math.min(40, Math.round(request.rows)));
  if (columns * rows > 200) return { ok: false, reason: 'stamp at most 200 tables at once' };
  const seats = Math.max(1, Math.min(24, Math.round(request.seats)));
  if (!(request.spacingX > 0) || !(request.spacingY > 0)) {
    return { ok: false, reason: 'enter table spacing' };
  }
  if (!request.table?.trim() || !request.chair?.trim()) {
    return { ok: false, reason: 'choose a table and chair' };
  }

  const created: number[] = [];
  const tableIds: number[] = [];
  const chairIdsByTable: number[][] = [];
  let placed = 0;
  let live = index;

  const originX = request.x - ((columns - 1) * request.spacingX) / 2;
  const originY = request.y - ((rows - 1) * request.spacingY) / 2;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const x = originX + c * request.spacingX;
      const y = originY + r * request.spacingY;
      const result = addSeating(doc, live, {
        kind: 'round',
        x,
        y,
        table: request.table,
        chair: request.chair,
        seats,
        chairSize: request.chairSize,
        tableSize: request.tableSize,
      });
      if (!result.ok) return { ...result, created, placed, tableIds, chairIdsByTable };
      const ids = result.created ?? [];
      created.push(...ids);
      placed += result.placed ?? ids.length;

      let tableId: number | undefined;
      const chairIds: number[] = [];
      for (const id of ids) {
        const node = findNode(doc, id);
        if (!node) continue;
        if (isTableNode(node) && tableId == null) tableId = id;
        else if (isChairNode(node)) chairIds.push(id);
      }
      if (tableId == null && ids[0] != null) tableId = ids[0];
      if (tableId != null) tableIds.push(tableId);
      // Prefer classified chairs; fall back to “everything after the table”.
      chairIdsByTable.push(
        chairIds.length
          ? chairIds
          : tableId != null
            ? ids.filter((id) => id !== tableId)
            : ids.slice(1),
      );
      live = indexDocument(doc);
    }
  }

  return { ok: true, created, placed, tableIds, chairIdsByTable };
}

/**
 * Replace chairs around a table with a new evenly spaced count.
 * `existingChairIds` should be the chairs currently grouped with the table.
 */
export function redistributeChairsAroundTable(
  doc: RVDocument,
  index: DocumentIndex,
  tableId: number,
  seats: number,
  chairName: string,
  existingChairIds: number[],
  options: {
    chairSize?: { width: number; height: number };
    standoff?: number;
  } = {},
): RedistributeResult {
  const count = Math.max(0, Math.min(24, Math.round(seats)));
  const table = findNode(doc, tableId);
  if (!table) return { ok: false, reason: 'table not found' };

  const centre = nodeCentre(table);
  const measured = measureNode(table);
  if (!centre || !(measured.width > 0) || !(measured.height > 0)) {
    return { ok: false, reason: 'could not measure that table' };
  }
  const standoff =
    options.standoff != null && options.standoff > 0 ? options.standoff : DEFAULT_CHAIR_STANDOFF;
  const radius = Math.max(measured.width, measured.height) / 2 + standoff;

  let live = index;
  for (const id of existingChairIds) {
    const node = live.byId.get(id) ?? findNode(doc, id);
    if (!node) continue;
    deleteNode(doc, live, node);
    live = indexDocument(doc);
  }

  const chairIds: number[] = [];
  const created: number[] = [];

  for (let i = 0; i < count; i++) {
    const bearing = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(1, count);
    const x = centre.x + radius * Math.cos(bearing);
    const y = centre.y + radius * Math.sin(bearing);
    const result = placeGear(doc, live, chairName, x, y, options.chairSize);
    if (!result.ok || !result.created?.length) {
      return {
        ok: false,
        reason: result.reason ?? 'could not place chairs',
        created,
        tableId,
        chairIds,
      };
    }
    const chairId = result.created[0]!;
    chairIds.push(chairId);
    created.push(chairId);
    const node = findNode(doc, chairId);
    if (node) rotateNode(doc, node, bearing + Math.PI / 2);
    if (result.method !== 'matched') live = indexDocument(doc);
  }

  return { ok: true, created, seats: count, tableId, chairIds };
}

/** Guess chairs near a table when object-links are missing (legacy plans). */
export function nearbyChairIds(doc: RVDocument, tableId: number, maxDistance?: number): number[] {
  const table = findNode(doc, tableId);
  if (!table) return [];
  const centre = nodeCentre(table);
  const measured = measureNode(table);
  if (!centre) return [];
  const reach =
    maxDistance ??
    Math.max(measured.width, measured.height) / 2 + 3 * UNITS_PER_FOOT;
  const out: number[] = [];
  for (const node of walk(doc)) {
    if (node.id === tableId) continue;
    if (node.cls !== 'RVShape') continue;
    const name = nodeName(node);
    if (!isChairName(name)) continue;
    const m = nodeCentre(node);
    if (!m) continue;
    if (Math.hypot(m.x - centre.x, m.y - centre.y) <= reach) out.push(node.id);
  }
  return out;
}

export function sortTableIdsForNumbering(
  doc: RVDocument,
  tableIds: number[],
  order: TableNumberOrder,
): number[] {
  const scored = tableIds
    .map((id) => {
      const node = findNode(doc, id);
      const c = node ? nodeCentre(node) : null;
      return { id, x: c?.x ?? 0, y: c?.y ?? 0 };
    })
    .filter((row) => findNode(doc, row.id));

  scored.sort((a, b) => {
    switch (order) {
      case 'right-left':
        return b.x - a.x || a.y - b.y;
      case 'top-bottom':
        return a.y - b.y || a.x - b.x;
      case 'bottom-top':
        return b.y - a.y || a.x - b.x;
      case 'left-right':
      default:
        return a.x - b.x || a.y - b.y;
    }
  });
  return scored.map((row) => row.id);
}

/** Place (or replace) number labels at table centres. */
export function autoNumberTables(
  doc: RVDocument,
  index: DocumentIndex,
  tableIds: number[],
  options: {
    start?: number;
    order?: TableNumberOrder;
    previousLabelIds?: number[];
    prefix?: string;
    suffix?: string;
    /** Pad numeric part to this width (e.g. 2 → 01, 02). */
    padWidth?: number;
  } = {},
): AutoNumberResult {
  const start = Math.max(1, Math.round(options.start ?? 1));
  const order = options.order ?? 'left-right';
  const prefix = options.prefix ?? '';
  const suffix = options.suffix ?? '';
  const padWidth = options.padWidth && options.padWidth > 0 ? Math.min(6, options.padWidth) : 0;
  const sorted = sortTableIdsForNumbering(doc, tableIds, order);
  if (!sorted.length) return { ok: false, reason: 'select one or more tables' };

  let live = index;
  for (const id of options.previousLabelIds ?? []) {
    const node = live.byId.get(id) ?? findNode(doc, id);
    if (node?.cls === 'RVLabel') {
      deleteNode(doc, live, node);
      live = indexDocument(doc);
    }
  }

  const labelIds: number[] = [];
  const created: number[] = [];

  sorted.forEach((tableId, i) => {
    const node = findNode(doc, tableId);
    const c = node ? nodeCentre(node) : null;
    if (!c) return;
    const num = start + i;
    const core = padWidth > 0 ? String(num).padStart(padWidth, '0') : String(num);
    const text = `${prefix}${core}${suffix}`;
    const result = createLabel(doc, live, text, c.x, c.y);
    if (result.ok && result.created?.length) {
      labelIds.push(...result.created);
      created.push(...result.created);
      live = indexDocument(doc);
    }
  });

  if (!labelIds.length) return { ok: false, reason: 'could not create table numbers' };
  return { ok: true, created, numbered: labelIds.length, labelIds };
}

/**
 * Reposition table centres onto a regular grid (row-major after sort).
 * Returns per-table deltas; callers should move linked chairs with the same delta.
 */
export function tableGridDeltas(
  doc: RVDocument,
  tableIds: number[],
  spacingX: number,
  spacingY: number,
  order: TableNumberOrder = 'left-right',
): { ok: true; moves: Array<{ id: number; dx: number; dy: number }> } | { ok: false; reason: string } {
  if (!(spacingX > 0) || !(spacingY > 0)) {
    return { ok: false, reason: 'enter table spacing' };
  }
  const sorted = sortTableIdsForNumbering(doc, tableIds, order);
  if (sorted.length < 2) return { ok: false, reason: 'select two or more tables' };

  const columns = Math.ceil(Math.sqrt(sorted.length));
  const rows = Math.ceil(sorted.length / columns);
  const centres = sorted.map((id) => {
    const node = findNode(doc, id);
    return nodeCentre(node!);
  });
  if (centres.some((c) => !c)) return { ok: false, reason: 'could not measure a selected table' };

  const meanX = centres.reduce((s, c) => s + c!.x, 0) / centres.length;
  const meanY = centres.reduce((s, c) => s + c!.y, 0) / centres.length;
  const originX = meanX - ((columns - 1) * spacingX) / 2;
  const originY = meanY - ((rows - 1) * spacingY) / 2;

  const moves: Array<{ id: number; dx: number; dy: number }> = [];
  sorted.forEach((id, i) => {
    const col = i % columns;
    const row = Math.floor(i / columns);
    const targetX = originX + col * spacingX;
    const targetY = originY + row * spacingY;
    const c = centres[i]!;
    const dx = targetX - c.x;
    const dy = targetY - c.y;
    if (dx !== 0 || dy !== 0) moves.push({ id, dx, dy });
  });

  return { ok: true, moves };
}

/** Apply deltas from tableGridDeltas to the named nodes only. */
export function applyTableMoves(
  doc: RVDocument,
  moves: Array<{ id: number; dx: number; dy: number }>,
): SpaceTablesResult {
  const created: number[] = [];
  let moved = 0;
  for (const move of moves) {
    const node = findNode(doc, move.id);
    if (!node) continue;
    const result = moveNode(doc, node, move.dx, move.dy);
    if (!result.ok) return { ...result, moved };
    moved++;
  }
  return { ok: true, created, moved };
}

export function filterTableIds(doc: RVDocument, ids: number[]): number[] {
  return ids.filter((id) => {
    const node = findNode(doc, id);
    if (!node || node.cls !== 'RVShape') return false;
    return isTableName(nodeName(node));
  });
}

export function isTableNode(node: RVNode): boolean {
  return node.cls === 'RVShape' && isTableName(nodeName(node));
}

export function isChairNode(node: RVNode): boolean {
  return node.cls === 'RVShape' && isChairName(nodeName(node));
}
