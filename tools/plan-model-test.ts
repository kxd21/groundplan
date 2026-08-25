/**
 * The wiring: the service the window actually talks to.
 *
 * The format modules are tested on their own; this exercises the layer between
 * them and the UI — the companion opening with a plan, edits going through a
 * session, and the whole thing surviving a save and a reopen. Everything the
 * Room panel does goes through these calls, so a green run here means the panel
 * is talking to something that works.
 *
 *   npx tsx tools/plan-model-test.ts
 */

import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Session } from '../src/main/session.js';
import {
  addStage,
  applySeating,
  createRectangularRoom,
  curveRoomWall,
  dimensionOneWall,
  dimensionTheRoom,
  openPlanModel,
  planAllocation,
  planModelView,
  planReport,
  previewSeating,
  resetPlanModel,
  reshapeRoom,
  savePlanModel,
} from '../src/main/plan-model.js';
import { companionPathFor } from '../src/main/companion-store.js';
import { verifyWritable } from '../src/format/write.js';
import { measureNode } from '../src/format/edit.js';
import { walk } from '../src/format/rv.js';
import { UNITS_PER_FOOT, UNITS_PER_INCH } from '../src/format/rv.js';
import { fixturePlanBuffer } from './test-fixture.js';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string): boolean {
  if (ok) {
    passed++;
    console.log(`  pass  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`);
  }
  return ok;
}

const F = UNITS_PER_FOOT;
const dir = mkdtempSync(join(tmpdir(), 'groundplan-model-'));
const planPath = join(dir, 'Wiring test.rv4');

/** A fresh plan and session, with the model opened against it. */
async function open(): Promise<Session> {
  resetPlanModel();
  // The sidecar too: every block starts from a plan Groundplan has never seen.
  rmSync(companionPathFor(planPath), { force: true });
  writeFileSync(planPath, fixturePlanBuffer({ walls: false }));
  const session = new Session(planPath, readFileSync(planPath));
  await openPlanModel(planPath, session.loaded.document, 'imperial');
  return session;
}

/** Mimics `applyEdit` in the main process: mutate, then refresh derived views. */
function commit(session: Session, run: () => { ok: boolean; reason?: string }): { ok: boolean; reason?: string } {
  session.checkpoint();
  const result = run();
  if (result.ok) session.refresh();
  else session.rollback();
  return result;
}

async function main(): Promise<void> {
 try {
  // -------------------------------------------------------------------------
  console.log('opening a plan that has never seen Groundplan\n');

  {
    const session = await open();
    const view = planModelView(session, 'imperial');

    check('the model opens', !!view);
    check('and reports the unit system', view.units === 'imperial');
    check('a plan with no walls falls back to the drawing extent', view.room?.source === 'extent', view.room?.source);
    check('and does not claim the companion as the source', view.room?.source !== 'companion');
    check('the companion is reported as missing, not broken', view.companion.freshness === 'missing');
    check('and it names where it would live', view.companion.path.endsWith('.groundplan.json'));
    check('every seating style is offered', view.seatingStyles.length === 12, `${view.seatingStyles.length}`);
    check('the ones needing a table say so', view.seatingStyles.find((s) => s.id === 'banquet')!.needsTable);
    check('and the ones that do not, do not', !view.seatingStyles.find((s) => s.id === 'theatre')!.needsTable);
    check('placed items are counted', view.itemCount === 1, `${view.itemCount}`);
    check('no stage yet', view.stage === null);
  }

  // -------------------------------------------------------------------------
  console.log('\ndrawing a room\n');

  {
    const session = await open();
    const drawn = commit(session, () => createRectangularRoom(session, 40 * F, 30 * F, 'imperial'));
    check('a room is drawn', drawn.ok, drawn.reason);
    check('and the plan still verifies', verifyWritable(session.loaded.document).ok);

    const view = planModelView(session, 'imperial');
    check('the room is now the companion\'s', view.room?.source === 'companion', view.room?.source);
    check('at the right area', view.room?.areaText === '1,200 sq ft', view.room?.areaText);
    check('with a readable size', view.room?.sizeText === "40' × 30'", view.room?.sizeText);
    check('and a perimeter', view.room?.perimeterText === "140'", view.room?.perimeterText);
    check('four walls', view.room?.walls === 4);
    check('nothing wrong with it', view.room?.problems.length === 0, view.room?.problems.join(' '));
    check('capacity is offered for every layout', view.room?.capacities.length === 8);
    check(
      'theatre capacity is sensible',
      view.room!.capacities.find((c) => c.layout === 'theatre')!.high === 200,
      JSON.stringify(view.room!.capacities[0]),
    );

    // Drawing again must move the walls, not add a second room.
    const again = commit(session, () => createRectangularRoom(session, 50 * F, 30 * F, 'imperial'));
    check('redrawing a room succeeds', again.ok, again.reason);
    const after = planModelView(session, 'imperial');
    check('it has four walls, not eight', after.room?.walls === 4, `${after.room?.walls}`);
    check('at the new size', after.room?.areaText === '1,500 sq ft', after.room?.areaText);
    check('and still verifies', verifyWritable(session.loaded.document).ok);
  }

  {
    // Metric is a display concern: the same room, said the other way.
    const session = await open();
    commit(session, () => createRectangularRoom(session, 40 * F, 30 * F, 'metric'));
    const metric = planModelView(session, 'metric');
    check('the same room reads in metres', metric.room!.sizeText.includes('m'), metric.room!.sizeText);
    check('and square metres', metric.room!.areaText.endsWith('m²'), metric.room!.areaText);
    const imperial = planModelView(session, 'imperial');
    check('switching back changes nothing but the words', imperial.room!.area === metric.room!.area);
  }

  {
    const session = await open();
    check(
      'a room with no size is refused',
      !commit(session, () => createRectangularRoom(session, 0, 30 * F, 'imperial')).ok,
    );
    check(
      'an absurd room is refused',
      !commit(session, () => createRectangularRoom(session, 99999 * F, 30 * F, 'imperial')).ok,
    );
  }

  // -------------------------------------------------------------------------
  console.log('\nreshaping and dimensioning\n');

  {
    const session = await open();
    commit(session, () => createRectangularRoom(session, 40 * F, 30 * F, 'imperial'));

    // A first room is drawn where the existing drawing sits, not at the origin,
    // so everything is positioned relative to the room's own bounds.
    const at = planModelView(session, 'imperial').room!;
    const cut = commit(session, () =>
      reshapeRoom(session, 'difference', at.x + 35 * F, at.y, 5 * F, 30 * F, 'imperial'),
    );
    check('a corridor can be cut out', cut.ok, cut.reason);
    check(
      'the floor area drops by exactly the corridor',
      planModelView(session, 'imperial').room!.areaText === '1,050 sq ft',
      planModelView(session, 'imperial').room!.areaText,
    );
    check('and it verifies', verifyWritable(session.loaded.document).ok);

    const added = commit(session, () =>
      reshapeRoom(session, 'union', at.x, at.y + 30 * F, 20 * F, 10 * F, 'imperial'),
    );
    check('a bay can be added', added.ok, added.reason);
    check('the area grows again', planModelView(session, 'imperial').room!.area > 1050 * F * F);
  }

  {
    const session = await open();
    commit(session, () => createRectangularRoom(session, 40 * F, 30 * F, 'imperial'));
    const dimensioned = commit(session, () => dimensionTheRoom(session, 'imperial'));
    check('the room can be dimensioned', dimensioned.ok, dimensioned.reason);
    check('and it verifies', verifyWritable(session.loaded.document).ok);
    check(
      'the dimension text is on the drawing',
      session.scene.primitives.some((p) => p.text === "40'  0 in" || p.text?.includes('ft')),
      session.scene.primitives.filter((p) => p.text).map((p) => p.text).join(' | '),
    );

    // Even a plan whose outline is only the drawing extent can be dimensioned:
    // the numbers are honest about what they measure.
    const bare = await open();
    check('a derived outline can still be dimensioned', commit(bare, () => dimensionTheRoom(bare, 'imperial')).ok);
  }

  {
    // Calling out one wall the way a drafter would: a curve reads three ways
    // and they are not interchangeable, so each has to be askable for.
    const session = await open();
    commit(session, () => createRectangularRoom(session, 40 * F, 30 * F, 'imperial'));

    const straight = commit(session, () => dimensionOneWall(session, 0, 'length', 'imperial'));
    check('a straight wall takes a length dimension', straight.ok, straight.reason);

    const wrongKind = dimensionOneWall(session, 0, 'radius', 'imperial');
    check(
      'and refuses a radius, with a reason that says what to do instead',
      !wrongKind.ok && /straight/i.test(wrongKind.reason ?? ''),
      wrongKind.reason,
    );

    // Bow one wall out, then read it three different ways.
    // A 30ft radius on a 40ft wall: a real ballroom bow, not a hairline.
    const curved = commit(session, () => curveRoomWall(session, 0, 30 * F, 'imperial'));
    check('a wall can be curved for the arc dimensions', curved.ok, curved.reason);

    for (const kind of ['radius', 'diameter', 'arc'] as const) {
      const reply = commit(session, () => dimensionOneWall(session, 0, kind, 'imperial'));
      check(`a curved wall can be called out as a ${kind}`, reply.ok, reply.reason);
    }

    check('and the plan still verifies afterwards', verifyWritable(session.loaded.document).ok);
  }

  {
    // Corner angles: square corners are the assumption and stay unannotated,
    // an angled corner is the thing a carpenter needs off the drawing.
    const square = await open();
    commit(square, () => createRectangularRoom(square, 40 * F, 30 * F, 'imperial'));
    const before = square.scene.primitives.length;
    commit(square, () => dimensionTheRoom(square, 'imperial', { corners: true }));
    const withCorners = square.scene.primitives.length;

    const plain = await open();
    commit(plain, () => createRectangularRoom(plain, 40 * F, 30 * F, 'imperial'));
    const plainBefore = plain.scene.primitives.length;
    commit(plain, () => dimensionTheRoom(plain, 'imperial'));
    const plainAfter = plain.scene.primitives.length;

    check(
      'asking for corners on a square room adds no angle clutter',
      withCorners - before === plainAfter - plainBefore,
      `${withCorners - before} vs ${plainAfter - plainBefore}`,
    );

    // Asking for one specific corner is different from the automatic pass:
    // the pass stays quiet about right angles because they are the assumption,
    // but a user who points at a corner and asks has said what they want.
    const angled = commit(square, () => dimensionOneWall(square, 0, 'angle', 'imperial'));
    check('but asking for one corner directly draws it anyway', angled.ok, angled.reason);
  }

  // -------------------------------------------------------------------------
  console.log('\nseating\n');

  {
    const session = await open();
    commit(session, () => createRectangularRoom(session, 40 * F, 30 * F, 'imperial'));

    const request = { style: 'theatre' as const, focusX: 20 * F, focusY: -6 * F };
    const preview = previewSeating(session, request);
    check('a layout can be previewed without drawing anything', preview.seats > 50, `${preview.seats}`);
    check('and previewing changes nothing', verifyWritable(session.loaded.document).ok);

    const wider = previewSeating(session, { ...request, rowSpacing: 60 * UNITS_PER_INCH });
    check('wider rows preview fewer seats', wider.seats < preview.seats, `${wider.seats} vs ${preview.seats}`);

    const aisled = previewSeating(session, { ...request, centreAisle: 6 * F });
    check('a centre aisle costs seats', aisled.seats < preview.seats, `${aisled.seats} vs ${preview.seats}`);

    const capped = previewSeating(session, { ...request, maxSeats: 40 });
    check('a cap is honoured in the preview', capped.seats === 40, `${capped.seats}`);

    const placed = commit(session, () =>
      applySeating(session, { ...request, maxSeats: 40 }, 'Fixture Table'),
    );
    check('the layout places', placed.ok, placed.reason);
    check('and the plan verifies', verifyWritable(session.loaded.document).ok);
    check(
      'one object per seat is on the drawing',
      planModelView(session, 'imperial').itemCount === 1 + 40,
      `${planModelView(session, 'imperial').itemCount}`,
    );

    // Replacing rather than accumulating is the whole point.
    const again = commit(session, () =>
      applySeating(session, { ...request, maxSeats: 20 }, 'Fixture Table'),
    );
    check('placing again replaces the previous layout', again.ok, again.reason);
    check(
      'leaving twenty, not sixty',
      planModelView(session, 'imperial').itemCount === 1 + 20,
      `${planModelView(session, 'imperial').itemCount}`,
    );

    const addedSection = commit(session, () =>
      applySeating(session, { ...request, maxSeats: 10, append: true }, 'Fixture Table'),
    );
    check('another seating bank can be added', addedSection.ok, addedSection.reason);
    check(
      'an added bank keeps the existing layout',
      planModelView(session, 'imperial').itemCount === 1 + 20 + 10,
      `${planModelView(session, 'imperial').itemCount}`,
    );
    check(
      'managed seating status is cumulative',
      planModelView(session, 'imperial').seatingStatus?.chairs === 30,
      `${planModelView(session, 'imperial').seatingStatus?.chairs}`,
    );
    check('and it still verifies', verifyWritable(session.loaded.document).ok);
  }

  {
    const session = await open();
    commit(session, () => createRectangularRoom(session, 40 * F, 30 * F, 'imperial'));
    const noChair = commit(session, () => applySeating(session, { style: 'theatre', focusX: 0, focusY: 0 }, ''));
    check('seating without a chair is refused', !noChair.ok);
    const noTable = commit(session, () =>
      applySeating(session, { style: 'banquet', focusX: 20 * F, focusY: -6 * F }, 'Fixture Table'),
    );
    check('a rounds layout without a table is refused', !noTable.ok, noTable.reason);
    check('and says a table is needed', (noTable.reason ?? '').includes('table'), noTable.reason);
  }

  // -------------------------------------------------------------------------
  console.log('\nstage\n');

  {
    const session = await open();
    commit(session, () => createRectangularRoom(session, 60 * F, 40 * F, 'imperial'));

    let build: ReturnType<typeof addStage> | null = null;
    const added = commit(session, () => {
      build = addStage(session, 18 * F, 0, 24 * F, 16 * F, 24 * UNITS_PER_INCH);
      return build;
    });
    check('a stage is added', added.ok, added.reason);
    check('and it verifies', verifyWritable(session.loaded.document).ok);
    check('with a build list', (build!.buildList?.length ?? 0) > 0);
    check(
      'counting twelve 4x8 decks',
      build!.buildList!.find((l) => l.item.includes("4' x 8'"))!.quantity === 12,
      JSON.stringify(build!.buildList),
    );
    check('and legs', build!.buildList!.some((l) => l.item.startsWith('Legs')));
    check('a sensible stage warns about nothing', (build!.warnings?.length ?? 0) === 0, build!.warnings?.join(' | '));

    const view = planModelView(session, 'imperial');
    check('the panel can see the stage', view.stage?.present === true);
    check(
      'stage and stairs are on the plan',
      view.itemCount >= 2 && view.itemCount <= 3,
      `${view.itemCount}`,
    );
    check('named with its size', session.scene.inventory.some((i) => i.name.startsWith('Stage 24')), session.scene.inventory.map((i) => i.name).join(' | '));

    // A placed shape keeps its insertion point in absolute coordinates and its
    // outline local to that point. Measuring the two together reports the
    // distance from the plan origin to the shape rather than the shape: this
    // 24ft stage placed 18ft along the room measured 42ft, and every "resize to
    // N feet" scaled by that same wrong figure.
    const stageNode = [...walk(session.loaded.document)].find(
      (node) => node.cls === 'RVShape' && node.labels.some((l) => l.startsWith('Stage 24')),
    );
    check('the stage object is findable', !!stageNode);
    const measured = measureNode(stageNode!);
    check(
      'and it measures the stage, not its distance from the origin',
      Math.abs(measured.width - 24 * F) < 2 && Math.abs(measured.height - 16 * F) < 2,
      `${(measured.width / F).toFixed(2)} x ${(measured.height / F).toFixed(2)} ft`,
    );
    check(
      'which is what its own bounds rect says too',
      Math.abs(measured.width - (stageNode!.bounds.right - stageNode!.bounds.left)) < 2,
      `rect ${((stageNode!.bounds.right - stageNode!.bounds.left) / F).toFixed(2)} ft`,
    );

    // A stage takes its floor out of the seating count.
    const request = { style: 'theatre' as const, focusX: 30 * F, focusY: 8 * F };
    const withStage = previewSeating(session, request);
    check('and its floor is not seated', withStage.seats > 0, `${withStage.seats}`);
  }

  // -------------------------------------------------------------------------
  console.log('\nreport and allocation\n');

  {
    const session = await open();
    commit(session, () => createRectangularRoom(session, 60 * F, 40 * F, 'imperial'));
    commit(session, () => addStage(session, 18 * F, 0, 24 * F, 16 * F, 24 * UNITS_PER_INCH));
    commit(session, () =>
      applySeating(session, { style: 'theatre', focusX: 30 * F, focusY: 8 * F, maxSeats: 30 }, 'Fixture Table'),
    );

    const report = planReport(session, {
      units: 'imperial',
      scale: '1/8" = 1\'',
      venue: 'Riverside',
      client: 'Acme',
      owned: [{ name: 'Fixture Table', quantity: 10 }],
      seating: { style: 'theatre', focusX: 30 * F, focusY: 8 * F, maxSeats: 30 },
    });

    check('a report is produced', report.length > 200);
    check('with the title block', report.includes('Riverside') && report.includes('Acme'));
    check('the room', report.includes('2,400 sq ft'), report.slice(0, 600));
    check('the capacity table', report.includes('Capacity by layout'));
    check('the stage build list', report.includes("Deck 4' x 8'"));
    check('the seating count', report.includes('## Seating'));
    check('and the equipment shortage', report.includes('## Equipment') && report.includes('short'));

    const allocation = planAllocation(session, [{ name: 'Fixture Table', quantity: 10 }]);
    check('the allocation is computed', allocation.lines.length > 0);
    check('and catches the shortfall', allocation.summary.shortLines === 1, JSON.stringify(allocation.summary));
    check(
      'naming what to sub-hire',
      allocation.summary.notes[0].includes('Fixture Table'),
      allocation.summary.notes.join(' | '),
    );
  }

  // -------------------------------------------------------------------------
  console.log('\nsaving and reopening\n');

  {
    const session = await open();
    commit(session, () => createRectangularRoom(session, 40 * F, 30 * F, 'imperial'));

    const bytes = session.file();
    writeFileSync(planPath, bytes);
    session.markSaved(bytes, session.body());
    await savePlanModel(planPath, session.body());

    const sidecar = companionPathFor(planPath);
    check('a companion file is written beside the plan', existsSync(sidecar));
    const stored = JSON.parse(readFileSync(sidecar, 'utf8')) as { rooms: unknown[]; format: string };
    check('holding the room', stored.rooms.length === 1);
    check('and marked as ours', stored.format === 'groundplan-companion');

    // Reopen from disk, exactly as the app does.
    resetPlanModel();
    const reopened = new Session(planPath, readFileSync(planPath));
    await openPlanModel(planPath, reopened.loaded.document, 'imperial');
    const view = planModelView(reopened, 'imperial');

    check('reopening finds the companion fresh', view.companion.freshness === 'fresh', view.companion.freshness);
    check('with the room it saved', view.room?.areaText === '1,200 sq ft', view.room?.areaText);
    check('from the companion, not re-derived', view.room?.source === 'companion', view.room?.source);

    // Now edit the plan behind Groundplan's back and reopen again.
    const edited = new Session(planPath, readFileSync(planPath));
    edited.checkpoint();
    createRectangularRoom(edited, 55 * F, 35 * F, 'imperial');
    edited.refresh();
    writeFileSync(planPath, edited.file());

    resetPlanModel();
    const stale = new Session(planPath, readFileSync(planPath));
    await openPlanModel(planPath, stale.loaded.document, 'imperial');
    const staleView = planModelView(stale, 'imperial');
    check('a plan changed elsewhere is reported stale', staleView.companion.freshness === 'stale', staleView.companion.freshness);
    check('with an explanation for the user', !!staleView.companion.reason && staleView.companion.reason.includes('Room Viewer'));
    check(
      'and the room falls back to what is actually drawn',
      staleView.room !== null && staleView.room.source !== 'companion',
      staleView.room?.source,
    );
  }

  {
    // A plan nobody authored must not litter the folder with a sidecar.
    const session = await open();
    await savePlanModel(planPath, session.body());
    check('an untouched plan writes no companion', !existsSync(companionPathFor(planPath)));
  }
 } finally {
  rmSync(dir, { recursive: true, force: true });
 }

 console.log(`\n${passed}/${passed + failed} checks passed`);
 if (failed) process.exit(1);
}

void main();
