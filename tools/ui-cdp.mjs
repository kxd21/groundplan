/**
 * Shared CDP helpers for Groundplan UI stress / click-through tools.
 *
 *   import { connectCdp, sleep } from './ui-cdp.mjs'
 */
import fs from 'node:fs';
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const DEFAULT_CDP = process.env.GROUNDPLAN_CDP || 'http://127.0.0.1:9222';
export const DEFAULT_SAVE = path.join(
  process.env.HOME || '',
  'Downloads',
  'CardParty-UI-stress.rv4',
);

/** Wait until a Chromium page target is listed on the CDP endpoint. */
export async function waitForCdpPage(base = DEFAULT_CDP, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const pages = await fetch(`${base}/json/list`).then((r) => r.json());
      const page = pages.find((p) => p.type === 'page' && p.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* not up yet */
    }
    await sleep(400);
  }
  throw new Error(`No CDP page at ${base} after ${timeoutMs}ms`);
}

export async function connectCdp(options = {}) {
  const base = options.base || DEFAULT_CDP;
  const page = options.page || (await waitForCdpPage(base, options.timeoutMs));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });

  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
    if (m.id && pending.has(m.id)) pending.get(m.id)(m);
  });

  const send = (method, params = {}) =>
    new Promise((r) => {
      const id = nextId++;
      pending.set(id, (m) => {
        pending.delete(id);
        r(m);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });

  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.result?.exceptionDetails) {
      throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
    }
    return r.result?.result?.value;
  };

  const mouse = (type, x, y, extras = {}) =>
    send('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extras });

  const clickAt = async (x, y) => {
    await mouse('mouseMoved', x, y);
    await mouse('mousePressed', x, y, { clickCount: 1 });
    await mouse('mouseReleased', x, y, { clickCount: 1 });
  };

  const key = async (windowsVirtualKeyCode, code, keyName, modifiers = 0) => {
    for (const type of ['keyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', {
        type,
        windowsVirtualKeyCode,
        code,
        key: keyName,
        modifiers,
        metaKey: !!(modifiers & 8),
        shiftKey: !!(modifiers & 4),
        altKey: !!(modifiers & 1),
      });
    }
  };

  const esc = () => key(27, 'Escape', 'Escape');

  const shot = async (filePath) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.from(r.result.data, 'base64'));
  };

  /**
   * Pick the first geometrically clickable match (w/h > 2). Falls back to the
   * first match and marks zero=true so callers can DOM-click or fail as UX.
   */
  const findButton = async ({ text, aria, match, root, toolId, seatKind } = {}) => {
    return ev(`(() => {
      const rootSel = ${root ? JSON.stringify(root) : 'null'};
      const root = (() => {
        if (!rootSel) return document.body;
        const nodes = rootSel.split(',').map((s) => s.trim()).filter(Boolean)
          .map((sel) => document.querySelector(sel))
          .filter(Boolean);
        const visible = nodes.find((n) => {
          const r = n.getBoundingClientRect();
          return r.width > 2 && r.height > 2;
        });
        return visible || nodes[0] || document.body;
      })();
      const re = ${match ? match : 'null'};
      const toolId = ${toolId ? JSON.stringify(toolId) : 'null'};
      const seatKind = ${seatKind ? JSON.stringify(seatKind) : 'null'};
      const candidates = [...root.querySelectorAll('button')].filter((el) => {
        if (toolId) return el.getAttribute('data-tool-id') === toolId;
        if (seatKind) return el.getAttribute('data-seat-kind') === seatKind;
        const t = (el.textContent || '').trim();
        const a = el.getAttribute('aria-label') || '';
        if (${text ? JSON.stringify(text) : 'null'} != null) return t === ${JSON.stringify(text ?? '')};
        if (${aria ? JSON.stringify(aria) : 'null'} != null) return a === ${JSON.stringify(aria ?? '')};
        if (re) return re.test(t) || re.test(a);
        return false;
      });
      const visible = candidates.find((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
      });
      const b = visible || candidates[0];
      if (!b) return null;
      const r = b.getBoundingClientRect();
      const zero = !(r.width > 2 && r.height > 2);
      return {
        x: r.x + r.width / 2,
        y: r.y + r.height / 2,
        t: ((b.textContent || '').trim() || b.getAttribute('aria-label') || '').slice(0, 48),
        dis: !!b.disabled,
        zero,
        toolId: b.getAttribute('data-tool-id'),
      };
    })()`);
  };

  const clickButton = async (spec, label, record, { allowDomClick = true } = {}) => {
    const box = await findButton(spec);
    if (!box) {
      record?.(label, false, 'not found');
      return false;
    }
    if (box.zero) {
      record?.(`${label}:hit-target`, false, '0×0 control');
      if (!allowDomClick) {
        record?.(label, false, 'zero hit target');
        return false;
      }
      const ok = await ev(`(() => {
        const toolId = ${spec.toolId ? JSON.stringify(spec.toolId) : 'null'};
        const seatKind = ${spec.seatKind ? JSON.stringify(spec.seatKind) : 'null'};
        const re = ${spec.match || 'null'};
        const b = [...document.querySelectorAll('button')].find((el) => {
          if (toolId) return el.getAttribute('data-tool-id') === toolId;
          if (seatKind) return el.getAttribute('data-seat-kind') === seatKind;
          const t = (el.textContent || '').trim();
          const a = el.getAttribute('aria-label') || '';
          if (${spec.text ? JSON.stringify(spec.text) : 'null'} != null) return t === ${JSON.stringify(spec.text ?? '')};
          if (${spec.aria ? JSON.stringify(spec.aria) : 'null'} != null) return a === ${JSON.stringify(spec.aria ?? '')};
          if (re) return re.test(t) || re.test(a);
          return false;
        });
        if (!b) return false;
        b.click();
        return true;
      })()`);
      record?.(label, !!ok, 'DOM .click() fallback');
      return !!ok;
    }
    await clickAt(box.x, box.y);
    record?.(label, true, `@${Math.round(box.x)},${Math.round(box.y)} ${box.t}`);
    return true;
  };

  const setInput = async (selector, value) => {
    await ev(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      const d = Object.getOwnPropertyDescriptor(
        el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,
        'value',
      );
      d.set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
  };

  const setSelect = async (selector, picker) => {
    return ev(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, reason: 'missing' };
      const opt = ${picker};
      if (!opt) return { ok: false, reason: 'no option', options: [...el.options].map((o) => o.text).slice(0, 12) };
      const native = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
      native.set.call(el, opt.value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, value: el.value, text: opt.text };
    })()`);
  };

  const chairs = () =>
    ev(
      `Number(String((document.body.innerText.match(/Chairs:\\s*([\\d,]+)/)||[])[1]||'0').replace(/,/g,''))`,
    );

  const title = () => ev('document.title');

  const canvasClickFt = async (xFt, yFt, unitsPerFoot = 120) => {
    const pt = await ev(`(() => {
      const canvas = document.querySelector('canvas');
      if (!canvas) return null;
      const cr = canvas.getBoundingClientRect();
      let fiber = canvas[Object.keys(canvas).find((k) => k.startsWith('__reactFiber'))];
      let view = null;
      for (let i = 0; i < 40 && fiber; i++) {
        let s = fiber.memoizedState;
        while (s) {
          const v = s.memoizedState;
          if (v && typeof v.scale === 'number' && typeof v.offsetX === 'number') {
            view = v;
            break;
          }
          s = s.next;
        }
        if (view) break;
        fiber = fiber.return;
      }
      if (!view) return null;
      return {
        x: cr.x + ${xFt} * ${unitsPerFoot} * view.scale + view.offsetX,
        y: cr.y + ${yFt} * ${unitsPerFoot} * view.scale + view.offsetY,
      };
    })()`);
    if (!pt) return false;
    await clickAt(pt.x, pt.y);
    return true;
  };

  const close = () => ws.close();

  return {
    page,
    send,
    ev,
    clickAt,
    key,
    esc,
    shot,
    findButton,
    clickButton,
    setInput,
    setSelect,
    chairs,
    title,
    canvasClickFt,
    close,
  };
}
