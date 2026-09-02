/**
 * The workspace state machine.
 *
 * These are the rules that used to live as 135 scattered `setSomethingOpen`
 * calls, which is why they were never all true at once. The point of the tests
 * is not that a reducer returns an object — it is the invariants: exactly one
 * mode owns the screen, an overlay only survives where it is allowed, Escape
 * unwinds in one predictable order, and nothing can leave a panel behind.
 *
 *   npx tsx tools/workspace-test.ts
 */

import {
  INITIAL_WORKSPACE,
  MODE_STRIP,
  OVERLAYS,
  escapeConsumed,
  isContentLayer,
  landingModeFor,
  overlayAllowedIn,
  resolveLanding,
  panelsFor,
  workspaceReducer,
  workspaceStatus,
  type Overlay,
  type WorkspaceAction,
  type WorkspaceMode,
  type WorkspaceState,
} from '../src/renderer/src/workspace.js';

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

const ALL_MODES: WorkspaceMode[] = ['browse', 'place', 'inspect', 'setup', 'draw', 'room-layout', 'canvas'];
const run = (state: WorkspaceState, ...actions: WorkspaceAction[]) =>
  actions.reduce(workspaceReducer, state);
const enter = (mode: WorkspaceMode) => run(INITIAL_WORKSPACE, { type: 'enter', mode });

// ---------------------------------------------------------------------------
// Canvas with independent surrounding surfaces
// ---------------------------------------------------------------------------

check('default workspace opens the inspector beside the canvas', (() => {
  const p = panelsFor(INITIAL_WORKSPACE);
  return p.inspectorOpen && p.inspectorVisible && !p.railOpen;
})());

check('place keeps the inspector visible', (() => {
  const p = panelsFor(enter('place'));
  return p.railOpen && p.railSource === 'equipment' && p.inspectorVisible;
})());

check('focus plan hides every surrounding surface', (() => {
  const p = panelsFor(run(enter('place'), { type: 'focus-plan' }));
  return !p.railOpen && !p.inspectorOpen && !p.toolDockOpen && !p.createDialogOpen && p.fullCanvas;
})());

check('place shows the equipment rail', (() => {
  const p = panelsFor(enter('place'));
  return p.railOpen && p.railSource === 'equipment';
})());

check('browse shows the browse rail, not equipment', (() => {
  const p = panelsFor(enter('browse'));
  return p.railOpen && p.railSource === 'recent';
})());

// Browse's list choice is sub-state, so switching to Place and back must not
// silently reset a user who was looking at a folder.
check('browse remembers its list across a trip through place', (() => {
  const state = run(INITIAL_WORKSPACE,
    { type: 'enter', mode: 'browse' },
    { type: 'browse-source', source: 'folder' },
    { type: 'enter', mode: 'place' },
    { type: 'enter', mode: 'browse' });
  return panelsFor(state).railSource === 'folder';
})());

check('every mode-strip entry is a real mode', MODE_STRIP.every((m) => ALL_MODES.includes(m)));
check('the exclusive room workspace is not in the mode strip', !MODE_STRIP.includes('room-layout'));
check('every mode has a status line', ALL_MODES.every((m) => workspaceStatus(enter(m)).length > 0));

// ---------------------------------------------------------------------------
// Toggling
// ---------------------------------------------------------------------------

check('toggling draw closes only the draw surface', (() => {
  const state = run(INITIAL_WORKSPACE, { type: 'enter', mode: 'draw' }, { type: 'toggle-mode', mode: 'draw' });
  return !state.drawDockOpen && state.inspectorOpen;
})());

check('toggling a different mode enters it', (() => {
  const state = run(INITIAL_WORKSPACE, { type: 'enter', mode: 'draw' }, { type: 'toggle-mode', mode: 'place' });
  return state.mode === 'place';
})());

check('entering place twice remains stable', (() => {
  const before = enter('place');
  const after = workspaceReducer(before, { type: 'enter', mode: 'place' });
  return after.left === 'assets' && after.inspectorOpen;
})());

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

// The behaviour the review flagged as hand-wired: wall edit is supposed to stay
// on while Place is open. Here it is a table entry, not twelve call sites.
check('wall edit survives a move to place', (() => {
  const state = run(INITIAL_WORKSPACE,
    { type: 'open-overlay', overlay: 'wall-edit' },
    { type: 'enter', mode: 'place' });
  const p = panelsFor(state);
  return p.wallEditLive && p.railOpen;
})());

check('wall edit survives a move to inspect', (() => {
  const state = run(INITIAL_WORKSPACE,
    { type: 'open-overlay', overlay: 'wall-edit' },
    { type: 'enter', mode: 'inspect' });
  return panelsFor(state).wallEditLive;
})());

check('wall edit survives the setup surface', (() => {
  const state = run(INITIAL_WORKSPACE,
    { type: 'open-overlay', overlay: 'wall-edit' },
    { type: 'enter', mode: 'setup' });
  return panelsFor(state).wallEditLive && panelsFor(state).createDialogOpen;
})());

check('the room workspace lights the wall handles without the overlay', (() => {
  const p = panelsFor(enter('room-layout'));
  return p.wallEditLive && p.refineRoomOpen;
})());

check('seating can open without closing setup', (() => {
  const state = run(INITIAL_WORKSPACE,
    { type: 'enter', mode: 'setup' },
    { type: 'open-overlay', overlay: 'seating' });
  return state.setupOpen && panelsFor(state).seatingOpen;
})());

check('opening an overlay twice does not stack it', (() => {
  const state = run(INITIAL_WORKSPACE,
    { type: 'open-overlay', overlay: 'calculator' },
    { type: 'open-overlay', overlay: 'calculator' });
  return state.overlays.length === 1;
})());

check('toggle-overlay is open then close', (() => {
  const opened = workspaceReducer(INITIAL_WORKSPACE, { type: 'toggle-overlay', overlay: 'seating' });
  const closed = workspaceReducer(opened, { type: 'toggle-overlay', overlay: 'seating' });
  return panelsFor(opened).seatingOpen && !panelsFor(closed).seatingOpen;
})());

// Every overlay must be reachable from somewhere, or it is dead UI.
check('every overlay is allowed in at least one mode',
  OVERLAYS.every((o: Overlay) => ALL_MODES.some((m) => overlayAllowedIn(o, m))));

// ---------------------------------------------------------------------------
// Escape
// ---------------------------------------------------------------------------

check('escape closes the newest overlay first', (() => {
  const state = run(INITIAL_WORKSPACE,
    { type: 'open-overlay', overlay: 'wall-edit' },
    { type: 'open-overlay', overlay: 'calculator' },
    { type: 'escape' });
  return !panelsFor(state).calculatorOpen && panelsFor(state).wallEditLive;
})());

check('escape then unwinds draw but keeps the inspector', (() => {
  const state = run(INITIAL_WORKSPACE,
    { type: 'enter', mode: 'draw' },
    { type: 'open-overlay', overlay: 'calculator' },
    { type: 'escape' },
    { type: 'escape' });
  return !state.drawDockOpen && state.inspectorOpen && state.overlays.length === 0;
})());

check('escape on a bare canvas is a no-op reference', (() => {
  const state = enter('canvas');
  return workspaceReducer(state, { type: 'escape' }) === state;
})());

check('escapeConsumed agrees with what escape does', ALL_MODES.every((mode) => {
  const state = enter(mode);
  const after = workspaceReducer(state, { type: 'escape' });
  return escapeConsumed(state) === (after !== state);
}));

// Escape terminates with the persistent inspector; Focus Plan hides it.
let stuck: string | null = null;
for (const mode of ALL_MODES) {
  for (const overlay of OVERLAYS) {
    let state = run(INITIAL_WORKSPACE, { type: 'enter', mode }, { type: 'open-overlay', overlay });
    for (let i = 0; i < 8 && escapeConsumed(state); i++) state = workspaceReducer(state, { type: 'escape' });
    if (escapeConsumed(state)) stuck = `${mode}+${overlay} → ${JSON.stringify(state)}`;
  }
}
check('escape always reaches the persistent canvas state', stuck === null, stuck);

// ---------------------------------------------------------------------------
// The room workspace's return path
// ---------------------------------------------------------------------------

// This replaces a pair of functions that stashed panel booleans in a ref on the
// way in and restored them on the way out. Any exit path that forgot to call
// the restore leaked the stash; here the target is part of the state.
check('leaving the room workspace returns where you came from', (() => {
  const state = run(INITIAL_WORKSPACE,
    { type: 'enter', mode: 'place' },
    { type: 'enter', mode: 'room-layout' },
    { type: 'escape' });
  return state.mode === 'place';
})());

check('the room workspace never returns to itself', (() => {
  const state = run(INITIAL_WORKSPACE,
    { type: 'enter', mode: 'room-layout' },
    { type: 'enter', mode: 'room-layout' },
    { type: 'escape' });
  return state.mode !== 'room-layout';
})());

check('entering the room workspace resets its focus', (() => {
  const state = run(INITIAL_WORKSPACE,
    { type: 'room-focus', focus: 'walls' },
    { type: 'enter', mode: 'room-layout' });
  return state.roomFocus === 'room';
})());

// ---------------------------------------------------------------------------
// Nothing gets left behind
// ---------------------------------------------------------------------------

// A random walk over every action, asserting the invariants hold at each step.
// The old design could not be checked this way at all: there was no state to
// walk, only flags that happened to be set.
const actions: WorkspaceAction[] = [
  ...ALL_MODES.map((mode) => ({ type: 'enter', mode }) as WorkspaceAction),
  ...ALL_MODES.map((mode) => ({ type: 'toggle-mode', mode }) as WorkspaceAction),
  ...OVERLAYS.map((overlay) => ({ type: 'toggle-overlay', overlay }) as WorkspaceAction),
  { type: 'escape' },
  { type: 'browse-source', source: 'collections' },
  { type: 'room-focus', focus: 'walls' },
];

let violation: string | null = null;
let walk = INITIAL_WORKSPACE;
// Deterministic pseudo-random walk; a fixed seed keeps a failure reproducible.
let seed = 12345;
for (let step = 0; step < 4000 && !violation; step++) {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  const action = actions[seed % actions.length]!;
  walk = workspaceReducer(walk, action);
  const panels = panelsFor(walk);
  if (new Set(walk.overlays).size !== walk.overlays.length) violation = `duplicate overlay: ${JSON.stringify(walk)}`;
  else if (walk.overlays.some((o) => !overlayAllowedIn(o, walk.mode)))
    violation = `overlay survived an incompatible mode: ${JSON.stringify(walk)}`;
  else if (panels.createDialogOpen && panels.inspectorVisible)
    violation = `setup and inspector visible in the same right slot: ${JSON.stringify(walk)}`;
  else if (panels.refineRoomOpen && panels.inspectorVisible)
    violation = `room edit and inspector visible in the same right slot: ${JSON.stringify(walk)}`;
}
check('invariants hold across a 4000-step random walk', violation === null, violation);

// ---------------------------------------------------------------------------
// Where an opened plan lands
// ---------------------------------------------------------------------------

// The default that made a passive intent destructive. Opening a finished show
// file must not arm a stamp tool over it — the first click has to select.
check('a plan with content opens with the inspector',
  landingModeFor({ hasRoom: true, hasContent: true }) === 'inspect');

// ...but the opposite rule is just as wrong: an empty sheet with no panel is a
// dead end, so a plan that cannot be read yet lands where the work is.
check('an empty room opens with the inspector, not an armed stamp',
  landingModeFor({ hasRoom: true, hasContent: false }) === 'inspect');
check('a plan with no room opens in setup',
  landingModeFor({ hasRoom: false, hasContent: false }) === 'setup');

// A plan can carry stray geometry without a usable room — there is still
// nothing to work inside, so the room comes first.
check('no room wins over content',
  landingModeFor({ hasRoom: false, hasContent: true }) === 'setup');

// Every landing must be a mode the user can get back out of by pressing the
// mode strip, so none of them may be the exclusive workspace.
check('no landing is the exclusive room workspace',
  [true, false].every((hasRoom) => [true, false].every((hasContent) =>
    landingModeFor({ hasRoom, hasContent }) !== 'room-layout')));

// The room is not content. Counting walls as content would send a freshly
// drawn, empty room to the canvas with nothing on it to look at.
check('walls do not count as content', !isContentLayer('walls'));
check('regions do not count as content', !isContentLayer('region'));
check('furniture counts as content', isContentLayer('furniture'));
check('annotation counts as content', isContentLayer('annotation'));

// ---------------------------------------------------------------------------
// Landing precedence: explicit ▸ remembered ▸ derived
// ---------------------------------------------------------------------------

const withContent = { hasRoom: true, hasContent: true };
const bare = { hasRoom: false, hasContent: false };

check('nothing but facts falls through to the derived answer',
  resolveLanding({ facts: withContent }) === 'inspect');

check('a remembered mode beats the derived one',
  resolveLanding({ remembered: 'inspect', facts: withContent }) === 'inspect');

// New Plan is the reason this rung exists. The file is new, so any memory at
// that path belongs to a document that no longer exists.
check('an explicit landing beats a stale memory',
  resolveLanding({ explicit: 'canvas', remembered: 'inspect', facts: bare }) === 'canvas');

check('an explicit landing beats the derived answer',
  resolveLanding({ explicit: 'canvas', facts: bare }) === 'canvas');

// The New Plan branches, spelled out: tracing and background calibration need
// the sheet clear even though the plan has no room and would otherwise derive
// `setup` — which is exactly the collision that made the dialog flash.
check('tracing a new outline lands on a clear canvas',
  resolveLanding({ explicit: 'canvas', facts: bare }) === 'canvas');
check('a new plan that is not tracing lands in setup',
  resolveLanding({ explicit: 'setup', facts: bare }) === 'setup');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
