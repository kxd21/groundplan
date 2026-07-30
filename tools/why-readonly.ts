import { readFileSync } from 'node:fs';
import { loadBuffer } from '../src/format/index.js';
import { roundTrip } from '../src/format/write.js';
import type { RVNode } from '../src/format/index.js';

const path = process.argv[2];
const loaded = loadBuffer(readFileSync(path), path);
const doc = loaded.document;

const seen = new Set<RVNode>();
const stack = [...doc.roots];
let objects = 0;
const classes = new Set<string>();
while (stack.length) {
  const n = stack.pop()!;
  if (seen.has(n)) continue;
  seen.add(n);
  objects++;
  classes.add(n.cls);
  for (const c of n.children) stack.push(c);
}

console.log(`${loaded.name}`);
console.log(`  archive bytes   ${doc.bytesTotal.toLocaleString()}`);
console.log(`  objects         ${objects.toLocaleString()}`);
console.log(`  distinct classes ${classes.size}`);
console.log(`  load-array size ~${(objects + classes.size).toLocaleString()}  (WORD tags max out at 32,766)`);
console.log(`  parse warnings  ${doc.warnings.length}`);
for (const w of doc.warnings.slice(0, 3)) console.log(`    ${w.message}`);

const rt = roundTrip(doc);
console.log(`  round-trips     ${rt.identical ? 'yes' : 'no'}`);
if (!rt.identical) {
  console.log(`  diverges at     ${rt.divergesAt?.toLocaleString()} of ${doc.source.length.toLocaleString()}`);
  if (rt.error) console.log(`  error           ${rt.error}`);
  const at = rt.divergesAt ?? 0;
  const src = doc.source.subarray(Math.max(0, at - 16), at + 16).toString('hex');
  const out = rt.written.subarray(Math.max(0, at - 16), at + 16).toString('hex');
  console.log(`  source  ...${src}`);
  console.log(`  written ...${out}`);
}
