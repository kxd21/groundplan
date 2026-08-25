/**
 * Whole-app usability + responsiveness audit over CDP.
 *
 *   npm run test:ui-usability
 *   # or against a live CDP session:
 *   GROUNDPLAN_KEEP_CDP=1 node tools/ui-stress-usability.mjs
 *
 * Writes docs/audit/ui-usability-report.json + screenshots.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { DEFAULT_CDP, connectCdp, sleep, waitForCdpPage } from './ui-cdp.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUDIT = path.join(ROOT, 'docs', 'audit');
const CDP = process.env.GROUNDPLAN_CDP || DEFAULT_CDP;
const PORT = Number(new URL(CDP).port || 9222);
fs.mkdirSync(AUDIT, { recursive: true });

const results = [];
const timings = [];
const record = (id, ok, detail = '') => {
  results.push({ id, ok, detail: String(detail || '').slice(0, 320) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}${detail ? ` — ${detail}` : ''}`);
};
const time = (id, ms, budget) => {
  const ok = ms <= budget;
  timings.push({ id, ms: Math.round(ms), budget, ok });
  record(`perf:${id}`, ok, `${Math.round(ms)}ms (budget ${budget}ms)`);
};

function cdpUp() {
  return fetch(`${CDP}/json/list`, { signal: AbortSignal.timeout(1500) })
    .then((r) => r.json())
    .then((pages) => pages.some((p) => p.type === 'page'))
    .catch(() => false);
}

async function ensureApp() {
  if (await cdpUp()) {
    console.log('CDP already up —', CDP);
    return null;
  }
  console.log('Starting Groundplan with CDP…');
  const child = spawn('npm', ['run', 'dev', '--', '--', `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    env: {
      ...process.env,
      GROUNDPLAN_E2E_SAVE_DIR: path.join(process.env.HOME || '', 'Downloads'),
      GROUNDPLAN_E2E_SAVE_NAME: 'Usability-Audit.rv4',
      GROUNDPLAN_E2E_SAVE_PATH: path.join(process.env.HOME || '', 'Downloads', 'Usability-Audit.rv4'),
      // Keep Open folder from blocking the OS picker; hang long enough for busy-release (~8s).
      GROUNDPLAN_E2E_FOLDER_DELAY_MS: process.env.GROUNDPLAN_E2E_FOLDER_DELAY_MS || '10000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (buf) => {
    const s = buf.toString();
    if (/DevTools listening|error|Error/.test(s)) process.stdout.write(`[dev] ${s}`);
  });
  child.stderr.on('data', (buf) => {
    const s = buf.toString();
    if (/DevTools listening|error|Error|Address already/.test(s)) process.stderr.write(`[dev] ${s}`);
  });
  await waitForCdpPage(CDP, 90000);
  await sleep(1500);
  return child;
}

const child = await ensureApp();
const cdp = await connectCdp({ base: CDP });
const { ev, clickAt, clickButton, shot, title, pageErrors, send, close, setInput, key } = cdp;
const click = (spec, label, opts) => clickButton(spec, label, record, opts);

const measure = async (id, budget, fn) => {
  const t0 = performance.now();
  await fn();
  time(id, performance.now() - t0, budget);
};

console.log('\n=== Usability + responsiveness audit ===\n');
console.log('title', await title());

// ---------- A. Shell ----------
console.log('\n-- A. Shell / workspaces --');
await shot(path.join(AUDIT, 'ui-usability-01-start.png'));
record('shell:app mounted', await ev(`!!document.querySelector('.app')`));
record('shell:toolbar present', await ev(`!!document.querySelector('.toolbar')`));

for (const label of ['Plan', 'Gear', 'Inventory']) {
  const match =
    label === 'Plan' ? '/^\\s*Plan\\s*$/' : label === 'Gear' ? '/^\\s*Gear/' : '/^\\s*Inventory/';
  await measure(`workspace-tab-${label}`, 900, async () => {
    await click({ match }, `nav:workspace ${label}`);
    await sleep(200);
  });
  record(
    `nav:workspace ${label} active`,
    await ev(`([...document.querySelectorAll('[role=tab]')].some((t) => {
      const text = (t.textContent || '').trim();
      const hit = ${match}.test(text);
      return hit && (t.getAttribute('aria-selected') === 'true' || t.classList.contains('active'));
    }))`),
  );
}
await click({ match: '/^\\s*Plan\\s*$/' }, 'nav:back to Plan');
await sleep(200);

// ---------- A2. Open a blank plan so canvas/tools are live ----------
console.log('\n-- A2. Create blank plan --');
const alreadyOpen = await ev(
  `!!document.querySelector('.canvas-wrap canvas, canvas[aria-label]') && !document.body.innerText.includes('What are you planning')`,
);
if (alreadyOpen) {
  record('plan:document open', true, `already open — ${await title()}`);
  record('plan:Create plan', true, 'skipped — plan already open');
} else {
await measure('open-new-plan', 12000, async () => {
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
    record('plan:welcome New plan', true, `@${Math.round(welcomeNew.x)},${Math.round(welcomeNew.y)}`);
  } else {
    await click({ text: 'New' }, 'plan:New menu');
    await sleep(250);
    const picked = await ev(`(() => {
      const b = [...document.querySelectorAll('[role=menuitem]')].find((el) => /^New plan/i.test((el.textContent || '').trim()));
      if (!b) return false;
      b.click();
      return true;
    })()`);
    record('plan:New plan via menu', !!picked);
  }
  await sleep(700);
  let hasNew = await ev('!!document.querySelector(".new-plan-sheet")');
  if (!hasNew) {
    await key(78, 'KeyN', 'n', 4);
    await sleep(700);
    hasNew = await ev('!!document.querySelector(".new-plan-sheet")');
  }
  record('plan:new-plan-sheet', hasNew);
  if (!hasNew) return;

  if (await ev('!!document.querySelector("#new-plan-name")')) {
    await setInput('#new-plan-name', 'Usability Audit');
  }
  const continued = await click({ match: '/^Continue to room$/i' }, null);
  if (continued) {
    record('plan:Continue to room', true, 'clicked');
  } else {
    record('plan:Continue to room', true, 'skipped — sheet already on room/create step');
  }
  await sleep(350);
  if (await ev('!!document.querySelector("#new-plan-width")')) {
    await setInput('#new-plan-width', "80'");
    await setInput('#new-plan-depth', "60'");
  }
  if (await ev('!!document.querySelector(".new-plan-sheet")')) {
    const reviewed = await click({ match: '/^Review plan$/i' }, null);
    if (reviewed) {
      record('plan:Review plan', true, 'clicked');
      await sleep(300);
      if (await ev('!!document.querySelector("#new-plan-name")')) {
        await setInput('#new-plan-name', 'Usability Audit');
      }
      await click({ match: '/^Empty room/i', root: '.new-plan-review' }, null);
    }
    const created = await click({ match: '/^Create plan$/i' }, 'plan:Create plan');
    if (!created) {
      await setInput('#new-plan-width', "80'").catch(() => undefined);
      await setInput('#new-plan-depth', "60'").catch(() => undefined);
      await click({ match: '/Create plan/i' }, 'plan:Create plan retry');
    }
  } else {
    record('plan:Create plan', true, 'dialog already closed');
  }
  for (let i = 0; i < 30; i++) {
    await sleep(300);
    const state = await ev(`({
      dialog: !!document.querySelector('.new-plan-sheet'),
      canvas: !!document.querySelector('.canvas-wrap canvas, canvas[aria-label]'),
      welcome: document.body.innerText.includes('What are you planning'),
    })`);
    if (!state.dialog && state.canvas && !state.welcome) break;
  }
});

record(
  'plan:document open',
  await ev(`!!document.querySelector('.canvas-wrap canvas, canvas[aria-label]') && !document.body.innerText.includes('What are you planning')`),
  await title(),
);
} // end else alreadyOpen

// ---------- B. Tooltip policy ----------
console.log('\n-- B. Hover tip policy --');
const tipAudit = await ev(`(() => {
  const tipSel = 'button, [role="button"], [role="tab"], [role="menuitem"], .icon-btn, .text-action, [data-tooltip]';
  const isWordy = (value) => {
    const t = String(value || '').replace(/\\s+/g, ' ').trim();
    if (!t) return false;
    if (/^[BIU]$/i.test(t)) return false;
    return /[A-Za-z]{2,}/.test(t);
  };
  const needsTip = (control) => {
    if (control.dataset.tooltipForce === 'true') return true;
    if (control.hasAttribute('data-no-tooltip') || control.closest('[data-no-tooltip]')) return false;
    for (const child of control.children) {
      if (!(child instanceof HTMLElement)) continue;
      if (child.matches('svg, img, [aria-hidden="true"], .num, .badge, .dot, .plan-tab-dirty')) continue;
      if (isWordy(child.textContent || '')) return false;
    }
    const direct = [...control.childNodes]
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent || '')
      .join(' ');
    if (isWordy(direct)) return false;
    return true;
  };
  const hasTipSource = (control) =>
    !!(
      control.getAttribute('data-tooltip')?.trim() ||
      control.getAttribute('title')?.trim() ||
      control.getAttribute('aria-label')?.trim() ||
      control.getAttribute('data-native-title')?.trim()
    );

  const nodes = [...document.querySelectorAll(tipSel)].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2 && !el.disabled;
  });

  let labeled = 0;
  let iconOnly = 0;
  let iconMissingTip = 0;
  const missingSamples = [];
  for (const el of nodes) {
    if (!needsTip(el)) {
      labeled += 1;
      continue;
    }
    iconOnly += 1;
    if (!hasTipSource(el)) {
      iconMissingTip += 1;
      if (missingSamples.length < 12) {
        missingSamples.push({
          cls: (el.className || '').toString().slice(0, 70),
          text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
          aria: (el.getAttribute('aria-label') || '').slice(0, 70),
        });
      }
    }
  }
  return { total: nodes.length, labeled, iconOnly, iconMissingTip, missingSamples };
})()`);

record(
  'tips:labeled buttons present',
  tipAudit.labeled > 0,
  `${tipAudit.labeled} labeled / ${tipAudit.total} visible`,
);
record(
  'tips:icon-only have tip source',
  tipAudit.iconMissingTip === 0,
  tipAudit.iconMissingTip
    ? `${tipAudit.iconMissingTip}/${tipAudit.iconOnly} missing — ${JSON.stringify(tipAudit.missingSamples.slice(0, 5))}`
    : `${tipAudit.iconOnly} icon-only covered`,
);

const hoverProbe = await ev(`(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const fire = (el, type) => el.dispatchEvent(new PointerEvent(type, { bubbles: true }));
  const tipVisible = () => !!document.querySelector('.app-hover-tip');

  const labeled = [...document.querySelectorAll('button')].find((b) => {
    const t = (b.textContent || '').replace(/\\s+/g, ' ').trim();
    return /^(New|Open|Files|Assets)\\b/i.test(t);
  });
  const icon = [...document.querySelectorAll('button')].find((b) => {
    const r = b.getBoundingClientRect();
    if (!(r.width > 2 && r.height > 2) || b.disabled) return false;
    if (b.getAttribute('role') === 'tab') return false;
    const wordyChild = [...b.children].some((c) => {
      if (c.matches('svg, img, [aria-hidden="true"], .num, .badge, .dot')) return false;
      return /[A-Za-z]{2,}/.test((c.textContent || '').trim());
    });
    const direct = [...b.childNodes]
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent || '')
      .join(' ');
    if (/[A-Za-z]{2,}/.test(direct.trim())) return false;
    const tip =
      b.getAttribute('data-tooltip') || b.getAttribute('aria-label') || b.getAttribute('title');
    return !wordyChild && !!tip;
  });

  let labeledShows = null;
  let iconShows = null;
  if (labeled) {
    fire(labeled, 'pointerover');
    await wait(90);
    labeledShows = tipVisible();
    fire(document.body, 'pointerover');
    await wait(40);
  }
  if (icon) {
    fire(icon, 'pointerover');
    await wait(90);
    iconShows = tipVisible();
    fire(document.body, 'pointerover');
    await wait(40);
  }
  return {
    labeledText: labeled ? (labeled.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40) : null,
    iconTip: icon
      ? (icon.getAttribute('data-tooltip') || icon.getAttribute('aria-label') || icon.getAttribute('title') || '').slice(0, 70)
      : null,
    labeledShows,
    iconShows,
  };
})()`);

record(
  'tips:labeled hover suppressed',
  hoverProbe.labeledText == null || hoverProbe.labeledShows === false,
  hoverProbe.labeledText || 'no labeled editor action in view',
);
record(
  'tips:icon hover shows tip',
  hoverProbe.iconTip != null && hoverProbe.iconShows === true,
  hoverProbe.iconTip || 'no icon-only tipped control found',
);

// ---------- C. Editor surfaces + direct tools ----------
console.log('\n-- C. Editor surfaces + direct tools --');
await measure('toggle-Files', 1000, async () => {
  await click({ match: '/^\\s*Files\\s*$/' }, 'surface:Files');
  await sleep(150);
});
await measure('toggle-Properties', 1000, async () => {
  await click({ match: '/^\\s*Properties\\s*$/', root: '.editor-workspace-actions' }, 'surface:Properties');
  await sleep(150);
});
await measure('arm-Line', 1000, async () => {
  await click({ aria: 'Line' }, 'tool:Line');
  await sleep(150);
});
await measure('toggle-Assets', 1000, async () => {
  await click({ match: '/^\\s*Assets\\s*$/' }, 'surface:Assets');
  await sleep(150);
});
{
  const cmd = await ev(
    `document.querySelector('.statusbar .status-command')?.textContent?.trim() || ''`,
  );
  record(
    'mode:last command id',
    cmd === 'mode.place',
    cmd ? `status shows ${cmd}` : 'missing status-command',
  );
  const mode = await ev(
    `document.querySelector('.statusbar .status-mode')?.textContent?.trim() || ''`,
  );
  record('mode:status mode chip', mode === 'place', mode ? `status mode ${mode}` : 'missing status-mode');
}
await measure('command-palette', 1200, async () => {
  await key(75, 'KeyK', 'k', 4);
  await sleep(250);
  const open = await ev(`!!document.querySelector('.command-palette')`);
  record('mode:command palette', open, open ? 'open' : 'missing');
  if (open) {
    await key(27, 'Escape', 'Escape');
    await sleep(120);
  }
});

// ---------- D. Canvas ----------
console.log('\n-- D. Canvas --');
const hasPlan = await ev(`!!document.querySelector('.canvas-wrap canvas, canvas[aria-label]')`);
record('canvas:present', hasPlan, hasPlan ? 'canvas found' : 'no plan canvas (welcome?)');

if (hasPlan) {
  await measure('canvas-pointer-move', 800, async () => {
    const box = await ev(`(() => {
      const c = document.querySelector('.canvas-wrap canvas, canvas');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: r.x + r.width * 0.4, y: r.y + r.height * 0.4 };
    })()`);
    if (!box) return;
    for (let i = 0; i < 16; i++) {
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: box.x + i * 10,
        y: box.y + (i % 4) * 8,
      });
    }
  });

  await measure('zoom-out', 700, async () => {
    await click({ aria: 'Zoom out' }, 'canvas:zoom out');
  });
  await measure('zoom-in', 700, async () => {
    await click({ aria: 'Zoom in' }, 'canvas:zoom in');
  });
  await measure('zoom-fit', 1000, async () => {
    await click({ match: '/Zoom to fit|^\\s*Fit\\s*$/' }, 'canvas:zoom fit');
  });
}

// ---------- E. Inspector tabs ----------
console.log('\n-- E. Inspector --');
// Surface toggles above may leave Properties closed — reopen before tab hits.
{
  const open = await ev(`(() => {
    const rail = document.querySelector('.inspector, [aria-label="Properties and layers inspector"]');
    if (!rail) return false;
    const r = rail.getBoundingClientRect();
    return r.width > 40 && r.height > 40;
  })()`);
  if (!open) {
    await click({ match: '/^\\s*Properties\\s*$/', root: '.editor-workspace-actions' }, 'surface:Properties reopen');
    await sleep(200);
  }
}
for (const tab of ['Layers', 'Properties', 'Room']) {
  await measure(`inspector-${tab}`, 800, async () => {
    await click(
      { match: `/^\\s*${tab}\\s*$/`, root: '.inspector-tabs, [aria-label="Plan inspector"]' },
      `inspector:${tab}`,
    );
    await sleep(120);
  });
}

// ---------- F. View toggles ----------
console.log('\n-- F. View toggles --');
await measure('toggle-Grid', 800, async () => {
  await click({ match: '/^\\s*Grid\\s*$|Hide grid|Show grid/' }, 'view:Grid');
});
await measure('toggle-Stack', 800, async () => {
  await click({ match: '/^\\s*Stack\\s*$|stack markers|stack hover/i' }, 'view:Stack');
});
await measure('toggle-Sight', 800, async () => {
  await click({ match: '/^\\s*Sight\\s*$|sightline/i' }, 'view:Sight');
});

// ---------- F2. Native dialog busy release (Phase 11/12) ----------
// Open Folder arms a busy toast; if the picker stays open, busy must clear ~8s.
// Only runs when this harness spawned the app (E2E folder delay) or when forced.
console.log('\n-- F2. Dialog busy release --');
{
  const folderE2e =
    Boolean(child) ||
    process.env.GROUNDPLAN_TEST_DIALOG_BUSY === '1' ||
    Number(process.env.GROUNDPLAN_E2E_FOLDER_DELAY_MS || 0) > 0;
  if (!folderE2e) {
    record(
      'dialog:folder-busy-skipped',
      true,
      'reused CDP without GROUNDPLAN_E2E_FOLDER_DELAY_MS — skip to avoid OS picker',
    );
  } else {
    await click({ match: '/^\\s*Plan\\s*$/' }, 'nav:Plan before folder busy');
    await sleep(150);
    await click({ match: '/^\\s*Folder\\s*$/' }, 'file:open folder busy');
    await sleep(400);
    const armed = await ev(`(() => {
      const toast = document.querySelector('.toast')?.textContent || '';
      const busy = document.querySelector('.app')?.getAttribute('aria-busy') === 'true';
      return { busy, toast, hint: /Opening folder/i.test(toast) };
    })()`);
    record(
      'dialog:folder-busy-starts',
      Boolean(armed?.busy || armed?.hint),
      JSON.stringify(armed),
    );
    let released = false;
    let last = armed;
    for (let i = 0; i < 22; i++) {
      await sleep(500);
      last = await ev(`(() => {
        const toast = document.querySelector('.toast')?.textContent || '';
        const status = document.querySelector('.status-bar, .status, [class*=status]')?.textContent || '';
        const busy = document.querySelector('.app')?.getAttribute('aria-busy') === 'true';
        return {
          busy,
          toast,
          status,
          opening: /Opening folder/i.test(toast),
          releasedHint: /still open/i.test(toast) || /still open/i.test(status),
        };
      })()`);
      if (!last?.busy && !last?.opening) {
        released = true;
        break;
      }
    }
    record(
      'dialog:folder-busy-releases',
      released,
      JSON.stringify({ released, last }),
    );
    // Wait out remaining E2E hang so the IPC returns and later steps are not blocked.
    await sleep(2500);
  }
}

// ---------- G. Health ----------
console.log('\n-- G. Health --');
record(
  'health:no page exceptions',
  pageErrors.length === 0,
  pageErrors.length ? JSON.stringify(pageErrors.slice(0, 3)) : 'clean',
);
record(
  'health:app not stuck busy',
  await ev(`document.querySelector('.app')?.getAttribute('aria-busy') !== 'true'`),
);

await shot(path.join(AUDIT, 'ui-usability-02-end.png'));

const failed = results.filter((r) => !r.ok);
const report = {
  at: new Date().toISOString(),
  title: await title(),
  tipAudit,
  hoverProbe,
  timings,
  results,
  failed: failed.length,
  passed: results.length - failed.length,
};
fs.writeFileSync(path.join(AUDIT, 'ui-usability-report.json'), JSON.stringify(report, null, 2));

console.log(`\n=== Summary: ${report.passed} passed, ${report.failed} failed ===`);
console.log('Report:', path.join(AUDIT, 'ui-usability-report.json'));
if (failed.length) {
  console.log('\nFailures:');
  for (const f of failed) console.log(`  - ${f.id}: ${f.detail}`);
}

close();
if (child && !process.env.GROUNDPLAN_KEEP_CDP) {
  child.kill('SIGTERM');
  await sleep(400);
}
process.exit(failed.length ? 1 : 0);
