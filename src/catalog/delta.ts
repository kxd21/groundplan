/**
 * Incremental catalog updates.
 *
 * Deltas are record-level rather than binary. A binary diff of a database file
 * breaks the moment the local copy is rewritten for an unrelated reason, and it
 * cannot be read by a person when something goes wrong. A list of records to
 * add, change and withdraw survives both.
 *
 * The property that matters, and the one the tests assert, is that applying a
 * delta produces exactly the catalog a full download of the same version would
 * have produced. If that ever stops holding, incremental updating is not worth
 * having.
 */

import {
  compareVersions,
  indexCatalog,
  type Catalog,
  type CatalogProduct,
} from './model.js';

export interface CatalogDelta {
  format: 'groundplan-catalog-delta';
  fromVersion: string;
  toVersion: string;
  /** Whole records, added or replaced. */
  upsert: CatalogProduct[];
  /** Ids withdrawn from the catalog, with a replacement where one is known. */
  deprecate: Array<{ id: string; replacedBy?: string; reason?: string }>;
  /**
   * Ids removed outright.
   *
   * Reserved for records that should never have existed — a duplicate, or
   * something published in error. Withdrawing a real product uses `deprecate`,
   * because a company may own one and their record has to keep resolving.
   */
  delete: string[];
  /** Asset hashes the new version needs, so they can be fetched once. */
  assets?: { add: string[]; drop: string[] };
  meta: Catalog['meta'];
}

/** Builds the delta between two catalog releases. Used by the publisher. */
export function computeDelta(from: Catalog, to: Catalog): CatalogDelta {
  const before = indexCatalog(from);
  const after = indexCatalog(to);

  const upsert: CatalogProduct[] = [];
  const deprecate: CatalogDelta['deprecate'] = [];
  const remove: string[] = [];

  for (const product of to.products) {
    const previous = before.get(product.id);
    // Compared by value: a release that republishes an unchanged record should
    // not put it in the delta, or every release would carry the whole catalog.
    if (!previous || JSON.stringify(previous) !== JSON.stringify(product)) {
      upsert.push(product);
    }
  }

  for (const product of from.products) {
    const current = after.get(product.id);
    if (!current) {
      remove.push(product.id);
    } else if (current.deprecated && !product.deprecated) {
      deprecate.push({
        id: product.id,
        replacedBy: current.replacedBy,
        reason: current.deprecated.reason,
      });
    }
  }

  const assetsOf = (catalog: Catalog): Set<string> => {
    const out = new Set<string>();
    for (const product of catalog.products) {
      for (const asset of [...(product.images ?? []), ...(product.manuals ?? [])]) {
        out.add(asset.sha256);
      }
    }
    return out;
  };
  const beforeAssets = assetsOf(from);
  const afterAssets = assetsOf(to);

  return {
    format: 'groundplan-catalog-delta',
    fromVersion: from.meta.version,
    toVersion: to.meta.version,
    upsert,
    deprecate,
    delete: remove,
    assets: {
      add: [...afterAssets].filter((h) => !beforeAssets.has(h)),
      drop: [...beforeAssets].filter((h) => !afterAssets.has(h)),
    },
    meta: to.meta,
  };
}

export interface ApplyResult {
  ok: boolean;
  reason?: string;
  catalog?: Catalog;
  added: number;
  updated: number;
  deprecated: number;
  removed: number;
}

/**
 * Applies a delta to a catalog, returning a new one.
 *
 * Pure: the input catalog is not touched. The caller stages the result and
 * validates it before anything replaces the copy in use, so a delta that
 * applies cleanly but produces nonsense still never becomes the live catalog.
 */
export function applyDelta(catalog: Catalog, delta: CatalogDelta): ApplyResult {
  const empty = { added: 0, updated: 0, deprecated: 0, removed: 0 };

  if (delta.format !== 'groundplan-catalog-delta') {
    return { ok: false, reason: 'not a catalog delta', ...empty };
  }
  if (compareVersions(delta.fromVersion, catalog.meta.version) !== 0) {
    return {
      ok: false,
      reason: `this update applies to catalog ${delta.fromVersion}, but ${catalog.meta.version} is installed`,
      ...empty,
    };
  }
  if (compareVersions(delta.toVersion, delta.fromVersion) <= 0) {
    return { ok: false, reason: 'the update does not move the catalog forward', ...empty };
  }

  const index = indexCatalog(catalog);
  // Deep-ish copy so the caller's catalog is untouched even on failure.
  const next = new Map<string, CatalogProduct>();
  for (const [id, product] of index) next.set(id, product);

  let added = 0;
  let updated = 0;

  for (const product of delta.upsert) {
    if (!product?.id) return { ok: false, reason: 'the update contains a product with no id', ...empty };
    if (next.has(product.id)) updated++;
    else added++;
    next.set(product.id, product);
  }

  let deprecated = 0;
  for (const entry of delta.deprecate) {
    const product = next.get(entry.id);
    if (!product) continue;
    next.set(entry.id, {
      ...product,
      deprecated: { since: delta.toVersion, reason: entry.reason },
      replacedBy: entry.replacedBy ?? product.replacedBy,
    });
    deprecated++;
  }

  let removed = 0;
  for (const id of delta.delete) {
    if (next.delete(id)) removed++;
  }

  const products = [...next.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    ok: true,
    catalog: {
      format: 'groundplan-catalog',
      meta: { ...delta.meta, productCount: products.length },
      products,
    },
    added,
    updated,
    deprecated,
    removed,
  };
}
