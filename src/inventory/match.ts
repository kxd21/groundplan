/**
 * Choosing a drawn symbol for a piece of gear.
 *
 * `classify.ts` says what an item is; this says what to draw for it. The two
 * are separate because the categories are stable while the available symbols
 * are whatever happens to have been harvested out of this shop's own plans —
 * one company's library has a `Mac 600`, another's has a `Sola Spot`, and both
 * should serve as "the moving light".
 *
 * Preferences are ordered, and the first one actually present wins. Where the
 * description carries a size, the closest symbol of the right kind is used
 * instead of the first — a 4'x8' deck should not place as an 8'x4' one.
 */

import type { Category } from './classify.js';
import { classify } from './classify.js';
import { normaliseName, type Inventory, type InventoryItem } from './model.js';

/**
 * Symbol names to look for, best first.
 *
 * Matching is loose (case-insensitive substring both ways) because the same
 * shape is called `Plasma - 50"` in one plan and `Plasma 50 on Stand` in
 * another.
 */
const PREFERENCES: Record<Category, string[]> = {
  // Generic first: a Panasonic drawn as a "Barco LC" is a lie a reader would
  // believe. Fall back to a named model only when no generic symbol exists.
  projector: ['LCD Projector', 'Xenon Projector', 'DLP', 'Projector', 'Barco LC', 'Sanyo'],
  screen: ['Fastfold', 'Screen'],
  'flat-panel': ['Plasma', 'Monitor', 'TV'],
  camera: ['Video Camera', 'Camera'],
  'moving-light': ['Mac 600', 'Moving', 'Sola'],
  'par-light': ['Source 4 Par', 'Par', 'Light'],
  ellipsoidal: ['Leko Light', 'Leko', 'Source 4', 'Ellipsoidal'],
  'light-batten': ['Batten', 'Strip', 'Source 4 Par'],
  'light-tree': ['Light Tree', 'Tree'],
  'lighting-console': ['Lighting Control', 'Console'],
  speaker: ['Speaker - Single', 'Speaker'],
  subwoofer: ['Sub', 'Speaker - Single', 'Speaker'],
  mixer: ['Mixer', 'Console'],
  podium: ['Podium/Lectern', 'Podium', 'Lectern'],
  riser: ['Riser'],
  stairs: ['Steps', 'Stairs'],
  truss: ['Box Truss', 'Truss'],
  'truss-base': ['Base Plate', 'Post'],
  drape: ['Pipe and Drape', 'Drape'],
  'drape-upright': ['Post', 'Upright'],
  lift: ['Genie Lift', 'Lift'],
  ladder: ['Genie Lift', 'Post'],
  'table-round': ['Round'],
  'table-rect': ['6\' x 30"', '8\' x 30"', 'Family', 'Table'],
  chair: ['Standard 18"x18"', 'Chair'],
  desk: ['Bar', '6\' x 30"', 'Table'],
  person: ['Technician'],
  door: ['Door - Double', 'Door - Single', 'Door', 'Opening'],
  'not-drawn': [],
};

export interface SymbolChoice {
  /** The library item holding the drawn geometry. */
  symbolName: string;
  symbolPath: string;
  category: Category;
  reason: string;
}

/**
 * Items that carry real drawn geometry, which are the only candidates.
 *
 * Automatic matches are excluded: they borrow someone else's shape, so
 * offering them as sources would let a guess become the basis for the next
 * guess.
 */
function symbolsOf(inventory: Inventory): InventoryItem[] {
  return inventory.items.filter((i) => i.symbolPath && i.width && i.height && i.mappedBy !== 'auto');
}

/**
 * Whether a symbol's name answers to what we are looking for.
 *
 * Matched on whole words, not raw substrings: `Bar` must not claim
 * `Barco LC w/1.2 Lens`, or a registration desk gets drawn as a projector.
 * Word-level containment still lets `Plasma` find `Plasma - 50" on Stand`.
 */
function relates(candidate: string, want: string): boolean {
  const words = (text: string): string[] =>
    normaliseName(text)
      .split(/[^a-z0-9."']+/)
      .filter(Boolean);

  const a = words(candidate);
  const b = words(want);
  if (a.length === 0 || b.length === 0) return false;

  // Every word of the shorter side must appear as a whole word in the longer.
  const [needle, haystack] = a.length <= b.length ? [a, b] : [b, a];
  return needle.every((w) => haystack.includes(w));
}

/**
 * Picks the closest symbol by footprint.
 *
 * Compared on the log of each side so a 4'x8' deck prefers a 4'x8' symbol over
 * an 8'x16' one by the same ratio it prefers it over 2'x4' — proportional
 * error, not absolute, which is what "closest size" means across items whose
 * scales differ by an order of magnitude.
 */
function nearestBySize(
  candidates: InventoryItem[],
  width: number,
  height: number,
): InventoryItem | null {
  let best: InventoryItem | null = null;
  let bestError = Infinity;
  for (const candidate of candidates) {
    if (!candidate.width || !candidate.height) continue;
    // Either orientation is acceptable; the shape can be rotated once placed.
    const direct =
      Math.abs(Math.log(candidate.width / width)) + Math.abs(Math.log(candidate.height / height));
    const turned =
      Math.abs(Math.log(candidate.height / width)) + Math.abs(Math.log(candidate.width / height));
    const error = Math.min(direct, turned);
    if (error < bestError) {
      bestError = error;
      best = candidate;
    }
  }
  return best;
}

/** Finds the symbol to draw for one gear description, or null if none fits. */
export function chooseSymbol(
  inventory: Inventory,
  description: string,
  candidates?: InventoryItem[],
): SymbolChoice | null {
  const verdict = classify(description);
  if (verdict.category === 'not-drawn') return null;

  const wanted = PREFERENCES[verdict.category];
  const symbols = candidates ?? symbolsOf(inventory);

  for (const want of wanted) {
    const matches = symbols.filter((s) => relates(s.name, want));
    if (matches.length === 0) continue;

    const pick =
      verdict.width && verdict.height
        ? (nearestBySize(matches, verdict.width, verdict.height) ?? matches[0])
        : // Otherwise the one this shop draws most often is the safest default.
          matches.sort((a, b) => b.timesSeen - a.timesSeen)[0];

    if (!pick?.symbolPath) continue;
    return {
      // Prefer the label inside the .rv4 when the inventory row was renamed.
      symbolName: pick.symbolName ?? pick.name,
      symbolPath: pick.symbolPath,
      category: verdict.category,
      reason: verdict.reason,
    };
  }

  return null;
}

export interface MapSummary {
  mapped: number;
  alreadyHad: number;
  noSymbol: number;
  notDrawn: number;
  /** A sample of what was decided, for showing the user. */
  examples: Array<{ item: string; symbol: string; reason: string }>;
}

/**
 * Maps every unshaped item in the inventory to a drawn symbol.
 *
 * Items that already carry their own geometry are left alone — a harvested
 * symbol is always better than a guess — and so is anything the user has
 * mapped by hand.
 */
export function mapSymbols(inventory: Inventory): MapSummary {
  const summary: MapSummary = {
    mapped: 0,
    alreadyHad: 0,
    noSymbol: 0,
    notDrawn: 0,
    examples: [],
  };

  // Fixed for the whole run, so the order items happen to sit in cannot change
  // what any one of them maps to.
  const candidates = symbolsOf(inventory);

  for (const item of inventory.items) {
    if (item.symbolPath) {
      summary.alreadyHad++;
      continue;
    }
    // A hand-traced or photo outline is already placeable — don't overwrite it
    // with an automatic catalogue guess.
    if (item.tracedIcon?.paths?.length) {
      summary.alreadyHad++;
      continue;
    }

    const choice = chooseSymbol(inventory, item.name, candidates);
    if (!choice) {
      if (classify(item.name).category === 'not-drawn') summary.notDrawn++;
      else summary.noSymbol++;
      continue;
    }

    item.symbolPath = choice.symbolPath;
    item.symbolName = choice.symbolName;
    item.mappedBy = 'auto';
    item.mapReason = choice.reason;
    summary.mapped++;
    if (summary.examples.length < 12) {
      summary.examples.push({ item: item.name, symbol: choice.symbolName, reason: choice.reason });
    }
  }

  return summary;
}
