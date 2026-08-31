/**
 * Hang / flown plot — positions of items with AFF elevation above floor.
 *
 * Geometry stays in the plan / DXF Z; this is the spreadsheet the rigger reads.
 */

import type { PlacedItem } from './definition.js';
import { UNITS_PER_FOOT } from './rv.js';
import { formatLength, type UnitSystem } from './units.js';

/** Items with underside above the floor — truss, fixtures, screens, flown gear. */
export function hangPlotItems(items: PlacedItem[]): PlacedItem[] {
  return items
    .filter((item) => item.elevation > 0)
    .sort(
      (a, b) =>
        b.elevation - a.elevation ||
        a.name.localeCompare(b.name) ||
        a.x - b.x ||
        a.y - b.y,
    );
}

/** Markdown table rows for the plan report hang section. */
export function hangPlotTableRows(
  items: PlacedItem[],
  units: UnitSystem,
): string[][] {
  return hangPlotItems(items).map((item) => [
    item.name,
    formatLength(item.x, units),
    formatLength(item.y, units),
    formatLength(item.elevation, units),
    formatLength(item.top, units),
  ]);
}

/** CSV hang plot — one row per flown item. */
export function hangPlotToCsv(items: PlacedItem[]): string {
  const escape = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const rows = ['Item,X (ft),Y (ft),AFF (ft),Top (ft),Rotation'];
  for (const item of hangPlotItems(items)) {
    rows.push(
      [
        escape(item.name),
        (item.x / UNITS_PER_FOOT).toFixed(2),
        (item.y / UNITS_PER_FOOT).toFixed(2),
        (item.elevation / UNITS_PER_FOOT).toFixed(2),
        (item.top / UNITS_PER_FOOT).toFixed(2),
        `${Math.round(item.rotation)}`,
      ].join(','),
    );
  }
  return rows.join('\n');
}
