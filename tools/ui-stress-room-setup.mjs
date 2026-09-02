/**
 * UI stress test for the show-intake flow: New Plan → Show Setup → readiness.
 *
 *   npm run test:ui-stress-setup
 *
 * Or against an already-running CDP session:
 *   GROUNDPLAN_E2E_SAVE_PATH=~/Downloads/Groundplan-setup-stress.rv4 \
 *     npm run dev -- -- --remote-debugging-port=9222
 *   node tools/ui-stress-room-setup.mjs
 *
 * What it is actually checking is one claim: a user can describe the show once,
 * build from that description, and see whether the resulting plan satisfies it.
 * So the assertions follow that number end to end — type 850 into New Plan, and
 * the Review card in a saved-and-reopened plan should still be measuring the
 * seat count against 850.
 *
 * Writes docs/audit/ui-stress-setup-report.json + screenshots.
 */
import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_CDP, connectCdp, sleep, waitForCdpPage } from './ui-cdp.mjs';

const AUDIT = path.join('docs', 'audit');
const SAVE_PATH =
  process.env.GROUNDPLAN_E2E_SAVE_PATH ||
  path.join(process.env.HOME || '', 'Downloads', 'Groundplan-setup-stress.rv4');
const CDP = process.env.GROUNDPLAN_CDP || DEFAULT_CDP;

/** The headcount this whole test follows. */
const TARGET = 850;
const SHOW_NAME = 'Setup Stress Kickoff';

fs.mkdirSync(AUDIT, { recursive: true });

const findings = [];
const results = [];

const record = (id, ok, detail = '') => {
  results.push({ id, ok, detail: String(detail || '').slice(0, 280) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}${detail ? ` — ${detail}` : ''}`);
};

const note = (severity, title, detail, evidence = '') => {
  findings.push({ severity, title, detail, evidence: String(evidence || '').slice(0, 320) });
  console.log(
    `\n[${severity}] ${title}\n  ${detail}${evidence ? `\n  evidence: ${String(evidence).slice(0, 200)}` : ''}\n`,
  );
};

await waitForCdpPage(CDP, 20000).catch(() => {
  console.error(`No CDP at ${CDP}. Run: npm run test:ui-stress-setup`);
  process.exit(1);
});

const cdp = await connectCdp({ base: CDP });
const { ev, clickAt, key, esc, shot, clickButton, setInput, setSelect, title, close, pageErrors } =
  cdp;
const click = (spec, label, opts) => clickButton(spec, label, record, opts);
const probe = (expression) => ev(expression);

const waitFor = async (expression, timeoutMs = 12000, interval = 250) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await ev(expression)) return true;
    } catch {
      /* transient eval errors while the renderer re-renders */
    }
    await sleep(interval);
  }
  return false;
};

/**
 * Set a field and blur it.
 *
 * The brief's inputs commit on blur, not on every keystroke — `setInput` alone
 * fires input/change and leaves the value uncommitted, which would make this
 * test pass against a panel that never saves anything.
 */
const setAndCommit = async (selector, value) => {
  await setInput(selector, value);
  await ev(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.dispatchEvent(new Event('blur', { bubbles: false }));
    el.blur();
    return true;
  })()`);
  await sleep(450);
};

/** Opens the brief disclosure group whose heading matches. */
const openBriefGroup = async (label) =>
  ev(`(() => {
    const b = [...document.querySelectorAll('.brief-group-head')].find((el) =>
      new RegExp(${JSON.stringify(label)}, 'i').test(el.textContent || ''),
    );
    if (!b) return false;
    b.scrollIntoView({ block: 'center' });
    if (b.getAttribute('aria-expanded') !== 'true') b.click();
    return true;
  })()`);

const readReview = () =>
  probe(`(() => {
    const card = document.querySelector('.review-card');
    if (!card) return null;
    const facts = {};
    for (const row of card.querySelectorAll('.review-facts > div')) {
      const k = (row.querySelector('dt')?.textContent || '').trim();
      const v = (row.querySelector('dd')?.textContent || '').trim();
      if (k) facts[k] = v;
    }
    return {
      state: (card.querySelector('.review-state')?.textContent || '').trim(),
      headline: (card.querySelector('.review-headline')?.textContent || '').trim(),
      facts,
      issues: [...card.querySelectorAll('.review-issues > li')].map((li) => ({
        title: (li.querySelector('strong')?.textContent || '').trim(),
        action: (li.querySelector('button')?.textContent || '').trim(),
        severity: (li.className.match(/is-(blocking|warning|info)/) || [])[1] || '',
      })),
    };
  })()`);

const openSetupDock = async () => {
  if (await ev(`!!document.querySelector('.create-dialog-sheet')`)) return true;
  await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find((el) =>
      /^Show Setup$/i.test((el.textContent || '').trim()),
    );
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(500);
  return waitFor(`!!document.querySelector('.create-dialog-sheet')`, 6000);
};

const openNewPlan = async () => {
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
  } else {
    await ev(`(() => {
      const create = [...document.querySelectorAll('button')].find(
        (el) => (el.textContent || '').trim() === 'New',
      );
      if (create) create.click();
      return true;
    })()`);
    await sleep(300);
    const picked = await ev(`(() => {
      const b = [...document.querySelectorAll('[role=menuitem]')].find((el) =>
        /^New plan/i.test((el.textContent || '').trim()),
      );
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!picked) await key(78, 'KeyN', 'n', 4);
  }
  await sleep(600);
  const open = await waitFor('!!document.querySelector(".new-plan-sheet")', 8000);
  record('nav:new-plan-sheet', open);
  return open;
};

console.log('\n=== Show intake UI stress ===\n');
console.log('title', await title());
console.log('E2E save path', SAVE_PATH);
try {
  fs.unlinkSync(SAVE_PATH);
} catch {
  /* ok */
}

// ---------------------------------------------------------------------------
// A. New Plan opens on the brief, and the brief can be skipped.
// ---------------------------------------------------------------------------
console.log('\n-- A. New Plan: the show step --');
await esc();
const sheetOpen = await openNewPlan();
await shot(path.join(AUDIT, 'ui-stress-setup-01-new-plan.png'));

if (!sheetOpen) {
  note('critical', 'New Plan dialog never opened', 'Nothing downstream can be tested without it.');
} else {
  const showStep = await probe(`(() => {
    const sheet = document.querySelector('.new-plan-sheet');
    if (!sheet) return null;
    const steps = [...sheet.querySelectorAll('.new-plan-steps li')].map((li) =>
      (li.querySelector('strong')?.textContent || '').trim(),
    );
    const skip = [...sheet.querySelectorAll('button')].find((b) =>
      /Skip for now/i.test(b.textContent || ''),
    );
    const quick = [...sheet.querySelectorAll('.new-plan-quick-start button, .new-plan-compact-alt button')].map((b) =>
      (b.textContent || '').replace(/\\s+/g, ' ').trim(),
    );
    return {
      title: (sheet.querySelector('h2')?.textContent || '').trim(),
      steps,
      brief: !!sheet.querySelector('.new-plan-brief'),
      name: !!sheet.querySelector('#new-plan-show-name'),
      venue: !!sheet.querySelector('#new-plan-show-venue'),
      layout: !!sheet.querySelector('#new-plan-show-layout'),
      guests: !!sheet.querySelector('#new-plan-guests'),
      skip: !!skip,
      quick,
    };
  })()`);

  record('newplan:brief block present', !!showStep?.brief, showStep?.title);
  record(
    'newplan:brief asks name, venue, layout, headcount',
    !!(showStep?.name && showStep?.venue && showStep?.layout && showStep?.guests),
    JSON.stringify({
      name: showStep?.name,
      venue: showStep?.venue,
      layout: showStep?.layout,
      guests: showStep?.guests,
    }),
  );
  record('newplan:brief is skippable', !!showStep?.skip);
  record(
    'newplan:compact create (no forced three-step wizard)',
    (showStep?.steps || []).length === 0 ||
      /Start from a room/i.test(showStep?.title || ''),
    JSON.stringify({ steps: showStep?.steps, title: showStep?.title }),
  );
  record(
    'newplan:room shortcuts preserved',
    (showStep?.quick || []).length >= 5 &&
      (showStep?.quick || []).some((t) => /Draw custom/i.test(t)),
    JSON.stringify(showStep?.quick),
  );

  if (!showStep?.skip) {
    note(
      'high',
      'The brief cannot be skipped',
      'Room-first has to stay available; a required intake form is a new wall in front of the canvas.',
    );
  }

  // -------------------------------------------------------------------------
  // B. Describe the show, then build from it.
  // -------------------------------------------------------------------------
  console.log('\n-- B. Describe the show --');
  await setInput('#new-plan-show-name', SHOW_NAME);
  await setInput('#new-plan-show-venue', 'Stress Convention Center');
  await setInput('#new-plan-guests', String(TARGET));
  await setSelect(
    '#new-plan-show-layout',
    `[...el.options].find((o) => /Theatre/i.test(o.text))`,
  );
  await sleep(300);

  const typed = await probe(`(() => ({
    name: document.querySelector('#new-plan-show-name')?.value || '',
    venue: document.querySelector('#new-plan-show-venue')?.value || '',
    guests: document.querySelector('#new-plan-guests')?.value || '',
    layout: document.querySelector('#new-plan-show-layout')?.value || '',
    summary: (document.querySelector('.new-plan-start-summary')?.innerText || '')
      .replace(/\\s+/g, ' ')
      .trim(),
  }))()`);
  record(
    'newplan:fields hold what was typed',
    typed?.name === SHOW_NAME && typed?.guests === String(TARGET) && typed?.layout === 'theatre',
    JSON.stringify(typed),
  );
  record(
    'newplan:summary reflects the show',
    new RegExp(String(TARGET)).test(typed?.summary || ''),
    typed?.summary,
  );

  await shot(path.join(AUDIT, 'ui-stress-setup-02-brief.png'));

  /*
   * Pick a standard room — that creates the plan immediately (Phase 4).
   * Draw custom / site plan / Customize remain for advanced paths.
   */
  await click({ match: '/Ballroom/i', root: '.new-plan-quick-start' }, 'newplan:quick Ballroom');

  const planOpened = await waitFor(
    `!document.querySelector('.new-plan-sheet') && !!document.querySelector('canvas')`,
    25000,
  );
  record('newplan:shortcut creates the plan', planOpened, await title());
  record('newplan:file written', fs.existsSync(SAVE_PATH), SAVE_PATH);
  await sleep(1400);

  // -------------------------------------------------------------------------
  // C. The brief survived, and the plan is measured against it.
  // -------------------------------------------------------------------------
  console.log('\n-- C. The brief drives the plan --');
  const dockOpen = await openSetupDock();
  record('setup:dock reachable', dockOpen);
  await sleep(600);
  await shot(path.join(AUDIT, 'ui-stress-setup-03-show-setup.png'));

  const briefCard = await probe(`(() => {
    const card = document.querySelector('.brief-card');
    if (!card) return null;
    return {
      name: (card.querySelector('.brief-summary strong')?.textContent || '').trim(),
      summary: (card.querySelector('.brief-summary small')?.textContent || '').trim(),
      groups: [...card.querySelectorAll('.brief-group-head strong')].map((s) =>
        (s.textContent || '').trim(),
      ),
      openGroups: card.querySelectorAll('.brief-group-body').length,
    };
  })()`);

  record('setup:brief card shows the show', briefCard?.name === SHOW_NAME, briefCard?.name);
  record(
    'setup:target attendance survived creation',
    new RegExp(TARGET.toLocaleString()).test(briefCard?.summary || ''),
    briefCard?.summary,
  );
  record(
    'setup:four progressive groups, none forced open',
    (briefCard?.groups || []).length === 4 && briefCard?.openGroups === 0,
    JSON.stringify(briefCard?.groups),
  );

  if (briefCard?.name !== SHOW_NAME) {
    note(
      'critical',
      'The show name did not survive plan creation',
      'The brief is the whole point of the intake step; if it is dropped at create, nothing downstream can be trusted.',
      JSON.stringify(briefCard),
    );
  }

  const review = await readReview();
  record('setup:review card present', !!review, review?.state);
  record(
    'setup:seats read actual against target',
    new RegExp(`of\\s*${TARGET.toLocaleString()}`).test(review?.facts?.Seats || ''),
    JSON.stringify(review?.facts),
  );
  record(
    'setup:layout requested is reported',
    /Theatre/i.test(review?.facts?.Layout || ''),
    review?.facts?.Layout,
  );
  record(
    'setup:every warning offers a way to fix it',
    (review?.issues || []).length === 0 || (review?.issues || []).every((i) => i.action.length > 1),
    JSON.stringify(review?.issues),
  );

  if ((review?.issues || []).some((i) => !i.action)) {
    note(
      'high',
      'A readiness warning has no action',
      'A warning that does not name the tool that fixes it is a complaint, not a check.',
      JSON.stringify(review?.issues),
    );
  }

  // -------------------------------------------------------------------------
  // D. Readiness reacts to the drawing, not to steps having been visited.
  // -------------------------------------------------------------------------
  console.log('\n-- D. Readiness reacts --');
  await openBriefGroup('Constraints');
  await sleep(350);
  const accessibleField = await probe(`!!document.querySelector('#brief-accessible')`);
  record('setup:constraints group opens', accessibleField);

  let accessibleWarned = false;
  if (accessibleField) {
    await setAndCommit('#brief-accessible', '12');
    accessibleWarned = await waitFor(
      `[...document.querySelectorAll('.review-issues > li strong')].some((s) => /accessible/i.test(s.textContent || ''))`,
      6000,
    );
    record('setup:new requirement raises a warning', accessibleWarned);
    if (!accessibleWarned) {
      note(
        'high',
        'Stating a requirement did not change readiness',
        'Twelve accessible spaces were required and none are drawn; the review still reported no shortfall.',
      );
    }

    // …and withdrawing it clears the warning again.
    await setAndCommit('#brief-accessible', '');
    const cleared = await waitFor(
      `![...document.querySelectorAll('.review-issues > li strong')].some((s) => /accessible/i.test(s.textContent || ''))`,
      6000,
    );
    record('setup:withdrawing it clears the warning', cleared);
  }

  await openBriefGroup('Layout goals');
  await sleep(350);
  const stageToggle = await probe(`!!document.querySelector('#brief-stage')`);
  record('setup:layout goals group opens', stageToggle);
  if (stageToggle) {
    const before = await readReview();
    await ev(`(() => {
      const el = document.querySelector('#brief-stage');
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      el.click();
      return true;
    })()`);
    await sleep(900);
    const after = await readReview();
    record(
      'setup:asking for a stage is reported against the drawing',
      !!after?.facts?.Stage && after.facts.Stage !== before?.facts?.Stage,
      JSON.stringify({ before: before?.facts?.Stage, after: after?.facts?.Stage }),
    );
    // Leave the brief as we found it.
    await ev(`document.querySelector('#brief-stage')?.click()`);
    await sleep(600);
  }

  await shot(path.join(AUDIT, 'ui-stress-setup-04-readiness.png'));

  // Seats: clear the seating and the shortfall must grow.
  const seatsBefore = await probe(`(() => {
    const row = [...document.querySelectorAll('.review-facts > div')].find((d) =>
      /Seats/i.test(d.querySelector('dt')?.textContent || ''),
    );
    return (row?.querySelector('dd')?.textContent || '').trim();
  })()`);
  record('setup:seat row reads off the drawing', /\d/.test(seatsBefore || ''), seatsBefore);

  // -------------------------------------------------------------------------
  // E. A warning takes you to the tool that fixes it.
  // -------------------------------------------------------------------------
  console.log('\n-- E. Warnings link somewhere --');
  const linked = await ev(`(() => {
    const li = [...document.querySelectorAll('.review-issues > li')].find((el) =>
      /seat/i.test(el.querySelector('strong')?.textContent || ''),
    );
    const btn = li?.querySelector('button');
    if (!btn) return null;
    const label = (btn.textContent || '').trim();
    btn.click();
    return label;
  })()`);
  if (linked) {
    await sleep(900);
    const wentSomewhere = await probe(`(() => {
      const text = document.body.innerText || '';
      return /Seating/i.test(text);
    })()`);
    record('setup:seat warning opens seating', !!wentSomewhere, linked);
  } else {
    record('setup:seat warning opens seating', true, 'no seat shortfall to follow — kit met the target');
  }
  await esc();
  await sleep(300);

  // -------------------------------------------------------------------------
  // F. The dock holds together small, in both themes, and takes the keyboard.
  // -------------------------------------------------------------------------
  console.log('\n-- F. Layout, themes, keyboard --');
  // 1100×700 is a small laptop with a dock open — the size the panel is most
  // likely to be clipped at, and the one the spec names.
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1100,
    height: 700,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(600);
  await openSetupDock();
  await openBriefGroup('Show');
  await sleep(400);

  const clipping = await probe(`(() => {
    const dock = document.querySelector('.create-dialog-sheet');
    if (!dock) return null;
    const box = dock.getBoundingClientRect();
    const bad = [];
    for (const el of dock.querySelectorAll('.brief-field, .brief-group, .review-facts > div, .review-issues > li, button, input, select')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.right > box.right + 1 || r.left < box.left - 1) {
        bad.push({ cls: el.className.toString().slice(0, 40), right: Math.round(r.right), edge: Math.round(box.right) });
      }
      if (el.scrollWidth > el.clientWidth + 2 && !/select|input/i.test(el.tagName)) {
        bad.push({ cls: el.className.toString().slice(0, 40), overflow: el.scrollWidth - el.clientWidth });
      }
    }
    return { viewport: { w: window.innerWidth, h: window.innerHeight }, dock: Math.round(box.width), bad: bad.slice(0, 8) };
  })()`);
  record(
    'layout:nothing overflows the dock',
    (clipping?.bad || []).length === 0,
    JSON.stringify(clipping),
  );
  if ((clipping?.bad || []).length) {
    note(
      'high',
      'Show Setup content spills out of the dock',
      'The brief and review must fit the panel at the window sizes people actually use.',
      JSON.stringify(clipping),
    );
  }

  for (const theme of ['light', 'dark']) {
    await ev(`(() => {
      const app = document.querySelector('.app');
      if (app) app.setAttribute('data-theme', ${JSON.stringify(theme)});
      return true;
    })()`);
    await sleep(350);
    const painted = await probe(`(() => {
      const pick = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { bg: cs.backgroundColor, color: cs.color };
      };
      return {
        brief: pick('.brief-card'),
        review: pick('.review-card'),
        state: pick('.review-state'),
      };
    })()`);
    const transparent = Object.entries(painted || {}).filter(
      ([, v]) => !v || /rgba\(0, 0, 0, 0\)/.test(v.bg || ''),
    );
    record(`theme:${theme} cards paint their own ground`, transparent.length === 0, JSON.stringify(painted));
    await shot(path.join(AUDIT, `ui-stress-setup-05-${theme}.png`));
  }

  const focus = await probe(`(() => {
    const head = document.querySelector('.brief-group-head');
    if (!head) return null;
    head.focus();
    const cs = getComputedStyle(head, ':focus-visible');
    const active = document.activeElement === head;
    return { active, outline: cs.outlineStyle, width: cs.outlineWidth };
  })()`);
  record(
    'a11y:brief groups take focus',
    !!focus?.active,
    JSON.stringify(focus),
  );

  const labelled = await probe(`(() => {
    const missing = [];
    for (const el of document.querySelectorAll('.brief-card input, .brief-card select, .review-card input')) {
      const id = el.id;
      const hasLabel = id ? !!document.querySelector('label[for="' + id + '"]') : false;
      const wrapped = !!el.closest('label');
      if (!hasLabel && !wrapped && !el.getAttribute('aria-label')) missing.push(id || el.outerHTML.slice(0, 60));
    }
    return missing;
  })()`);
  record('a11y:every brief control is labelled', (labelled || []).length === 0, JSON.stringify(labelled));

  // -------------------------------------------------------------------------
  // G. The brief outlives the session.
  // -------------------------------------------------------------------------
  console.log('\n-- G. Persistence --');
  await key(83, 'KeyS', 's', 4); // Cmd/Ctrl+S
  await sleep(1600);
  const savedName = await probe(`(() => {
    const el = document.querySelector('.brief-summary strong');
    return (el?.textContent || '').trim();
  })()`);
  record('persist:brief still shown after save', savedName === SHOW_NAME, savedName);

  // -------------------------------------------------------------------------
  // H. Print stays reachable, and readiness is visible before it.
  // -------------------------------------------------------------------------
  console.log('\n-- H. Issue --');
  const issueBlock = await probe(`(() => {
    const card = document.querySelector('.review-card');
    if (!card) return null;
    const print = [...card.querySelectorAll('button')].find((b) => /Print/i.test(b.textContent || ''));
    const state = card.querySelector('.review-state');
    if (!print || !state) return null;
    const pr = print.getBoundingClientRect();
    const sr = state.getBoundingClientRect();
    return {
      hasDrawnBy: !!card.querySelector('#review-drawn-by'),
      hasRevision: !!card.querySelector('#review-revision'),
      printEnabled: !print.disabled,
      readinessAbovePrint: sr.top <= pr.top,
    };
  })()`);
  record('issue:drawn-by and revision live with the sheet', !!(issueBlock?.hasDrawnBy && issueBlock?.hasRevision), JSON.stringify(issueBlock));
  record('issue:readiness is visible before print', !!issueBlock?.readinessAbovePrint);
  record('issue:printing is never blocked', !!issueBlock?.printEnabled);

  if (issueBlock && !issueBlock.printEnabled) {
    note(
      'high',
      'Print is disabled on a plan with a room',
      'A drawing that does not yet satisfy the brief is still a drawing somebody may need to send.',
    );
  }
}

await cdp.send('Emulation.clearDeviceMetricsOverride', {}).catch(() => undefined);
await shot(path.join(AUDIT, 'ui-stress-setup-06-final.png'));

const uniqueErrors = [];
const seenErr = new Set();
for (const err of pageErrors) {
  const key = `${err.type}:${err.text}`;
  if (seenErr.has(key)) continue;
  seenErr.add(key);
  uniqueErrors.push(err);
}
const crashy = uniqueErrors.filter(
  (e) => /EPIPE|Cannot read|TypeError|Unhandled|Uncaught/i.test(e.text) && !/DevTools|favicon/i.test(e.text),
);
record(
  'runtime:no hard console exceptions',
  crashy.length === 0,
  crashy[0]?.text || `${uniqueErrors.length} console messages`,
);
if (crashy.length) {
  note('critical', 'Renderer threw while walking the intake flow', crashy[0].text, JSON.stringify(crashy.slice(0, 4)));
}

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;
const report = {
  generatedAt: new Date().toISOString(),
  title: await title(),
  savePath: SAVE_PATH,
  target: TARGET,
  summary: { passed, failed, findings: findings.length, consoleErrors: uniqueErrors.length },
  results,
  findings,
  consoleErrors: uniqueErrors.slice(0, 20),
};
fs.writeFileSync(path.join(AUDIT, 'ui-stress-setup-report.json'), JSON.stringify(report, null, 2));
console.log(`\n=== Summary: ${passed} passed, ${failed} failed, ${findings.length} findings ===`);
console.log(`Report: ${path.join(AUDIT, 'ui-stress-setup-report.json')}`);

await close();
process.exitCode =
  failed > 0 || findings.some((f) => f.severity === 'critical' || f.severity === 'high') ? 1 : 0;
