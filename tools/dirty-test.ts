/**
 * Checks that "unsaved changes" means what it says.
 *
 * The flag drives the close prompt and the dot in the title bar, so getting it
 * wrong loses work silently: the app claims the file on disk matches the screen
 * when it does not.
 *
 * Two ways that used to go wrong, both from inferring the flag from the depth
 * of the undo stack rather than from what was actually last written:
 *
 *   - undo after a save walked the stack to empty and reported "clean", while
 *     the file on disk still held the saved edit;
 *   - past the history limit the oldest state is dropped, so undoing everything
 *     empties the stack without returning the document to where it started.
 */

import { readFileSync } from 'node:fs';

import { Session } from '../src/main/session.js';
import { moveNode } from '../src/format/edit.js';

const PLAN =
  process.argv[2] ?? '/Volumes/Prince/Roomviewer/Data/ADDISON TRAINING ROOM bootcamp v1.rv4';

let checks = 0;
let failures = 0;

function check(label: string, ok: boolean): void {
  checks++;
  if (!ok) {
    failures++;
    console.error(`  FAIL  ${label}`);
  }
}

const original = readFileSync(PLAN);
const session = new Session(PLAN, original);

if (!session.editable) {
  console.log('skipped — test plan is not editable');
  process.exit(0);
}

/** Moves the first movable object, so each edit really changes the bytes. */
function edit(session: Session, by: number): boolean {
  for (const node of session.index.byId.values()) {
    if (session.index.shared.has(node)) continue;
    session.checkpoint();
    const moved = moveNode(session.loaded.document, node, by, 0);
    if (moved.ok) {
      session.refresh();
      return true;
    }
  }
  return false;
}

check('a freshly opened file is clean', !session.dirty);

check('an edit makes it dirty', edit(session, 10) && session.dirty);

session.markSaved();
check('saving makes it clean', !session.dirty);

// The file on disk now holds the edit. Undoing moves away from it again.
session.undo();
check('undo after a save is dirty again, because disk no longer matches', session.dirty);

session.redo();
check('redo back to the saved state is clean', !session.dirty);

// Past the history limit the oldest snapshot is dropped, so the stack emptying
// is not the same as being back where we started.
const deep = new Session(PLAN, original);
for (let i = 0; i < 120; i++) edit(deep, 10);
check('many edits are dirty', deep.dirty);
while (deep.canUndo()) deep.undo();
check('undoing past the history limit still reports unsaved changes', deep.dirty);

console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
