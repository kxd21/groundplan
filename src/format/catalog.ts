/**
 * Reads Room Viewer's shape catalogue from `rvtss.mdb`.
 *
 * The installation keeps a Jet (Access) database alongside the shape libraries
 * describing every stock shape: its name, the category it belongs to, and the
 * inventory file it came from. Plans only store a shape's *name*, so this is what
 * turns an inventory line like `Round 60"` into "Round Tables" — useful when
 * reading someone else's plan.
 *
 * The database is opened read-only; nothing here writes to the installation.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import MDBReader from 'mdb-reader';

export interface CatalogEntry {
  name: string;
  category?: string;
  inventory?: string;
}

export interface Catalog {
  path: string;
  entries: Map<string, CatalogEntry>;
  categories: string[];
}

/**
 * Looks for `rvtss.mdb` near an opened plan.
 *
 * A Room Viewer installation puts plans in `Data/` and the database in
 * `Common/`, so both the plan's folder and its siblings are worth checking.
 */
export function findCatalogPath(planPath: string): string | null {
  const dir = dirname(planPath);
  const candidates = [
    join(dir, 'rvtss.mdb'),
    join(dir, 'Common', 'rvtss.mdb'),
    resolve(dir, '..', 'Common', 'rvtss.mdb'),
    resolve(dir, '..', '..', 'Common', 'rvtss.mdb'),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

export function loadCatalog(path: string): Catalog {
  const db = new MDBReader(readFileSync(path));

  const categoryById = new Map<number, string>();
  const libraryById = new Map<number, string>();

  const tables = new Set(db.getTableNames());

  if (tables.has('CATEGORY')) {
    for (const row of db.getTable('CATEGORY').getData()) {
      const id = Number(row.ID);
      const name = String(row.NAME ?? '').replace(/\.\.\.$/, '').trim();
      if (Number.isFinite(id) && name) categoryById.set(id, name);
    }
  }

  if (tables.has('SHPLIB')) {
    for (const row of db.getTable('SHPLIB').getData()) {
      const id = Number(row.ID);
      const name = String(row.NAME ?? row.FILENAME ?? '').trim();
      if (Number.isFinite(id) && name) libraryById.set(id, name);
    }
  }

  const entries = new Map<string, CatalogEntry>();
  if (tables.has('SHAPE')) {
    for (const row of db.getTable('SHAPE').getData()) {
      const name = String(row.NAME ?? '').trim();
      if (!name) continue;
      entries.set(name.toLowerCase(), {
        name,
        category: categoryById.get(Number(row.CATID)),
        inventory: libraryById.get(Number(row.LIBID)),
      });
    }
  }

  return {
    path,
    entries,
    categories: [...new Set(categoryById.values())].sort(),
  };
}

/**
 * Matches an inventory name against the catalogue.
 *
 * Plans sometimes record a trailing size or trimmed variant of the catalogue
 * name, so an exact match is tried first and a prefix match second.
 */
export function lookup(catalog: Catalog, name: string): CatalogEntry | undefined {
  const key = name.trim().toLowerCase();
  const exact = catalog.entries.get(key);
  if (exact) return exact;

  for (const [candidate, entry] of catalog.entries) {
    if (key.startsWith(candidate) || candidate.startsWith(key)) return entry;
  }
  return undefined;
}
