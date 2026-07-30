/**
 * A new plan, from nothing.
 *
 * Until objects could be synthesized this was not possible at all. Every
 * operation in the app worked by cloning something the open file already
 * contained, so a file with nothing in it was a file nothing could be done to —
 * which is why Groundplan could only ever open a plan somebody else had drawn.
 *
 * A blank plan is a real Room Viewer document: an OLE compound file with the
 * archive in its `Contents` stream, holding an `RVRoomDef`, an `RVWalls`
 * container, and optionally a room. It opens in Room Viewer like any other
 * file, and it passes the same round-trip gate every other plan has to pass
 * before it can be saved.
 */

import CFB from 'cfb';

import { addRoot, appendChild } from './edit.js';
import { rectangularRoom } from './room.js';
import { applyRoom } from './room-render.js';
import { UNITS_PER_FOOT, type RVDocument } from './rv.js';
import { createContainer } from './synthesize.js';
import { serializeArchive, verifyWritable } from './write.js';

/**
 * `COleDocument` writes three DWORDs before the archive proper. The reader
 * searches past them for the first tag, so a file without them would still
 * open — they are here because the point of a new plan is that it should be
 * indistinguishable from an old one.
 */
const OLE_PREAMBLE_BYTES = 12;

/** An empty document, ready to have objects added to it. */
function emptyDocument(): RVDocument {
  return {
    roots: [],
    parts: [],
    warnings: [],
    bytesConsumed: 0,
    bytesTotal: 0,
    trailerStrings: [],
    // Nothing is read from a source, because there is no source: every object a
    // blank plan contains carries its own bytes.
    source: Buffer.alloc(0),
    archiveStart: 0,
    nextId: 1,
  };
}

export interface BlankPlanOptions {
  /** Draw a rectangular room, in logical units. Omit for an empty sheet. */
  room?: { width: number; depth: number };
  /** Name for the room. */
  roomName?: string;
}

export interface BlankPlanResult {
  ok: boolean;
  reason?: string;
  /** A complete `.rv4`, ready to write. */
  file?: Buffer;
}

/**
 * Builds a new plan.
 *
 * Verified before it is returned: the document is written, read back, and
 * required to reproduce itself exactly. Handing somebody a new plan they cannot
 * save would be a cruel thing to do, and the check costs a millisecond.
 */
export function createBlankPlan(options: BlankPlanOptions = {}): BlankPlanResult {
  const doc = emptyDocument();

  // Every Room Viewer plan is rooted in a room definition; it is what the app
  // hangs walls, furniture and annotation off.
  const roomDef = createContainer(doc, { cls: 'RVRoomDef' });
  if (!roomDef.ok || !roomDef.node) return { ok: false, reason: roomDef.reason };
  if (!addRoot(doc, roomDef.node).ok) return { ok: false, reason: 'the room definition could not be added' };

  // A wall container, so the first room drawn has somewhere to go that reads
  // back as walls rather than as furniture.
  const walls = createContainer(doc, { cls: 'RVWalls' });
  if (!walls.ok || !walls.node) return { ok: false, reason: walls.reason };
  if (!appendChild(doc, roomDef.node, walls.node).ok) {
    return { ok: false, reason: 'the wall container could not be added' };
  }

  if (options.room) {
    const { width, depth } = options.room;
    if (!(width > 0) || !(depth > 0)) return { ok: false, reason: 'a room needs a width and a depth' };
    if (width > 2000 * UNITS_PER_FOOT || depth > 2000 * UNITS_PER_FOOT) {
      return { ok: false, reason: 'that is larger than any room this format holds' };
    }
    const drawn = applyRoom(doc, rectangularRoom(width, depth, options.roomName ?? 'Room'));
    if (!drawn.ok) return { ok: false, reason: drawn.reason };
  }

  const verdict = verifyWritable(doc);
  if (!verdict.ok) return { ok: false, reason: verdict.reason };

  const body = Buffer.concat([Buffer.alloc(OLE_PREAMBLE_BYTES), serializeArchive(doc)]);
  const compound = CFB.utils.cfb_new();
  CFB.utils.cfb_add(compound, 'Contents', body);

  return { ok: true, file: Buffer.from(CFB.write(compound, { type: 'buffer' }) as Uint8Array) };
}

/**
 * Room sizes offered when starting a plan, in feet.
 *
 * The sizes a venue actually books, so the common case is one click rather than
 * two measurements.
 */
export const ROOM_PRESETS: Array<{ label: string; width: number; depth: number }> = [
  { label: 'Empty sheet', width: 0, depth: 0 },
  { label: "Meeting room — 30' × 20'", width: 30, depth: 20 },
  { label: "Small ballroom — 40' × 30'", width: 40, depth: 30 },
  { label: "Ballroom — 60' × 40'", width: 60, depth: 40 },
  { label: "Large ballroom — 100' × 60'", width: 100, depth: 60 },
  { label: "General session — 150' × 80'", width: 150, depth: 80 },
  { label: "Exhibit hall — 250' × 120'", width: 250, depth: 120 },
];
