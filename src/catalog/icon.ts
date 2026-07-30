/**
 * Turning a symbol drawn in a real plan into a publishable icon.
 *
 * An icon for a projector is not proprietary — it is a projector-shaped
 * outline, and everyone benefits from having the same one. A *schematic* is a
 * different thing: the room, the seating, the labels, the client whose show it
 * was. The two live in the same file, so extracting one without the other has
 * to be deliberate rather than assumed.
 *
 * What is kept: closed and open outlines belonging to one instance of the
 * shape, translated so the insertion point is the origin and rotated back to
 * zero.
 *
 * What is dropped, unconditionally:
 *
 *   - every text primitive — labels are where show and client names live
 *   - everything on the annotation layer — dimensions, notes, callouts
 *   - everything belonging to any other object in the drawing
 *   - the source file path, the room, and the plan's own extent
 *
 * `sanitiseIcon` is the only supported way to produce a publishable icon, and
 * `containsNoText` exists so the publishing pipeline can assert the property
 * rather than trust it.
 */

import type { Scene, ScenePrimitive } from '../format/scene.js';
import type { SymbolPath } from './symbols.js';

export interface CatalogIcon {
  /** Outlines, centred on the insertion point, in logical units. */
  paths: SymbolPath[];
  width: number;
  height: number;
}

export interface SanitiseResult {
  icon?: CatalogIcon;
  /** Primitives left out, so the publisher can report what was stripped. */
  droppedText: number;
  droppedAnnotation: number;
  reason?: string;
}

/**
 * Extracts one instance of a named shape as a publishable icon.
 *
 * The most detailed instance is used: copies near a room edge are often
 * clipped, and a partial outline would be published for everyone.
 */
export function sanitiseIcon(scene: Scene, name: string, insertion?: { x: number; y: number }): SanitiseResult {
  const want = name.trim().toLowerCase();
  const groups = new Map<number, ScenePrimitive[]>();
  let droppedText = 0;
  let droppedAnnotation = 0;

  for (const primitive of scene.primitives) {
    if ((primitive.owner ?? '').trim().toLowerCase() !== want) continue;

    // Both of these are how a client name reaches a published file. The layer
    // is checked first so a dimension — which carries text *and* sits on the
    // annotation layer — is reported as the annotation it is, rather than as a
    // stray label.
    if (primitive.layer === 'annotation') {
      droppedAnnotation++;
      continue;
    }
    if (primitive.text) {
      droppedText++;
      continue;
    }

    const group = groups.get(primitive.selectId);
    if (group) group.push(primitive);
    else groups.set(primitive.selectId, [primitive]);
  }

  let best: ScenePrimitive[] = [];
  for (const group of groups.values()) {
    const points = group.reduce((n, p) => n + p.pts.length, 0);
    if (points > best.reduce((n, p) => n + p.pts.length, 0)) best = group;
  }

  if (best.length === 0) {
    return { droppedText, droppedAnnotation, reason: `no drawable geometry named "${name}"` };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const primitive of best) {
    for (let i = 0; i < primitive.pts.length; i += 2) {
      const x = primitive.pts[i];
      const y = primitive.pts[i + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (!Number.isFinite(minX)) {
    return { droppedText, droppedAnnotation, reason: 'the geometry has no finite extent' };
  }

  // Centre on the insertion point where one is known, so the icon places where
  // it is dropped; otherwise centre on the outline's own middle.
  const originX = insertion?.x ?? (minX + maxX) / 2;
  const originY = insertion?.y ?? (minY + maxY) / 2;

  // A tenth of a logical unit is a hundredth of an inch — finer than anything
  // that was ever drawn, and it keeps binary float noise like 307055220264374
  // out of a file thousands of people download.
  const round = (n: number): number => Math.round(n * 10) / 10;

  const paths: SymbolPath[] = [];
  for (const primitive of best) {
    const points: number[] = [];
    for (let i = 0; i < primitive.pts.length; i += 2) {
      points.push(round(primitive.pts[i] - originX), round(primitive.pts[i + 1] - originY));
    }
    if (points.length >= 4) paths.push({ points, closed: primitive.type === 'polygon' });
  }

  if (paths.length === 0) {
    return { droppedText, droppedAnnotation, reason: 'nothing left after sanitising' };
  }

  return {
    icon: { paths, width: round(maxX - minX), height: round(maxY - minY) },
    droppedText,
    droppedAnnotation,
  };
}

/**
 * Asserts that an icon carries no text of any kind.
 *
 * An icon is numbers and nothing else, so any string anywhere in the structure
 * means something leaked. Cheap enough to run over every icon in a release, and
 * the publishing pipeline does exactly that.
 */
export function containsNoText(icon: CatalogIcon): boolean {
  for (const path of icon.paths) {
    if (typeof path.closed !== 'boolean') return false;
    for (const value of path.points) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    }
  }
  return true;
}

/**
 * A last check before an icon is published.
 *
 * Rejects the shapes that are not really product icons: an outline the size of
 * a room is a wall or a seating block that happened to share a name, and
 * publishing it would put a piece of somebody's floor plan in the catalog.
 */
export function isPublishable(icon: CatalogIcon): { ok: boolean; reason?: string } {
  const FOOT = 120;
  if (!containsNoText(icon)) return { ok: false, reason: 'the icon contains non-numeric data' };
  if (icon.paths.length === 0) return { ok: false, reason: 'the icon has no outlines' };
  if (icon.width <= 0 || icon.height <= 0) return { ok: false, reason: 'the icon has no size' };
  if (icon.width > 40 * FOOT || icon.height > 40 * FOOT) {
    return { ok: false, reason: 'the outline is room-sized, so it is probably not a product' };
  }
  const points = icon.paths.reduce((n, p) => n + p.points.length / 2, 0);
  if (points > 4000) {
    return { ok: false, reason: 'the outline has too much detail to be a single product' };
  }
  return { ok: true };
}

/**
 * Screens a symbol's name before it is published.
 *
 * The line is between the technology and the client. `Barco LC w/1.2 Lens`,
 * `DLP 15SX - 2.0` and `6' x 30"` all describe equipment and should be shared
 * exactly as they are — that identity is the useful part, and stripping it
 * would leave a catalog of anonymous boxes. `BofA Podium` or
 * `Grand Ballroom Riser` names a customer or a venue and must not be.
 *
 * A survey of 400 real plans found 83 distinct symbol names and not one client
 * reference, because these names come from the stock shape catalogue rather
 * than from anything typed for a particular show. So this gate is expected to
 * pass nearly everything; it exists for the custom symbol somebody names after
 * the job they drew it for.
 *
 * Suspect names are flagged for a person to look at, never silently rewritten.
 * Quietly renaming someone's equipment would be its own kind of wrong.
 */
export interface NameScreen {
  safe: boolean;
  reasons: string[];
}

/** Places, organisations and event language — never part of a product name. */
const CLIENT_MARKERS: Array<[RegExp, string]> = [
  [/\b(ballroom|salon|foyer|atrium|pavilion|arena|amphitheat|auditorium)\b/i, 'names a venue space'],
  [/\b(convention|conference cent|hotel|marriott|hilton|hyatt|sheraton|westin|omni|ritz)\b/i, 'names a venue'],
  [/\b(inc\.?|llc|ltd|corp\.?|company|partners|holdings|bank|financial|pharma|airlines)\b/i, 'names an organisation'],
  [/\bbofa\b|\bbank of\b/i, 'names a client'],
  [/\b(19|20)\d{2}\b/, 'carries a year, which usually means one specific show'],
  [/\b(gala|keynote|general session|breakout|awards|kickoff|summit|expo|roadshow)\b/i, 'names an event'],
  [/\b(room|rm)\s*\d+\b/i, 'names a specific room'],
  [/\w's\b/, 'possessive, which usually names a customer'],
];

/** Vocabulary that makes a name clearly about equipment rather than a job. */
const TECHNOLOGY = new RegExp(
  [
    // A dimension pair, e.g. 6' x 30", 18"x18", 4'x4'.
    String.raw`\d+\s*['"′″]?\s*[x×]\s*\d+`,
    String.raw`\b(barco|christie|panasonic|sanyo|epson|nec|sony|dlp|lcd|led|laser|xenon)\b`,
    String.raw`\b(martin|mac|glp|chauvet|etc|elation|robe|solaspot|solaframe|source ?four|leko|par|fresnel)\b`,
    String.raw`\b(shure|sennheiser|yamaha|midas|qsc|jbl|meyer|acoustics)\b`,
    String.raw`\b(chair|table|round|serpentine|square|family|riser|deck|stage|step|truss|scaffold|screen|fastfold)\b`,
    String.raw`\b(projector|monitor|plasma|display|camera|speaker|sub|mixer|console|microphone|mic|lectern|podium)\b`,
    String.raw`\b(door|window|wall|column|post|drape|pipe|light|borderlight|tree|lift|genie|ladder|plant|piano)\b`,
    String.raw`\b(technician|operator|dance ?floor|buffet|bar|stool|bench|counter|cart|rack|case|tent|planter)\b`,
    // Added after a survey flagged these real, entirely generic shapes.
    String.raw`\b(steps?|stairs?|control|dimmer|amp|rigging|motor|hoist|chain|shell|skirt|valance)\b`,
  ].join('|'),
  'i',
);

export function screenIconName(name: string): NameScreen {
  const trimmed = name.trim();
  if (!trimmed) return { safe: false, reasons: ['the name is empty'] };

  const reasons: string[] = [];
  for (const [pattern, reason] of CLIENT_MARKERS) {
    if (pattern.test(trimmed)) reasons.push(reason);
  }

  // A name with no recognisable equipment vocabulary is not necessarily a leak,
  // but it is the shape a one-off custom symbol has, so it gets attention.
  if (reasons.length === 0 && !TECHNOLOGY.test(trimmed)) {
    reasons.push('no recognisable equipment vocabulary — check it is not job-specific');
  }

  return { safe: reasons.length === 0, reasons };
}


/** Plain names to fall back to when nothing publishable survives a strip. */
const GENERIC_BY_CATEGORY: Record<string, string> = {
  projector: 'Projector',
  screen: 'Projection Screen',
  'flat-panel': 'Flat Panel Display',
  camera: 'Camera',
  'moving-light': 'Moving Light',
  'par-light': 'PAR Fixture',
  ellipsoidal: 'Ellipsoidal Fixture',
  'light-batten': 'LED Batten',
  'light-tree': 'Light Tree',
  'lighting-console': 'Lighting Console',
  speaker: 'Loudspeaker',
  subwoofer: 'Subwoofer',
  mixer: 'Mixing Console',
  podium: 'Podium',
  riser: 'Riser',
  stairs: 'Steps',
  truss: 'Truss',
  'truss-base': 'Truss Base',
  drape: 'Drape',
  'drape-upright': 'Drape Upright',
  lift: 'Lift',
  ladder: 'Ladder',
  'table-round': 'Round Table',
  'table-rect': 'Banquet Table',
  chair: 'Chair',
  desk: 'Counter',
  person: 'Crew Position',
};

export interface GenericName {
  name: string;
  /** True when anything was removed, so the change can be shown to the user. */
  changed: boolean;
  removed: string[];
}

/**
 * Rewrites a name so it describes the equipment and nothing else.
 *
 * Reviewing flagged names by hand does not scale — a queue nobody works is
 * worse than no queue, because it looks like a safeguard while doing nothing.
 * So anything tying a symbol to a customer, a venue, a room or a date is
 * removed automatically, and what remains describes the technology:
 *
 *     "BofA Podium"           -> "Podium"
 *     "Grand Ballroom Riser"  -> "Riser"
 *     "Card Party 2026 Stage" -> "Stage"
 *     "Barco LC w/1.2 Lens"   -> unchanged
 *
 * Where stripping leaves nothing useful, the category's plain name is used, so
 * the result is always readable. Names stay editable in the inventory palette
 * afterwards: this decides the starting point, not the final answer.
 */
export function genericiseName(name: string, category?: string): GenericName {
  const original = name.trim().replace(/\s+/g, ' ');

  // An empty name is not "safe", it is missing. Falling through would publish a
  // nameless product.
  if (!original) {
    return {
      name: (category && GENERIC_BY_CATEGORY[category]) || 'Equipment',
      changed: true,
      removed: ['the name was empty'],
    };
  }

  const removed: string[] = [];
  for (const [pattern, reason] of CLIENT_MARKERS) {
    if (pattern.test(original)) removed.push(reason);
  }
  if (removed.length === 0) return { name: original, changed: false, removed: [] };

  // Rebuilt from an allowlist rather than by deleting the parts that looked
  // wrong. Deleting leaves whatever it failed to recognise, so "Card Party 2026
  // Stage" kept the client and became "Card Party Stage". Keeping only words
  // that are known equipment vocabulary cannot do that: anything unrecognised
  // is dropped by default, which is the correct bias for a privacy control.
  const tokens = original.split(/\s+/);
  const bareOf = (t: string): string => t.replace(/^[^\w'"′″]+|[^\w'"′″]+$/g, '');

  const kept = tokens
    .filter((token, i) => {
      const bare = bareOf(token);
      if (!bare) return false;

      // A dimension describes the product, so it stays — but only when it is
      // actually a dimension. A bare integer is just as likely to be a year or
      // a room number, which is how "Card Party 2026 Stage" kept its year and
      // "Room 402 Chair" kept its room.
      if (/^[x×]$/i.test(bare)) return true;
      if (/\d+\s*['"′″]\s*[x×]?\s*\d*/.test(bare) && /['"′″]/.test(bare)) return true;
      if (/^\d+(\.\d+)?$/.test(bare)) {
        const neighbours = [bareOf(tokens[i - 1] ?? ''), bareOf(tokens[i + 1] ?? '')];
        return neighbours.some((n) => /^[x×]$/i.test(n));
      }

      return TECHNOLOGY.test(bare);
    })
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (kept.length >= 3 && TECHNOLOGY.test(kept)) {
    return { name: kept, changed: kept !== original, removed };
  }

  const fallback = (category && GENERIC_BY_CATEGORY[category]) || 'Equipment';
  return { name: fallback, changed: true, removed };
}
