/**
 * Hardcore UI stress: build a show end to end, then try to break it.
 *
 *   npm run test:ui-hardcore
 *
 * This is not the happy-path setup test. It drives the real intake — brief,
 * room, kit, stage, seating, gear, readiness, save, reopen, export — and then
 * attacks each surface the way a user under pressure does: junk in every field,
 * rapid double-clicks on destructive actions, undo storms, resize while a dock
 * is open, escape out of half-finished dialogs, and reopen to see what survived.
 *
 * Findings are severity-ranked. `high` and `critical` fail the run.
 */
import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_CDP, connectCdp, sleep, waitForCdpPage } from './ui-cdp.mjs';

const AUDIT = path.join('docs', 'audit');
const SAVE_PATH =
  process.env.GROUNDPLAN_E2E_SAVE_PATH ||
  path.join(process.env.HOME || '', 'Downloads', 'Groundplan-hardcore.rv4');
const CDP = process.env.GROUNDPLAN_CDP || DEFAULT_CDP;
const TARGET = 900;
const SHOW = 'Hardcore Summit 2026';

fs.mkdirSync(AUDIT, { recursive: true });

const results = [];
const findings = [];
const record = (id, ok, detail = '') => {
  results.push({ id, ok, detail: String(detail ?? '').slice(0, 300) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}${detail ? ` — ${String(detail).slice(0, 160)}` : ''}`);
};
const note = (severity, title, detail, evidence = '') => {
  findings.push({ severity, title, detail, evidence: String(evidence ?? '').slice(0, 400) });
  console.log(`\n[${severity}] ${title}\n  ${detail}${evidence ? `\n  ${String(evidence).slice(0, 220)}` : ''}\n`);
};

await waitForCdpPage(CDP, 20000).catch(() => {
  console.error(`No CDP at ${CDP}. Run: npm run test:ui-hardcore`);
  process.exit(1);
});

const cdp = await connectCdp({ base: CDP });
const { ev, clickAt, key, esc, shot, setInput, setSelect, title, close, pageErrors, send } = cdp;

const waitFor = async (expr, ms = 15000, step = 300) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await ev(expr)) return true;
    } catch {
      /* renderer mid-update */
    }
    await sleep(step);
  }
  return false;
};

/** Set a field and commit it the way a blur would. */
const commit = async (sel, value) => {
  await setInput(sel, value);
  await ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false;
    el.dispatchEvent(new Event('blur')); el.blur(); return true; })()`);
  await sleep(500);
};

const clickText = async (re, root = 'body') =>
  ev(`(() => {
    const scope = document.querySelector(${JSON.stringify(root)}) || document;
    const b = [...scope.querySelectorAll('button')].find((e) => new RegExp(${JSON.stringify(re)}, 'i').test(e.textContent || ''));
    if (!b || b.disabled) return false;
    b.scrollIntoView({ block: 'center' });
    b.click();
    return true;
  })()`);

/**
 * Reopen the plan the way a user does.
 *
 * Calling `window.groundplan.openPath` straight from CDP loads the plan in the
 * MAIN process and leaves the renderer holding the document it already had —
 * so every panel reads stale counts and the test blames the app for its own
 * shortcut. Going through the recent-plans list exercises the real path.
 */
const reopenThroughTheApp = async (savePath) => {
  const base = path.basename(savePath).replace(/\.rv4$/i, '');
  await esc(); await sleep(300);
  const clicked = await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find((e) => new RegExp(${JSON.stringify('BASE')}, 'i').test(e.textContent || ''));
    if (!b) return false;
    b.click();
    return true;
  })()`.replace('BASE', base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  if (!clicked) return false;
  await sleep(5500);
  return ev(`!!document.querySelector('canvas')`);
};

const openDock = async () => {
  if (await ev(`!!document.querySelector('.create-dialog-sheet')`)) return true;
  await clickText('^Show Setup$');
  return waitFor(`!!document.querySelector('.create-dialog-sheet')`, 8000);
};

const openGroup = async (label) => {
  await ev(`(() => {
    const b = [...document.querySelectorAll('.brief-group-head')].find((e) => new RegExp(${JSON.stringify(label)}, 'i').test(e.textContent || ''));
    if (!b) return false;
    b.scrollIntoView({ block: 'center' });
    if (b.getAttribute('aria-expanded') !== 'true') b.click();
    return true;
  })()`);
  await sleep(450);
};

const review = () =>
  ev(`(() => {
    const card = document.querySelector('.review-card');
    if (!card) return null;
    const facts = {};
    for (const r of card.querySelectorAll('.review-facts > div')) {
      facts[(r.querySelector('dt')?.textContent || '').trim()] =
        (r.querySelector('dd')?.textContent || '').trim() + (r.classList.contains('is-off') ? ' [off]' : '');
    }
    return {
      state: (card.querySelector('.review-state')?.textContent || '').trim(),
      facts,
      issues: [...card.querySelectorAll('.review-issues > li')].map((li) => ({
        sev: (li.className.match(/is-(blocking|warning|info)/) || [])[1] || '',
        title: (li.querySelector('strong')?.textContent || '').trim(),
        action: (li.querySelector('button')?.textContent || '').trim(),
      })),
    };
  })()`);

const counts = () =>
  ev(`(async () => {
    const s = await window.groundplan.scheduleBuild();
    const m = await window.groundplan.planModel();
    return {
      items: m.itemCount,
      groups: (s?.groups || []).length,
      chairs: (s?.groups || []).filter((g) => /chair/i.test(g.name)).reduce((a, g) => a + g.count, 0),
    };
  })()`);

console.log('\n═══ Hardcore show build ═══\n');
console.log('title', await title());
for (const p of [SAVE_PATH, `${SAVE_PATH}.groundplan.json`]) {
  try { fs.unlinkSync(p); } catch { /* ok */ }
}

/* ── 1. Intake ──────────────────────────────────────────────────────────── */
console.log('\n-- 1. Describe the show --');
await esc(); await sleep(200); await esc(); await sleep(300);
await clickText('^New plan$');
if (!(await waitFor(`!!document.querySelector('.new-plan-sheet')`, 8000))) {
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find((e)=>(e.textContent||'').trim()==='New'); if(b) b.click(); return true; })()`);
  await sleep(400);
  await ev(`(() => { const b=[...document.querySelectorAll('[role=menuitem]')].find((e)=>/^New plan/i.test((e.textContent||'').trim())); if(b) b.click(); return true; })()`);
}
record('intake:new plan opens', await waitFor(`!!document.querySelector('.new-plan-sheet')`, 10000));

/*
 * Junk first. Every one of these is something a real user types — a pasted
 * number with a comma, an accented venue, a negative headcount, an emoji in a
 * name — and none of them should corrupt the plan or throw.
 */
await setInput('#new-plan-show-name', `${SHOW} — “Café” 🎪`);
await setInput('#new-plan-show-venue', 'Javits Center — Hall 1E');
await setInput('#new-plan-guests', '-40');
await sleep(300);
const negative = await ev(`(() => {
  const b = [...document.querySelectorAll('.new-plan-guest-row button')].find((e) => /Create /i.test(e.textContent || ''));
  return { disabled: !!b?.disabled, value: document.querySelector('#new-plan-guests')?.value };
})()`);
record('intake:a negative headcount cannot be applied', negative?.disabled === true, JSON.stringify(negative));
if (!negative?.disabled) {
  note('high', 'A negative headcount is accepted', 'The create-from-attendance button stayed live for -40 people.', JSON.stringify(negative));
}

await setInput('#new-plan-guests', String(TARGET));
await setSelect('#new-plan-show-layout', `[...el.options].find((o) => /General session/i.test(o.text))`);
await sleep(300);
// Open client field so unicode client survives the brief.
await ev(`(() => { const b=[...document.querySelectorAll('.new-plan-advanced-toggle')].find((e)=>/Add client/i.test(e.textContent||'')); if(b) b.click(); return true; })()`);
await sleep(200);
await setInput('#new-plan-show-client', 'Ünïcödé Röbotics <script>alert(1)</script>');
// Create from attendance — one click, not a three-step advance.
await ev(`(() => { const b=[...document.querySelectorAll('.new-plan-guest-row button')].find((e)=>/Create /i.test(e.textContent||'')); if(b&&!b.disabled){ b.click(); b.click(); } return true; })()`);
const created = await waitFor(`!document.querySelector('.new-plan-sheet') && !!document.querySelector('canvas')`, 30000);
record('intake:double-clicking create still creates one plan', created, await title());
await sleep(3500);
record('intake:file written', fs.existsSync(SAVE_PATH), SAVE_PATH);

const brief0 = await ev(`window.groundplan.showBrief()`);
record('intake:brief reached the sidecar', !!brief0?.name, brief0?.name);
record('intake:target attendance kept', brief0?.targetAttendance === TARGET, String(brief0?.targetAttendance));
record(
  'intake:non-latin1 text survives the trailer sync',
  typeof brief0?.venue === 'string' && brief0.venue.includes('—'),
  brief0?.venue,
);
const sidecar0 = fs.existsSync(`${SAVE_PATH}.groundplan.json`)
  ? JSON.parse(fs.readFileSync(`${SAVE_PATH}.groundplan.json`, 'utf8'))
  : null;
record('intake:sidecar written without a manual save', !!sidecar0?.showBrief?.name, sidecar0?.showBrief?.name);
if (!sidecar0?.showBrief) {
  note('critical', 'The brief never reached disk', 'A crash or force quit here loses the whole description of the show.');
}

/* ── 2. Layout ──────────────────────────────────────────────────────────── */
console.log('\n-- 2. Apply a layout --');
await openDock();
await sleep(1200);
const before = await counts();
await setSelect('#show-kit-select', `[...el.options].find((o) => /Card Party/i.test(o.text))`);
await sleep(400);
// Double-click Apply: a second apply must not double the room.
await ev(`(() => { const b=[...document.querySelectorAll('.show-setup-kit-hero button')].find((e)=>/Apply complete layout/i.test(e.textContent||'')); if(b&&!b.disabled){b.click();b.click();} return true; })()`);
await waitFor(`/Applied kit/.test(document.querySelector('.toast')?.textContent || '')`, 40000);
await sleep(3000);
const afterKit = await counts();
record('layout:the kit lands its chairs', afterKit.chairs > 2000, `${before.chairs} → ${afterKit.chairs}`);
record('layout:gear is named on the plan', afterKit.groups >= 10, `${afterKit.groups} groups`);
const gearNames = await ev(`(async () => { const s = await window.groundplan.scheduleBuild(); return (s?.groups||[]).map((g)=>g.name); })()`);
for (const want of ['Speaker', 'Podium/Lectern', 'Mixer']) {
  record(`layout:${want} is counted, not just drawn`, (gearNames || []).includes(want), JSON.stringify((gearNames||[]).slice(0,6)));
  if (!(gearNames || []).includes(want)) {
    note('high', `${want} is on the plan but invisible to the schedule`, 'It will not appear on a pull sheet, a report or a gear list.', JSON.stringify(gearNames));
  }
}
record('layout:a double apply does not double the room', afterKit.chairs < 5000, String(afterKit.chairs));
if (afterKit.chairs >= 5000) {
  note('high', 'Applying a kit twice stacks two layouts', 'The second apply must replace, not add.', String(afterKit.chairs));
}

/* ── 3. The brief drives the plan ───────────────────────────────────────── */
console.log('\n-- 3. Readiness reacts --');
await openDock();
await openGroup('Layout goals');
await ev(`document.querySelector('#brief-stage')?.click()`); await sleep(800);
await commit('#brief-stage-w', '40');
await commit('#brief-stage-d', '24');
await commit('#brief-stage-h', '24');
await ev(`document.querySelector('#brief-screens')?.click()`); await sleep(900);
const r1 = await review();
record('readiness:over-seating is not "ready"', r1?.state !== 'Ready', `${r1?.state} · ${r1?.facts?.Seats}`);
record(
  'readiness:the excess is named',
  (r1?.issues || []).some((i) => /more seats than/i.test(i.title)),
  JSON.stringify((r1?.issues || []).map((i) => i.title)),
);
record(
  'readiness:screens already drawn are recognised',
  /On the drawing/i.test(r1?.facts?.['Screens / AV'] || ''),
  r1?.facts?.['Screens / AV'],
);
if (!/On the drawing/i.test(r1?.facts?.['Screens / AV'] || '')) {
  note('high', 'Screens on the plan are reported missing', 'The brief asked for A/V, the kit placed projectors, and the check said none are drawn.', r1?.facts?.['Screens / AV']);
}
record(
  'readiness:an undersized stage is caught',
  (r1?.issues || []).some((i) => /smaller than the brief/i.test(i.title)),
  JSON.stringify((r1?.issues || []).map((i) => i.title)),
);
record('readiness:every issue offers a route', (r1?.issues || []).every((i) => i.action.length > 1), JSON.stringify(r1?.issues));

// The stage warning must open a builder that already knows the answer.
await ev(`(() => { const li=[...document.querySelectorAll('.review-issues > li')].find((e)=>/stage/i.test(e.querySelector('strong')?.textContent||'')); li?.querySelector('button')?.click(); return true; })()`);
await sleep(1600);
const prefilled = await ev(`(() => {
  const dlg = document.querySelector('[aria-label="Build a Stage"]');
  if (!dlg) return null;
  return [...dlg.querySelectorAll('input')].map((i) => i.value).slice(0, 3);
})()`);
record('readiness:the stage builder opens pre-filled from the brief', /40/.test((prefilled || []).join(' ')), JSON.stringify(prefilled));
if (prefilled && !/40/.test(prefilled.join(' '))) {
  note('medium', 'The stage builder ignores the brief', 'The brief names a size and the dialog opens on its own default, so the warning that sent you here comes straight back.', JSON.stringify(prefilled));
}
await clickText('Build stage', '[aria-label="Build a Stage"]');
await sleep(4000);
await openDock();
await sleep(1500);
const r2 = await review();
record('readiness:building it clears the warning', !(r2?.issues || []).some((i) => /smaller than the brief/i.test(i.title)), r2?.facts?.Stage);

/* ── 4. Accessible spaces ───────────────────────────────────────────────── */
console.log('\n-- 4. Accessible spaces --');
await openGroup('Constraints');
await commit('#brief-accessible', '18');
await sleep(900);
const r3 = await review();
record('readiness:a stated requirement raises a warning', (r3?.issues || []).some((i) => /accessible/i.test(i.title)));
const placed = await ev(`(async () => {
  const out = [];
  for (let i = 0; i < 18; i++) {
    const rep = await window.groundplan.placeGear('Wheelchair', (-42 + i * 5) * 120, 30 * 120);
    out.push(rep.ok);
  }
  return out.filter(Boolean).length;
})()`);
record('readiness:eighteen spaces can be placed', placed === 18, String(placed));
// Reopen so the renderer's document is unambiguously current.
await ev(`window.groundplan.save()`);
await sleep(2500);
await ev(`window.groundplan.closePlan?.()`).catch(() => {});
await sleep(1500);
record('readiness:the plan reopens from the recent list', await reopenThroughTheApp(SAVE_PATH));
await openDock();
await sleep(2000);
const r4 = await review();
record(
  'readiness:placing them clears the warning',
  !(r4?.issues || []).some((i) => /accessible/i.test(i.title)),
  r4?.facts?.Accessible,
);
if ((r4?.issues || []).some((i) => /accessible/i.test(i.title))) {
  note('high', 'Accessible spaces are on the plan and still reported short', 'A warning that cannot be cleared by doing the thing it asks for is a nag.', r4?.facts?.Accessible);
}

/* ── 5. Junk into every brief field ─────────────────────────────────────── */
console.log('\n-- 5. Junk in the brief --');
const junk = [
  ['#brief-attendance', 'not a number'],
  ['#brief-attendance', '999999999999'],
  ['#brief-accessible', '-5'],
  ['#brief-stage-w', '0'],
  ['#brief-aisle', '1e400'],
];
await openGroup('Layout goals');
for (const [sel, value] of junk) {
  if (!(await ev(`!!document.querySelector(${JSON.stringify(sel)})`))) {
    await openGroup('Constraints');
  }
  if (!(await ev(`!!document.querySelector(${JSON.stringify(sel)})`))) continue;
  await commit(sel, value);
}
await sleep(800);
const afterJunk = await ev(`window.groundplan.showBrief()`);
const sane =
  afterJunk != null &&
  (afterJunk.targetAttendance == null || (afterJunk.targetAttendance > 0 && afterJunk.targetAttendance <= 500000)) &&
  (afterJunk.accessibleSeats == null || afterJunk.accessibleSeats > 0) &&
  (afterJunk.minAisleIn == null || Number.isFinite(afterJunk.minAisleIn));
record('junk:the brief refuses nonsense rather than storing it', sane, JSON.stringify(afterJunk).slice(0, 220));
if (!sane) {
  note('high', 'The brief stored a value it cannot mean', 'Junk in a numeric field reached the sidecar.', JSON.stringify(afterJunk));
}
record('junk:the show still has its name', !!afterJunk?.name, afterJunk?.name);

/* ── 6. Undo storm ──────────────────────────────────────────────────────── */
console.log('\n-- 6. Undo storm --');
const beforeUndo = await counts();
for (let i = 0; i < 25; i++) {
  await ev(`window.groundplan.undo()`);
}
await sleep(2500);
const afterUndo = await counts();
record('undo:twenty-five undos do not throw', true, `${beforeUndo.items} → ${afterUndo.items}`);
for (let i = 0; i < 25; i++) {
  await ev(`window.groundplan.redo()`);
}
await sleep(2500);
const afterRedo = await counts();
record('undo:redo returns the plan', afterRedo.items >= afterUndo.items, `${afterUndo.items} → ${afterRedo.items}`);
await openDock();
await sleep(1500);
const r5 = await review();
record('undo:readiness follows the undo stack', !!r5?.state, `${r5?.state} · ${r5?.facts?.Seats}`);
const briefAfterUndo = await ev(`window.groundplan.showBrief()`);
record(
  'undo:undo does not eat the brief',
  !!briefAfterUndo?.name,
  briefAfterUndo?.name,
);
if (!briefAfterUndo?.name) {
  note('critical', 'Undo destroyed the brief', 'The brief is sidecar data and is not part of the document history.');
}

/* ── 7. Escape out of half-finished dialogs ─────────────────────────────── */
console.log('\n-- 7. Abandoned dialogs --');
for (const [label, opener] of [
  ['stage', async () => clickText('^Stage$')],
  ['seating', async () => clickText('^Seating$')],
  ['room', async () => clickText('^Room$')],
]) {
  await opener();
  await sleep(1200);
  await esc();
  await sleep(700);
  const stuck = await ev(`(() => {
    const modal = document.querySelector('[role=dialog][aria-modal=true], .sheet-backdrop');
    const blocked = !!document.querySelector('.sheet-backdrop');
    return { modal: !!modal, blocked };
  })()`);
  record(`dialog:${label} closes on Escape`, !stuck?.blocked, JSON.stringify(stuck));
  if (stuck?.blocked) {
    note('high', `${label} dialog cannot be escaped`, 'A modal backdrop is still covering the app.', JSON.stringify(stuck));
  }
}

/* ── 8. Narrow windows ──────────────────────────────────────────────────── */
console.log('\n-- 8. Small windows --');
await openDock();
for (const [w, h] of [[1100, 700], [900, 640], [1440, 900]]) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await sleep(900);
  await openDock();
  await openGroup('Show');
  await sleep(600);
  const clip = await ev(`(() => {
    const dock = document.querySelector('.create-dialog-sheet');
    if (!dock) return { missing: true };
    const box = dock.getBoundingClientRect();
    const bad = [];
    for (const el of dock.querySelectorAll('.brief-field, .brief-group, .review-facts > div, .review-issues > li, button, input, select')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.right > box.right + 1 || r.left < box.left - 1) bad.push((el.className || el.tagName).toString().slice(0, 40));
    }
    return { w: window.innerWidth, h: window.innerHeight, dock: Math.round(box.width), bad: bad.slice(0, 6) };
  })()`);
  record(`layout:${w}×${h} nothing spills out of the dock`, !clip?.missing && (clip?.bad || []).length === 0, JSON.stringify(clip));
  if ((clip?.bad || []).length) {
    note('high', `Show Setup is clipped at ${w}×${h}`, 'Content leaves the panel at a window size people use.', JSON.stringify(clip));
  }
  await shot(path.join(AUDIT, `ui-hardcore-dock-${w}x${h}.png`));
}
await send('Emulation.clearDeviceMetricsOverride', {}).catch(() => undefined);
await sleep(600);

/* ── 9. Themes ──────────────────────────────────────────────────────────── */
console.log('\n-- 9. Themes --');
for (const theme of ['light', 'dark']) {
  await ev(`document.querySelector('.app')?.setAttribute('data-theme', ${JSON.stringify(theme)})`);
  await sleep(700);
  const painted = await ev(`(() => {
    const pick = (sel) => { const el = document.querySelector(sel); if (!el) return null;
      const cs = getComputedStyle(el); return { bg: cs.backgroundColor, color: cs.color }; };
    return { brief: pick('.brief-card'), review: pick('.review-card'), issue: pick('.review-issues > li') };
  })()`);
  const transparent = Object.entries(painted || {}).filter(([, v]) => v && /rgba\(0, 0, 0, 0\)/.test(v.bg || ''));
  record(`theme:${theme} cards paint their own ground`, transparent.length === 0, JSON.stringify(painted));
  await shot(path.join(AUDIT, `ui-hardcore-${theme}.png`));
}
await ev(`document.querySelector('.app')?.setAttribute('data-theme','light')`);
await sleep(400);

/* ── 10. Save, reopen, export ───────────────────────────────────────────── */
console.log('\n-- 10. Save, reopen, issue --');
const beforeSave = await counts();
const briefBeforeSave = await ev(`window.groundplan.showBrief()`);
await ev(`window.groundplan.save()`);
await sleep(3000);
await ev(`window.groundplan.closePlan?.()`).catch(() => {});
await sleep(1500);
record('persist:the plan reopens from the recent list', await reopenThroughTheApp(SAVE_PATH));
const afterReopen = await counts();
const briefAfterReopen = await ev(`window.groundplan.showBrief()`);
record('persist:the plan reopens with its contents', afterReopen.items === beforeSave.items, `${beforeSave.items} → ${afterReopen.items}`);
record('persist:the brief reopens with the plan', briefAfterReopen?.name === briefBeforeSave?.name, briefAfterReopen?.name);
record(
  'persist:the headcount reopens too',
  briefAfterReopen?.targetAttendance === briefBeforeSave?.targetAttendance,
  `${briefBeforeSave?.targetAttendance} → ${briefAfterReopen?.targetAttendance}`,
);
if (afterReopen.items !== beforeSave.items) {
  note('critical', 'The plan does not round-trip', 'Objects were lost or gained across save and reopen.', `${beforeSave.items} → ${afterReopen.items}`);
}

await openDock();
await sleep(1800);
const issueBlock = await ev(`(() => {
  const card = document.querySelector('.review-card');
  if (!card) return null;
  const print = [...card.querySelectorAll('button')].find((b) => /Print/i.test(b.textContent || ''));
  const state = card.querySelector('.review-state');
  return {
    drawnBy: !!card.querySelector('#review-drawn-by'),
    revision: !!card.querySelector('#review-revision'),
    printEnabled: !!print && !print.disabled,
    readinessFirst: !!state && !!print && state.getBoundingClientRect().top <= print.getBoundingClientRect().top,
  };
})()`);
record('issue:the sheet carries drawn-by and revision', !!(issueBlock?.drawnBy && issueBlock?.revision), JSON.stringify(issueBlock));
record('issue:readiness is visible before print', !!issueBlock?.readinessFirst);
record('issue:printing is never blocked', !!issueBlock?.printEnabled);

const exports = await ev(`(async () => {
  const out = {};
  try { const s = await window.groundplan.scheduleBuild(); out.schedule = (s?.groups||[]).length; } catch (e) { out.schedule = String(e); }
  try { const a = await window.groundplan.allocation(); out.allocationLines = a?.lines?.length ?? null; } catch (e) { out.allocation = String(e); }
  try { const av = await window.groundplan.avSummary(); out.screens = av?.screens ?? null; } catch (e) { out.av = String(e); }
  try { const l = await window.groundplan.loadSummary(); out.load = l ? Object.keys(l).length : null; } catch (e) { out.load = String(e); }
  return out;
})()`);
record('issue:every downstream report builds', Object.values(exports || {}).every((v) => typeof v !== 'string'), JSON.stringify(exports));
record('issue:the pull sheet sees the gear', (exports?.allocationLines ?? 0) > 0, String(exports?.allocationLines));
if (!(exports?.allocationLines > 0)) {
  note('high', 'The gear allocation is empty on a plan full of gear', 'Nothing will reach the truck.', JSON.stringify(exports));
}

await shot(path.join(AUDIT, 'ui-hardcore-final.png'));

/* ── Report ─────────────────────────────────────────────────────────────── */
const seen = new Set();
const uniqueErrors = [];
for (const e of pageErrors) {
  const k = `${e.type}:${e.text}`;
  if (seen.has(k)) continue;
  seen.add(k);
  uniqueErrors.push(e);
}
const crashy = uniqueErrors.filter(
  (e) => /EPIPE|Cannot read|TypeError|Unhandled|Uncaught|is not a function/i.test(e.text) && !/DevTools|favicon/i.test(e.text),
);
record('runtime:no renderer exceptions across the whole build', crashy.length === 0, crashy[0]?.text || `${uniqueErrors.length} messages`);
if (crashy.length) {
  note('critical', 'The renderer threw while building a show', crashy[0].text, JSON.stringify(crashy.slice(0, 5)));
}

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;
fs.writeFileSync(
  path.join(AUDIT, 'ui-hardcore-report.json'),
  JSON.stringify(
    { generatedAt: new Date().toISOString(), savePath: SAVE_PATH, summary: { passed, failed, findings: findings.length }, results, findings, consoleErrors: uniqueErrors.slice(0, 20) },
    null,
    2,
  ),
);
console.log(`\n═══ ${passed} passed, ${failed} failed, ${findings.length} findings ═══`);
for (const f of findings) console.log(`  [${f.severity}] ${f.title}`);
console.log(`Report: ${path.join(AUDIT, 'ui-hardcore-report.json')}`);

await close();
process.exitCode = failed > 0 || findings.some((f) => f.severity === 'critical' || f.severity === 'high') ? 1 : 0;
