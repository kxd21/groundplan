/**
 * End-to-end test of the editing pipeline the UI drives.
 *
 * Exercises `Session` exactly as the main process does — checkpoint, edit,
 * refresh, undo, redo, save — against a copy of a real plan, and verifies the
 * saved file on disk reopens with the expected contents.
 *
 *   npx tsx tools/session-test.ts <plan.rv4>
 */

import { copyFileSync, readFileSync, existsSync, unlinkSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

import { Session } from '../src/main/session.js';
import { moveNode, deleteNode, duplicateNode } from '../src/format/edit.js';
import { loadBuffer } from '../src/format/index.js';
import type { RVNode } from '../src/format/index.js';

const source = process.argv[2] ?? '/Volumes/Prince/Roomviewer/Data/1 BAC - Thames Room (Drape Booths).rv4';
const dir = mkdtempSync(join(tmpdir(), 'groundplan-'));
const work = join(dir, basename(source));
copyFileSync(source, work);

const checks: Array<[string, boolean, string?]> = [];
const check = (name: string, ok: boolean, detail?: string) => checks.push([name, ok, detail]);

function firstShape(roots: RVNode[]): RVNode | null {
  const stack = [...roots];
  const seen = new Set<RVNode>();
  while (stack.length) {
    const n = stack.pop()!;
    if (seen.has(n)) continue;
    seen.add(n);
    if (n.cls === 'RVShape' && n.points[0]) return n;
    for (const c of n.children) stack.push(c);
  }
  return null;
}

const s = new Session(work, readFileSync(work));
check('opens as editable', s.editable);
check('starts clean', !s.dirty);
check('has no undo history', !s.canUndo());

const shapeCount = () => s.scene.counts['RVShape'] ?? 0;
const startingShapes = shapeCount();
const target = firstShape(s.loaded.document.roots);
check('found an item to edit', !!target);

if (target) {
  const before = { ...target.points[0]! };

  // --- move --------------------------------------------------------------
  s.checkpoint();
  const moved = moveNode(s.loaded.document, target, 360, 240);
  s.refresh();
  check('move applied', moved.ok, moved.reason);
  check(
    'move shifted the insertion point by 3ft x 2ft',
    Math.abs(target.points[0]!.x - before.x - 360) < 0.001 &&
      Math.abs(target.points[0]!.y - before.y - 240) < 0.001,
  );
  check('document is now dirty', s.dirty);

  // --- undo / redo -------------------------------------------------------
  check('undo available', s.canUndo());
  s.undo();
  const afterUndo = firstShape(s.loaded.document.roots);
  check(
    'undo restored the original position',
    !!afterUndo &&
      Math.abs(afterUndo.points[0]!.x - before.x) < 0.001 &&
      Math.abs(afterUndo.points[0]!.y - before.y) < 0.001,
  );
  check('redo available', s.canRedo());
  s.redo();
  const afterRedo = firstShape(s.loaded.document.roots);
  check('redo re-applied the move', !!afterRedo && Math.abs(afterRedo.points[0]!.x - before.x - 360) < 0.001);

  // --- duplicate ---------------------------------------------------------
  const dupTarget = firstShape(s.loaded.document.roots)!;
  s.checkpoint();
  const dup = duplicateNode(s.loaded.document, s.index, dupTarget, 240, 0);
  s.refresh();
  check('duplicate applied', dup.ok, dup.reason);
  check('duplicate added one item', shapeCount() === startingShapes + 1, `${shapeCount()} vs ${startingShapes + 1}`);

  // --- delete ------------------------------------------------------------
  const delTarget = firstShape(s.loaded.document.roots)!;
  s.checkpoint();
  const del = deleteNode(s.loaded.document, s.index, delTarget);
  s.refresh();
  check('delete applied', del.ok, del.reason);
  check('delete removed one item', shapeCount() === startingShapes, `${shapeCount()} vs ${startingShapes}`);
}

// --- save --------------------------------------------------------------
const bytes = s.file();
const backup = `${work}.bak`;
copyFileSync(work, backup);
writeFileSync(work, bytes);
s.markSaved();

check('backup written', existsSync(backup));
check('marked saved', !s.dirty);

const reopened = loadBuffer(readFileSync(work), work);
check('saved file reopens', reopened.document.roots.length > 0);
check(
  'saved file parses without warnings',
  reopened.document.warnings.length === 0,
  reopened.document.warnings[0]?.message,
);

const reopenedSession = new Session(work, readFileSync(work));
check('saved file is still editable', reopenedSession.editable);
check(
  'saved file has the expected item count',
  (reopenedSession.scene.counts['RVShape'] ?? 0) === startingShapes,
  `${reopenedSession.scene.counts['RVShape']} vs ${startingShapes}`,
);

// Backup must still be the untouched original.
check('backup matches the original bytes', readFileSync(backup).equals(readFileSync(source)));

let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);

unlinkSync(work);
unlinkSync(backup);
process.exit(failed ? 1 : 0);
