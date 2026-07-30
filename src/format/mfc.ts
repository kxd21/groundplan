/**
 * Low-level reader for Microsoft Foundation Class `CArchive` serialization.
 *
 * Room Viewer (TimeSaver Software, 1990s–2013) persisted its documents with
 * MFC's `CArchive`, which is *not* self-describing: it emits a tag stream where
 * each object is either a brand-new class (name + schema written inline) or a
 * back-reference into a "load array" of everything seen so far. Field layouts
 * live only in the original C++ `Serialize()` methods, so the per-class layouts
 * in `rv.ts` were recovered by analysing the file corpus.
 *
 * Tag semantics (matching MFC's `CArchive::ReadObject` / `ReadClass`):
 *   0x0000        — null object
 *   0xFFFF        — new class follows: WORD schema, WORD nameLen, ASCII name
 *   0x8000 | idx  — object of an already-seen class at load-array index `idx`
 *   otherwise     — back-reference to an already-deserialized object
 *
 * The load array is 1-based and holds classes *and* objects interleaved, which
 * is why a second `RVSegmentLine` in a file tagged `RVRoomDef`(1) + object(2) +
 * `RVSegmentLine`(3) + object(4) comes back as tag 0x8003.
 */

export const NULL_TAG = 0x0000;
export const NEW_CLASS_TAG = 0xffff;
export const CLASS_TAG = 0x8000;

/** An entry in MFC's `m_pLoadArray`. Classes and objects share the index space. */
export type LoadEntry =
  | { kind: 'class'; name: string; schema: number }
  | { kind: 'object'; name: string };

export class ArchiveError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(`${message} (at byte ${offset})`);
    this.name = 'ArchiveError';
  }
}

/** A cursor over an MFC archive stream with the load array attached. */
export class ArchiveReader {
  pos: number;
  readonly loadArray: LoadEntry[] = [];

  constructor(
    readonly buf: Buffer,
    start = 0,
  ) {
    this.pos = start;
  }

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  get eof(): boolean {
    return this.pos >= this.buf.length;
  }

  private need(n: number, what: string): void {
    if (this.pos + n > this.buf.length) {
      throw new ArchiveError(`unexpected end of stream reading ${what}`, this.pos);
    }
  }

  u8(): number {
    this.need(1, 'byte');
    return this.buf.readUInt8(this.pos++);
  }

  u16(): number {
    this.need(2, 'word');
    const v = this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }

  i32(): number {
    this.need(4, 'int32');
    const v = this.buf.readInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  u32(): number {
    this.need(4, 'uint32');
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  f64(): number {
    this.need(8, 'double');
    const v = this.buf.readDoubleLE(this.pos);
    this.pos += 8;
    return v;
  }

  skip(n: number): void {
    this.need(n, `${n} bytes`);
    this.pos += n;
  }

  /**
   * MFC `CString` serialization: a length byte, escalating to WORD (0xFF
   * prefix) and DWORD (0xFFFF prefix) for longer strings.
   */
  cstring(): string {
    let len = this.u8();
    if (len === 0xff) {
      len = this.u16();
      if (len === 0xffff) len = this.u32();
    }
    this.need(len, `string of ${len} bytes`);
    const s = this.buf.toString('latin1', this.pos, this.pos + len);
    this.pos += len;
    return s;
  }

  /** MFC `CRect`: left, top, right, bottom as 32-bit signed logical units. */
  rect(): Rect {
    return { left: this.i32(), top: this.i32(), right: this.i32(), bottom: this.i32() };
  }

  peekU16(at = this.pos): number | null {
    if (at + 2 > this.buf.length) return null;
    return this.buf.readUInt16LE(at);
  }

  /**
   * Reads an object tag and resolves it to a class name, registering new
   * classes in the load array. Returns `null` for the null tag, and a
   * `backref` result when the tag points at an already-deserialized object
   * (in which case no payload follows and the caller must not read fields).
   */
  readTag(): TagResult {
    const offset = this.pos;
    const tag = this.u16();

    if (tag === NULL_TAG) return { kind: 'null', offset };

    if (tag === NEW_CLASS_TAG) {
      const schema = this.u16();
      const nameLen = this.u16();
      if (nameLen < 1 || nameLen > 64) {
        throw new ArchiveError(`implausible class-name length ${nameLen}`, offset);
      }
      this.need(nameLen, 'class name');
      const name = this.buf.toString('latin1', this.pos, this.pos + nameLen);
      this.pos += nameLen;
      this.loadArray.push({ kind: 'class', name, schema });
      return { kind: 'object', name, schema, offset, newClass: true };
    }

    if ((tag & CLASS_TAG) !== 0) {
      const idx = tag & ~CLASS_TAG;
      const entry = this.loadArray[idx - 1];
      if (!entry || entry.kind !== 'class') {
        throw new ArchiveError(`class tag 0x${tag.toString(16)} does not resolve to a class`, offset);
      }
      return { kind: 'object', name: entry.name, schema: entry.schema, offset, newClass: false };
    }

    const entry = this.loadArray[tag - 1];
    if (!entry) {
      throw new ArchiveError(`object back-reference ${tag} is out of range`, offset);
    }
    return { kind: 'backref', name: entry.name, offset, index: tag };
  }

  /** Registers a freshly deserialized object so later back-references resolve. */
  registerObject(name: string): number {
    this.loadArray.push({ kind: 'object', name });
    return this.loadArray.length;
  }
}

export type TagResult =
  | { kind: 'null'; offset: number }
  | { kind: 'object'; name: string; schema: number; offset: number; newClass: boolean }
  | { kind: 'backref'; name: string; offset: number; index: number };

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
