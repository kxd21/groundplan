/**
 * The public equipment catalog.
 *
 * This is the half of an inventory that is the same for everybody: a Barco
 * UDX-4K32 weighs what it weighs no matter who owns it. Keeping it separate
 * from company data is what lets it be downloaded, replaced and shared without
 * ever touching what a company knows about its own gear.
 *
 * The split is physical, not a convention. Public records live in their own
 * file that the update path owns outright; private records live in
 * `inventory.json`, which the update path cannot write. "An update must never
 * overwrite private data" is then a property of the design rather than a rule
 * someone has to remember.
 *
 * Stored as JSON rather than SQLite on purpose. Windows installers are
 * cross-built from macOS through wine, and a native database module would need
 * per-platform prebuilt binaries — it would break that cross-build outright.
 * JSON also reuses the migration and atomic-write machinery the private
 * inventory already relies on. The cost is linear search, which is fine into
 * the tens of thousands of products.
 */

/** Lengths are in tenths of an inch, matching the drawing engine. */
export const CATALOG_UNITS_PER_INCH = 10;

export interface CatalogAsset {
  /** SHA-256 of the file, which is also its name in the asset store. */
  sha256: string;
  kind: 'image' | 'manual' | 'drawing';
  /** Shown to a person, e.g. "Installation manual (rev C)". */
  label?: string;
  bytes?: number;
  /** MIME type, so the app knows how to open it. */
  contentType?: string;
}

export interface CatalogDimensions {
  /** Footprint, in tenths of an inch — the two the plan cares about. */
  width?: number;
  depth?: number;
  /** Vertical height, kept for 3D export and rigging clearance. */
  height?: number;
}

export interface CatalogPower {
  /** Steady-state draw in watts. */
  watts?: number;
  volts?: number;
  /** Worst-case amperage, which is what a venue asks for. */
  amps?: number;
  /** e.g. "Edison", "L6-20", "powerCON TRUE1". */
  connector?: string;
  phase?: 1 | 3;
}

/**
 * One publicly shared product.
 *
 * Every field here is safe for anyone to see. Nothing about who owns one, what
 * they paid, or where it is stored belongs in this type — see `InventoryItem`
 * for that.
 */
export interface CatalogProduct {
  /** Stable, namespaced and human-readable: `gp:barco:udx-4k32`. */
  id: string;
  manufacturer: string;
  /** Sub-brand where it differs from the manufacturer, e.g. Chauvet DJ. */
  brand?: string;
  model: string;
  /** Full display name, usually manufacturer plus model. */
  name: string;
  /** Equipment category, shared with the classifier's vocabulary. */
  category: string;

  dimensions?: CatalogDimensions;
  /** Weight in pounds. Rigging cares, so it is first-class rather than a spec. */
  weightLb?: number;
  power?: CatalogPower;

  /** Free-form technical specs, e.g. `{"Brightness": "31,000 lumens"}`. */
  specifications?: Record<string, string>;
  inputs?: string[];
  outputs?: string[];
  connections?: string[];

  images?: CatalogAsset[];
  manuals?: CatalogAsset[];

  /** Product ids of accessories that go with this. */
  accessories?: string[];
  /** Product ids known to work with this. */
  compatibleWith?: string[];
  /** Where a discontinued product's replacement lives. */
  replacedBy?: string;

  tags?: string[];

  /**
   * Set when a product is withdrawn.
   *
   * Deprecated products are kept rather than deleted: a company may still own
   * one, and their record has to keep resolving.
   */
  deprecated?: { since: string; reason?: string };

  /** Catalog version this record last changed in, for "what's new". */
  revised?: string;
}

export interface CatalogMeta {
  /** Content version of this catalog release, e.g. "2.5.0". */
  version: string;
  /** Shape of this file. Bumped only by breaking structural change. */
  schemaVersion: number;
  released: string;
  /** Oldest app build that can read this schema. */
  minAppVersion: string;
  productCount: number;
}

export interface Catalog {
  format: 'groundplan-catalog';
  meta: CatalogMeta;
  products: CatalogProduct[];
}

export const CATALOG_SCHEMA_VERSION = 1;

/** Schema versions this build understands. Anything else is refused. */
export const SUPPORTED_CATALOG_SCHEMAS = [1];

export function emptyCatalog(): Catalog {
  return {
    format: 'groundplan-catalog',
    meta: {
      version: '0.0.0',
      schemaVersion: CATALOG_SCHEMA_VERSION,
      released: '1970-01-01T00:00:00Z',
      minAppVersion: '0.0.0',
      productCount: 0,
    },
    products: [],
  };
}

/** Semver comparison, enough for `major.minor.patch`. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v
      .split('.')
      .map((part) => Number.parseInt(part, 10))
      .map((n) => (Number.isFinite(n) ? n : 0));

  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const d = (left[i] ?? 0) - (right[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export interface CatalogValidation {
  ok: boolean;
  problems: string[];
}

/**
 * Structural check of a catalog before it is trusted.
 *
 * Run after applying an update and before swapping it into place, so a release
 * that is well-signed but internally broken still cannot land.
 */
export function validateCatalog(value: unknown): CatalogValidation {
  const problems: string[] = [];
  const catalog = value as Catalog | null;

  if (!catalog || typeof catalog !== 'object') return { ok: false, problems: ['not an object'] };
  if (catalog.format !== 'groundplan-catalog') problems.push('wrong format tag');
  if (!Array.isArray(catalog.products)) problems.push('products is not an array');
  if (!catalog.meta || typeof catalog.meta !== 'object') problems.push('missing meta');

  if (catalog.meta && !SUPPORTED_CATALOG_SCHEMAS.includes(catalog.meta.schemaVersion)) {
    problems.push(`unsupported schema version ${String(catalog.meta.schemaVersion)}`);
  }

  if (Array.isArray(catalog.products)) {
    const seen = new Set<string>();
    for (const product of catalog.products) {
      if (!product?.id || typeof product.id !== 'string') {
        problems.push('a product has no id');
        break;
      }
      if (seen.has(product.id)) {
        problems.push(`duplicate product id ${product.id}`);
        break;
      }
      seen.add(product.id);
      if (!product.name || !product.manufacturer) {
        problems.push(`${product.id} is missing a name or manufacturer`);
        break;
      }
    }

    if (catalog.meta && catalog.meta.productCount !== catalog.products.length) {
      problems.push(
        `meta says ${catalog.meta.productCount} products but the file holds ${catalog.products.length}`,
      );
    }
  }

  return { ok: problems.length === 0, problems };
}

/** Index by id, for delta application and lookup. */
export function indexCatalog(catalog: Catalog): Map<string, CatalogProduct> {
  return new Map(catalog.products.map((p) => [p.id, p]));
}
