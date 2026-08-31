/**
 * Add-panel buckets for Place mode.
 *
 * Inventory `classify()` categories (and a few name-shaped aliases) collapse
 * into the six families the unified Add surface shows. Keeping the map here
 * avoids widening `classify.ts` for UI IA.
 */

export type AddBucket =
  | 'room'
  | 'furniture'
  | 'stage'
  | 'production'
  | 'annotations'
  | 'custom';

export type AddCategoryId = 'all' | AddBucket;

export const ADD_BUCKET_ORDER: AddBucket[] = [
  'room',
  'furniture',
  'stage',
  'production',
  'annotations',
  'custom',
];

export const ADD_BUCKET_LABELS: Record<AddBucket, string> = {
  room: 'Room',
  furniture: 'Furniture',
  stage: 'Stage',
  production: 'Production',
  annotations: 'Annotations',
  custom: 'Custom',
};

export const ADD_CATEGORY_OPTIONS: Array<{ id: AddCategoryId; label: string }> = [
  { id: 'all', label: 'All' },
  ...ADD_BUCKET_ORDER.map((id) => ({ id, label: ADD_BUCKET_LABELS[id] })),
];

const ROOM = new Set([
  'wall',
  'walls',
  'door',
  'doors',
  'column',
  'columns',
  'airwall',
  'airwalls',
  'opening',
  'openings',
  'architecture',
  'architecture-ish',
  'drape',
  'drape-upright',
]);

const FURNITURE = new Set([
  'chair',
  'table',
  'table-round',
  'table-rect',
  'bar',
  'podium',
  'buffet',
  'desk',
]);

const STAGE = new Set([
  'stage',
  'stairs',
  'steps',
  'riser',
  'deck',
  'platform',
  'lift',
  'ladder',
]);

const PRODUCTION = new Set([
  'video',
  'audio',
  'lighting',
  'truss',
  'truss-base',
  'screen',
  'projector',
  'foh',
  'cable',
  'av',
  'flat-panel',
  'camera',
  'moving-light',
  'par-light',
  'ellipsoidal',
  'light-batten',
  'light-tree',
  'lighting-console',
  'speaker',
  'subwoofer',
  'mixer',
]);

const ANNOTATIONS = new Set([
  'annotation',
  'annotations',
  'label',
  'labels',
  'dimension',
  'dimensions',
  'text',
  'note',
  'notes',
]);

const CUSTOM = new Set([
  'traced',
  'other',
  'unknown',
  'not-drawn',
  'person',
  'custom',
]);

/** Maps a classify (or inventory) category string into an Add bucket. */
export function addBucket(category: string): AddBucket {
  const key = category.trim().toLowerCase();
  if (!key) return 'custom';
  if (ROOM.has(key)) return 'room';
  if (FURNITURE.has(key)) return 'furniture';
  if (STAGE.has(key)) return 'stage';
  if (PRODUCTION.has(key)) return 'production';
  if (ANNOTATIONS.has(key)) return 'annotations';
  if (CUSTOM.has(key)) return 'custom';
  return 'custom';
}
