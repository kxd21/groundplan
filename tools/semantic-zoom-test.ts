/**
 * Semantic zoom bands and bank overlay packing.
 *
 *   npx tsx tools/semantic-zoom-test.ts
 */

import {
  SEMANTIC_BLOCKS_BELOW,
  bankMemberIdSet,
  bankOverlaysFromGroups,
  semanticLodForScale,
} from '../src/renderer/src/semantic-zoom.js';

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.log(` FAIL ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 220)}`}`);
  }
};

check('far out is blocks', semanticLodForScale(0.05) === 'blocks');
check('just below blocks threshold is blocks', semanticLodForScale(SEMANTIC_BLOCKS_BELOW - 1e-9) === 'blocks');
check('at blocks threshold is full chairs', semanticLodForScale(SEMANTIC_BLOCKS_BELOW) === 'full');
check('typical ballroom fit is full chairs', semanticLodForScale(0.14) === 'full');
check('mid zoom is full chairs', semanticLodForScale(0.2) === 'full');
check('close in is full', semanticLodForScale(0.4) === 'full');
check('non-finite scale falls back to blocks', semanticLodForScale(Number.NaN) === 'blocks');
check('zero scale falls back to blocks', semanticLodForScale(0) === 'blocks');

const bounds = new Map([
  [1, { minX: 0, minY: 0, maxX: 10, maxY: 10 }],
  [2, { minX: 12, minY: 0, maxX: 22, maxY: 10 }],
  [3, { minX: 100, minY: 100, maxX: 110, maxY: 110 }],
  [4, { minX: 112, minY: 100, maxX: 122, maxY: 110 }],
]);

const overlays = bankOverlaysFromGroups(
  [
    { hubId: 1, memberIds: [1, 2] },
    { hubId: 3, memberIds: [3, 4] },
    { hubId: 9, memberIds: [9] },
  ],
  bounds,
);

check('two visible banks', overlays.length === 2);
check('first bank unions bounds', overlays[0]!.minX === 0 && overlays[0]!.maxX === 22 && overlays[0]!.count === 2);
check('second bank unions bounds', overlays[1]!.hubId === 3 && overlays[1]!.minY === 100);

const hidden = bankOverlaysFromGroups([{ hubId: 1, memberIds: [1, 99] }], bounds);
check('bank with one visible member is omitted', hidden.length === 0);

const members = bankMemberIdSet([{ hubId: 1, memberIds: [1, 2, 2] }, { hubId: 3, memberIds: [3] }]);
check('member set dedupes', members.size === 3 && members.has(1) && members.has(2) && members.has(3));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
