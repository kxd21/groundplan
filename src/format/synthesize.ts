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

/** Container body layout: the common prefix, then the counted list header. */
const CONTAINER_LIST_VERSION = 20;
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

/** A synthesized node owns its bytes outright, so its span starts at zero. */
function ownSpan(headerBytes: number): RVSpan {
  return { tagAt: 0, bodyAt: 0, headerEnd: headerBytes, trailerAt: headerBytes, end: headerBytes };
}

/**
 * The schema number written next to a class name the first time it appears.
 *
 * Every `RV*` class in the corpus is schema 1. Where the open document already
 * introduced the class, its number is reused so a file that already contains
 * the class keeps writing the same value.
 */
function schemaFor(doc: RVDocument, cls: string): number {
  for (const node of walk(doc)) {
    if (node.cls === cls) return node.schema;
  }
  return 1;
}

export interface SegmentSpec {
  cls: SynthesizableSegment;
  /** Coordinates in logical units (tenths of an inch). */
  points: Point[];
  /** COLORREF as 0x00BBGGRR. Defaults to black. */
  color?: number;
  /** Cached rect. Computed from the points when omitted. */
  bounds?: Rect;
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

  const style = borrowStyle(doc, spec.cls);
  const bounds = spec.bounds ?? boundsOf(spec.points);
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
}

/**
 * Builds an empty counted container.
 *
 * Containers are the one shape with no undecoded block: a common prefix, a list
 * version, two words that are zero in every file examined, and a child count.
 * Nothing is borrowed because there is nothing left over to borrow.
 */
export function createContainer(doc: RVDocument, spec: ContainerSpec): SynthesisResult {
  const bounds = spec.bounds ?? { left: 0, top: 0, right: 0, bottom: 0 };
  const header = Buffer.alloc(CONTAINER_HEADER_BYTES);

  header.writeInt32LE(1, 0);
  header.writeInt32LE(bounds.left, 4);
  header.writeInt32LE(bounds.top, 8);
  header.writeInt32LE(bounds.right, 12);
  header.writeInt32LE(bounds.bottom, 16);
  header.writeUInt16LE(1, CONTAINER_LIST_VERSION);
  header.writeUInt16LE(0, CONTAINER_CHILD_COUNT);

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
    bold: fontBlock.readInt32LE(16) >= 600,
    labels: face ? [face, text] : [text],
    children: [],
    fields: {
      boundsAt: 4,
      placementAt: LABEL_PLACEMENT,
      angleAt: LABEL_ANGLE,
      textAt,
      textLen: encoded.length,
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
  outline: Point[][];
  color?: number;
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
  const outline = spec.outline.filter((run) => run.length >= 2);
  if (!outline.length) return { ok: false, reason: 'a shape needs at least one outline run' };

  // Build the geometry first: a failure part-way leaves nothing attached.
  let local: Rect = { left: 0, top: 0, right: 0, bottom: 0 };
  const segments: RVNode[] = [];
  for (const run of outline) {
    const built = createSegment(doc, {
      cls: run.length === 2 ? 'RVSegmentLine' : 'RVSegmentPoly',
      points: run,
      color: spec.color,
    });
    if (!built.ok || !built.node) return { ok: false, reason: built.reason };
    segments.push(built.node);
  }

  const all = outline.flat();
  local = boundsOf(all);

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

/** True when a node was built here rather than read from a file. */
export function isSynthesized(node: RVNode): boolean {
  return node.headerOverride != null && node.trailerOverride != null && node.span.tagAt === 0;
}
