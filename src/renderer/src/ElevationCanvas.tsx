/**
 * Simplified Front / Side elevation viewport.
 *
 * Horizontal position follows plan X (front) or plan Y (side). Vertical is
 * elevation above the floor. Missing elevation drawings fall back to a
 * rectangular silhouette at least 36″ tall.
 */

import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';

import { classify, type ItemView } from '../../inventory/classify.js';
import { UNITS_PER_INCH, type UnitSystem } from '../../format/units.js';
import { elevationAxis } from './plan-view.js';

const MIN_SILHOUETTE_HEIGHT = 36 * UNITS_PER_INCH;
const PAD = 28;
const FRONT_VIEWS: ReadonlySet<ItemView> = new Set(['front', 'front-side', 'rear']);
const SIDE_VIEWS: ReadonlySet<ItemView> = new Set(['side', 'front-side']);

export interface ElevationItem {
  id: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  elevation?: number;
}

export interface ElevationInventoryHint {
  name: string;
  view?: string | null;
  /** Optional path / polygon data for a future elevation stroke; unused in MVP. */
  outline?: unknown;
}

interface Props {
  items: ElevationItem[];
  planView: 'front' | 'side';
  selectedIds: number[];
  units: UnitSystem;
  onSelect: (ids: number[]) => void;
  inventory?: ElevationInventoryHint[];
}

interface ViewBox {
  scale: number;
  offsetX: number;
  offsetY: number;
}

interface Silhouette {
  id: number;
  name: string;
  left: number;
  bottom: number;
  width: number;
  height: number;
  selected: boolean;
}

function resolveView(hint: ElevationInventoryHint): ItemView {
  const raw = hint.view;
  if (raw === 'plan' || raw === 'front' || raw === 'side' || raw === 'rear' || raw === 'front-side') {
    return raw;
  }
  return classify(hint.name).view;
}

function hasElevationSibling(
  item: ElevationItem,
  planView: 'front' | 'side',
  inventory: ElevationInventoryHint[] | undefined,
): boolean {
  if (!inventory?.length) return false;
  const wanted = planView === 'front' ? FRONT_VIEWS : SIDE_VIEWS;
  const base = classify(item.name).baseName.toLowerCase();
  return inventory.some((hint) => {
    if (!wanted.has(resolveView(hint))) return false;
    return classify(hint.name).baseName.toLowerCase() === base;
  });
}

function silhouettesFor(
  items: ElevationItem[],
  planView: 'front' | 'side',
  selected: ReadonlySet<number>,
  inventory: ElevationInventoryHint[] | undefined,
): Silhouette[] {
  const axis = elevationAxis(planView);
  return items.map((item) => {
    const along = axis === 'y' ? item.y : item.x;
    // Front: width along X. Side: plan depth (height) along Y.
    const span = axis === 'y' ? Math.max(item.height, UNITS_PER_INCH) : Math.max(item.width, UNITS_PER_INCH);
    const elev = item.elevation != null && Number.isFinite(item.elevation) ? item.elevation : 0;
    // No FV/SV sibling → extruded silhouette at least 36″ tall.
    const body = hasElevationSibling(item, planView, inventory)
      ? Math.max(item.height, UNITS_PER_INCH)
      : Math.max(item.height, MIN_SILHOUETTE_HEIGHT);
    return {
      id: item.id,
      name: item.name,
      left: along - span / 2,
      bottom: elev,
      width: span,
      height: body,
      selected: selected.has(item.id),
    };
  });
}

function fitView(boxes: Silhouette[], cssW: number, cssH: number): ViewBox {
  if (boxes.length === 0 || cssW <= 0 || cssH <= 0) {
    return { scale: 0.05, offsetX: cssW / 2, offsetY: cssH * 0.7 };
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = 0;
  let maxY = MIN_SILHOUETTE_HEIGHT;
  for (const box of boxes) {
    minX = Math.min(minX, box.left);
    maxX = Math.max(maxX, box.left + box.width);
    minY = Math.min(minY, box.bottom);
    maxY = Math.max(maxY, box.bottom + box.height);
  }
  const worldW = Math.max(maxX - minX, UNITS_PER_INCH * 12);
  const worldH = Math.max(maxY - minY, UNITS_PER_INCH * 12);
  const scale = Math.min((cssW - PAD * 2) / worldW, (cssH - PAD * 2) / worldH);
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  return {
    scale,
    offsetX: cssW / 2 - midX * scale,
    // World Y up → screen Y down; ground near the lower third.
    offsetY: cssH / 2 + midY * scale,
  };
}

function worldToScreen(x: number, y: number, view: ViewBox): { x: number; y: number } {
  return {
    x: x * view.scale + view.offsetX,
    y: -y * view.scale + view.offsetY,
  };
}

function readCssVar(el: HTMLElement, name: string, fallback: string): string {
  const value = getComputedStyle(el).getPropertyValue(name).trim();
  return value || fallback;
}

function hitTest(boxes: Silhouette[], worldX: number, worldY: number): number | null {
  // Topmost (highest elevation top) wins on overlap.
  let best: Silhouette | null = null;
  for (const box of boxes) {
    if (
      worldX >= box.left &&
      worldX <= box.left + box.width &&
      worldY >= box.bottom &&
      worldY <= box.bottom + box.height
    ) {
      if (!best || box.bottom + box.height >= best.bottom + best.height) best = box;
    }
  }
  return best?.id ?? null;
}

export function ElevationCanvas({
  items,
  planView,
  selectedIds,
  units: _units,
  onSelect,
  inventory,
}: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewRef = useRef<ViewBox>({ scale: 0.05, offsetX: 0, offsetY: 0 });
  const boxesRef = useRef<Silhouette[]>([]);
  const fittedRef = useRef(false);

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const dpr = window.devicePixelRatio || 1;
    const cssW = Math.max(1, wrap.clientWidth);
    const cssH = Math.max(1, wrap.clientHeight);
    if (canvas.width !== Math.floor(cssW * dpr) || canvas.height !== Math.floor(cssH * dpr)) {
      canvas.width = Math.floor(cssW * dpr);
      canvas.height = Math.floor(cssH * dpr);
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
    }

    const selected = new Set(selectedIds);
    const boxes = silhouettesFor(items, planView, selected, inventory);
    boxesRef.current = boxes;

    if (!fittedRef.current) {
      viewRef.current = fitView(boxes, cssW, cssH);
      fittedRef.current = true;
    }

    const view = viewRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const bg = readCssVar(wrap, '--bg', '#0a0b0d');
    const surface = readCssVar(wrap, '--surface', '#101216');
    const ink = readCssVar(wrap, '--ink', '#eceef1');
    const ink3 = readCssVar(wrap, '--ink-3', '#757d88');
    const line = readCssVar(wrap, '--line-strong', 'rgba(255,255,255,0.13)');
    const soft = readCssVar(wrap, '--accent-soft', 'rgba(77,148,255,0.16)');
    const danger = readCssVar(wrap, '--danger', '#ff6b6b');

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, cssW, cssH);

    // Ground line at world y = 0.
    const ground = worldToScreen(0, 0, view);
    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, ground.y);
    ctx.lineTo(cssW, ground.y);
    ctx.stroke();

    // Floor wash below ground.
    ctx.fillStyle = surface;
    ctx.globalAlpha = 0.55;
    ctx.fillRect(0, ground.y, cssW, cssH - ground.y);
    ctx.globalAlpha = 1;

    ctx.fillStyle = ink3;
    ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
    ctx.fillText('0', 8, ground.y - 6);

    for (const box of boxes) {
      const tl = worldToScreen(box.left, box.bottom + box.height, view);
      const br = worldToScreen(box.left + box.width, box.bottom, view);
      const x = tl.x;
      const y = tl.y;
      const w = Math.max(1, br.x - tl.x);
      const h = Math.max(1, br.y - tl.y);

      ctx.fillStyle = box.selected ? soft : surface;
      ctx.strokeStyle = box.selected ? danger : ink3;
      ctx.lineWidth = box.selected ? 2 : 1;
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

      if (w > 28 && h > 14) {
        ctx.fillStyle = ink;
        ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
        const label = box.name.replace(/\s*\((FV-SV|FV|SV|RV|R)\)\s*$/i, '');
        ctx.save();
        ctx.beginPath();
        ctx.rect(x + 2, y + 2, w - 4, h - 4);
        ctx.clip();
        ctx.fillText(label, x + 4, y + 12);
        ctx.restore();
      }
    }
  }, [inventory, items, planView, selectedIds]);

  useEffect(() => {
    fittedRef.current = false;
    paint();
  }, [items, planView, paint]);

  useEffect(() => {
    paint();
  }, [paint, selectedIds]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      fittedRef.current = false;
      paint();
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [paint]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const sx = event.clientX - rect.left;
      const sy = event.clientY - rect.top;
      const view = viewRef.current;
      const worldX = (sx - view.offsetX) / view.scale;
      const worldY = -(sy - view.offsetY) / view.scale;
      const id = hitTest(boxesRef.current, worldX, worldY);
      if (id == null) {
        onSelect([]);
        return;
      }
      if (event.shiftKey || event.metaKey || event.ctrlKey) {
        const next = new Set(selectedIds);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        onSelect([...next]);
      } else {
        onSelect([id]);
      }
    },
    [onSelect, selectedIds],
  );

  return (
    <div
      ref={wrapRef}
      className="elevation-canvas"
      data-plan-view={planView}
      aria-label={`${planView} elevation`}
      style={{ position: 'relative', width: '100%', height: '100%', minHeight: 160, overflow: 'hidden' }}
    >
      <canvas ref={canvasRef} onPointerDown={onPointerDown} style={{ display: 'block' }} />
    </div>
  );
}
