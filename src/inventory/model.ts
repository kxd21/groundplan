/**
 * The equipment inventory.
 *
 * A gear list belongs to one job; this belongs to the company. Every item that
 * has ever appeared on a job accumulates here, so the next plan can be built
 * from the real inventory rather than from whatever happens to be in the file
 * already.
 *
 * The part that earns its keep is `width`/`height`. Sizes guessed from a
 * description are often wrong — "Leko Light" says nothing about its footprint —
 * so once a size is corrected by hand it is remembered and every later
 * placement of that item is right.
 */

import {
  classify,
  CATEGORY_LABELS,
  CATEGORY_LAYER,
  type Category,
  type CategoryLayer,
} from './classify.js';

export type SizeSource = 'parsed' | 'user' | 'unknown' | 'symbol';

export type InventoryImportType =
  | 'gear-pdf'
  | 'csv'
  | 'plan'
  | 'symbol-library'
  | 'manual'
  | 'unknown';

export interface InventoryImportContext {
  /**
   * Stable caller-provided identity. Prefer a Show/job UUID. When omitted, a
   * deterministic identity is derived from jobId or sourcePath.
   */
  id?: string;
  type: InventoryImportType;
  jobId?: string;
  label?: string;
  sourcePath?: string;
}

export interface InventoryImportRecord extends InventoryImportContext {
  id: string;
  firstImportedAt: string;
  lastImportedAt: string;
}

export interface InventorySymbolAsset {
  /** SHA-256 of the managed source file. */
  hash: string;
  /** Portable path relative to the inventory file's directory. */
  relativePath: string;
  /** Original location retained for provenance and repair. */
  sourcePath?: string;
}

export interface InventoryItem {
  id: string;
  name: string;
  /** Department it arrived under, e.g. `Lighting`. */
  department?: string;
  /**
   * What kind of thing this is, worked out from the description.
   *
   * Drives grouping and search, and is what the symbol matcher keys off. The
   * families line up with the drawing's own layers so the two vocabularies
   * stay one idea.
   */
  category?: Category;
  /** Footprint in logical units (tenths of an inch). */
  width?: number;
  height?: number;
  sizeSource: SizeSource;
  /** How many jobs this item has appeared on. */
  timesSeen: number;
  /**
   * Count inherited from inventory v1, where individual jobs were not known.
   * New, identified imports are counted separately in provenanceIds.
   */
  legacyTimesSeen?: number;
  /** Distinct import/job identities in which this item appeared. */
  provenanceIds?: string[];
  /** Largest quantity seen on any one job — a useful stocking hint. */
  peakQuantity: number;
  notes?: string;
  /**
   * File this item's drawn symbol comes from.
   *
   * Present when the item was uploaded from a plan or shape inventory, in which
   * case placing it brings the real outline across instead of drawing a box.
   */
  symbolPath?: string;
  /** Managed, content-addressed copy that survives a detached source drive. */
  symbolAsset?: InventorySymbolAsset;
  /**
   * The symbol's own name in that file, when it differs from this item's.
   *
   * A gear list calls it "Panasonic PT-RZ21KU Laser Projector"; the drawing
   * calls the shape "LCD Projector". Placement has to look up the latter.
   */
  symbolName?: string;
  /** Whether the shape was harvested, matched automatically, or set by hand. */
  mappedBy?: 'auto' | 'user';
  /** Why the automatic match chose this shape, so a wrong call is checkable. */
  mapReason?: string;
  /**
   * An outline traced from a picture.
   *
   * Held on the item because there is no plan behind it — the shape came from
   * a datasheet or a photograph rather than from something someone drew.
   */
  tracedIcon?: { paths: Array<{ points: number[]; closed: boolean }>; width: number; height: number };
  addedAt: string;
}

export interface Inventory {
  /** Older files carry `groundplan-library`; the loader accepts both. */
  format: 'groundplan-inventory' | 'groundplan-library';
  version: 2;
  items: InventoryItem[];
  /** Deduplicated import ledger referenced by each item's provenanceIds. */
  imports: InventoryImportRecord[];
}

export function emptyInventory(): Inventory {
  return { format: 'groundplan-inventory', version: 2, items: [], imports: [] };
}

/** Names vary in case, quoting and spacing; match on a normalised form. */
export function normaliseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[”“]/g, '"')
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Opaque identity for a library record.
 *
 * Name-based IDs are recycled after deletion and can make a stale UI command
 * target a newly created row with the same name. Names remain the dedupe key
 * during import, while identity is a UUID that is never derived from mutable
 * content or array position.
 */
function idFor(): string {
  return `li_${globalThis.crypto.randomUUID()}`;
}

export interface MergeSummary {
  added: number;
  updated: number;
  /** Existing rows for which an identified import had already been recorded. */
  duplicateSightings: number;
  /** Existing rows whose content and provenance were already current. */
  unchanged: number;
}

export interface IncomingItem {
  name: string;
  department?: string;
  quantity?: number;
  width?: number;
  height?: number;
  sizeSource?: SizeSource;
  symbolPath?: string;
  symbolName?: string;
  mappedBy?: 'auto' | 'user';
  mapReason?: string;
  notes?: string;
  tracedIcon?: InventoryItem['tracedIcon'];
  symbolAsset?: InventorySymbolAsset;
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/** Returns the stable identity used to deduplicate one import/job. */
export function inventoryImportId(context: InventoryImportContext): string | null {
  const explicit = context.id?.trim();
  if (explicit) return explicit;
  const job = context.jobId?.trim();
  if (job) return `job_${shortHash(normaliseName(job))}`;
  const source = context.sourcePath?.trim();
  if (source) {
    // File paths are case-insensitive on the supported default Mac/Windows
    // volumes. Normalising separators also makes the ledger portable.
    const portable = source.replace(/\\/g, '/').toLowerCase();
    return `source_${shortHash(portable)}`;
  }
  return null;
}

function registerImport(
  inventory: Inventory,
  context: InventoryImportContext | undefined,
  at: string,
): string | null {
  if (!context) return null;
  const id = inventoryImportId(context);
  if (!id) return null;
  inventory.imports ??= [];
  const existing = inventory.imports.find((entry) => entry.id === id);
  if (existing) {
    existing.lastImportedAt = at;
    if (!existing.jobId && context.jobId) existing.jobId = context.jobId;
    if (!existing.label && context.label) existing.label = context.label;
    if (!existing.sourcePath && context.sourcePath) existing.sourcePath = context.sourcePath;
  } else {
    inventory.imports.push({
      ...context,
      id,
      firstImportedAt: at,
      lastImportedAt: at,
    });
  }
  return id;
}

function migrateSightingCount(item: InventoryItem): void {
  item.provenanceIds = [...new Set((item.provenanceIds ?? []).filter(Boolean))];
  if (!Number.isSafeInteger(item.legacyTimesSeen) || (item.legacyTimesSeen ?? 0) < 0) {
    // v1's count cannot be assigned to a known job. Preserve it as an honest
    // legacy baseline rather than fabricating provenance.
    item.legacyTimesSeen = Math.max(0, Math.round(item.timesSeen || 0) - item.provenanceIds.length);
  }
  item.timesSeen = (item.legacyTimesSeen ?? 0) + item.provenanceIds.length;
}

function recordSighting(item: InventoryItem, provenanceId: string | null): {
  changed: boolean;
  duplicate: boolean;
} {
  migrateSightingCount(item);
  if (provenanceId) {
    if (item.provenanceIds!.includes(provenanceId)) return { changed: false, duplicate: true };
    item.provenanceIds!.push(provenanceId);
  } else {
    item.legacyTimesSeen = (item.legacyTimesSeen ?? 0) + 1;
  }
  item.timesSeen = (item.legacyTimesSeen ?? 0) + item.provenanceIds!.length;
  return { changed: true, duplicate: false };
}

/**
 * Folds items into the inventory, matching on name.
 *
 * A size the user has corrected is never overwritten by a guess — that
 * correction is the most valuable thing in the record.
 */
export function mergeItems(
  inventory: Inventory,
  incoming: IncomingItem[],
  now = new Date(),
  importContext?: InventoryImportContext,
): MergeSummary {
  const byName = new Map(inventory.items.map((i) => [normaliseName(i.name), i]));
  const at = now.toISOString();
  const provenanceId = registerImport(inventory, importContext, at);
  let added = 0;
  let updated = 0;
  let duplicateSightings = 0;
  let unchanged = 0;

  for (const item of incoming) {
    const name = item.name.trim();
    if (!name) continue;
    const key = normaliseName(name);
    const existing = byName.get(key);

    if (!existing) {
      const entry: InventoryItem = {
        id: idFor(),
        name,
        department: item.department,
        width: item.width,
        height: item.height,
        sizeSource: item.sizeSource ?? (item.width ? 'parsed' : 'unknown'),
        category: classify(name).category,
        symbolPath: item.symbolPath,
        symbolName: item.symbolName,
        symbolAsset: item.symbolAsset,
        mappedBy: item.mappedBy,
        mapReason: item.mapReason,
        notes: item.notes,
        tracedIcon: item.tracedIcon,
        timesSeen: 0,
        legacyTimesSeen: provenanceId ? 0 : 1,
        provenanceIds: provenanceId ? [provenanceId] : [],
        peakQuantity: item.quantity ?? 0,
        addedAt: at,
      };
      entry.timesSeen = entry.legacyTimesSeen! + entry.provenanceIds!.length;
      inventory.items.push(entry);
      byName.set(key, entry);
      added++;
      continue;
    }

    let changed = false;
    const sighting = recordSighting(existing, provenanceId);
    changed ||= sighting.changed;
    if (sighting.duplicate) duplicateSightings++;
    if ((item.quantity ?? 0) > existing.peakQuantity) {
      existing.peakQuantity = item.quantity ?? 0;
      changed = true;
    }
    if (!existing.department && item.department) {
      existing.department = item.department;
      changed = true;
    }
    // A real symbol always beats a name-only entry.
    if (item.symbolPath && item.symbolPath !== existing.symbolPath) {
      existing.symbolPath = item.symbolPath;
      changed = true;
    }
    if (item.symbolAsset && item.symbolAsset.hash !== existing.symbolAsset?.hash) {
      existing.symbolAsset = item.symbolAsset;
      changed = true;
    }
    if (item.symbolName && item.symbolName !== existing.symbolName) {
      existing.symbolName = item.symbolName;
      changed = true;
    }
    if (item.tracedIcon && !existing.tracedIcon) {
      existing.tracedIcon = item.tracedIcon;
      changed = true;
    }
    if (item.mappedBy && !existing.mappedBy) {
      existing.mappedBy = item.mappedBy;
      existing.mapReason = item.mapReason;
      changed = true;
    }
    if (item.notes && !existing.notes) {
      existing.notes = item.notes;
      changed = true;
    }
    if (existing.sizeSource !== 'user' && item.width && item.height) {
      const source = item.sizeSource ?? 'parsed';
      if (existing.width !== item.width || existing.height !== item.height || existing.sizeSource !== source) {
        existing.width = item.width;
        existing.height = item.height;
        existing.sizeSource = source;
        changed = true;
      }
    }
    if (changed) updated++;
    else unchanged++;
  }

  return { added, updated, duplicateSightings, unchanged };
}

export interface InventoryItemPatch {
  name?: string;
  department?: string;
  notes?: string;
  width?: number;
  height?: number;
}

export interface RemovedInventoryItem {
  item: InventoryItem;
  index: number;
}

export type InventoryMutationResult<T = undefined> =
  | { ok: true; changed: true; value: T }
  | { ok: true; changed: false; value?: T }
  | { ok: false; reason: string };

/** Finds one item only; a duplicate legacy ID is treated as unsafe. */
export function locateInventoryItem(inventory: Inventory, id: string): InventoryItem | null {
  const matches = inventory.items.filter((item) => item.id === id);
  return matches.length === 1 ? matches[0] : null;
}

/** Atomically validates and applies an Equipment Library inspector edit. */
export function updateInventoryItem(
  inventory: Inventory,
  id: string,
  patch: InventoryItemPatch,
): InventoryMutationResult<InventoryItem> {
  const item = locateInventoryItem(inventory, id);
  if (!item) return { ok: false, reason: 'item is missing or its legacy ID is ambiguous' };

  let wantedName = item.name;
  if (patch.name !== undefined) {
    wantedName = patch.name.trim();
    if (!wantedName) return { ok: false, reason: 'name cannot be empty' };
    if (
      normaliseName(wantedName) !== normaliseName(item.name) &&
      inventory.items.some((candidate) => candidate.id !== id && normaliseName(candidate.name) === normaliseName(wantedName))
    ) {
      return { ok: false, reason: `there is already an item called "${wantedName}"` };
    }
  }

  const hasWidth = patch.width !== undefined;
  const hasHeight = patch.height !== undefined;
  if (hasWidth !== hasHeight) {
    return { ok: false, reason: 'width and height must be changed together' };
  }
  if (
    hasWidth &&
    (!Number.isFinite(patch.width) ||
      !Number.isFinite(patch.height) ||
      patch.width! <= 0 ||
      patch.height! <= 0)
  ) {
    return { ok: false, reason: 'width and height must be positive numbers' };
  }

  const department = patch.department === undefined ? item.department : patch.department.trim() || undefined;
  const notes = patch.notes === undefined ? item.notes : patch.notes.trim() || undefined;
  const changed =
    wantedName !== item.name ||
    department !== item.department ||
    notes !== item.notes ||
    (hasWidth && (patch.width !== item.width || patch.height !== item.height || item.sizeSource !== 'user'));

  if (!changed) return { ok: true, changed: false, value: item };

  if (wantedName !== item.name) {
    item.name = wantedName;
    item.category = classify(wantedName).category;
  }
  item.department = department;
  item.notes = notes;
  if (hasWidth) {
    item.width = patch.width;
    item.height = patch.height;
    item.sizeSource = 'user';
  }
  return { ok: true, changed: true, value: item };
}

/** Removes one unambiguous item and returns a serialisable undo token. */
export function removeInventoryItem(
  inventory: Inventory,
  id: string,
): InventoryMutationResult<RemovedInventoryItem> {
  const matches = inventory.items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.id === id);
  if (matches.length !== 1) return { ok: false, reason: 'item is missing or its legacy ID is ambiguous' };
  const [{ item, index }] = matches;
  inventory.items.splice(index, 1);
  return { ok: true, changed: true, value: { item, index } };
}

export function restoreInventoryItem(
  inventory: Inventory,
  removed: RemovedInventoryItem,
): InventoryMutationResult<InventoryItem> {
  if (inventory.items.some((item) => item.id === removed.item.id)) {
    return { ok: false, reason: 'cannot restore because that item ID is already in use' };
  }
  if (inventory.items.some((item) => normaliseName(item.name) === normaliseName(removed.item.name))) {
    return { ok: false, reason: 'cannot restore because an item with that name already exists' };
  }
  const index = Math.max(0, Math.min(removed.index, inventory.items.length));
  inventory.items.splice(index, 0, removed.item);
  return { ok: true, changed: true, value: removed.item };
}

/**
 * Backfills categories on an inventory saved before they existed.
 *
 * Cheap enough to run at every load, and it keeps old files working without a
 * migration step the user has to know about.
 */
export function ensureCategories(inventory: Inventory): number {
  let filled = 0;
  for (const item of inventory.items) {
    if (item.category) continue;
    item.category = classify(item.name).category;
    filled++;
  }
  return filled;
}

/** Category counts, grouped by the drawing layer each belongs to. */
export function categoriesOf(
  inventory: Inventory,
): Array<{ id: Category; layer: CategoryLayer; count: number }> {
  const counts = new Map<Category, number>();
  for (const item of inventory.items) {
    const key = item.category ?? 'not-drawn';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([id, count]) => ({ id, layer: CATEGORY_LAYER[id], count }))
    .sort((a, b) => b.count - a.count);
}

export function departmentsOf(inventory: Inventory): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of inventory.items) {
    const key = item.department ?? 'Unfiled';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function searchInventory(
  inventory: Inventory,
  query: string,
  department: string | null,
  category: Category | null = null,
): InventoryItem[] {
  const q = normaliseName(query);
  return inventory.items
    .filter((item) => {
      if (department && (item.department ?? 'Unfiled') !== department) return false;
      if (category && (item.category ?? 'not-drawn') !== category) return false;
      if (!q) return true;
      // Searching the category by name is how someone looks for "projectors"
      // without knowing what any of them are called. The borrowed symbol's name
      // counts too, so "plasma" finds the TVs that place as one.
      const haystack = [
        item.name,
        item.department ?? '',
        item.symbolName ?? '',
        item.category ? CATEGORY_LABELS[item.category] : '',
        item.category ?? '',
      ];
      return haystack.some((text) => normaliseName(text).includes(q));
    })
    .sort((a, b) => b.timesSeen - a.timesSeen || a.name.localeCompare(b.name));
}

/** Parses a CSV export back into items, for bulk loading from a spreadsheet. */
export function parseCsv(text: string): IncomingItem[] {
  const rows = text.split(/\r?\n/).filter((r) => r.trim());
  if (rows.length === 0) return [];

  const split = (row: string): string[] => {
    const out: string[] = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < row.length; i++) {
      const c = row[i];
      if (quoted) {
        if (c === '"' && row[i + 1] === '"') {
          cell += '"';
          i++;
        } else if (c === '"') quoted = false;
        else cell += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') {
        out.push(cell);
        cell = '';
      } else cell += c;
    }
    out.push(cell);
    return out;
  };

  const header = split(rows[0]).map((h) => h.trim().toLowerCase());
  const nameAt = header.findIndex((h) => /name|description|item/.test(h));
  const deptAt = header.findIndex((h) => /department|category|dept/.test(h));
  const qtyAt = header.findIndex((h) => /quantity|qty|count/.test(h));

  // A file with no recognisable header is treated as one item per line.
  if (nameAt === -1) {
    return rows.map((r) => ({ name: split(r)[0]?.trim() ?? '' })).filter((i) => i.name);
  }

  return rows
    .slice(1)
    .map((row) => {
      const cells = split(row);
      return {
        name: (cells[nameAt] ?? '').trim(),
        department: deptAt === -1 ? undefined : (cells[deptAt] ?? '').trim() || undefined,
        quantity: qtyAt === -1 ? undefined : Number(cells[qtyAt]) || undefined,
      };
    })
    .filter((i) => i.name);
}
