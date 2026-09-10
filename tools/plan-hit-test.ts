/**
 * Regression tests for plan pick accuracy — dense chairs especially.
 */

import assert from 'node:assert/strict';
import type { ScenePrimitive } from '../src/format/scene.js';
import { hitTest, hitTestCandidates, type HitTestItem } from '../src/renderer/src/plan-hit.js';

function rectPts(minX: number, minY: number, maxX: number, maxY: number): number[] {
  return [minX, minY, maxX, minY, maxX, maxY, minX, maxY];
}

function furniturePoly(
  selectId: number,
  pts: number[],
  owner: string,
  extras?: Partial<ScenePrimitive>,
): ScenePrimitive {
  return {
    id: selectId * 10,
    nodeId: selectId,
    selectId,
    type: 'polygon',
    pts,
    color: 0,
    cls: 'RVSegmentRect',
    layer: 'furniture',
    discipline: 'Staging',
    owner,
    ...extras,
  };
}

function itemFrom(primitive: ScenePrimitive): HitTestItem {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < primitive.pts.length; i += 2) {
    minX = Math.min(minX, primitive.pts[i]!);
    maxX = Math.max(maxX, primitive.pts[i]!);
    minY = Math.min(minY, primitive.pts[i + 1]!);
    maxY = Math.max(maxY, primitive.pts[i + 1]!);
  }
  return { primitive, minX, maxX, minY, maxY };
}

const visible = new Set(['Staging']);

// Two adjacent 18″ chairs (180 units) with a 6″ gap.
const leftSeat = furniturePoly(1, rectPts(0, 0, 180, 100), 'Chair');
const leftBack = furniturePoly(1, rectPts(0, 100, 180, 180), 'Chair', { id: 11 });
const rightSeat = furniturePoly(2, rectPts(240, 0, 420, 100), 'Chair');
const rightBack = furniturePoly(2, rectPts(240, 100, 420, 180), 'Chair', { id: 21 });
const row = [leftSeat, leftBack, rightSeat, rightBack].map(itemFrom);

{
  // Click inside the right chair's backrest — must not pick the left chair
  // just because its seat edge was processed first and fell inside a fat halo.
  const id = hitTest(row, visible, 330, 140, 160);
  assert.equal(id, 2, `backrest click should select right chair, got ${id}`);
  console.log('ok backrest picks that chair, not the neighbour');
}

{
  // Click in the gap between chairs with a fat screen-pixel halo (fit zoom).
  // Old code selected a neighbour; capped edge tolerance should miss both.
  const id = hitTest(row, visible, 210, 90, 160);
  assert.equal(id, null, `gap click should miss, got ${id}`);
  console.log('ok gap between chairs is empty at fat zoom tolerance');
}

{
  // Interior of left seat still wins even when the right chair's outline is nearer
  // in world units than the old 1-unit tie threshold cared about.
  const hits = hitTestCandidates(row, visible, 90, 50, 160);
  assert.equal(hits[0]?.id, 1);
  assert.equal(hits[0]?.distance, 0);
  console.log('ok seat interior beats neighbour outline');
}

{
  // Multi-part aggregation: seat near-miss must not lock out a later backrest hit.
  const onlyLeftNearMissFirst = [
    itemFrom(furniturePoly(3, rectPts(0, 0, 180, 100), 'Chair A')),
    itemFrom(furniturePoly(4, rectPts(200, 0, 380, 180), 'Chair B')),
    itemFrom(furniturePoly(3, rectPts(0, 120, 180, 180), 'Chair A', { id: 31 })),
  ];
  // Click on chair A's back (y=150). Chair B's body is also near (edge ~20).
  // Fat tolerance would see B first if A only recorded the seat near-miss.
  const id = hitTest(onlyLeftNearMissFirst, visible, 90, 150, 160);
  assert.equal(id, 3, `aggregated parts should pick chair A backrest, got ${id}`);
  console.log('ok multi-part chair aggregates best distance');
}

{
  // Chair overlapping a larger table: smaller body wins on a shared interior.
  const table = itemFrom(furniturePoly(10, rectPts(0, 0, 600, 600), 'Round 66"'));
  const chair = itemFrom(furniturePoly(11, rectPts(200, 200, 380, 380), 'Chair'));
  const id = hitTest([table, chair], visible, 290, 290, 40);
  assert.equal(id, 11, `chair should win over table fill, got ${id}`);
  console.log('ok chair preferred over overlapping table');
}

console.log('plan-hit-test passed');
