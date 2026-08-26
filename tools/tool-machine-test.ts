/**
 * The tool state machine: what the pointer will do with its next click.
 *
 * This replaces `tools/two-point-tool-test.ts` and `tools/placement-test.ts`,
 * and carries over everything they asserted. They tested two helpers hung off
 * thirteen parallel state cells in `App.tsx`; each helper correctly fixed the
 * one symptom it was written for, and the next bug came out of a pair of cells
 * nobody had guarded yet. The cells are gone. There is one value now, and these
 * are its rules.
 *
 * What the field taught us, in the order it hurt:
 *
 *   - Rebuilding a real 2,400-object sheet, 21 of 43 labels never made it onto
 *     the plan, and the ones that vanished were the repeats. Placing is a round
 *     trip through the main process, slow enough on that plan to arm the next
 *     label before the last reply lands; the reply then put the tool away
 *     underneath the operator. Armed label, dead click, no message.
 *
 *   - A clean run of 86 clicks became 57 dimensions instead of 43, joined by
 *     long diagonals between points never meant to pair, because the second
 *     click of a pair awaited IPC while reading its start point from the last
 *     committed render.
 *
 *   - The T button stayed lit forever, and a label re-armed on a keystroke
 *     drew rectangles while the banner promised a label.
 *
 *   npx tsx tools/tool-machine-test.ts
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  DIMENSION,
  HAND,
  MEASURE,
  SELECT,
  banner,
  choiceId,
  drawChoice,
  escapeAlsoClearsSelection,
  initialToolState,
  isPressed,
  labelChoice,
  opensProperties,
  pointerSpec,
  reduce,
  powerCableChoice,
  roomOutlineChoice,
  staysAfterUse,
  type Capability,
  type PendingEffect,
  type PlanPoint,
  type ToolChoice,
  type ToolEvent,
  type ToolState,
} from '../src/renderer/src/tool/machine.js';

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

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const EDITABLE: Capability = { open: true, editable: true };
const READ_ONLY: Capability = { open: true, editable: false };
const NOTHING_OPEN: Capability = { open: false, editable: false };

const GEAR: ToolChoice = { kind: 'stamp', stamp: { what: 'gear', description: '8× drape 12′' } };
const ITEM: ToolChoice = { kind: 'stamp', stamp: { what: 'inventory', id: 'inv-7', name: 'Riser 8×4' } };
const SEATING: ToolChoice = {
  kind: 'stamp',
  stamp: { what: 'seating', request: { kind: 'round', seats: 10 }, description: '72″ round with 10 seats' },
};

/** Every tool a control can name. */
const ALL_CHOICES: ToolChoice[] = [
  SELECT,
  HAND,
  drawChoice('line'),
  drawChoice('rect'),
  drawChoice('ellipse'),
  roomOutlineChoice,
  labelChoice('X4S'),
  MEASURE,
  DIMENSION,
  GEAR,
  ITEM,
  SEATING,
];

/** Applies a sequence, returning the final state and every effect minted. */
function play(
  start: ToolState,
  events: ToolEvent[],
): { state: ToolState; effects: PendingEffect[]; refusals: string[] } {
  let state = start;
  const effects: PendingEffect[] = [];
  const refusals: string[] = [];
  for (const event of events) {
    const next = reduce(state, event);
    state = next.state;
    if (next.effect) effects.push(next.effect);
    if (next.refusal) refusals.push(next.refusal);
  }
  return { state, effects, refusals };
}

// ---------------------------------------------------------------------------
console.log('1. the pairing rule\n');

/** Clicks are numbered; a correct pair joins 2k and 2k+1. */
const clickAt = (i: number): PlanPoint => ({ x: i * 100, y: i * 100 });
const indexOf = (p: PlanPoint): number => p.x / 100;

type Pair = { from: PlanPoint; to: PlanPoint };
const pairsOf = (effects: PendingEffect[]): Pair[] =>
  effects
    .filter((e) => e.do === 'draw' || e.do === 'addDimension' || e.do === 'showReadout')
    .map((e) => e as PendingEffect & Pair);

const misPaired = (pairs: Pair[]): Pair[] =>
  pairs.filter((d) => {
    const a = indexOf(d.from);
    const b = indexOf(d.to);
    return a % 2 !== 0 || b !== a + 1;
  });

{
  const run = play(
    reduce(initialToolState(EDITABLE), { type: 'pick', choice: DIMENSION }).state,
    Array.from({ length: 86 }, (_, i): ToolEvent => ({ type: 'click', at: clickAt(i) })),
  );
  const pairs = pairsOf(run.effects);
  check('86 clicks make 43 dimensions', pairs.length === 43, `made ${pairs.length}`);
  check('every pair joins the two clicks that were meant to pair', misPaired(pairs).length === 0);
  check(
    'nothing is left held at the end of an even run',
    run.state.tool.kind === 'span' && run.state.tool.from === null,
  );
  check(
    'the tool does not chain — an end point never becomes the next start',
    pairs.every((d, i) => !pairs[i + 1] || indexOf(d.to) !== indexOf(pairs[i + 1].from)),
  );
  check('and the tool is still in hand for the next pair', isPressed(run.state, DIMENSION));
}

{
  const traced = play(initialToolState(EDITABLE), [
    { type: 'pick', choice: roomOutlineChoice },
    { type: 'click', at: clickAt(0) },
    { type: 'click', at: clickAt(1) },
    { type: 'click', at: clickAt(2) },
    { type: 'click', at: clickAt(3) },
    { type: 'finish' },
  ]);
  check(
    'a freeform room waits for Finish before creating anything',
    traced.effects.length === 1 && traced.effects[0].do === 'createRoom',
  );
  check(
    'the room effect carries every clicked corner in order',
    traced.effects[0]?.do === 'createRoom' &&
      traced.effects[0].points.map(indexOf).join(',') === '0,1,2,3',
  );
  check(
    'a finished room is one-shot after its edit succeeds',
    reduce(traced.state, { type: 'settled', epoch: traced.state.epoch, ok: true }).state.tool.kind === 'select',
  );
}

{
  // clickAt points are 100 units (~10") apart; closing tolerance is 2 feet, so a
  // click within a few units of the first corner finishes the outline.
  const closed = play(initialToolState(EDITABLE), [
    { type: 'pick', choice: roomOutlineChoice },
    { type: 'click', at: clickAt(0) },
    { type: 'click', at: clickAt(1) },
    { type: 'click', at: clickAt(2) },
    { type: 'click', at: { x: clickAt(0).x + 2, y: clickAt(0).y - 1 } },
  ]);
  check(
    'clicking near the first corner closes a freeform room',
    closed.effects.length === 1 && closed.effects[0].do === 'createRoom',
  );
  check(
    'the closing click is not added as another corner',
    closed.effects[0]?.do === 'createRoom' && closed.effects[0].points.length === 3,
  );
}

/*
 * A cable run is not a room.
 *
 * The path tool draws both, and everything downstream assumed "room". Routing a
 * power run back past its own start — a return leg, which is most of what cable
 * routing is — fired `createRoom`, discarded the cable and built a room out of
 * it. Two feet is a normal gap between cable vertices, so it took no unusual
 * drawing to hit; the reported symptom was that cable points "operate weird and
 * not accurately".
 */
{
  const returned = play(initialToolState(EDITABLE), [
    { type: 'pick', choice: powerCableChoice },
    { type: 'click', at: clickAt(0) },
    { type: 'click', at: clickAt(1) },
    { type: 'click', at: clickAt(2) },
    { type: 'click', at: { x: clickAt(0).x + 2, y: clickAt(0).y - 1 } },
  ]);
  check(
    'a cable run passing its own start does not become a room',
    returned.effects.length === 0,
    returned.effects.map((e) => e.do).join(', '),
  );
  check(
    'and that click is kept as a cable point',
    returned.state.tool.kind === 'path' && returned.state.tool.points.length === 4,
    returned.state.tool.kind === 'path' ? String(returned.state.tool.points.length) : returned.state.tool.kind,
  );
  const finished = reduce(returned.state, { type: 'finish' });
  check(
    'and Finish places the cable, all four points',
    finished.effect?.do === 'placeCable' && finished.effect.points.length === 4,
    finished.effect?.do,
  );

  // The preview is the other half of the same confusion: a room previews the
  // floor it will enclose and the leg that closes it; a cable does neither.
  check(
    'a cable previews as an open path, not a room floor',
    pointerSpec(returned.state).preview === 'cable',
    String(pointerSpec(returned.state).preview),
  );
  const roomPath = play(initialToolState(EDITABLE), [
    { type: 'pick', choice: roomOutlineChoice },
    { type: 'click', at: clickAt(0) },
  ]);
  check(
    'and a room still previews as a room',
    pointerSpec(roomPath.state).preview === 'room',
    String(pointerSpec(roomPath.state).preview),
  );
}

{
  const twoCorners = play(initialToolState(EDITABLE), [
    { type: 'pick', choice: roomOutlineChoice },
    { type: 'click', at: clickAt(0) },
    { type: 'click', at: clickAt(1) },
  ]).state;
  const refused = reduce(twoCorners, { type: 'finish' });
  check('a room cannot close with fewer than three corners', !!refused.refusal && !refused.effect);
  const undone = reduce(twoCorners, { type: 'undo-point' }).state;
  check('Undo point removes only the latest room corner', undone.tool.kind === 'path' && undone.tool.points.length === 1);
  const escaped = reduce(undone, { type: 'escape' }).state;
  check('Escape also walks a custom outline back one point', escaped.tool.kind === 'path' && escaped.tool.points.length === 0);
  check('a second Escape cancels an empty room outline', reduce(escaped, { type: 'escape' }).state.tool.kind === 'select');
}

{
  const run = play(
    reduce(initialToolState(EDITABLE), { type: 'pick', choice: drawChoice('rect') }).state,
    Array.from({ length: 7 }, (_, i): ToolEvent => ({ type: 'click', at: clickAt(i) })),
  );
  const pairs = pairsOf(run.effects);
  check('an odd run makes floor(n/2) shapes', pairs.length === 3, `made ${pairs.length}`);
  check(
    'and holds the unpartnered click rather than inventing a partner for it',
    run.state.tool.kind === 'span' && !!run.state.tool.from && indexOf(run.state.tool.from) === 6,
  );
}

{
  // The held point belongs to the span holding it, so it cannot be read for a
  // different tool. Swapping tools mid-pair abandons the half-made shape.
  const run = play(reduce(initialToolState(EDITABLE), { type: 'pick', choice: DIMENSION }).state, [
    { type: 'click', at: clickAt(0) },
    { type: 'pick', choice: drawChoice('rect') },
    { type: 'click', at: clickAt(1) },
  ]);
  check(
    'changing tools mid-pair abandons the half-made span rather than finishing it',
    run.effects.length === 0 && run.state.tool.kind === 'span' && run.state.tool.from !== null,
  );
}

// ---------------------------------------------------------------------------
console.log('\n2. clicks arriving while the previous edit is still in flight\n');

/**
 * Two models of the click loop, on a virtual clock.
 *
 * `machine` drives the real `reduce`, settling each effect after an IPC delay
 * and committing the mirrored render state a frame later.
 *
 * `committed` reproduces what the component used to do: the canvas called the
 * handler from the last *committed* render, so the start point it read was
 * stale for as long as the IPC call was pending, and it was only cleared
 * afterwards. It is kept as the regression witness — evidence that the test
 * above discriminates rather than merely restating the pairing rule.
 */
function runLoop(
  strategy: 'machine' | 'committed',
  clicks: number,
  gap: number,
  ipc: number,
  commit: number,
): Pair[] {
  type Job = { at: number; seq: number; run: () => void };
  const jobs: (Job | undefined)[] = [];
  let seq = 0;
  const at = (time: number, run: () => void): void => {
    jobs.push({ at: time, seq: seq++, run });
  };

  const pairs: Pair[] = [];
  let committed: PlanPoint | null = null;
  let state = reduce(initialToolState(EDITABLE), { type: 'pick', choice: DIMENSION }).state;

  for (let i = 0; i < clicks; i++) {
    const t = i * gap;
    at(t, () => {
      const point = clickAt(i);
      if (strategy === 'machine') {
        const next = reduce(state, { type: 'click', at: point });
        state = next.state;
        const effect = next.effect;
        if (effect) {
          at(t + ipc, () => {
            pairs.push(effect as PendingEffect & Pair);
            state = reduce(state, { type: 'settled', epoch: effect.epoch, ok: true }).state;
          });
        }
        return;
      }
      const from = committed;
      if (!from) {
        at(t + commit, () => {
          committed = point;
        });
        return;
      }
      at(t + ipc, () => {
        pairs.push({ from, to: point });
        at(t + ipc + commit, () => {
          committed = null;
        });
      });
    });
  }

  for (;;) {
    let best = -1;
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      if (!job) continue;
      const bestJob = best < 0 ? null : jobs[best];
      if (!bestJob || job.at < bestJob.at || (job.at === bestJob.at && job.seq < bestJob.seq)) best = i;
    }
    if (best < 0) break;
    const job = jobs[best]!;
    jobs[best] = undefined;
    job.run();
  }
  return pairs;
}

const timings: [number, number][] = [
  [10, 20],
  [20, 40],
  [30, 40],
  [50, 40],
  [80, 40],
  [10, 120],
  [30, 120],
  [80, 120],
  [200, 20],
];

{
  let worstCount = 43;
  let worstMis = 0;
  for (const [gap, ipc] of timings) {
    const pairs = runLoop('machine', 86, gap, ipc, 4);
    worstCount = Math.max(worstCount, pairs.length);
    worstMis = Math.max(worstMis, misPaired(pairs).length);
  }
  check(
    'a held start point survives every click rate, from faster than the edit to slower',
    worstCount === 43 && worstMis === 0,
    `worst run made ${worstCount} pairs, ${worstMis} mis-paired`,
  );
}

{
  const inflated = timings.filter(([gap, ipc]) => runLoop('committed', 86, gap, ipc, 4).length > 43);
  const crossed = timings.filter(([gap, ipc]) => misPaired(runLoop('committed', 86, gap, ipc, 4)).length > 0);
  check(
    'deciding the pair from rendered state draws more dimensions than there are pairs',
    inflated.length > 0,
    'the regression witness no longer reproduces',
  );
  check('and joins points that were never meant to pair', crossed.length > 0);
  // A frame to commit a render, a 40ms round trip on a 2,400-object plan, and
  // a click every 50ms. This is a MODEL of the old loop, not the component, and
  // its exact output moves with the commit latency fed to it — so it is not
  // evidence for any particular count in the real app. What it does show is the
  // shape of the failure.
  const observed = runLoop('committed', 86, 50, 40, 16);
  check(
    'and at plausible timings invents dimensions no pair of clicks asked for',
    observed.length > 43,
    `made ${observed.length} from 86 clicks`,
  );
  check('nearly all of which join the wrong two points', misPaired(observed).length > 30);
}

// ---------------------------------------------------------------------------
console.log('\n3. a reply that lands late keeps its hands off a newer tool\n');

{
  // Every stamp and every span, not just the one kind that was observed to
  // break. `armGeneration` guarded seating alone; the epoch guard is in the
  // machine, so no future async path can be added without it.
  let clean = true;
  const detail: string[] = [];
  for (const choice of ALL_CHOICES) {
    if (choice.kind === 'select' || choice.kind === 'hand') continue;
    const armed = reduce(initialToolState(EDITABLE), { type: 'pick', choice }).state;
    const staleEpoch = armed.epoch;
    // The operator picks up the next thing while the reply is in flight.
    const newer = reduce(armed, { type: 'pick', choice: labelChoice('X4S') }).state;
    const after = reduce(newer, { type: 'settled', epoch: staleEpoch, ok: true }).state;
    if (!isPressed(after, labelChoice('X4S')) || after.epoch !== newer.epoch) {
      clean = false;
      detail.push(choiceId(choice));
    }
  }
  check(
    'a superseded reply never disturbs whatever is in hand now',
    clean,
    detail.length ? `disturbed by: ${detail.join(', ')}` : undefined,
  );
}

{
  const armed = reduce(initialToolState(EDITABLE), { type: 'pick', choice: SEATING }).state;
  const after = reduce(armed, { type: 'settled', epoch: armed.epoch, ok: true }).state;
  check('seating stays in hand so sixteen banks is sixteen clicks', isPressed(after, SEATING));
  check('completed room outlines are deliberately one-shot',
    !staysAfterUse(reduce(initialToolState(EDITABLE), { type: 'pick', choice: roomOutlineChoice }).state.tool));
}

{
  const armed = reduce(initialToolState(EDITABLE), { type: 'pick', choice: labelChoice('X4S') }).state;
  const after = reduce(armed, { type: 'settled', epoch: armed.epoch, ok: true }).state;
  check('a label stays in hand, so ten X4S is ten clicks', isPressed(after, labelChoice('X4S')));
}

for (const choice of [GEAR, ITEM, MEASURE, DIMENSION, drawChoice('rect')]) {
  const armed = reduce(initialToolState(EDITABLE), { type: 'pick', choice }).state;
  const after = reduce(armed, { type: 'settled', epoch: armed.epoch, ok: true }).state;
  check(`${choiceId(choice)} stays in hand for a run`, isPressed(after, choice));
}

{
  const armed = reduce(initialToolState(EDITABLE), { type: 'pick', choice: SEATING }).state;
  const after = reduce(armed, { type: 'settled', epoch: armed.epoch, ok: false }).state;
  check(
    'a refused drop leaves the block in hand so it can be tried again',
    isPressed(after, SEATING),
  );
}

// ---------------------------------------------------------------------------
console.log('\n4. one tool at a time, structurally\n');

{
  // The bug this encodes: picking a draw tool cleared `armed` but not
  // `armedAnnotation`, so T read pressed forever and a keystroke could re-arm
  // the label on top of a live draw tool.
  let clean = true;
  const detail: string[] = [];
  for (const a of ALL_CHOICES) {
    for (const b of ALL_CHOICES) {
      const state = play(initialToolState(EDITABLE), [
        { type: 'pick', choice: a },
        { type: 'pick', choice: b },
      ]).state;
      const on = ALL_CHOICES.filter((c) => isPressed(state, c));
      if (on.length !== 1 || choiceId(on[0]) !== choiceId(b)) {
        clean = false;
        detail.push(`${choiceId(a)} → ${choiceId(b)} left ${on.map(choiceId).join('+') || 'nothing'} on`);
      }
    }
  }
  check(
    'after any two picks, exactly the second tool reads as pressed',
    clean,
    detail.slice(0, 4).join('; '),
  );
}

{
  // The literal reproduction of the two known-unfixed bugs, in order.
  const run = play(initialToolState(EDITABLE), [
    { type: 'pick', choice: labelChoice('X4S') },
    { type: 'pick', choice: drawChoice('rect') },
    { type: 'retext', text: 'X4S' },
    { type: 'click', at: clickAt(0) },
    { type: 'click', at: clickAt(1) },
  ]);
  check(
    'label then rectangle: the T button goes out',
    !isPressed(run.state, labelChoice('X4S')),
  );
  check('typing in the label field does not steal the draw tool', isPressed(run.state, drawChoice('rect')));
  check(
    'and two clicks draw one rectangle, placing no label',
    run.effects.length === 1 && run.effects[0].do === 'draw' && run.effects[0].shape === 'rect',
    run.effects.map((e) => e.do).join(', '),
  );
}

{
  const armed = reduce(initialToolState(EDITABLE), { type: 'pick', choice: labelChoice('X4S') }).state;
  const off = reduce(armed, { type: 'toggle', choice: labelChoice('X4S') }).state;
  check('T is a real toggle — pressing it again puts the label down', off.tool.kind === 'select');
  check(
    'and toggling a tool that is not in hand picks it up',
    isPressed(reduce(off, { type: 'toggle', choice: MEASURE }).state, MEASURE),
  );
  check(
    'the label button ignores the text when deciding whether it is pressed',
    isPressed(armed, labelChoice('anything else')),
  );
}

{
  const labelColor = 0x0055aa;
  const armed = reduce(initialToolState(EDITABLE), { type: 'pick', choice: labelChoice('X4S', labelColor) }).state;
  const retyped = reduce(armed, { type: 'retext', text: '  Stage left  ' }).state;
  check(
    'retyping while the label is in hand follows the field and keeps its color',
    retyped.tool.kind === 'stamp' &&
      retyped.tool.stamp.what === 'label' &&
      retyped.tool.stamp.text === 'Stage left' &&
      retyped.tool.stamp.color === labelColor,
  );
  check('emptying the field puts the label down', reduce(armed, { type: 'retext', text: '   ' }).state.tool.kind === 'select');
  for (const choice of [MEASURE, DIMENSION, drawChoice('line'), GEAR, SELECT]) {
    const other = reduce(initialToolState(EDITABLE), { type: 'pick', choice }).state;
    check(
      `typing does not disturb ${choiceId(choice)}`,
      reduce(other, { type: 'retext', text: 'X4S' }).state === other,
    );
  }
}

// ---------------------------------------------------------------------------
console.log('\n5. the escape ladder\n');

{
  const half = play(initialToolState(EDITABLE), [
    { type: 'pick', choice: DIMENSION },
    { type: 'click', at: clickAt(0) },
  ]).state;
  const once = reduce(half, { type: 'escape' }).state;
  check(
    'the first Escape abandons a half-made span but keeps the tool',
    isPressed(once, DIMENSION) && once.tool.kind === 'span' && once.tool.from === null,
  );
  check('the second puts it down', reduce(once, { type: 'escape' }).state.tool.kind === 'select');
}

for (const choice of ALL_CHOICES) {
  if (choice.kind === 'select') continue;
  const armed = reduce(initialToolState(EDITABLE), { type: 'pick', choice }).state;
  check(
    `Escape puts ${choiceId(choice)} down`,
    reduce(armed, { type: 'escape' }).state.tool.kind === 'select',
  );
}

{
  const idle = initialToolState(EDITABLE);
  check('with nothing in hand, Escape is about the selection', escapeAlsoClearsSelection(idle));
  check('and never while a tool is in hand', !ALL_CHOICES.some(
    (c) => c.kind !== 'select' && escapeAlsoClearsSelection(reduce(idle, { type: 'pick', choice: c }).state),
  ));
  check('Escape with nothing in hand changes nothing', reduce(idle, { type: 'escape' }).state === idle);
}

// ---------------------------------------------------------------------------
console.log('\n6. reset, and what the document permits\n');

{
  // Opening a plan or leaving the Plan workspace used to clear the armed cells
  // but not `drawTool`/`drawFrom`, so a draw tool survived against a document
  // that no longer existed.
  let clean = true;
  for (const choice of ALL_CHOICES) {
    const armed = play(initialToolState(EDITABLE), [
      { type: 'pick', choice },
      { type: 'click', at: clickAt(0) },
    ]).state;
    const after = reduce(armed, { type: 'reset' }).state;
    if (after.tool.kind !== 'select' || after.readout !== null || after.epoch <= armed.epoch) clean = false;
  }
  check('reset lands on Select from every state, with a bumped epoch and no readout', clean);
}

{
  const refused = reduce(initialToolState(READ_ONLY), { type: 'pick', choice: DIMENSION });
  check('a read-only plan refuses the dimension tool, with a reason', !!refused.refusal);
  check('and does not arm it silently to fail later at the IPC boundary', refused.state.tool.kind === 'select');
  check(
    'but Measure still works on a read-only plan',
    isPressed(reduce(initialToolState(READ_ONLY), { type: 'pick', choice: MEASURE }).state, MEASURE),
  );
  check(
    'with no plan open nothing but Select and Hand can be picked up',
    ALL_CHOICES.filter((c) => !reduce(initialToolState(NOTHING_OPEN), { type: 'pick', choice: c }).refusal)
      .map(choiceId)
      .join(',') === 'select,hand',
  );
  check(
    'an empty label cannot be armed',
    !!reduce(initialToolState(EDITABLE), { type: 'pick', choice: labelChoice('   ') }).refusal,
  );
  // Annotation is available in every editable plan. Gating it on
  // `annotationCapabilities` — false on any plan drawn from scratch — made the
  // label field and both dimension buttons permanently unusable, a deadlock the
  // dimension tool could never unlock itself from.
  check(
    'a from-scratch editable plan can label and dimension',
    !reduce(initialToolState(EDITABLE), { type: 'pick', choice: labelChoice('X4S') }).refusal &&
      !reduce(initialToolState(EDITABLE), { type: 'pick', choice: DIMENSION }).refusal,
  );
}

{
  const armed = reduce(initialToolState(EDITABLE), { type: 'pick', choice: drawChoice('rect') }).state;
  const locked = reduce(armed, { type: 'capability', can: READ_ONLY }).state;
  check('a plan turning read-only puts an editing tool down', locked.tool.kind === 'select');
  const measuring = reduce(initialToolState(EDITABLE), { type: 'pick', choice: MEASURE }).state;
  check(
    'and leaves Measure alone',
    isPressed(reduce(measuring, { type: 'capability', can: READ_ONLY }).state, MEASURE),
  );
}

// ---------------------------------------------------------------------------
console.log('\n7. the inspector follows the operator, not the placement\n');

{
  const idle = initialToolState(EDITABLE);
  check('clicking an object opens its properties', opensProperties(1, idle));
  check('a band-selection opens properties too', opensProperties(12, idle));
  check('and nothing selected changes nothing', !opensProperties(0, idle));
  let clean = true;
  for (const choice of ALL_CHOICES) {
    if (choice.kind === 'select') continue;
    if (opensProperties(1, reduce(idle, { type: 'pick', choice }).state)) clean = false;
  }
  // The old rule tested "is a stamp armed", so drawing a rectangle still
  // yanked the panel away and unmounted the field being typed into.
  check('no tool in hand — stamp or span — ever yanks the create panel away', clean);
}

// ---------------------------------------------------------------------------
console.log('\n8. how the canvas reads the next click\n');

{
  const spec = (choice: ToolChoice) => pointerSpec(reduce(initialToolState(EDITABLE), { type: 'pick', choice }).state);
  check('Select selects', spec(SELECT).mode === 'select');
  check('Hand pans', spec(HAND).mode === 'pan');
  check(
    'a stamp stamps, snapped to the grid, associating with nothing',
    spec(GEAR).mode === 'stamp' && spec(GEAR).snap === 'grid' && !spec(GEAR).associate,
  );
  // Inherited from PlanCanvas rather than designed here: a measurement should
  // report what is actually there, so it does not grid-snap; a dimension does.
  // Both hit-test the raw click so an endpoint can follow the object it was
  // placed on. Pinned as behaviour, not doctrine.
  check('Measure does not grid-snap', spec(MEASURE).snap === 'none' && spec(MEASURE).associate);
  check('Dimension does grid-snap', spec(DIMENSION).snap === 'grid' && spec(DIMENSION).associate);
  check(
    'the draw tools share the dimension interaction',
    (['line', 'rect', 'ellipse'] as const).every(
      (s) => spec(drawChoice(s)).snap === 'grid' && spec(drawChoice(s)).associate && spec(drawChoice(s)).preview === s,
    ),
  );
  check(
    'a custom room collects snapped corners without associating to objects',
    spec(roomOutlineChoice).mode === 'path' &&
      spec(roomOutlineChoice).snap === 'grid' &&
      !spec(roomOutlineChoice).associate &&
      spec(roomOutlineChoice).preview === 'room',
  );
  check('a measure preview rubber-bands a measurement', spec(MEASURE).preview === 'measure');
  check('and nothing else previews anything', spec(SELECT).preview === 'none' && spec(GEAR).preview === 'none');
}

{
  // The parity the canvas publishes: after every click it must flip. A run that
  // does not flip it has had a click taken from it by something over the sheet.
  const armed = reduce(initialToolState(EDITABLE), { type: 'pick', choice: DIMENSION }).state;
  const half = reduce(armed, { type: 'click', at: clickAt(0) }).state;
  check('the next click of an empty span starts a pair', pointerSpec(armed).parity === 'start');
  check('and of a half-made span ends one', pointerSpec(half).parity === 'end');
  check('nothing else publishes a parity', pointerSpec(initialToolState(EDITABLE)).parity === undefined);
}

// ---------------------------------------------------------------------------
console.log('\n9. one banner, saying one thing\n');

{
  check('Select shows no banner', banner(initialToolState(EDITABLE)) === null);
  const stamp = banner(reduce(initialToolState(EDITABLE), { type: 'pick', choice: GEAR }).state);
  check('a stamp names what is in hand', stamp?.emphasis === '8× drape 12′');
  const measure = reduce(initialToolState(EDITABLE), { type: 'pick', choice: MEASURE }).state;
  check('Measure is badged temporary', banner(measure)?.badge?.tone === 'temporary');
  check('Dimension is badged persistent', banner(reduce(measure, { type: 'pick', choice: DIMENSION }).state)?.badge?.tone === 'persistent');
  const withReadout = play(measure, [
    { type: 'click', at: clickAt(0) },
    { type: 'click', at: clickAt(1) },
  ]).state;
  check('a finished measurement can be kept', banner(withReadout)?.actions.some((a) => a.id === 'save-dimension') === true);
  check('and the readout survives until the tool is put down', withReadout.readout !== null);
  check(
    'putting the tool down takes the readout with it',
    reduce(reduce(withReadout, { type: 'escape' }).state, { type: 'escape' }).state.readout === null,
  );
  check(
    'every banner offers a way out',
    ALL_CHOICES.filter((c) => c.kind !== 'select' && c.kind !== 'hand').every((c) => {
      const b = banner(reduce(initialToolState(EDITABLE), { type: 'pick', choice: c }).state);
      return !!b && b.actions.some((a) => a.id === 'done');
    }),
  );
}

// ---------------------------------------------------------------------------
console.log('\n10. the machine is total, and never leaks a start point\n');

{
  // Every (state kind × event type) must return a state. A machine that throws
  // or returns undefined on an unexpected pairing is how ordering became a
  // matter of luck in the first place.
  const seeds: ToolState[] = [
    initialToolState(EDITABLE),
    initialToolState(READ_ONLY),
    ...ALL_CHOICES.map((c) => reduce(initialToolState(EDITABLE), { type: 'pick', choice: c }).state),
    play(initialToolState(EDITABLE), [
      { type: 'pick', choice: DIMENSION },
      { type: 'click', at: clickAt(0) },
    ]).state,
  ];
  const events: ToolEvent[] = [
    { type: 'pick', choice: SELECT },
    { type: 'toggle', choice: MEASURE },
    { type: 'click', at: clickAt(3) },
    { type: 'finish' },
    { type: 'undo-point' },
    { type: 'escape' },
    { type: 'retext', text: 'X4S' },
    { type: 'reset' },
    { type: 'capability', can: READ_ONLY },
    { type: 'settled', epoch: 0, ok: true },
    { type: 'settled', epoch: 999, ok: false },
  ];
  let total = true;
  for (const seed of seeds) {
    for (const event of events) {
      const next = reduce(seed, event);
      if (!next || !next.state || !['select', 'hand', 'stamp', 'span', 'path'].includes(next.state.tool.kind)) {
        total = false;
      }
    }
  }
  check('every state accepts every event and answers with a state', total);
}

{
  // A fuzz over random sequences. Two things must hold no matter the order:
  // a held start point is only ever reachable from the span holding it, and one
  // held point yields at most one effect.
  let seed = 20260731;
  const rand = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  let starts = 0;
  let spans = 0;
  let leaked = false;
  let state = initialToolState(EDITABLE);
  for (let i = 0; i < 40000; i++) {
    const roll = rand(10);
    const event: ToolEvent =
      roll < 4
        ? { type: 'click', at: clickAt(rand(8)) }
        : roll === 4
          ? { type: 'pick', choice: ALL_CHOICES[rand(ALL_CHOICES.length)] }
          : roll === 5
            ? { type: 'toggle', choice: ALL_CHOICES[rand(ALL_CHOICES.length)] }
            : roll === 6
              ? { type: 'escape' }
              : roll === 7
                ? { type: 'retext', text: rand(2) ? 'X4S' : '' }
                : roll === 8
                  ? { type: 'settled', epoch: rand(2) ? state.epoch : rand(50), ok: rand(2) === 0 }
                  : { type: 'capability', can: rand(2) ? EDITABLE : READ_ONLY };
    const before = state.tool.kind === 'span' ? state.tool.from : null;
    const next = reduce(state, event);
    const after = next.state.tool.kind === 'span' ? next.state.tool.from : null;
    if (!before && after) starts++;
    if (next.effect && (next.effect.do === 'draw' || next.effect.do === 'addDimension' || next.effect.do === 'showReadout')) {
      spans++;
    }
    // A start point can only exist on the span that took it.
    if (next.state.tool.kind !== 'span' && after) leaked = true;
    state = next.state;
  }
  check('a held start point never outlives the span holding it', !leaked);
  check(
    'and one held point never yields two spans',
    spans <= starts,
    `${spans} spans from ${starts} start points`,
  );
  check('the fuzz actually exercised the span tools', spans > 250, `only ${spans} spans`);
}

// ---------------------------------------------------------------------------
console.log('\n11. the parallel state cannot grow back\n');

{
  // Comments hold no braces, so they would otherwise be swept into the selector
  // list of whatever rule follows them.
  const css = readFileSync(join(root, 'src/renderer/src/styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  /**
   * The declaration block of the top-level rule whose selector list contains an
   * exact selector, so a grouped rule counts the same as a single one.
   */
  function ruleFor(selector: string): string | null {
    for (const match of css.matchAll(/(^|\n)([^{}@\n][^{}]*)\{([^}]*)\}/g)) {
      const selectors = match[2].split(',').map((s) => s.trim().replace(/\s+/g, ' '));
      if (selectors.includes(selector)) return match[3];
    }
    return null;
  }

  /**
   * Overlays that float over the plan canvas and exist only to be read. While
   * they took pointer input, a click that landed on one never reached the
   * canvas, and the parity of every pair after it was wrong.
   */
  for (const selector of ['.toast', '.arming']) {
    const rule = ruleFor(selector);
    check(
      `${selector} is styled`,
      rule !== null,
      'the selector moved; this guard needs updating rather than deleting',
    );
    check(
      `${selector} lets clicks through to the drawing`,
      !!rule && /pointer-events:\s*none/.test(rule),
      'an informational overlay over the canvas swallows the clicks that land on it',
    );
  }

  for (const selector of ['.toast button', '.arming button']) {
    check(
      `${selector} is still clickable`,
      /pointer-events:\s*auto/.test(ruleFor(selector) ?? ''),
      'the container opted out of pointer input and its own controls did not opt back in',
    );
  }
}

{
  const canvas = readFileSync(join(root, 'src/renderer/src/PlanCanvas.tsx'), 'utf8');
  check(
    'the canvas publishes the two-point parity for the next click',
    /data-two-point=/.test(canvas) && /'end'/.test(canvas) && /'start'/.test(canvas),
  );

  const app = readFileSync(join(root, 'src/renderer/src/App.tsx'), 'utf8');
  const parallel = [
    'armed',
    'armedItem',
    'armedSeating',
    'armedAnnotation',
    'measuring',
    'measureFrom',
    'measurement',
    'dimensioning',
    'dimensionFrom',
    'drawTool',
    'drawFrom',
    'handTool',
  ];
  const regrown = parallel.filter((name) =>
    new RegExp(`\\b(?:const|let)\\s*\\[\\s*${name}\\s*,`).test(app) ||
    new RegExp(`\\bconst\\s+${name}\\s*=\\s*use(?:State|Ref)\\b`).test(app),
  );
  check(
    'App declares none of the thirteen cells the machine replaced',
    regrown.length === 0,
    regrown.length ? `back: ${regrown.join(', ')}` : undefined,
  );
  const canvasCells = ['handTool'].filter((name) =>
    new RegExp(`\\b(?:const|let)\\s*\\[\\s*${name}\\s*,`).test(canvas),
  );
  check(
    'and the canvas no longer keeps a tool of its own',
    canvasCells.length === 0,
    canvasCells.join(', '),
  );
  check(
    'Space stays a transient canvas-local modifier, not part of the tool',
    /spaceHeld/.test(canvas) && !/spaceHeld/.test(app),
  );
}

for (const gone of ['src/renderer/src/placement.ts', 'src/renderer/src/two-point.ts']) {
  check(`${gone} is deleted, not left behind to drift`, !existsSync(join(root, gone)));
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
else console.log('no failures');
