/**
 * Inventory health — what a shop needs to trust the library as the product spine.
 *
 * Placement, seating, Insert, and kits all fail quietly when outlines are
 * missing or elevations leak into the plan palette. This report is the single
 * place that names those failures so the UI can repair them.
 */

import { existsSync } from 'node:fs';

import { classify } from './classify.js';
import { insertCatalogCoverage } from './insert-catalog.js';
import { hasPlaceableSeatingFurniture } from './seed.js';
import type { Inventory, InventoryItem } from './model.js';

export interface InventoryHealthReport {
  total: number;
  placeable: number;
  missingOutline: number;
  deadSymbolPaths: number;
  elevations: number;
  boxLikeOutlines: number;
  seatingReady: boolean;
  insertMatched: number;
  insertTotal: number;
  insertMissing: string[];
  /** Short lines for status / notice copy. */
  issues: string[];
  ok: boolean;
}

function isBoxLike(item: InventoryItem): boolean {
  const paths = item.tracedIcon?.paths;
  if (!paths || paths.length !== 1) return false;
  const path = paths[0]!;
  return path.closed === true && (path.points?.length ?? 0) === 8;
}

function hasOutline(item: InventoryItem): boolean {
  if (item.tracedIcon?.paths?.length) return true;
  if (item.symbolPath && existsSync(item.symbolPath)) return true;
  return false;
}

export function inventoryHealth(inventory: Inventory): InventoryHealthReport {
  let placeable = 0;
  let missingOutline = 0;
  let deadSymbolPaths = 0;
  let elevations = 0;
  let boxLikeOutlines = 0;

  for (const item of inventory.items) {
    const view = item.view ?? classify(item.name).view;
    if (view !== 'plan') elevations++;

    const liveSymbol = !!(item.symbolPath && existsSync(item.symbolPath));
    if (item.symbolPath && !liveSymbol && !item.symbolAsset?.relativePath) deadSymbolPaths++;
    else if (item.symbolPath && !liveSymbol && item.symbolAsset) {
      // Relative asset not hydrated yet — count only if no traced fallback.
      if (!item.tracedIcon?.paths?.length) deadSymbolPaths++;
    }

    if (hasOutline(item)) {
      if (view === 'plan') placeable++;
      if (isBoxLike(item)) boxLikeOutlines++;
    } else {
      missingOutline++;
    }
  }

  const coverage = insertCatalogCoverage(
    inventory.items.map((item) => ({
      id: item.id,
      name: item.name,
      category: item.category ?? null,
    })),
  );

  const seatingReady = hasPlaceableSeatingFurniture(inventory);
  const issues: string[] = [];
  if (inventory.items.length === 0) {
    issues.push('The equipment library is empty — restore the starter pack to place shapes.');
  } else {
    if (!seatingReady) issues.push('Seating needs a plan-view chair and table with outlines.');
    if (missingOutline > 0) {
      issues.push(`${missingOutline} item${missingOutline === 1 ? '' : 's'} have no placeable outline.`);
    }
    if (deadSymbolPaths > 0) {
      issues.push(`${deadSymbolPaths} symbol file path${deadSymbolPaths === 1 ? '' : 's'} are missing.`);
    }
    if (elevations > 0) {
      issues.push(
        `${elevations} elevation drawing${elevations === 1 ? '' : 's'} (front/side/rear) — hidden from Place.`,
      );
    }
    if (coverage.matched < coverage.total) {
      const pct = Math.round((coverage.matched / Math.max(1, coverage.total)) * 100);
      issues.push(`Insert matches ${coverage.matched}/${coverage.total} catalogue items (${pct}%).`);
    }
  }

  return {
    total: inventory.items.length,
    placeable,
    missingOutline,
    deadSymbolPaths,
    elevations,
    boxLikeOutlines,
    seatingReady,
    insertMatched: coverage.matched,
    insertTotal: coverage.total,
    insertMissing: coverage.missing,
    issues,
    ok: issues.length === 0 || (seatingReady && missingOutline === 0 && deadSymbolPaths === 0),
  };
}
