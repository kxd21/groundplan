/**
 * Live furniture tallies for the status bar.
 *
 * Counts come from the open scene inventory — what is actually on the drawing —
 * not from the last seating preview. Names cover common rental wording, not
 * only the literal words "chair" and "table".
 */

export interface FurnitureCounts {
  chairs: number;
  tables: number;
}

const CHAIR_RE =
  /\bchair\b|\bseat\b|stool|chiavari|stacker|folding.?chair|armchair|banquet.?chair|padded.?chair|ballroom.?chair|conference.?chair/i;
const TABLE_RE =
  /\btable\b|banquet|cabaret|cocktail|schoolroom|serpentine|high.?top|round\s*\d|rect(angular)?\s*\d|\d+\s*["″]?\s*round/i;

export function countFurniture(
  items: Array<{ name: string; count?: number }>,
): FurnitureCounts {
  let chairs = 0;
  let tables = 0;
  for (const item of items) {
    const n = item.count && item.count > 0 ? item.count : 1;
    const name = item.name ?? '';
    if (CHAIR_RE.test(name)) chairs += n;
    else if (TABLE_RE.test(name)) tables += n;
  }
  return { chairs, tables };
}
