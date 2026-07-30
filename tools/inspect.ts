/**
 * Inspects a single Room Viewer file: object tree, warnings, and an optional
 * hex window used when reverse-engineering a class layout.
 *
 *   npm run inspect -- "<file>" [--tree] [--hex <offset>] [--len <bytes>]
 */

import { readFileSync } from 'node:fs';
import CFB from 'cfb';

import { loadFile, geometryExtent, classHistogram, type RVNode } from '../src/format/index.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: inspect <file> [--tree] [--hex <offset>] [--len <bytes>]');
  process.exit(1);
}

const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};

const loaded = loadFile(file);
const doc = loaded.document;

console.log(`${loaded.name}`);
console.log(`  container   ${loaded.container}${loaded.declaredEntries != null ? ` (${loaded.declaredEntries} entries)` : ''}`);
console.log(`  bytes       ${loaded.byteLength} on disk, ${doc.bytesConsumed}/${doc.bytesTotal} archive bytes consumed`);
console.log(`  roots       ${doc.roots.length}`);

const extent = geometryExtent(doc);
if (extent) {
  const w = (extent.maxX - extent.minX) / 120;
  const h = (extent.maxY - extent.minY) / 120;
  console.log(`  extent      ${w.toFixed(1)}ft x ${h.toFixed(1)}ft`);
}

console.log('\nclasses');
for (const [cls, n] of Object.entries(classHistogram(doc)).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(6)}  ${cls}`);
}

if (doc.trailerStrings.length) {
  console.log('\ntrailer strings');
  for (const s of doc.trailerStrings.slice(0, 12)) console.log(`  ${JSON.stringify(s)}`);
}

if (doc.warnings.length) {
  console.log(`\nwarnings (${doc.warnings.length})`);
  for (const w of doc.warnings.slice(0, 20)) console.log(`  @${w.offset}  ${w.message}`);
}

if (process.argv.includes('--tree')) {
  console.log('\ntree');
  const show = (n: RVNode, indent: string, limit: { left: number }) => {
    if (limit.left-- <= 0) return;
    const pts = n.points.length ? ` pts=${n.points.length}` : '';
    const kind = n.kind != null ? ` kind=${n.kind}` : '';
    const labels = n.labels.length ? ` ${JSON.stringify(n.labels.slice(0, 2))}` : '';
    const b = n.bounds;
    console.log(
      `${indent}${n.cls}@${n.offset} [${b.left},${b.top},${b.right},${b.bottom}]${kind}${pts}${labels}`,
    );
    for (const c of n.children) show(c, indent + '  ', limit);
  };
  const limit = { left: Number(flag('--limit') ?? 120) };
  for (const r of doc.roots) show(r, '  ', limit);
}

const hexAt = flag('--hex');
if (hexAt != null) {
  let buf = readFileSync(file);
  if (buf.readUInt32LE(0) === 0xe011cfd0) {
    const cf = CFB.read(buf, { type: 'buffer' });
    buf = Buffer.from(CFB.find(cf, 'Contents')!.content as Uint8Array);
  }
  const start = Math.max(0, Number(hexAt));
  const len = Number(flag('--len') ?? 256);
  console.log(`\nhex ${start}..${start + len}`);
  for (let i = start; i < Math.min(start + len, buf.length); i += 16) {
    const slice = buf.subarray(i, Math.min(i + 16, buf.length));
    const hex = slice.toString('hex').replace(/(..)/g, '$1 ').trim().padEnd(48);
    const asc = Array.from(slice)
      .map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.'))
      .join('');
    console.log(`${String(i).padStart(7)}  ${hex}  ${asc}`);
  }
}
