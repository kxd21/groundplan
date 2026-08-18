/**
 * Light/dark UI contrast stress — CDP walk of visible chrome text.
 *
 * Against an already-running CDP session:
 *   GROUNDPLAN_KEEP_CDP=1 node tools/ui-stress-contrast.mjs
 *
 * Or: npm run test:ui-contrast (via run-ui-stress with this harness).
 *
 * Writes docs/audit/ui-contrast-report.json + screenshots.
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
const CDP = process.env.GROUNDPLAN_CDP || DEFAULT_CDP;
const MIN_NORMAL = Number(process.env.CONTRAST_MIN || 4.5);
const MIN_LARGE = Number(process.env.CONTRAST_MIN_LARGE || 3);
const TOP_N = Number(process.env.CONTRAST_TOP || 40);

fs.mkdirSync(AUDIT, { recursive: true });

await waitForCdpPage(CDP, 15000).catch(() => {
  console.error(`No CDP at ${CDP}. Start: npm run dev -- -- --remote-debugging-port=9222`);
  process.exit(1);
});

const cdp = await connectCdp({ base: CDP });
const { ev, shot, clickButton, esc, close } = cdp;

const record = [];
const log = (id, ok, detail = '') => {
  record.push({ id, ok, detail: String(detail || '').slice(0, 240) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}${detail ? ` — ${detail}` : ''}`);
};

const setTheme = async (mode) => {
  const modeLit = JSON.stringify(mode);
  await ev(`(() => {
    const mode = ${modeLit};
    localStorage.setItem('groundplan:appearance', mode);
    const btn = [...document.querySelectorAll('button')].find((el) => {
      const t = (el.textContent || '').replace(/\\s+/g, ' ').trim();
      const label = (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('data-tooltip') || '');
      return mode === 'dark'
        ? /Dark UI|Use dark/i.test(t) || /dark interface/i.test(label)
        : /Light UI|Use light/i.test(t) || /light interface/i.test(label);
    });
    if (btn) btn.click();
    else {
      const app = document.querySelector('.app');
      if (app) app.setAttribute('data-theme', mode);
    }
    return document.querySelector('.app')?.getAttribute('data-theme') || mode;
  })()`);
  await sleep(350);
  // If button toggle went the wrong way, click again until matched.
  for (let i = 0; i < 3; i++) {
    const current = await ev(`document.querySelector('.app')?.getAttribute('data-theme')`);
    if (current === mode) break;
    await ev(`(() => {
      const btn = [...document.querySelectorAll('button.ribbon-action, button.icon-btn')].find((el) =>
        /Light UI|Dark UI|light interface|dark interface/i.test(
          (el.textContent || '') + (el.getAttribute('aria-label') || '') + (el.getAttribute('data-tooltip') || ''),
        ),
      );
      btn?.click();
    })()`);
    await sleep(250);
  }
  const theme = await ev(`document.querySelector('.app')?.getAttribute('data-theme')`);
  log(`theme:${mode}`, theme === mode, `data-theme=${theme}`);
  return theme === mode;
};

const openSurface = async (label, clickSpec) => {
  try {
    await esc();
    await sleep(120);
  } catch {
    /* ok */
  }
  if (!clickSpec) return;
  // A surface can need more than one click to reach — the welcome screen lives
  // behind the Browse rail once a plan is open.
  const steps = Array.isArray(clickSpec) ? clickSpec : [clickSpec];
  for (const [i, step] of steps.entries()) {
    const id = steps.length > 1 ? `open:${label}:${i + 1}` : `open:${label}`;
    if (step.eval) {
      try {
        await ev(step.eval);
        log(id, true, 'via api');
      } catch (err) {
        log(id, false, String(err && err.message ? err.message : err));
      }
      await sleep(step.settle ?? 900);
      continue;
    }
    await clickButton(step, id, (cid, ok, detail) => log(cid, ok, detail));
    await sleep(280);
  }
};

const auditContrast = async (theme, surface) => {
  // Keep browser JS in a normal string — nested template literals break Node parse.
  const expression = [
    '(function(theme, surface, MIN_N, MIN_L, TOP_N) {',
    '  const parseColor = (raw) => {',
    "    if (!raw || raw === 'transparent' || raw === 'inherit') return null;",
    '    const s = String(raw).trim();',
    '    const m = s.match(/rgba?\\((\\d+)[,\\s]+(\\d+)[,\\s]+(\\d+)(?:[,\\s\\/]+([\\d.]+))?\\)/i);',
    '    if (m) return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] === undefined ? 1 : Number(m[4]) };',
    "    if (s.startsWith('#')) {",
    '      let h = s.slice(1);',
    "      if (h.length === 3) h = h.split('').map((c) => c + c).join('');",
    '      if (h.length === 6 || h.length === 8) {',
    '        return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };',
    '      }',
    '    }',
    '    return null;',
    '  };',
    '  const blend = (fg, bg) => {',
    '    const a = Math.max(0, Math.min(1, fg.a == null ? 1 : fg.a));',
    '    if (a >= 0.999) return { r: fg.r, g: fg.g, b: fg.b, a: 1 };',
    '    return { r: Math.round(fg.r * a + bg.r * (1 - a)), g: Math.round(fg.g * a + bg.g * (1 - a)), b: Math.round(fg.b * a + bg.b * (1 - a)), a: 1 };',
    '  };',
    '  const lin = (c) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };',
    '  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);',
    '  const contrast = (a, b) => { const L1 = lum(a), L2 = lum(b); const hi = Math.max(L1, L2), lo = Math.min(L1, L2); return (hi + 0.05) / (lo + 0.05); };',
    '  const bgOf = (el) => {',
    '    let node = el;',
    '    while (node && node.nodeType === 1) {',
    '      const cs = getComputedStyle(node);',
    // A gradient or image paints over whatever colour sits behind it, and this
    // walk only understands colours. Continuing past it resolved white-on-blue
    // hero text against the page ground and reported 1.13:1 — 24 of the 34
    // failures in one run were this single blind spot. Unknown is reported as
    // unknown.
    '      if (cs.backgroundImage && cs.backgroundImage !== \'none\') return null;',
    '      const bg = parseColor(cs.backgroundColor);',
    '      if (bg && bg.a > 0.08) {',
    '        let composite = bg;',
    '        let p = node.parentElement;',
    '        while (composite.a < 0.98 && p) {',
    '          const pb = parseColor(getComputedStyle(p).backgroundColor);',
    '          if (pb && pb.a > 0.08) composite = blend(composite, pb);',
    '          p = p.parentElement;',
    '        }',
    '        if (composite.a < 0.98) {',
    '          const root = parseColor(getComputedStyle(document.body).backgroundColor) || { r: 16, g: 18, b: 22, a: 1 };',
    '          composite = blend(composite, root);',
    '        }',
    '        return composite;',
    '      }',
    '      node = node.parentElement;',
    '    }',
    '    return parseColor(getComputedStyle(document.body).backgroundColor) || { r: 16, g: 18, b: 22, a: 1 };',
    '  };',
    '  const pathOf = (el) => {',
    '    const parts = [];',
    '    let n = el;',
    '    for (let i = 0; n && i < 5; i++) {',
    "      const id = n.id ? ('#' + n.id) : '';",
    "      const cls = (n.className && typeof n.className === 'string') ? ('.' + n.className.trim().split(/\\s+/).slice(0, 2).join('.')) : '';",
    "      parts.unshift((n.tagName || '').toLowerCase() + id + cls);",
    '      n = n.parentElement;',
    '    }',
    "    return parts.join('>');",
    '  };',
    '  const fails = [];',
    '  const seen = new Set();',
    '  let measured = 0, skippedNoText = 0, skippedNoBg = 0;',
    "  const selectors = ['button','a','label','summary','th','td','li','h1','h2','h3','h4','strong','small','span','p','input','select','textarea','[role=\"tab\"]','[role=\"menuitem\"]','.hint','.muted','.statusbar','.ribbon-action','.tool-button','.create-flow-step','.show-setup-phase','.layer-count','.autosave-label','.show-setup-chip','.field label','.create-dialog-head small','.inspector-empty','.welcome-home'];",
    '  const nodes = new Set();',
    '  for (const sel of selectors) document.querySelectorAll(sel).forEach((el) => nodes.add(el));',
    '  for (const el of nodes) {',
    '    const r = el.getBoundingClientRect();',
    '    if (r.width < 2 || r.height < 2) continue;',
    '    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;',
    '    const cs = getComputedStyle(el);',
    '    if (cs.visibility === \"hidden\" || cs.display === \"none\" || Number(cs.opacity) < 0.15) continue;',
    '    if (el.disabled || el.getAttribute(\"aria-disabled\") === \"true\") continue;',
    '    if (el.closest(\"button:disabled, [aria-disabled=true]\")) continue;',
    '    if (/^(INPUT|TEXTAREA|SELECT)$/i.test(el.tagName) && !(el.value || \"\").trim() && !(el.getAttribute(\"aria-label\") || \"\").trim()) continue;',
    '    if (/^(INPUT)$/i.test(el.tagName) && el.type === \"checkbox\") continue;',
    // `aria-label` used to stand in for missing text, so a 15x3px carousel dot
    // — an empty button whose visual is its background — was measured as if it
    // rendered its label, against the 4.5:1 threshold for body copy. Twelve
    // failures in one run were dots that paint no glyphs at all. An icon
    // control's contrast is a real question, but it is the 3:1 non-text one,
    // not this check.
    // `color` only paints text this element renders ITSELF. A container whose
    // text all lives in children that set their own colours was being measured
    // against a colour nothing on screen uses — a recent-plan card reported
    // 1.03:1 while every word inside it was perfectly legible. Direct text
    // nodes are the honest test.
    '    const ownsText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());',
    '    const isField = /^(INPUT|TEXTAREA|SELECT)$/i.test(el.tagName);',
    '    let text = (el.innerText || el.value || el.getAttribute(\"placeholder\") || \"\").replace(/\\s+/g, \" \").trim();',
    '    if (!text) { skippedNoText++; continue; }',
    '    if (!ownsText && !isField) { skippedNoText++; continue; }',
    '    if (el.children.length > 3 && text.length > 80 && !/^(BUTTON|A|LABEL|SUMMARY)$/i.test(el.tagName)) continue;',
    '    text = text.slice(0, 64);',
    '    const color = parseColor(cs.color);',
    '    if (!color || color.a < 0.2) continue;',
    '    const bg = bgOf(el);',
    '    if (!bg) { skippedNoBg++; continue; }',
    '    const fg = blend(color, bg);',
    '    const ratio = contrast(fg, bg);',
    '    measured++;',
    '    const fontSize = parseFloat(cs.fontSize) || 13;',
    '    const bold = (parseInt(cs.fontWeight, 10) || 400) >= 600;',
    '    const large = fontSize >= 18 || (fontSize >= 14 && bold);',
    '    const min = large ? MIN_L : MIN_N;',
    '    if (ratio + 1e-6 >= min) continue;',
    '    const key = pathOf(el) + \"|\" + text + \"|\" + ratio.toFixed(2);',
    '    if (seen.has(key)) continue;',
    '    seen.add(key);',
    '    fails.push({ theme: theme, surface: surface, text: text, ratio: Math.round(ratio * 100) / 100, min: min, fontSize: fontSize, color: cs.color, background: \"rgba(\" + bg.r + \",\" + bg.g + \",\" + bg.b + \",1)\", path: pathOf(el) });',
    '  }',
    '  fails.sort((a, b) => a.ratio - b.ratio);',
    // Skips are reported, not hidden. A checker that silently ignores half the
    // page looks identical to a clean page, and this one previously did exactly
    // that in the other direction — inventing failures it could not resolve.
    '  return { fails: fails.slice(0, TOP_N), measured: measured, skippedNoText: skippedNoText, skippedNoBg: skippedNoBg };',
    '})(' +
      JSON.stringify(theme) +
      ', ' +
      JSON.stringify(surface) +
      ', ' +
      MIN_NORMAL +
      ', ' +
      MIN_LARGE +
      ', ' +
      TOP_N +
      ')',
  ].join('\n');

  const findings = await ev(expression);
  return findings || [];
};

console.log('\n=== UI contrast stress (light + dark) ===\n');
console.log('title', await ev('document.title'));

const surfaces = [
  { id: 'plan-chrome', open: null },
  { id: 'setup', open: { text: 'Setup' } },
  // Mode labels, not panel nouns: the shell redesign renamed these to match the
  // mode strip, and the harness kept opening panels that no longer answer to
  // "Inspector" / "Browser" / "Tools" — so it was sampling whatever happened to
  // be on screen and still reporting a pass.
  { id: 'inspector', open: { text: 'Inspect' } },
  { id: 'browser', open: { text: 'Browse' } },
  { id: 'tools', open: { text: 'Draw' } },
  // The welcome screen is the first thing every launch shows and was the one
  // surface never audited — no button reaches it once a plan is restored, and
  // `plan-chrome` opens nothing, so coverage depended on the app's state rather
  // than on this list. A deliberately unreadable `--home-ink-3` cleared the
  // entire gate because of it. Audited last so the editor surfaces above still
  // have a plan; the second step answers the unsaved-changes prompt if the run
  // dirtied one.
];

// Audited after every editor surface, in both themes: reaching it closes the
// open plan, which disables the mode buttons the other surfaces need.
const welcomeSurface =
  {
    id: 'welcome',
    open: [
      { eval: '(() => { window.groundplan.closePlan(); return true; })()' },
      {
        eval:
          "(() => { const b = [...document.querySelectorAll('.discard-prompt-actions button')]" +
          ".find((x) => /Discard changes/.test(x.textContent)); if (b) b.click(); return true; })()",
      },
      // `closePlan` drops the session in the main process, but the renderer
      // holds its own copy of the open document and keeps drawing it, so the
      // audit was photographing the editor and calling it the welcome screen.
      // Reloading makes the renderer re-read state from main.
      { eval: '(() => { setTimeout(() => location.reload(), 0); return true; })()', settle: 6000 },
    ],
  };

const allFails = [];
const coverage = { measured: 0, skippedNoText: 0, skippedNoBg: 0 };

for (const theme of ['light', 'dark']) {
  console.log(`\n-- Theme: ${theme} --`);
  await setTheme(theme);
  for (const surface of surfaces) {
    await openSurface(surface.id, surface.open);
    const shotPath = path.join(AUDIT, `ui-contrast-${theme}-${surface.id}.png`);
    await shot(shotPath);
    const scan = await auditContrast(theme, surface.id);
    const fails = scan.fails;
    coverage.measured += scan.measured;
    coverage.skippedNoText += scan.skippedNoText;
    coverage.skippedNoBg += scan.skippedNoBg;
    allFails.push(...fails);
    const worst = fails[0];
    log(
      `contrast:${theme}:${surface.id}`,
      fails.length === 0,
      fails.length
        ? `${fails.length} fails; worst ${worst.ratio}:1 “${worst.text}”`
        : 'ok',
    );
    console.log(`  shot ${shotPath}`);
  }
}

// Also sample New plan dialog if reachable
await setTheme('dark');
await openSurface('new-plan', { text: 'New' });
await sleep(200);
await ev(`(() => {
  const item = [...document.querySelectorAll('[role=menuitem],button')].find((el) =>
    /^New plan/i.test((el.textContent || '').trim()),
  );
  item?.click();
})()`);
await sleep(400);
await shot(path.join(AUDIT, 'ui-contrast-dark-new-plan.png'));
for (const theme of ['light', 'dark']) {
  await setTheme(theme);
  await openSurface(welcomeSurface.id, welcomeSurface.open);
  await shot(path.join(AUDIT, `ui-contrast-${theme}-welcome.png`));
  const scan = await auditContrast(theme, 'welcome');
  coverage.measured += scan.measured;
  coverage.skippedNoText += scan.skippedNoText;
  coverage.skippedNoBg += scan.skippedNoBg;
  allFails.push(...scan.fails);
  const worst = scan.fails[0];
  log(
    `contrast:${theme}:welcome`,
    scan.fails.length === 0,
    scan.fails.length ? `${scan.fails.length} fails; worst ${worst.ratio}:1 “${worst.text}”` : 'ok',
  );
}

const newPlanFails = (await auditContrast('dark', 'new-plan')).fails;
allFails.push(...newPlanFails);
log(
  'contrast:dark:new-plan',
  newPlanFails.length === 0,
  newPlanFails.length
    ? `${newPlanFails.length} fails; worst ${newPlanFails[0].ratio}:1 “${newPlanFails[0].text}”`
    : 'ok',
);

await esc();
await setTheme('light');
await openSurface('new-plan-light', { text: 'New' });
await sleep(200);
await ev(`(() => {
  const item = [...document.querySelectorAll('[role=menuitem],button')].find((el) =>
    /^New plan/i.test((el.textContent || '').trim()),
  );
  item?.click();
})()`);
await sleep(400);
await shot(path.join(AUDIT, 'ui-contrast-light-new-plan.png'));
const newPlanLightFails = (await auditContrast('light', 'new-plan')).fails;
allFails.push(...newPlanLightFails);
log(
  'contrast:light:new-plan',
  newPlanLightFails.length === 0,
  newPlanLightFails.length
    ? `${newPlanLightFails.length} fails; worst ${newPlanLightFails[0].ratio}:1 “${newPlanLightFails[0].text}”`
    : 'ok',
);

const byKey = new Map();
for (const f of allFails) {
  const k = `${f.theme}|${f.path}|${f.text}`;
  if (!byKey.has(k) || byKey.get(k).ratio > f.ratio) byKey.set(k, f);
}
const unique = [...byKey.values()].sort((a, b) => a.ratio - b.ratio);

const report = {
  at: new Date().toISOString(),
  thresholds: { normal: MIN_NORMAL, large: MIN_LARGE },
  failCount: unique.length,
  fails: unique.slice(0, 80),
  checks: record,
};
const reportPath = path.join(AUDIT, 'ui-contrast-report.json');
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

console.log('\n=== Summary ===');
console.log(
  `Coverage: ${coverage.measured} text nodes measured · ` +
    `${coverage.skippedNoText} skipped (no rendered text) · ` +
    `${coverage.skippedNoBg} skipped (background not resolvable)`,
);
console.log(`Unique contrast fails: ${unique.length}`);
for (const f of unique.slice(0, 25)) {
  console.log(
    `  ${f.ratio}:1 [${f.theme}/${f.surface}] “${f.text}”  ${f.color} on ${f.background}`,
  );
  console.log(`    ${f.path}`);
}
console.log(`Report: ${reportPath}`);

// `:hit-target` entries note a control the harness could not reach by pointer
// and had to DOM-click. Worth seeing, but it still audited the surface, so it is
// advisory rather than a hole in coverage.
const brokenChecks = record.filter((r) => !r.ok && !r.id.endsWith(':hit-target'));
if (brokenChecks.length) {
  console.log('\nChecks that did not complete:');
  for (const b of brokenChecks) console.log(`  ${b.id}${b.detail ? ` — ${b.detail}` : ''}`);
}

await close();
// A surface that never opened is a hole in coverage, not a pass. This used to
// exit on `unique.length` alone, so the run could fail to reach every screen it
// names, audit whatever happened to be in front of it, and still report
// success — which is how a deliberately unreadable `--home-ink-3` cleared the
// whole gate.
process.exit(unique.length > 0 || brokenChecks.length > 0 ? 1 : 0);
