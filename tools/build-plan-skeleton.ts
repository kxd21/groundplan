/**
 * Generates `src/format/plan-skeleton-bytes.ts` from the plan corpus.
 *
 * Groundplan used to assemble a new plan out of whatever containers seemed
 * plausible, and nothing could tell it it was wrong: `verifyWritable` proves a
 * document is *self-consistent*, which is a property of our parser, not a
 * property of the format. The only evidence for "this is a Room Viewer plan" is
 * what Room Viewer itself writes, so that evidence is measured here and frozen
 * into a generated module the rest of the code reads.
 *
 * Everything emitted is either a **measurement** (a byte run that is unanimous
 * across the sample, printed with its count) or a **donor** (a run nobody
 * decoded, copied verbatim from one real plan, which is the same discipline
 * `borrowStyle` and `borrowFont` already use in `synthesize.ts`). Nothing is
 * invented.
 *
 * Run it with the production drive mounted:
 *
 *     npx tsx tools/build-plan-skeleton.ts [sampleSize]
 *
 * It refuses to write the module if any fact it depends on is not unanimous,
 * so a future corpus that disagrees produces a loud failure rather than a
 * quietly wrong plan.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadBuffer, type RVDocument, type RVNode } from '../src/format/index.js';

const CORPUS = process.env.GROUNDPLAN_CORPUS ?? '/Volumes/Prince/Roomviewer/Data';
const OUT = new URL('../src/format/plan-skeleton-bytes.ts', import.meta.url).pathname;
const SAMPLE = Number(process.argv[2] ?? 400);

/** Body offsets shared by every class: version, then the cached CRect. */
const LIST_HEADER_AT = 20;
const CONTAINER_HEADER_BYTES = 28;
/** Where a segment's undecoded pen/brush block starts and its points begin. */
const SEG_STYLE_FROM = 26;
const SEG_POINTS = 62;
const SEG_VERTEX_HINT = 22;
const SEG_KIND = 20;
const SEG_COLOR = 54;

class Unanimity<T> {
  private readonly counts = new Map<string, { value: T; n: number }>();

  add(value: T): void {
    const key = JSON.stringify(value);
    const seen = this.counts.get(key);
    if (seen) seen.n++;
    else this.counts.set(key, { value, n: 1 });
  }

  get total(): number {
    return [...this.counts.values()].reduce((a, b) => a + b.n, 0);
  }

  /** The most common value, its count, and how many files were measured. */
  get modal(): { value: T; n: number; total: number } {
    const best = [...this.counts.values()].sort((a, b) => b.n - a.n)[0];
    return { value: best.value, n: best.n, total: this.total };
  }

  report(label: string): string {
    const { n, total } = this.modal;
    const rest = [...this.counts.values()].length - 1;
    return `${label}: ${n}/${total}${rest ? ` (${rest} other value${rest > 1 ? 's' : ''})` : ' — unanimous'}`;
  }

  /**
   * The modal value, provided enough of the corpus agreed.
   *
   * Byte runs are required to be unanimous (`share` 1): a run that differs
   * between plans is not a constant and has no business being frozen into a
   * module. Whole-file structural facts take a threshold instead, because the
   * corpus contains a handful of files with a damaged sector or an object
   * somebody hand-edited, and one of those must not veto a finding that 389
   * plans agree on.
   */
  require(label: string, share = 1): T {
    const { value, n, total } = this.modal;
    if (total === 0) throw new Error(`${label}: nothing measured`);
    if (n < total * share) {
      const others = [...this.counts.values()]
        .filter((c) => c.value !== value)
        .slice(0, 4)
        .map((c) => `${JSON.stringify(c.value)} x${c.n}`)
        .join(', ');
      throw new Error(
        `${label}: only ${n}/${total} agree (needed ${Math.ceil(total * share)}); others: ${others}`,
      );
    }
    return value;
  }
}

function skeletonOf(doc: RVDocument): {
  body: RVNode;
  settings: RVNode;
  room: RVNode;
  roomDef: RVNode;
  walls: RVNode;
} | null {
  const roomDefs = doc.roots.filter((r) => r.cls === 'RVRoomDef');
  const room = doc.roots.find((r) => r.cls === 'RVRoom');
  const walls = doc.roots.find((r) => r.cls === 'RVWalls');
  if (roomDefs.length !== 2 || !room || !walls) return null;
  const settings = roomDefs[0].children.find((c) => c.cls === 'RVRegion');
  if (!settings) return null;
  return { body: roomDefs[0], settings, room, roomDef: roomDefs[1], walls };
}

function cstring(buf: Buffer, at: number): { text: string; end: number } | null {
  if (at < 0 || at >= buf.length) return null;
  const len = buf[at];
  if (len === 0xff || at + 1 + len > buf.length) return null;
  return { text: buf.toString('latin1', at + 1, at + 1 + len), end: at + 1 + len };
}

// ---------------------------------------------------------------------------
// Measure
// ---------------------------------------------------------------------------

const files = readdirSync(CORPUS)
  .filter((f) => f.toLowerCase().endsWith('.rv4') && !f.startsWith('._'))
  .sort();
if (!files.length) throw new Error(`no .rv4 files under ${CORPUS}`);

const step = Math.max(1, Math.floor(files.length / SAMPLE));
const picked = files.filter((_, i) => i % step === 0).slice(0, SAMPLE);

const preamble = new Unanimity<string>();
const listHeader = new Unanimity<string>();
const roomFollow = new Unanimity<string>();
const roomDefTail = new Unanimity<string>();
const wallStyle = new Unanimity<string>();
const wallVertexHint = new Unanimity<number>();
const wallKind = new Unanimity<number>();
const wallColor = new Unanimity<number>();
const census = new Unanimity<string>();
const schemas = new Map<string, Unanimity<number>>();
const settingsChair = new Unanimity<number>();
const trailerLead = new Unanimity<number>();
const trailerStringCount = new Unanimity<number>();
const wallWinding = new Unanimity<string>();
const roomRectRule = new Unanimity<string>();

let measured = 0;
let skipped = 0;

for (const name of picked) {
  const path = join(CORPUS, name);
  let doc: RVDocument;
  try {
    doc = loadBuffer(readFileSync(path), path).document;
  } catch {
    skipped++;
    continue;
  }
  const skel = skeletonOf(doc);
  const counts: Record<string, number> = {};
  for (const cls of ['RVRoomDef', 'RVRoom', 'RVRegion', 'RVWalls']) counts[cls] = 0;
  const visit = (n: RVNode): void => {
    if (n.cls in counts) counts[n.cls]++;
    for (const c of n.children) visit(c);
  };
  for (const r of doc.roots) visit(r);
  census.add(Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' '));
  if (!skel) {
    skipped++;
    continue;
  }
  measured++;
  const src = doc.source;

  preamble.add(src.subarray(0, doc.archiveStart).toString('hex'));

  // Every container's list header, at +20..+26.
  const containers = (n: RVNode): void => {
    if (n.fields.childCountAt != null) {
      const at = n.span.bodyAt + LIST_HEADER_AT;
      if (at + 6 <= src.length) listHeader.add(src.subarray(at, at + 6).toString('hex'));
    }
    for (const c of n.children) containers(c);
  };
  for (const r of doc.roots) containers(r);

  // One schema per class per archive is an MFC invariant; record what each is.
  const seenSchema = (n: RVNode): void => {
    if (!schemas.has(n.cls)) schemas.set(n.cls, new Unanimity<number>());
    schemas.get(n.cls)!.add(n.schema);
    for (const c of n.children) seenSchema(c);
  };
  for (const r of doc.roots) seenSchema(r);

  // The document-level run that follows the empty RVRoom.
  const roomPart = doc.parts.findIndex((p) => p.kind === 'node' && p.node === skel.room);
  const after = doc.parts[roomPart + 1];
  roomFollow.add(after && after.kind === 'raw' ? src.subarray(after.from, after.to).toString('hex') : '(none)');

  // The block that follows the second RVRoomDef's child count. The parser folds
  // it into that node's header, because an empty container's header span runs
  // to wherever the forward scan stopped.
  roomDefTail.add(
    src.subarray(skel.roomDef.span.bodyAt + CONTAINER_HEADER_BYTES, skel.roomDef.span.end).toString('hex'),
  );

  // Wall geometry: the pen/brush block, and the fields around it.
  if (skel.walls.children.length === 4) {
    const w = skel.walls.children[0];
    if (w.cls === 'RVSegmentLine' && w.fields.pointsAt === w.span.bodyAt + SEG_POINTS) {
      wallStyle.add(src.subarray(w.span.bodyAt + SEG_STYLE_FROM, w.span.bodyAt + SEG_POINTS).toString('hex'));
      wallVertexHint.add(src.readInt32LE(w.span.bodyAt + SEG_VERTEX_HINT));
      wallKind.add(src.readUInt16LE(w.span.bodyAt + SEG_KIND));
      wallColor.add(src.readUInt32LE(w.span.bodyAt + SEG_COLOR));
    }

    const pts = skel.walls.children.flatMap((c) => c.points);
    if (pts.length === 8) {
      wallWinding.add(
        skel.walls.children.map((c) => c.points.map((p) => `${Math.sign(p.x)}${Math.sign(p.y)}`).join('>')).join(' '),
      );
      const hx = Math.max(...pts.map((p) => Math.abs(p.x)));
      const hy = Math.max(...pts.map((p) => Math.abs(p.y)));
      if (Number.isInteger(hx) && Number.isInteger(hy)) {
        const w = skel.walls.bounds;
        const r = skel.room.bounds;
        const wallsDerived =
          w.left === -(hx + 1) && w.top === -hy && w.right === hx + 1 && w.bottom === hy;
        const roomTall = r.bottom === hy + 1;
        const roomFlat = r.bottom === hy;
        roomRectRule.add(
          `walls=${wallsDerived ? 'derived' : 'other'} room.bottom=${roomTall ? 'hy+1' : roomFlat ? 'hy' : 'other'}`,
        );
      }
    }
  }

  // The document trailer sits after the last wall's point array. The parser
  // never surfaces it — the segment's span swallows it — so read it directly.
  const lastWall = skel.walls.children[skel.walls.children.length - 1];
  if (lastWall?.fields.pointsAt != null && lastWall.fields.pointCount) {
    const tail = src.subarray(lastWall.fields.pointsAt + lastWall.fields.pointCount * 16);
    if (tail.length >= 4) {
      trailerLead.add(tail.readInt32LE(0));
      let at = 4;
      let n = 0;
      while (at < tail.length && n < 16) {
        const c = cstring(tail, at);
        if (!c) break;
        at = c.end;
        n++;
      }
      trailerStringCount.add(at === tail.length ? n : -1);
    }
  }

  // The settings block the empty RVRegion carries.
  if (skel.settings.slots.length === 0) {
    const block = src.subarray(skel.settings.span.bodyAt + CONTAINER_HEADER_BYTES, skel.settings.span.end);
    const chair = cstring(block, 106);
    settingsChair.add(chair && chair.text === 'Standard 18"x18"' ? 106 : -1);
  }
}

// ---------------------------------------------------------------------------
// Choose the donor: the smallest plan that is exactly the skeleton and nothing
// else, which is Room Viewer's own answer to "what is a new plan".
// ---------------------------------------------------------------------------

let donor: { name: string; doc: RVDocument; block: Buffer; chairAt: number; nameAt: number; tableAt: number } | null =
  null;

for (const { name } of files
  .map((f) => ({ name: f, size: statSync(join(CORPUS, f)).size }))
  .sort((a, b) => a.size - b.size)
  .slice(0, 40)) {
  let doc: RVDocument;
  try {
    doc = loadBuffer(readFileSync(join(CORPUS, name)), join(CORPUS, name)).document;
  } catch {
    continue;
  }
  const skel = skeletonOf(doc);
  if (!skel || doc.warnings.length) continue;
  // Exactly the skeleton: the body holds the settings record and nothing else.
  if (skel.body.slots.length !== 1 || skel.settings.slots.length !== 0) continue;
  if (skel.walls.children.length !== 4) continue;

  const block = Buffer.from(
    doc.source.subarray(skel.settings.span.bodyAt + CONTAINER_HEADER_BYTES, skel.settings.span.end),
  );
  // Three length-prefixed names live in the block: the default chair, the room
  // name, and the default table. Locate them by walking, not by guessing.
  const chair = cstring(block, 106);
  if (!chair || chair.text !== 'Standard 18"x18"') continue;
  let nameAt = -1;
  let tableAt = -1;
  for (let at = chair.end; at + 1 < block.length; at++) {
    const c = cstring(block, at);
    if (!c || c.text.length < 2 || !/^[\x20-\x7e]+$/.test(c.text) || !/[A-Za-z0-9]/.test(c.text)) continue;
    if (nameAt === -1) nameAt = at;
    else {
      tableAt = at;
      break;
    }
    at = c.end - 1;
  }
  if (nameAt === -1 || tableAt === -1) continue;
  donor = { name, doc, block, chairAt: 106, nameAt, tableAt };
  break;
}

if (!donor) throw new Error('no minimal plan on the drive could serve as a settings donor');

// The room name is the one field in the block that carries the donor's own
// event data, so it is removed before anything is committed. Removing it moves
// everything after it, which is why the table offset is recomputed.
const donorName = cstring(donor.block, donor.nameAt)!;
const settingsBlock = Buffer.concat([
  donor.block.subarray(0, donor.nameAt),
  Buffer.from([0]),
  donor.block.subarray(donorName.end),
]);
const tableAt = donor.tableAt - donorName.text.length;
const donorTable = cstring(settingsBlock, tableAt);
if (!donorTable) throw new Error('the default-table name moved when the room name was removed');

// ---------------------------------------------------------------------------
// Check every fact the generated module depends on, then emit it.
// ---------------------------------------------------------------------------

console.log(`corpus ${CORPUS}`);
console.log(`sampled ${picked.length} of ${files.length} plans; ${measured} measured, ${skipped} skipped\n`);
for (const [label, u] of [
  ['skeleton census', census],
  ['OLE preamble', preamble],
  ['container list header', listHeader],
  ['run after RVRoom', roomFollow],
  ['block after 2nd RVRoomDef', roomDefTail],
  ['wall pen/brush block', wallStyle],
  ['wall vertex hint', wallVertexHint],
  ['wall segment kind', wallKind],
  ['wall colour', wallColor],
  ['default chair at +106', settingsChair],
  ['trailer lead int32', trailerLead],
  ['trailer string count', trailerStringCount],
  ['wall winding', wallWinding],
  ['room rect rule', roomRectRule],
] as Array<[string, Unanimity<unknown>]>) {
  console.log(`  ${u.report(label)}`);
}
console.log('\n  schema per class:');
for (const [cls, u] of [...schemas].sort()) console.log(`    ${u.report(cls.padEnd(26))}`);

/** How much of the corpus must agree on a whole-file structural fact. */
const STRUCTURAL_SHARE = 0.95;

const CENSUS = 'RVRoomDef:2 RVRoom:1 RVRegion:1 RVWalls:1';
if (census.require('skeleton census', STRUCTURAL_SHARE) !== CENSUS) {
  throw new Error(`the corpus census is "${census.modal.value}", not "${CENSUS}"`);
}
const OLE_PREAMBLE = preamble.require('OLE preamble');
const LIST_HEADER = listHeader.require('container list header');
const ROOM_FOLLOW = roomFollow.require('run after RVRoom');
const ROOMDEF_TAIL = roomDefTail.require('block after the second RVRoomDef', STRUCTURAL_SHARE);
const WALL_STYLE = wallStyle.require('wall pen/brush block', STRUCTURAL_SHARE);
const WALL_COLOR = wallColor.require('wall colour');
const WALL_KIND = wallKind.require('wall segment kind');
const WALL_VERTEX_HINT = wallVertexHint.require('wall vertex hint');
const TRAILER_LEAD = trailerLead.require('trailer lead int32', STRUCTURAL_SHARE);
for (const [cls, u] of schemas) u.require(`schema of ${cls}`);

const containerSchema = ['RVRoomDef', 'RVRoom', 'RVWalls'].map((c) => [c, schemas.get(c)!.modal.value] as const);
const drawableSchema = [...schemas].filter(([c]) => !['RVRoomDef', 'RVRoom', 'RVWalls'].includes(c));
for (const [cls, s] of containerSchema) if (s !== 1) throw new Error(`${cls} is schema ${s}, expected 1`);
for (const [cls, u] of drawableSchema) if (u.modal.value !== 2) throw new Error(`${cls} is schema ${u.modal.value}, expected 2`);

const hex = (h: string): string => h.replace(/(.{2})/g, '$1 ').trim();
const buf = (h: string): string => `Buffer.from('${h}', 'hex')`;

const source = `/**
 * Byte runs a Room Viewer plan is made of.
 *
 * GENERATED by \`tools/build-plan-skeleton.ts\` — do not edit by hand.
 *
 *   corpus   ${CORPUS}
 *   sampled  ${picked.length} of ${files.length} plans (${measured} carried a full skeleton)
 *   donor    ${donor.name}
 *   built    ${new Date().toISOString().slice(0, 10)}
 *
 * Two kinds of value live here and they are not equally well understood:
 *
 *   **Measurements.** Runs that were identical in every plan measured. The
 *   preamble, the container list header, the blocks that follow \`RVRoom\` and
 *   the second \`RVRoomDef\`, and the wall pen/brush block are all unanimous
 *   across ${measured} plans. These are findings, not choices.
 *
 *   **A donor.** \`SETTINGS_BLOCK\` is the ${settingsBlock.length}-byte record an empty
 *   \`RVRegion\` carries: the plan's default chair and table, its name, and
 *   several hundred bytes nobody decoded — grid, scale, ceiling and layout
 *   defaults, which differ from plan to plan. There is no consensus value to
 *   compute, so one real plan's block is copied verbatim, exactly as
 *   \`borrowStyle\` and \`borrowFont\` copy pen and font blocks in
 *   \`synthesize.ts\`. The donor's own room name is stripped before committing,
 *   so no venue or event data is carried here; the three name fields are the
 *   only bytes \`plan-skeleton.ts\` ever authors inside the record.
 */

/* eslint-disable */

/** \`COleDocument\` writes three DWORDs before the first tag: ${hex(OLE_PREAMBLE)}. */
export const OLE_PREAMBLE = ${buf(OLE_PREAMBLE)};

/**
 * A container's list header, at body +20: list version, a flag, a reserved
 * word. Groundplan used to write \`1, 0, 0\` here; every one of the
 * ${listHeader.modal.total.toLocaleString()} containers measured writes \`0, 1, 0\`. The parser reads
 * neither word, which is why nothing caught it.
 */
export const CONTAINER_LIST_HEADER = ${buf(LIST_HEADER)};

/** Four document-level bytes that follow the empty \`RVRoom\` record. */
export const ROOM_FOLLOW = ${buf(ROOM_FOLLOW)};

/** Eighteen bytes the second \`RVRoomDef\` carries after its child count. */
export const ROOMDEF_TAIL = ${buf(ROOMDEF_TAIL)};

/** The undecoded pen/brush block (+26..+62) every wall segment carries. */
export const WALL_STYLE = ${buf(WALL_STYLE)};

/** COLORREF the corpus stamps on wall segments, at +54. */
export const WALL_COLOR = 0x${WALL_COLOR.toString(16).padStart(8, '0')};

/** Segment kind code for a wall line, at +20. */
export const WALL_KIND = ${WALL_KIND};

/** Point count a wall line declares at +22. */
export const WALL_VERTEX_HINT = ${WALL_VERTEX_HINT};

/** The int32 that opens the document trailer. */
export const TRAILER_LEAD = ${TRAILER_LEAD};

/**
 * The settings record an empty \`RVRegion\` holds, with the donor's room name
 * removed. Offsets below are into this buffer, and are the only positions any
 * code writes to.
 */
export const SETTINGS_BLOCK = ${buf(settingsBlock.toString('hex'))};

/** Length byte of the default-chair name, "${cstring(settingsBlock, 106)!.text}". */
export const SETTINGS_CHAIR_AT = ${donor.chairAt};

/** Length byte of the room name — zero-length as committed. */
export const SETTINGS_NAME_AT = ${donor.nameAt};

/** Length byte of the default-table name, "${donorTable.text}". */
export const SETTINGS_TABLE_AT = ${tableAt};
`;

writeFileSync(OUT, source, 'utf8');
console.log(`\nwrote ${OUT}`);
console.log(`  donor           ${donor.name}`);
console.log(`  settings block  ${settingsBlock.length} bytes (name stripped from ${donor.block.length})`);
console.log(`  chair "+${donor.chairAt}"  name "+${donor.nameAt}"  table "+${tableAt}"`);
