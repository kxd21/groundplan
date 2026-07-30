import { readFileSync } from 'node:fs';
import { loadBuffer, walk } from '../src/format/index.js';
import { buildScene } from '../src/format/scene.js';
import type { RVNode } from '../src/format/index.js';
const path = process.argv[2];
const loaded = loadBuffer(readFileSync(path), path);
const doc = loaded.document;
const scene = buildScene(doc);

const cls = new Map<string, number>();
for (const n of walk(doc)) cls.set(n.cls, (cls.get(n.cls) ?? 0) + 1);
console.log('object classes');
for (const [c, n] of [...cls].sort((a,b)=>b[1]-a[1])) console.log(`  ${String(n).padStart(6)}  ${c}`);

// Rotation spread of placed shapes tells us whether blocks are angled.
const angles = new Map<string, number>();
let rotated = 0, total = 0;
for (const n of walk(doc)) {
  if (n.cls !== 'RVShape' || n.angle == null) continue;
  total++;
  const deg = Math.round((n.angle * 180) / Math.PI);
  const norm = ((deg % 360) + 360) % 360;
  if (norm % 90 !== 0) rotated++;
  angles.set(String(norm), (angles.get(String(norm)) ?? 0) + 1);
}
console.log(`\nplaced shapes with a rotation: ${total}; not on a 90° step: ${rotated}`);
console.log('most common angles (degrees):');
for (const [a, n] of [...angles].sort((x,y)=>y[1]-x[1]).slice(0, 12)) console.log(`  ${a.padStart(4)}°  ${n}`);

console.log('\ninventory');
for (const i of scene.inventory.slice(0, 14)) console.log(`  ${String(i.count).padStart(5)}  ${i.name}`);

const texts: string[] = [];
for (const n of walk(doc)) {
  if (n.cls !== 'RVLabel') continue;
  const t = n.labels.find(l => !/^(Arial|Times|Courier|Helvetica|Tahoma|Verdana|Symbol)/i.test(l));
  if (t) texts.push(t);
}
console.log(`\nlabels: ${texts.length}`);
console.log('  sample: ' + texts.filter(t => !/^\d+ ft/.test(t)).slice(0, 12).map(t => JSON.stringify(t)).join(', '));
const dims = [...walk(doc)].filter((n: RVNode) => n.cls === 'RVDimensionLine').length;
console.log(`dimension lines: ${dims}`);
