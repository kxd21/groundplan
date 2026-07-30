/**
 * Reports stream bytes that no decoded object accounts for.
 *
 * Every byte of an archive belongs to some object, so a gap means the parser
 * skipped something — and because MFC tags are resolved through a shared load
 * array, a single skipped object shifts every later index and silently drops
 * whatever follows. This locates the first gap, which is where to look.
 *
 *   npx tsx tools/coverage.ts <file> [--all]
 */

import { readFileSync } from 'node:fs';
import CFB from 'cfb';

import { loadFile } from '../src/format/index.js';
import type { RVNode } from '../src/format/index.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: coverage <file> [--all]');
  process.exit(1);
}

const loaded = loadFile(file);

const nodes: RVNode[] = [];
const seen = new Set<RVNode>();
const stack = [...loaded.document.roots];
while (stack.length) {
  const n = stack.pop()!;
  if (seen.has(n)) continue;
  seen.add(n);
  nodes.push(n);
  for (const c of n.children) stack.push(c);
}
nodes.sort((a, b) => a.span.tagAt - b.span.tagAt);

let cursor = -1;
const gaps: Array<{ from: number; to: number; after?: RVNode; before?: RVNode }> = [];
/**
 * A parent legitimately encloses its children, so only a *sibling-level*
 * overlap is a defect: one object's bytes running past where the next
 * top-of-stream object begins means it swallowed something.
 */
const overlaps: Array<{ node: RVNode; next: RVNode; by: number }> = [];
let prev: RVNode | undefined;

for (const n of nodes) {
  if (cursor === -1) cursor = n.span.tagAt;
  if (n.span.tagAt > cursor) gaps.push({ from: cursor, to: n.span.tagAt, after: prev, before: n });
  if (prev && prev.span.end > n.span.tagAt && prev.span.headerEnd > n.span.tagAt && !prev.children.includes(n)) {
    overlaps.push({ node: prev, next: n, by: prev.span.end - n.span.tagAt });
  }
  cursor = Math.max(cursor, n.span.end);
  prev = n;
}

let buf = readFileSync(file);
if (buf.length > 8 && buf.readUInt16LE(0) === 0xcfd0) {
  const cf = CFB.read(buf, { type: 'buffer' });
  buf = Buffer.from(CFB.find(cf, 'Contents')!.content as Uint8Array);
}

console.log(`${loaded.name}`);
console.log(`  objects   ${nodes.length}`);
console.log(`  stream    ${buf.length} bytes, accounted to ${cursor}`);
console.log(`  gaps      ${gaps.length}`);
console.log(`  overlaps  ${overlaps.length}`);

for (const o of overlaps.slice(0, 5)) {
  console.log(
    `\n  ${o.node.cls}@${o.node.span.tagAt} runs to ${o.node.span.end}, past ${o.next.cls}@${o.next.span.tagAt} by ${o.by} bytes`,
  );
  console.log(
    `    header ${o.node.span.bodyAt}..${o.node.span.headerEnd}  points=${o.node.points.length}  children=${o.node.children.length}`,
  );
}

const show = process.argv.includes('--all') ? gaps : gaps.slice(0, 5);
for (const g of show) {
  console.log(`\n  gap ${g.from}..${g.to} (${g.to - g.from} bytes)`);
  console.log(`    after  ${g.after?.cls}@${g.after?.span.tagAt} (ends ${g.after?.span.end})`);
  console.log(`    before ${g.before?.cls}@${g.before?.span.tagAt}`);
  const slice = buf.subarray(g.from, Math.min(g.to + 16, buf.length));
  for (let i = 0; i < Math.min(slice.length, 96); i += 16) {
    const row = slice.subarray(i, i + 16);
    const hex = row.toString('hex').replace(/(..)/g, '$1 ').trim().padEnd(48);
    const asc = Array.from(row)
      .map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.'))
      .join('');
    console.log(`    ${String(g.from + i).padStart(7)}  ${hex}  ${asc}`);
  }
}

if (gaps.length > show.length) console.log(`\n  ... and ${gaps.length - show.length} more gaps`);
