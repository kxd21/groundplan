/**
 * Gear lists — the equipment inventory for a job.
 *
 * A rental system prints these as a flat page, but the structure underneath is
 * a tree: departments hold line items, and a line item may be a *package* whose
 * indented children are the pieces that make it up. A "Shure ULXD 8 Pack
 * Wireless Package" is one line to the account manager and eleven lines to the
 * warehouse, and both readings have to survive.
 */

export interface GearItem {
  id: string;
  /** Quantity as printed. Package children are quantities of that package. */
  quantity: number;
  description: string;
  /** Pieces making up a package. */
  children: GearItem[];
  /**
   * A bold instruction rather than a physical item — "Please send diffusion &
   * holders". Counted separately so totals stay honest.
   */
  note?: boolean;
  /** Ticked off during prep. */
  checked?: boolean;
}

export interface GearDepartment {
  id: string;
  name: string;
  items: GearItem[];
}

export interface GearList {
  /**
   * Durable identity for this working list.
   *
   * Optional only so pre-v2 files and callers can still be read. The gear
   * repository assigns one before a list is returned or saved.
   */
  id?: string;
  /** Monotonic revision used to invalidate derived views such as reconcile. */
  revision?: number;
  /** Job number from the header, e.g. `2554`. */
  jobNumber?: string;
  title: string;
  location?: string;
  printedAt?: string;
  departments: GearDepartment[];
  /** Where this list came from, for reference. */
  sourcePath?: string;
  /** Content identity of the imported source, stable if that file is moved. */
  sourceFingerprint?: string;
}

export interface GearTotals {
  /** Top-level line items, which is what a pull sheet is counted in. */
  lines: number;
  /** Every line including package contents. */
  allLines: number;
  /** Sum of quantities across every line. */
  pieces: number;
  notes: number;
  checked: number;
}

export function walkItems(list: GearList): GearItem[] {
  const out: GearItem[] = [];
  const visit = (items: GearItem[]) => {
    for (const item of items) {
      out.push(item);
      visit(item.children);
    }
  };
  for (const d of list.departments) visit(d.items);
  return out;
}

export function totalsFor(list: GearList): GearTotals {
  let lines = 0;
  let allLines = 0;
  let pieces = 0;
  let notes = 0;
  let checked = 0;

  for (const d of list.departments) lines += d.items.filter((i) => !i.note).length;

  for (const item of walkItems(list)) {
    if (item.note) {
      notes++;
      continue;
    }
    allLines++;
    pieces += item.quantity;
    if (item.checked) checked++;
  }

  return { lines, allLines, pieces, notes, checked };
}

export function departmentTotals(department: GearDepartment): { lines: number; pieces: number } {
  let lines = 0;
  let pieces = 0;
  const visit = (items: GearItem[]) => {
    for (const item of items) {
      if (!item.note) {
        lines++;
        pieces += item.quantity;
      }
      visit(item.children);
    }
  };
  visit(department.items);
  return { lines, pieces };
}

/** Case-insensitive filter that keeps a package when any child matches. */
export function filterList(list: GearList, query: string): GearList {
  const q = query.trim().toLowerCase();
  if (!q) return list;

  const keep = (item: GearItem): GearItem | null => {
    const children = item.children.map(keep).filter((c): c is GearItem => c !== null);
    if (item.description.toLowerCase().includes(q) || children.length) {
      return { ...item, children };
    }
    return null;
  };

  return {
    ...list,
    departments: list.departments
      .map((d) => ({ ...d, items: d.items.map(keep).filter((i): i is GearItem => i !== null) }))
      .filter((d) => d.items.length > 0),
  };
}

/** Flattens to CSV, with package contents indented by a leading marker. */
export function toCsv(list: GearList): string {
  const rows: string[] = ['Department,Quantity,Description,Package,Checked'];
  const escape = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

  for (const d of list.departments) {
    const visit = (items: GearItem[], parent: string) => {
      for (const item of items) {
        rows.push(
          [
            escape(d.name),
            item.note ? '' : String(item.quantity),
            escape(item.description),
            escape(parent),
            item.checked ? 'yes' : '',
          ].join(','),
        );
        visit(item.children, item.description);
      }
    };
    visit(d.items, '');
  }

  return rows.join('\n');
}

/**
 * Generates an opaque ID that remains safe across restarts and concurrent
 * imports. The old implementation used a module counter, so opening a saved
 * list and adding an item could reuse an existing ID.
 */
export function nextId(prefix = 'g'): string {
  return `${prefix}_${globalThis.crypto.randomUUID()}`;
}

export interface GearItemLocation {
  item: GearItem;
  siblings: GearItem[];
  index: number;
  departmentId: string;
  parentId: string | null;
}

export interface RemovedGearItem {
  /** Enough information to put an accidentally removed row back in place. */
  item: GearItem;
  departmentId: string;
  parentId: string | null;
  index: number;
}

export type GearMutationResult<T = undefined> =
  | { ok: true; changed: true; value: T; revision: number }
  | { ok: true; changed: false; value?: T; revision: number }
  | { ok: false; reason: string; revision: number };

function currentRevision(list: GearList): number {
  return Number.isSafeInteger(list.revision) && (list.revision ?? 0) >= 0 ? list.revision! : 0;
}

function markChanged(list: GearList): number {
  const revision = currentRevision(list) + 1;
  list.revision = revision;
  return revision;
}

/**
 * Locates exactly one row.
 *
 * Returning no result for an ambiguous legacy ID is deliberately safer than
 * editing whichever duplicate happened to be traversed first.
 */
export function locateGearItem(list: GearList, id: string): GearItemLocation | null {
  const matches: GearItemLocation[] = [];
  const visit = (
    items: GearItem[],
    departmentId: string,
    parentId: string | null,
  ): void => {
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      if (item.id === id) matches.push({ item, siblings: items, index, departmentId, parentId });
      visit(item.children, departmentId, item.id);
    }
  };

  for (const department of list.departments) visit(department.items, department.id, null);
  return matches.length === 1 ? matches[0] : null;
}

export interface GearItemUpdate {
  checked?: boolean;
  quantity?: number;
  description?: string;
}

/** Applies a validated edit and returns a revision suitable for stale checks. */
export function updateGearItem(
  list: GearList,
  id: string,
  patch: GearItemUpdate,
): GearMutationResult<GearItem> {
  const found = locateGearItem(list, id);
  if (!found) {
    return { ok: false, reason: 'item is missing or its legacy ID is ambiguous', revision: currentRevision(list) };
  }

  const item = found.item;
  let changed = false;

  if (patch.quantity !== undefined) {
    if (!Number.isFinite(patch.quantity) || patch.quantity < 0) {
      return { ok: false, reason: 'quantity must be a non-negative number', revision: currentRevision(list) };
    }
    const quantity = Math.round(patch.quantity);
    if (quantity !== item.quantity) {
      item.quantity = quantity;
      changed = true;
    }
  }

  if (patch.description !== undefined) {
    const description = patch.description.trim();
    if (!description) {
      return { ok: false, reason: 'description cannot be empty', revision: currentRevision(list) };
    }
    if (description !== item.description) {
      item.description = description;
      changed = true;
    }
  }

  if (patch.checked !== undefined) {
    const checked = !!patch.checked;
    const visit = (candidate: GearItem): boolean => {
      const differs = (candidate.checked === true) !== checked;
      return candidate.children.reduce((found, child) => visit(child) || found, differs);
    };
    if (visit(item)) {
      const apply = (candidate: GearItem): void => {
        candidate.checked = checked || undefined;
        for (const child of candidate.children) apply(child);
      };
      apply(item);
      changed = true;
    }
  }

  if (!changed) return { ok: true, changed: false, value: item, revision: currentRevision(list) };
  return { ok: true, changed: true, value: item, revision: markChanged(list) };
}

/** Removes one unambiguous row and returns a serialisable undo token. */
export function removeGearItem(list: GearList, id: string): GearMutationResult<RemovedGearItem> {
  const found = locateGearItem(list, id);
  if (!found) {
    return { ok: false, reason: 'item is missing or its legacy ID is ambiguous', revision: currentRevision(list) };
  }
  const [item] = found.siblings.splice(found.index, 1);
  const removed: RemovedGearItem = {
    item,
    departmentId: found.departmentId,
    parentId: found.parentId,
    index: found.index,
  };
  return { ok: true, changed: true, value: removed, revision: markChanged(list) };
}

/** Restores a row removed by removeGearItem, unless its ID is now in use. */
export function restoreGearItem(list: GearList, removed: RemovedGearItem): GearMutationResult<GearItem> {
  if (locateGearItem(list, removed.item.id)) {
    return { ok: false, reason: 'cannot restore because that item ID is already in use', revision: currentRevision(list) };
  }

  const department = list.departments.find((candidate) => candidate.id === removed.departmentId);
  if (!department) {
    return { ok: false, reason: 'cannot restore because the department no longer exists', revision: currentRevision(list) };
  }

  let siblings = department.items;
  if (removed.parentId) {
    const parent = locateGearItem(list, removed.parentId);
    if (!parent) {
      return { ok: false, reason: 'cannot restore because the package no longer exists', revision: currentRevision(list) };
    }
    siblings = parent.item.children;
  }

  const index = Math.max(0, Math.min(removed.index, siblings.length));
  siblings.splice(index, 0, removed.item);
  return { ok: true, changed: true, value: removed.item, revision: markChanged(list) };
}
