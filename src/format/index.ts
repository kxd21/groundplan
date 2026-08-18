/**
 * Entry point for reading every Room Viewer file type.
 *
 * Two containers exist:
 *   - `.rv4` / `.rs4` / `.se4` / `.ds4` are OLE2 compound files (a
 *     `COleDocument`) with the archive in a single `Contents` stream, preceded
 *     by a 12-byte document header.
 *   - `.add` / `.stk` / `.lib` / `.rsd` are the same archive stored raw, with
 *     libraries prefixed by a 32-bit entry count and `.rsd` starting directly
 *     at the first tag.
 */

import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import CFB from 'cfb';

import { parseArchive, walk, type RVDocument, type RVNode, type Point } from './rv.js';

export * from './rv.js';
export type { Rect } from './mfc.js';

const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
/** `COleDocument` typically writes three DWORDs before the archive proper. */
const OLE_CONTENTS_PREAMBLE = 12;
/** How far into a stream to look for the first class tag. */
const TAG_SEARCH_WINDOW = 256;

export type ContainerKind = 'ole-compound' | 'raw-archive' | 'counted-inventory';

/**
 * Finds the first `0xFFFF` new-class tag in a stream.
 *
 * The `COleDocument` preamble is usually 12 bytes, but not in every file the
 * corpus contains, and guessing wrong turns the first class tag into a bogus
 * object back-reference. Searching for the tag is both cheaper and safer than
 * enumerating preamble variants.
 */
function findFirstTag(buf: Buffer, hint: number): number {
  const limit = Math.min(buf.length - 6, TAG_SEARCH_WINDOW);
  for (let i = 0; i <= limit; i++) {
    if (buf.readUInt16LE(i) !== 0xffff) continue;
    const schema = buf.readUInt16LE(i + 2);
    const len = buf.readUInt16LE(i + 4);
    if (schema < 1 || schema > 16) continue;
    if (len < 3 || len > 48 || i + 6 + len > buf.length) continue;
    const name = buf.toString('latin1', i + 6, i + 6 + len);
    if (/^(RV|C)[A-Za-z0-9_]+$/.test(name)) return i;
  }
  return hint;
}

/**
 * Repairs a compound-file header whose signature bits have decayed.
 *
 * One file in the corpus reads `D0CF0160A1B112A1` with a sector shift of 1 —
 * the correct values with individual bits cleared, the signature of failing
 * storage rather than a different format version. The directory and FAT are
 * often still intact, so rewriting the header lets the payload be recovered.
 */
function repairCompoundHeader(buf: Buffer): Buffer | null {
  if (buf.length < 512) return null;
  // Every byte of the real signature must be reachable by only clearing bits.
  for (let i = 0; i < 8; i++) {
    if ((buf[i] & OLE_SIGNATURE[i]) !== buf[i]) return null;
  }
  const patched = Buffer.from(buf);
  OLE_SIGNATURE.copy(patched, 0);
  const major = patched.readUInt16LE(26);
  patched.writeUInt16LE(major === 4 ? 0x000c : 0x0009, 30); // sector shift
  patched.writeUInt16LE(0x0006, 32); // mini-sector shift
  return patched;
}

export interface LoadedFile {
  path: string;
  name: string;
  extension: string;
  container: ContainerKind;
  /** Entry count declared by inventory files, when present. */
  declaredEntries?: number;
  /** True when a damaged compound-file header had to be reconstructed. */
  repaired: boolean;
  document: RVDocument;
  byteLength: number;
}

/**
 * Scans an entire file for the start of the MFC archive, used when the
 * compound-file directory cannot be trusted.
 */
function carveArchive(buf: Buffer): number | null {
  for (let i = 0; i + 6 < buf.length; i++) {
    if (buf.readUInt16LE(i) !== 0xffff) continue;
    const schema = buf.readUInt16LE(i + 2);
    const len = buf.readUInt16LE(i + 4);
    if (schema < 1 || schema > 16) continue;
    if (len < 3 || len > 48 || i + 6 + len > buf.length) continue;
    const name = buf.toString('latin1', i + 6, i + 6 + len);
    if (/^RV[A-Za-z0-9_]+$/.test(name)) return i;
  }
  return null;
}

export interface Unwrapped {
  body: Buffer;
  start: number;
  container: ContainerKind;
  declaredEntries?: number;
  repaired?: boolean;
}

/** Splits a file into its archive body and the offset of the first tag. */
function unwrap(buf: Buffer): Unwrapped {
  const looksCompound = buf.length >= 8 && buf.readUInt16LE(0) === 0xcfd0;

  if (looksCompound) {
    let source = buf;
    let repaired = false;
    if (!buf.subarray(0, 8).equals(OLE_SIGNATURE)) {
      const fixed = repairCompoundHeader(buf);
      if (fixed) {
        source = fixed;
        repaired = true;
      }
    }

    try {
      const cf = CFB.read(source, { type: 'buffer' });
      const entry = CFB.find(cf, 'Contents');
      if (!entry || !entry.content) {
        throw new Error('compound file has no "Contents" stream');
      }
      const body = Buffer.from(entry.content as Uint8Array);
      return {
        body,
        start: findFirstTag(body, OLE_CONTENTS_PREAMBLE),
        container: 'ole-compound',
        repaired,
      };
    } catch {
      // The directory or FAT is unreadable. The archive itself is plain bytes
      // inside the file, so carve it out and parse whatever survives; the
      // resynchronising parser recovers everything up to the first bad sector.
      const carved = carveArchive(buf);
      if (!carved) throw new Error('compound file is damaged and no archive data could be recovered');
      return { body: buf, start: carved, container: 'ole-compound', repaired: true };
    }
  }

  if (buf.length >= 2 && buf.readUInt16LE(0) === 0xffff) {
    return { body: buf, start: 0, container: 'raw-archive' };
  }

  if (buf.length >= 6 && buf.readUInt16LE(4) === 0xffff) {
    return {
      body: buf,
      start: 4,
      container: 'counted-inventory',
      declaredEntries: buf.readUInt32LE(0),
    };
  }

  throw new Error('unrecognised container: not an OLE compound file or MFC archive');
}

export function loadBuffer(buf: Buffer, path = '<memory>'): LoadedFile {
  const { body, start, container, declaredEntries, repaired } = unwrap(buf);
  const document = parseArchive(body, start);
  return {
    path,
    name: basename(path),
    extension: extname(path).toLowerCase(),
    container,
    declaredEntries,
    repaired: repaired ?? false,
    document,
    byteLength: buf.length,
  };
}

export function loadFile(path: string): LoadedFile {
  return loadBuffer(readFileSync(path), path);
}

export interface Extent {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Bounding box of all drawn geometry, in logical units. */
export function geometryExtent(doc: RVDocument): Extent | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let seen = false;

  for (const node of walk(doc)) {
    for (const p of node.points) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      seen = true;
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }

  return seen ? { minX, minY, maxX, maxY } : null;
}

/** Counts objects by class — the quickest way to sanity-check a parse. */
export function classHistogram(doc: RVDocument): Record<string, number> {
  const out: Record<string, number> = {};
  for (const node of walk(doc)) out[node.cls] = (out[node.cls] ?? 0) + 1;
  return out;
}

export type { RVDocument, RVNode, Point };
