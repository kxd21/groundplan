/**
 * Checks the two properties that keep an edited plan trustworthy.
 *
 * **Reload stability.** `editable` is decided once, when the file is opened, by
 * checking that it re-serializes to its original bytes. After an edit the bytes
 * legitimately differ, so that check no longer says anything. The property that
 * has to hold from then on is that writing the document and reading it back
 * produces the same document — otherwise the plan the user saves is not the
 * plan they were looking at, and nothing would have told them.
 *
 * **Failed edits leave no redo.** A rejected edit is rolled back, but rolling
 * back used to push the half-mutated state onto the redo stack, so pressing
 * Redo afterwards could apply the change that was just refused.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';

import { Session } from '../src/main/session.js';
import { moveNode, rotateNode, duplicateNode } from '../src/format/edit.js';
import { addSeating } from '../src/format/seating.js';
import { loadBuffer } from '../src/format/index.js';
import { serializeArchive, packContainer } from '../src/format/write.js';

const DIR = process.argv[2] ?? '/Volumes/Prince/Roomviewer/Data';
const LIMIT = Number(process.argv[3] ?? 25);

let checks = 0;
let failures = 0;

function check(label: string, ok: boolean): void {
  checks++;
  if (!ok) {
    failures++;
    console.error(`  FAIL  ${label}`);
  }
}

/**
 * Writing the document and reading it back must produce the same bytes again.
 *
 * This is the post-edit form of the round-trip gate: not "matches the original
 * file" but "survives a save and reload unchanged".
 */
function reloadsIdentically(session: Session): boolean {
  const written = packContainer(readFileSync(session.path), session.body());
  try {
    const reparsed = loadBuffer(written, session.path).document;
    return serializeArchive(reparsed).equals(session.body());
  } catch {
    return false;
  }
}

const plans = readdirSync(DIR)
  .filter((f) => extname(f).toLowerCase() === '.rv4' && !f.startsWith('._'))
  .sort()
  .slice(0, LIMIT);

let tested = 0;
const broken: string[] = [];

for (const name of plans) {
  const path = join(DIR, name);
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    continue;
  }

  const session = new Session(path, bytes);
  if (!session.editable) continue;
  tested++;

  const movable = [...session.index.byId.values()].filter(
    (n) => !session.index.shared.has(n) && n.span,
  );
  if (movable.length === 0) continue;
  const target = movable[Math.min(3, movable.length - 1)];

  const operations: Array<[string, () => { ok: boolean }]> = [
    ['move', () => moveNode(session.loaded.document, target, 120, 120)],
    ['rotate', () => rotateNode(session.loaded.document, target, Math.PI / 2)],
    ['duplicate', () => duplicateNode(session.loaded.document, session.index, target, 240, 0)],
    [
      'seating',
      () =>
        addSeating(session.loaded.document, session.index, {
          kind: 'round',
          x: 0,
          y: 0,
          chair: session.scene.inventory[0]?.name ?? '',
          table: session.scene.inventory[1]?.name,
          seats: 8,
        }),
    ],
  ];

  for (const [label, run] of operations) {
    let result: { ok: boolean };
    try {
      result = run();
    } catch {
      continue; // an operation that refuses outright is not a corruption
    }
    if (!result.ok) continue;
    session.refresh();
    if (!reloadsIdentically(session)) broken.push(`${name} — after ${label}`);
  }
}

check(`edited plans still reload identically (${tested} plans exercised)`, broken.length === 0);
for (const b of broken.slice(0, 8)) console.error(`        ${b}`);

// A refused edit must not leave something to redo.
const first = plans.map((n) => join(DIR, n)).find((p) => new Session(p, readFileSync(p)).editable);
if (first) {
  const session = new Session(first, readFileSync(first));
  session.checkpoint();
  // Simulate an edit that mutates and is then rejected, which is what a partial
  // batch does.
  const victim = [...session.index.byId.values()].find((n) => n.span && !session.index.shared.has(n));
  if (victim) {
    moveNode(session.loaded.document, victim, 60, 0);
    session.rollback();
    check('a rolled-back edit leaves nothing to redo', !session.canRedo());
    check('a rolled-back edit leaves the document clean', !session.dirty);
  }
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
