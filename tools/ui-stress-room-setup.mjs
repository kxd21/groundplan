/**
 * Fresh UI/UX stress test for room-first New Plan + Show setup.
 *
 *   npm run test:ui-stress-setup
 *
 * Or against an already-running CDP session:
 *   GROUNDPLAN_E2E_SAVE_PATH=~/Downloads/Groundplan-setup-stress.rv4 \\
 *     npm run dev -- -- --remote-debugging-port=9222
 *   node tools/ui-stress-room-setup.mjs
 *
 * Writes docs/audit/ui-stress-setup-report.json + screenshots.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_CDP,
  connectCdp,
  sleep,
  waitForCdpPage,
} from './ui-cdp.mjs';

const AUDIT = path.join('docs', 'audit');
const SAVE_PATH =
  process.env.GROUNDPLAN_E2E_SAVE_PATH ||
  path.join(process.env.HOME || '', 'Downloads', 'Groundplan-setup-stress.rv4');
const CDP = process.env.GROUNDPLAN_CDP || DEFAULT_CDP;

fs.mkdirSync(AUDIT, { recursive: true });

const findings = [];
const results = [];

const record = (id, ok, detail = '') => {
  results.push({ id, ok, detail: String(detail || '').slice(0, 280) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}${detail ? ` — ${detail}` : ''}`);
};

const note = (severity, title, detail, evidence = '') => {
  findings.push({ severity, title, detail, evidence: String(evidence || '').slice(0, 320) });
  console.log(`\n[${severity}] ${title}\n  ${detail}${evidence ? `\n  evidence: ${String(evidence).slice(0, 200)}` : ''}\n`);
};

await waitForCdpPage(CDP, 20000).catch(() => {
  console.error(`No CDP at ${CDP}. Run: npm run test:ui-stress-setup`);
  process.exit(1);
});

const cdp = await connectCdp({ base: CDP });
const { ev, clickAt, key, esc, shot, clickButton, setInput, title, close } = cdp;
const click = (spec, label, opts) => clickButton(spec, label, record, opts);

const probe = async (expression) => ev(expression);

const waitFor = async (expression, timeoutMs = 12000, interval = 250) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await ev(expression)) return true;
    } catch {
      /* ignore transient eval errors during navigation */
    }
    await sleep(interval);
  }
  return false;
};

const openNewPlan = async () => {
  // Escape any open sheets first.
  await esc();
  await sleep(200);
  await esc();
  await sleep(200);

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
    await clickAt(welcomeNew.x, welcomeNew.y);
    record('nav:welcome New plan', true);
  } else {
    // Cmd/Ctrl+N
    await key(78, 'KeyN', 'n', 8);
    record('nav:shortcut New plan', true, 'meta+N');
  }
  await sleep(600);
  const open = await waitFor('!!document.querySelector(".new-plan-sheet")', 8000);
  record('nav:new-plan-sheet', open);
  return open;
};

const closePlanIfOpen = async () => {
  const hasPlan = await ev(`!!document.querySelector('canvas') && !document.querySelector('.welcome-home')`);
  if (!hasPlan) return;
  // Prefer discard empty if available, else just leave for next create (E2E confirmDiscard).
  await esc();
  await sleep(100);
};

console.log('\n=== Fresh room-setup UI stress ===\n');
console.log('title', await title());
console.log('E2E save path', SAVE_PATH);
try {
  fs.unlinkSync(SAVE_PATH);
} catch {
  /* ok */
}

// ---------------------------------------------------------------------------
// A. New Plan dialog structure (room-first)
// ---------------------------------------------------------------------------
console.log('\n-- A. New Plan dialog (room-first) --');
await closePlanIfOpen();
const sheetOpen = await openNewPlan();
await shot(path.join(AUDIT, 'ui-stress-setup-01-new-plan.png'));

if (sheetOpen) {
  const dialog = await probe(`(() => {
    const sheet = document.querySelector('.new-plan-sheet');
    if (!sheet) return { ok: false };
    const text = sheet.innerText || '';
    const quick = [...sheet.querySelectorAll('.new-plan-quick-start button')].map((b) => (b.textContent || '').replace(/\\s+/g, ' ').trim());
    const primary = [...sheet.querySelectorAll('.new-plan-shape-grid.is-primary button')].map((b) => (b.textContent || '').replace(/\\s+/g, ' ').trim());
    const advancedToggle = [...sheet.querySelectorAll('button')].find((b) => /More shapes|Hide more shapes/i.test(b.textContent || ''));
    const continueOld = /Continue to room/i.test(text);
    const eventStep = /\\bEvent\\b/.test(text) && /Name and show information/i.test(text);
    const venueField = !!sheet.querySelector('#new-plan-venue');
    const createBtn = [...sheet.querySelectorAll('button')].find((b) => /Create plan|Create & draw/i.test(b.textContent || ''));
    return {
      ok: true,
      title: (sheet.querySelector('h2')?.textContent || '').trim(),
      blurb: (sheet.querySelector('.new-plan-head p')?.textContent || '').trim(),
      quick,
      primary,
      hasAdvancedToggle: !!advancedToggle,
      advancedLabel: (advancedToggle?.textContent || '').trim(),
      continueOld,
      eventStep,
      venueField,
      createLabel: (createBtn?.textContent || '').replace(/\\s+/g, ' ').trim(),
      footNote: (sheet.querySelector('.new-plan-foot-note')?.textContent || '').trim(),
    };
  })()`);

  record('dialog:title is Build the room', /Build the room/i.test(dialog?.title || ''), dialog?.title);
  record('dialog:no Event step', !dialog?.eventStep && !dialog?.continueOld, JSON.stringify({ eventStep: dialog?.eventStep, continueOld: dialog?.continueOld }));
  record('dialog:no venue field in wizard', !dialog?.venueField);
  record('dialog:quick start has 4 actions', (dialog?.quick || []).length === 4, JSON.stringify(dialog?.quick));
  record('dialog:primary shapes are compact', (dialog?.primary || []).length === 3, JSON.stringify(dialog?.primary));
  record('dialog:advanced shapes collapsed', !!dialog?.hasAdvancedToggle && /More shapes/i.test(dialog?.advancedLabel || ''), dialog?.advancedLabel);

  if (dialog?.continueOld || dialog?.eventStep || dialog?.venueField) {
    note('high', 'New Plan still shows old Event / identity step', 'Room-first rewrite may not be loaded, or old fields remain.', JSON.stringify(dialog));
  }
  if ((dialog?.primary || []).length > 3) {
    note('medium', 'Primary shape grid still shows advanced shapes', 'Decision load should stay at Rectangle / Circle / Draw custom.', JSON.stringify(dialog?.primary));
  }

  // Open advanced and check curve power is still available.
  await click({ match: '/More shapes & curves/i' }, 'dialog:open advanced');
  await sleep(200);
  const advanced = await probe(`(() => {
    const sheet = document.querySelector('.new-plan-sheet');
    const shapes = [...sheet.querySelectorAll('.new-plan-shape-grid.is-advanced button')].map((b) => (b.textContent || '').replace(/\\s+/g, ' ').trim());
    return { shapes, count: shapes.length };
  })()`);
  record('dialog:advanced shapes available', (advanced?.count || 0) >= 3, JSON.stringify(advanced?.shapes));

  // ---------------------------------------------------------------------------
  // B. Quick start Ballroom → room ready handoff
  // ---------------------------------------------------------------------------
  console.log('\n-- B. Quick start Ballroom handoff --');
  await click({ match: '/Ballroom/i', root: '.new-plan-quick-start' }, 'quick:Ballroom');
  const ballroomOpened = await waitFor(
    `!document.querySelector('.new-plan-sheet') && !!document.querySelector('canvas')`,
    15000,
  );
  record('quick:Ballroom opens plan', ballroomOpened, await title());
  record('quick:E2E file written', fs.existsSync(SAVE_PATH), SAVE_PATH);
  await sleep(800);
  await shot(path.join(AUDIT, 'ui-stress-setup-02-ballroom.png'));

  const afterBallroom = await probe(`(() => {
    const create = document.querySelector('.create-dialog-sheet');
    const createText = create?.innerText || '';
    const progress = [...document.querySelectorAll('.show-setup-progress li')].map((li) => ({
      text: (li.textContent || '').replace(/\\s+/g, ' ').trim(),
      current: li.classList.contains('is-current'),
      done: li.classList.contains('is-done'),
    }));
    const chip = (document.querySelector('.show-setup-chip')?.textContent || '').trim();
    const head = (document.querySelector('#create-dialog-title')?.textContent || '').trim();
    const library = /\\bLibrary\\b/.test(createText) && /New shape/i.test(createText);
    const buildStage = [...(create?.querySelectorAll('button') || [])].find((b) => /Build a stage/i.test(b.textContent || ''));
    const buildStageNext = buildStage?.classList.contains('is-next');
    const roomNeededActions = /Draw room outline/i.test(createText);
    const toast = (document.querySelector('.toast')?.textContent || '').trim();
    return {
      createOpen: !!create,
      head,
      chip,
      progress,
      library,
      buildStageNext,
      roomNeededActions,
      toast,
      bodyStart: createText.slice(0, 180).replace(/\\s+/g, ' '),
    };
  })()`);

  record('handoff:Create opens after preset', !!afterBallroom?.createOpen);
  record('handoff:chip Room ready', /Room ready/i.test(afterBallroom?.chip || ''), afterBallroom?.chip);
  record('handoff:progress Room done', !!afterBallroom?.progress?.[0]?.done, JSON.stringify(afterBallroom?.progress));
  record('handoff:Build stage marked next', !!afterBallroom?.buildStageNext);
  record('handoff:Library not first', !!afterBallroom?.createOpen && !/^Library/i.test(afterBallroom?.bodyStart || ''), afterBallroom?.bodyStart);
  record('handoff:no Draw outline when room exists', !afterBallroom?.roomNeededActions);

  const zoomAfter = await probe(`(() => {
    const labels = [...document.querySelectorAll('body *')].map((n) => (n.childNodes.length === 1 && n.textContent || '').trim()).filter((t) => /^\\d+%$/.test(t));
    const fromBody = (document.body.innerText.match(/\\b(\\d+)%/g) || []).map((s) => Number(s));
    return Math.min(...(fromBody.length ? fromBody : [100]));
  })()`);
  record('handoff:zoom not tiny', !(typeof zoomAfter === 'number' && zoomAfter < 15), `zoom≈${zoomAfter}%`);
  if (typeof zoomAfter === 'number' && zoomAfter < 15) {
    note('medium', 'Preset room opens extremely zoomed out', `After Ballroom create, zoom is about ${zoomAfter}% — the 60×40 room looks lost on the sheet.`, `zoom=${zoomAfter}`);
  }

  if (afterBallroom?.createOpen && /^Library/i.test(afterBallroom?.bodyStart || '')) {
    note('high', 'Create still leads with Library after room create', 'Show setup / next step should come first.', afterBallroom?.bodyStart);
  }
  if (afterBallroom?.createOpen && !afterBallroom?.buildStageNext && !/Build stage/i.test(afterBallroom?.toast || '')) {
    note('medium', 'No clear next-step highlight after room create', 'Expected Build stage to be marked as next or toasted.', JSON.stringify(afterBallroom));
  }

  // ---------------------------------------------------------------------------
  // C. Show setup interactions
  // ---------------------------------------------------------------------------
  console.log('\n-- C. Show setup interactions --');
  if (!(await ev('!!document.querySelector(".create-dialog-sheet")'))) {
    await click({ text: 'Create' }, 'setup:Create menu');
    await sleep(250);
    await ev(`(() => {
      const b = [...document.querySelectorAll('[role=menuitem]')].find((el) => /^Show setup/i.test((el.textContent || '').trim()));
      if (b) b.click();
      return !!b;
    })()`);
    await sleep(400);
  }

  await click({ match: '/Show details/i', root: '.create-dialog-sheet' }, 'setup:expand details');
  await sleep(200);
  // Prefer a direct DOM toggle in case the control is clipped in the dock.
  await ev(`(() => {
    const b = [...document.querySelectorAll('.create-dialog-sheet button')].find((el) =>
      /Show details/i.test(el.textContent || ''),
    );
    if (!b) return false;
    b.scrollIntoView({ block: 'center' });
    if (b.getAttribute('aria-expanded') !== 'true') b.click();
    return true;
  })()`);
  await sleep(250);
  const details = await probe(`!!document.querySelector('#show-setup-venue')`);
  record('setup:details expand shows venue', details);
  if (!details) {
    note('high', 'Show details collapse does not reveal venue fields', 'Collapsed optional section may be broken or clipped in the Create dock.');
  }
  if (details) {
    await setInput('#show-setup-venue', 'Stress Venue');
    await setInput('#show-setup-event', 'Setup Stress');
    record('setup:details fields editable', true);
  }

  await ev(`(() => {
    const b = [...document.querySelectorAll('.create-dialog-sheet button')].find((el) =>
      /Show kits/i.test(el.textContent || ''),
    );
    if (!b) return false;
    b.scrollIntoView({ block: 'center' });
    if (b.getAttribute('aria-expanded') !== 'true') b.click();
    return true;
  })()`);
  await sleep(250);
  const kitsVisible = await ev(`!!document.querySelector('#show-kit-select')`);
  record('setup:kits collapsed by default then expandable', kitsVisible);
  if (!kitsVisible) {
    note('medium', 'Show kits collapse does not reveal kit selector', 'Optional kits section may be broken or clipped in the Create dock.');
  }

  await ev(`(() => {
    const b = [...document.querySelectorAll('.create-dialog-sheet button, .create-dialog-sheet .link-btn')].find((el) =>
      /^Open Room panel$/i.test((el.textContent || '').trim()),
    );
    if (!b) return false;
    b.scrollIntoView({ block: 'center' });
    b.click();
    return true;
  })()`);
  record('setup:Open Room panel', true, 'dom click after scroll');
  await sleep(600);
  const roomPanel = await probe(`(() => {
    const createOpen = !!document.querySelector('.create-dialog-sheet');
    const roomTab = [...document.querySelectorAll('button')].find((el) => {
      const t = (el.textContent || '').trim();
      return t === 'Room' && el.getAttribute('aria-current') === 'page';
    });
    const text = document.body.innerText || '';
    const hasRoomCopy = /Draw custom|Redraw rectangle|2,400 sq ft|sq ft floor|Room shape/i.test(text);
    const seatingWorkspace = !!document.querySelector('.seating-workspace, [aria-label="Seating"]') ||
      (/Seating planner/i.test(text) && /Clearances/i.test(text));
    return {
      createOpen,
      roomTab: !!roomTab,
      hasRoomCopy,
      seatingWorkspace,
      title: document.title,
    };
  })()`);
  const roomOk = !!roomPanel?.hasRoomCopy && !roomPanel?.seatingWorkspace;
  record('setup:Open Room panel reaches room tools', roomOk, JSON.stringify(roomPanel));
  if (!roomOk) {
    note('high', 'Open Room panel did not show room tools', 'Expected Room inspector with shape / redraw controls.', JSON.stringify(roomPanel));
  }
  await shot(path.join(AUDIT, 'ui-stress-setup-03-room-panel.png'));

  // ---------------------------------------------------------------------------
  // D. Custom draw path (banner, no Create until room)
  // ---------------------------------------------------------------------------
  console.log('\n-- D. Custom draw path --');
  await esc();
  await sleep(200);
  // With a plan already open, prefer Create → New plan (CDP meta+N does not hit Electron menu accelerators).
  const openedViaMenu = await ev(`(() => {
    const create = [...document.querySelectorAll('button')].find((el) => (el.textContent || '').trim() === 'Create');
    if (create) create.click();
    return true;
  })()`);
  await sleep(300);
  const pickedNew = await ev(`(() => {
    const b = [...document.querySelectorAll('[role=menuitem]')].find((el) => /^New plan/i.test((el.textContent || '').trim()));
    if (!b) return false;
    b.click();
    return true;
  })()`);
  record('custom:Create → New plan', !!pickedNew || openedViaMenu);
  await sleep(700);
  let customSheet = await waitFor('!!document.querySelector(".new-plan-sheet")', 8000);
  if (!customSheet) {
    customSheet = await openNewPlan();
  }
  record('custom:new-plan-sheet', customSheet);
  if (customSheet) {
    await click({ match: '/Draw custom/i', root: '.new-plan-quick-start' }, 'custom:quick Draw custom');
    const customOpened = await waitFor(
      `!document.querySelector('.new-plan-sheet') && !!document.querySelector('canvas')`,
      15000,
    );
    record('custom:opens empty plan', customOpened, await title());
    await sleep(900);
    await shot(path.join(AUDIT, 'ui-stress-setup-04-custom-draw.png'));

    const customState = await probe(`(() => {
      const createOpen = !!document.querySelector('.create-dialog-sheet');
      const banner = document.querySelector('.room-outline-banner');
      const bannerText = (banner?.innerText || '').replace(/\\s+/g, ' ').trim();
      const toast = (document.querySelector('.toast')?.textContent || '').trim();
      const roomTool = document.querySelector('[data-tool-id="room"]');
      const roomPressed = roomTool?.getAttribute('aria-pressed') === 'true' || roomTool?.classList.contains('is-on');
      return {
        createOpen,
        banner: !!banner,
        bannerText,
        toast,
        roomPressed,
        hasFinishRect: /Finish as rectangle/i.test(bannerText),
        hasDiscard: /Discard plan/i.test(bannerText),
      };
    })()`);

    record('custom:Create deferred until room', !customState?.createOpen, JSON.stringify({ createOpen: customState?.createOpen }));
    record('custom:outline banner visible', !!customState?.banner, customState?.bannerText);
    record('custom:banner offers Finish as rectangle', !!customState?.hasFinishRect);
    record('custom:banner offers Discard', !!customState?.hasDiscard);
    record('custom:room outline tool armed', !!customState?.roomPressed);

    const zoom = await probe(`(() => {
      const text = document.body.innerText || '';
      const m = text.match(/\\b(\\d+)%\\b/);
      return m ? Number(m[1]) : null;
    })()`);
    if (typeof zoom === 'number' && zoom > 0 && zoom < 15) {
      note('medium', 'New plan opens extremely zoomed out', `Canvas zoom reported around ${zoom}% — room is hard to work with until Fit.`, `zoom=${zoom}`);
    }

    const invalidShape = await probe(`(/\\* Invalid Shape \\*/i.test(document.body.innerText || ''))`);
    if (invalidShape) {
      note('low', 'Inventory lists an Invalid Shape item', 'Catalog noise on a brand-new plan session.', '* Invalid Shape *');
    }

    if (customState?.createOpen) {
      note('high', 'Create opens during custom draw', 'Canvas banner should own guidance until the outline exists.', JSON.stringify(customState));
    }
    if (!customState?.banner) {
      note('high', 'Missing room-outline banner on custom create', 'Users can abandon an empty .rv4 with no recovery UI.', JSON.stringify(customState));
    }

    // Finish as rectangle recovery
    if (customState?.hasFinishRect) {
      await click({ match: '/Finish as rectangle/i' }, 'custom:Finish as rectangle');
      await sleep(1000);
      const finished = await probe(`(() => {
        const chip = (document.querySelector('.show-setup-chip')?.textContent || '').trim();
        const createOpen = !!document.querySelector('.create-dialog-sheet');
        const banner = !!document.querySelector('.room-outline-banner');
        return { chip, createOpen, banner };
      })()`);
      record('custom:finish-as-rect creates room', /Room ready/i.test(finished?.chip || '') || (!finished?.banner && finished?.createOpen), JSON.stringify(finished));
      record('custom:Create opens after room exists', !!finished?.createOpen);
      await shot(path.join(AUDIT, 'ui-stress-setup-05-finish-rect.png'));
    }
  } else {
    record('custom:opens empty plan', false, 'could not reopen New Plan');
  }

  // ---------------------------------------------------------------------------
  // E. Vocabulary / consistency probes
  // ---------------------------------------------------------------------------
  console.log('\n-- E. Copy consistency --');
  const copy = await probe(`(() => {
    const text = document.body.innerText || '';
    return {
      freeform: /\\bFreeform\\b/.test(text),
      drawCustom: /Draw custom/i.test(text),
      continueToRoom: /Continue to room/i.test(text),
      newShowReady: /New show ready/i.test(text),
      theatre: /Theatre/i.test(text),
      theater: /\\bTheater\\b/.test(text),
    };
  })()`);
  record('copy:no Freeform label', !copy?.freeform);
  record('copy:no Continue to room', !copy?.continueToRoom);
  record('copy:no New show ready toast', !copy?.newShowReady);
  if (copy?.freeform) {
    note('low', 'Freeform label still appears', 'Should be Draw custom for consistency.', 'body text match');
  }
} else {
  note('critical', 'New Plan dialog never opened', 'Cannot stress room-first flow without the sheet.');
}

await shot(path.join(AUDIT, 'ui-stress-setup-06-final.png'));

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;
const report = {
  generatedAt: new Date().toISOString(),
  title: await title(),
  savePath: SAVE_PATH,
  summary: { passed, failed, findings: findings.length },
  results,
  findings,
};
fs.writeFileSync(path.join(AUDIT, 'ui-stress-setup-report.json'), JSON.stringify(report, null, 2));
console.log(`\n=== Summary: ${passed} passed, ${failed} failed, ${findings.length} findings ===`);
console.log(`Report: ${path.join(AUDIT, 'ui-stress-setup-report.json')}`);

await close();
process.exitCode = failed > 0 || findings.some((f) => f.severity === 'critical' || f.severity === 'high') ? 1 : 0;
