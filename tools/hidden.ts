/**
 * Finds objects buried inside another object's header or trailer.
 *
 * Byte coverage can look perfect while objects are still lost: if a parent
 * resynchronises by scanning to the next tag it recognises, any object in the
 * skipped region is absorbed into the parent's span rather than decoded. Those
 * objects never register in the load array, so every later class reference
 * shifts and whole branches of the plan disappear.
 *
 *   npx tsx tools/hidden.ts <file>
 */

import { readFileSync } from 'node:fs';
import CFB from 'cfb';

import { loadFile } from '../src/format/index.js';
import type { RVNode } from '../src/format/index.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: hidden <file>');
  process.exit(1);
}

const loaded = loadFile(file);

let buf = readFileSync(file);
if (buf.length > 8 && buf.readUInt16LE(0) === 0xcfd0) {
  const cf = CFB.read(buf, { type: 'buffer' });
  buf = Buffer.from(CFB.find(cf, 'Contents')!.content as Uint8Array);
}

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

/** A definite object start: a new-class tag naming a real Room Viewer class. */
function newClassAt(at: number): string | null {
  if (at + 6 > buf.length) return null;
  if (buf.readUInt16LE(at) !== 0xffff) return null;
  const schema = buf.readUInt16LE(at + 2);
  const len = buf.readUInt16LE(at + 4);
  if (schema < 1 || schema > 16) return null;
  if (len < 3 || len > 48 || at + 6 + len > buf.length) return null;
  const name = buf.toString('latin1', at + 6, at + 6 + len);
  return /^(RV|C)[A-Za-z0-9_]+$/.test(name) ? name : null;
}

const decoded = new Set(nodes.map((n) => n.span.tagAt));
const hidden: Array<{ cls: string; at: number; inside: RVNode; region: string }> = [];

for (const n of nodes) {
  const regions: Array<[number, number, string]> = [
    [n.span.bodyAt, n.span.headerEnd, 'header'],
    [n.span.trailerAt, n.span.end, 'trailer'],
  ];
  for (const [from, to, region] of regions) {
    for (let at = from; at < to; at++) {
      const cls = newClassAt(at);
      if (cls && !decoded.has(at)) hidden.push({ cls, at, inside: n, region });
    }
  }
}

console.log(`${loaded.name}`);
console.log(`  decoded objects       ${nodes.length}`);
console.log(`  hidden new-class tags ${hidden.length}`);

for (const h of hidden.slice(0, 12)) {
  console.log(
    `    ${h.cls} at ${h.at} — buried in ${h.inside.cls}@${h.inside.span.tagAt} ${h.region} ` +
      `(${h.inside.span.bodyAt}..${h.region === 'header' ? h.inside.span.headerEnd : h.inside.span.end})`,
  );
}
if (hidden.length > 12) console.log(`    ... and ${hidden.length - 12} more`);
