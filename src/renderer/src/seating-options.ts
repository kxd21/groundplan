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
  return items.filter((item) => {
    const inferred = classify(item.name);
    if ((item.view ?? inferred.view) !== 'plan') return false;
    const category = item.category ?? inferred.category;
    return kind === 'chair'
      ? category === 'chair'
      : category === 'table' || category === 'table-round' || category === 'table-rect';
  });
}
