/**
 * The show brief, and whether the drawing satisfies it.
 *
 *   npx tsx tools/show-brief-test.ts
 *
 * Two things are load-bearing here. A plan made before the brief existed has
 * to keep opening exactly as it did, and a brief that was filled in has to
 * come back byte for byte after a save and a reopen — a record you cannot
 * trust to survive is worse than no record, because people stop writing in it.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  briefFromIdentity,
  briefIsEmpty,
  describeBrief,
  emptyShowBrief,
  identityFromBrief,
  parseShowBrief,
  patchShowBrief,
  SHOW_BRIEF_VERSION,
  type ShowBrief,
} from '../src/format/show-brief.js';
import { assessReadiness, describeReadiness, type PlanFacts } from '../src/format/readiness.js';
import { suggestKit, type KitCandidate } from '../src/format/kit-fit.js';
import { parseCompanion, createCompanion, COMPANION_FORMAT } from '../src/format/companion.js';
import { loadBuffer } from '../src/format/index.js';
import { planIdentity, setPlanIdentity } from '../src/format/plan-skeleton.js';
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

/** A brief with every field populated, for round-trip checks. */
function fullBrief(): ShowBrief {
  return {
    version: SHOW_BRIEF_VERSION,
    name: 'Northwind Global Kickoff',
    client: 'Northwind Traders',
    jobNumber: 'NW-2049',
    status: 'review',
    eventStart: '2026-09-14',
    eventEnd: '2026-09-16',
    loadIn: '2026-09-12 06:00',
    loadOut: '2026-09-16 23:00',
    venue: 'Marriott Marquis',
    roomName: 'Grand Ballroom East',
    address: '780 Mission St, San Francisco',
    venueContact: 'Dana Reyes',
    productionContact: 'Sam Okafor',
    accessNotes: 'Dock 3, 12ft clearance, no overnight parking',
    targetAttendance: 850,
    layoutType: 'general-session',
    stageRequired: true,
    stageWidthFt: 40,
    stageDepthFt: 24,
    stageHeightIn: 32,
    screensRequired: true,
    tablesRequired: false,
    minAisleIn: 44,
    accessibleSeats: 12,
    riggingAllowed: true,
    riggingNotes: 'Two points per motor, 1500lb limit',
    powerNotes: '400A three phase at stage left',
    egressNotes: 'Four exits, none may be blocked by seating',
    productionNotes: 'Client wants centre aisle for award walk-ups',
    updatedAt: '2026-08-01T10:00:00.000Z',
  };
}

console.log('\nan empty brief is not a brief');
{
  check('a fresh brief reports empty', briefIsEmpty(emptyShowBrief()));
  check('null reports empty', briefIsEmpty(null));
  check('a name alone is not empty', !briefIsEmpty(emptyShowBrief('Kickoff')));
  check(
    'a field other than the name is not empty',
    !briefIsEmpty({ ...emptyShowBrief(), targetAttendance: 400 }),
  );
  check('parsing nothing gives nothing', parseShowBrief(undefined) === null);
  check('parsing junk gives nothing', parseShowBrief('nonsense') === null);
  check('parsing an empty object gives nothing', parseShowBrief({}) === null);
}

console.log('\nevery field survives a parse');
{
  const original = fullBrief();
  const round = parseShowBrief(JSON.parse(JSON.stringify(original)));
  check('it parses', !!round);
  if (round) {
    const keys = Object.keys(original) as Array<keyof ShowBrief>;
    const wrong = keys.filter((k) => JSON.stringify(round[k]) !== JSON.stringify(original[k]));
    check(`all ${keys.length} fields round-trip`, wrong.length === 0, `differs: ${wrong.join(', ')}`);
  }
}

console.log('\nbad values degrade rather than failing the open');
{
  const brief = parseShowBrief({
    name: '  Spacey Show  ',
    status: 'not-a-status',
    layoutType: 'interpretive-dance',
    targetAttendance: -4,
    accessibleSeats: 0,
    stageWidthFt: 'wide',
    stageRequired: 'yes',
    client: '   ',
    venue: 'Hall',
    unknownFuture: { nested: true },
  });
  check('it still parses', !!brief);
  check('the name is trimmed', brief?.name === 'Spacey Show', brief?.name);
  check('an unknown status falls back to planning', brief?.status === 'planning', brief?.status);
  check('an unknown layout type is dropped', brief?.layoutType === undefined);
  check('a negative attendance is dropped', brief?.targetAttendance === undefined);
  check('zero accessible seats is dropped, not stored as zero', brief?.accessibleSeats === undefined);
  check('a non-numeric size is dropped', brief?.stageWidthFt === undefined);
  check('a non-boolean flag is dropped', brief?.stageRequired === undefined);
  check('a whitespace-only field is dropped', brief?.client === undefined);
  check('a real field alongside them survives', brief?.venue === 'Hall');
  check('an unknown field is not carried through', !('unknownFuture' in (brief ?? {})));
}

console.log('\npatching clears a field rather than storing an empty one');
{
  const start = patchShowBrief(null, { name: 'Show', venue: 'Hall', targetAttendance: 300 });
  check('a patch onto nothing creates a brief', start.name === 'Show' && start.venue === 'Hall');
  check('and stamps a version', start.version === SHOW_BRIEF_VERSION);
  check('and an updated time', !!start.updatedAt);

  const cleared = patchShowBrief(start, { venue: '' });
  check('clearing a field removes it', !('venue' in cleared), JSON.stringify(cleared.venue));
  check('and leaves the others alone', cleared.targetAttendance === 300 && cleared.name === 'Show');

  const renamed = patchShowBrief(cleared, { name: '  Trimmed  ' });
  check('a name is trimmed on patch', renamed.name === 'Trimmed', renamed.name);

  const bogus = patchShowBrief(cleared, { status: 'nope' as never });
  check('a bad status falls back rather than sticking', bogus.status === 'planning');
}

console.log('\nthe four legacy trailer fields stay in step');
{
  const brief = fullBrief();
  const identity = identityFromBrief(brief);
  check('the event is the show name', identity.event === 'Northwind Global Kickoff', identity.event);
  check(
    'the venue includes the room, which is the more useful answer',
    identity.venue === 'Marriott Marquis · Grand Ballroom East',
    identity.venue,
  );
  check('the date is the event start', identity.date === '2026-09-14', identity.date);
  check(
    'the contact prefers production over venue',
    identity.contact === 'Sam Okafor',
    identity.contact,
  );

  const venueOnly = identityFromBrief({ ...emptyShowBrief('S'), venueContact: 'Dana' });
  check('and falls back to the venue contact', venueOnly.contact === 'Dana', venueOnly.contact);

  const bare = identityFromBrief(emptyShowBrief(''));
  check('an empty brief yields no trailer fields', Object.keys(bare).length === 0, JSON.stringify(bare));

  // The other direction: a legacy plan seeds a brief from what it already has.
  const seeded = briefFromIdentity({ event: 'Old Show', venue: 'Old Hall', date: '2019-01-01' });
  check('a legacy plan seeds a brief', seeded?.name === 'Old Show' && seeded?.venue === 'Old Hall');
  check('and its date becomes the event start', seeded?.eventStart === '2019-01-01');
  check('an empty trailer seeds nothing', briefFromIdentity({}) === null);
}

console.log('\nthe brief rides in the companion sidecar');
{
  const dir = mkdtempSync(join(tmpdir(), 'groundplan-brief-'));
  const planPath = join(dir, 'Show.rv4');
  const bytes = fixturePlanBuffer();
  writeFileSync(planPath, bytes);
  const doc = loadBuffer(bytes, planPath).document;

  const companion = createCompanion(doc, 'imperial');
  companion.showBrief = fullBrief();

  const json = JSON.parse(JSON.stringify(companion));
  const reopened = parseCompanion(json);
  check('the sidecar parses', !!reopened);
  check('and it is ours', reopened?.format === COMPANION_FORMAT);
  check('the brief came back', !!reopened?.showBrief);
  // Per field, not by stringify: the parser builds keys in its own order and
  // key order is not part of the contract.
  const want = fullBrief();
  const got = reopened?.showBrief;
  const differing = (Object.keys(want) as Array<keyof ShowBrief>).filter(
    (k) => JSON.stringify(got?.[k]) !== JSON.stringify(want[k]),
  );
  check('with every value intact', !!got && differing.length === 0, `differs: ${differing.join(', ')}`);

  // The case that must never regress: a sidecar written before briefs existed.
  const legacy = JSON.parse(JSON.stringify(createCompanion(doc, 'imperial')));
  delete legacy.showBrief;
  const legacyParsed = parseCompanion(legacy);
  check('a sidecar with no brief still opens', !!legacyParsed);
  check('and reports no brief rather than an empty one', legacyParsed?.showBrief === undefined);

  // And a sidecar whose brief is corrupt.
  const broken = JSON.parse(JSON.stringify(companion));
  broken.showBrief = 'not an object';
  const brokenParsed = parseCompanion(broken);
  check('a corrupt brief does not fail the plan', !!brokenParsed);
  check('it is simply absent', brokenParsed?.showBrief === undefined);

  rmSync(dir, { recursive: true, force: true });
}

console.log('\nreadiness: nothing is ticked by having been visited');
{
  const empty: PlanFacts = {
    hasRoom: false,
    seats: 0,
    tables: 0,
    hasStage: false,
    hasScreens: false,
    accessibleSeats: 0,
  };

  const noBrief = assessReadiness(null, empty);
  check('no brief and no room is incomplete', noBrief.level === 'incomplete', noBrief.level);
  check('and says the room is missing', noBrief.issues.some((i) => i.id === 'no-room'));
  check('and that the show has no name', noBrief.issues.some((i) => i.id === 'no-name'));
  check('both blocking', noBrief.issues.filter((i) => i.severity === 'blocking').length === 2);
  check('every issue names a place to go', noBrief.issues.every((i) => !!i.target && !!i.action));

  const brief = fullBrief();
  const roomOnly = assessReadiness(brief, { ...empty, hasRoom: true });
  check('a room but nothing built is attention, not incomplete', roomOnly.level === 'attention', roomOnly.level);
  check('850 seats short', roomOnly.seats.shortfall === 850, `${roomOnly.seats.shortfall}`);
  check('the stage is reported missing', roomOnly.issues.some((i) => i.id === 'stage-missing'));
  check('the screens are reported missing', roomOnly.issues.some((i) => i.id === 'screens-missing'));
  check(
    'accessible spaces are reported short',
    roomOnly.issues.some((i) => i.id === 'accessible-short'),
  );
  check(
    'tables were not asked for, so they are not reported',
    !roomOnly.issues.some((i) => i.id === 'tables-missing'),
  );
}

console.log('\nreadiness: a plan that meets the brief is ready');
{
  const brief = fullBrief();
  const good: PlanFacts = {
    hasRoom: true,
    seats: 900,
    tables: 0,
    hasStage: true,
    hasScreens: true,
    accessibleSeats: 12,
  };
  const report = assessReadiness(brief, good);
  check('it is ready', report.level === 'ready', `${report.level}: ${report.issues.map((i) => i.id).join(', ')}`);
  check('no issues at all', report.issues.length === 0, report.issues.map((i) => i.id).join(', '));
  check('spare capacity reads as a negative shortfall', report.seats.shortfall === -50, `${report.seats.shortfall}`);
  check('and it says so plainly', /Everything/.test(describeReadiness(report)), describeReadiness(report));

  /*
   * Materially over the target is a warning, not a pass.
   *
   * "At least the target" was the whole seat test, so a 900-person show that
   * landed a 2,234-seat kit read "Everything the brief asked for is on the
   * drawing" — with 1,334 chairs nobody ordered and the occupant load a fire
   * marshal reads off the drawing rather than off the brief.
   */
  const overSeated = assessReadiness(brief, { ...good, seats: 2234 });
  check('a 2.6x over-seated room is not ready', overSeated.level === 'attention', overSeated.level);
  const excess = overSeated.issues.find((i) => i.id === 'seats-excess');
  check('and it names the excess', !!excess, overSeated.issues.map((i) => i.id).join(', '));
  check('by how many', /1,384/.test(excess?.title ?? ''), excess?.title);
  check('pointing at seating', excess?.target === 'seating', excess?.target);

  // A handful spare is normal and must not nag. 50 over 850 is under the 10%
  // that would make it worth a word — the `good` case above already proves it
  // stays ready; this proves the boundary is about proportion, not a fixed
  // number, by keeping the same 50 against a much smaller show.
  const smallShow = assessReadiness(
    { ...brief, targetAttendance: 100 },
    { ...good, seats: 150 },
  );
  check(
    'the same 50 spare on a 100-person show IS worth saying',
    smallShow.issues.some((i) => i.id === 'seats-excess'),
    smallShow.issues.map((i) => i.id).join(', '),
  );
  const barelyOver = assessReadiness(brief, { ...good, seats: 865 });
  check(
    'fifteen spare is left alone',
    !barelyOver.issues.some((i) => i.id === 'seats-excess'),
    barelyOver.issues.map((i) => i.id).join(', '),
  );

  /*
   * A stage that exists but is not the stage that was asked for.
   *
   * The brief takes a width, a depth and a height and used to do nothing with
   * any of them, so a general session that asked for 40′ × 24′ and got a
   * 12′ × 5′ riser reported "Stage: on the drawing" and called itself ready.
   */
  const smallStage = assessReadiness(
    { ...brief, stageRequired: true, stageWidthFt: 40, stageDepthFt: 24 },
    { ...good, stageSize: { widthFt: 12, depthFt: 5 } },
  );
  check(
    'a riser does not satisfy a forty-by-twenty-four stage',
    smallStage.issues.some((i) => i.id === 'stage-undersized'),
    smallStage.issues.map((i) => i.id).join(', '),
  );
  check(
    'and it says both numbers',
    /12.*5.*40.*24/s.test(smallStage.issues.find((i) => i.id === 'stage-undersized')?.detail ?? ''),
    smallStage.issues.find((i) => i.id === 'stage-undersized')?.detail,
  );
  const rightStage = assessReadiness(
    { ...brief, stageRequired: true, stageWidthFt: 40, stageDepthFt: 24 },
    { ...good, stageSize: { widthFt: 40, depthFt: 24 } },
  );
  check(
    'the stage it asked for passes',
    !rightStage.issues.some((i) => i.id === 'stage-undersized'),
    rightStage.issues.map((i) => i.id).join(', '),
  );
  const biggerStage = assessReadiness(
    { ...brief, stageRequired: true, stageWidthFt: 40, stageDepthFt: 24 },
    { ...good, stageSize: { widthFt: 48, depthFt: 32 } },
  );
  check(
    'and a bigger deck is a decision, not an error',
    !biggerStage.issues.some((i) => i.id === 'stage-undersized'),
    biggerStage.issues.map((i) => i.id).join(', '),
  );
  const unmeasured = assessReadiness(
    { ...brief, stageRequired: true, stageWidthFt: 40, stageDepthFt: 24 },
    good,
  );
  check(
    'a stage whose size is unknown is not accused of being small',
    !unmeasured.issues.some((i) => i.id === 'stage-undersized'),
    unmeasured.issues.map((i) => i.id).join(', '),
  );

  /*
   * Writing is held to the same rules as reading.
   *
   * `parseShowBrief` clamped and `patchShowBrief` did not, so the two
   * disagreed about the same brief: a target attendance of 999,999,999,999
   * was stored and shown, the panel reported a shortfall of a trillion seats,
   * and the number quietly became 500,000 the next time the plan opened.
   */
  {
    const junk = patchShowBrief(emptyShowBrief('Junk'), {
      targetAttendance: 999_999_999_999,
      accessibleSeats: -5,
      stageWidthFt: 0,
      minAisleIn: Number.POSITIVE_INFINITY,
      layoutType: 'not-a-layout' as never,
    });
    check('an absurd headcount is clamped on the way in', junk.targetAttendance === 500_000, `${junk.targetAttendance}`);
    check('a negative accessible count clears the field', junk.accessibleSeats === undefined, `${junk.accessibleSeats}`);
    check('a zero stage width clears it', junk.stageWidthFt === undefined, `${junk.stageWidthFt}`);
    check('an infinite aisle clears it', junk.minAisleIn === undefined, `${junk.minAisleIn}`);
    check('an unknown layout type clears it', junk.layoutType === undefined, `${junk.layoutType}`);
    check('and the name it was given survives', junk.name === 'Junk', junk.name);

    // What is written is what is read back — no drift across a round trip.
    const round = parseShowBrief(JSON.parse(JSON.stringify(junk)));
    check(
      'a patched brief round-trips unchanged',
      JSON.stringify({ ...round, updatedAt: '' }) === JSON.stringify({ ...junk, updatedAt: '' }),
      JSON.stringify(round),
    );
  }

  // Removing the stage must move it straight back to attention.
  const noStage = assessReadiness(brief, { ...good, hasStage: false });
  check('taking the stage away drops it to attention', noStage.level === 'attention');
  check('naming the stage', noStage.issues.some((i) => i.id === 'stage-missing'));
  check('and the tool that fixes it', noStage.issues.find((i) => i.id === 'stage-missing')?.target === 'stage');

  // Gear shortages surface only when a gear list is loaded.
  const shortGear = assessReadiness(brief, { ...good, gearShort: 3, gearUntracked: 7 });
  check('gear shortages are a warning', shortGear.issues.some((i) => i.id === 'gear-short'));
  check('untracked gear is only information', shortGear.issues.find((i) => i.id === 'gear-untracked')?.severity === 'info');
  check('so the plan is attention, not incomplete', shortGear.level === 'attention');
}

console.log('\nreadiness: an unstated requirement is never reported as met');
{
  const thin = emptyShowBrief('Sketch');
  const facts: PlanFacts = {
    hasRoom: true,
    seats: 40,
    tables: 4,
    hasStage: false,
    hasScreens: false,
    accessibleSeats: 0,
  };
  const report = assessReadiness(thin, facts);

  check('no target means no shortfall', report.seats.shortfall === null, `${report.seats.shortfall}`);
  check('and no seat warning', !report.issues.some((i) => i.id === 'seats-short'));
  check(
    'a stage nobody asked for is not reported missing',
    !report.issues.some((i) => i.id === 'stage-missing'),
  );
  check(
    'but the missing target is surfaced as information',
    report.issues.some((i) => i.id === 'no-target' && i.severity === 'info'),
  );
  check('as is the missing venue', report.issues.some((i) => i.id === 'no-venue'));
  check('and the missing egress note', report.issues.some((i) => i.id === 'no-egress'));
  check(
    'a brief with only information-level gaps still counts as ready to issue',
    report.level === 'ready',
    report.level,
  );
}

console.log('\naccented and punctuated names survive the legacy trailer');
{
  // This is a regression guard for a real defect, not a hypothetical. The
  // trailer encodes latin1, and the decoder used to reject anything outside
  // printable ASCII — so writing a venue called "Cafe\u0301 Royal" succeeded, then
  // failed to read back, silently taking venue, event, date and contact with
  // it. Accented venue names are ordinary; this must round-trip.
  const dir = mkdtempSync(join(tmpdir(), 'groundplan-trailer-'));
  const planPath = join(dir, 'Accents.rv4');
  const bytes = fixturePlanBuffer();
  writeFileSync(planPath, bytes);

  for (const venue of [
    'Plain ASCII Hall',
    'Caf\u00e9 Royal',
    'H\u00f4tel de Ville',
    'Marriott Marquis \u00b7 Grand Ballroom East',
    'M\u00fcnchen Messe',
  ]) {
    const doc = loadBuffer(bytes, planPath).document;
    const wrote = setPlanIdentity(doc, { venue, event: 'Show' });
    const read = planIdentity(doc);
    check(`"${venue}" round-trips through the trailer`, wrote.ok && read?.venue === venue, read ? read.venue : 'trailer unreadable');
  }

  // Characters the single-byte format cannot hold are substituted, not written
  // as the wrong bytes.
  const doc = loadBuffer(bytes, planPath).document;
  setPlanIdentity(doc, { venue: 'Hall \u2013 East \u2026 \u201cMain\u201d' });
  const swapped = planIdentity(doc)?.venue;
  check(
    'an en dash and smart quotes become their plain equivalents',
    swapped === 'Hall - East ... "Main"',
    swapped,
  );

  const doc2 = loadBuffer(bytes, planPath).document;
  setPlanIdentity(doc2, { venue: '\u5927\u5b8f Hall' });
  const cjk = planIdentity(doc2)?.venue;
  check('and an unrepresentable character becomes a question mark, readably', cjk === '?? Hall', cjk);

  rmSync(dir, { recursive: true, force: true });
}

console.log('\nthe summary line says something useful');
{
  check(
    'it names the client, venue, headcount and layout',
    describeBrief(fullBrief()) ===
      'Northwind Traders · Marriott Marquis · 850 people · General session',
    describeBrief(fullBrief()),
  );
  check('and is empty when nothing is known', describeBrief(emptyShowBrief('X')) === '');
}


console.log('\nkit recommendation reads the brief, not the kit name');
{
  const kits: KitCandidate[] = [
    { id: 'bundled:boardroom', name: 'Boardroom', source: 'bundled', chairs: 14,
      seatingKinds: ['schoolroom'], hasStage: false, extentFt: { width: 20, depth: 14 } },
    { id: 'bundled:banquet-200', name: 'Gala Dinner', source: 'bundled', chairs: 200,
      seatingKinds: ['round'], hasStage: false, extentFt: { width: 70, depth: 50 } },
    { id: 'bundled:session-220', name: 'Card Party South Florida', source: 'bundled', chairs: 220,
      seatingKinds: ['theatre'], hasStage: true, extentFt: { width: 70, depth: 55 } },
    { id: 'bundled:arena', name: 'Arena', source: 'bundled', chairs: 2200,
      seatingKinds: ['theatre'], hasStage: true, extentFt: { width: 240, depth: 128 } },
    { id: 'user:tuesday', name: 'Tuesday', source: 'user', chairs: 190,
      seatingKinds: ['round'], hasStage: false, extentFt: { width: 66, depth: 48 } },
  ];
  const room = { widthFt: 80, depthFt: 60 };

  const banquet = suggestKit(kits, { ...emptyShowBrief('Gala'), targetAttendance: 190, layoutType: 'banquet' }, room);
  check(
    'a banquet for 190 picks a rounds kit that seats about 190',
    banquet?.kitId === 'user:tuesday' || banquet?.kitId === 'bundled:banquet-200',
    `${banquet?.kitId} — ${banquet?.reason}`,
  );
  check('and says why', /round/.test(banquet?.reason ?? ''), banquet?.reason);

  const session = suggestKit(
    kits,
    { ...emptyShowBrief('Keynote'), targetAttendance: 200, layoutType: 'general-session', stageRequired: true },
    room,
  );
  check(
    'a general session with a stage picks the kit that builds one',
    session?.kitId === 'bundled:session-220',
    `${session?.kitId} — ${session?.reason}`,
  );
  check('and says it includes a stage', /stage/.test(session?.reason ?? ''), session?.reason);

  // The name-matching the old picker relied on must not decide anything: the
  // 220-seat kit is literally called "Card Party" and is a theatre bank.
  const rounds = suggestKit(
    kits,
    { ...emptyShowBrief('Dinner'), targetAttendance: 200, layoutType: 'banquet' },
    room,
  );
  check(
    'a banquet does not get the theatre kit merely because of its name',
    rounds?.kitId !== 'bundled:session-220',
    `${rounds?.kitId}`,
  );

  const tiny = suggestKit(kits, { ...emptyShowBrief('Board'), targetAttendance: 12, layoutType: 'classroom' }, { widthFt: 24, depthFt: 18 });
  check('a 12-person classroom picks the boardroom', tiny?.kitId === 'bundled:boardroom', `${tiny?.kitId}`);

  // The room is a real constraint, not decoration.
  const big = suggestKit(
    kits,
    { ...emptyShowBrief('Arena'), targetAttendance: 2000, layoutType: 'theatre' },
    { widthFt: 60, depthFt: 40 },
  );
  check(
    'a kit larger than the room is flagged oversize',
    big?.oversize === true,
    `${big?.kitId} oversize=${big?.oversize}`,
  );
  check('and says so', /larger than this room/.test(big?.reason ?? ''), big?.reason);

  const fits = suggestKit(
    kits,
    { ...emptyShowBrief('Arena'), targetAttendance: 2000, layoutType: 'theatre' },
    { widthFt: 260, depthFt: 140 },
  );
  check('the same kit in a room that holds it is not oversize', fits?.oversize === false, `${fits?.oversize}`);

  check('no kits means no suggestion', suggestKit([], emptyShowBrief('X'), room) === null);
  check(
    'nothing to go on means no suggestion rather than a guess',
    suggestKit(kits, emptyShowBrief('X'), {}) === null,
  );
}

console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed) process.exit(1);
