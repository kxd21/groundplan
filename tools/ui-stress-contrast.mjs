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
  if (clickSpec) {
    await clickButton(clickSpec, `open:${label}`, (id, ok, detail) => log(id, ok, detail), {
      optional: true,
    });
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
    '    let text = (el.innerText || el.value || el.getAttribute(\"aria-label\") || el.getAttribute(\"placeholder\") || \"\").replace(/\\s+/g, \" \").trim();',
    '    if (!text) continue;',
    '    if (el.children.length > 3 && text.length > 80 && !/^(BUTTON|A|LABEL|SUMMARY)$/i.test(el.tagName)) continue;',
    '    text = text.slice(0, 64);',
    '    const color = parseColor(cs.color);',
    '    if (!color || color.a < 0.2) continue;',
    '    const bg = bgOf(el);',
    '    const fg = blend(color, bg);',
    '    const ratio = contrast(fg, bg);',
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
    '  return fails.slice(0, TOP_N);',
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
  { id: 'inspector', open: { text: 'Inspector' } },
  { id: 'browser', open: { text: 'Browser' } },
  { id: 'tools', open: { text: 'Tools' } },
];

const allFails = [];

for (const theme of ['light', 'dark']) {
  console.log(`\n-- Theme: ${theme} --`);
  await setTheme(theme);
  for (const surface of surfaces) {
    await openSurface(surface.id, surface.open);
    const shotPath = path.join(AUDIT, `ui-contrast-${theme}-${surface.id}.png`);
    await shot(shotPath);
    const fails = await auditContrast(theme, surface.id);
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
const newPlanFails = await auditContrast('dark', 'new-plan');
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
const newPlanLightFails = await auditContrast('light', 'new-plan');
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
console.log(`Unique contrast fails: ${unique.length}`);
for (const f of unique.slice(0, 25)) {
  console.log(
    `  ${f.ratio}:1 [${f.theme}/${f.surface}] “${f.text}”  ${f.color} on ${f.background}`,
  );
  console.log(`    ${f.path}`);
}
console.log(`Report: ${reportPath}`);

await close();
process.exit(unique.length > 0 ? 1 : 0);
