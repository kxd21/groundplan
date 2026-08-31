/**
 * The seating pickers are not general equipment browsers.
 *
 * A Room Viewer catalogue contains plan drawings, front/side/rear elevations,
 * and hundreds of unrelated production assets. Keeping this filter in one
 * place prevents the New Seating flow and the full Seating Planner from
 * drifting back into different, equally confusing lists.
 */

import { classify } from '../../inventory/classify.js';

export interface SeatingCatalogItem {
  name: string;
  category?: string | null;
  view?: string | null;
  /**
   * Explicit override for furniture curated for the seating workflow.
   * `false` keeps an otherwise table-like service object out of the picker.
   */
  seatingEligible?: SeatingAssetKind | false | null;
}

export type SeatingAssetKind = 'chair' | 'table';

const NON_SEATING_TABLE_NAME =
  /\b(bar\s*mat|booth|buffet|cart|casino|cradle|flip\s*chart|glass|napkin|piano|plate|platter|pool\s*table|serving|utensil|whiteboard|test\s*item)\b/i;

/**
 * Classify catalogue stock for the purpose-built seating pickers. This is
 * intentionally stricter than the general inventory taxonomy: a buffet line
 * may be table-shaped on a plan, but it is not a table a planner can seat.
 */
export function seatingEligibility(item: SeatingCatalogItem): SeatingAssetKind | null {
  if (item.seatingEligible === false) return null;
  if (item.seatingEligible === 'chair' || item.seatingEligible === 'table') {
    return item.seatingEligible;
  }

  const inferred = classify(item.name);
  if ((item.view ?? inferred.view) !== 'plan') return null;
  const category = item.category ?? inferred.category;

  if (category === 'chair' || /\b(chair|seat)\b/i.test(item.name)) {
    return ['table-round', 'table-rect', 'desk', 'stairs', 'riser'].includes(category)
      ? null
      : 'chair';
  }

  if (NON_SEATING_TABLE_NAME.test(item.name)) return null;
  if (category === 'table' || category === 'table-round' || category === 'table-rect') {
    return 'table';
  }
  if (category === 'desk' && /\btable\b/i.test(item.name)) return 'table';
  return null;
}

/** Only top-down chairs or tables, in the order the catalogue supplied. */
export function filterSeatingAssets<T extends SeatingCatalogItem>(
  items: T[],
  kind: SeatingAssetKind,
): T[] {
  return items.filter((item) => seatingEligibility(item) === kind);
}

/** Prefer hospitality stock when auto-picking chairs for a new seating job. */
export const PREFERRED_SEATING_CHAIRS = [
  'Banquet Chair 18" × 20"',
  'Banquet Chair 18" x 20"',
  'Chair 20.5W X 23.23D',
  'Chiavari Chair',
];

/** Prefer common banquet / classroom tables when auto-picking. */
export const PREFERRED_SEATING_TABLES = [
  'Banquet Round 60"',
  'Round 60"',
  'Banquet 6′ × 30″',
  `6' x 30"`,
  'Banquet 6′ × 18″',
];

function normalizeFurnitureName(name: string): string {
  return name
    .replace(/[′'']/g, "'")
    .replace(/[″""]/g, '"')
    .replace(/×/g, 'x')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** First preferred name that exists in `available`, else the first available name. */
export function pickPreferredSeatingName(available: string[], preferred: string[]): string {
  if (available.length === 0) return '';
  const byNorm = new Map(available.map((n) => [normalizeFurnitureName(n), n] as const));
  for (const want of preferred) {
    const hit = byNorm.get(normalizeFurnitureName(want));
    if (hit) return hit;
  }
  for (const want of preferred) {
    const wn = normalizeFurnitureName(want);
    const hit = available.find((n) => {
      const an = normalizeFurnitureName(n);
      return an.includes(wn) || wn.includes(an);
    });
    if (hit) return hit;
  }
  return available[0]!;
}
