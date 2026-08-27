/**
 * Pipe and drape around the room, in one step.
 *
 * A masking run is a line of "Pipe and Drape" panels; placing 51 of them by
 * hand is what made draping a room from scratch impractical. This checks the
 * perimeter drape lays a full run of correctly-named panels and that the result
 * still writes and re-reads as a valid Room Viewer file.
 *
 *   npx tsx tools/drape-test.ts
 */

import { UNITS_PER_FOOT } from '../src/format/rv.js';
import { createBlankPlan } from '../src/format/blank.js';
import { loadBuffer, walk } from '../src/format/index.js';
import { serializeArchive, roundTrip, packContainer } from '../src/format/write.js';
import { drapePerimeter } from '../src/main/plan-model.js';
import type { Session } from '../src/main/session.js';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  pass  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`);
  }
}

const F = UNITS_PER_FOOT;

console.log('draping the room perimeter\n');

const blank = createBlankPlan({ room: { width: 60 * F, depth: 40 * F } });
const original = blank.file!;
const doc = loadBuffer(original, 'draped.rv4').document;

// drapePerimeter reads the document off the session; a minimal stand-in is
// enough since it only uses loaded.document.
const session = { loaded: { document: doc } } as unknown as Session;

const before = [...walk(doc)].filter((n) => n.labels.includes('Pipe and Drape')).length;
const result = drapePerimeter(session);
check('the room is draped', result.ok, result.reason);
const after = [...walk(doc)].filter((n) => n.labels.includes('Pipe and Drape')).length;

// A 60x40 room is a 200 ft perimeter; at ~10 ft standard panels that is ~20.
check('a full run of panels is laid', after - before >= 15, `${after - before} panels`);
check('each created object is a drape panel', (result.created?.length ?? 0) === after - before);

const saved = packContainer(original, serializeArchive(doc));
const reread = loadBuffer(saved, 'draped.rv4').document;
check('the draped plan still parses cleanly', reread.warnings.length === 0, reread.warnings.slice(0, 2).join('; '));
check('and reproduces itself byte-for-byte', roundTrip(reread).identical);

console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed) process.exit(1);
