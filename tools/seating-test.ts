/**
 * Verifies rotation and the seating generator against a real plan.
 *
 *   npx tsx tools/seating-test.ts [--svg]
 */
import { copyFileSync, readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { loadBuffer } from '../src/format/index.js';
import { indexDocument, rotateNode, resizeNode } from '../src/format/edit.js';
import { addSeating } from '../src/format/seating.js';
import { serializeArchive, roundTrip, packContainer } from '../src/format/write.js';
import { buildScene } from '../src/format/scene.js';
import { toSvg } from '../src/renderer/src/svg.js';
import type { RVNode } from '../src/format/index.js';

const SOURCE = '/Volumes/Prince/Roomviewer/Data/ADDISON TRAINING ROOM bootcamp v1.rv4';
const FOOT = 120;
const checks: Array<[string, boolean, string?]> = [];
const check = (n: string, ok: boolean, d?: string) => checks.push([n, ok, d]);

const dir = mkdtempSync(join(tmpdir(), 'gp-seat-'));
const work = join(dir, basename(SOURCE));
copyFileSync(SOURCE, work);
const original = readFileSync(work);

// --- rotation ---------------------------------------------------------------
{
  const doc = loadBuffer(original, work).document;
  const stack = [...doc.roots]; const seen = new Set<RVNode>(); let chair: RVNode | null = null;
  while (stack.length && !chair) {
    const n = stack.pop()!; if (seen.has(n)) continue; seen.add(n);
    if (n.cls === 'RVShape' && n.labels.some(l => /18"x18"/.test(l))) chair = n;
    for (const c of n.children) stack.push(c);
  }
  check('found a chair to rotate', !!chair);
  if (chair) {
    const before = { w: chair.bounds.right - chair.bounds.left, h: chair.bounds.bottom - chair.bounds.top };
    const g = chair.children.find(c => c.cls === 'RVGeometry')!;
    const pt = { ...g.children[0].points[0] };
    const r = rotateNode(doc, chair, Math.PI / 2);
    check('rotate applied', r.ok, r.reason);
    const after = g.children[0].points[0];
    // A quarter turn maps (x,y) -> (-y,x).
    check('geometry turned a quarter', Math.abs(after.x + pt.y) < 0.01 && Math.abs(after.y - pt.x) < 0.01,
      `(${pt.x.toFixed(1)},${pt.y.toFixed(1)}) -> (${after.x.toFixed(1)},${after.y.toFixed(1)})`);
    const nb = { w: chair.bounds.right - chair.bounds.left, h: chair.bounds.bottom - chair.bounds.top };
    check('bounds swapped', Math.abs(nb.w - before.h) < 3 && Math.abs(nb.h - before.w) < 3,
      `${before.w}x${before.h} -> ${nb.w}x${nb.h}`);

    const rr = resizeNode(doc, chair, 2, 2);
    check('resize applied', rr.ok, rr.reason);
    const rb = { w: chair.bounds.right - chair.bounds.left };
    check('resize doubled the width', Math.abs(rb.w - nb.w * 2) < 4, `${nb.w} -> ${rb.w}`);

    const saved = packContainer(original, serializeArchive(doc));
    const reread = loadBuffer(saved, work);
    check('rotated plan saves and reparses', reread.document.warnings.length === 0);
    check('rotated plan stays editable', roundTrip(reread.document).identical);
  }
}

// --- seating ----------------------------------------------------------------
{
  const doc = loadBuffer(original, work).document;
  const index = indexDocument(doc);
  const before = buildScene(doc).counts['RVShape'] ?? 0;

  const round = addSeating(doc, index, { kind: 'round', x: 0, y: -40 * FOOT, table: 'Round 66"', chair: 'Standard 18"x18"', seats: 10 });
  check('round table generated', round.ok, round.reason);
  check('placed 1 table + 10 chairs', round.placed === 11, String(round.placed));

  const idx2 = indexDocument(doc);
  const theatre = addSeating(doc, idx2, { kind: 'theatre', x: 0, y: 30 * FOOT, chair: 'Standard 18"x18"', rows: 4, perRow: 8 });
  check('theatre rows generated', theatre.ok, theatre.reason);
  check('placed 32 chairs', theatre.placed === 32, String(theatre.placed));

  const after = buildScene(doc).counts['RVShape'] ?? 0;
  check('all shapes landed', after === before + 43, `${after} vs ${before + 43}`);

  const saved = packContainer(original, serializeArchive(doc));
  const reread = loadBuffer(saved, work);
  check('seated plan reparses cleanly', reread.document.warnings.length === 0, reread.document.warnings[0]?.message);
  check('seated plan stays editable', roundTrip(reread.document).identical);

  const scene = buildScene(reread.document);
  const chairs = scene.inventory.find(i => /18"x18"/.test(i.name));
  check('chairs show in the inventory', (chairs?.count ?? 0) >= 42, String(chairs?.count));

  if (process.argv.includes('--svg')) {
    writeFileSync('/tmp/gp/seating.svg', toSvg(scene, new Set(['walls','furniture','annotation','region','other'] as never[])));
    console.log('wrote /tmp/gp/seating.svg');
  }
}

let failed = 0;
for (const [n, ok, d] of checks) { console.log(`  ${ok ? 'pass' : 'FAIL'}  ${n}${!ok && d ? ` — ${d}` : ''}`); if (!ok) failed++; }
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
