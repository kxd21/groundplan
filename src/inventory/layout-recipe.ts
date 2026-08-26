/**
 * Layout recipes — durable, exact-name plans for recreating a show layout.
 *
 * A recipe pins catalogue names (never fuzzy search), seating rowLengths,
 * measured gear spots, labels, dimensions, and expected counts. Applying one
 * fails closed if seat totals or required gear names cannot be resolved
 * exactly — the failure mode that Card Party needed.
 *
 * This is the architecture that cures print-recreation drift:
 *   measure once → recipe JSON → apply through the same edit path as the UI.
 *
 *   format: groundplan-layout-recipe / version 1
 */

import { resolveInventoryQuery, resolveFailureMessage } from './resolve.js';
import {
  addSeating,
  expectedSeatCount,
  type SeatingRequest,
  type SeatingResult,
} from '../format/seating.js';
import type { RVDocument } from '../format/rv.js';
import { UNITS_PER_FOOT, UNITS_PER_INCH } from '../format/rv.js';
import { indexDocument, type DocumentIndex } from '../format/edit.js';
import { placeGear, placeFromLibrary } from '../format/place.js';
import { importSymbol } from '../format/symbol.js';
import { readLibrary } from '../format/library.js';
import { readFileSync } from 'node:fs';
import { loadBuffer } from '../format/index.js';
import { createLabel, createDimension } from '../format/annotate.js';
import type { IncomingItem, Inventory } from './model.js';

export const LAYOUT_RECIPE_FORMAT = 'groundplan-layout-recipe' as const;
export const LAYOUT_RECIPE_VERSION = 1 as const;

export interface LayoutRecipeSeatingBlock {
  /** Block centre in feet. */
  xFt: number;
  yFt: number;
  angleDeg?: number;
  /**
   * Stamp kind. Defaults to theatre (row banks).
   * Use `round` for banquet tables; `schoolroom` for classroom rows with tables.
   */
  kind?: 'theatre' | 'schoolroom' | 'round';
  /** Exact catalogue chair name. */
  chair: string;
  /** Exact catalogue table name — required for round and schoolroom. */
  table?: string;
  /** Seats around a round table (kind: round). */
  seats?: number;
  seatSpacingFt?: number;
  rowSpacingFt?: number;
  /** Prefer irregular lengths; falls back to rows×perRow. */
  rowLengths?: number[];
  rows?: number;
  perRow?: number;
  /** Required seat total for this block — apply fails if placement differs. */
  expectCount: number;
}

export interface LayoutRecipeGear {
  /** Exact catalogue name — resolved with requireExact. */
  name: string;
  xFt: number;
  yFt: number;
}

export interface LayoutRecipeStage {
  xFt: number;
  yFt: number;
  widthFt: number;
  depthFt: number;
  heightIn?: number;
  back?: { depthFt: number; heightIn: number };
  stairs?: Array<'left' | 'right' | 'front' | 'back'>;
}

export interface LayoutRecipeLabel {
  text: string;
  xFt: number;
  yFt: number;
}

export interface LayoutRecipeDimension {
  x1Ft: number;
  y1Ft: number;
  x2Ft: number;
  y2Ft: number;
}

export interface LayoutRecipe {
  format: typeof LAYOUT_RECIPE_FORMAT;
  version: typeof LAYOUT_RECIPE_VERSION;
  identity?: {
    event?: string;
    venue?: string;
    roomLabel?: string;
    date?: string;
    /** Guest/capacity label for variant kits (e.g. 1200). */
    capacityGuests?: number;
    /** Kit id this recipe is a capacity/variant of (e.g. bundled:card-party). */
    variantOf?: string;
  };
  room?: { widthFt: number; depthFt: number };
  stage?: LayoutRecipeStage[];
  seating: LayoutRecipeSeatingBlock[];
  gear?: LayoutRecipeGear[];
  labels?: LayoutRecipeLabel[];
  dimensions?: LayoutRecipeDimension[];
  expectations: {
    chairs: number;
    /** Exact gear names that must resolve (optional presence check). */
    requireGearNames?: string[];
  };
}

export interface LayoutRecipeApplyResult {
  ok: boolean;
  reason?: string;
  chairsPlaced: number;
  gearPlaced: number;
  labelsPlaced: number;
  dimensionsPlaced: number;
  seating: SeatingResult[];
}

export function isLayoutRecipe(value: unknown): value is LayoutRecipe {
  if (!value || typeof value !== 'object') return false;
  const v = value as LayoutRecipe;
  return (
    v.format === LAYOUT_RECIPE_FORMAT &&
    v.version === LAYOUT_RECIPE_VERSION &&
    Array.isArray(v.seating) &&
    !!v.expectations &&
    typeof v.expectations.chairs === 'number'
  );
}

/**
 * Scale a recipe from its authored room into a different room size.
 * Rooms are origin-centred; positions and sizes stretch with width/depth.
 * Seat counts stay the same — only spacing and placement change.
 */
export function scaleLayoutRecipeToRoom(
  recipe: LayoutRecipe,
  targetWidthFt: number,
  targetDepthFt: number,
): LayoutRecipe {
  const sourceW = recipe.room?.widthFt ?? 0;
  const sourceD = recipe.room?.depthFt ?? 0;
  if (!(sourceW > 0 && sourceD > 0 && targetWidthFt > 0 && targetDepthFt > 0)) {
    return recipe;
  }
  const sx = targetWidthFt / sourceW;
  const sy = targetDepthFt / sourceD;
  if (Math.abs(sx - 1) < 0.005 && Math.abs(sy - 1) < 0.005) {
    return recipe;
  }
  const sAvg = (sx + sy) / 2;

  return {
    ...recipe,
    room: { widthFt: targetWidthFt, depthFt: targetDepthFt },
    stage: recipe.stage?.map((stage) => ({
      ...stage,
      xFt: stage.xFt * sx,
      yFt: stage.yFt * sy,
      widthFt: stage.widthFt * sx,
      depthFt: stage.depthFt * sy,
      back: stage.back
        ? { ...stage.back, depthFt: stage.back.depthFt * sy }
        : undefined,
    })),
    seating: recipe.seating.map((block) => ({
      ...block,
      xFt: block.xFt * sx,
      yFt: block.yFt * sy,
      seatSpacingFt:
        block.seatSpacingFt != null ? block.seatSpacingFt * sAvg : undefined,
      rowSpacingFt:
        block.rowSpacingFt != null ? block.rowSpacingFt * sy : undefined,
    })),
    gear: recipe.gear?.map((spot) => ({
      ...spot,
      xFt: spot.xFt * sx,
      yFt: spot.yFt * sy,
    })),
    labels: recipe.labels?.map((label) => ({
      ...label,
      xFt: label.xFt * sx,
      yFt: label.yFt * sy,
    })),
    dimensions: recipe.dimensions?.map((dim) => ({
      x1Ft: dim.x1Ft * sx,
      y1Ft: dim.y1Ft * sy,
      x2Ft: dim.x2Ft * sx,
      y2Ft: dim.y2Ft * sy,
    })),
  };
}

/** True when the recipe room already matches the target within a small tolerance. */
export function layoutRecipeFitsRoom(
  recipe: LayoutRecipe,
  targetWidthFt: number,
  targetDepthFt: number,
  tolerance = 0.02,
): boolean {
  const sourceW = recipe.room?.widthFt ?? 0;
  const sourceD = recipe.room?.depthFt ?? 0;
  if (!(sourceW > 0 && sourceD > 0 && targetWidthFt > 0 && targetDepthFt > 0)) {
    return false;
  }
  return (
    Math.abs(sourceW - targetWidthFt) / sourceW <= tolerance &&
    Math.abs(sourceD - targetDepthFt) / sourceD <= tolerance
  );
}

/** Validates names and seat maths without mutating a plan. */
export function validateLayoutRecipe(
  recipe: LayoutRecipe,
  inventory?: Inventory,
): { ok: true } | { ok: false; reason: string } {
  let seatSum = 0;
  for (const [i, block] of recipe.seating.entries()) {
    const kind = block.kind ?? 'theatre';
    if (kind === 'round' || kind === 'schoolroom') {
      if (!block.table) {
        return {
          ok: false,
          reason: `block ${i + 1}: ${kind} seating needs an exact table catalogue name`,
        };
      }
      if (inventory) {
        const resolved = resolveInventoryQuery(inventory, block.table, { requireExact: true });
        if (resolved.status !== 'exact' && resolved.status !== 'unique') {
          return {
            ok: false,
            reason: `block ${i + 1} table: ${resolveFailureMessage(resolved)}`,
          };
        }
      }
    }
    const request = seatingRequestFromBlock(block, 0, 0);
    const n = expectedSeatCount(request);
    if (n !== block.expectCount) {
      return {
        ok: false,
        reason: `block ${i + 1}: rowLengths/rows imply ${n} seats but expectCount is ${block.expectCount}`,
      };
    }
    seatSum += n;
    if (inventory) {
      const resolved = resolveInventoryQuery(inventory, block.chair, { requireExact: true });
      if (resolved.status !== 'exact' && resolved.status !== 'unique') {
        return {
          ok: false,
          reason: `block ${i + 1} chair: ${resolveFailureMessage(resolved)}`,
        };
      }
    }
  }
  if (seatSum !== recipe.expectations.chairs) {
    return {
      ok: false,
      reason: `seating blocks sum to ${seatSum} chairs but expectations.chairs is ${recipe.expectations.chairs}`,
    };
  }
  if (inventory && recipe.expectations.requireGearNames) {
    for (const name of recipe.expectations.requireGearNames) {
      const resolved = resolveInventoryQuery(inventory, name, { requireExact: true });
      if (resolved.status !== 'exact' && resolved.status !== 'unique') {
        return { ok: false, reason: `required gear: ${resolveFailureMessage(resolved)}` };
      }
    }
  }
  if (inventory && recipe.gear) {
    for (const g of recipe.gear) {
      const resolved = resolveInventoryQuery(inventory, g.name, { requireExact: true });
      if (resolved.status !== 'exact' && resolved.status !== 'unique') {
        return { ok: false, reason: `gear “${g.name}”: ${resolveFailureMessage(resolved)}` };
      }
    }
  }
  return { ok: true };
}

export function seatingRequestFromBlock(
  block: LayoutRecipeSeatingBlock,
  x: number,
  y: number,
): SeatingRequest {
  const kind = block.kind ?? 'theatre';
  return {
    kind,
    x,
    y,
    chair: block.chair,
    table: block.table,
    seats: block.seats,
    angle: block.angleDeg,
    seatSpacing: (block.seatSpacingFt ?? 2) * UNITS_PER_FOOT,
    rowSpacing: (block.rowSpacingFt ?? (kind === 'schoolroom' ? 5 : 3)) * UNITS_PER_FOOT,
    rowLengths: block.rowLengths,
    rows: block.rows,
    perRow: block.perRow,
  };
}

/**
 * Places every seating block onto a document.
 * Callers supply an already-open editable plan sized to the recipe room.
 */
export function applyLayoutRecipeSeating(
  doc: RVDocument,
  index: DocumentIndex,
  recipe: LayoutRecipe,
): LayoutRecipeApplyResult {
  const seating: SeatingResult[] = [];
  let chairsPlaced = 0;
  let live = index;

  for (const [i, block] of recipe.seating.entries()) {
    const request = seatingRequestFromBlock(
      block,
      block.xFt * UNITS_PER_FOOT,
      block.yFt * UNITS_PER_FOOT,
    );
    const result = addSeating(doc, live, request);
    seating.push(result);
    if (!result.ok) {
      return {
        ok: false,
        reason: `block ${i + 1}: ${result.reason}`,
        chairsPlaced,
        gearPlaced: 0,
        labelsPlaced: 0,
        dimensionsPlaced: 0,
        seating,
      };
    }
    // `result.placed` can include tables (rounds / schoolroom); chair total is the contract.
    const chairsThisBlock = expectedSeatCount(request);
    if (chairsThisBlock !== block.expectCount) {
      return {
        ok: false,
        reason: `block ${i + 1}: placed ${chairsThisBlock} chairs, expected ${block.expectCount}`,
        chairsPlaced: chairsPlaced + chairsThisBlock,
        gearPlaced: 0,
        labelsPlaced: 0,
        dimensionsPlaced: 0,
        seating,
      };
    }
    chairsPlaced += chairsThisBlock;
    live = indexDocument(doc);
  }

  if (chairsPlaced !== recipe.expectations.chairs) {
    return {
      ok: false,
      reason: `placed ${chairsPlaced} chairs, expected ${recipe.expectations.chairs}`,
      chairsPlaced,
      gearPlaced: 0,
      labelsPlaced: 0,
      dimensionsPlaced: 0,
      seating,
    };
  }

  return {
    ok: true,
    chairsPlaced,
    gearPlaced: 0,
    labelsPlaced: 0,
    dimensionsPlaced: 0,
    seating,
  };
}

/**
 * Symbol files are opened once and kept. A recipe places gear item by item, and
 * a show of this size names the same source file dozens of times.
 */
const symbolSourceCache = new Map<string, RVDocument | null>();

function loadSymbolSource(path: string): RVDocument | null {
  const hit = symbolSourceCache.get(path);
  if (hit !== undefined) return hit;
  let doc: RVDocument | null = null;
  try {
    doc = loadBuffer(readFileSync(path), path).document;
  } catch {
    doc = null;
  }
  symbolSourceCache.set(path, doc);
  return doc;
}

/** The real outline for a chair name, when the inventory carries one. */
export function seedChairSymbol(
  inventory: Inventory | undefined,
  chair: string,
): { source: RVDocument; name: string } | null {
  if (!inventory) return null;
  const resolved = resolveInventoryQuery(inventory, chair, { requireExact: true });
  if (resolved.status !== 'exact' && resolved.status !== 'unique') return null;
  const path = resolved.item.symbolPath;
  if (!path) return null;
  const source = loadSymbolSource(path);
  if (!source) return null;
  return { source, name: resolved.item.symbolName ?? resolved.item.name };
}

export function applyLayoutRecipeGear(
  doc: RVDocument,
  index: DocumentIndex,
  recipe: LayoutRecipe,
  inventory?: Inventory,
): { ok: true; gearPlaced: number } | { ok: false; reason: string; gearPlaced: number } {
  let gearPlaced = 0;
  let live = index;
  for (const g of recipe.gear ?? []) {
    let name = g.name;
    let known: { width: number; height: number } | undefined;
    let symbol: { path: string; name: string } | undefined;
    if (inventory) {
      const resolved = resolveInventoryQuery(inventory, g.name, { requireExact: true });
      if (resolved.status !== 'exact' && resolved.status !== 'unique') {
        return {
          ok: false,
          reason: resolveFailureMessage(resolved) ?? `cannot resolve ${g.name}`,
          gearPlaced,
        };
      }
      name = resolved.item.name;
      known =
        resolved.item.width && resolved.item.height
          ? { width: resolved.item.width, height: resolved.item.height }
          : undefined;
      if (resolved.item.symbolPath) {
        symbol = { path: resolved.item.symbolPath, name: resolved.item.symbolName ?? resolved.item.name };
      }
    }

    // An inventory item that carries a harvested outline gets the real drawing.
    // Without this the recipe path only ever reached `placeGear`, which clones a
    // matching shape already in the document — and on a plan built from a blank
    // sheet there is nothing to clone, so every piece of gear became a sized
    // box. The rebuild of a 2,234-seat show came out with 2,395 furniture
    // primitives against the original's 6,941, and the difference was almost
    // entirely symbols that were never brought across.
    //
    // WHICH route depends on what the source holds. A shape LIBRARY keeps its
    // definitions as typed roots — `RVAVItem`, `RVChair` — whose name lives in
    // a record beside the object rather than in a label inside it. Copying one
    // across with `importSymbol` brings the drawing and loses the identity: it
    // lands as an `RVAVItem` with no labels, and every consumer that reads the
    // plan by walking named `RVShape`s — the schedule, the pull sheet, the
    // report, the gear allocation — cannot see it.
    //
    // That is not theoretical. "Speaker" and "Podium/Lectern" resolve to a
    // `.stk` library, so applying the arena kit placed both, counted neither,
    // failed its own `requireGearNames` check, and rolled the WHOLE layout
    // back — 664 chairs and a stage discarded because two speakers were
    // invisible to the schedule. `placeFromLibrary` rebuilds the outline as a
    // proper named placement, which is what every other object on the plan is.
    const source = symbol ? loadSymbolSource(symbol.path) : null;
    const fromLibrary =
      source != null &&
      readLibrary(source).some((e) => e.name.trim().toLowerCase() === symbol!.name.trim().toLowerCase());

    const placed = !source
      ? placeGear(doc, live, name, g.xFt * UNITS_PER_FOOT, g.yFt * UNITS_PER_FOOT, known)
      : fromLibrary
        ? placeFromLibrary(
            doc,
            source,
            symbol!.name,
            g.xFt * UNITS_PER_FOOT,
            g.yFt * UNITS_PER_FOOT,
          )
        : importSymbol(
            doc,
            live,
            source,
            symbol!.name,
            g.xFt * UNITS_PER_FOOT,
            g.yFt * UNITS_PER_FOOT,
          );
    if (!placed.ok) {
      return { ok: false, reason: placed.reason ?? `failed to place ${name}`, gearPlaced };
    }
    gearPlaced++;
    live = indexDocument(doc);
  }
  return { ok: true, gearPlaced };
}

export function applyLayoutRecipeAnnotations(
  doc: RVDocument,
  index: DocumentIndex,
  recipe: LayoutRecipe,
): { ok: true; labelsPlaced: number; dimensionsPlaced: number } | { ok: false; reason: string } {
  let live = index;
  let labelsPlaced = 0;
  let dimensionsPlaced = 0;

  for (const label of recipe.labels ?? []) {
    const result = createLabel(
      doc,
      live,
      label.text,
      label.xFt * UNITS_PER_FOOT,
      label.yFt * UNITS_PER_FOOT,
    );
    if (!result.ok) {
      return { ok: false, reason: result.reason ?? `label “${label.text}”` };
    }
    labelsPlaced++;
    live = indexDocument(doc);
  }

  for (const dim of recipe.dimensions ?? []) {
    const result = createDimension(
      doc,
      live,
      dim.x1Ft * UNITS_PER_FOOT,
      dim.y1Ft * UNITS_PER_FOOT,
      dim.x2Ft * UNITS_PER_FOOT,
      dim.y2Ft * UNITS_PER_FOOT,
    );
    if (!result.ok) {
      return { ok: false, reason: result.reason ?? 'dimension failed' };
    }
    dimensionsPlaced++;
    live = indexDocument(doc);
  }

  return { ok: true, labelsPlaced, dimensionsPlaced };
}

/** Stage specs for Session.addStage — kept as data so apply tools stay thin. */
export function stageRequestFromRecipe(stage: LayoutRecipeStage) {
  return {
    x: stage.xFt * UNITS_PER_FOOT,
    y: stage.yFt * UNITS_PER_FOOT,
    width: stage.widthFt * UNITS_PER_FOOT,
    depth: stage.depthFt * UNITS_PER_FOOT,
    height: (stage.heightIn ?? 32) * UNITS_PER_INCH,
    back: stage.back
      ? {
          depth: stage.back.depthFt * UNITS_PER_FOOT,
          height: stage.back.heightIn * UNITS_PER_INCH,
        }
      : undefined,
    stairs: stage.stairs,
  };
}

/** Build IncomingItem stubs so a hermetic inventory can validate a recipe. */
export function recipeCatalogueStub(recipe: LayoutRecipe): IncomingItem[] {
  const names = new Set<string>();
  for (const b of recipe.seating) names.add(b.chair);
  for (const g of recipe.gear ?? []) names.add(g.name);
  for (const n of recipe.expectations.requireGearNames ?? []) names.add(n);
  return [...names].map((name) => ({ name }));
}
