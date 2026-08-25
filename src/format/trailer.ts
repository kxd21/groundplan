/**
 * The document trailer — what a plan records about itself.
 *
 * Every `.rv4` ends with the same run of bytes: `int32 1`, then eight or nine
 * length-prefixed strings, finishing exactly at the end of the stream. It holds
 * the show's date, venue, event, time and contact, and usually a plan GUID.
 * Measured over 400 plans on the production drive it was present in 400 — 262
 * with the GUID, 138 without — and no plan ended any other way.
 *
 * It lives in its own module because two subsystems need the same grammar and
 * neither can own it. `plan-skeleton.ts` writes the trailer when it builds a
 * plan, and `rv.ts` has to *recognise* one while parsing, because a trailer is
 * where an object ends. Before this existed the parser knew only about MFC
 * tags, so the last wall segment's point array had no boundary to stop at:
 *
 *   - `locateSegmentPoints` requires a segment's points to end on a valid tag.
 *     At the end of the last wall the next word is this trailer's `01 00`,
 *     which is a plain index where a class tag would be needed, so both the
 *     strong and the weak pass failed and the parser fell through to
 *     `locatePointArray` — a heuristic that keeps whichever 2-byte alignment
 *     fits the most coordinate pairs, breaking ties on the least trailing
 *     slack. Because the unclaimed trailer inflated the search window, a
 *     misaligned start could tie on count and win on slack. Real plans came out
 *     right by luck: their wall coordinates are odd numbers whose bytes do not
 *     re-read as plausible doubles when shifted. A room a round number of feet
 *     across does — a 20ft x 10ft room put the wall at -1200, and -1200 read
 *     six bytes late is -2.0000000000218856, which is a perfectly plausible
 *     coordinate. So a plan Groundplan created could not be read back, and the
 *     save gate correctly refused every one of them.
 *
 *   - The same missing boundary is why `doc.trailerStrings` was empty for every
 *     file in the corpus: the last segment's span ran to the end of the stream
 *     and swallowed the trailer, so nothing was left for the document to
 *     harvest, and `buildScene` could never find a plan's title.
 *
 * Recognising the trailer fixes both. It is a deliberately narrow rule — the
 * run has to end exactly at the end of the stream — so it cannot match part-way
 * through a point array.
 */

/** The int32 that opens the trailer. */
const LEAD = 1;

/**
 * Strings before the identifier. Slots 5, 6 and 7 were empty in all 400 plans
 * measured; they are written to keep the shape, not because they carry
 * anything.
 */
export const TRAILER_SLOTS = 8;

/** What each slot holds, by how the corpus fills them. */
export const TRAILER_DATE = 0;
export const TRAILER_VENUE = 1;
export const TRAILER_EVENT = 2;
export const TRAILER_TIME = 3;
export const TRAILER_CONTACT = 4;
/** The plan GUID, when the plan has one — 262 of 400. */
export const TRAILER_ID = 8;

/** Reads a length-prefixed latin1 string, or null when there is not one here. */
export function readCString(buf: Buffer, at: number): { text: string; end: number } | null {
  if (at < 0 || at >= buf.length) return null;
  const len = buf[at];
  if (len === 0xff || at + 1 + len > buf.length) return null;
  return { text: buf.toString('latin1', at + 1, at + 1 + len), end: at + 1 + len };
}

/**
 * Characters the trailer's single-byte encoding can actually carry.
 *
 * The format stores one byte per character, so anything outside latin1 has no
 * representation at all. `Buffer.from(text, 'latin1')` does not say so — it
 * silently keeps the low byte, turning an en dash into a stray 0x13 and a CJK
 * character into noise. Substituting is the honest failure: the name comes back
 * slightly wrong rather than as bytes that are not the name at all.
 */
function toLatin1(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0xff) {
      out += ch;
      continue;
    }
    // The punctuation people actually paste in from documents, mapped to the
    // nearest thing the format can hold.
    const swap =
      ch === '\u2013' || ch === '\u2014' ? '-' :
      ch === '\u2018' || ch === '\u2019' ? "'" :
      ch === '\u201c' || ch === '\u201d' ? '"' :
      ch === '\u2026' ? '...' :
      ch === '\u2022' ? '\u00b7' :
      '?';
    out += swap;
  }
  return out;
}

/** Writes one, truncating at the single length byte the format allows. */
export function writeCString(text: string): Buffer {
  const encoded = Buffer.from(toLatin1(text).slice(0, 254), 'latin1');
  return Buffer.concat([Buffer.from([encoded.length]), encoded]);
}

/**
 * Decodes the trailer starting at `at`, or null when these bytes are not one.
 *
 * Three things have to hold, and together they are what makes this safe to run
 * against arbitrary offsets inside a segment's point array: the lead int32, a
 * string count of exactly eight or nine, and a run that finishes on the last
 * byte of the stream rather than merely somewhere inside it.
 */
export function decodeTrailer(buf: Buffer, at: number, strict = true): string[] | null {
  if (at < 0 || at + 4 > buf.length || buf.readInt32LE(at) !== LEAD) return null;

  const out: string[] = [];
  let p = at + 4;
  while (p < buf.length) {
    if (out.length > TRAILER_SLOTS + 1) return null;
    const s = readCString(buf, p);
    if (!s) return null;
    /*
     * Two callers, two needs.
     *
     * HUNTING for a trailer at an arbitrary offset (`isTrailerAt`) needs the
     * tight test: every non-empty string in all 400 plans measured was
     * printable ASCII, and that is what stops a run of point-array bytes from
     * being mistaken for a trailer.
     *
     * READING a trailer we already know we are standing on does not, and the
     * tight test actively broke it: `writeCString` encodes latin1, so a venue
     * called "Café Royal" wrote 0xE9 quite correctly and then failed to decode,
     * taking the venue, event, date and contact with it. The write reached
     * disk; the read refused it. Accented names are ordinary in this industry
     * and must round-trip.
     *
     * Control bytes stay rejected either way — they are what actually
     * distinguishes text from coordinates.
     */
    const printable = strict
      ? /^[\x20-\x7e]*$/.test(s.text)
      : /^[\x20-\x7e\xa0-\xff]*$/.test(s.text);
    if (!printable) return null;
    out.push(s.text);
    p = s.end;
  }
  if (p !== buf.length) return null;
  if (out.length !== TRAILER_SLOTS && out.length !== TRAILER_SLOTS + 1) return null;
  return out;
}

/** True when the document trailer begins exactly here. */
export function isTrailerAt(buf: Buffer, at: number): boolean {
  return decodeTrailer(buf, at) !== null;
}

/** Builds a trailer from its slots; the identifier is written when present. */
export function buildTrailer(slots: string[], id?: string): Buffer {
  const filled = new Array<string>(TRAILER_SLOTS).fill('');
  for (let i = 0; i < Math.min(slots.length, TRAILER_SLOTS); i++) filled[i] = slots[i] ?? '';
  const lead = Buffer.alloc(4);
  lead.writeInt32LE(LEAD, 0);
  const strings = filled.map(writeCString);
  if (id) strings.push(writeCString(id));
  return Buffer.concat([lead, ...strings]);
}
