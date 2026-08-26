/**
 * Placing gear onto a plan.
 *
 * A gear list is a list of things that will be in the room, so each line should
 * be droppable onto the diagram. Two routes get it there:
 *
 *   1. **Match.** If the plan already contains a shape with that name — a
 *      "Round 60"", a "Pipe and Drape" — place a copy of the real thing. The
 *      result is indistinguishable from one placed in Room Viewer.
 *   2. **Synthesize.** Otherwise build a labelled box at the right size, taken
 *      from dimensions in the description ("4' x 8' Stage Deck", "65\" TV").
 *   3. **Traced icon.** An inventory item that carries its own outline (from a
 *      datasheet trace or the starter catalog) becomes a real placed shape via
 *      `createShape`, so a blank plan still gets the silhouette rather than a
 *      generic box.
 *
 * Cloning is preferred: a copy of a shape already in the file keeps the pen and
 * brush blocks — which this project only partly decodes — byte-valid, and comes
 * from this drawing rather than from a default. Where the plan has no shape at
 * all to copy, which is exactly the case for a plan that has just been created,
 * the box is built from scratch instead.
 */

import type { Point, RVDocument, RVNode } from './rv.js';
import { UNITS_PER_FOOT, UNITS_PER_INCH } from './rv.js';
import { addRoot, appendChild, duplicateNode, moveNode, type DocumentIndex, type EditResult } from './edit.js';
import { boxOutline, circleOutline, createShape, quarterCircleOutline } from './synthesize.js';
import { libraryOutline, readLibrary } from './library.js';
import { planBody } from './plan-skeleton.js';

/** Flat catalog/trace path list → outline runs for `createShape`. */
export function outlineFromTracedPaths(
  paths: Array<{ points: number[]; closed: boolean }>,
): Point[][] {
  const outline: Point[][] = [];
  for (const path of paths) {
    const run: Point[] = [];
    for (let i = 0; i + 1 < path.points.length; i += 2) {
      run.push({ x: path.points[i], y: path.points[i + 1] });
    }
    if (run.length < 2) continue;
    if (path.closed) {
      const first = run[0];
      const last = run[run.length - 1];
      if (first.x !== last.x || first.y !== last.y) run.push({ x: first.x, y: first.y });
    }
    outline.push(run);
  }
  return outline;
}

/** Default footprint when a description carries no dimensions: 2ft x 2ft. */
const DEFAULT_SIZE = 2 * UNITS_PER_FOOT;
const MIN_SIZE = UNITS_PER_INCH * 3;
const MAX_SIZE = 200 * UNITS_PER_FOOT;

export interface Dimensions {
  width: number;
  height: number;
  /** How the size was arrived at, for the UI to be honest about guesses. */
  source: 'parsed' | 'default';
}

/**
 * Reads a footprint out of a gear description.
 *
 * Handles the notations these lists actually use: `4' x 8'`, `11'X20'`,
 * `20.5" x 8'`, `6' x 30"`, `16' x 14.5'`, and a single measurement like
 * `65" Samsung Standard TV` or `12' Ladder`, which becomes a square.
 */
export function parseDimensions(description: string): Dimensions {
  const value = (n: string, unit: string) =>
    unit === '"' ? Number(n) * UNITS_PER_INCH : Number(n) * UNITS_PER_FOOT;

  const pair = description.match(/(\d+(?:\.\d+)?)\s*(['"])\s*[xX×]\s*(\d+(?:\.\d+)?)\s*(['"])/);
  if (pair) {
    const width = value(pair[1], pair[2]);
    const height = value(pair[3], pair[4]);
    if (width >= MIN_SIZE && height >= MIN_SIZE && width <= MAX_SIZE && height <= MAX_SIZE) {
      return { width, height, source: 'parsed' };
    }
  }

  // `4 x 8` with the unit stated once, e.g. `Stage Deck 4 x 8'`.
  const loose = description.match(/(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)\s*(['"])/);
  if (loose) {
    const width = value(loose[1], loose[3]);
    const height = value(loose[2], loose[3]);
    if (width >= MIN_SIZE && height >= MIN_SIZE && width <= MAX_SIZE && height <= MAX_SIZE) {
      return { width, height, source: 'parsed' };
    }
  }

  const single = description.match(/(\d+(?:\.\d+)?)\s*(['"])/);
  if (single) {
    const size = value(single[1], single[2]);
    // A lone measurement is usually a length, not a footprint. Cables and
    // jumpers are the common case and should not become room-sized boxes.
    if (size >= MIN_SIZE && size <= 12 * UNITS_PER_FOOT && !/\b(cable|jumper|xlr|sdi|hdmi|cat\s*6|dmx|soca|edison|feeder)\b/i.test(description)) {
      return { width: size, height: size, source: 'parsed' };
    }
  }

  return { width: DEFAULT_SIZE, height: DEFAULT_SIZE, source: 'default' };
}

/** Normalises a name for matching: case, quotes and spacing all vary. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[”“]/g, '"')
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Finds a shape in the plan whose catalogue name matches a gear description. */
export function findMatchingShape(doc: RVDocument, description: string): RVNode | null {
  const want = normalise(description);
  let best: { node: RVNode; score: number } | null = null;

  const visit = (node: RVNode, seen: Set<RVNode>) => {
    if (seen.has(node)) return;
    seen.add(node);

    if (node.cls === 'RVShape' && node.fields.nameAt != null) {
      const name = normalise(node.labels.find((l) => !/^(Arial|Times|Courier|Helvetica)/i.test(l)) ?? '');
      if (name) {
        let score = 0;
        if (name === want) score = 3;
        else if (want.includes(name) || name.includes(want)) score = 2;
        if (score && (!best || score > best.score)) best = { node, score };
      }
    }
    for (const child of node.children) visit(child, seen);
  };

  const seen = new Set<RVNode>();
  for (const root of doc.roots) visit(root, seen);
  return best ? (best as { node: RVNode }).node : null;
}

/** A shape suitable for cloning: one geometry holding a four-point rectangle. */
function findTemplateShape(doc: RVDocument): RVNode | null {
  let fallback: RVNode | null = null;
  const seen = new Set<RVNode>();

  const visit = (node: RVNode): RVNode | null => {
    if (seen.has(node)) return null;
    seen.add(node);

    if (node.cls === 'RVShape' && node.fields.placementAt != null && node.fields.nameAt != null) {
      const geometry = node.children.find((c) => c.cls === 'RVGeometry');
      if (geometry) {
        const rect = geometry.children.find(
          (c) => c.cls === 'RVSegmentRect' && c.fields.pointsAt != null && c.fields.pointCount === 4,
        );
        if (rect && geometry.children.length === 1) return node;
        if (rect && !fallback) fallback = node;
      }
    }
    for (const child of node.children) {
      const found = visit(child);
      if (found) return found;
    }
    return null;
  };

  for (const root of doc.roots) {
    const found = visit(root);
    if (found) return found;
  }
  return fallback;
}

function writeBounds(doc: RVDocument, node: RVNode, left: number, top: number, right: number, bottom: number): void {
  if (node.fields.boundsAt == null) return;
  if (!node.headerOverride) {
    node.headerOverride = Buffer.from(doc.source.subarray(node.span.bodyAt, node.span.headerEnd));
  }
  const at = node.fields.boundsAt - node.span.bodyAt;
  if (at < 0 || at + 16 > node.headerOverride.length) return;
  node.headerOverride.writeInt32LE(Math.round(left), at);
  node.headerOverride.writeInt32LE(Math.round(top), at + 4);
  node.headerOverride.writeInt32LE(Math.round(right), at + 8);
  node.headerOverride.writeInt32LE(Math.round(bottom), at + 12);
  node.bounds = { left: Math.round(left), top: Math.round(top), right: Math.round(right), bottom: Math.round(bottom) };
}

/** Rewrites a placed shape's catalogue name, resizing the header as needed. */
function renameShape(doc: RVDocument, node: RVNode, name: string): boolean {
  if (node.fields.nameAt == null) return false;
  if (!node.headerOverride) {
    node.headerOverride = Buffer.from(doc.source.subarray(node.span.bodyAt, node.span.headerEnd));
  }

  const header = node.headerOverride;
  const at = node.fields.nameAt - node.span.bodyAt;
  const oldLen = header[at];
  if (at < 0 || at + 1 + oldLen > header.length) return false;

  const encoded = Buffer.from(name.slice(0, 254), 'latin1');
  node.headerOverride = Buffer.concat([
    header.subarray(0, at),
    Buffer.from([encoded.length]),
    encoded,
    header.subarray(at + 1 + oldLen),
  ]);
  node.fields.nameLen = encoded.length;
  node.labels = [name];
  return true;
}

/** Overwrites a four-point rectangle segment with a new centred footprint. */
function resizeRect(doc: RVDocument, segment: RVNode, width: number, height: number): boolean {
  if (segment.fields.pointsAt == null || segment.fields.pointCount !== 4) return false;
  if (!segment.headerOverride) {
    segment.headerOverride = Buffer.from(doc.source.subarray(segment.span.bodyAt, segment.span.headerEnd));
  }

  const header = segment.headerOverride;
  const at = segment.fields.pointsAt - segment.span.bodyAt;
  if (at < 0 || at + 64 > header.length) return false;

  const hw = width / 2;
  const hh = height / 2;
  const corners = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ];
  corners.forEach(([x, y], i) => {
    header.writeDoubleLE(x, at + i * 16);
    header.writeDoubleLE(y, at + i * 16 + 8);
  });
  segment.points = corners.map(([x, y]) => ({ x, y }));
  return true;
}

export interface PlaceResult extends EditResult {
  /** How the placed object was produced. */
  method?: 'matched' | 'library' | 'symbol' | 'traced' | 'synthesized' | 'box';
  size?: Dimensions;
}

/**
 * Places a gear item on the plan at a point, in logical units.
 *
 * Returns which route was taken so the UI can say whether the footprint is the
 * real catalogue shape or a box sized from the description.
 */
export function placeGear(
  doc: RVDocument,
  index: DocumentIndex,
  description: string,
  x: number,
  y: number,
  /** Footprint from the equipment inventory, which beats guessing. */
  known?: { width: number; height: number },
): PlaceResult {
  // An identical object already on the plan is the best template there is: it
  // carries the real outline, including any correction somebody made by hand.
  // Ask FIRST, even for round footprints — the special-outline branch below
  // exists because a rectangle template cannot be resized into a circle, not
  // because a circle is a bad thing to copy.
  const matched = findMatchingShape(doc, description);

  // Circular / curved footprints cannot be made by resizing a rectangle
  // template — synthesize them so the outline is actually round.
  if (!matched && needsSpecialOutline(description)) {
    return placeSynthesized(doc, description, x, y, known);
  }

  const template = matched ?? findTemplateShape(doc);
  if (!template) {
    // Nothing to copy. Build the box instead — this is the new-plan case, and
    // refusing it would mean a plan you just created could hold nothing.
    return placeSynthesized(doc, description, x, y, known);
  }

  const result = duplicateNode(doc, index, template, 0, 0);
  if (!result.ok || !result.created?.length) return result;

  // The clone is the object created directly after the template.
  const copy = findById(doc, result.created[0]);
  if (!copy) return { ok: false, reason: 'the new item could not be located after insertion' };

  const anchor = copy.points[0] ?? {
    x: (copy.bounds.left + copy.bounds.right) / 2,
    y: (copy.bounds.top + copy.bounds.bottom) / 2,
  };
  moveNode(doc, copy, x - anchor.x, y - anchor.y);

  if (matched) {
    return { ok: true, created: result.created, method: 'matched' };
  }

  // Synthesized: rename it and resize its outline. A size the inventory holds is
  // authoritative — it was either corrected by hand or learned from a match.
  const size: Dimensions = known
    ? { width: known.width, height: known.height, source: 'parsed' }
    : parseDimensions(description);
  renameShape(doc, copy, description);

  const geometry = copy.children.find((c) => c.cls === 'RVGeometry');
  if (geometry) {
    const rect = geometry.children.find((c) => c.cls === 'RVSegmentRect' && c.fields.pointCount === 4);
    if (rect) resizeRect(doc, rect, size.width, size.height);

    // Drop any other outline pieces so the box is a clean rectangle.
    if (rect && geometry.slots.length > 1 && geometry.fields.childCountAt != null) {
      geometry.slots = geometry.slots.filter((s) => s.node === rect);
      geometry.children = [rect];
      const header =
        geometry.headerOverride ??
        (geometry.headerOverride = Buffer.from(doc.source.subarray(geometry.span.bodyAt, geometry.span.headerEnd)));
      const at = geometry.fields.childCountAt - geometry.span.bodyAt;
      if (at >= 0 && at + 2 <= header.length) header.writeUInt16LE(geometry.slots.length, at);
    }

    writeBounds(doc, geometry, -size.width / 2, -size.height / 2, size.width / 2, size.height / 2);
  }

  writeBounds(doc, copy, x - size.width / 2, y - size.height / 2, x + size.width / 2, y + size.height / 2);
  return { ok: true, created: result.created, method: 'box', size };
}

/**
 * Places a gear item as a freshly built labelled box.
 *
 * The fallback when the plan has no shape to clone. The result is an ordinary
 * `RVShape` with an `RVGeometry` outline — the same thing a clone produces —
 * so everything downstream treats it identically.
 */
function placeSynthesized(
  doc: RVDocument,
  description: string,
  x: number,
  y: number,
  known?: { width: number; height: number },
): PlaceResult {
  const size: Dimensions = known
    ? { width: known.width, height: known.height, source: 'parsed' }
    : parseDimensions(description);

  const outline = outlineForDescription(description, size.width, size.height);
  const built = createShape(doc, {
    name: description,
    x,
    y,
    outline,
  });
  if (!built.ok || !built.node) return { ok: false, reason: built.reason };

  const host = planBody(doc);
  const added = host ? appendChild(doc, host, built.node) : addRoot(doc, built.node);
  if (!added.ok) return { ok: false, reason: added.reason };

  return {
    ok: true,
    created: [built.node.id],
    method: needsSpecialOutline(description) ? 'synthesized' : 'box',
    size,
  };
}

/**
 * True when the name describes something actually round.
 *
 * This used to demand a round word AND a deck/riser/stage word, so a circular
 * STAGE came out round and a round TABLE came out square — and the banquet
 * round is the commonest object in this entire application. On any plan built
 * from scratch, where there is no existing table to clone, every round in the
 * room was drawn as a box with chairs arranged around it in a circle. It is the
 * first thing anybody notices, and it was wrong in the drawing that gets sent
 * to a venue.
 *
 * `Round 60"` is how the stock catalogue names a five-foot banquet round, so a
 * round word followed by a measurement counts on its own.
 */
function isRoundFootprint(description: string): boolean {
  if (/\bhalf.?round\b|\bquarter.?round\b/i.test(description)) return false;
  if (/\b(circular|round)\b/i.test(description) && /\b(deck|riser|stage|table|top)\b/i.test(description)) {
    return true;
  }
  // "Round 60"", "Round 72 in", "60in Round" — a round with its diameter.
  return /\bround\b/i.test(description) && /\d/.test(description);
}

/** Picks a footprint silhouette from the stock name when placing without a library. */
function outlineForDescription(description: string, width: number, height: number) {
  if (isRoundFootprint(description)) {
    return circleOutline(Math.max(width, height));
  }
  if (/\b(curved|quarter)\b/i.test(description) && /\b(riser|deck|stage)\b/i.test(description)) {
    return quarterCircleOutline(width, height);
  }
  return boxOutline(width, height);
}

/** True when cloning a rectangle template would lose the intended silhouette. */
function needsSpecialOutline(description: string): boolean {
  return (
    isRoundFootprint(description) ||
    (/\b(curved|quarter)\b/i.test(description) && /\b(riser|deck|stage)\b/i.test(description))
  );
}

/**
 * Places a shape from a Room Viewer shape library.
 *
 * The library holds the definition — a typed `RVChair` or `RVAVItem` whose name
 * lives in a record beside it — and a plan needs a named `RVShape`. Copying the
 * definition across brings the drawing but not the identity: it lands as an
 * `RVChair`, so nothing counts it, names it or lists it in the inventory. So
 * the outline is taken and rebuilt as a proper placement, which is the same
 * thing every other placement in the plan is.
 *
 * Curves survive the rebuild. Each arc in the definition is written back as an
 * `RVSegmentArc` rather than as the four points of its control polygon, so a
 * round table placed this way is round.
 */
export function placeFromLibrary(
  doc: RVDocument,
  library: RVDocument,
  name: string,
  x: number,
  y: number,
): PlaceResult {
  const want = name.trim().toLowerCase();
  const entry = readLibrary(library).find((e) => e.name.trim().toLowerCase() === want);
  if (!entry) return { ok: false, reason: `"${name}" is not in that library` };

  const outline = libraryOutline(entry);
  if (!outline.length) return { ok: false, reason: `"${name}" has no outline to draw` };

  // The library is the style donor: a plan that has never held a curve has no
  // arc to copy a pen and brush from, and the definition being placed does.
  const built = createShape(doc, { name: entry.name, x, y, outline, styleFrom: library });
  if (!built.ok || !built.node) return { ok: false, reason: built.reason };

  const host = planBody(doc);
  const added = host ? appendChild(doc, host, built.node) : addRoot(doc, built.node);
  if (!added.ok) return { ok: false, reason: added.reason };

  return {
    ok: true,
    created: [built.node.id],
    method: 'library',
    size: {
      width: entry.node.bounds.right - entry.node.bounds.left,
      height: entry.node.bounds.bottom - entry.node.bounds.top,
      source: 'parsed',
    },
  };
}

/**
 * Places an inventory item from its traced (or catalog) outline.
 *
 * Paths are already centred on the insertion point, matching `createShape`.
 */
export function placeTracedIcon(
  doc: RVDocument,
  index: DocumentIndex,
  description: string,
  x: number,
  y: number,
  icon: { paths: Array<{ points: number[]; closed: boolean }>; width: number; height: number },
): PlaceResult {
  void index;
  const outline = outlineFromTracedPaths(icon.paths);
  if (!outline.length) return { ok: false, reason: 'the traced outline is empty' };

  const built = createShape(doc, { name: description, x, y, outline });
  if (!built.ok || !built.node) return { ok: false, reason: built.reason };

  const host = planBody(doc);
  const added = host ? appendChild(doc, host, built.node) : addRoot(doc, built.node);
  if (!added.ok) return { ok: false, reason: added.reason };

  const width = icon.width > 0 ? icon.width : parseDimensions(description).width;
  const height = icon.height > 0 ? icon.height : parseDimensions(description).height;
  return {
    ok: true,
    created: [built.node.id],
    method: 'traced',
    size: { width, height, source: 'parsed' },
  };
}

function findById(doc: RVDocument, id: number): RVNode | null {
  const seen = new Set<RVNode>();
  const visit = (node: RVNode): RVNode | null => {
    if (seen.has(node)) return null;
    seen.add(node);
    if (node.id === id) return node;
    for (const child of node.children) {
      const found = visit(child);
      if (found) return found;
    }
    return null;
  };
  for (const root of doc.roots) {
    const found = visit(root);
    if (found) return found;
  }
  return null;
}
