/**
 * Small, synthetic Room Viewer plan used by mandatory tests.
 *
 * The production corpus contains customer names and venue geometry, so it must
 * never be copied into CI. This fixture is built from scratch and contains one
 * placed rectangle, one editable label, and one dimension line.
 *
 * It used to hand-roll its own MFC archive, which made it a *fifth* opinion
 * about what a plan is — and a wrong one. It stamped schema 1 on `RVShape`,
 * `RVGeometry`, `RVSegmentRect`, `RVLabel` and `RVDimensionLine`, where every
 * real file writes 2; it wrote the container list header as `1, 0, 0` where
 * 92,230 of 92,230 corpus containers write `0, 1, 0`; it wrote twelve zero
 * preamble bytes instead of the measured ones; and it had no `RVRoomDef`,
 * `RVRoom`, `RVRegion`, `RVWalls` or document trailer at all, so every object
 * sat at document root. The tests then confirmed that all of that worked.
 *
 * Now it goes through `createPlanDocument` and `synthesize.ts` like the product
 * does, so there is exactly one implementation of "what a plan is" and the tests
 * exercise it. What the fixture guarantees is unchanged: no production data, and
 * the same parser, serializer, scene and editing paths as a real plan.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import CFB from 'cfb';

import { appendChild } from '../src/format/edit.js';
import { createPlanDocument, setRoomRect } from '../src/format/plan-skeleton.js';
import type { RVDocument, RVNode } from '../src/format/rv.js';
import { createLabel, createSegment, createShape } from '../src/format/synthesize.js';
import { verifyWritable } from '../src/format/write.js';

export interface FixtureOptions {
  /**
   * Draw the four walls. Off is a real case worth testing — `room-test.ts`
   * checks that a plan with no wall geometry falls back to the drawing's
   * extent — and it is the only way to reach that path now that the skeleton
   * always provides an `RVWalls` container.
   */
  walls?: boolean;
}

/** The room the fixture draws, in logical units: 20ft x 10ft about the origin. */
const ROOM_HALF_WIDTH = 1200;
const ROOM_HALF_DEPTH = 600;

/** Every step is required to succeed: a half-built fixture is worse than none. */
function must(what: string, result: { ok: boolean; reason?: string }): void {
  if (!result.ok) throw new Error(`fixture: ${what} — ${result.reason ?? 'no reason given'}`);
}

function built(what: string, result: { ok: boolean; reason?: string; node?: RVNode }): RVNode {
  must(what, result);
  if (!result.node) throw new Error(`fixture: ${what} produced no object`);
  return result.node;
}

/** The fixture as a live document, for tests that want to edit it directly. */
export function fixtureDocument(options: FixtureOptions = {}): RVDocument {
  const plan = createPlanDocument({
    identity: { date: '2026-01-01', venue: 'Fixture Hall', event: 'Fixture Event' },
    defaults: { roomName: 'Fixture Room' },
  });
  if (!plan.ok || !plan.doc || !plan.skeleton) throw new Error(`fixture: ${plan.reason}`);
  const doc = plan.doc;
  const { body, walls } = plan.skeleton;

  if (options.walls !== false) {
    const corners: Array<[number, number]> = [
      [-ROOM_HALF_WIDTH, ROOM_HALF_DEPTH],
      [ROOM_HALF_WIDTH, ROOM_HALF_DEPTH],
      [ROOM_HALF_WIDTH, -ROOM_HALF_DEPTH],
      [-ROOM_HALF_WIDTH, -ROOM_HALF_DEPTH],
    ];
    for (let i = 0; i < corners.length; i++) {
      const [x1, y1] = corners[i];
      const [x2, y2] = corners[(i + 1) % corners.length];
      const wall = built(
        'wall',
        createSegment(doc, { cls: 'RVSegmentLine', points: [{ x: x1, y: y1 }, { x: x2, y: y2 }] }),
      );
      must('the wall was not held', appendChild(doc, walls, wall));
    }
    must(
      'the room rect was not written',
      setRoomRect(doc, {
        left: -ROOM_HALF_WIDTH,
        top: -ROOM_HALF_DEPTH,
        right: ROOM_HALF_WIDTH,
        bottom: ROOM_HALF_DEPTH,
      }),
    );
  }

  // One placed rectangle, at the same coordinates the old fixture used so the
  // tests that assert on its position keep asserting on the same thing.
  const shape = built(
    'placed shape',
    createShape(doc, {
      name: 'Fixture Table',
      x: 1000,
      y: 2000,
      outline: [
        {
          rect: [
            { x: -100, y: -50 },
            { x: 100, y: -50 },
            { x: 100, y: 50 },
            { x: -100, y: 50 },
          ],
        },
      ],
    }),
  );
  must('the shape was not held', appendChild(doc, body, shape));

  const label = built('label', createLabel(doc, { text: 'Fixture note', x: 1000, y: 1850 }));
  must('the label was not held', appendChild(doc, body, label));

  const dimension = built(
    'dimension',
    createSegment(doc, {
      cls: 'RVDimensionLine',
      points: [
        { x: 800, y: 2200 },
        { x: 1200, y: 2200 },
      ],
    }),
  );
  must('the dimension was not held', appendChild(doc, body, dimension));

  return doc;
}

export function fixturePlanBuffer(options: FixtureOptions = {}): Buffer {
  const doc = fixtureDocument(options);
  // The fixture is held to the same gate the product is: if it cannot be read
  // back exactly, every test built on it is testing a fiction.
  const verdict = verifyWritable(doc);
  if (!verdict.ok || !verdict.bytes) throw new Error(`fixture does not verify: ${verdict.reason}`);

  const compound = CFB.utils.cfb_new();
  CFB.utils.cfb_add(compound, 'Contents', verdict.bytes);
  return Buffer.from(CFB.write(compound, { type: 'buffer' }) as Uint8Array);
}

export function fixtureCorpus(): { directory: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'groundplan-fixture-'));
  writeFileSync(join(directory, 'Synthetic fixture.rv4'), fixturePlanBuffer());
  return {
    directory,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
