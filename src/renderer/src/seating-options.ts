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
}

export type SeatingAssetKind = 'chair' | 'table';

/** Only top-down chairs or tables, in the order the catalogue supplied. */
export function filterSeatingAssets<T extends SeatingCatalogItem>(
  items: T[],
  kind: SeatingAssetKind,
): T[] {
  const blockedTableCategories = new Set([
    'chair',
    'person',
    'stairs',
    'riser',
    'projector',
    'screen',
    'speaker',
    'truss',
    'not-drawn',
  ]);
  const blockedChairCategories = new Set([
    'table-round',
    'table-rect',
    'desk',
    'stairs',
    'riser',
    'projector',
    'screen',
    'truss',
    'not-drawn',
  ]);

  return items.filter((item) => {
    const inferred = classify(item.name);
    if ((item.view ?? inferred.view) !== 'plan') return false;
    const category = item.category ?? inferred.category;
    if (kind === 'chair') {
      if (blockedChairCategories.has(category)) return false;
      return category === 'chair' || /\b(chair|seat)\b/i.test(item.name);
    }
    if (blockedTableCategories.has(category)) return false;
    return (
      category === 'table' ||
      category === 'table-round' ||
      category === 'table-rect' ||
      (category === 'desk' && /\btable\b/i.test(item.name))
    );
  });
}
