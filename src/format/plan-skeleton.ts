/**
 * What a Room Viewer plan *is*.
 *
 * This module owns the shape of a document. Before it existed four modules each
 * had their own idea — `blank.ts` assembled a skeleton nothing in the corpus
 * resembles, `test-fixture.ts` hand-rolled a fifth, and six separate functions
 * guessed where a new object should go — and none of those guesses was visible
 * to any gate the project had. `verifyWritable` (write.ts) proves a document is
 * *self-consistent*: it writes, reparses, and requires identical bytes and an
 * identical census. That is a property of our parser. It says nothing about
 * whether the thing we wrote is a Room Viewer plan, so a document could be
 * structurally unlike every file on the drive and still pass everything.
 *
 * The evidence for the format is the corpus, and it is unusually clear. Across
 * 390 plans on the production drive (`tools/build-plan-skeleton.ts`, and the
 * root-order and rect measurements below), every plan holds the same five
 * containers in the same order:
 *
 *   RVRoomDef   root 0, holds every drawn object          the display list
 *     RVRegion  its child 0, always                       the plan's settings
 *   ...content roots...
 *   RVRoom      root, empty, followed by 4 document bytes the room record
 *   RVRoomDef   root, empty, carries an 18-byte block     the room definition
 *   RVWalls     last root, four two-point RVSegmentLine   the wall geometry
 *   ...document trailer: int32 1, then 8 or 9 CStrings...
 *
 * `RVRegion` is included because it has a job, not to make a count match. It is
 * where the format keeps the plan's name and the seating tools' default chair
 * and table, and it is the reason a plan Groundplan created had no name at all:
 * the name went into the companion JSON sidecar and nothing in the `.rv4`
 * carried it. It is *not* a drawing layer — `scene.ts`'s `RVRegion -> 'region'`
 * branch produced zero primitives across 250 plans.
 *
 * `RVRoom` and the second `RVRoomDef` are included on the same test: they carry
 * the room's own rect, and `setRoomRect` keeps the three rects in step.
 */

import { randomUUID } from 'node:crypto';

import { appendChild, type EditResult } from './edit.js';
import type { Rect } from './mfc.js';
import {
  CONTAINER_LIST_HEADER,
  OLE_PREAMBLE,
  ROOMDEF_TAIL,
  ROOM_FOLLOW,
  SETTINGS_BLOCK,
  SETTINGS_CHAIR_AT,
} from './plan-skeleton-bytes.js';
import { walk, type DocumentPart, type RVDocument, type RVNode } from './rv.js';
import { createContainer } from './synthesize.js';
import {
  buildTrailer,
  decodeTrailer,
  readCString,
  writeCString,
  TRAILER_CONTACT,
  TRAILER_DATE,
  TRAILER_EVENT,
  TRAILER_ID,
  TRAILER_VENUE,
} from './trailer.js';

/** Body offsets shared by every container: prefix, rect, list header, count. */
const CONTAINER_HEADER_BYTES = 28;

/**
 * Schema each class carries, measured over 390 plans and unanimous in all of
 * them — 780 `RVRoomDef`, 390 each of `RVRoom`/`RVRegion`/`RVWalls`, 166,813
 * `RVSegmentLine`, 92,950 `RVShape`, and so on. MFC stores one schema per class
 * per archive, so a plan that writes geometry at schema 1 can never accept a
 * symbol imported from a real plan: the archive would describe `RVSegmentLine`
 * as schema 1 while the imported object is schema 2.
 */
export const PLAN_SCHEMA: Record<string, number> = {
  RVRoomDef: 1,
  RVRoom: 1,
  RVWalls: 1,
  RVRegion: 2,
};
/** Everything not named above. */
export const DRAWABLE_SCHEMA = 2;

/**
 * How far outside the wall extent the room rects sit.
 *
 * Measured over 246 corpus plans with four two-point walls: `RVWalls`,
 * `RVRoom` and the second `RVRoomDef` all cache `(minX - 1, minY, maxX + 1,
 * maxY)` — 217 of 246 for the walls, 135 of 246 for the room, with a further 82
 * putting the room's bottom one unit lower. The majority convention is taken;
 * the minority differs by one tenth of an inch and is noted rather than modelled.
 * `RVRoomDef` matched `RVRoom` exactly in 243 of 246.
 */
const ROOM_RECT_X_MARGIN = 1;

/** The plan's date, venue, event, contact and identifier. */
export interface PlanIdentity {
  date: string;
  venue: string;
  event: string;
  contact: string;
  /** Registry-style GUID, `{XXXXXXXX-....}`. */
  id: string;
}

/** The room's name, and the chair and table the seating tools start from. */
export interface PlanDefaults {
  roomName: string;
  chair: string;
  table: string;
}

/**
 * The five containers every real plan has.
 *
 * Never assembled outside this module: `createPlanDocument` builds one and
 * `planSkeleton` recognises one, and nothing else may invent a sixth shape.
 */
export interface PlanSkeleton {
  /** `RVRoomDef` root 0 — the display list. Everything drawn lives here. */
  body: RVNode;
  /**
   * The body's `RVRegion` — the plan's name and its defaults, and, in a plan
   * somebody has laid out, its seating groups. See `planDefaults`.
   */
  settings: RVNode;
  /** `RVRoom` — the room-shape record. Empty; carries the room rect. */
  room: RVNode;
  /** The second `RVRoomDef` — the room-definition record. Empty; same rect. */
  roomDef: RVNode;
  /** `RVWalls`, the last root — the wall geometry. */
  walls: RVNode;
}

export interface PlanDocumentResult {
  ok: boolean;
  reason?: string;
  doc?: RVDocument;
  skeleton?: PlanSkeleton;
}

export interface PlanDocumentOptions {
  identity?: Partial<PlanIdentity>;
  defaults?: Partial<PlanDefaults>;
}

// ---------------------------------------------------------------------------
// Reading bytes out of a node, whichever representation it is in
// ---------------------------------------------------------------------------

/**
 * An object's own bytes — everything it owns before its first child.
 *
 * A node is in one of two states and callers must not care which: a synthesized
 * node carries `headerOverride`, a parsed one is a span of `doc.source`. What
 * makes this the right unit for reading a *record* is that the parser gives an
 * empty container `headerEnd === end`, so everything such an object consumed —
 * including several hundred bytes of settings after the child count — counts as
 * its header.
 */
function ownBytes(doc: RVDocument, node: RVNode): Buffer {
  return node.headerOverride ?? doc.source.subarray(node.span.bodyAt, node.span.headerEnd);
}

/**
 * Replaces an object's own bytes.
 *
 * Only `headerOverride` is touched, so a container's children and any trailer
 * after them are left exactly where they were — the same discipline
 * `edit.ts` uses for every other patch.
 */
function setOwnBytes(node: RVNode, bytes: Buffer): void {
  node.headerOverride = bytes;
}

// ---------------------------------------------------------------------------
// Recognising the skeleton
// ---------------------------------------------------------------------------

/** True when this object holds a counted child list. */
function isContainer(node: RVNode): boolean {
  return node.fields.childCountAt != null;
}

/**
 * The container a new object belongs in.
 *
 * One rule, written down once: the first `RVRoomDef` or `RVRoom` with a child
 * list, in document order, descending into children before moving on. On a
 * plan with a skeleton that is always `body`, because `body` is root 0.
 *
 * This replaces six independent copies of the same idea. Two of them —
 * `annotate.ts`'s `annotationHost` and `symbol.ts`'s `findHost` — seeded a
 * stack from `[...doc.roots]` and `pop()`ed it, so they walked the roots
 * *backwards*. On the old single-root blank plan that could not show. On a plan
 * shaped like a real one the last roots are `RVWalls`, then the empty
 * `RVRoomDef`, then `RVRoom` — so they would have filed every label and every
 * imported symbol into the empty room-definition record.
 */
export function planBody(doc: RVDocument): RVNode | null {
  for (const node of walk(doc)) {
    if (!isContainer(node)) continue;
    if (node.cls === 'RVRoomDef' || node.cls === 'RVRoom') return node;
  }
  return null;
}

/** The container wall geometry belongs in, if this plan has one. */
export function planWalls(doc: RVDocument): RVNode | null {
  for (const node of walk(doc)) {
    if (isContainer(node) && node.cls === 'RVWalls') return node;
  }
  return null;
}

/**
 * Recognises the skeleton in a document that has one.
 *
 * Returns null for a shape library, for a plan written by the old code (which
 * has one `RVRoomDef` and no `RVRoom`, `RVRegion` or root `RVWalls`), and for
 * anything else that is not shaped like a Room Viewer plan. Callers treat that
 * as "this document has no skeleton", not as an error.
 */
export function planSkeleton(doc: RVDocument): PlanSkeleton | null {
  const roomDefs = doc.roots.filter((r) => r.cls === 'RVRoomDef' && isContainer(r));
  if (roomDefs.length !== 2) return null;
  const room = doc.roots.find((r) => r.cls === 'RVRoom' && isContainer(r));
  const walls = doc.roots.find((r) => r.cls === 'RVWalls' && isContainer(r));
  if (!room || !walls) return null;
  const body = roomDefs[0];
  if (doc.roots[0] !== body) return null;
  // Usually the body's first child — 251 of 295 plans — but a plan whose
  // drawing predates its seating has geometry ahead of it, so position is not
  // the test. There is exactly one `RVRegion` in a plan and it is the body's.
  const settings = body.children.find((c) => c.cls === 'RVRegion');
  if (!settings) return null;
  return { body, settings, room, roomDef: roomDefs[1], walls };
}

// ---------------------------------------------------------------------------
// The settings record: the plan's name and its seating defaults
// ---------------------------------------------------------------------------

interface NameField {
  text: string;
  at: number;
  end: number;
}

/**
 * Bytes between the end of the room name and the start of the default table.
 *
 * Constant across every record examined, from 389 bytes to 436, which is what
 * makes the two locatable at all: the runs around them are not the same length
 * in every installation, so a fixed offset would only work for the machine the
 * donor came from.
 */
const SETTINGS_NAME_TO_TABLE = 29;

/**
 * True when a length-prefixed string here looks like a name somebody typed.
 *
 * The range includes the latin-1 letters, not just ASCII. It used to stop at
 * `\x7e`, and the record is written in latin-1 — so naming a plan "Café Royal"
 * or "Ünïcödé" put byte 0xe9 in the room-name field, this refused to see a name
 * there, `locateSettingsNames` found nothing, and the blank-plan verifier
 * rejected the file GROUNDPLAN HAD JUST BUILT with "the settings record does
 * not hold the three names". A plan could not be created with an accented name
 * at all, and the message blamed the plan's shape rather than the four letters
 * the user typed. (An emoji was fine, because it is not representable in
 * latin-1 and gets substituted to ASCII on the way in — so the failure hit
 * French, German and Spanish venue names and spared the decorative ones.)
 *
 * Requiring at least one ASCII alphanumeric is what keeps the hunt honest: a
 * run of high bytes that happens to sit in the record is still not a name.
 */
function plausibleName(block: Buffer, at: number): NameField | null {
  const c = readCString(block, at);
  if (!c || c.text.length < 2) return null;
  if (!/^[\x20-\x7e\xa0-\xff]+$/.test(c.text) || !/[A-Za-z0-9]/.test(c.text)) return null;
  return { text: c.text, at, end: c.end };
}

/**
 * Where the three names live inside the settings record.
 *
 * The default chair sits at a fixed offset — 171 of 171 empty `RVRegion`
 * records measured carry `Standard 18"x18"` at +106 into the record. The room
 * name and the default table follow, always exactly `SETTINGS_NAME_TO_TABLE`
 * bytes apart, and that gap is what tells them apart. The rooms in the corpus
 * are usually unnamed, so the first readable string after the chair is normally
 * the *table*, not the name — reading the next two strings in order, which is
 * how the donor was measured, silently writes the plan's name into its default
 * table. So: take the first readable string, and ask whether another one sits
 * one gap beyond it. If it does, the first was the name. If it does not, the
 * first was the table and the name is the empty string a gap behind it.
 */
function locateSettingsNames(
  block: Buffer,
): { chair: NameField; name: NameField; table: NameField } | null {
  const chairRaw = readCString(block, SETTINGS_CHAIR_AT);
  if (!chairRaw) return null;
  const chair: NameField = { text: chairRaw.text, at: SETTINGS_CHAIR_AT, end: chairRaw.end };

  let first: NameField | null = null;
  for (let at = chair.end; at + 1 < block.length && !first; at++) first = plausibleName(block, at);
  if (!first) return null;

  const beyond = plausibleName(block, first.end + SETTINGS_NAME_TO_TABLE);
  if (beyond) return { chair, name: first, table: beyond };

  const nameAt = first.at - SETTINGS_NAME_TO_TABLE - 1;
  if (nameAt <= chair.end) return null;
  const empty = readCString(block, nameAt);
  if (!empty || empty.text.length !== 0) return null;
  return { chair, name: { text: '', at: nameAt, end: nameAt + 1 }, table: first };
}

/**
 * The `RVRegion`'s settings record — everything after its 28-byte header.
 *
 * Only readable while the region declares no children, and that limit is real
 * rather than a shortcut. An empty `RVRegion` gets `headerEnd === end` from the
 * parser, so the record is unambiguously its own bytes: 143 of 143 such regions
 * carry the default chair at +106. A region that holds seating groups —
 * `RVTableAndChairBanquet` and friends, 155 of 300 plans — does not surrender
 * the record to any offset this project has been able to justify. Rather than
 * guess and then write into bytes whose meaning is unknown, the record is
 * reported as unreadable there.
 *
 * A plan this module creates always has an empty region, so naming a new plan
 * always works; reading the defaults off somebody's laid-out plan does not yet.
 */
function settingsRecord(doc: RVDocument, settings: RVNode): Buffer | null {
  if (settings.slots.length) return null;
  return ownBytes(doc, settings).subarray(CONTAINER_HEADER_BYTES);
}

/** The plan's name and the chair and table its seating tools start from. */
export function planDefaults(doc: RVDocument): PlanDefaults | null {
  const skeleton = planSkeleton(doc);
  if (!skeleton) return null;
  const record = settingsRecord(doc, skeleton.settings);
  if (!record) return null;
  const names = locateSettingsNames(record);
  if (!names) return null;
  return { roomName: names.name.text, chair: names.chair.text, table: names.table.text };
}

/** The plan's name, as Room Viewer stores it. */
export function planName(doc: RVDocument): string | null {
  const defaults = planDefaults(doc);
  return defaults && defaults.roomName ? defaults.roomName : null;
}

/**
 * Rewrites one of the three names in the settings record.
 *
 * Only the length-prefixed string moves; every byte around it is copied. The
 * record holds several hundred bytes nobody decoded — grid, scale, ceiling and
 * layout defaults — and those are exactly the bytes this must not disturb.
 */
function setSettingsName(
  doc: RVDocument,
  which: 'roomName' | 'chair' | 'table',
  value: string,
): EditResult {
  const skeleton = planSkeleton(doc);
  if (!skeleton) return { ok: false, reason: 'this plan has no settings record to name' };

  if (skeleton.settings.slots.length) {
    return { ok: false, reason: 'this plan already holds seating, and its settings record cannot be located' };
  }
  const body = Buffer.from(ownBytes(doc, skeleton.settings));
  const names = locateSettingsNames(body.subarray(CONTAINER_HEADER_BYTES));
  if (!names) return { ok: false, reason: 'the settings record is not laid out the way this reads it' };

  const field = which === 'roomName' ? names.name : which === 'chair' ? names.chair : names.table;
  const at = CONTAINER_HEADER_BYTES + field.at;
  const end = CONTAINER_HEADER_BYTES + field.end;
  setOwnBytes(
    skeleton.settings,
    Buffer.concat([body.subarray(0, at), writeCString(value), body.subarray(end)]),
  );
  return { ok: true };
}

/** Names the plan, where Room Viewer will read the name back. */
export function setPlanName(doc: RVDocument, name: string): EditResult {
  return setSettingsName(doc, 'roomName', name);
}

/** Sets the chair the seating tools start from. */
export function setDefaultChair(doc: RVDocument, chair: string): EditResult {
  return setSettingsName(doc, 'chair', chair);
}

/** Sets the table the seating tools start from. */
export function setDefaultTable(doc: RVDocument, table: string): EditResult {
  return setSettingsName(doc, 'table', table);
}

// ---------------------------------------------------------------------------
// The document trailer: date, venue, event, contact, and the plan's identifier
// ---------------------------------------------------------------------------

/**
 * Which trailer slot each field of the identity lives in.
 *
 * The grammar and the slot meanings are `trailer.ts`, because the parser needs
 * them too — a trailer is where the last object ends, and until it could be
 * recognised the final wall segment ran off the end of the stream and took the
 * trailer with it.
 */
const IDENTITY_SLOT: Record<keyof Omit<PlanIdentity, 'id'>, number> = {
  date: TRAILER_DATE,
  venue: TRAILER_VENUE,
  event: TRAILER_EVENT,
  contact: TRAILER_CONTACT,
};

function trailerBytes(identity: PlanIdentity): Buffer {
  const slots: string[] = [];
  for (const [key, index] of Object.entries(IDENTITY_SLOT)) {
    slots[index] = identity[key as keyof typeof IDENTITY_SLOT];
  }
  return buildTrailer(slots, identity.id);
}

/**
 * The trailer's own run of bytes at the end of the document.
 *
 * It is the last part, and it is raw: the parser stops the last object where
 * the trailer begins. That was not true before — the trailer had to be hunted
 * for *inside* the final segment's bytes, because the segment's span swallowed
 * it — and being able to say "the last part is the trailer" is most of why
 * naming a plan is now a byte replacement rather than a search.
 */
function trailerPart(doc: RVDocument): { index: number; from: number; strings: string[] } | null {
  const index = doc.parts.length - 1;
  const last = doc.parts[index];
  if (last?.kind !== 'raw') return null;
  // Not strict: this is the known-last raw part, not a hunt, so a latin1
  // venue name must be readable rather than treated as "not a trailer".
  const strings = decodeTrailer(doc.source.subarray(0, last.to), last.from, false);
  return strings ? { index, from: last.from, strings } : null;
}

/** The plan's date, venue, event, contact and identifier, when it has them. */
export function planIdentity(doc: RVDocument): PlanIdentity | null {
  const found = trailerPart(doc);
  if (!found) return null;
  const s = found.strings;
  return {
    date: s[IDENTITY_SLOT.date] ?? '',
    venue: s[IDENTITY_SLOT.venue] ?? '',
    event: s[IDENTITY_SLOT.event] ?? '',
    contact: s[IDENTITY_SLOT.contact] ?? '',
    id: s[TRAILER_ID] ?? '',
  };
}

/** Rewrites the document trailer, keeping the fields not named in `patch`. */
export function setPlanIdentity(doc: RVDocument, patch: Partial<PlanIdentity>): EditResult {
  const found = trailerPart(doc);
  if (!found) return { ok: false, reason: 'this document has no trailer to write' };
  const trailer = trailerBytes({ ...planIdentity(doc)!, ...patch });

  // Every part before this one indexes into the same buffer and none of them
  // reaches past `from`, so replacing the tail moves nothing else.
  doc.source = Buffer.concat([doc.source.subarray(0, found.from), trailer]);
  doc.parts[found.index] = { kind: 'raw', from: found.from, to: found.from + trailer.length };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The room rect
// ---------------------------------------------------------------------------

/** Writes a rect into an object's cached `CRect`, patching only those bytes. */
function writeRect(doc: RVDocument, node: RVNode, rect: Rect): void {
  const bytes = Buffer.from(ownBytes(doc, node));
  const at = node.fields.boundsAt - node.span.bodyAt;
  if (at < 0 || at + 16 > bytes.length) return;
  bytes.writeInt32LE(Math.round(rect.left), at);
  bytes.writeInt32LE(Math.round(rect.top), at + 4);
  bytes.writeInt32LE(Math.round(rect.right), at + 8);
  bytes.writeInt32LE(Math.round(rect.bottom), at + 12);
  setOwnBytes(node, bytes);
  node.bounds = {
    left: Math.round(rect.left),
    top: Math.round(rect.top),
    right: Math.round(rect.right),
    bottom: Math.round(rect.bottom),
  };
}

/**
 * Caches the room's extent on the three objects that record it.
 *
 * `RVWalls`, `RVRoom` and the second `RVRoomDef` all hold the same rect in a
 * real plan, and it is the wall extent widened by one unit on each side. Keeping
 * them in step is the whole reason the two empty records are worth having.
 */
export function setRoomRect(doc: RVDocument, extent: Rect): EditResult {
  const skeleton = planSkeleton(doc);
  if (!skeleton) return { ok: false, reason: 'this plan has no room records to size' };
  const rect: Rect = {
    left: Math.round(extent.left) - ROOM_RECT_X_MARGIN,
    top: Math.round(extent.top),
    right: Math.round(extent.right) + ROOM_RECT_X_MARGIN,
    bottom: Math.round(extent.bottom),
  };
  for (const node of [skeleton.walls, skeleton.room, skeleton.roomDef]) writeRect(doc, node, rect);
  return { ok: true };
}

/** The extent of whatever the walls container draws, in logical units. */
export function wallExtent(doc: RVDocument): Rect | null {
  const walls = planWalls(doc);
  if (!walls) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const child of walls.children) {
    for (const p of child.points) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      left = Math.min(left, p.x);
      top = Math.min(top, p.y);
      right = Math.max(right, p.x);
      bottom = Math.max(bottom, p.y);
    }
  }
  return Number.isFinite(left) ? { left, top, right, bottom } : null;
}

// ---------------------------------------------------------------------------
// Building one
// ---------------------------------------------------------------------------

/** A registry-style GUID, the form the corpus writes into the trailer. */
function newPlanId(): string {
  return `{${randomUUID().toUpperCase()}}`;
}

const ZERO_RECT: Rect = { left: 0, top: 0, right: 0, bottom: 0 };

/**
 * Builds a document shaped like a Room Viewer plan.
 *
 * Every byte of the file is a part of the document before anything verifies it.
 * That matters: `createBlankPlan` used to run `verifyWritable` and *then*
 * concatenate twelve zero bytes in front of the result, so the only twelve bytes
 * that reached disk were the only twelve nothing had checked — and they were
 * wrong, because every real plan writes `00000000 02000000 00000000` there.
 * Here the preamble and the trailer are parts like any other, `archiveStart` is
 * 12, and what is verified is what is written.
 */
export function createPlanDocument(options: PlanDocumentOptions = {}): PlanDocumentResult {
  const identity: PlanIdentity = {
    date: '',
    venue: '',
    event: '',
    contact: '',
    id: newPlanId(),
    ...options.identity,
  };

  // The document-level raw runs, in one buffer the raw parts index into.
  const trailer = trailerBytes(identity);
  const source = Buffer.concat([OLE_PREAMBLE, ROOM_FOLLOW, trailer]);
  const preambleTo = OLE_PREAMBLE.length;
  const roomFollowTo = preambleTo + ROOM_FOLLOW.length;

  const doc: RVDocument = {
    roots: [],
    parts: [],
    warnings: [],
    bytesConsumed: 0,
    bytesTotal: 0,
    trailerStrings: [],
    source,
    archiveStart: preambleTo,
    nextId: 1,
  };

  const build = (cls: 'RVRoomDef' | 'RVRoom' | 'RVRegion' | 'RVWalls', record?: Buffer): RVNode | null => {
    const made = createContainer(doc, { cls, bounds: ZERO_RECT, record });
    return made.ok && made.node ? made.node : null;
  };

  const body = build('RVRoomDef');
  const settings = build('RVRegion', SETTINGS_BLOCK);
  const room = build('RVRoom');
  const roomDef = build('RVRoomDef', ROOMDEF_TAIL);
  const walls = build('RVWalls');
  if (!body || !settings || !room || !roomDef || !walls) {
    return { ok: false, reason: 'the plan skeleton could not be built' };
  }

  // The settings record is the body's only child until something is drawn.
  const held = appendChild(doc, body, settings);
  if (!held.ok) return { ok: false, reason: held.reason };

  const parts: DocumentPart[] = [
    { kind: 'raw', from: 0, to: preambleTo },
    { kind: 'node', node: body },
    { kind: 'node', node: room },
    { kind: 'raw', from: preambleTo, to: roomFollowTo },
    { kind: 'node', node: roomDef },
    { kind: 'node', node: walls },
    { kind: 'raw', from: roomFollowTo, to: source.length },
  ];
  doc.parts = parts;
  doc.roots = [body, room, roomDef, walls];

  const skeleton: PlanSkeleton = { body, settings, room, roomDef, walls };

  const named = options.defaults?.roomName;
  if (named != null) {
    const set = setPlanName(doc, named);
    if (!set.ok) return { ok: false, reason: set.reason };
  }
  if (options.defaults?.chair != null) {
    const set = setDefaultChair(doc, options.defaults.chair);
    if (!set.ok) return { ok: false, reason: set.reason };
  }
  if (options.defaults?.table != null) {
    const set = setDefaultTable(doc, options.defaults.table);
    if (!set.ok) return { ok: false, reason: set.reason };
  }

  return { ok: true, doc, skeleton };
}

// ---------------------------------------------------------------------------
// The shape gate
// ---------------------------------------------------------------------------

export interface PlanShapeCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Is this recognisably a Room Viewer plan?
 *
 * The half `verifyWritable` cannot supply. It proves a document reproduces
 * itself; this proves the document matches what Room Viewer writes, and every
 * clause below is a corpus measurement rather than an opinion of our parser.
 * All four of the bugs this rewrite removed — the wrong preamble, the inverted
 * container list header, `RVWalls` nested inside `RVRoomDef`, and the missing
 * `RVRoom`/`RVRegion` — fail one of these clauses and passed everything else.
 */
export function verifyPlanShape(doc: RVDocument): PlanShapeCheck {
  const skeleton = planSkeleton(doc);
  if (!skeleton) return { ok: false, reason: 'the document does not hold a plan skeleton' };

  const order = doc.roots.map((r) => r.cls);
  const tail = order.slice(-3).join(' ');
  if (tail !== 'RVRoom RVRoomDef RVWalls') {
    return { ok: false, reason: `the last three roots are "${tail}", not "RVRoom RVRoomDef RVWalls"` };
  }
  if (order[0] !== 'RVRoomDef') {
    return { ok: false, reason: `root 0 is ${order[0]}, not the display list` };
  }

  const census = new Map<string, number>();
  const schemas = new Map<string, Set<number>>();
  for (const node of walk(doc)) {
    census.set(node.cls, (census.get(node.cls) ?? 0) + 1);
    const seen = schemas.get(node.cls) ?? new Set<number>();
    seen.add(node.schema);
    schemas.set(node.cls, seen);
  }
  for (const [cls, want] of [
    ['RVRoomDef', 2],
    ['RVRoom', 1],
    ['RVRegion', 1],
    ['RVWalls', 1],
  ] as Array<[string, number]>) {
    const got = census.get(cls) ?? 0;
    if (got !== want) return { ok: false, reason: `the plan holds ${got} ${cls}, not ${want}` };
  }

  // MFC stores one schema per class per archive, so two is not a style choice,
  // it is a file that cannot be read back.
  for (const [cls, seen] of schemas) {
    if (seen.size !== 1) {
      return { ok: false, reason: `${cls} is written at schemas ${[...seen].join(' and ')} in one archive` };
    }
    const want = PLAN_SCHEMA[cls] ?? DRAWABLE_SCHEMA;
    const got = [...seen][0];
    if (got !== want) return { ok: false, reason: `${cls} is schema ${got}, not ${want}` };
  }

  // `RVRoom` and the second `RVRoomDef` are records, not lists: their bytes
  // after the child count are fields, and a child written there would land in
  // the middle of them. Both are empty in every plan measured. `RVRegion` is
  // deliberately not in this list — it is a record *and* a list, and 155 of 300
  // plans file their seating groups in it.
  for (const [name, node] of [
    ['the room record', skeleton.room],
    ['the room definition', skeleton.roomDef],
  ] as Array<[string, RVNode]>) {
    if (node.slots.length) return { ok: false, reason: `${name} holds ${node.slots.length} children` };
  }

  for (const node of walk(doc)) {
    if (!isContainer(node)) continue;
    const bytes = ownBytes(doc, node);
    const at = node.fields.childCountAt! - node.span.bodyAt - CONTAINER_LIST_HEADER.length;
    const header = bytes.subarray(at, at + CONTAINER_LIST_HEADER.length);
    if (!header.equals(CONTAINER_LIST_HEADER)) {
      return {
        ok: false,
        reason: `${node.cls} writes a list header of ${header.toString('hex')}, not ${CONTAINER_LIST_HEADER.toString('hex')}`,
      };
    }
  }

  const preamble = doc.source.subarray(0, doc.archiveStart);
  if (!preamble.equals(OLE_PREAMBLE)) {
    return { ok: false, reason: `the preamble is ${preamble.toString('hex')}, not ${OLE_PREAMBLE.toString('hex')}` };
  }

  if (!trailerPart(doc)) return { ok: false, reason: 'the document trailer is missing or unreadable' };
  // The record is only addressable while the region holds no seating; a plan
  // that does is not one this module built, and the names are checked where
  // they can be.
  if (!skeleton.settings.slots.length && !planDefaults(doc)) {
    return { ok: false, reason: 'the settings record does not hold the three names' };
  }

  return { ok: true };
}
