/**
 * Reading Room Viewer's shape libraries.
 *
 * A plan names the shapes it places — "Chair 20.5W X 23.23D", "Pipe and Drape"
 * — but does not always carry their outlines. The outlines live in the
 * libraries that shipped with the editor: `.stk` stock shapes, `.add` add-on
 * catalogues, `.lib` user libraries. Without them a plan's catalogue items have
 * a name, a footprint and nothing to draw.
 *
 * These files are "counted inventory" archives: a count, then that many
 * top-level objects. Each object is a definition typed by its class — `RVChair`,
 * `RVTable`, `RVScreen`, `RVProjector`, `RVAVItem`, `RVRiserSection`,
 * `RVRoomFeature`, `RVMisc` — rather than the `RVShape` a plan uses for a
 * placement.
 *
 * The name is not inside the object. It follows it:
 *
 *     [object body]
 *     u32   version        4 in the stock and user libraries, 2 in the add-ons
 *     u32   category       0 table, 1 chair, 2 riser, 7 room feature, ...
 *     CString name         MFC: a length byte, then latin-1 characters
 *     ...                  per-entry metadata this does not need to read
 *
 * The record is recognised by its shape rather than by that leading number,
 * which is a version and not a constant — reading it as one found the stock
 * libraries and silently skipped every add-on catalogue.
 *
 * Verified against the seven libraries on the production drive.
 */

import type { RVDocument, RVNode } from './rv.js';
import type { OutlineRun } from './synthesize.js';

/** Version numbers seen in the record header; anything wilder is not a record. */
const MAX_RECORD_VERSION = 16;
/** Category codes are small; a large one means these bytes are not a record. */
const MAX_CATEGORY = 64;
/** How far past a definition to look for its record before giving up. */
const SEARCH_WINDOW = 16;

export interface LibraryEntry {
  name: string;
  /** The definition itself, ready to be copied into a plan. */
  node: RVNode;
  /** Room Viewer's category code, kept because it is what the file says. */
  category: number;
  /** MFC class the definition is stored as, e.g. `RVChair`. */
  cls: string;
}

/**
 * Reads an MFC `CString`.
 *
 * Lengths escape upward: a byte, unless it is 0xFF, in which case a word,
 * unless that is 0xFFFF, in which case a dword.
 */
function readCString(buf: Buffer, at: number): { text: string; end: number } | null {
  if (at >= buf.length) return null;
  let length = buf.readUInt8(at);
  let cursor = at + 1;

  if (length === 0xff) {
    if (cursor + 2 > buf.length) return null;
    length = buf.readUInt16LE(cursor);
    cursor += 2;
    if (length === 0xffff) {
      if (cursor + 4 > buf.length) return null;
      length = buf.readUInt32LE(cursor);
      cursor += 4;
    }
  }

  if (length === 0 || cursor + length > buf.length) return null;
  return { text: buf.toString('latin1', cursor, cursor + length), end: cursor + length };
}

/**
 * Finds an entry's trailing record at or just after a definition ends.
 *
 * Usually it begins exactly where the object stops. For a handful of AV items
 * it begins eight bytes later — the parser leaves one trailing double
 * unattributed on those, and reading only at the exact end lost their names
 * ("Genie Lift - Right", "Video Camera (SV)") while every neighbour worked.
 * Scanning a short window absorbs that without touching the parser, whose
 * byte-exact round-trip must not be disturbed to read a catalogue.
 */
function recordAfter(doc: RVDocument, from: number): { name: string; category: number } | null {
  const limit = Math.min(from + SEARCH_WINDOW, doc.source.length - 9);
  for (let at = from; at <= limit; at++) {
    const version = doc.source.readUInt32LE(at);
    if (version === 0 || version > MAX_RECORD_VERSION) continue;
    const category = doc.source.readUInt32LE(at + 4);
    if (category > MAX_CATEGORY) continue;

    const name = readCString(doc.source, at + 8);
    if (!name) continue;

    // Bytes that happen to parse as a length and some characters are not a
    // name. Requiring the whole run to be printable is what separates a real
    // record from a coincidence in a file that has none.
    const text = name.text.trim();
    if (!text || !/^[\x20-\x7e]+$/.test(text)) continue;
    return { name: text, category };
  }
  return null;
}

/**
 * Lists the named definitions in a library document.
 *
 * Returns nothing for a plan, which has no such records — callers can therefore
 * try this first and fall back to reading placements.
 */
export function readLibrary(doc: RVDocument): LibraryEntry[] {
  const out: LibraryEntry[] = [];

  for (const root of doc.roots) {
    const found = recordAfter(doc, root.span.end);
    if (!found) continue;
    out.push({ name: found.name, node: root, category: found.category, cls: root.cls });
  }

  return out;
}

/** True when a document is a shape library rather than a plan. */
export function isLibrary(doc: RVDocument): boolean {
  return readLibrary(doc).length > 0;
}

/** Segment classes that carry drawable geometry. */
const DRAWABLE = new Set([
  'RVSegmentLine',
  'RVSegmentRect',
  'RVSegmentPoly',
  'RVSegmentArc',
]);

/**
 * Flattens a definition into outline runs centred on its insertion point.
 *
 * This is what turns a catalogue entry into something placeable: `createShape`
 * wants runs of points relative to where the item will sit, and a definition
 * holds them relative to its own rect.
 *
 * An arc contributes its last four points — the cubic the renderer draws — and
 * says so, rather than handing them over as an ordinary run. A run of four
 * points becomes a polyline, and a Bézier's control polygon is not its curve:
 * the two halves of an 8ft circle would have been redrawn as the two long sides
 * of a 16ft x 21ft box. Marking it `curve` is what lets the placement be
 * written back as a real `RVSegmentArc`.
 *
 * A rectangle says so for the same reason. It is the commonest primitive in
 * these files by a wide margin, and handing its four corners over unmarked made
 * every placed chair, riser and screen come back as an open `RVSegmentPoly` —
 * a different class, drawn unclosed and unfillable. The marker carries the
 * source class across; `rectangleCorners` in `synthesize.ts` then checks the
 * geometry before anything is written as a rect.
 */
export function libraryOutline(entry: LibraryEntry): OutlineRun[] {
  const cx = (entry.node.bounds.left + entry.node.bounds.right) / 2;
  const cy = (entry.node.bounds.top + entry.node.bounds.bottom) / 2;
  const runs: OutlineRun[] = [];
  const local = (points: Array<{ x: number; y: number }>) =>
    points.map((p) => ({ x: p.x - cx, y: p.y - cy }));

  const visit = (node: RVNode, depth = 0): void => {
    if (depth > 64) return;
    if (DRAWABLE.has(node.cls) && node.points.length >= 2) {
      if (node.cls === 'RVSegmentArc' && node.points.length >= 4) {
        runs.push({ curve: local(node.points.slice(-4)) });
      } else if (node.cls === 'RVSegmentRect' && node.points.length === 4) {
        runs.push({ rect: local(node.points) });
      } else {
        runs.push(local(node.points));
      }
    }
    for (const child of node.children) visit(child, depth + 1);
  };
  visit(entry.node);

  return runs;
}
