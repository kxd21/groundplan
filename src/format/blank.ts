/**
 * A new plan, from nothing.
 *
 * Until objects could be synthesized this was not possible at all. Every
 * operation in the app worked by cloning something the open file already
 * contained, so a file with nothing in it was a file nothing could be done to —
 * which is why Groundplan could only ever open a plan somebody else had drawn.
 *
 * What a plan *is* lives in `plan-skeleton.ts`, which measured it off the
 * corpus. This file is what remains once that knowledge moved out: the room
 * sizes the new-plan dialog offers, the validation on the one people type, and
 * the two gates a new file has to pass before anybody is handed it.
 */

import CFB from 'cfb';

import { dimensionRoom } from './dimension.js';
import { renderDimensions } from './dimension-render.js';
import { buildNewRoom, type NewRoomSpec } from './new-room.js';
import { createPlanDocument, setRoomRect, verifyPlanShape, wallExtent } from './plan-skeleton.js';
import { roomBounds, roomFromPolygon, type RoomModel } from './room.js';
import { applyRoom } from './room-render.js';
import { parseArchive, UNITS_PER_FOOT } from './rv.js';
import type { UnitSystem } from './units.js';
import { verifyWritable } from './write.js';

/** The largest room this format's coordinates hold, in feet. */
const MAX_ROOM_FEET = 2000;

export interface BlankPlanOptions {
  /** Draw a rectangular room, in logical units. Omit for an empty sheet. */
  room?: { width: number; depth: number };
  /** Advanced New Plan geometry: circles, recesses, rounding, and curved walls. */
  roomSpec?: NewRoomSpec;
  /**
   * Size the empty sheet for fit/zoom without drawing walls — used by custom
   * room tracing so the canvas opens around the intended venue footprint.
   */
  sheetSize?: { width: number; depth: number };
  /** Name for the room. Stored where Room Viewer reads it, not just alongside. */
  roomName?: string;
  /** Date, venue, event and contact, written into the document trailer. */
  identity?: { date?: string; venue?: string; event?: string; contact?: string };
  /** Add buildable wall/radius dimensions to the initial drawing. */
  autoDimensions?: UnitSystem;
}

export interface BlankPlanResult {
  ok: boolean;
  reason?: string;
  /** A complete `.rv4`, ready to write. */
  file?: Buffer;
}

/**
 * The four walls of a rectangular room, wound the way Room Viewer winds them.
 *
 * Centred on the origin, and starting at the bottom-left corner going right:
 * 236 of 246 corpus plans centre the wall extent on the origin in both axes,
 * and 234 of 246 wind the four segments bottom, right, top, left. Neither fact
 * changes what the room *is*, but a new plan may as well be the same shape as
 * an old one — that is the entire point of this subsystem.
 */
function rectangularWalls(width: number, depth: number, name: string) {
  const hw = width / 2;
  const hd = depth / 2;
  return roomFromPolygon(
    [
      { x: -hw, y: hd },
      { x: hw, y: hd },
      { x: hw, y: -hd },
      { x: -hw, y: -hd },
    ],
    name,
  );
}

/**
 * Builds a new plan.
 *
 * Verified twice before it is returned, because the two checks answer different
 * questions and the project only ever had the first:
 *
 *   - `verifyWritable` asks whether the document reproduces itself — written,
 *     reparsed, re-serialized byte for byte, same census, no new warnings. That
 *     is a property of our parser.
 *   - `verifyPlanShape` asks whether it is a Room Viewer plan — the five
 *     containers in the corpus order, one schema per class and the right one,
 *     the measured container list header, the measured preamble, a readable
 *     document trailer. That is a property of the format.
 *
 * Both run against the *reparsed* bytes, and those bytes are what gets packed.
 * Nothing is appended after verification: the old code verified the document and
 * then concatenated twelve zero bytes in front of it, so the only bytes that
 * reached disk unchecked were the only ones that were wrong.
 */
export function createBlankPlan(options: BlankPlanOptions = {}): BlankPlanResult {
  if (options.room) {
    const { width, depth } = options.room;
    if (!(width > 0) || !(depth > 0)) return { ok: false, reason: 'a room needs a width and a depth' };
    if (width > MAX_ROOM_FEET * UNITS_PER_FOOT || depth > MAX_ROOM_FEET * UNITS_PER_FOOT) {
      return { ok: false, reason: 'that is larger than any room this format holds' };
    }
  }
  if (options.sheetSize) {
    const { width, depth } = options.sheetSize;
    if (!(width > 0) || !(depth > 0)) return { ok: false, reason: 'the working size needs a width and a depth' };
    if (width > MAX_ROOM_FEET * UNITS_PER_FOOT || depth > MAX_ROOM_FEET * UNITS_PER_FOOT) {
      return { ok: false, reason: 'that is larger than any room this format holds' };
    }
  }

  const roomName = options.roomName ?? 'Room';
  let authoredRoom: RoomModel | undefined;
  if (options.roomSpec) {
    const advanced = buildNewRoom(options.roomSpec, roomName);
    if (!advanced.ok || !advanced.room) return { ok: false, reason: advanced.reason };
    authoredRoom = advanced.room;
  } else if (options.room) {
    authoredRoom = rectangularWalls(options.room.width, options.room.depth, roomName);
  }

  if (authoredRoom) {
    const bounds = roomBounds(authoredRoom);
    if (
      !bounds ||
      bounds.maxX - bounds.minX > MAX_ROOM_FEET * UNITS_PER_FOOT ||
      bounds.maxY - bounds.minY > MAX_ROOM_FEET * UNITS_PER_FOOT
    ) {
      return { ok: false, reason: 'that is larger than any room this format holds' };
    }
  }

  const built = createPlanDocument({
    identity: options.identity,
    defaults: { roomName },
  });
  if (!built.ok || !built.doc) return { ok: false, reason: built.reason };
  const doc = built.doc;

  if (authoredRoom) {
    const drawn = applyRoom(doc, authoredRoom);
    if (!drawn.ok) return { ok: false, reason: drawn.reason };
    const extent = wallExtent(doc);
    if (extent) {
      const sized = setRoomRect(doc, extent);
      if (!sized.ok) return { ok: false, reason: sized.reason };
    }

    if (options.autoDimensions) {
      const dimensions = renderDimensions(doc, dimensionRoom(authoredRoom, options.autoDimensions));
      if (!dimensions.ok) return { ok: false, reason: dimensions.reason };
    }
  } else if (options.sheetSize) {
    const hw = options.sheetSize.width / 2;
    const hd = options.sheetSize.depth / 2;
    const sized = setRoomRect(doc, { left: -hw, top: -hd, right: hw, bottom: hd });
    if (!sized.ok) return { ok: false, reason: sized.reason };
  }

  const verdict = verifyWritable(doc);
  if (!verdict.ok || !verdict.bytes) return { ok: false, reason: verdict.reason };

  // The shape gate runs on the bytes as the parser reads them back, not on the
  // document we meant to build. Anything the two disagree about is exactly the
  // class of defect this exists to catch.
  const shape = verifyPlanShape(parseArchive(verdict.bytes, doc.archiveStart));
  if (!shape.ok) return { ok: false, reason: `the plan is not shaped like a Room Viewer plan: ${shape.reason}` };

  const compound = CFB.utils.cfb_new();
  CFB.utils.cfb_add(compound, 'Contents', verdict.bytes);

  return { ok: true, file: Buffer.from(CFB.write(compound, { type: 'buffer' }) as Uint8Array) };
}

/**
 * Room sizes offered when starting a plan, in feet.
 *
 * The sizes a venue actually books, so the common case is one click rather than
 * two measurements.
 */
export const ROOM_PRESETS: Array<{ label: string; width: number; depth: number; ceilingFt?: number }> = [
  { label: 'Empty sheet', width: 0, depth: 0 },
  { label: "Boardroom: 20' × 16', 10' ceiling", width: 20, depth: 16, ceilingFt: 10 },
  { label: "Meeting room: 30' × 20', 12' ceiling", width: 30, depth: 20, ceilingFt: 12 },
  { label: "Small ballroom: 40' × 30', 14' ceiling", width: 40, depth: 30, ceilingFt: 14 },
  { label: "Ballroom: 60' × 40', 18' ceiling", width: 60, depth: 40, ceilingFt: 18 },
  { label: "Large ballroom: 100' × 60', 22' ceiling", width: 100, depth: 60, ceilingFt: 22 },
  { label: "General session: 150' × 80', 25' ceiling", width: 150, depth: 80, ceilingFt: 25 },
  { label: "Concert floor: 200' × 120', 40' ceiling", width: 200, depth: 120, ceilingFt: 40 },
  { label: "Exhibit hall: 250' × 120', 30' ceiling", width: 250, depth: 120, ceilingFt: 30 },
  { label: "Arena floor: 300' × 200', 45' ceiling", width: 300, depth: 200, ceilingFt: 45 },
];
