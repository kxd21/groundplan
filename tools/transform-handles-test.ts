/**
 * On-canvas transform handle maths.
 *
 * The interesting cases are all about rotation: a frame turned 90° must put its
 * "north" handle where north went, and a drag on that handle must grow the
 * object along its own axis rather than the screen's.
 *
 *   npx tsx tools/transform-handles-test.ts
 */

import {
  angleAt,
  cursorFor,
  frameCorners,
  handlePoints,
  hitHandle,
  resizeFrom,
  rotateFrom,
  type TransformFrame,
} from '../src/renderer/src/transform-handles.js';

// Plan Y grows up while screen Y grows down. Offset Y keeps the fixture's
// centre at screen y=100, making the expected handle positions easy to read.
const view = { scale: 1, offsetX: 0, offsetY: 200 };

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.log(` FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};
const near = (a: number, b: number, tolerance = 1e-6) => Math.abs(a - b) <= tolerance;

const square: TransformFrame = { cx: 100, cy: 100, width: 40, height: 20, angle: 0 };

// ---- geometry -------------------------------------------------------------

const corners = frameCorners(square, view);
check(
  'corners of an unrotated frame',
  near(corners[0]!.x, 80) && near(corners[0]!.y, 90) && near(corners[2]!.x, 120) && near(corners[2]!.y, 110),
  JSON.stringify(corners),
);

const turned: TransformFrame = { ...square, angle: 90 };
const turnedCorners = frameCorners(turned, view);
check(
  'a +90° plan frame follows the Y-up drawing',
  near(turnedCorners[0]!.x, 90) && near(turnedCorners[0]!.y, 120),
  JSON.stringify(turnedCorners[0]),
);

const east = handlePoints(square, view, true).find((p) => p.id === 'e')!;
check('east handle sits on the right edge midpoint', near(east.x, 120) && near(east.y, 100));

const turnedEast = handlePoints(turned, view, true).find((p) => p.id === 'e')!;
check(
  'east handle follows the rotation to the north',
  near(turnedEast.x, 100) && near(turnedEast.y, 80),
  `${turnedEast.x},${turnedEast.y}`,
);

// Regression for a table below plan zero: its handle frame used to be drawn
// the same distance above zero, visibly detached from the selected circle.
const belowZero: TransformFrame = { cx: 600, cy: -600, width: 600, height: 600, angle: 0 };
const belowView = { scale: 0.1, offsetX: 500, offsetY: 400 };
const belowCorners = frameCorners(belowZero, belowView);
check(
  'a frame below plan zero stays centred on the item',
  near((belowCorners[0]!.x + belowCorners[2]!.x) / 2, 560) &&
    near((belowCorners[0]!.y + belowCorners[2]!.y) / 2, 460),
  JSON.stringify(belowCorners),
);
for (const [name, frame, candidateView] of [
  ['positive Y at close zoom', { cx: -240, cy: 840, width: 300, height: 180, angle: 27 }, { scale: 0.5, offsetX: 700, offsetY: 500 }],
  ['negative Y at far zoom', { cx: 1320, cy: -1560, width: 720, height: 240, angle: -38 }, { scale: 0.04, offsetX: 300, offsetY: 260 }],
  ['origin at medium zoom', { cx: 0, cy: 0, width: 480, height: 960, angle: 90 }, { scale: 0.2, offsetX: 410, offsetY: 330 }],
] as const) {
  const candidateCorners = frameCorners(frame, candidateView);
  check(
    `${name} keeps the frame centre attached`,
    near((candidateCorners[0]!.x + candidateCorners[2]!.x) / 2, frame.cx * candidateView.scale + candidateView.offsetX) &&
      near((candidateCorners[0]!.y + candidateCorners[2]!.y) / 2, -frame.cy * candidateView.scale + candidateView.offsetY),
    JSON.stringify(candidateCorners),
  );
}

const grip = handlePoints(square, view, true).find((p) => p.id === 'rotate');
check('rotate grip is offset above the top edge', !!grip && grip.y < 90);
check('rotate grip is absent when the object cannot turn', !handlePoints(square, view, false).some((p) => p.id === 'rotate'));

// ---- hit testing ----------------------------------------------------------

// The east handle needs vertical clearance; a 20px-tall frame has none, so it
// is correctly suppressed. Give the frame room and it comes back.
const tall: TransformFrame = { ...square, height: 60 };
check('a click on the east handle finds it', hitHandle(tall, view, 120, 100, true) === 'e');
check('a click in open space finds nothing', hitHandle(square, view, 60, 60, true) === null);
check('the rotate grip is hit-testable', hitHandle(square, view, grip!.x, grip!.y, true) === 'rotate');
check('the rotate grip is not hit when rotation is off', hitHandle(square, view, grip!.x, grip!.y, false) === null);

// Edge handles are dropped on a frame too small to hold them, so a tiny symbol
// does not become four overlapping targets. Corners survive.
const tiny: TransformFrame = { cx: 0, cy: 0, width: 20, height: 20, angle: 0 };
check('edge handles drop out on a small frame', hitHandle(tiny, view, 10, 0, true) !== 'e');

// Per-axis clearance: a long thin truss keeps the end handles it has room for
// and loses only the ones that would sit on top of a corner.
const truss: TransformFrame = { cx: 0, cy: 0, width: 400, height: 12, angle: 0 };
check('a long thin frame keeps its north/south handles', hitHandle(truss, view, 0, 194, true) === 'n');
check('a long thin frame drops its east/west handles', hitHandle(truss, view, 200, 200, true) !== 'e');
check('corner handles survive on a small frame', hitHandle(tiny, view, 10, 210, true) === 'se');

// ---- resize ---------------------------------------------------------------

const free = { lockAspect: false, snapStep: 0 };

// Centre-anchored: the grabbed corner tracks the pointer, so the width grows by
// twice the local delta. This matches `resizeNode`, which scales about centre.
check(
  'dragging east by 5 widens by 10',
  near(resizeFrom(square, 'e', 5, 0, free).width, 50) && near(resizeFrom(square, 'e', 5, 0, free).height, 20),
);
check('dragging west by -5 also widens by 10', near(resizeFrom(square, 'w', -5, 0, free).width, 50));
check('an east drag leaves the height alone', near(resizeFrom(square, 'e', 5, 7, free).height, 20));

// A five-pixel drag down is -5 in the plan's Y-up coordinates.
const corner = resizeFrom(square, 'se', 5, -5, free);
check('a corner drag moves both axes', near(corner.width, 50) && near(corner.height, 30));

// On a +90° plan frame the east handle is visually north. Moving toward it is
// +Y in plan coordinates, so width—not height—is what grows.
const turnedDrag = resizeFrom(turned, 'e', 0, 5, free);
check(
  'a rotated frame grows along its visible handle axis',
  near(turnedDrag.width, 50) && near(turnedDrag.height, 20),
  JSON.stringify(turnedDrag),
);

check('a size can never go negative', resizeFrom(square, 'e', -500, 0, free).width >= 2);

const locked = resizeFrom(square, 'se', 5, 0, { lockAspect: true, snapStep: 0 });
check(
  'shift locks the aspect ratio',
  near(locked.width / locked.height, square.width / square.height),
  `${locked.width}x${locked.height}`,
);

const snapped = resizeFrom(square, 'e', 5.7, 0, { lockAspect: false, snapStep: 10 });
check('sizes snap to the step', near(snapped.width, 50), String(snapped.width));
check(
  'an edge drag does not re-round the axis it is not driving',
  near(resizeFrom({ ...square, height: 23 }, 'e', 5, 0, { lockAspect: false, snapStep: 10 }).height, 23),
);

// ---- rotate ---------------------------------------------------------------

check('bearing east of centre is 0°', near(angleAt(square, 200, 100), 0));
check('bearing north of centre is 90° in plan coordinates', near(angleAt(square, 100, 200), 90));

check('a quarter turn reads as +90', near(rotateFrom(square, 0, 90, false), 90));
check('the delta wraps to the short way round', near(rotateFrom(square, 0, -170, false), -170));

// Shift snaps the RESULT, not the delta: a frame sitting at 7° must land on a
// multiple of 15, not stay 7° off true forever.
const offTrue: TransformFrame = { ...square, angle: 7 };
const snappedDelta = rotateFrom(offTrue, 0, 10, true);
check(
  'shift snaps the resulting angle to 15°',
  near((offTrue.angle + snappedDelta) % 15, 0),
  String(offTrue.angle + snappedDelta),
);

// ---- cursors --------------------------------------------------------------

check('east handle gets the horizontal cursor', cursorFor('e', 0) === 'ew-resize');
check('north handle gets the vertical cursor', cursorFor('n', 0) === 'ns-resize');
check('a 90° turn swaps the two', cursorFor('e', 90) === 'ns-resize');
check('a +45° plan turn gives east the visible NE/SW cursor', cursorFor('e', 45) === 'nesw-resize');
check('the rotate grip gets a grab cursor', cursorFor('rotate', 0) === 'grab');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
