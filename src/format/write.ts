/**
 * Serializes a parsed document back to an MFC `CArchive` stream.
 *
 * The guiding rule is **preserve what you did not model**. Room Viewer objects
 * carry fields this project never decoded — pen styles, fill patterns, seat
 * counts, flags whose meaning is unknown — and re-synthesising an object from
 * the parts we understand would silently discard them. So each object is
 * re-emitted from its original bytes, and edits are patches applied to known
 * offsets inside those bytes.
 *
 * The one thing that *must* be regenerated is the tag stream. MFC resolves
 * classes and shared objects through a load array built in read order, so
 * inserting or removing a single object renumbers every later reference.
 * `serializeArchive` therefore rebuilds tags from scratch while copying bodies
 * verbatim.
 *
 * Correctness is checked by round-tripping the whole corpus: parsing and
 * re-serializing an unedited file must reproduce it byte for byte. Saving is
 * only offered for files that pass that check (see `canSave`).
 */

import CFB from 'cfb';

import { parseArchive, type RVDocument, type RVNode, type RVChildSlot } from './rv.js';

const NEW_CLASS_TAG = 0xffff;
const CLASS_TAG = 0x8000;
/** MFC switches to a 32-bit tag once the load array outgrows this. */
const BIG_OBJECT_TAG = 0x7fff;

class ByteWriter {
  private chunks: Buffer[] = [];
  private length = 0;

  push(buf: Buffer): void {
    this.chunks.push(buf);
    this.length += buf.length;
  }

  u16(v: number): void {
    const b = Buffer.allocUnsafe(2);
    b.writeUInt16LE(v, 0);
    this.push(b);
  }

  get size(): number {
    return this.length;
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks, this.length);
  }
}

/** Mirrors MFC's `m_pLoadArray`: classes and objects share one index space. */
class EmitContext {
  private entries = 0;
  readonly classIndex = new Map<string, number>();
  readonly objectIndex = new Map<RVNode, number>();

  addClass(name: string): number {
    const index = ++this.entries;
    this.classIndex.set(name, index);
    return index;
  }

  addObject(node: RVNode): number {
    const index = ++this.entries;
    this.objectIndex.set(node, index);
    return index;
  }

  get size(): number {
    return this.entries;
  }
}

export class SerializeError extends Error {}

function writeNode(node: RVNode, doc: RVDocument, out: ByteWriter, ctx: EmitContext): void {
  const already = ctx.objectIndex.get(node);
  if (already != null) {
    // Shared instance: emit a bare object reference, no body.
    if (already >= BIG_OBJECT_TAG) {
      throw new SerializeError(`object index ${already} needs 32-bit tags, which are not implemented`);
    }
    out.u16(already);
    return;
  }

  const known = ctx.classIndex.get(node.cls);
  if (known == null) {
    // Introduce the class here. Normally this is the object that introduced it
    // in the source, which keeps an untouched file byte-identical. It also
    // covers the case where that object was deleted: any object may introduce
    // its own class, so the remaining ones stay readable.
    out.u16(NEW_CLASS_TAG);
    out.u16(node.schema);
    const name = Buffer.from(node.cls, 'latin1');
    out.u16(name.length);
    out.push(name);
    ctx.addClass(node.cls);
  } else {
    if (known >= BIG_OBJECT_TAG) {
      throw new SerializeError(`class index ${known} needs 32-bit tags, which are not implemented`);
    }
    out.u16(CLASS_TAG | known);
  }

  ctx.addObject(node);

  // Edited objects carry a patched copy of their original bytes.
  out.push(node.headerOverride ?? doc.source.subarray(node.span.bodyAt, node.span.headerEnd));

  for (const slot of node.slots) {
    writeSlot(slot, doc, out, ctx);
  }

  out.push(node.trailerOverride ?? doc.source.subarray(node.span.trailerAt, node.span.end));
}

function writeSlot(slot: RVChildSlot, doc: RVDocument, out: ByteWriter, ctx: EmitContext): void {
  if (slot.kind === 'null') {
    out.u16(0);
    return;
  }

  if (slot.kind === 'ref') {
    if (slot.node) {
      const index = ctx.objectIndex.get(slot.node);
      if (index == null) {
        throw new SerializeError(`reference to ${slot.node.cls} that has not been written yet`);
      }
      out.u16(index);
      return;
    }
    // A parent pointer the parser declined to follow. Its target is an object
    // that encloses this one and has therefore already been written, so its
    // current index is known. Re-resolving rather than replaying the source's
    // index is what keeps the pointer correct once an object has been inserted
    // ahead of the target and renumbered it.
    const resolved = slot.refTarget ? ctx.objectIndex.get(slot.refTarget) : undefined;
    if (resolved != null) {
      out.u16(resolved);
      return;
    }
    if (slot.sourceIndex == null) {
      throw new SerializeError('reference slot has no recorded index');
    }
    out.u16(slot.sourceIndex);
    return;
  }

  if (!slot.node) throw new SerializeError('object slot has no node');
  writeNode(slot.node, doc, out, ctx);
}

/**
 * Rebuilds the archive body.
 *
 * The document's parts cover every byte of the stream in order, so walking
 * them reproduces the preamble, each object, any region the parser could not
 * attribute, and the trailing plan metadata.
 */
export function serializeArchive(doc: RVDocument): Buffer {
  const out = new ByteWriter();
  const ctx = new EmitContext();

  for (const part of doc.parts) {
    if (part.kind === 'raw') out.push(doc.source.subarray(part.from, part.to));
    else writeNode(part.node, doc, out, ctx);
  }

  return out.toBuffer();
}

export interface RoundTripResult {
  identical: boolean;
  /** First differing byte offset, when the result is not identical. */
  divergesAt?: number;
  written: Buffer;
  error?: string;
}

/**
 * Re-serializes a document and compares it with its source.
 *
 * This is the safety gate for editing: if an untouched document does not
 * reproduce itself exactly, the parser's understanding of that file is
 * incomplete and saving it could destroy data.
 */
export function roundTrip(doc: RVDocument): RoundTripResult {
  let written: Buffer;
  try {
    written = serializeArchive(doc);
  } catch (err) {
    return {
      identical: false,
      written: Buffer.alloc(0),
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (written.equals(doc.source)) return { identical: true, written };

  const limit = Math.min(written.length, doc.source.length);
  let at = limit;
  for (let i = 0; i < limit; i++) {
    if (written[i] !== doc.source[i]) {
      at = i;
      break;
    }
  }
  return { identical: false, divergesAt: at, written };
}

/** True when a document can be saved without risking data loss. */
export function canSave(doc: RVDocument): boolean {
  return roundTrip(doc).identical;
}

/**
 * A description of every object in serialize order, used to prove that writing
 * a document and reading it back yields the same document.
 *
 * Bounds, geometry and list shape are all included, because those are what a
 * mis-sized header would corrupt: a segment whose point array the parser
 * locates two bytes off still parses, and still produces a plausible-looking
 * object, but not the same one.
 */
function census(doc: RVDocument): string[] {
  const out: string[] = [];
  const seen = new Set<RVNode>();

  const visit = (node: RVNode): void => {
    if (seen.has(node)) {
      out.push(`shared ${node.cls}`);
      return;
    }
    seen.add(node);

    const b = node.bounds;
    const points = node.points.map((p) => `${p.x},${p.y}`).join(' ');
    out.push(
      `${node.cls} v${node.version} s${node.schema} ` +
        `[${b.left},${b.top},${b.right},${b.bottom}] ` +
        `slots=${node.slots.length} pts=${node.points.length} {${points}}`,
    );

    for (const slot of node.slots) {
      if (slot.kind === 'null') out.push('  null');
      else if (slot.kind === 'ref') out.push(`  ref ${slot.node?.cls ?? slot.refTarget?.cls ?? '?'}`);
      else if (slot.node) visit(slot.node);
      else out.push('  empty');
    }
  };

  for (const part of doc.parts) {
    if (part.kind === 'node') visit(part.node);
  }
  return out;
}

export interface WritableCheck {
  ok: boolean;
  reason?: string;
  /** The bytes that were verified, ready to be packed into a container. */
  bytes?: Buffer;
}

/**
 * The save gate for a document that has had objects added to it.
 *
 * `roundTrip` cannot judge these. It asks whether a document still reproduces
 * the file it was read from, and a document with a newly created wall in it is
 * deliberately not that file any more — it would fail by design, which is why
 * "run the round-trip gate after synthesis" is not on its own a usable rule.
 *
 * The equivalent guarantee for creation is self-consistency. Write the
 * document, read the result back with the same parser, and require that:
 *
 *   - the reparse round-trips byte for byte, so the parser accounts for every
 *     byte we produced and would reproduce them again;
 *   - the object census matches, so nothing was dropped, duplicated, or decoded
 *     into different geometry than it was written with;
 *   - no new parse warnings appeared.
 *
 * A synthesized object that the parser cannot read back exactly fails all
 * three, and the save is refused rather than a broken file being written.
 */
export function verifyWritable(doc: RVDocument): WritableCheck {
  let bytes: Buffer;
  try {
    bytes = serializeArchive(doc);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  let reparsed: RVDocument;
  try {
    reparsed = parseArchive(bytes, doc.archiveStart);
  } catch (err) {
    return {
      ok: false,
      reason: `the written document could not be read back: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const stable = roundTrip(reparsed);
  if (!stable.identical) {
    return {
      ok: false,
      reason: stable.error
        ? `the written document does not re-serialize: ${stable.error}`
        : `the written document does not re-serialize (diverges at byte ${stable.divergesAt})`,
    };
  }

  const before = census(doc);
  const after = census(reparsed);
  if (before.length !== after.length) {
    // Seen once in 1,955 corpus files, and always as the reparse resolving one
    // *more* reference than the document held. The bytes are self-consistent —
    // they round-trip — but the object graph is not provably the one intended,
    // and that is exactly the case to decline rather than guess about.
    const more = after.length > before.length;
    return {
      ok: false,
      reason:
        `reading the document back found ${after.length} objects where it held ${before.length}. ` +
        `Its structure is not reproduced exactly enough to write ${more ? 'into' : 'from'} safely. ` +
        `Adding at the top level of the plan rather than inside a group may work.`,
    };
  }
  for (let i = 0; i < before.length; i++) {
    if (before[i] !== after[i]) {
      return { ok: false, reason: `object ${i + 1} read back as "${after[i]}", not "${before[i]}"` };
    }
  }

  if (reparsed.warnings.length > doc.warnings.length) {
    const fresh = reparsed.warnings[doc.warnings.length];
    return { ok: false, reason: `the written document parses with a new warning: ${fresh.message}` };
  }

  return { ok: true, bytes };
}

/**
 * Repacks an archive body into the container it came from.
 *
 * Compound-file plans keep the archive in a single `Contents` stream; raw
 * inventory formats are the archive itself.
 */
export function packContainer(original: Buffer, body: Buffer): Buffer {
  const isCompound = original.length >= 8 && original.readUInt16LE(0) === 0xcfd0;
  if (!isCompound) return body;

  const cf = CFB.read(original, { type: 'buffer' });
  CFB.utils.cfb_del(cf, 'Contents');
  CFB.utils.cfb_add(cf, 'Contents', body);
  const out = CFB.write(cf, { type: 'buffer' }) as Uint8Array;
  return Buffer.from(out);
}
