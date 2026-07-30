/**
 * Small, synthetic Room Viewer archive used by mandatory tests.
 *
 * The production corpus contains customer names and venue geometry, so it must
 * never be copied into CI. This fixture is built from scratch and contains one
 * placed rectangle, one editable label, and one dimension line. It exercises
 * the same MFC tag stream, parser, serializer, scene, and editing code as a real
 * plan without carrying production data.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import CFB from 'cfb';

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

class Bytes {
  private readonly chunks: Buffer[] = [];

  push(value: Buffer): void {
    this.chunks.push(value);
  }

  u8(value: number): void {
    const out = Buffer.alloc(1);
    out.writeUInt8(value);
    this.push(out);
  }

  u16(value: number): void {
    const out = Buffer.alloc(2);
    out.writeUInt16LE(value);
    this.push(out);
  }

  u32(value: number): void {
    const out = Buffer.alloc(4);
    out.writeUInt32LE(value);
    this.push(out);
  }

  i32(value: number): void {
    const out = Buffer.alloc(4);
    out.writeInt32LE(value);
    this.push(out);
  }

  f64(value: number): void {
    const out = Buffer.alloc(8);
    out.writeDoubleLE(value);
    this.push(out);
  }

  cstring(value: string): void {
    const encoded = Buffer.from(value, 'latin1');
    if (encoded.length > 254) throw new Error('fixture CString is too long');
    this.u8(encoded.length);
    this.push(encoded);
  }

  newClass(name: string): void {
    const encoded = Buffer.from(name, 'latin1');
    this.u16(0xffff);
    this.u16(1);
    this.u16(encoded.length);
    this.push(encoded);
  }

  common(rect: Rect): void {
    this.i32(1);
    this.i32(rect.left);
    this.i32(rect.top);
    this.i32(rect.right);
    this.i32(rect.bottom);
  }

  buffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

function segmentBody(kind: number, points: Array<[number, number]>, bounds: Rect, color = 0x002f6fed): Buffer {
  const out = Buffer.alloc(62 + points.length * 16);
  out.writeInt32LE(1, 0);
  out.writeInt32LE(bounds.left, 4);
  out.writeInt32LE(bounds.top, 8);
  out.writeInt32LE(bounds.right, 12);
  out.writeInt32LE(bounds.bottom, 16);
  out.writeUInt16LE(kind, 20);
  out.writeInt32LE(points.length, 22);
  out.writeUInt32LE(color, 54);
  for (let i = 0; i < points.length; i++) {
    out.writeDoubleLE(points[i][0], 62 + i * 16);
    out.writeDoubleLE(points[i][1], 62 + i * 16 + 8);
  }
  return out;
}

function fixtureArchiveBody(): Buffer {
  const out = new Bytes();

  out.newClass('RVShape');
  out.common({ left: 900, top: 1950, right: 1100, bottom: 2050 });
  out.u16(1);
  out.u16(0);
  out.u16(0);
  out.f64(1000);
  out.f64(2000);
  out.f64(1000);
  out.f64(2000);
  out.f64(0);
  out.i32(0);
  out.cstring('');
  out.cstring('Fixture Table');

  out.newClass('RVGeometry');
  out.common({ left: -100, top: -50, right: 100, bottom: 50 });
  out.u16(1);
  out.u16(0);
  out.u16(0);
  out.u16(1);

  out.newClass('RVSegmentRect');
  out.push(
    segmentBody(
      2,
      [
        [-100, -50],
        [100, -50],
        [100, 50],
        [-100, 50],
      ],
      { left: -100, top: -50, right: 100, bottom: 50 },
    ),
  );

  out.newClass('RVLabel');
  out.common({ left: 850, top: 1800, right: 1150, bottom: 1900 });
  out.u16(1);
  out.u16(0);
  out.u16(0);
  out.f64(1000);
  out.f64(1850);
  out.f64(1000);
  out.f64(1850);
  out.f64(0);
  out.i32(0);
  out.i32(-90);
  out.i32(0);
  out.i32(0);
  out.i32(0);
  out.i32(400);
  out.push(Buffer.alloc(8));
  out.cstring('Arial');
  out.cstring('Fixture note');
  out.u32(0);
  out.i32(0);
  out.f64(0);
  out.f64(0);
  out.f64(0);
  out.f64(0);
  out.i32(0);
  out.f64(0);

  out.newClass('RVDimensionLine');
  out.push(
    segmentBody(
      0,
      [
        [800, 2200],
        [1200, 2200],
      ],
      { left: 800, top: 2200, right: 1200, bottom: 2200 },
      0,
    ),
  );

  return out.buffer();
}

export function fixturePlanBuffer(): Buffer {
  const compound = CFB.utils.cfb_new();
  const contents = Buffer.concat([Buffer.alloc(12), fixtureArchiveBody()]);
  CFB.utils.cfb_add(compound, 'Contents', contents);
  return Buffer.from(CFB.write(compound, { type: 'buffer' }) as Uint8Array);
}

export function fixtureCorpus(): { directory: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'groundplan-fixture-'));
  writeFileSync(join(directory, 'Synthetic fixture.rv4'), fixturePlanBuffer());
  return {
    directory,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
