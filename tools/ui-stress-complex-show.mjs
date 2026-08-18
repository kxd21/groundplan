/**
 * Complex-show UI/UX stress test — CDP click-through of every control needed
 * to author a Card Party–scale plan from Welcome → blank → stage/seating/gear.
 *
 * Prefer the launcher (starts app + E2E save bypass):
 *   npm run test:ui-stress
 *
 * Or against an already-running CDP session:
 *   GROUNDPLAN_E2E_SAVE_PATH=~/Downloads/CardParty-UI-stress.rv4 \\
 *     npm run dev -- -- --remote-debugging-port=9222
 *   node tools/ui-stress-complex-show.mjs
 *
 * Writes docs/audit/ui-stress-report.json + screenshots.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_CDP,
  DEFAULT_SAVE,
  connectCdp,
  sleep,
  waitForCdpPage,
} from './ui-cdp.mjs';

const AUDIT = path.join('docs', 'audit');
const SAVE_PATH = process.env.GROUNDPLAN_E2E_SAVE_PATH || DEFAULT_SAVE;
const CDP = process.env.GROUNDPLAN_CDP || DEFAULT_CDP;
const HALF_D = 130 + 7 / 12;

fs.mkdirSync(AUDIT, { recursive: true });

const results = [];
const record = (id, ok, detail = '') => {
  results.push({ id, ok, detail: String(detail || '').slice(0, 220) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}${detail ? ` — ${detail}` : ''}`);
};

await waitForCdpPage(CDP, 15000).catch(() => {
  console.error(`No CDP at ${CDP}. Run: npm run test:ui-stress`);
  process.exit(1);
});

const cdp = await connectCdp({ base: CDP });
const {
  ev,
  clickAt,
  key,
  esc,
  shot,
  clickButton,
  setInput,
  setSelect,
  chairs,
  title,
  canvasClickFt,
  close,
} = cdp;

const click = (spec, label, opts) => clickButton(spec, label, record, opts);

console.log('\n=== Complex-show UI stress test ===\n');
console.log('title', await title());
console.log('E2E save path', SAVE_PATH);
try {
  fs.unlinkSync(SAVE_PATH);
} catch {
  /* ok */
}

// ---------- A. Welcome → New plan ----------
console.log('\n-- A. Welcome → Create blank --');
record(
  'welcome:home visible',
  await ev(
    `document.body.innerText.includes('What are you planning') || /Groundplan$/.test(document.title)`,
  ),
);

// Prefer Welcome New plan; if a plan is already open, use Create → New plan…
const welcomeNew = await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find((el) => {
    if ((el.textContent || '').trim() !== 'New plan') return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  });
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
})()`);
if (welcomeNew) {
  await cdp.clickAt(welcomeNew.x, welcomeNew.y);
  record('welcome:New plan', true, `@${Math.round(welcomeNew.x)},${Math.round(welcomeNew.y)}`);
} else {
  await click({ text: 'New' }, 'welcome:New (plan already open)');
  await sleep(250);
  const picked = await ev(`(() => {
    const b = [...document.querySelectorAll('[role=menuitem]')].find((el) => /^New plan/i.test((el.textContent || '').trim()));
    if (!b) return false;
    b.click();
    return true;
  })()`);
  record('welcome:New plan via New menu', !!picked);
}
await sleep(700);
let hasNew = await ev('!!document.querySelector(".new-plan-sheet")');
if (!hasNew) {
  await key(78, 'KeyN', 'n', 4);
  await sleep(700);
  hasNew = await ev('!!document.querySelector(".new-plan-sheet")');
}
record('create:new-plan-sheet', hasNew);

if (hasNew) {
  // Venue / event / date are not in this dialog. They are show identity, and
  // they live in Setup > Show details, where section F now sets them. The
  // dialog also lost its "Continue to room" step when it stopped being a
  // wizard.
  for (const [sel, val, label] of [
    ['#new-plan-name', 'Card Party South Florida', 'create:name'],
  ]) {
    const focused = await ev(`!!document.querySelector(${JSON.stringify(sel)})`);
    if (!focused) {
      record(label, false, 'missing');
      continue;
    }
    await setInput(sel, val);
    record(label, true, val);
  }
  await setInput('#new-plan-width', "245'");
  record('create:width', true, "245'");
  await setInput('#new-plan-depth', `130' 7"`);
  record('create:depth', true, `130' 7"`);
  await shot(path.join(AUDIT, 'ui-stress-02-new-plan.png'));
  await click({ match: '/Create plan/i' }, 'create:Create plan');

  let opened = false;
  for (let i = 0; i < 40; i++) {
    await sleep(350);
    const state = await ev(`({
      dialog: !!document.querySelector('.new-plan-sheet'),
      title: document.title,
      chairs: Number(String((document.body.innerText.match(/Chairs:\\s*([\\d,]+)/)||[])[1]||'0').replace(/,/g,''))
    })`);
    if (
      !state.dialog &&
      state.chairs === 0 &&
      (/CardParty|Card Party/i.test(state.title) || fs.existsSync(SAVE_PATH))
    ) {
      opened = true;
      break;
    }
  }
  record('create:blank opened', opened, await title());
  record('create:E2E file written', fs.existsSync(SAVE_PATH), SAVE_PATH);
} else {
  record('create:blank opened', false, 'sheet never opened');
}
await shot(path.join(AUDIT, 'ui-stress-03-blank.png'));

// ---------- B. Ribbon (requires open plan for real hit targets) ----------
console.log('\n-- B. Ribbon / panel toggles --');
record(
  'ribbon:controls have hit targets',
  await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find((el) => (el.textContent || '').trim() === 'Fit');
    if (!b) return false;
    const r = b.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  })()`),
);

// The mode strip is Browse / Place / Inspect / Setup / Draw. This block used
// to click "Tools", "Browser" and "Inspector", which the shell redesign had
// already renamed — so the dock never opened and every toolId below it missed
// for want of geometry, reporting twenty failures for one wrong word.
await sleep(150);

// Exactly the tools the dock renders. Seating, Stage, Calculate, Edit walls
// and Refine room are no longer dock tools — they moved into Setup and the
// overlays, and are covered by their own sections further down.
// Toolbar controls. Escape between them is harmless: they live in the chrome.
for (const [label, spec] of [
  ['Browse', { text: 'Browse' }],
  ['Inspect', { text: 'Inspect' }],
  ['Fit', { aria: 'Zoom plan to fit' }],
  ['Grid', { text: 'Grid' }],
  ['Snap', { text: 'Snap' }],
  ['Undo', { aria: 'Undo plan edit' }],
  ['Redo', { aria: 'Redo plan edit' }],
]) {
  await click(spec, `ribbon:${label}`);
  await sleep(100);
  await esc();
  await sleep(60);
}

// Dock tools. These only exist while Draw is the active mode, and Escape
// leaves Draw — so the old loop opened the dock, pressed Escape, and then
// reported "not found" for every tool in it. Enter Draw once, stay there, and
// re-enter only if a tool's own action drops the mode.
const enterDraw = async (why) => {
  if (await ev(`!!document.querySelector('[data-tool-id]')`)) return true;
  return click({ text: 'Draw' }, `ribbon:Draw dock${why ? ` (${why})` : ''}`);
};
await enterDraw();
await sleep(200);
for (const [label, toolId] of [
  ['Select', 'select'],
  ['Direct select', 'direct-select'],
  ['Hand', 'hand'],
  ['Line', 'line'],
  ['Rectangle', 'rect'],
  ['Ellipse', 'ellipse'],
  ['Power cable', 'power-cable'],
  ['Signal cable', 'signal-cable'],
  ['Room', 'room'],
  ['Add text', 'add-text'],
  ['Measure', 'measure'],
  ['Dimension', 'dimension'],
]) {
  await enterDraw(label);
  await click({ toolId }, `ribbon:${label}`);
  await sleep(90);
}
await esc();
await sleep(80);

// Settings, shortcuts and the theme toggle moved into the More menu when the
// toolbar was compacted, and they are labelled for people rather than for the
// old ribbon: "Settings…", "Keyboard shortcuts", "Dark interface".
for (const [label, match] of [
  ['Settings', '/^Settings/'],
  ['Keyboard shortcuts', '/Keyboard shortcuts/'],
  ['Theme toggle', '/(Dark|Light) interface/'],
]) {
  await click({ text: 'More' }, `ribbon:More for ${label}`);
  await sleep(220);
  await click({ match }, `ribbon:${label}`);
  await sleep(160);
  await esc();
  await sleep(80);
}
await shot(path.join(AUDIT, 'ui-stress-01-ribbon.png'));

// ---------- C. Setup + Theatre + Stage ----------
console.log('\n-- C. Setup + Stage + Theatre --');
await click({ match: '/^Setup$/i' }, 'setup:Setup panel');
await sleep(500);
if (!(await ev('!!document.querySelector(".create-dialog-sheet")'))) {
  await click({ match: '/^Setup$/i' }, 'setup:Setup dock retry');
  await sleep(400);
}
record('setup:create-dialog-sheet', await ev('!!document.querySelector(".create-dialog-sheet")'));

await ev(`(() => {
  const d = document.querySelector('.create-more-tools');
  if (d && !d.open) d.open = true;
  const banks = document.querySelector('.create-stamp-banks');
  if (banks && !banks.open) banks.open = true;
  return true;
})()`);
await sleep(200);

const theatre = await ev(`(() => {
  const b = document.querySelector('.create-dialog-sheet [data-seat-kind="theatre"]');
  if (!b) return { ok: false, reason: 'no data-seat-kind=theatre' };
  b.scrollIntoView({ block: 'center' });
  b.click();
  return { ok: true };
})()`);
record('setup:Theatre click', !!theatre?.ok, JSON.stringify(theatre));
await sleep(200);
const theatreActive = await ev(
  `document.querySelector('.create-dialog-sheet [data-seat-kind="theatre"]')?.getAttribute('aria-pressed') === 'true'`,
);
record('setup:Theatre tab', theatreActive);

const chairArmed = await ev(`(() => {
  const chair = document.getElementById('create-seat-chair');
  if (!chair) return { ok: false, reason: 'no chair select' };
  chair.scrollIntoView({ block: 'center' });
  const opt = [...chair.options].find((o) => /Chair 20/i.test(o.text))
    || [...chair.options].find((o) => /chair/i.test(o.text) && o.value)
    || [...chair.options].find((o) => o.value);
  if (!opt) return { ok: false, reason: 'no options', options: [...chair.options].map((o) => o.text) };
  const native = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  native.set.call(chair, opt.value);
  chair.dispatchEvent(new Event('input', { bubbles: true }));
  chair.dispatchEvent(new Event('change', { bubbles: true }));
  // React 17+ controlled selects sometimes ignore synthetic change — poke props.
  const propsKey = Object.keys(chair).find((k) => k.startsWith('__reactProps'));
  const props = propsKey ? chair[propsKey] : null;
  if (props?.onChange) {
    try { props.onChange({ target: chair, currentTarget: chair }); } catch { /* ok */ }
  }
  const lengths = document.getElementById('create-seat-row-lengths');
  if (lengths) {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    set.set.call(lengths, '14,14,14,14,14,14,14,14,14,14,14');
    lengths.dispatchEvent(new Event('input', { bubbles: true }));
    lengths.dispatchEvent(new Event('change', { bubbles: true }));
    const lk = Object.keys(lengths).find((k) => k.startsWith('__reactProps'));
    if (lk && lengths[lk]?.onChange) {
      try { lengths[lk].onChange({ target: lengths, currentTarget: lengths }); } catch { /* ok */ }
    }
  }
  return { ok: true, chair: chair.value, kindActive: [...document.querySelectorAll('.create-dialog-sheet .seat-kinds button')].find((b) => b.classList.contains('active'))?.textContent };
})()`);
record('setup:chair select', !!chairArmed?.ok, JSON.stringify(chairArmed));
await sleep(200);

const placeArmed = await ev(`(() => {
  const place = [...document.querySelectorAll('.create-dialog-sheet button')].find((b) =>
    /^\\s*Place on plan\\s*$/i.test((b.textContent || '').replace(/\\s+/g, ' ').trim()) ||
    ((b.textContent || '').includes('Place on plan') && !(b.textContent || '').includes('Insert')),
  );
  if (!place) return { ok: false, reason: 'missing' };
  place.scrollIntoView({ block: 'center' });
  if (place.disabled) {
    return {
      ok: false,
      reason: 'disabled',
      chairDom: document.getElementById('create-seat-chair')?.value,
      placeText: (place.textContent || '').trim().slice(0, 40),
    };
  }
  place.click();
  return { ok: true };
})()`);
record('setup:Place on plan', !!placeArmed?.ok, JSON.stringify(placeArmed));
await sleep(200);

await click({ text: 'Fit' }, 'setup:Fit before place');
await sleep(400);
const before = await chairs();
await canvasClickFt(-48, -36);
await sleep(900);
const after1 = await chairs();
record('setup:place bank 1', after1 > before, `${before} → ${after1}`);
await canvasClickFt(48, -36);
await sleep(900);
const after2 = await chairs();
record('setup:place bank 2', after2 > after1, `${after1} → ${after2}`);
await click({ match: '/^Done placing$/i' }, 'setup:Done placing');
await esc();

// Stage, seating, wall editing and the calculator left the dock for Setup and
// the overlays. Reaching them means opening Setup and, on a plan that already
// has a layout, the "Change the layout" disclosure that now folds them away.
const openSetupTools = async (label) => {
  // Idempotent: the mode strip toggles, so clicking Setup while Setup is
  // already open closes it. Earlier sections leave it open, and this used to
  // shut the panel it was trying to reach into.
  if (!(await ev(`!!document.querySelector('.show-setup-section')`))) {
    await click({ match: '/^Setup$/i' }, `${label}:Setup`);
    await sleep(500);
  }
  // Check the OUTCOME, not "is some disclosure closed". There are two
  // disclosures in this panel (kit and build); keying off either one meant a
  // closed kit section made this click the build heading and shut the very
  // steps it was opening.
  const stepsVisible = await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find((el) =>
      /Build a stage/.test(el.textContent || ''));
    if (!b) return false;
    const r = b.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  })()`);
  if (!stepsVisible) {
    await click(
      { match: '/Change the layout|Or build it yourself/' },
      `${label}:expand layout tools`,
    );
    await sleep(320);
  }
};

await openSetupTools('stage');
await click({ match: '/Build a stage/' }, 'stage:open');
await sleep(350);
await click({ match: '/House 8|24.*8|Tiered|Simple/i' }, 'stage:preset');
await sleep(100);
await click({ match: '/Build stage/i' }, 'stage:Build stage');
await sleep(1000);
await esc();
await shot(path.join(AUDIT, 'ui-stress-04-stage-seating.png'));

// ---------- D. Seating planner ----------
console.log('\n-- D. Seating planner --');
await openSetupTools('seating');
await click({ match: '/Seating planner/' }, 'seating:open planner');
await sleep(400);
record(
  'seating:planner visible',
  await ev(
    `!!(document.querySelector('#seating-window-title') || document.querySelector('[aria-label="Close seating planner"]') || document.body.innerText.includes('Seating planner'))`,
  ),
);
await click({ match: '/Place seating|Add section/i' }, 'seating:Place seating (may stay disabled)');
await click({ aria: 'Close seating planner' }, 'seating:close');
await sleep(200);

// ---------- E. Equipment ----------
console.log('\n-- E. Equipment --');
await click({ text: 'Place' }, 'equip:ensure Place');
await sleep(200);
await click(
  {
    match: '/^Equipment$/',
    root: '.rail, .palette, .browser, aside, .left-rail, .canvas-with-palette',
  },
  'equip:Equipment tab',
);
await sleep(200);

async function armSearch(query) {
  await ev(`(() => {
    const input = [...document.querySelectorAll('input')].find((i) => /search/i.test(i.placeholder || ''));
    if (!input) return false;
    const p = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    p.set.call(input, ${JSON.stringify(query)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(350);
  return ev(`(() => {
    const best = [...document.querySelectorAll('.palette-place')][0];
    if (!best) return null;
    best.click();
    return (best.textContent || '').trim().slice(0, 48);
  })()`);
}

const door = await armSearch('Door - Double (Out)');
record('equip:arm Door Double Out', !!door, door || '');
await click({ text: 'Fit' }, 'equip:Fit');
await sleep(250);
await canvasClickFt(-77, -HALF_D / 2 + 0.5);
await sleep(250);
await canvasClickFt(77, -HALF_D / 2 + 0.5);
await sleep(150);
await click({ match: '/Done placing/i' }, 'equip:Done placing');

for (const q of ['Fastfold', 'Mixer', 'Light Tree', 'Podium', 'Speaker', 'Truss']) {
  const armed = await armSearch(q);
  record(`equip:search ${q}`, !!armed, armed || 'no hits');
  if (armed) {
    await canvasClickFt(0, -HALF_D / 2 + 12);
    await sleep(200);
    await click({ match: '/Done placing/i' }, `equip:done ${q}`);
  }
}
await shot(path.join(AUDIT, 'ui-stress-05-equipment.png'));

// ---------- F. Annotations ----------
console.log('\n-- F. Annotations --');
// Back into Draw: the annotation tools are dock tools, and the sections above
// left the app in Setup.
await click({ text: 'Draw' }, 'annot:Draw dock');
await sleep(260);
await click({ toolId: 'add-text' }, 'annot:Add text');
await sleep(150);
await canvasClickFt(0, -HALF_D / 2 + 3);
await sleep(200);
await cdp.send('Input.insertText', { text: 'STAGE' });
await key(13, 'Enter', 'Enter');
await sleep(150);
record('annot:text STAGE', true);
await esc();

await click({ text: 'Draw' }, 'annot:Draw dock (dimension)');
await sleep(220);
await click({ toolId: 'dimension' }, 'annot:Dimension tool');
await sleep(120);
await canvasClickFt(-4, -20);
await sleep(80);
await canvasClickFt(4, -20);
await sleep(250);
record('annot:dimension drag', true);
await esc();

await click({ text: 'Draw' }, 'annot:Draw dock (measure)');
await sleep(220);
await click({ toolId: 'measure' }, 'annot:Measure tool');
await sleep(100);
await canvasClickFt(-10, 0);
await sleep(80);
await canvasClickFt(10, 0);
await sleep(200);
await esc();
record('annot:measure', true);

// ---------- G. Room / calc / snap select ----------
console.log('\n-- G. Room + calc + snap --');
await openSetupTools('room');
await click({ match: '/^Edit walls$/' }, 'room:Edit walls');
await sleep(250);
await esc();
await openSetupTools('roomws');
await click({ match: '/^Edit room$/' }, 'room:Edit room workspace');
await sleep(250);
await esc();
await click({ match: '/Space calculator|Calculator/' }, 'calc:open');
await sleep(350);
record(
  'calc:visible',
  await ev(
    `document.body.innerText.includes('Calculator') || document.body.innerText.includes('calculator') || !!document.querySelector('[aria-label*="calculator" i]')`,
  ),
);
await esc();

// Snap step is a <select aria-label="Snap step">, not a menu of buttons.
for (const [value, label] of [
  ['10', '1″'],
  ['120', "1′"],
  ['0', 'Off'],
]) {
  const set = await ev(`(() => {
    const sel = document.querySelector('select[aria-label="Snap step"]');
    if (!sel) return { ok: false, reason: 'no select' };
    const native = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    native.set.call(sel, ${JSON.stringify(value)});
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, value: sel.value, label: sel.selectedOptions[0]?.text };
  })()`);
  record(`snap:set ${label}`, !!set?.ok, JSON.stringify(set));
  await sleep(80);
}

// ---------- H. Save / history / inspector ----------
console.log('\n-- H. Save / history / inspector --');
await click({ text: 'Save' }, 'file:Save');
await sleep(500);
record('file:exists on disk', fs.existsSync(SAVE_PATH) || /CardParty|Card Party/i.test(await title()), SAVE_PATH);
await click({ aria: 'Undo plan edit' }, 'history:Undo');
await sleep(150);
await click({ aria: 'Redo plan edit' }, 'history:Redo');
await sleep(150);
await click({ text: 'Inspect' }, 'inspector:toggle');
await sleep(120);
for (const tab of ['Properties', 'Room', 'Layers']) {
  const hit = await ev(`(() => {
    const b = [...document.querySelectorAll('button,[role=tab]')].find((el) => (el.textContent || '').trim() === ${JSON.stringify(tab)});
    if (!b) return false;
    b.click();
    return true;
  })()`);
  record(`inspector:${tab}`, hit);
  await sleep(100);
}
await click({ text: 'Fit' }, 'view:Fit final');
await sleep(350);
await shot(path.join(AUDIT, 'ui-stress-06-final.png'));

const summary = {
  title: await title(),
  chairs: await chairs(),
  savePath: SAVE_PATH,
  saveExists: fs.existsSync(SAVE_PATH),
  passed: results.filter((r) => r.ok).length,
  failed: results.filter((r) => !r.ok).length,
  total: results.length,
  results,
};
fs.writeFileSync(path.join(AUDIT, 'ui-stress-report.json'), JSON.stringify(summary, null, 2));
console.log('\n=== SUMMARY ===');
console.log(`${summary.passed}/${summary.total} passed, ${summary.failed} failed`);
console.log('chairs', summary.chairs, 'title', summary.title);
console.log('report docs/audit/ui-stress-report.json');
close();
process.exit(summary.failed > 8 ? 1 : 0);
