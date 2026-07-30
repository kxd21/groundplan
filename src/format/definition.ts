/**
 * What a thing is, kept apart from where it was put.
 *
 * A Room Viewer plan has only placements. An `RVShape` named `Round 66"` knows
 * its outline and its insertion point and nothing else — not that it is a
 * table, not that it stands 30 inches high, not that ten people sit at it. Ask
 * the file how much of the room is blocked at eye level, or whether the back
 * row can see the screen, and there is nothing to ask.
 *
 * So a **definition** describes the item once — footprint, how tall it stands,
 * how far off the floor it starts, whether you can see over it, what it seats —
 * and an **instance** is one appearance of it in a plan. Definitions live in
 * the companion document and in the equipment inventory; instances stay where
 * they already are, as objects in the `.rv4`.
 *
 * Where a definition is missing, `inferSpec` guesses from the name and says so.
 * A guess that admits it is a guess is useful; one that does not is a liability
 * when a sightline study depends on it.
 */

import { measureNode } from './edit.js';
import { walk, UNITS_PER_FOOT, UNITS_PER_INCH, type RVDocument, type RVNode } from './rv.js';

/** How much of the view an item blocks, for sightline and layout work. */
export type Obstruction =
  /** See straight through: a rope line, a floor decal, a dance floor. */
  | 'none'
  /** Blocks below its own height only: tables, chairs, low furniture. */
  | 'partial'
  /** Blocks entirely up to its height: drape, walls, scenic, a truck. */
  | 'full';

export interface AspectRatio {
  w: number;
  h: number;
}

/** The ratios event AV actually specifies. */
export const ASPECT_PRESETS: Array<{ label: string; ratio: AspectRatio }> = [
  { label: '16:9 (HD)', ratio: { w: 16, h: 9 } },
  { label: '16:10 (WUXGA)', ratio: { w: 16, h: 10 } },
  { label: '4:3 (XGA)', ratio: { w: 4, h: 3 } },
  { label: '1:1 (square)', ratio: { w: 1, h: 1 } },
  { label: '1.85:1 (flat)', ratio: { w: 1.85, h: 1 } },
  { label: '2.39:1 (scope)', ratio: { w: 2.39, h: 1 } },
  { label: '21:9 (ultrawide)', ratio: { w: 21, h: 9 } },
  { label: '32:9 (dual-wide)', ratio: { w: 32, h: 9 } },
];

/** Reads `16:9`, `16x9`, `1.85:1` or `1.78` as a ratio. */
export function parseAspect(text: string): AspectRatio | null {
  const cleaned = text.trim().toLowerCase().replace(/\s+/g, '');
  const pair = cleaned.match(/^(\d+(?:\.\d+)?)[:x×/](\d+(?:\.\d+)?)$/);
  if (pair) {
    const w = Number(pair[1]);
    const h = Number(pair[2]);
    if (w > 0 && h > 0) return { w, h };
  }
  const single = cleaned.match(/^(\d+(?:\.\d+)?)$/);
  if (single) {
    const value = Number(single[1]);
    if (value > 0.2 && value < 40) return { w: value, h: 1 };
  }
  return null;
}

export function aspectValue(ratio: AspectRatio): number {
  return ratio.w / ratio.h;
}

export function formatAspect(ratio: AspectRatio): string {
  const preset = ASPECT_PRESETS.find((p) => Math.abs(aspectValue(p.ratio) - aspectValue(ratio)) < 0.005);
  if (preset) return preset.label.replace(/\s*\(.*\)$/, '');
  return `${Number(ratio.w.toFixed(2))}:${Number(ratio.h.toFixed(2))}`;
}

/** Image size from a diagonal measurement and a ratio — how screens are sold. */
export function screenFromDiagonal(diagonal: number, ratio: AspectRatio): { width: number; height: number } {
  const r = aspectValue(ratio);
  const height = diagonal / Math.sqrt(r * r + 1);
  return { width: height * r, height };
}

/** Image size from a width — how screens are actually specified on a plan. */
export function screenFromWidth(width: number, ratio: AspectRatio): { width: number; height: number } {
  return { width, height: width / aspectValue(ratio) };
}

/**
 * The categories the shape editor files things under.
 *
 * Taken from the original application's category tree rather than invented, so
 * a shape defined here lands where somebody used to Room Viewer expects it.
 */
export type ShapeCategory =
  | 'Screens'
  | 'Additional A/V'
  | 'Chairs'
  | 'Dance Floors'
  | 'Miscellaneous'
  | 'Risers'
  | 'Room Features'
  | 'Tables';

export const SHAPE_CATEGORIES: ShapeCategory[] = [
  'Screens',
  'Additional A/V',
  'Chairs',
  'Dance Floors',
  'Miscellaneous',
  'Risers',
  'Room Features',
  'Tables',
];

/** How a table may be seated, which decides where a layout can use it. */
export type TableKind = 'other' | 'round' | 'rectangular';

export interface ItemSpec {
  id: string;
  /** Catalogue name as it appears in plans. Matched on the normalised form. */
  name: string;
  /**
   * Name for Spanish-language reports.
   *
   * The original application is bilingual and its reports are issued in both,
   * which for a crew that works in Spanish is not a nicety.
   */
  spanishName?: string;
  category?: string;
  /** Where the shape editor files it. */
  shapeCategory?: ShapeCategory;
  /** Footprint in logical units. Omitted means "measure it from the drawing". */
  width?: number;
  depth?: number;
  /** Underside height above finished floor — a deck, a flown item, a shelf. */
  elevation?: number;
  /** The item's own height, from its underside. */
  height?: number;
  obstruction?: Obstruction;
  /**
   * This is what the audience is trying to see.
   *
   * The other half of the line-of-sight pair: `obstruction` says a thing blocks
   * the view, this says a thing *is* the view — a screen, a stage, a podium. A
   * sightline check can then find its own target instead of being handed one.
   */
  sightTarget?: boolean;
  /**
   * Hangs from the ceiling rather than standing on the floor.
   *
   * A chandelier is positioned by how far it drops, not by how high its base
   * is, and its clearance question is the opposite one.
   */
  ceilingMounted?: boolean;
  /** How far below the ceiling it hangs, when ceiling-mounted. */
  dropFromCeiling?: number;
  /**
   * Keeps its own clear space around it.
   *
   * Nothing may be laid out inside the footprint plus this margin — a column,
   * a planter, a safelock stand.
   */
  obstacle?: boolean;
  /** Extra clear space an obstacle demands beyond its footprint. */
  clearance?: number;
  /** False for polygons and coloured shapes, which cannot be scaled. */
  resizeable?: boolean;
  /** Tables only: how it seats, which decides which layouts may place it. */
  tableKind?: TableKind;
  /** Tables only: chairs may be placed around it. */
  allowChairs?: boolean;
  /**
   * Layouts allowed to place this table automatically.
   *
   * Empty means any. A 6ft rectangular table belongs in a schoolroom and a
   * hollow square but not in a banquet, and saying so here is what stops the
   * solver reaching for the wrong one.
   */
  validStyles?: string[];
  /** Projection or display surfaces only. */
  aspect?: AspectRatio;
  /** People seated at or on this item. */
  seats?: number;
  weightLb?: number;
  powerW?: number;
  notes?: string;
  /**
   * True when the values came from `inferSpec` rather than from a person or an
   * inventory record. Anything reported from a guessed spec has to say so.
   */
  inferred?: boolean;
}

/** Per-placement departures from the definition: this one riser is higher. */
export interface InstanceOverride {
  /** Stable key from the schedule anchor mechanism. */
  key: string;
  elevation?: number;
  height?: number;
  obstruction?: Obstruction;
  aspect?: AspectRatio;
  seats?: number;
  label?: string;
  layer?: string;
}

export const normaliseName = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[”“]/g, '"')
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

const IN = UNITS_PER_INCH;
const FT = UNITS_PER_FOOT;

/**
 * Standing heights and sightline behaviour by kind of item.
 *
 * These are the trade's ordinary dimensions — a banquet chair seat at 18in with
 * a back around 34in, a dining table at 30in, a cocktail table at 42in, a
 * standard drape at 12ft. They are here so that a plan drawn by someone who
 * never entered a height still supports a sightline check, and every one of
 * them is marked `inferred` so it can be told apart from a measured value.
 */
const INFERENCE: Array<{
  test: RegExp;
  category: string;
  height?: number;
  elevation?: number;
  obstruction?: Obstruction;
  seats?: number;
  aspect?: AspectRatio;
}> = [
  { test: /\bpipe\s*(&|and)?\s*drape\b|\bdrape\b|\bmasking\b/i, category: 'drape', height: 12 * FT, obstruction: 'full' },
  { test: /\bscreen\b|\bprojection surface\b|\bfast[- ]?fold\b/i, category: 'screen', elevation: 3 * FT, height: 9 * FT, obstruction: 'full', aspect: { w: 16, h: 9 } },
  { test: /\b(led )?wall\b|\bvideo wall\b/i, category: 'screen', elevation: 3 * FT, height: 9 * FT, obstruction: 'full', aspect: { w: 16, h: 9 } },
  { test: /\b(tv|monitor|display|plasma)\b/i, category: 'screen', elevation: 4 * FT, height: 3 * FT, obstruction: 'full', aspect: { w: 16, h: 9 } },
  { test: /\bprojector\b/i, category: 'projector', elevation: 3 * FT, height: 12 * IN, obstruction: 'partial' },
  { test: /\b(stage|riser|deck|platform)\b/i, category: 'stage', height: 24 * IN, obstruction: 'none' },
  { test: /\bdance floor\b/i, category: 'floor', height: 1 * IN, obstruction: 'none' },
  { test: /\bpodium\b|\blectern\b/i, category: 'furniture', height: 46 * IN, obstruction: 'full' },
  // Seating before tables: "Banquet Chair" and "Schoolroom Chair" name both,
  // and the chair is the thing being described.
  { test: /\bchair\b|\bstool\b|\bbench\b/i, category: 'chair', height: 34 * IN, obstruction: 'partial', seats: 1 },
  { test: /\bcocktail\b|\bhigh ?top\b|\bbar table\b/i, category: 'table', height: 42 * IN, obstruction: 'partial', seats: 4 },
  { test: /\bround\b/i, category: 'table', height: 30 * IN, obstruction: 'partial' },
  { test: /\b(banquet|rect(angle)?|table|schoolroom|classroom)\b/i, category: 'table', height: 30 * IN, obstruction: 'partial' },
  { test: /\btruss\b/i, category: 'rigging', elevation: 16 * FT, height: 12 * IN, obstruction: 'none' },
  { test: /\b(leko|par|moving light|wash|fixture|light)\b/i, category: 'lighting', elevation: 12 * FT, height: 18 * IN, obstruction: 'none' },
  { test: /\bspeaker\b|\bsub\b|\bline array\b/i, category: 'audio', height: 4 * FT, obstruction: 'partial' },
  { test: /\bbar\b/i, category: 'furniture', height: 42 * IN, obstruction: 'full' },
  { test: /\bbuffet\b/i, category: 'table', height: 30 * IN, obstruction: 'partial' },
];

/**
 * Seats at a table, from the size in its name.
 *
 * Round tables are sold by diameter and seat by circumference, which is why a
 * 60in seats eight and a 72in seats ten rather than the twelve the area would
 * suggest. Banquet tables seat along both long edges plus the ends.
 */
export function inferSeats(name: string): number | undefined {
  const round = name.match(/\bround\s*(\d+(?:\.\d+)?)\s*("|in|inch)?/i) ?? name.match(/\b(\d+)\s*"?\s*round\b/i);
  if (round) {
    // Diameter, in inches, to the count these tables are laid for: a 60in
    // seats eight and a 72in seats ten, because a round seats by its
    // circumference rather than its area.
    const inches = Number(round[1]);
    if (inches < 36) return undefined;
    if (inches < 48) return 4;
    if (inches < 54) return 6;
    if (inches < 66) return 8;
    if (inches <= 96) return 10;
  }

  const banquet = name.match(/\b(\d+(?:\.\d+)?)\s*'?\s*(?:x|×)\s*(\d+(?:\.\d+)?)\s*"?/i);
  if (banquet && /\b(banquet|table|rect)/i.test(name)) {
    const long = Math.max(Number(banquet[1]), Number(banquet[2]));
    if (long >= 8) return 10;
    if (long >= 6) return 8;
    if (long >= 4) return 4;
  }

  const feet = name.match(/\b(\d+)\s*'\s*(banquet|table)/i);
  if (feet) {
    const long = Number(feet[1]);
    if (long >= 8) return 10;
    if (long >= 6) return 8;
  }

  return undefined;
}

/**
 * Builds a best-effort definition from a catalogue name.
 *
 * Used only where nothing better exists. Every field it fills is a trade
 * convention rather than a measurement, so the result carries `inferred: true`
 * and callers are expected to surface that.
 */
export function inferSpec(name: string, id = normaliseName(name)): ItemSpec {
  const spec: ItemSpec = { id, name, inferred: true, obstruction: 'partial', height: 30 * IN };
  // The things an audience looks at, which a sightline check needs to find.
  if (/\b(screen|stage|podium|lectern|led wall|video wall|monitor|display|plasma|tv)\b/i.test(name)) {
    spec.sightTarget = true;
  }
  if (/\b(chandelier|pendant)\b/i.test(name)) {
    spec.ceilingMounted = true;
    spec.dropFromCeiling = 3 * FT;
  }
  if (/\b(column|pillar|planter)\b/i.test(name)) {
    spec.obstacle = true;
    spec.obstruction = 'full';
  }

  for (const rule of INFERENCE) {
    if (!rule.test.test(name)) continue;
    spec.category = rule.category;
    if (rule.height != null) spec.height = rule.height;
    if (rule.elevation != null) spec.elevation = rule.elevation;
    if (rule.obstruction) spec.obstruction = rule.obstruction;
    if (rule.seats != null) spec.seats = rule.seats;
    if (rule.aspect) spec.aspect = rule.aspect;
    break;
  }

  const seats = inferSeats(name);
  if (seats != null) spec.seats = seats;
  return spec;
}

// ---------------------------------------------------------------------------
// The library
// ---------------------------------------------------------------------------

/** Definitions indexed by normalised name, with inference as the fallback. */
export class SpecLibrary {
  private readonly byName = new Map<string, ItemSpec>();

  constructor(specs: ItemSpec[] = []) {
    for (const spec of specs) this.add(spec);
  }

  add(spec: ItemSpec): void {
    this.byName.set(normaliseName(spec.name), spec);
  }

  /** The definition for a name, inferring one when the library has none. */
  resolve(name: string): ItemSpec {
    return this.byName.get(normaliseName(name)) ?? inferSpec(name);
  }

  /** Only the definitions someone actually entered. */
  known(): ItemSpec[] {
    return [...this.byName.values()].filter((s) => !s.inferred);
  }

  all(): ItemSpec[] {
    return [...this.byName.values()];
  }

  has(name: string): boolean {
    return this.byName.has(normaliseName(name));
  }
}

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

export interface PlacedItem {
  /** Object id within this parse. Not stable across a reopen. */
  nodeId: number;
  /** Stable-across-reopen key, matching the schedule's anchor scheme. */
  key: string;
  name: string;
  /** Insertion point in logical units. */
  x: number;
  y: number;
  /** Rotation in degrees, 0-359. */
  rotation: number;
  /** Footprint measured from the drawn outline, not the cached rect. */
  width: number;
  depth: number;
  spec: ItemSpec;
  /** Underside above finished floor, after overrides. */
  elevation: number;
  /** Top of the item above finished floor, after overrides. */
  top: number;
  obstruction: Obstruction;
  seats: number;
  aspect?: AspectRatio;
  /** True when any value above came from inference rather than a definition. */
  estimated: boolean;
}

const CATALOGUE_NOISE = /^(Arial|Times|Courier|Helvetica|Tahoma|Verdana|Symbol)/i;

/** The catalogue name of a placed shape, ignoring the font names beside it. */
export function shapeName(node: RVNode): string | undefined {
  return node.labels.find((l) => !CATALOGUE_NOISE.test(l));
}

/**
 * Every placement in a plan, paired with its definition.
 *
 * The footprint is measured from the outline rather than read from the cached
 * `CRect`, because that rect goes stale when a table-and-chairs group is
 * duplicated — a plan with 105 chairs has 105 insertion points but only 20
 * distinct rects.
 */
export function resolveInstances(
  doc: RVDocument,
  library: SpecLibrary,
  overrides: InstanceOverride[] = [],
): PlacedItem[] {
  const byKey = new Map(overrides.map((o) => [o.key, o]));
  const out: PlacedItem[] = [];

  for (const node of walk(doc)) {
    if (node.cls !== 'RVShape') continue;
    const name = shapeName(node);
    if (!name) continue;

    const at = node.points[0] ?? {
      x: (node.bounds.left + node.bounds.right) / 2,
      y: (node.bounds.top + node.bounds.bottom) / 2,
    };

    const geometry = node.children.find((c) => c.cls === 'RVGeometry') ?? node;
    const measured = measureNode(geometry);
    const spec = library.resolve(name);
    const override = byKey.get(instanceKey(name, at.x, at.y));

    const elevation = override?.elevation ?? spec.elevation ?? 0;
    const height = override?.height ?? spec.height ?? 0;
    const degrees = node.angle != null ? Math.round((node.angle * 180) / Math.PI) : 0;

    out.push({
      nodeId: node.id,
      key: instanceKey(name, at.x, at.y),
      name,
      x: at.x,
      y: at.y,
      rotation: ((degrees % 360) + 360) % 360,
      width: measured.width || node.bounds.right - node.bounds.left,
      depth: measured.height || node.bounds.bottom - node.bounds.top,
      spec,
      elevation,
      top: elevation + height,
      obstruction: override?.obstruction ?? spec.obstruction ?? 'partial',
      seats: override?.seats ?? spec.seats ?? 0,
      aspect: override?.aspect ?? spec.aspect,
      estimated: spec.inferred === true && !override,
    });
  }

  return out;
}

/**
 * A placement key that survives reopening the file.
 *
 * Deliberately the same scheme the schedule already uses — name plus position
 * to the nearest inch — so definitions, schedule fields and layer assignments
 * all address a placement the same way instead of inventing three identities
 * for one chair.
 */
export function instanceKey(name: string, x: number, y: number): string {
  return `${normaliseName(name)}@${Math.round(x / 10)},${Math.round(y / 10)}`;
}

/** Total seats a plan provides, and how much of that figure is guessed. */
export function seatCount(items: PlacedItem[]): { total: number; estimated: number } {
  let total = 0;
  let estimated = 0;
  for (const item of items) {
    total += item.seats;
    if (item.estimated && item.seats) estimated += item.seats;
  }
  return { total, estimated };
}
