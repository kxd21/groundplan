import { readdirSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { loadBuffer, walk } from '../src/format/index.js';
const dir = '/Volumes/Prince/Roomviewer/Data';
const counts = new Map<number, number>();
let files = 0;
for (const name of readdirSync(dir)) {
  if (!['.rv4', '.rs4'].includes(extname(name).toLowerCase())) continue;
  if (files++ > 300) break;
  try {
    const doc = loadBuffer(readFileSync(join(dir, name)), name).document;
    for (const n of walk(doc)) counts.set(n.version, (counts.get(n.version) ?? 0) + 1);
  } catch { /* skip */ }
}
console.log('object version field across', files, 'files:');
for (const [v, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  version ${v}: ${n.toLocaleString()}`);
