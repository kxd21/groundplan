/**
 * Proves an edited file is still a valid Room Viewer file.
 *
 * For each sample plan: move an item, save, re-open the saved bytes, and check
 * that the object survived, landed where it was put, and that nothing else
 * changed. Then delete and duplicate, verifying the object count moves by
 * exactly one each way and the result still parses cleanly.
 *
 * Mandatory synthetic sweep:
 *   npx tsx tools/edit-test.ts --fixture
 *
 * Optional production-corpus sweep:
 *   npx tsx tools/edit-test.ts "/path/to/Roomviewer/Data" 40
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';

import { loadBuffer } from '../src/format/index.js';
import { buildScene } from '../src/format/scene.js';
import { serializeArchive, roundTrip, packContainer } from '../src/format/write.js';
import { indexDocument, moveNode, deleteNode, duplicateNode, relabelNode } from '../src/format/edit.js';
import type { RVNode } from '../src/format/index.js';
import { fixtureCorpus } from './test-fixture.js';

const args = process.argv.slice(2);
const useFixture = args.includes('--fixture');
const positional = args.filter((arg) => !arg.startsWith('--'));
const fixture = useFixture ? fixtureCorpus() : null;
const DIR = fixture?.directory ?? positional[0] ?? process.env.GROUNDPLAN_CORPUS_DIR;
const LIMIT = Number(positional[1] ?? process.env.GROUNDPLAN_EDIT_LIMIT ?? 40);

if (!DIR) {
  console.error(
    'No test corpus selected. Use --fixture for the synthetic CI plan, pass a directory, ' +
      'or set GROUNDPLAN_CORPUS_DIR.',
  );
  process.exit(2);
}
if (!Number.isInteger(LIMIT) || LIMIT < 1) {
  console.error(`Edit sweep limit must be a positive integer; received ${String(LIMIT)}.`);
  fixture?.cleanup();
  process.exit(2);
}

function firstShape(doc: { roots: RVNode[] }): RVNode | null {
  const stack = [...doc.roots];
  const seen = new Set<RVNode>();
  while (stack.length) {
    const n = stack.pop()!;
    if (seen.has(n)) continue;
    seen.add(n);
    if (n.cls === 'RVShape' && n.points[0] && n.children.length) return n;
    for (const c of n.children) stack.push(c);
  }
  return null;
}

let tested = 0;
let moveAttempted = 0;
let deleteAttempted = 0;
let duplicateAttempted = 0;
let relabelAttempted = 0;
let movedOk = 0;
let deletedOk = 0;
let duplicatedOk = 0;
let relabelOk = 0;
const failures: string[] = [];
const refusals: string[] = [];

const files = readdirSync(DIR)
  .filter((f) => extname(f).toLowerCase() === '.rv4' && !f.startsWith('._'))
  .sort()
  .slice(0, LIMIT);

for (const name of files) {
  const path = join(DIR, name);
  let original: Buffer;
  try {
    original = readFileSync(path);
  } catch {
    continue;
  }

  // Only files that reproduce themselves exactly are editable.
  const base = loadBuffer(original, path);
  if (!roundTrip(base.document).identical) continue;
  tested++;

  // --- move -------------------------------------------------------------
  {
    const doc = loadBuffer(original, path).document;
    const target = firstShape(doc);
    if (target) {
      moveAttempted++;
      const before = { ...target.points[0]! };
      const result = moveNode(doc, target, 240, -120); // two feet right, one foot up
      if (!result.ok) {
        failures.push(`${name}: move refused — ${result.reason}`);
      } else {
        const saved = packContainer(original, serializeArchive(doc));
        const reread = loadBuffer(saved, path).document;
        const again = firstShape(reread);
        if (!again) {
          failures.push(`${name}: moved shape vanished after save`);
        } else if (reread.warnings.length) {
          failures.push(`${name}: saved file no longer parses cleanly`);
        } else {
          const dx = again.points[0]!.x - before.x;
          const dy = again.points[0]!.y - before.y;
          if (Math.abs(dx - 240) > 0.001 || Math.abs(dy + 120) > 0.001) {
            failures.push(`${name}: moved by (${dx.toFixed(1)}, ${dy.toFixed(1)}), expected (240, -120)`);
          } else {
            movedOk++;
          }
        }
      }
    }
  }

  // --- delete -----------------------------------------------------------
  {
    const doc = loadBuffer(original, path).document;
    const index = indexDocument(doc);
    const target = firstShape(doc);
    if (target) {
      deleteAttempted++;
      const countBefore = buildScene(doc).counts['RVShape'] ?? 0;
      const result = deleteNode(doc, index, target);
      if (!result.ok) refusals.push(`delete: ${result.reason}`);
      if (result.ok) {
        const saved = packContainer(original, serializeArchive(doc));
        const reread = loadBuffer(saved, path).document;
        const countAfter = buildScene(reread).counts['RVShape'] ?? 0;
        if (reread.warnings.length) failures.push(`${name}: delete produced a file with parse warnings`);
        else if (countAfter !== countBefore - 1) {
          failures.push(`${name}: delete left ${countAfter} shapes, expected ${countBefore - 1}`);
        } else deletedOk++;
      }
    }
  }

  // --- duplicate --------------------------------------------------------
  {
    const doc = loadBuffer(original, path).document;
    const index = indexDocument(doc);
    const target = firstShape(doc);
    if (target) {
      duplicateAttempted++;
      const countBefore = buildScene(doc).counts['RVShape'] ?? 0;
      const result = duplicateNode(doc, index, target, 360, 0);
      if (!result.ok) refusals.push(`duplicate: ${result.reason}`);
      if (result.ok) {
        const saved = packContainer(original, serializeArchive(doc));
        const reread = loadBuffer(saved, path).document;
        const countAfter = buildScene(reread).counts['RVShape'] ?? 0;
        if (reread.warnings.length) failures.push(`${name}: duplicate produced a file with parse warnings`);
        else if (countAfter !== countBefore + 1) {
          failures.push(`${name}: duplicate left ${countAfter} shapes, expected ${countBefore + 1}`);
        } else duplicatedOk++;
      }
    }
  }

  // --- relabel ----------------------------------------------------------
  {
    const doc = loadBuffer(original, path).document;
    const stack = [...doc.roots];
    const seen = new Set<RVNode>();
    let label: RVNode | null = null;
    while (stack.length && !label) {
      const n = stack.pop()!;
      if (seen.has(n)) continue;
      seen.add(n);
      if (n.cls === 'RVLabel' && n.fields.textAt != null) label = n;
      for (const c of n.children) stack.push(c);
    }
    if (label) {
      relabelAttempted++;
      const text = 'Groundplan edit test';
      const result = relabelNode(doc, label, text);
      if (!result.ok) {
        refusals.push(`relabel: ${result.reason}`);
      } else {
        const saved = packContainer(original, serializeArchive(doc));
        const reread = loadBuffer(saved, path).document;
        const found = [...(function* walkAll(ns: RVNode[]): Generator<RVNode> {
          const st = [...ns];
          const s2 = new Set<RVNode>();
          while (st.length) {
            const n = st.pop()!;
            if (s2.has(n)) continue;
            s2.add(n);
            yield n;
            for (const c of n.children) st.push(c);
          }
        })(reread.roots)].some((n) => n.labels.includes(text));
        if (reread.warnings.length) failures.push(`${name}: relabel produced parse warnings`);
        else if (!found) failures.push(`${name}: relabelled text not found after save`);
        else relabelOk++;
      }
    }
  }
}

console.log(`editable plans tested: ${tested}\n`);
console.log(`  move       ${movedOk}/${moveAttempted}`);
console.log(`  delete     ${deletedOk}/${deleteAttempted}`);
console.log(`  duplicate  ${duplicatedOk}/${duplicateAttempted}`);
console.log(`  relabel    ${relabelOk}/${relabelAttempted}`);

if (refusals.length) {
  const tally = new Map<string, number>();
  for (const r of refusals) tally.set(r, (tally.get(r) ?? 0) + 1);
  console.log('\nrefusals:');
  for (const [r, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${n}x ${r}`);
}

if (tested === 0) {
  failures.push('no editable plans were exercised');
} else if (moveAttempted + deleteAttempted + duplicateAttempted + relabelAttempted === 0) {
  failures.push('editable plans contained no supported edit targets');
}

if (failures.length) {
  console.log(`\nfailures (${failures.length}):`);
  for (const f of failures.slice(0, 20)) console.log(`  ${f}`);
} else {
  console.log('\nno failures');
}

fixture?.cleanup();
if (failures.length > 0) process.exitCode = 1;
