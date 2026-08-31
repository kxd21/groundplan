/**
 * Building Room Viewer objects from nothing.
 *
 * Everything else here works by cloning. An existing object's bytes are copied
 * and the fields we understand are patched, so the many fields we never decoded
 * stay valid (`edit.ts`, `place.ts`, `annotate.ts`). That is the right default,
 * and it is also the reason the app cannot draw a wall: a plan containing no
 * wall has nothing to clone.
 *
 * This file writes the bytes itself. Two things make that safe enough to do:
 *
 *   1. **The layout is known for exactly these classes.** A segment is a fixed
 *      20-byte common prefix, a style block, and an array of coordinate pairs.
 *      `tools/test-fixture.ts` has been building segments this way — and the
 *      parser has been reading them — since the fixture was written.
 *   2. **The style block is borrowed, not invented.** Bytes +20..+62 hold pen
 *      width, line style, brush and fill fields this project never decoded.
 *      Where the document already contains a segment of the same class, that
 *      block is copied verbatim so the new object draws like its neighbours.
 *      Only when a document has no such segment do we fall back to a documented
 *      default, and `defaultStyle` records exactly what that assumes.
 *
 * Nothing synthesized here may be saved without passing `verifyWritable`
 * (`write.ts`), which is the creation-time equivalent of the round-trip gate:
 * `roundTrip` compares a document against the file it was read from, and a
 * document with a new object in it is deliberately no longer that file.
 */

import type { Rect } from './mfc.js';
import { CONTAINER_LIST_HEADER } from './plan-skeleton-bytes.js';
import type { Point, RVDocument, RVNode, RVSpan } from './rv.js';
import { walk } from './rv.js';

/** Classes this module can build. Adding one means decoding its layout first. */
export type SynthesizableSegment =
  | 'RVSegmentLine'
  | 'RVSegmentRect'
  | 'RVSegmentPoly'
  | 'RVSegmentArc'
  | 'RVDimensionLine';

/**
 * Classes this module can build as counted child lists.
 *
 * All of them share one layout — the common prefix, a list version, two words
 * that are zero in every file examined, and a child count — so the set is
 * limited by which class names a plan is expected to contain rather than by
 * anything unknown about their bytes.
 */
export type SynthesizableContainer =
  | 'RVRoomDef'
  | 'RVRoom'
  | 'RVGeometry'
  | 'RVRegion'
  | 'RVWalls';

/**
 * Segment body layout, as offsets from the first body byte.
 *
 *   +0   int32  version        always 1
 *   +4   CRect  bounds         4 x int32, logical units
 *   +20  WORD   kind           0 line, 1 arc, 2 rect, 3 poly
 *   +22  int32  vertexHint     point count for lines and polys
 *   +26  ...    pen/brush/style block, undecoded
 *   +54  DWORD  color          COLORREF, 0x00BBGGRR
 *   +58  WORD   declaredCount  read by the parser for polylines
 *   +62  points                n x (double x, double y)
 */
const SEG_KIND = 20;
const SEG_VERTEX_HINT = 22;
const SEG_STYLE_FROM = 26;
const SEG_COLOR = 54;
const SEG_DECLARED_COUNT = 58;
const SEG_POINTS = 62;

/**
 * Container body layout: the common prefix, then the counted list header.
 *
 * The three words at +20 are a list version, a flag and a reserved word. The
 * parser reads none of them, which is why this file wrote `1, 0, 0` there for
 * as long as it existed and no gate ever noticed — round trip, census and
 * `verifyWritable` are all blind to bytes nobody decodes. Every one of the
 * 92,230 containers measured across 390 corpus plans writes `0, 1, 0`, so the
 * measured value is used verbatim (`plan-skeleton-bytes.ts`).
 */
const CONTAINER_LIST_HEADER_AT = 20;
const CONTAINER_CHILD_COUNT = 26;
const CONTAINER_HEADER_BYTES = 28;

/** Segment kind codes, keyed by class. */
const KIND_CODE: Record<SynthesizableSegment, number> = {
  RVSegmentLine: 0,
  RVSegmentArc: 1,
  RVSegmentRect: 2,
  RVSegmentPoly: 3,
  RVDimensionLine: 0,
};

/** Point counts the parser expects; `null` means the count is declared inline. */
const REQUIRED_POINTS: Record<SynthesizableSegment, number | null> = {
  RVSegmentLine: 2,
  RVSegmentRect: 4,
  RVSegmentArc: 8,
  RVDimensionLine: 2,
  RVSegmentPoly: null,
};

/** Black, the colour Room Viewer draws walls and dimensions in. */
export const DEFAULT_COLOR = 0x00000000;

/**
 * The style block used when a document has nothing to borrow from.
 *
 * These 36 bytes (+26 through +62, minus the colour we always write) were never
 * decoded, so this is an assumption rather than a finding: zeros. Every real
 * file the corpus contains has at least one segment, so this path is reached
 * only for a document built entirely from scratch. `borrowedStyle` reports
 * which of the two was used so callers can be honest about it.
 */
function defaultStyle(): Buffer {
  return Buffer.alloc(SEG_POINTS - SEG_STYLE_FROM);
}

/**
 * Copies the undecoded style bytes off a segment of the same class.
 *
 * Same class only: +58 is a declared point count on a polyline and something
 * else on a rectangle, so borrowing across classes would write one class's
 * field into another's slot.
 */
function borrowStyle(doc: RVDocument, cls: string): Buffer | null {
  for (const node of walk(doc)) {
    if (node.cls !== cls) continue;
    if (node.fields.pointsAt == null) continue;
    const from = node.span.bodyAt + SEG_STYLE_FROM;
    const to = node.span.bodyAt + SEG_POINTS;
    const body = node.headerOverride;
    if (body) {
      if (body.length < SEG_POINTS) continue;
      return Buffer.from(body.subarray(SEG_STYLE_FROM, SEG_POINTS));
    }
    if (to > doc.source.length) continue;
    return Buffer.from(doc.source.subarray(from, to));
  }
  return null;
}

/**
 * Tight bounding box of a cubic Bézier, in whole logical units.
 *
 * A curve's control polygon is not its extent — a semicircle's control points
 * stand a third further out than the curve ever reaches — and Room Viewer
 * stores the *curve's* box: measured over 99,491 arcs in 1,939 files on the
 * production drive, the cached rect matches the tight box of the drawn cubic in
 * 99.99% of them and the control-polygon box in 15%. Writing the polygon box
 * would make every placed arc claim a footprint a third too large, which is
 * what the readiness and allocation passes measure.
 */
export function curveBounds(curve: Point[]): Rect {
  const axis = (a: number, b: number, c: number, d: number): [number, number] => {
    let lo = Math.min(a, d);
    let hi = Math.max(a, d);
    const at = (t: number): number => {
      const s = 1 - t;
      return s * s * s * a + 3 * s * s * t * b + 3 * s * t * t * c + t * t * t * d;
    };
    const consider = (t: number): void => {
      if (!(t > 0 && t < 1)) return;
      const v = at(t);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    };
    // B'(t) = 0, written in the monomial basis.
    const qa = -a + 3 * b - 3 * c + d;
    const qb = 2 * (a - 2 * b + c);
    const qc = -a + b;
    if (Math.abs(qa) < 1e-12) {
      if (Math.abs(qb) > 1e-12) consider(-qc / qb);
    } else {
      const disc = qb * qb - 4 * qa * qc;
      if (disc >= 0) {
        const root = Math.sqrt(disc);
        consider((-qb + root) / (2 * qa));
        consider((-qb - root) / (2 * qa));
      }
    }
    return [lo, hi];
  };

  if (curve.length !== 4) return boundsOf(curve);
  const [left, right] = axis(curve[0].x, curve[1].x, curve[2].x, curve[3].x);
  const [top, bottom] = axis(curve[0].y, curve[1].y, curve[2].y, curve[3].y);
  return {
    left: Math.round(left),
    top: Math.round(top),
    right: Math.round(right),
    bottom: Math.round(bottom),
  };
}

/**
 * The eight points an `RVSegmentArc` stores, from the four that are drawn.
 *
 * An arc's point array is two representations of one cubic. The last four are
 * the control points the renderer draws — that is the project's existing
 * finding, and the cached rect above confirms it. The first four were unread
 * until now; measured across the corpus they are the same curve in the frame it
 * was *authored* in, held as a weighted control polygon `(P0, 3·P1, 3·P2, P3)`.
 * Where an arc has not been rotated or mirrored since it was drawn the two
 * frames coincide, and 83,229 of the 99,491 arcs on the production drive are
 * exactly `(P0, 3·P1, 3·P2, P3, P0, P1, P2, P3)`.
 *
 * A shape placed from a library has not been transformed, so that is precisely
 * the form written here: not a guess at half an object, but the byte pattern
 * Room Viewer itself writes for the case being synthesized.
 */
export function arcSegmentPoints(curve: Point[]): Point[] {
  const [p0, p1, p2, p3] = curve;
  return [
    { x: p0.x, y: p0.y },
    { x: p1.x * 3, y: p1.y * 3 },
    { x: p2.x * 3, y: p2.y * 3 },
    { x: p3.x, y: p3.y },
    { x: p0.x, y: p0.y },
    { x: p1.x, y: p1.y },
    { x: p2.x, y: p2.y },
    { x: p3.x, y: p3.y },
  ];
}

/** Bounding box of a point list, in whole logical units. */
export function boundsOf(points: Point[]): Rect {
  if (!points.length) return { left: 0, top: 0, right: 0, bottom: 0 };
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const p of points) {
    if (p.x < left) left = p.x;
    if (p.y < top) top = p.y;
    if (p.x > right) right = p.x;
    if (p.y > bottom) bottom = p.y;
  }
  return {
    left: Math.round(left),
    top: Math.round(top),
    right: Math.round(right),
    bottom: Math.round(bottom),
  };
}

/** Smallest rect holding both, treating a missing one as nothing at all. */
function unionRect(a: Rect | null, b: Rect): Rect {
  if (!a) return b;
  return {
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
  };
}

/** A synthesized node owns its bytes outright, so its span starts at zero. */
function ownSpan(headerBytes: number): RVSpan {
  return { tagAt: 0, bodyAt: 0, headerEnd: headerBytes, trailerAt: headerBytes, end: headerBytes };
}

/**
 * The schema number written next to a class name the first time it appears.
 *
 * Where the open document already introduced the class its number is reused, so
 * editing a real plan keeps writing whatever that plan uses.
 *
 * The fallback matters when a plan is created from nothing. MFC stores one
 * schema per class for the whole archive, so a document cannot hold two — and
 * writing geometry at schema 1, as this used to, meant a plan Groundplan
 * created could never accept a symbol imported from a real one: the archive
 * ended up describing `RVSegmentLine` as schema 1 while the imported objects
 * were schema 2, and the save gate refused the file.
 *
 * Measured over 149 plans on the production drive, real files are unanimous:
 * the containers are schema 1 and everything drawable is schema 2.
 */
const CONTAINER_SCHEMA = new Set(['RVRoom', 'RVRoomDef', 'RVWalls']);

function schemaFor(doc: RVDocument, cls: string): number {
  for (const node of walk(doc)) {
    if (node.cls === cls) return node.schema;
  }
  return CONTAINER_SCHEMA.has(cls) ? 1 : 2;
}

export interface SegmentSpec {
  cls: SynthesizableSegment;
  /** Coordinates in logical units (tenths of an inch). */
  points: Point[];
  /** COLORREF as 0x00BBGGRR. Defaults to black. */
  color?: number;
  /** Cached rect. Computed from the points when omitted. */
  bounds?: Rect;
  /**
   * Second document to take the undecoded style block from when the target has
   * no segment of this class. A blank plan contains no arc, so an arc placed
   * into one would otherwise get the zeroed default; the library the shape came
   * from holds the pen and brush Room Viewer drew it with.
   */
  styleFrom?: RVDocument;
}

export interface SynthesisResult {
  ok: boolean;
  reason?: string;
  node?: RVNode;
  /** False when no segment of this class existed to copy style bytes from. */
  borrowedStyle?: boolean;
}

/**
 * Builds a segment — a line, rectangle, polyline, arc or dimension — from
 * scratch, with no template object in the document.
 *
 * The node returned is not yet part of the document; pass it to `appendChild`
 * or `addRoot` in `edit.ts`, then gate the save with `verifyWritable`.
 */
export function createSegment(doc: RVDocument, spec: SegmentSpec): SynthesisResult {
  const required = REQUIRED_POINTS[spec.cls];
  if (required != null && spec.points.length !== required) {
    return {
      ok: false,
      reason: `${spec.cls} needs exactly ${required} points, got ${spec.points.length}`,
    };
  }
  if (required == null && spec.points.length < 2) {
    return { ok: false, reason: `${spec.cls} needs at least 2 points` };
  }
  if (spec.points.length > 8192) {
    return { ok: false, reason: `${spec.cls} cannot hold more than 8192 points` };
  }
  for (const p of spec.points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      return { ok: false, reason: 'points must be finite' };
    }
    // The parser rejects coordinates outside this range as misparses, so a
    // document containing them would not survive its own round trip.
    if (Math.abs(p.x) > 1e7 || Math.abs(p.y) > 1e7) {
      return { ok: false, reason: 'points are outside the coordinate range Room Viewer uses' };
    }
  }

  const style = borrowStyle(doc, spec.cls) ?? (spec.styleFrom ? borrowStyle(spec.styleFrom, spec.cls) : null);
  // An arc's rect is the box of the curve it draws, which is the last four of
  // its eight points; the leading four are the same curve in its authored frame
  // and reach three times as far.
  const drawn = spec.cls === 'RVSegmentArc' && spec.points.length === 8 ? spec.points.slice(-4) : null;
  const bounds = spec.bounds ?? (drawn ? curveBounds(drawn) : boundsOf(spec.points));
  const header = Buffer.alloc(SEG_POINTS + spec.points.length * 16);

  header.writeInt32LE(1, 0);
  header.writeInt32LE(bounds.left, 4);
  header.writeInt32LE(bounds.top, 8);
  header.writeInt32LE(bounds.right, 12);
  header.writeInt32LE(bounds.bottom, 16);

  (style ?? defaultStyle()).copy(header, SEG_STYLE_FROM);

  header.writeUInt16LE(KIND_CODE[spec.cls], SEG_KIND);
  header.writeInt32LE(spec.points.length, SEG_VERTEX_HINT);
  header.writeUInt32LE((spec.color ?? DEFAULT_COLOR) >>> 0, SEG_COLOR);
  // Only a class whose count is not fixed carries it inline. Writing it for the
  // others would overwrite a borrowed field whose meaning we do not know.
  if (required == null) header.writeUInt16LE(spec.points.length, SEG_DECLARED_COUNT);

  spec.points.forEach((p, i) => {
    header.writeDoubleLE(p.x, SEG_POINTS + i * 16);
    header.writeDoubleLE(p.y, SEG_POINTS + i * 16 + 8);
  });

  const node: RVNode = {
    id: doc.nextId++,
    cls: spec.cls,
    schema: schemaFor(doc, spec.cls),
    offset: 0,
    span: ownSpan(header.length),
    newClass: false,
    slots: [],
    version: 1,
    bounds,
    points: spec.points.map((p) => ({ ...p })),
    kind: KIND_CODE[spec.cls],
    color: (spec.color ?? DEFAULT_COLOR) >>> 0,
    labels: [],
    children: [],
    fields: {
      boundsAt: 4,
      colorAt: SEG_COLOR,
      pointsAt: SEG_POINTS,
      pointCount: spec.points.length,
    },
    headerOverride: header,
    trailerOverride: Buffer.alloc(0),
  };

  return { ok: true, node, borrowedStyle: style != null };
}

export interface ContainerSpec {
  cls: SynthesizableContainer;
  bounds?: Rect;
  /**
   * Bytes the object carries after its child count.
   *
   * Three of the five containers in a Room Viewer plan are *records* rather
   * than lists: they declare no children and spend the rest of their body on
   * fields nobody decoded — the second `RVRoomDef`'s 18-byte block, the
   * `RVRegion`'s 392-byte settings record. The parser folds those bytes into
   * the object's header span (an empty container's `headerEnd` runs to
   * wherever the forward scan stopped), so they belong to the header here too.
   *
   * A container given a record must stay empty: `appendChild` would write the
   * child list *after* the record, where no real file has one. `verifyPlanShape`
   * checks that.
   */
  record?: Buffer;
}

/**
 * Builds a counted container.
 *
 * Containers are the one shape with no undecoded block *in the list header*: a
 * common prefix, the three list words, and a child count. Anything past that is
 * a `record`, which is copied from the corpus rather than invented.
 */
export function createContainer(doc: RVDocument, spec: ContainerSpec): SynthesisResult {
  const bounds = spec.bounds ?? { left: 0, top: 0, right: 0, bottom: 0 };
  const record = spec.record ?? Buffer.alloc(0);
  const header = Buffer.alloc(CONTAINER_HEADER_BYTES + record.length);

  header.writeInt32LE(1, 0);
  header.writeInt32LE(bounds.left, 4);
  header.writeInt32LE(bounds.top, 8);
  header.writeInt32LE(bounds.right, 12);
  header.writeInt32LE(bounds.bottom, 16);
  CONTAINER_LIST_HEADER.copy(header, CONTAINER_LIST_HEADER_AT);
  header.writeUInt16LE(0, CONTAINER_CHILD_COUNT);
  record.copy(header, CONTAINER_HEADER_BYTES);

  const node: RVNode = {
    id: doc.nextId++,
    cls: spec.cls,
    schema: schemaFor(doc, spec.cls),
    offset: 0,
    span: ownSpan(header.length),
    newClass: false,
    slots: [],
    version: 1,
    bounds,
    points: [],
    labels: [],
    children: [],
    fields: { boundsAt: 4, childCountAt: CONTAINER_CHILD_COUNT },
    headerOverride: header,
    trailerOverride: Buffer.alloc(0),
  };

  return { ok: true, node };
}

/**
 * Label body layout, as offsets from the first body byte.
 *
 *   +0   int32  version
 *   +4   CRect  bounds
 *   +20  WORD x3
 *   +26  double x4          insertion point, then a second reference point
 *   +58  double             rotation in radians
 *   +66  int32
 *   +70  LOGFONT            5 x int32, 8 style bytes, face name as a CString
 *   ...  CString            the text
 *   ...  DWORD colour, int32, double x4, int32, double
 */
const LABEL_PLACEMENT = 26;
const LABEL_ANGLE = 58;
const LABEL_FONT = 70;
/** Five metrics and eight style flags, before the face name. */
const LOGFONT_FIXED_BYTES = 28;
/** Colour, a count, four doubles, a count, a double. */
const LABEL_TAIL_BYTES = 52;

/**
 * The font a label gets when the document has none to copy.
 *
 * `lfHeight` is negative, which in a `LOGFONT` means the value is a character
 * height rather than a cell height; 400 is `FW_NORMAL`. Arial is the face the
 * corpus uses most. Borrowing beats this wherever a label already exists.
 */
const DEFAULT_FONT = { height: -90, weight: 400, face: 'Arial' };

/** Copies the LOGFONT metrics off an existing label, so new text matches. */
function borrowFont(doc: RVDocument): Buffer | null {
  for (const node of walk(doc)) {
    if (node.cls !== 'RVLabel' || node.fields.textAt == null) continue;
    const body = node.headerOverride;
    const from = LABEL_FONT;
    const to = node.fields.textAt - node.span.bodyAt;
    if (to <= from) continue;
    if (body) {
      if (body.length < to) continue;
      return Buffer.from(body.subarray(from, to));
    }
    const start = node.span.bodyAt + from;
    const end = node.span.bodyAt + to;
    if (end > doc.source.length) continue;
    return Buffer.from(doc.source.subarray(start, end));
  }
  return null;
}

function defaultFontBlock(): Buffer {
  const face = Buffer.from(DEFAULT_FONT.face, 'latin1');
  const out = Buffer.alloc(LOGFONT_FIXED_BYTES + 1 + face.length);
  out.writeInt32LE(DEFAULT_FONT.height, 0);
  out.writeInt32LE(DEFAULT_FONT.weight, 16);
  out.writeUInt8(face.length, LOGFONT_FIXED_BYTES);
  face.copy(out, LOGFONT_FIXED_BYTES + 1);
  return out;
}

export interface LabelSpec {
  text: string;
  /** Insertion point in logical units. */
  x: number;
  y: number;
  /** Rotation in radians. */
  angle?: number;
  /** COLORREF as 0x00BBGGRR. */
  color?: number;
}

/**
 * Builds a text label from scratch.
 *
 * This is what makes annotation possible in a plan that has none. Until now a
 * label could only be cloned, so the first label in an empty drawing — exactly
 * the case where someone wants one — could not be written at all.
 */
export function createLabel(doc: RVDocument, spec: LabelSpec): SynthesisResult {
  const text = spec.text.replace(/\r?\n/g, '\r\n');
  const encoded = Buffer.from(text, 'latin1');
  if (!encoded.length) return { ok: false, reason: 'a label needs some text' };
  if (encoded.length > 254) return { ok: false, reason: 'that label is too long' };
  if (!Number.isFinite(spec.x) || !Number.isFinite(spec.y)) {
    return { ok: false, reason: 'the label position must be finite' };
  }

  const font = borrowFont(doc);
  const fontBlock = font ?? defaultFontBlock();
  const header = Buffer.alloc(LABEL_FONT + fontBlock.length + 1 + encoded.length + LABEL_TAIL_BYTES);

  header.writeInt32LE(1, 0);
  // A label's cached rect is only used for hit-testing; the drawn text is
  // positioned from the insertion point, so a tight box around it will do.
  const halfWidth = Math.max(1, encoded.length * 30);
  header.writeInt32LE(Math.round(spec.x - halfWidth / 2), 4);
  header.writeInt32LE(Math.round(spec.y - 60), 8);
  header.writeInt32LE(Math.round(spec.x + halfWidth / 2), 12);
  header.writeInt32LE(Math.round(spec.y + 60), 16);
  header.writeUInt16LE(1, 20);

  header.writeDoubleLE(spec.x, LABEL_PLACEMENT);
  header.writeDoubleLE(spec.y, LABEL_PLACEMENT + 8);
  header.writeDoubleLE(spec.x, LABEL_PLACEMENT + 16);
  header.writeDoubleLE(spec.y, LABEL_PLACEMENT + 24);
  header.writeDoubleLE(spec.angle ?? 0, LABEL_ANGLE);

  fontBlock.copy(header, LABEL_FONT);
  const textAt = LABEL_FONT + fontBlock.length;
  header.writeUInt8(encoded.length, textAt);
  encoded.copy(header, textAt + 1);
  header.writeUInt32LE((spec.color ?? DEFAULT_COLOR) >>> 0, textAt + 1 + encoded.length);

  const faceLen = fontBlock[LOGFONT_FIXED_BYTES] ?? 0;
  const face = fontBlock.toString('latin1', LOGFONT_FIXED_BYTES + 1, LOGFONT_FIXED_BYTES + 1 + faceLen);

  const node: RVNode = {
    id: doc.nextId++,
    cls: 'RVLabel',
    schema: schemaFor(doc, 'RVLabel'),
    offset: 0,
    span: ownSpan(header.length),
    newClass: false,
    slots: [],
    version: 1,
    bounds: {
      left: header.readInt32LE(4),
      top: header.readInt32LE(8),
      right: header.readInt32LE(12),
      bottom: header.readInt32LE(16),
    },
    points: [
      { x: spec.x, y: spec.y },
      { x: spec.x, y: spec.y },
    ],
    angle: spec.angle ?? 0,
    color: (spec.color ?? DEFAULT_COLOR) >>> 0,
    bold: fontBlock.readInt32LE(16) >= 600,
    font: {
      family: face || 'Arial',
      height: fontBlock.readInt32LE(0),
      width: fontBlock.readInt32LE(4),
      weight: fontBlock.readInt32LE(16),
      italic: fontBlock.readUInt8(20) !== 0,
      underline: fontBlock.readUInt8(21) !== 0,
      strikeOut: fontBlock.readUInt8(22) !== 0,
    },
    labels: face ? [face, text] : [text],
    children: [],
    fields: {
      boundsAt: 4,
      placementAt: LABEL_PLACEMENT,
      angleAt: LABEL_ANGLE,
      fontHeightAt: LABEL_FONT,
      fontWidthAt: LABEL_FONT + 4,
      fontWeightAt: LABEL_FONT + 16,
      fontItalicAt: LABEL_FONT + 20,
      fontUnderlineAt: LABEL_FONT + 21,
      fontStrikeOutAt: LABEL_FONT + 22,
      fontFaceAt: LABEL_FONT + LOGFONT_FIXED_BYTES,
      fontFaceLen: faceLen,
      textAt,
      textLen: encoded.length,
      colorAt: textAt + 1 + encoded.length,
    },
    headerOverride: header,
    trailerOverride: Buffer.alloc(0),
  };

  return { ok: true, node, borrowedStyle: font != null };
}

/**
 * Placed-shape body layout, as offsets from the first body byte.
 *
 *   +0   int32  version
 *   +4   CRect  bounds          absolute, unlike the geometry inside it
 *   +20  WORD x3
 *   +26  double x4              insertion point, then a second reference point
 *   +58  double                 rotation in radians
 *   +66  int32
 *   +70  CString                empty in every file examined
 *   +71  CString                catalogue name
 *   then the RVGeometry child holding the outline, in local coordinates
 */
const SHAPE_PLACEMENT = 26;
const SHAPE_ANGLE = 58;
const SHAPE_STRINGS = 70;

/**
 * One run of an outline.
 *
 * A bare point list is a straight-sided run — a line if it has two points, a
 * polyline otherwise. `{ curve }` is a cubic Bézier of exactly four control
 * points, written as a real `RVSegmentArc` so a round table stays round instead
 * of being flattened into the chords of its own control polygon.
 *
 * `{ rect }` is the same idea for the commonest primitive of all. Room Viewer
 * stores a rectangular footprint as an `RVSegmentRect` — a closed four-corner
 * solid — and a rebuild that emitted every straight-sided run as a polyline
 * turned all of them into open polylines: 5,745 `RVSegmentPoly` where the
 * original plan had 5,768 `RVSegmentRect`. That is not only a class mismatch.
 * `scene.ts` types a rect as a `polygon` and a poly as a `polyline`, so the
 * rebuilt outline stopped closing, stopped filling (`style.ts enclosesArea`),
 * and became a stroke to hit rather than an area to click.
 *
 * The marker records what the source run *was*; `rectangleCorners` then decides
 * whether it still *is* one. Both have to agree before a rect is written.
 */
export type OutlineRun = Point[] | { curve: Point[] } | { rect: Point[] };

const isCurveRun = (run: OutlineRun): run is { curve: Point[] } =>
  !Array.isArray(run) && 'curve' in run;
const isRectRun = (run: OutlineRun): run is { rect: Point[] } =>
  !Array.isArray(run) && 'rect' in run;
const runPoints = (run: OutlineRun): Point[] =>
  Array.isArray(run) ? run : isCurveRun(run) ? run.curve : run.rect;

/**
 * How far the repeat of a closing point may sit from the point it repeats.
 *
 * A closed run repeats its first coordinate verbatim, and the only arithmetic
 * between reading it and testing it here is subtracting one centre from both —
 * the same double from the same value, so the two stay bit-identical. This is a
 * guard against a caller that computed its corners rather than copying them,
 * not a real tolerance: a hundred-millionth of a tenth of an inch.
 */
const CLOSING_POINT_TOLERANCE = 1e-9;

/**
 * The largest `|cos θ|` a corner may show and still count as a right angle.
 *
 * Measured over 69,513 four-point `RVSegmentRect` objects in 250 plans on the
 * production drive, the worst corner of each is sharply bimodal: 69,391 of them
 * come in under 1e-6 (8,158 exactly zero, 59,873 under 1e-12, 1,360 under 1e-9,
 * 2 under 1e-6) and 120 come in at 1e-2 or worse — Room Viewer will stamp
 * `kind = 2` on a skewed quadrilateral, and those are not rectangles. Nothing at
 * all lands in the four decades between. Any threshold in that gap classifies
 * the corpus identically, so this takes the conservative end of it: 1e-6 is
 * about 0.00006°, far tighter than any rectangle a person drew and far looser
 * than the rounding in a rotated one.
 */
const RIGHT_ANGLE_COSINE = 1e-6;

/**
 * Shortest side a rectangle may have, in logical units (tenths of an inch).
 *
 * A zero-length side makes the corner angle meaningless — 119 corpus rects have
 * one — and a rect collapsed to a line is not what the four-corner class means.
 */
const MIN_RECT_SIDE = 1e-6;

/**
 * The four corners of a run, if the run really is a rectangle.
 *
 * Accepts four corners, or five with the last repeating the first, and requires
 * a right angle at each corner. Four right angles in a closed quadrilateral is
 * the whole definition — it forces opposite sides parallel and equal — so
 * nothing else needs checking.
 *
 * Rotation is deliberately allowed. Room Viewer itself writes turned rectangles
 * as `RVSegmentRect`: 1,257 of the 5,768 in the plan being rebuilt are rotated,
 * as are 32,894 of 69,639 across 250 plans, and the class's cached rect is
 * `0,0,0,0` in 99.4% of them — so the four stored corners, not an axis-aligned
 * box, are what the format and the renderer use. Refusing a rotated rectangle
 * would write a polyline where the original file has a rect.
 *
 * Returns `null` for anything else, and the caller falls back to a polyline.
 */
export function rectangleCorners(points: Point[]): Point[] | null {
  let corners = points;
  if (corners.length === 5) {
    const first = corners[0];
    const last = corners[4];
    if (
      Math.abs(first.x - last.x) > CLOSING_POINT_TOLERANCE ||
      Math.abs(first.y - last.y) > CLOSING_POINT_TOLERANCE
    ) {
      return null;
    }
    corners = corners.slice(0, 4);
  }
  if (corners.length !== 4) return null;

  for (const p of corners) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  }

  for (let i = 0; i < 4; i++) {
    const before = corners[(i + 3) % 4];
    const at = corners[i];
    const after = corners[(i + 1) % 4];
    const ux = at.x - before.x;
    const uy = at.y - before.y;
    const vx = after.x - at.x;
    const vy = after.y - at.y;
    const lu = Math.hypot(ux, uy);
    const lv = Math.hypot(vx, vy);
    if (lu < MIN_RECT_SIDE || lv < MIN_RECT_SIDE) return null;
    if (Math.abs(ux * vx + uy * vy) / (lu * lv) > RIGHT_ANGLE_COSINE) return null;
  }

  return corners.map((p) => ({ ...p }));
}

export interface ShapeSpec {
  /** Catalogue name, as it will appear in the inventory and on schedules. */
  name: string;
  /** Insertion point in logical units. */
  x: number;
  y: number;
  /** Rotation in radians. */
  angle?: number;
  /**
   * The outline, in coordinates local to the insertion point — so a 60in round
   * table is a circle about the origin, not about where it sits.
   */
  outline: OutlineRun[];
  color?: number;
  /** Style donor for classes the target document does not already contain. */
  styleFrom?: RVDocument;
}

/**
 * Builds a placed shape and its outline from scratch.
 *
 * This is what a custom-shape editor needs, and it is also what removes the
 * last template dependency in the app: `placeGear` could only ever put
 * something on a plan that already contained a shape to clone, so a blank
 * drawing refused every placement with "this plan has no placed shape to base a
 * new item on".
 *
 * Returns the shape with its geometry already attached; add it to a container
 * with `appendChild`, or at document level with `addRoot`.
 */
export function createShape(doc: RVDocument, spec: ShapeSpec): SynthesisResult {
  const name = spec.name.trim();
  if (!name) return { ok: false, reason: 'a shape needs a name' };
  const encoded = Buffer.from(name.slice(0, 254), 'latin1');
  if (!Number.isFinite(spec.x) || !Number.isFinite(spec.y)) {
    return { ok: false, reason: 'the shape position must be finite' };
  }
  const outline = spec.outline.filter((run) =>
    isCurveRun(run) ? run.curve.length === 4 : runPoints(run).length >= 2,
  );
  if (!outline.length) return { ok: false, reason: 'a shape needs at least one outline run' };

  // Build the geometry first: a failure part-way leaves nothing attached.
  const segments: RVNode[] = [];
  let local: Rect | null = null;
  for (const run of outline) {
    const curve = isCurveRun(run) ? run.curve : null;
    // A run becomes a rect only when it was one in the source *and* still
    // measures as one. A shape library holds rectangles under both classes —
    // `StockShapes.stk` has 129 `RVSegmentRect` and 59 `RVSegmentPoly` that are
    // geometrically rectangles — so promoting on geometry alone would write
    // rects the source file does not have. Requiring both is what makes a
    // rebuilt histogram match the original rather than merely move.
    const corners = isRectRun(run) ? rectangleCorners(run.rect) : null;
    const points = curve ? arcSegmentPoints(curve) : (corners ?? runPoints(run));
    const cls: SynthesizableSegment = curve
      ? 'RVSegmentArc'
      : corners
        ? 'RVSegmentRect'
        : points.length === 2
          ? 'RVSegmentLine'
          : 'RVSegmentPoly';
    const built = createSegment(doc, {
      cls,
      points,
      color: spec.color,
      styleFrom: spec.styleFrom,
    });
    if (!built.ok || !built.node) return { ok: false, reason: built.reason };
    segments.push(built.node);
    // A run's contribution is what it draws: for an arc that is the curve's own
    // box, not its control points, and not the eight stored coordinates.
    local = unionRect(local, curve ? curveBounds(curve) : boundsOf(points));
  }
  local ??= { left: 0, top: 0, right: 0, bottom: 0 };

  const geometry = createContainer(doc, { cls: 'RVGeometry', bounds: local });
  if (!geometry.ok || !geometry.node) return { ok: false, reason: geometry.reason };
  for (const segment of segments) {
    geometry.node.slots.push({ kind: 'object', node: segment });
    geometry.node.children.push(segment);
  }
  geometry.node.headerOverride!.writeUInt16LE(segments.length, CONTAINER_CHILD_COUNT);

  const header = Buffer.alloc(SHAPE_STRINGS + 2 + encoded.length);
  header.writeInt32LE(1, 0);
  // The shape's rect is absolute; the geometry's is local to the insertion point.
  header.writeInt32LE(Math.round(spec.x + local.left), 4);
  header.writeInt32LE(Math.round(spec.y + local.top), 8);
  header.writeInt32LE(Math.round(spec.x + local.right), 12);
  header.writeInt32LE(Math.round(spec.y + local.bottom), 16);
  header.writeUInt16LE(1, 20);
  header.writeDoubleLE(spec.x, SHAPE_PLACEMENT);
  header.writeDoubleLE(spec.y, SHAPE_PLACEMENT + 8);
  header.writeDoubleLE(spec.x, SHAPE_PLACEMENT + 16);
  header.writeDoubleLE(spec.y, SHAPE_PLACEMENT + 24);
  header.writeDoubleLE(spec.angle ?? 0, SHAPE_ANGLE);
  header.writeUInt8(0, SHAPE_STRINGS);
  header.writeUInt8(encoded.length, SHAPE_STRINGS + 1);
  encoded.copy(header, SHAPE_STRINGS + 2);

  const node: RVNode = {
    id: doc.nextId++,
    cls: 'RVShape',
    schema: schemaFor(doc, 'RVShape'),
    offset: 0,
    span: ownSpan(header.length),
    newClass: false,
    slots: [{ kind: 'object', node: geometry.node }],
    version: 1,
    bounds: {
      left: header.readInt32LE(4),
      top: header.readInt32LE(8),
      right: header.readInt32LE(12),
      bottom: header.readInt32LE(16),
    },
    points: [
      { x: spec.x, y: spec.y },
      { x: spec.x, y: spec.y },
    ],
    angle: spec.angle ?? 0,
    labels: [name],
    children: [geometry.node],
    fields: {
      boundsAt: 4,
      placementAt: SHAPE_PLACEMENT,
      angleAt: SHAPE_ANGLE,
      nameAt: SHAPE_STRINGS + 1,
      nameLen: encoded.length,
    },
    headerOverride: header,
    trailerOverride: Buffer.alloc(0),
  };

  return { ok: true, node };
}

/** A rectangular footprint about the origin — the commonest custom shape. */
export function boxOutline(width: number, height: number): Point[][] {
  const hw = width / 2;
  const hh = height / 2;
  return [
    [
      { x: -hw, y: -hh },
      { x: hw, y: -hh },
      { x: hw, y: hh },
      { x: -hw, y: hh },
      { x: -hw, y: -hh },
    ],
  ];
}

/** A circular footprint about the origin, drawn as a closed polyline. */
export function circleOutline(diameter: number, segments = 48): Point[][] {
  const r = diameter / 2;
  const points: Point[] = [];
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * 2 * Math.PI;
    points.push({ x: r * Math.cos(angle), y: r * Math.sin(angle) });
  }
  return [points];
}

/**
 * A quarter-circle deck filling the bounding box (LEMG-style curved corner).
 * Arc runs from +X through to +Y; straight edges close back to the origin corner.
 */
export function quarterCircleOutline(width: number, height: number, segments = 24): Point[][] {
  const hw = width / 2;
  const hh = height / 2;
  const points: Point[] = [{ x: -hw, y: -hh }];
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * (Math.PI / 2);
    points.push({ x: -hw + width * Math.cos(angle), y: -hh + height * Math.sin(angle) });
  }
  points.push({ x: -hw, y: -hh });
  return [points];
}

/** Cubic Bézier kappa for a quarter circle. */
const QUARTER_CIRCLE_K = (4 / 3) * (Math.SQRT2 - 1);

export type DoorSwing = {
  /** One leaf or a pair meeting in the middle. */
  leaves: 1 | 2;
  /** Into the room (+) or away from it (−), relative to the jamb edge. */
  out: boolean;
  /** Hinge on the left (−X) or right (+X) for a single leaf. */
  hand: 'L' | 'R';
};

/**
 * Architectural door plan mark: wall jamb, leaf line(s), and swing arc(s).
 *
 * Matches the Room Viewer stock doors (jamb on the wall edge, 90° swing into
 * or out of the room). Used when a plan has no harvested door symbol to clone.
 */
export function doorOutline(
  width: number,
  depth: number,
  swing: DoorSwing = { leaves: 1, out: true, hand: 'R' },
): OutlineRun[] {
  const w = Math.max(width, 1);
  const d = Math.max(depth, 1);
  const hw = w / 2;
  const hh = d / 2;
  // ~6″ jamb thickness, clamped so a tiny door still draws.
  const jamb = Math.min(Math.max(w * 0.08, 40), Math.min(w, d) * 0.25);
  const wallY = hh;
  const roomDir = swing.out ? -1 : 1;
  // jamb thickness used below; openY was only for the old tip placement.
  const runs: OutlineRun[] = [
    {
      rect: [
        { x: -hw + jamb * 0.15, y: wallY },
        { x: hw - jamb * 0.15, y: wallY },
        { x: hw - jamb * 0.15, y: wallY - roomDir * jamb },
        { x: -hw + jamb * 0.15, y: wallY - roomDir * jamb },
      ],
    },
  ];

  const leaf = (hingeX: number, tipX: number) => {
    const closedY = wallY - roomDir * jamb;
    const openTipY = wallY - roomDir * jamb - roomDir * Math.abs(tipX - hingeX);
    runs.push([
      { x: hingeX, y: closedY },
      { x: hingeX, y: openTipY },
    ]);
    const r = Math.abs(tipX - hingeX);
    const alongWall = tipX >= hingeX ? 1 : -1;
    const p0 = { x: hingeX + alongWall * r, y: closedY };
    const p3 = { x: hingeX, y: openTipY };
    const p1 = { x: p0.x, y: p0.y - roomDir * QUARTER_CIRCLE_K * r };
    const p2 = { x: p3.x + alongWall * QUARTER_CIRCLE_K * r, y: p3.y };
    runs.push({ curve: [p0, p1, p2, p3] });
  };

  if (swing.leaves === 2) {
    leaf(-hw + jamb * 0.2, 0);
    leaf(hw - jamb * 0.2, 0);
  } else if (swing.hand === 'L') {
    leaf(-hw + jamb * 0.2, hw - jamb * 0.2);
  } else {
    leaf(hw - jamb * 0.2, -hw + jamb * 0.2);
  }

  return runs;
}

/** Reads swing style from stock names like `Door - Single (In) Left Swing`. */
export function doorSwingFromName(description: string): DoorSwing {
  const text = description.toLowerCase();
  const leaves: 1 | 2 = /\bdouble\b/.test(text) ? 2 : 1;
  const explicitIn = /\(\s*in\s*\)/.test(text);
  const explicitOut = /\(\s*out\s*\)/.test(text);
  const out = explicitOut ? true : explicitIn ? false : true;
  const hand: 'L' | 'R' = /\bleft\b/.test(text) ? 'L' : 'R';
  return { leaves, out, hand };
}

/** True when a node was built here rather than read from a file. */
export function isSynthesized(node: RVNode): boolean {
  return node.headerOverride != null && node.trailerOverride != null && node.span.tagAt === 0;
}
