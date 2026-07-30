import { readFileSync } from 'node:fs';
import { loadBuffer } from '../src/format/index.js';
import type { RVNode } from '../src/format/index.js';
const path = process.argv[2];
const at = Number(process.argv[3]);
const doc = loadBuffer(readFileSync(path), path).document;
const seen = new Set<RVNode>(); const all: RVNode[] = [];
const stack = [...doc.roots];
while (stack.length) { const n = stack.pop()!; if (seen.has(n)) continue; seen.add(n); all.push(n); for (const c of n.children) stack.push(c); }
all.sort((a,b)=>a.span.tagAt-b.span.tagAt);
const near = all.filter(n => Math.abs(n.span.end - at) < 200 || Math.abs(n.span.tagAt - at) < 200);
for (const n of near) {
  console.log(`${n.cls.padEnd(16)} tag=${n.span.tagAt} body=${n.span.bodyAt} headerEnd=${n.span.headerEnd} end=${n.span.end} pts=${n.points.length} pointsAt=${n.fields.pointsAt ?? '-'} count=${n.fields.pointCount ?? '-'}`);
}
