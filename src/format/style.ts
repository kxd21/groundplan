/**
 * One drafting vocabulary, read by both renderers.
 *
 * The canvas and the SVG export used to invent their appearance separately —
 * the canvas in screen pixels, the export in drawing units — so the two never
 * had to agree and did not. Everything either of them draws now resolves
 * through here.
 *
 * **Line weight is a printed thickness, not a size in the room.** The export
 * used to set `stroke-width` in tenths of an inch of real floor, which print
 * then scaled with the drawing: at 1/8in = 1ft every non-wall line came out at
 * 0.38pt and at 1/16in it was 0.19pt, below what most printers put on paper at
 * all. A wall is 1.4pt at every scale, the way a pen is.
 *
 * The grades are the ordinary architectural set. The floor is the thinnest line
 * that reliably prints — 0.13mm — and nothing resolves below it.
 */

import { cableSpec, classifyCable } from './cable.js';
import type { Layer, ScenePrimitive } from './scene.js';

/** Printed points. A point is 1/72in. */
export const GRADE = {
  heavy: 1.4,
  medium: 0.9,
  light: 0.6,
  fine: 0.4,
  hairline: 0.35,
} as const;

export type Grade = keyof typeof GRADE;

/** Nothing prints thinner than this; below it the line stops being a line. */
export const MIN_STROKE_POINTS = 0.35;

export interface DrawingStyle {
  /** Stroke thickness in printed points. */
  strokePoints: number;
  /** Stroke colour as CSS. */
  stroke: string;
  /** Fill colour as CSS, when the object is a solid. */
  fill?: string;
  /** Dash pattern in printed points. Absent means solid. */
  dash?: number[];
  /** Where the appearance came from, so the UI can be honest about it. */
  source: 'imported' | 'class-default' | 'cable';
}

/**
 * Objects whose floor is a solid surface people stand on.
 *
 * Room Viewer fills these; the export drew them hollow because it wrote
 * `fill="none"` on every polygon it emitted, and the canvas because it never
 * called `fill()` at all. Matching on the placed shape's name is what keeps
 * this a rule about staging rather than a special case for one drawing.
 */
const DECK = /\b(stage|riser|deck|platform|rostrum)\b/i;
/** Tiered decks read as elevation when the higher one is darker. */
const DECK_FILL_LOW = '#e6e6e6';
const DECK_FILL_HIGH = '#cfcfcf';
/** A height in the name, e.g. `Stage 42' x 8' x 32"` or `... at 24" Height`. */
const HEIGHT = /(\d+(?:\.\d+)?)\s*"\s*(?:height)?\s*$|x\s*(\d+(?:\.\d+)?)\s*"/i;
/** Decks at or above this read as the upper tier. */
const UPPER_TIER_INCHES = 28;

/**
 * Whether a primitive bounds an area that can be filled.
 *
 * Rectangles arrive typed as polygons, but a synthesized outline is a
 * `RVSegmentPoly` and arrives as a polyline whose last point repeats its first.
 * Testing the geometry rather than the type is what makes a stage built here
 * fill the same as a riser imported from a real plan.
 */
export function enclosesArea(primitive: ScenePrimitive): boolean {
  if (primitive.type === 'polygon') return true;
  if (primitive.type !== 'polyline') return false;
  const n = primitive.pts.length;
  if (n < 8) return false;
  return primitive.pts[0] === primitive.pts[n - 2] && primitive.pts[1] === primitive.pts[n - 1];
}

function css(color: number): string {
  const r = color & 0xff;
  const g = (color >> 8) & 0xff;
  const b = (color >> 16) & 0xff;
  // Near-white ink is invisible on a white sheet. It is almost always a colour
  // chosen to read on the editor's dark canvas, not an instruction to print
  // nothing, so it prints as near-black instead.
  return r > 235 && g > 235 && b > 235 ? '#2b2b2b' : `rgb(${r},${g},${b})`;
}

function gradeFor(primitive: ScenePrimitive): Grade {
  if (primitive.layer === 'walls') return 'heavy';
  if (primitive.type === 'dimension' || primitive.cls === 'RVDimensionLine') return 'fine';
  if (primitive.owner && DECK.test(primitive.owner)) return 'medium';
  if (primitive.layer === 'furniture') return 'light';
  if (primitive.layer === 'region') return 'fine';
  return 'fine';
}

function deckFill(owner: string): string {
  const match = HEIGHT.exec(owner);
  const inches = Number(match?.[1] ?? match?.[2] ?? 0);
  return inches >= UPPER_TIER_INCHES ? DECK_FILL_HIGH : DECK_FILL_LOW;
}

/**
 * The appearance of one primitive.
 *
 * `source` is always `class-default` today: the pen and brush block the file
 * carries at bytes +26..+54 is not decoded yet, so there is no imported value
 * to prefer. The field exists so that when it is decoded, a value read from the
 * file can take precedence and be told apart from one this invented.
 */
/** Names that mean "this is a cable run", not a piece of equipment. */
const CABLE_RUN = /\b(run|cable|feeder|snake|soca|dmx|sdi|fib(re|er)|xlr|cat ?[56]|drop)\b/i;

export function resolveStyle(primitive: ScenePrimitive): DrawingStyle {
  const grade = gradeFor(primitive);
  const style: DrawingStyle = {
    strokePoints: Math.max(MIN_STROKE_POINTS, GRADE[grade]),
    stroke: css(primitive.color),
    source: 'class-default',
  };

  // A closed outline belonging to a deck is a surface, so it is filled.
  if (primitive.owner && DECK.test(primitive.owner) && enclosesArea(primitive)) {
    style.fill = deckFill(primitive.owner);
  }

  /*
   * A cable run reads as its own kind of line.
   *
   * Every run used to draw identically, so a fibre and a soca were the same
   * mark and the drawing could not answer the question anybody actually asks
   * of it. The conventions live in `cable.ts` next to the schedule that totals
   * them, so the line and the order sheet cannot drift apart.
   */
  if (primitive.owner && CABLE_RUN.test(primitive.owner) && !enclosesArea(primitive)) {
    const spec = cableSpec(classifyCable(primitive.owner));
    style.stroke = spec.stroke;
    style.strokePoints = Math.max(MIN_STROKE_POINTS, spec.strokePoints);
    if (spec.dash) style.dash = spec.dash;
    style.source = 'cable';
  }

  return style;
}

/**
 * Converts a printed thickness into drawing units for the SVG export.
 *
 * The export's viewBox is in tenths of an inch, and print sizes the sheet so
 * one foot of room becomes `inchesPerFoot` inches of paper. A point is 1/72in,
 * so a point of paper is `(1/72) / (inchesPerFoot/120)` units.
 */
export function pointsToUnits(points: number, inchesPerFoot: number): number {
  if (!(inchesPerFoot > 0)) return points * 4;
  return (points / 72) * (120 / inchesPerFoot);
}

/** Layers that are drawn behind everything else, so fills never bury outlines. */
export const FILL_FIRST: Layer[] = ['walls', 'region', 'other', 'furniture', 'annotation'];

/**
 * Drawing scales, as inches of paper per foot of room.
 *
 * "Fit to page" has no fixed scale, so pen weights are resolved as if it were
 * 1/8in — the common working scale — rather than left to vary with the sheet.
 */
export const SCALE_INCHES_PER_FOOT: Record<string, number> = {
  '1/16': 1 / 16,
  '3/32': 3 / 32,
  '1/8': 1 / 8,
  '3/16': 3 / 16,
  '1/4': 1 / 4,
  fit: 1 / 8,
};

/**
 * Printable sheet sizes in inches, portrait.
 *
 * Declared here rather than in the print service because the SVG exporter has
 * to size its strokes for the sheet the drawing will land on, and the exporter
 * runs in the renderer, which cannot import from `src/main`.
 */
export const PAPER_SIZES: Record<string, { width: number; height: number }> = {
  Letter: { width: 8.5, height: 11 },
  Legal: { width: 8.5, height: 14 },
  Tabloid: { width: 11, height: 17 },
  A4: { width: 8.27, height: 11.69 },
  A3: { width: 11.69, height: 16.54 },
};

/** Sheet margin, in inches. Matches `MARGIN` in the print service. */
export const SHEET_MARGIN = 0.4;

/** Height reserved for the title block, in inches. Matches the print service. */
export const SHEET_TITLE_BLOCK = 0.85;

/** The drawing frame left on a sheet once margins and title block are taken. */
export function sheetFrame(
  paperId: string,
  landscape: boolean,
): { width: number; height: number } {
  const paper = PAPER_SIZES[paperId] ?? PAPER_SIZES.Letter!;
  const pageWidth = landscape ? paper.height : paper.width;
  const pageHeight = landscape ? paper.width : paper.height;
  return {
    width: Math.max(1, pageWidth - SHEET_MARGIN * 2 - 0.2),
    height: Math.max(1, pageHeight - SHEET_MARGIN * 2 - SHEET_TITLE_BLOCK - 0.2),
  };
}

/**
 * The scale a "Fit to page" drawing actually ends up at.
 *
 * "Fit" is not a scale, it is an outcome, and the drawing arrives at whatever
 * scale makes it fit the frame. Sizing strokes for a nominal 1/8in per foot and
 * then letting the sheet shrink the result is why a large room printed as
 * hairlines: a 245ft ballroom on Letter lands near 1/30in per foot, so every
 * line had been drawn for a sheet roughly four times the size of the one it
 * went onto. Given the drawing extent and the frame, this returns the scale the
 * drawing will really be read at, so the weights can be built for that.
 */
export function fitInchesPerFoot(
  extentUnits: { width: number; height: number },
  frameInches: { width: number; height: number },
): number {
  const widthFeet = extentUnits.width / 120;
  const heightFeet = extentUnits.height / 120;
  if (!(widthFeet > 0) || !(heightFeet > 0)) return SCALE_INCHES_PER_FOOT['1/8']!;
  return Math.min(frameInches.width / widthFeet, frameInches.height / heightFeet);
}

/** Printed height of annotation text, in points (3/32in). */
export const TEXT_POINTS = 6.75;
