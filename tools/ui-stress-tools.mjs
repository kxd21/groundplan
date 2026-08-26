/**
 * Every tool in the plan dock, used the way it is meant to be used.
 *
 *   npm run test:ui-tools
 *
 * Arms each tool from the dock, performs its gesture on the canvas, and checks
 * the plan actually gained what the tool promises. A tool that arms, shows a
 * banner and produces nothing is the failure this is built to catch — it looks
 * like it is working right up until you save.
 */
import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_CDP, connectCdp, sleep, waitForCdpPage } from './ui-cdp.mjs';

const AUDIT = path.join('docs', 'audit');
const CDP = process.env.GROUNDPLAN_CDP || DEFAULT_CDP;
fs.mkdirSync(AUDIT, { recursive: true });

const results = [];
const findings = [];
const record = (id, ok, detail = '') => {
  results.push({ id, ok, detail: String(detail ?? '').slice(0, 240) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}${detail ? ` — ${String(detail).slice(0, 140)}` : ''}`);
};
const note = (severity, title, detail) => {
  findings.push({ severity, title, detail });
  console.log(`\n[${severity}] ${title}\n  ${detail}\n`);
};

await waitForCdpPage(CDP, 20000).catch(() => {
  console.error(`No CDP at ${CDP}. Run: npm run test:ui-tools`);
  process.exit(1);
});

const cdp = await connectCdp({ base: CDP });
const { ev, key, esc, shot, close, pageErrors, canvasClickFt } = cdp;

const waitFor = async (expr, ms = 12000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await ev(expr)) return true; } catch { /* re-render */ }
    await sleep(250);
  }
  return false;
};

/** Counts every named object on the plan, via the main process. */
const total = () =>
  ev(`(async () => { const s = await window.groundplan.scheduleBuild(); return (s?.groups||[]).reduce((a,g)=>a+g.count,0); })()`);

/**
 * Everything drawn.
 *
 * `itemCount` counts PLACED ITEMS only, so it cannot move when a line or a
 * dimension is drawn — using it made every drawing tool look broken when the
 * tools were fine and the counter was wrong.
 */
const primitives = () =>
  ev(`(async () => { const m = await window.groundplan.planModel(); return m.primitiveCount; })()`);

const armTool = async (id) => {
  const ok = await ev(`(() => {
    const b = document.querySelector('[data-tool-id=${JSON.stringify(id)}]');
    if (!b || b.disabled) return false;
    b.click();
    return true;
  })()`);
  await sleep(500);
  return ok;
};

const armed = (id) =>
  ev(`(() => {
    const b = document.querySelector('[data-tool-id=${JSON.stringify(id)}]');
    if (!b) return null;
    return b.getAttribute('aria-pressed') === 'true' || b.classList.contains('is-on') || b.classList.contains('active');
  })()`);

const bannerText = () =>
  ev(`(document.querySelector('.tool-banner, .plan-banner, [class*="banner"]')?.innerText || '').replace(/\\n/g, ' | ').trim()`);

console.log('\n═══ Plan tools ═══\n');

// A room to draw inside, made the way a user makes one. Calling `newPlan` over
// IPC opens it in the MAIN process and leaves the renderer on the welcome
// screen, so the whole dock is absent and every check below blames the tools
// for the harness's shortcut.
await esc(); await sleep(300);
let haveCanvas = await ev(`!!document.querySelector('canvas')`);
if (!haveCanvas) {
  await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find((e) => (e.textContent || '').trim() === 'New plan');
    if (b) b.click();
    return !!b;
  })()`);
  await waitFor(`!!document.querySelector('.new-plan-sheet')`, 10000);
  // Ballroom is a room big enough to draw in, and three clicks from here.
  await ev(`(() => {
    const b = [...document.querySelectorAll('.new-plan-quick-start button')].find((e) => /Ballroom/i.test(e.textContent || ''));
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(500);
  for (let step = 0; step < 3; step++) {
    await ev(`(() => { const b = document.querySelector('.new-plan-foot .primary'); if (b && !b.disabled) b.click(); return true; })()`);
    await sleep(1100);
  }
  haveCanvas = await waitFor(`!document.querySelector('.new-plan-sheet') && !!document.querySelector('canvas')`, 30000);
  await sleep(3500);
}
record('setup:a plan is open', haveCanvas, await ev(`document.title`));
if (!haveCanvas) {
  note('critical', 'No plan could be created', 'Nothing below can be tested.');
}

// The dock has to be showing.
await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find((e) => /^All canvas tools$|^Draw$/i.test((e.textContent||'').trim()));
  if (b) b.click();
  return true;
})()`);
await sleep(900);

const dockTools = await ev(`[...document.querySelectorAll('[data-tool-id]')].map((b) => ({
  id: b.getAttribute('data-tool-id'),
  label: (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 40),
  disabled: !!b.disabled,
}))`);
record('dock:tools are on screen', (dockTools || []).length >= 8, JSON.stringify((dockTools || []).map((t) => t.id)));
const enabled = (dockTools || []).filter((t) => !t.disabled).map((t) => t.id);
record('dock:none of them are dead on an editable plan', (dockTools || []).every((t) => !t.disabled), JSON.stringify((dockTools||[]).filter((t)=>t.disabled).map((t)=>t.id)));

/* Each tool: arm it, use it, check the plan changed. ---------------------- */
const gestures = {
  line:      { clicks: [[-20, -10], [-10, -10]], grows: 'primitives' },
  rect:      { clicks: [[-20, 0], [-10, 6]],     grows: 'primitives' },
  ellipse:   { clicks: [[0, 0], [8, 6]],         grows: 'primitives' },
  dimension: { clicks: [[-20, 12], [-6, 12]],    grows: 'primitives' },
  'power-cable':  { clicks: [[-30, -14], [-20, -14], [-20, -6]], finish: true, grows: 'primitives' },
  'signal-cable': { clicks: [[-30, 14], [-18, 14], [-18, 8]],    finish: true, grows: 'primitives' },
};

for (const [id, gesture] of Object.entries(gestures)) {
  if (!enabled.includes(id)) { record(`${id}:present in the dock`, false, 'not found or disabled'); continue; }
  const before = gesture.grows === 'primitives' ? await primitives() : await total();
  const ok = await armTool(id);
  record(`${id}:arms`, ok);
  record(`${id}:reports itself armed`, (await armed(id)) === true, await bannerText());

  for (const [x, y] of gesture.clicks) {
    await canvasClickFt(x, y);
    await sleep(450);
  }
  if (gesture.finish) { await key(13, 'Enter', 'Enter'); await sleep(1500); }
  await sleep(1200);

  const after = gesture.grows === 'primitives' ? await primitives() : await total();
  record(`${id}:puts something on the plan`, after > before, `${before} → ${after}`);
  if (!(after > before)) {
    note('high', `The ${id} tool produced nothing`, `Armed, showed its banner, took ${gesture.clicks.length} clicks, and the plan did not change.`);
  }
  await esc(); await sleep(300); await esc(); await sleep(300);
}

/* The cable tool must stay in hand for a second run. ---------------------- */
{
  const before = await primitives();
  await armTool('power-cable');
  for (const [x, y] of [[10, -14], [20, -14], [20, -8]]) { await canvasClickFt(x, y); await sleep(400); }
  await key(13, 'Enter', 'Enter');
  await sleep(2000);
  const stillArmed = await armed('power-cable');
  record('power-cable:stays in hand after a run', stillArmed === true, `armed=${stillArmed}`);
  // …and the second run works without going back to the rail.
  for (const [x, y] of [[10, 18], [22, 18], [22, 10]]) { await canvasClickFt(x, y); await sleep(400); }
  await key(13, 'Enter', 'Enter');
  await sleep(2000);
  const after = await primitives();
  record('power-cable:a second run needs no re-pick', after > before + 2, `${before} → ${after}`);
  if (!(after > before + 2)) {
    note('high', 'A second cable run could not be drawn', 'The tool did not stay in hand, or the second run placed nothing.');
  }
  await esc(); await sleep(300); await esc(); await sleep(400);
}

/* Measure is the one tool that must NOT change the plan. ------------------ */
{
  const before = await primitives();
  await armTool('measure');
  record('measure:arms', (await armed('measure')) === true);
  await canvasClickFt(-24, -18); await sleep(400);
  await canvasClickFt(-8, -18);  await sleep(900);
  const readout = await ev(`/\\d/.test(document.body.innerText.match(/[^\\n]*(ft|″|')[^\\n]*/)?.[0] || '')`);
  record('measure:shows a reading', !!readout);
  const after = await primitives();
  record('measure:changes nothing on the plan', after === before, `${before} → ${after}`);
  if (after !== before) {
    note('high', 'Measuring altered the drawing', 'A temporary measurement must not become part of the plan.');
  }
  await esc(); await sleep(400);
}

/* Escape puts every tool down. ------------------------------------------- */
for (const id of enabled) {
  if (id === 'select') continue;
  await armTool(id);
  await esc(); await sleep(250); await esc(); await sleep(350);
  const stuck = await armed(id);
  record(`${id}:Escape puts it down`, stuck !== true, `armed=${stuck}`);
  if (stuck === true) note('high', `The ${id} tool cannot be put down with Escape`, 'The user is stuck holding it.');
}

await shot(path.join(AUDIT, 'ui-tools-final.png'));

const seen = new Set();
const errors = [];
for (const e of pageErrors) {
  const k = `${e.type}:${e.text}`;
  if (seen.has(k)) continue;
  seen.add(k);
  errors.push(e);
}
const crashy = errors.filter((e) => /Cannot read|TypeError|Unhandled|Uncaught|is not a function/i.test(e.text) && !/DevTools|favicon/i.test(e.text));
record('runtime:no exceptions while using the tools', crashy.length === 0, crashy[0]?.text || `${errors.length} messages`);
if (crashy.length) note('critical', 'The renderer threw while a tool was in use', crashy[0].text);

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;
fs.writeFileSync(
  path.join(AUDIT, 'ui-tools-report.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), summary: { passed, failed, findings: findings.length }, results, findings }, null, 2),
);
console.log(`\n═══ ${passed} passed, ${failed} failed, ${findings.length} findings ═══`);
for (const f of findings) console.log(`  [${f.severity}] ${f.title}`);

await close();
process.exitCode = failed > 0 || findings.some((f) => f.severity === 'critical' || f.severity === 'high') ? 1 : 0;
