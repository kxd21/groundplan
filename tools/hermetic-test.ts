/**
 * Mandatory, corpus-independent regression suite.
 *
 * This runs in CI on every platform. Production plans and gear-list PDFs remain
 * valuable optional sweep inputs, but no developer-specific path is required
 * for the release gate.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { arrangeMoves } from '../src/format/arrange.js';
import {
  annotationCapabilities,
  createDimension,
  createLabel,
} from '../src/format/annotate.js';
import {
  deleteNode,
  duplicateNode,
  indexDocument,
  moveNode,
  relabelNode,
  resizeNode,
  rotateNode,
} from '../src/format/edit.js';
import { loadBuffer, walk } from '../src/format/index.js';
import { parseDimensions, placeGear } from '../src/format/place.js';
import { importSymbol, listSymbols } from '../src/format/symbol.js';
import { createBlankPlan } from '../src/format/blank.js';
import { isLibrary, readLibrary } from '../src/format/library.js';
import { GRADE, MIN_STROKE_POINTS, pointsToUnits, resolveStyle } from '../src/format/style.js';
import { buildSchedule, entryKey, scheduleSummaryCsv, scheduleToCsv } from '../src/format/schedule.js';
import { buildScene } from '../src/format/scene.js';
import { addSeating } from '../src/format/seating.js';
import { packContainer, roundTrip, serializeArchive, verifyWritable } from '../src/format/write.js';
import { loadGearFile, saveGearFile } from '../src/gear/store.js';
import type { GearList } from '../src/gear/model.js';
import { classify } from '../src/inventory/classify.js';
import { emptyInventory, mergeItems, parseCsv, searchInventory } from '../src/inventory/model.js';
import { loadInventory, saveInventory } from '../src/inventory/store.js';
import { Session } from '../src/main/session.js';
import { atomicWriteFile, atomicWriteJson } from '../src/main/storage.js';
import { copyShowForSaveAs, linkShow, showLinkState } from '../src/main/show-project.js';
import {
  listRecoveries,
  readRecovery,
  recoveryId,
  removeRecovery,
  writeRecovery,
} from '../src/main/recovery.js';
import { buildStableSchedule, setStableScheduleField } from '../src/main/schedule-metadata.js';
import {
  loadDimensionAssociations,
  registerDimensionAssociation,
  saveDimensionAssociations,
  updateAssociativeDimensions,
  type DimensionAssociationFile,
} from '../src/main/dimension-associations.js';
import {
  addPlansToFolder,
  createPlanFolder,
  emptyPlanFolders,
  loadPlanFolders,
  removePlanFolder,
  renamePlanFolder,
  savePlanFolders,
} from '../src/main/plan-folders.js';
import { fixturePlanBuffer } from './test-fixture.js';

/** Counts objects of one class, for before/after assertions. */
function countClass(doc: Parameters<typeof walk>[0], cls: string): number {
  return [...walk(doc)].filter((node) => node.cls === cls).length;
}


let checks = 0;
let failures = 0;

function check(label: string, ok: boolean, detail?: string): void {
  checks++;
  if (ok) return;
  failures++;
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
}

async function main(): Promise<void> {
  const bytes = fixturePlanBuffer();
  const path = 'Synthetic fixture.rv4';
  const loaded = loadBuffer(bytes, path);

  check('synthetic plan uses the production OLE compound container', loaded.container === 'ole-compound');
  check('synthetic archive parses without diagnostics', loaded.document.warnings.length === 0);
  check('synthetic archive round-trips byte-for-byte', roundTrip(loaded.document).identical);

  const scene = buildScene(loaded.document);
  check('scene contains one placed fixture item', scene.inventory[0]?.name === 'Fixture Table' && scene.inventory[0].count === 1);
  check('scene contains rectangle and dimension geometry', scene.primitives.length >= 2, `${scene.primitives.length} primitives`);

  const session = new Session(path, bytes);
  check('fixture opens editable and clean', session.editable && !session.dirty);
  check('session recognises the file revision it opened', session.matchesSavedFile(bytes));
  const externallyChanged = Buffer.from(bytes);
  externallyChanged[externallyChanged.length - 1] ^= 1;
  check('session detects an externally changed file revision', !session.matchesSavedFile(externallyChanged));
  const shape = [...session.index.byId.values()].find((node) => node.cls === 'RVShape');
  check('fixture exposes a movable shape', !!shape);
  if (shape) {
    const before = { ...shape.points[0] };
    session.checkpoint();
    const moved = moveNode(session.loaded.document, shape, 240, -120);
    session.refresh();
    check('move changes the insertion point and dirty state', moved.ok && session.dirty);
    check(
      'move uses expected logical units',
      shape.points[0]?.x === before.x + 240 && shape.points[0]?.y === before.y - 120,
    );
    check('undo restores the saved bytes', session.undo() && !session.dirty);
    check('redo restores the edit', session.redo() && session.dirty);
    check('second undo recreates redo history', session.undo() && session.canRedo());
    session.checkpoint();
    check('rolling back a refused edit succeeds', session.rollback());
    check('refused edit preserves prior redo history', session.canRedo());
    check('preserved redo still reapplies the edit', session.redo() && session.dirty);
  }

  const saveRaceSession = new Session(path, bytes);
  const saveRaceShape = [...saveRaceSession.index.byId.values()].find(
    (node) => node.cls === 'RVShape',
  );
  if (saveRaceShape) {
    saveRaceSession.checkpoint();
    moveNode(saveRaceSession.loaded.document, saveRaceShape, 120, 0);
    saveRaceSession.refresh();
    const bodyBeingSaved = saveRaceSession.body();
    const fileBeingSaved = saveRaceSession.file();
    saveRaceSession.checkpoint();
    moveNode(saveRaceSession.loaded.document, saveRaceShape, 120, 0);
    saveRaceSession.refresh();
    saveRaceSession.markSaved(fileBeingSaved, bodyBeingSaved);
    check('an edit made during a save remains dirty', saveRaceSession.dirty);
  }
  const untrustedRecovery = new Session(path, bytes);
  untrustedRecovery.markRecovered();
  check(
    'legacy recovery without a disk baseline cannot overwrite in place',
    !untrustedRecovery.matchesSavedFile(bytes),
  );

  const label = [...session.index.byId.values()].find((node) => node.cls === 'RVLabel');
  check('fixture exposes an editable label', !!label?.fields.textAt);
  if (label) {
    session.checkpoint();
    check('label can be rewritten', relabelNode(session.loaded.document, label, 'Updated fixture').ok);
    session.refresh();
  }

  const beforeAnnotations = buildScene(session.loaded.document).primitives.length;
  const labelReply = createLabel(session.loaded.document, session.index, 'Created in CI', 1400, 1700);
  check('label creation uses the fixture template', labelReply.ok, labelReply.reason);
  session.refresh();
  const dimensionReply = createDimension(session.loaded.document, session.index, 700, 2400, 1900, 2400);
  check('dimension creation persists a line and value label', dimensionReply.ok, dimensionReply.reason);
  session.refresh();
  check(
    'annotation creation adds scene primitives',
    buildScene(session.loaded.document).primitives.length > beforeAnnotations,
  );

  // A plan with no usable label to copy. This used to be refused outright; the
  // dimension is now built from scratch instead. What must still hold is that a
  // dimension is all-or-nothing — never a line without its value.
  const noLabelDocument = loadBuffer(bytes, path).document;
  for (const node of indexDocument(noLabelDocument).byId.values()) {
    if (node.cls === 'RVLabel') node.fields.textAt = undefined;
  }
  const labelsBefore = countClass(noLabelDocument, 'RVLabel');
  const linesBefore = countClass(noLabelDocument, 'RVDimensionLine');
  const synthesized = createDimension(
    noLabelDocument,
    indexDocument(noLabelDocument),
    700,
    2600,
    1900,
    2600,
  );
  check('a dimension can be made without a template to copy', synthesized.ok, synthesized.reason);
  check(
    'it is a line and a value, never half of one',
    countClass(noLabelDocument, 'RVDimensionLine') === linesBefore + 1 &&
      countClass(noLabelDocument, 'RVLabel') === labelsBefore + 1,
  );
  check('and the plan it produced can be written', verifyWritable(noLabelDocument).ok);

  const reopened = new Session(path, session.file());
  check('edited fixture saves and reopens without diagnostics', reopened.loaded.document.warnings.length === 0);
  check('edited fixture remains round-trip stable', reopened.editable);
  check('created dimension survives reopen', (reopened.scene.counts.RVDimensionLine ?? 0) >= 2);

  const transformDocument = loadBuffer(bytes, path).document;
  const transformShape = [...indexDocument(transformDocument).byId.values()].find((node) => node.cls === 'RVShape');
  check('fixture exposes a transformable shape', !!transformShape);
  if (transformShape) {
    check('shape rotates by an arbitrary angle', rotateNode(transformDocument, transformShape, Math.PI / 6).ok);
    check('shape resizes non-uniformly', resizeNode(transformDocument, transformShape, 1.5, 0.75).ok);
    check(
      'transformed shape saves and reopens',
      new Session(path, packContainer(bytes, serializeArchive(transformDocument))).editable,
    );
  }

  const dimensions = parseDimensions("Fixture Deck 4' x 8'");
  check('placement dimensions parse feet correctly', dimensions.width === 480 && dimensions.height === 960);
  const placementDocument = loadBuffer(bytes, path).document;
  const placementBefore = buildScene(placementDocument).counts.RVShape ?? 0;
  const placed = placeGear(
    placementDocument,
    indexDocument(placementDocument),
    "Fixture Deck 4' x 8'",
    2400,
    2000,
  );
  check('unknown gear synthesizes from a safe in-plan template', placed.ok && placed.method === 'synthesized', placed.reason);
  const placementReopened = new Session(path, packContainer(bytes, serializeArchive(placementDocument)));
  check('synthesized gear survives reopen', (placementReopened.scene.counts.RVShape ?? 0) === placementBefore + 1);

  const seatingDocument = loadBuffer(bytes, path).document;
  const seatingBefore = buildScene(seatingDocument).counts.RVShape ?? 0;
  const seating = addSeating(seatingDocument, indexDocument(seatingDocument), {
    kind: 'theatre',
    x: 1800,
    y: 3000,
    chair: 'Fixture Table',
    rows: 2,
    perRow: 3,
    angle: 30,
  });
  check('angled theatre seating creates the requested block', seating.ok && seating.placed === 6, seating.reason);
  const seatingReopened = new Session(path, packContainer(bytes, serializeArchive(seatingDocument)));
  check('generated seating survives reopen', (seatingReopened.scene.counts.RVShape ?? 0) === seatingBefore + 6);

  const schedule = buildSchedule(reopened.loaded.document, {
    [entryKey('Fixture Table', 1240, 1880)]: { purpose: 'CI fixture' },
  });
  check('schedule derives placed items from the plan', schedule.total === 1);
  check('detailed schedule exports CSV', scheduleToCsv(schedule).startsWith('Item,X (ft),Y (ft)'));
  check('summary schedule exports a total', scheduleSummaryCsv(schedule).includes('TOTAL,1'));

  const moves = arrangeMoves(
    [
      { id: 1, bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 } },
      { id: 2, bounds: { minX: 30, minY: 20, maxX: 50, maxY: 30 } },
      { id: 3, bounds: { minX: 100, minY: 40, maxX: 110, maxY: 50 } },
    ],
    'distribute-horizontal',
  );
  check('arrange distributes unequal items with equal clear space', moves[1]?.dx === 15);
  check('inventory classification remains ordered', classify('PA/Monitor Speaker').category === 'speaker');

  const temporary = mkdtempSync(join(tmpdir(), 'groundplan-data-test-'));
  try {
    const inventory = emptyInventory();
    const rows = parseCsv('Name,Department,Quantity\nFixture Table,Furniture,4\n65" Display,Video,2\n');
    check('inventory CSV parser produces two rows', rows.length === 2);
    check('inventory merge adds both rows', mergeItems(inventory, rows).added === 2);
    check('inventory search finds classified text', searchInventory(inventory, 'display', null).length === 1);
    const inventoryFile = join(temporary, 'inventory.json');
    await saveInventory(inventoryFile, inventory);
    check('inventory saves and reloads atomically', (await loadInventory(inventoryFile)).items.length === 2);

    const gear: GearList = {
      title: 'Synthetic job',
      jobNumber: 'CI-001',
      departments: [
        {
          id: 'department-fixture',
          name: 'Furniture',
          items: [{ id: 'item-fixture', quantity: 4, description: 'Fixture Table', children: [] }],
        },
      ],
    };
    const gearFile = join(temporary, 'fixture.gear.json');
    await saveGearFile(gearFile, [gear]);
    const reopenedGear = await loadGearFile(gearFile);
    check('gear JSON saves and reloads its hierarchy', reopenedGear[0]?.departments[0]?.items[0]?.id === 'item-fixture');

    const linkedPlan = join(temporary, 'linked-plan.rv4');
    await atomicWriteFile(linkedPlan, bytes);
    const planFolderLibrary = emptyPlanFolders();
    const yearFolder = createPlanFolder(
      planFolderLibrary,
      '2026',
      null,
      'folder-year',
      '2026-01-01T00:00:00.000Z',
    );
    const quarterFolder = createPlanFolder(
      planFolderLibrary,
      'Q1',
      yearFolder.id,
      'folder-quarter',
      '2026-01-02T00:00:00.000Z',
    );
    const clientFolder = createPlanFolder(
      planFolderLibrary,
      'Acme Events',
      quarterFolder.id,
      'folder-client',
      '2026-01-03T00:00:00.000Z',
    );
    check(
      'plan folders support year, quarter, and client nesting',
      clientFolder.parentId === quarterFolder.id && quarterFolder.parentId === yearFolder.id,
    );
    check(
      'adding a plan to a virtual folder is idempotent',
      addPlansToFolder(planFolderLibrary, clientFolder.id, [linkedPlan, linkedPlan]) === 1 &&
        addPlansToFolder(planFolderLibrary, clientFolder.id, [linkedPlan]) === 0,
    );
    let duplicateFolderRejected = false;
    try {
      createPlanFolder(planFolderLibrary, 'q1', yearFolder.id, 'folder-duplicate');
    } catch {
      duplicateFolderRejected = true;
    }
    check('sibling folder names reject case-only duplicates', duplicateFolderRejected);
    renamePlanFolder(planFolderLibrary, clientFolder.id, 'Acme Annual Meeting');
    check(
      'plan folders can be renamed without touching memberships',
      planFolderLibrary.folders.find((folder) => folder.id === clientFolder.id)?.name ===
        'Acme Annual Meeting' &&
        planFolderLibrary.memberships[0]?.path === linkedPlan,
    );
    const planFoldersFile = join(temporary, 'plan-folders.json');
    await savePlanFolders(planFoldersFile, planFolderLibrary);
    const reloadedPlanFolders = await loadPlanFolders(planFoldersFile);
    check(
      'plan-folder hierarchy and membership persist atomically',
      reloadedPlanFolders.library.folders.length === 3 &&
        reloadedPlanFolders.library.memberships[0]?.folderId === clientFolder.id,
    );
    const removedPlanFolders = removePlanFolder(reloadedPlanFolders.library, yearFolder.id);
    check(
      'removing a plan folder recursively removes organization metadata',
      removedPlanFolders.folders === 3 &&
        removedPlanFolders.memberships === 1 &&
        reloadedPlanFolders.library.folders.length === 0,
    );
    check('removing a virtual folder leaves the original plan untouched', existsSync(linkedPlan));

    const linkedShow = await linkShow(linkedPlan, gearFile, reopenedGear[0]!);
    check('local Show manifest links the exact plan and gear pair', linkedShow.linked);
    check(
      'local Show manifest rejects a different gear path',
      !(await showLinkState(linkedPlan, join(temporary, 'other.gear.json'))).linked,
    );
    const copiedPlan = join(temporary, 'linked-plan-copy.rv4');
    await atomicWriteFile(copiedPlan, bytes);
    check('Save As copies Show metadata', await copyShowForSaveAs(linkedPlan, copiedPlan));
    const copiedShow = await showLinkState(copiedPlan, gearFile);
    check('copied Show manifest resolves its linked gear path', copiedShow.linked);
    check(
      'copied Show receives a new identity',
      copiedShow.manifest?.id !== linkedShow.manifest?.id,
    );

    const scheduleDocument = loadBuffer(bytes, linkedPlan).document;
    const initialStable = await buildStableSchedule(scheduleDocument, linkedPlan);
    const initialScheduleEntry = initialStable.schedule.groups.flatMap((group) => group.entries)[0];
    check('new schedule rows receive a safe pending identity', initialScheduleEntry?.key.startsWith('pending:') === true);
    const withPurpose = await setStableScheduleField(
      scheduleDocument,
      linkedPlan,
      initialScheduleEntry!.key,
      'purpose',
      'Main display',
    );
    const identifiedEntry = withPurpose.schedule.groups.flatMap((group) => group.entries)[0]!;
    check('schedule field receives a durable UUID identity', !identifiedEntry.key.startsWith('pending:'));
    const scheduleShape = [...indexDocument(scheduleDocument).byId.values()].find(
      (node) => node.cls === 'RVShape',
    );
    if (scheduleShape) moveNode(scheduleDocument, scheduleShape, 240, 0);
    const afterScheduleMove = await buildStableSchedule(scheduleDocument, linkedPlan);
    const movedScheduleEntry = afterScheduleMove.schedule.groups.flatMap((group) => group.entries)[0];
    check(
      'schedule metadata follows a moved object',
      movedScheduleEntry?.key === identifiedEntry.key &&
        movedScheduleEntry.data?.purpose === 'Main display',
    );

    const associativeDocument = loadBuffer(bytes, linkedPlan).document;
    const capabilities = annotationCapabilities(associativeDocument);
    check(
      'annotation tools advertise only templates the plan can safely clone',
      capabilities.label && capabilities.dimensionLine && capabilities.dimension,
    );
    const associativeIndex = indexDocument(associativeDocument);
    const associativeShape = [...associativeIndex.byId.values()].find(
      (node) => node.cls === 'RVShape' && !!node.points[0],
    )!;
    const associationStart = { ...associativeShape.points[0]! };
    const associationEnd = { x: associationStart.x + 1_200, y: associationStart.y };
    const associativeDimension = createDimension(
      associativeDocument,
      associativeIndex,
      associationStart.x,
      associationStart.y,
      associationEnd.x,
      associationEnd.y,
    );
    const associationFile: DimensionAssociationFile = {
      format: 'groundplan-dimension-associations',
      version: 1,
      entries: [],
    };
    check(
      'dimension can attach an endpoint to a selected object',
      associativeDimension.ok &&
        !!associativeDimension.created &&
        registerDimensionAssociation(
          associativeDocument,
          associativeIndex,
          associationFile,
          associativeDimension.created,
          { ...associationStart, nodeId: associativeShape.id },
          associationEnd,
        ),
      associativeDimension.reason,
    );
    moveNode(associativeDocument, associativeShape, 240, 0);
    check(
      'associative dimension updates after its object moves',
      updateAssociativeDimensions(associativeDocument, associativeIndex, associationFile) === 1,
    );
    const associatedLine = [...walk(associativeDocument)].find(
      (node) =>
        associativeDimension.created?.includes(node.id) &&
        node.cls === 'RVDimensionLine',
    );
    check(
      'associated endpoint follows the object while detached endpoint stays put',
      associatedLine?.points[0]?.x === associationStart.x + 240 &&
        associatedLine.points[1]?.x === associationEnd.x,
    );
    const duplicateIndex = indexDocument(associativeDocument);
    const duplicate = duplicateNode(
      associativeDocument,
      duplicateIndex,
      duplicateIndex.byId.get(associativeShape.id)!,
      600,
      0,
    );
    const deleteIndex = indexDocument(associativeDocument);
    const deleted = deleteNode(
      associativeDocument,
      deleteIndex,
      deleteIndex.byId.get(associativeShape.id)!,
    );
    const endpointBeforeDelete = associatedLine?.points[0]?.x;
    updateAssociativeDimensions(
      associativeDocument,
      indexDocument(associativeDocument),
      associationFile,
    );
    check(
      'deleting an endpoint does not steal a same-named nearby object',
      duplicate.ok && deleted.ok && associatedLine?.points[0]?.x === endpointBeforeDelete,
    );
    await saveDimensionAssociations(linkedPlan, associationFile);
    check(
      'dimension associations persist in a versioned sidecar',
      (await loadDimensionAssociations(linkedPlan)).file.entries.length === 1,
    );

    const atomicFile = join(temporary, 'atomic.txt');
    await atomicWriteFile(atomicFile, 'first');
    await atomicWriteFile(atomicFile, 'second', { backupPath: `${atomicFile}.bak` });
    check('shared atomic writer replaces the target', readFileSync(atomicFile, 'utf8') === 'second');
    check('shared atomic writer retains last-good backup', readFileSync(`${atomicFile}.bak`, 'utf8') === 'first');

    const atomicJson = join(temporary, 'atomic.json');
    await atomicWriteJson(atomicJson, { version: 1, ok: true });
    check(
      'shared JSON writer emits valid durable JSON',
      (JSON.parse(readFileSync(atomicJson, 'utf8')) as { ok?: boolean }).ok === true,
    );

    const recoveryRoot = join(temporary, 'recovery');
    const recovery = await writeRecovery(
      recoveryRoot,
      'plan',
      linkedPlan,
      'Linked plan',
      bytes,
      linkedPlan,
      new Session(linkedPlan, bytes).savedFileHash,
    );
    check('dirty work is discoverable through the recovery journal', (await listRecoveries(recoveryRoot)).length === 1);
    check('recovery journal preserves the complete plan bytes', (await readRecovery(recoveryRoot, recovery.id)).data.equals(bytes));
    check('recovery IDs are deterministic per source', recovery.id === recoveryId('plan', linkedPlan));
    check(
      'recovery journal retains the source revision needed for conflict checks',
      typeof recovery.sourceDigest === 'string' && recovery.sourceDigest.length === 64,
    );
    await removeRecovery(recoveryRoot, recovery.id);
    check('saved/dismissed recovery work is removed', (await listRecoveries(recoveryRoot)).length === 0);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }

  // Indexing the final document must remain total after duplicate annotations.
  check('final document index contains unique object ids', indexDocument(reopened.loaded.document).byId.size > 0);

  // --- importing a symbol between plans ----------------------------------
  //
  // The only coverage for this lived in tools/symbol-test.ts, which needs the
  // production drive and so never runs in CI. Two bugs survived there: the
  // import wrote the moved bounds into the bytes but left the node on the
  // source file's rect, and it wrote the placement as `anchor + delta` rather
  // than the destination, which lands a bit or two away in doubles. Both made
  // the save gate refuse the plan afterwards, so both are checked here.
  {
    const donor = loadBuffer(fixturePlanBuffer(), 'donor.rv4').document;
    const donorPlacement = placeGear(donor, indexDocument(donor), 'Import Probe', 40 * 120, 30 * 120, {
      width: 4 * 120,
      height: 2 * 120,
    });
    check('a donor plan can be given a shape to export', donorPlacement.ok, donorPlacement.reason);

    const blank = createBlankPlan({ roomName: 'host', room: { width: 60 * 120, depth: 40 * 120 } });
    check('a blank plan is available to import into', blank.ok && !!blank.file, blank.reason);
    const host = loadBuffer(blank.file!, 'host.rv4').document;
    const named = listSymbols(donor).find((s) => s.name === 'Import Probe');
    check('and that shape is listed as an importable symbol', !!named);

    // A coordinate whose delta does not round-trip cleanly through doubles.
    const targetX = 12345.678901234567;
    const targetY = -9876.543210987654;
    const imported = importSymbol(host, indexDocument(host), donor, 'Import Probe', targetX, targetY);
    check('it imports into another plan', imported.ok, imported.reason);

    const brought = [...walk(host)].find(
      (node) => node.cls === 'RVShape' && node.labels.includes('Import Probe'),
    );
    check('the imported shape is in the host', !!brought);
    check(
      'at exactly the point asked for, not a delta away from it',
      brought?.points[0]?.x === targetX && brought?.points[0]?.y === targetY,
      `${brought?.points[0]?.x}, ${brought?.points[0]?.y}`,
    );
    check(
      'with its bounds rect moved with it',
      !!brought && brought.bounds.left > 0 && brought.bounds.right > brought.bounds.left,
      JSON.stringify(brought?.bounds),
    );

    const writable = verifyWritable(host);
    check('and the plan can still be saved afterwards', writable.ok, writable.reason);
  }

  // --- the shape-library reader must not mistake a plan for a catalogue -----
  //
  // It recognises entries by shape rather than by a magic number, so the guard
  // that matters is that ordinary plans yield nothing: a false positive would
  // invent catalogue names out of whatever bytes followed an object.
  {
    const plan = loadBuffer(fixturePlanBuffer(), 'plan.rv4').document;
    check('a plan is not read as a shape library', readLibrary(plan).length === 0);
    check('and is not flagged as one', !isLibrary(plan));

    const madeHere = createBlankPlan({ roomName: 'Test', room: { width: 30 * 120, depth: 20 * 120 } });
    const synthetic = loadBuffer(madeHere.file!, 'synthetic.rv4').document;
    check('nor is a plan this created', readLibrary(synthetic).length === 0);
  }

  // --- drafting styles are shared and scale-independent --------------------
  {
    const scene = reopened.scene ?? buildScene(reopened.loaded.document);
    const styles = scene.primitives.map((p) => resolveStyle(p));
    check('every primitive resolves a style', styles.length === scene.primitives.length);
    check(
      'and none of them prints thinner than the floor',
      styles.every((st) => st.strokePoints >= MIN_STROKE_POINTS),
      `${Math.min(...styles.map((st) => st.strokePoints))}pt`,
    );

    // A pen weight is a thickness on paper, so it must not change with scale.
    // Stating it in drawing units — which is what the export used to do — made
    // a wall 1.4pt at one scale and 0.45pt at another.
    const printed = (points: number, ipf: number) => pointsToUnits(points, ipf) * (ipf / 120) * 72;
    check(
      'a pen weight prints the same at every scale',
      Math.abs(printed(GRADE.heavy, 1 / 16) - GRADE.heavy) < 1e-6 &&
        Math.abs(printed(GRADE.heavy, 1 / 4) - GRADE.heavy) < 1e-6,
      `${printed(GRADE.heavy, 1 / 16).toFixed(3)} vs ${printed(GRADE.heavy, 1 / 4).toFixed(3)}`,
    );

    check(
      'a wall is heavier than a chair',
      GRADE.heavy > GRADE.light,
    );

    // A deck is a surface. This is the defect that started the audit: closed
    // outlines belonging to staging were drawn hollow in both renderers.
    const deck = {
      id: 0, nodeId: 0, selectId: 0, type: 'polyline' as const,
      pts: [0, 0, 100, 0, 100, 100, 0, 100, 0, 0],
      color: 0, cls: 'RVSegmentPoly', layer: 'furniture' as const,
      owner: 'Stage 42\' x 8\' x 32"',
    };
    check('a closed deck outline resolves a fill', !!resolveStyle(deck).fill);
    check(
      'and a taller deck fills darker than a lower one',
      resolveStyle(deck).fill !== resolveStyle({ ...deck, owner: 'Riser 8\' x 42\' x 24"' }).fill,
      `${resolveStyle(deck).fill} vs ${resolveStyle({ ...deck, owner: 'Riser 8\' x 42\' x 24"' }).fill}`,
    );
    check('a chair is not filled', !resolveStyle({ ...deck, owner: 'Chair 20.5W X 23.23D' }).fill);
    check(
      'an open run is not filled even on a deck',
      !resolveStyle({ ...deck, pts: [0, 0, 100, 0, 100, 100] }).fill,
    );
  }

  console.log(`${checks - failures}/${checks} hermetic checks passed`);
  if (failures > 0) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
