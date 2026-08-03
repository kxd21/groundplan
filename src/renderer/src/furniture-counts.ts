/**
 * Live furniture tallies for the status bar.
 *
 * Counts come from the open scene inventory — what is actually on the drawing —
 * not from the last seating preview. Names are matched the same way the
 * classifier and seating pickers already do.
 */

export interface FurnitureCounts {
  chairs: number;
  tables: number;
}

export function countFurniture(
  items: Array<{ name: string; count?: number }>,
): FurnitureCounts {
  let chairs = 0;
  let tables = 0;
  for (const item of items) {
    const n = item.count && item.count > 0 ? item.count : 1;
    const name = item.name ?? '';
    if (/\bchair\b|\bseat\b|stool/i.test(name)) chairs += n;
    else if (/\btable\b|banquet|cabaret|cocktail|schoolroom/i.test(name)) tables += n;
  }
  return { chairs, tables };
}
