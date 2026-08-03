/**
 * Room Viewer document decoder.
 *
 * Class layouts here were recovered by analysing the file corpus, because MFC
 * archives carry no field metadata. Everything below is expressed in terms of
 * three observed shapes:
 *
 *   Common prefix (all classes, 20 bytes)
 *     int32  version            always 1
 *     CRect  bounds             4 × int32, logical units
 *
 *   Containers (+8 bytes, then `childCount` nested objects, then a trailer)
 *     WORD   listVersion, WORD flag, WORD reserved, WORD childCount
 *
 *   Segments (+42/+46 bytes, then `n` points as pairs of doubles)
 *     WORD   kind             0 = line, 1 = arc, 2 = rect, 3 = poly
 *     int32  vertexHint       point count for lines/polys, a param count otherwise
 *     ... pen/brush/style block ...
 *     DWORD  color            COLORREF (0x00BBGGRR)
 *
 * Logical units are tenths of an inch: an "8' Circle" shape measures 958 units
 * across, i.e. 95.8in ≈ 8ft. `UNITS_PER_INCH` below is the conversion the UI
 * uses for its rulers and readouts.
 */

import { ArchiveReader, ArchiveError, type Rect } from './mfc.js';
import { decodeTrailer, isTrailerAt } from './trailer.js';

export { UNITS_PER_INCH, UNITS_PER_FOOT } from './constants.js';

/** Classes that hold a counted child list. */
const CONTAINER_CLASSES = new Set([
  'RVRoomDef',
  'RVRoom',
  'RVRegion',
  'RVWalls',
  'RVGeometry',
  'RVRoomFeature',
  'RVTable',
  'RVChair',
  'RVRiserSection',
  'RVAVItem',
  'RVProjector',
  'RVScreen',
  'RVMisc',
  'RVDanceFloorSection',
  'RVTableAndChairBanquet',
  'RVTableAndChairSchoolroom',
]);

/**
 * Classes storing a point array of doubles rather than children.
 *
 * `RVDimensionLine` is structurally a segment: same pen/colour block, two
 * points, then a four-byte trailer holding the arrowhead style.
 */
const SEGMENT_CLASSES = new Set([
  'RVSegmentLine',
  'RVSegmentRect',
  'RVSegmentArc',
  'RVSegmentPoly',
  'RVSegmentOle',
  'RVDimensionLine',
]);

/**
 * Smallest observed gap between the common prefix and the point array, and how
 * far past it the array can start.
 *
 * The pen/brush block is not a fixed size — the same `RVSegmentRect` class
 * begins its points at +62 in a shape inventory and +70 inside a floor plan — so
 * the parser searches this window for the alignment that fits a whole number
 * of plausible coordinate pairs (see `locatePointArray`).
 */
const SEGMENT_POINTS_MIN_OFFSET = 62;
const SEGMENT_POINTS_SEARCH_BYTES = 32;

/** Fixed point counts by segment kind; polylines carry theirs in `vertexHint`. */
const FIXED_POINT_COUNT: Record<string, number | null> = {
  RVSegmentLine: 2,
  RVSegmentRect: 4,
  RVSegmentArc: 8,
  RVDimensionLine: 2,
  RVSegmentPoly: null,
  RVSegmentOle: null,
};

export interface Point {
  x: number;
  y: number;
}

/**
 * Room Viewer works in tenths of an inch, so even a stadium floor plan stays
 * well inside ±10^7 units (≈83,000 ft). Values outside that range mean the
 * cursor has drifted out of the point array and into another field.
 *
 * The low cutoff only exists to reject denormals, which is what misaligned
 * reads produce. It must stay far below any real coordinate: a circle's
 * topmost point lands on y = 1e-14 rather than exactly zero, and a cutoff
 * anywhere near that truncates every round table to a semicircle.
 */
const COORDINATE_LIMIT = 1e7;
const DENORMAL_CUTOFF = 1e-100;

function isPlausibleCoordinate(v: number): boolean {
  if (!Number.isFinite(v) || Math.abs(v) > COORDINATE_LIMIT) return false;
  return v === 0 || Math.abs(v) >= DENORMAL_CUTOFF;
}

/**
 * One entry in an object's original child sequence.
 *
 * Writing a file back requires reproducing the sequence exactly, including
 * slots that carry no geometry: a back-reference to shared furniture, or a
 * reference to an enclosing object that the parser refuses to follow. Both
 * still occupy a slot the parent's child count includes.
 */
export interface RVChildSlot {
  kind: 'object' | 'ref' | 'null';
  node: RVNode | null;
  /** Load-array index the source used, for `ref` slots. */
  sourceIndex?: number;
  /**
   * Target of a reference the parser declined to traverse.
   *
   * A parent pointer names an enclosing object, so following it would build a
   * cycle — but the pointer still has to be written back, and writing the
   * source's literal index only survives while indices do not move. Inserting
   * an object ahead of the target renumbers it, so the target is recorded here
   * and re-resolved at write time. It is deliberately kept out of `node` and
   * `children` so no traversal ever descends through it.
   */
  refTarget?: RVNode;
}

/**
 * Byte ranges an object occupied in the source stream.
 *
 * `header` and `trailer` are re-emitted verbatim when saving, so fields the
 * parser never interpreted survive a round trip untouched.
 */
export interface RVSpan {
  /** Offset of the object's tag. */
  tagAt: number;
  /** Offset of the first body byte, after the tag. */
  bodyAt: number;
  /** End of the object's own fields — where its first child begins. */
  headerEnd: number;
  /** Start of any bytes following the last child. */
  trailerAt: number;
  /** One past the object's last byte. */
  end: number;
}

export interface RVNode {
  /** Stable identifier for this parse, used to address objects when editing. */
  id: number;
  /** MFC class name, e.g. `RVSegmentLine`. */
  cls: string;
  schema: number;
  /** Byte offset the object started at — useful when diagnosing a bad parse. */
  offset: number;
  /** Byte ranges this object occupied, for round-trip-safe saving. */
  span: RVSpan;
  /** True when the source introduced this object's class inline. */
  newClass: boolean;
  /** Original child sequence, including reference and null slots. */
  slots: RVChildSlot[];
  version: number;
  bounds: Rect;
  /** Segment geometry, in logical units. Empty for containers. */
  points: Point[];
  /** Segment kind code (0 line, 1 arc, 2 rect, 3 poly), when applicable. */
  kind?: number;
  /** Rotation in radians, for placed shapes and labels. */
  angle?: number;
  /** Label drawn in a bold face. */
  bold?: boolean;
  /** COLORREF as 0x00BBGGRR, when applicable. */
  color?: number;
  /** Strings recovered from the object body (shape name, label text). */
  labels: string[];
  children: RVNode[];
  /** Absolute stream offsets of fields an edit may rewrite. */
  fields: RVFieldOffsets;
  /**
   * Replacement header bytes once this object has been edited.
   *
   * Editing never rebuilds an object from the fields we understand — it copies
   * the original bytes and patches the ones it means to change, so unmodelled
   * fields survive.
   */
  headerOverride?: Buffer;
  /**
   * Replacement trailer bytes, for objects imported from another file.
   *
   * A node normally re-emits its trailer from the document it was parsed from.
   * One brought in from a shape inventory has no bytes in this document, so it
   * carries both its header and its trailer with it.
   */
  trailerOverride?: Buffer;
}

/** Absolute offsets of editable fields, or undefined where a class has none. */
export interface RVFieldOffsets {
  /** The `CRect`, four int32s. */
  boundsAt: number;
  /** Insertion point of a placed shape or label: two doubles. */
  placementAt?: number;
  /** Rotation in radians, one double. */
  angleAt?: number;
  /** COLORREF, one uint32. */
  colorAt?: number;
  /** First coordinate pair of a segment. */
  pointsAt?: number;
  pointCount?: number;
  /** The child-count WORD at the end of a container's header. */
  childCountAt?: number;
  /** Length-prefixed label text: offset of the length byte, and its length. */
  textAt?: number;
  textLen?: number;
  /** Length-prefixed catalogue name of a placed shape. */
  nameAt?: number;
  nameLen?: number;
}

export interface ParseWarning {
  offset: number;
  message: string;
}

/**
 * A span of the stream at document level: either a decoded object or a run of
 * bytes kept verbatim (the container preamble, the trailing plan metadata, or
 * a region the parser could not attribute). Together the parts cover every
 * byte, which is what lets a file be written back unchanged.
 */
export type DocumentPart = { kind: 'node'; node: RVNode } | { kind: 'raw'; from: number; to: number };

export interface RVDocument {
  /** Top-level objects — normally a single `RVRoomDef`. */
  roots: RVNode[];
  /** Every byte of the stream, in order, as objects and verbatim runs. */
  parts: DocumentPart[];
  warnings: ParseWarning[];
  /** Bytes of the stream the parser accounted for. */
  bytesConsumed: number;
  bytesTotal: number;
  /** Document-level strings found in the trailer (plan name, shape name). */
  trailerStrings: string[];
  /** The archive body, retained so saving can re-emit unmodelled bytes. */
  source: Buffer;
  /** Offset of the first tag; everything before it is the container preamble. */
  archiveStart: number;
  /**
   * Next free object id.
   *
   * Ids must be allocated from the document, not from a snapshot of it: a
   * generator that places 200 chairs takes one index at the start, and deriving
   * ids from that stale snapshot hands every chair the same id.
   */
  nextId: number;
}

/**
 * Locates the next MFC object tag at or after `from`.
 *
 * Segments do not record their point count in a way that generalises across
 * kinds, so for those the parser brackets the point array by finding where the
 * next tag begins. Candidates must land on a whole-point boundary (16 bytes per
 * x/y pair), which makes false positives from double-precision byte patterns
 * essentially impossible.
 */
function findNextTag(r: ArchiveReader, from: number, stride: number): number {
  const buf = r.buf;
  for (let i = from; i + 2 <= buf.length; i += stride) {
    const tag = buf.readUInt16LE(i);

    if (tag === 0xffff) {
      if (i + 6 > buf.length) continue;
      const schema = buf.readUInt16LE(i + 2);
      const len = buf.readUInt16LE(i + 4);
      if (schema < 1 || schema > 16) continue;
      if (len < 3 || len > 48 || i + 6 + len > buf.length) continue;
      const name = buf.toString('latin1', i + 6, i + 6 + len);
      if (/^(RV|C)[A-Za-z0-9_]+$/.test(name)) return i;
      continue;
    }

    if ((tag & 0x8000) !== 0) {
      const idx = tag & 0x7fff;
      const entry = r.loadArray[idx - 1];
      if (entry && entry.kind === 'class') return i;
    }
  }
  return -1;
}

/**
 * Reads the Win32 `LOGFONT` a label carries: five 32-bit metrics, eight
 * single-byte style flags, then the face name as a length-prefixed string.
 * Recognising it is what makes a label's text field findable.
 */
function readLogFont(r: ArchiveReader, node: RVNode): void {
  r.i32(); // lfHeight — negative values are point sizes
  r.i32(); // lfWidth
  r.i32(); // lfEscapement
  r.i32(); // lfOrientation
  const weight = r.i32();
  r.skip(8); // italic, underline, strikeout, charset, precision, quality, pitch
  const face = r.cstring();
  if (face) node.labels.push(face);
  node.bold = weight >= 600;
}

/** Offset of an object's body given its tag position, or null for a reference. */
function bodyOffsetAt(r: ArchiveReader, pos: number): number | null {
  const buf = r.buf;
  if (pos + 2 > buf.length) return null;
  const tag = buf.readUInt16LE(pos);

  if (tag === 0xffff) {
    if (pos + 6 > buf.length) return null;
    const len = buf.readUInt16LE(pos + 4);
    return pos + 6 + len;
  }
  if ((tag & 0x8000) !== 0) return pos + 2;
  // A back-reference has no body of its own.
  return null;
}

/**
 * True when a real object begins at `pos`.
 *
 * Every Room Viewer object opens with a version field of 1 — 296,883 of the
 * 296,889 objects in the corpus, the six exceptions being misparses. Checking
 * it costs four bytes and settles cases where two candidate alignments both
 * end on a plausible class tag, which is otherwise the last ambiguity in
 * locating a segment's point array.
 */
function startsWithVersionOne(r: ArchiveReader, pos: number): boolean {
  const body = bodyOffsetAt(r, pos);
  if (body == null) return true;
  if (body + 4 > r.buf.length) return false;
  return r.buf.readInt32LE(body) === 1;
}

/**
 * True when `pos` holds a class tag — either a class introduced inline or a
 * reference to one already seen. Unlike a plain object reference, these cannot
 * plausibly be mistaken for data, so they make a reliable object boundary.
 */
function isStrongTagAt(r: ArchiveReader, pos: number): boolean {
  const buf = r.buf;
  if (pos + 2 > buf.length) return pos === buf.length;
  const tag = buf.readUInt16LE(pos);

  if (tag === 0xffff) return isValidTagAt(r, pos) && startsWithVersionOne(r, pos);
  if ((tag & 0x8000) === 0) return false;
  const entry = r.loadArray[(tag & 0x7fff) - 1];
  return !!entry && entry.kind === 'class' && startsWithVersionOne(r, pos);
}

/** True when `pos` holds any of the three MFC tag forms. */
function isValidTagAt(r: ArchiveReader, pos: number): boolean {
  const buf = r.buf;
  if (pos + 2 > buf.length) return pos === buf.length;
  const tag = buf.readUInt16LE(pos);

  if (tag === 0xffff) {
    if (pos + 6 > buf.length) return false;
    const schema = buf.readUInt16LE(pos + 2);
    const len = buf.readUInt16LE(pos + 4);
    if (schema < 1 || schema > 16) return false;
    if (len < 3 || len > 48 || pos + 6 + len > buf.length) return false;
    return /^(RV|C)[A-Za-z0-9_]+$/.test(buf.toString('latin1', pos + 6, pos + 6 + len));
  }

  if (tag === 0) return false;

  const idx = (tag & 0x8000) !== 0 ? (tag & 0x7fff) : tag;
  const entry = r.loadArray[idx - 1];
  if (!entry) return false;
  return (tag & 0x8000) !== 0 ? entry.kind === 'class' : entry.kind === 'object';
}

/**
 * True where an object may legitimately end.
 *
 * Normally that means another object begins here. The exception is the last
 * object in the file, which is followed by the document trailer — and a trailer
 * opens with a plain index, the one tag form that cannot be told from data, so
 * `isValidTagAt` rejects it. Without this the final wall segment had no
 * boundary to stop at and its point array was located by a heuristic that
 * happened to be right on real plans and wrong on ours. See `trailer.ts`.
 */
function isObjectEndAt(r: ArchiveReader, pos: number): boolean {
  return isValidTagAt(r, pos) || isTrailerAt(r.buf, pos);
}

/** The same, for the strong pass: a trailer is as unambiguous as a class tag. */
function isStrongEndAt(r: ArchiveReader, pos: number): boolean {
  return isStrongTagAt(r, pos) || isTrailerAt(r.buf, pos);
}

/**
 * Resolves the class name of the tag at `pos` without advancing the cursor or
 * mutating the load array. Used to decide whether a shape owns the object that
 * follows it.
 */
function peekTagClass(r: ArchiveReader, pos: number): string | null {
  const buf = r.buf;
  if (pos + 2 > buf.length) return null;
  const tag = buf.readUInt16LE(pos);

  if (tag === 0xffff) {
    if (pos + 6 > buf.length) return null;
    const len = buf.readUInt16LE(pos + 4);
    if (len < 1 || pos + 6 + len > buf.length) return null;
    return buf.toString('latin1', pos + 6, pos + 6 + len);
  }

  if ((tag & 0x8000) !== 0) {
    const entry = r.loadArray[(tag & 0x7fff) - 1];
    return entry && entry.kind === 'class' ? entry.name : null;
  }

  // A plain index is a back-reference to an existing object — the form shared
  // furniture geometry takes.
  const entry = r.loadArray[tag - 1];
  return entry && entry.kind === 'object' ? entry.name : null;
}

/**
 * Finds where a segment's coordinate pairs begin.
 *
 * The pen/brush block preceding the points varies in length between file kinds,
 * so instead of trusting a fixed offset the parser tries each 2-byte alignment
 * in the search window and keeps the one that yields the most whole coordinate
 * pairs, preferring the alignment that leaves the least trailing slack. Real
 * coordinates are tightly constrained (see `isPlausibleCoordinate`), which is
 * what makes the search unambiguous — a misalignment reads exponent bytes as
 * mantissa and produces denormals or astronomically large values.
 */
function locatePointArray(
  buf: Buffer,
  windowStart: number,
  end: number,
): { start: number; count: number } | null {
  let best: { start: number; count: number; slack: number } | null = null;

  for (let s = windowStart; s <= windowStart + SEGMENT_POINTS_SEARCH_BYTES; s += 2) {
    const span = end - s;
    if (span < 16) break;

    const capacity = Math.floor(span / 16);
    let count = 0;
    for (let i = 0; i < capacity; i++) {
      const at = s + i * 16;
      if (at + 16 > buf.length) break;
      if (!isPlausibleCoordinate(buf.readDoubleLE(at))) break;
      if (!isPlausibleCoordinate(buf.readDoubleLE(at + 8))) break;
      count++;
    }
    if (count === 0) continue;

    const slack = span - count * 16;
    if (!best || count > best.count || (count === best.count && slack < best.slack)) {
      best = { start: s, count, slack };
    }
  }

  return best ? { start: best.start, count: best.count } : null;
}

/** Pulls printable length-prefixed strings out of a body/trailer byte range. */
function harvestStrings(buf: Buffer, start: number, end: number): string[] {
  const out: string[] = [];
  for (let i = start; i < end; i++) {
    const len = buf[i];
    if (len < 3 || len > 64 || i + 1 + len > end) continue;
    const s = buf.toString('latin1', i + 1, i + 1 + len);
    if (!/^[\x20-\x7e]+$/.test(s)) continue;
    if (!/[A-Za-z]{2}/.test(s)) continue;
    out.push(s);
    i += len;
  }
  return out;
}

class DocumentParser {
  readonly warnings: ParseWarning[] = [];
  private depth = 0;
  /**
   * Objects by load-array index.
   *
   * Repeated furniture is serialized once and then referenced by index: a room
   * with 105 identical chairs writes one `RVGeometry` outline and 105 shapes
   * that point at it. Dropping those references loses most of the plan, so
   * back-references resolve to the original node and are re-drawn at each
   * owner's own position.
   */
  private readonly objects = new Map<number, RVNode>();
  /**
   * Objects whose child lists are still being read.
   *
   * A back-reference may legitimately point at a sibling, but some files
   * reference an object that is still open — an ancestor — which would turn
   * the tree into a cycle and make any later traversal run forever. Those
   * references are dropped.
   */
  private readonly open = new Set<RVNode>();
  private nextId = 1;

  constructor(private readonly r: ArchiveReader) {}

  /** The id the next object would take, used to seed the document's counter. */
  peekNextId(): number {
    return this.nextId;
  }

  private warn(offset: number, message: string): void {
    if (this.warnings.length < 200) this.warnings.push({ offset, message });
  }

  /** Reads one object, returning it as the child slot it occupies. */
  readObject(): RVNode | null {
    return this.readSlot().node;
  }

  /** Reads one slot of a child sequence (tag already pending at the cursor). */
  readSlot(): RVChildSlot {
    const r = this.r;
    const tag = r.readTag();

    if (tag.kind === 'null') return { kind: 'null', node: null };
    if (tag.kind === 'backref') {
      // A shared instance referenced again; it carries no payload of its own.
      const existing = this.objects.get(tag.index);
      // A reference back to a still-open ancestor is a parent pointer, not
      // content — Room Viewer writes one from a room's child list to the room
      // itself. Following it would build a cycle, and it draws nothing, so it
      // is kept as a reference slot (saving must reproduce it) but not
      // traversed.
      const cyclic = !!existing && this.open.has(existing);
      return {
        kind: 'ref',
        node: cyclic ? null : (existing ?? null),
        sourceIndex: tag.index,
        refTarget: cyclic ? existing : undefined,
      };
    }

    const slot = r.registerObject(tag.name);
    const start = r.pos;
    const version = r.i32();
    const bounds = r.rect();

    const node: RVNode = {
      id: this.nextId++,
      cls: tag.name,
      schema: tag.schema,
      offset: tag.offset,
      span: { tagAt: tag.offset, bodyAt: start, headerEnd: start, trailerAt: start, end: start },
      newClass: tag.newClass,
      slots: [],
      version,
      bounds,
      points: [],
      labels: [],
      children: [],
      fields: { boundsAt: start + 4 },
    };
    this.objects.set(slot, node);
    this.open.add(node);

    try {
      if (SEGMENT_CLASSES.has(tag.name)) {
        this.readSegmentBody(node, start);
      } else if (CONTAINER_CLASSES.has(tag.name)) {
        this.readContainerBody(node, start);
      } else if (tag.name === 'RVShape' || tag.name === 'RVLabel') {
        this.readAnnotatedBody(node, start);
      } else {
        // Unknown class: fall back to bracketing it by the next tag so the rest
        // of the document still parses, and salvage any geometry inside.
        this.readUnknownBody(node);
      }
    } finally {
      this.open.delete(node);
    }

    node.span.end = r.pos;
    // Leaves have no children, so everything they consumed is their header.
    if (node.slots.length === 0) {
      node.span.headerEnd = r.pos;
      node.span.trailerAt = r.pos;
    }

    return { kind: 'object', node };
  }

  /**
   * `RVShape` and `RVLabel` share a placement block — an insertion point, a
   * second reference point, and a rotation in radians — followed by
   * class-specific fields and length-prefixed strings.
   *
   * These two must be decoded exactly rather than bracketed by a tag search,
   * because what follows a shape is usually a *back-reference* to shared
   * geometry, and a back-reference is a small integer that no byte scan can
   * reliably distinguish from padding. Each layout is therefore parsed field by
   * field and then verified: if the cursor does not land on a valid tag, the
   * parser falls back to scanning rather than trusting a bad decode.
   */
  private readAnnotatedBody(node: RVNode, start: number): void {
    const r = this.r;
    r.u16();
    r.u16();
    r.u16();

    const x1 = r.f64();
    const y1 = r.f64();
    const x2 = r.f64();
    const y2 = r.f64();
    const angle = r.f64();

    if (Number.isFinite(x1) && Number.isFinite(y1)) node.points.push({ x: x1, y: y1 });
    if (Number.isFinite(x2) && Number.isFinite(y2)) node.points.push({ x: x2, y: y2 });
    if (Number.isFinite(angle)) node.angle = angle;

    node.fields.placementAt = start + 26;
    node.fields.angleAt = start + 58;

    const afterPlacement = r.pos;
    let exact = false;

    try {
      if (node.cls === 'RVShape') {
        r.i32();
        r.cstring();
        const nameAt = r.pos;
        const name = r.cstring();
        if (name) {
          node.labels.push(name);
          node.fields.nameAt = nameAt;
          node.fields.nameLen = name.length;
        }
      } else {
        r.i32();
        readLogFont(r, node);
        const textAt = r.pos;
        const text = r.cstring();
        if (text) {
          node.labels.push(text);
          node.fields.textAt = textAt;
          node.fields.textLen = text.length;
        }
        r.u32(); // text colour
        r.i32();
        r.f64();
        r.f64();
        r.f64();
        r.f64();
        r.i32();
        r.f64();
      }
      exact = isObjectEndAt(r, r.pos);
    } catch {
      exact = false;
    }

    if (!exact) {
      // Layout variant we do not model — recover the strings and resynchronise.
      // Field offsets from the failed attempt must not be kept: editing them
      // would write into bytes whose meaning is unknown.
      r.pos = afterPlacement;
      node.labels.length = 0;
      node.fields.textAt = undefined;
      node.fields.textLen = undefined;
      node.fields.nameAt = undefined;
      node.fields.nameLen = undefined;
      const next = findNextTag(r, r.pos, 1);
      const stop = next === -1 ? r.buf.length : next;
      node.labels.push(...harvestStrings(r.buf, r.pos, stop));
      r.pos = stop;
    }
    void start;

    if (node.cls === 'RVShape' && peekTagClass(r, r.pos) === 'RVGeometry') {
      node.span.headerEnd = r.pos;
      const child = this.readObject();
      if (child) {
        node.children.push(child);
        node.slots.push({ kind: 'object', node: child });
      }
      node.span.trailerAt = r.pos;
    }
  }

  private readSegmentBody(node: RVNode, start: number): void {
    const r = this.r;

    node.kind = r.u16();
    const vertexHint = r.i32();
    // The pen/brush/style block follows; the COLORREF sits at a fixed +34.
    const colorAt = start + 20 + 34;
    if (colorAt + 4 <= r.buf.length) node.color = r.buf.readUInt32LE(colorAt);

    void vertexHint;
    const windowStart = start + SEGMENT_POINTS_MIN_OFFSET;
    const found = this.locateSegmentPoints(node, windowStart);

    if (found) {
      r.pos = found.start;
      node.fields.pointsAt = found.start;
      node.fields.pointCount = found.count;
      node.fields.colorAt = start + 54;
      for (let i = 0; i < found.count; i++) {
        node.points.push({ x: r.f64(), y: r.f64() });
      }
      // Anything after the points is a per-kind trailer — but the *document*
      // trailer is not the segment's, and swallowing it is what left every
      // plan without a readable name.
      if (!isObjectEndAt(r, r.pos)) {
        const next = findNextTag(r, r.pos, 1);
        if (next !== -1) r.pos = next;
        else r.pos = r.buf.length;
      }
      return;
    }

    const expected = FIXED_POINT_COUNT[node.cls];
    if (expected) {
      this.warn(start, `${node.cls}: expected ${expected} points but found no plausible coordinates`);
    }
    const next = findNextTag(r, windowStart, 1);
    r.pos = next === -1 ? r.buf.length : next;
  }

  /**
   * Finds a segment's point array and its length.
   *
   * The end of the array must land exactly on a valid tag. That check is what
   * makes this correct: scanning forward for the *next* tag cannot see a plain
   * object back-reference — a small integer indistinguishable from padding — so
   * a segment followed by shared furniture used to swallow it whole, losing
   * that object and shifting every later load-array index.
   *
   * Counts come from two places: fixed shapes (a line has two points, a rect
   * four, an arc eight) and polylines, which prefix their array with a 16-bit
   * element count four bytes ahead of the points.
   */
  private locateSegmentPoints(node: RVNode, windowStart: number): { start: number; count: number } | null {
    const r = this.r;
    const buf = r.buf;
    const expected = FIXED_POINT_COUNT[node.cls];

    const pairsPlausible = (at: number, n: number): boolean => {
      if (at + n * 16 > buf.length) return false;
      for (let i = 0; i < n; i++) {
        if (!isPlausibleCoordinate(buf.readDoubleLE(at + i * 16))) return false;
        if (!isPlausibleCoordinate(buf.readDoubleLE(at + i * 16 + 8))) return false;
      }
      return true;
    };

    // Two passes. A boundary landing on a class tag is strong evidence, because
    // those byte patterns do not occur by chance. A plain object reference is
    // only a small integer, so an alignment can appear valid when it is not —
    // accept those only when nothing stronger fits.
    for (const requireStrongBoundary of [true, false]) {
      for (let s = windowStart; s <= windowStart + SEGMENT_POINTS_SEARCH_BYTES; s += 2) {
        const counts: number[] = [];
        if (expected != null) counts.push(expected);
        if (s - 4 >= 0 && s - 2 <= buf.length) {
          const declared = buf.readUInt16LE(s - 4);
          if (declared > 0 && declared <= 8192 && declared !== expected) counts.push(declared);
        }

        for (const n of counts) {
          const boundary = s + n * 16;
          if (!pairsPlausible(s, n)) continue;
          if (!isObjectEndAt(r, boundary)) continue;
          if (requireStrongBoundary && !isStrongEndAt(r, boundary)) continue;
          return { start: s, count: n };
        }
      }
    }

    // Nothing validated — fall back to the widest plausible run so geometry is
    // still recovered, even though the object boundary is uncertain.
    const next = findNextTag(r, windowStart, 1);
    const end = next === -1 ? buf.length : next;
    return locatePointArray(buf, windowStart, end);
  }

  private readContainerBody(node: RVNode, start: number): void {
    const r = this.r;
    r.u16(); // list version
    r.u16(); // flag
    r.u16(); // reserved
    const childCount = r.u16();
    node.fields.childCountAt = r.pos - 2;

    if (childCount > 20000) {
      this.warn(start, `${node.cls}: implausible child count ${childCount}`);
      this.readUnknownBody(node);
      return;
    }

    if (this.depth > 64) {
      this.warn(start, `${node.cls}: nesting deeper than 64, stopping descent`);
      return;
    }

    node.span.headerEnd = r.pos;

    this.depth++;
    try {
      for (let i = 0; i < childCount; i++) {
        if (r.eof) {
          this.warn(r.pos, `${node.cls}: stream ended after ${i}/${childCount} children`);
          break;
        }
        const at = r.pos;
        try {
          const slot = this.readSlot();
          node.slots.push(slot);
          if (slot.node && slot.kind === 'object') node.children.push(slot.node);
          else if (slot.node) node.children.push(slot.node);
        } catch (err) {
          if (!(err instanceof ArchiveError)) throw err;
          this.warn(at, `${node.cls}: child ${i + 1}/${childCount} — ${err.message}`);
          const resume = findNextTag(r, Math.max(at + 2, r.pos), 1);
          if (resume === -1) break;
          r.pos = resume;
        }
      }
    } finally {
      this.depth--;
    }

    node.span.trailerAt = r.pos;

    // Objects may carry fields after their child list (name, seat counts).
    // When the next object follows immediately there is nothing to skip — and
    // scanning would step straight over a back-reference tag. The document
    // trailer ends the last container the same way.
    if (isObjectEndAt(r, r.pos)) return;

    const next = findNextTag(r, r.pos, 1);
    const stop = next === -1 ? r.buf.length : next;
    if (stop > r.pos) {
      node.labels.push(...harvestStrings(r.buf, r.pos, stop));
      r.pos = stop;
    }
  }

  private readUnknownBody(node: RVNode): void {
    const r = this.r;
    const next = findNextTag(r, r.pos, 1);
    const stop = next === -1 ? r.buf.length : next;
    node.labels.push(...harvestStrings(r.buf, r.pos, stop));
    r.pos = stop;
  }
}

/**
 * Parses a decompressed Room Viewer archive body.
 *
 * @param buf   the raw MFC stream
 * @param start byte offset of the first tag
 */
export function parseArchive(buf: Buffer, start: number): RVDocument {
  const r = new ArchiveReader(buf, start);
  const parser = new DocumentParser(r);
  const roots: RVNode[] = [];
  const parts: DocumentPart[] = [];

  // Everything before the first tag is container preamble, kept verbatim.
  let cursor = 0;

  const rawUpTo = (to: number) => {
    if (to > cursor) {
      parts.push({ kind: 'raw', from: cursor, to });
      cursor = to;
    }
  };

  while (!r.eof) {
    const before = r.pos;
    let node: RVNode | null = null;
    try {
      node = parser.readObject();
    } catch (err) {
      if (err instanceof ArchiveError) {
        parser.warnings.push({ offset: r.pos, message: err.message });
        // Resynchronise rather than abandoning the file: a single misread
        // object should cost one object, not the rest of the floor plan.
        const resume = findNextTag(r, Math.max(before + 2, r.pos), 1);
        if (resume === -1) break;
        r.pos = resume;
        continue;
      }
      throw err;
    }
    if (node) {
      rawUpTo(node.span.tagAt);
      parts.push({ kind: 'node', node });
      cursor = node.span.end;
      roots.push(node);
    }
    if (r.pos <= before) break;

    // Anything left is the document trailer, not another root object.
    const next = findNextTag(r, r.pos, 1);
    if (next === -1) break;
    r.pos = next;
  }

  // The document trailer: plan name, ceiling notes, saved defaults.
  rawUpTo(buf.length);

  // The trailer is a record with named slots, not a bag of strings to sift for
  // anything printable. Decoding it keeps the empty slots, which is what makes
  // "slot 2 is the event" mean something. `harvestStrings` remains the answer
  // for a tail that is not a trailer — a shape library ends differently.
  const trailerStrings =
    r.pos < buf.length
      ? (decodeTrailer(buf, r.pos) ?? harvestStrings(buf, r.pos, buf.length))
      : [];

  return {
    roots,
    parts,
    warnings: parser.warnings,
    bytesConsumed: r.pos - start,
    bytesTotal: buf.length - start,
    trailerStrings,
    source: buf,
    archiveStart: start,
    nextId: parser.peekNextId(),
  };
}

/**
 * Walks every distinct node in a document depth-first.
 *
 * Shared geometry is yielded once. Callers that need one visit per *placement*
 * — anything that positions objects in the room — must use `buildScene`, which
 * carries the transform for each reference.
 */
export function* walk(doc: RVDocument): Generator<RVNode> {
  const stack = [...doc.roots].reverse();
  const seen = new Set<RVNode>();
  while (stack.length) {
    const n = stack.pop()!;
    if (seen.has(n)) continue;
    seen.add(n);
    yield n;
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
  }
}
