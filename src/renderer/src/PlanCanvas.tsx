import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { Scene, Layer, ScenePrimitive } from '../../format/scene.js';
import { resolveStyle, type DrawingStyle } from '../../format/style.js';
import { formatLength, UNITS_PER_METRE, type UnitSystem } from '../../format/units.js';
import { IconPlus, IconMinus, IconFit, IconHand } from './icons.js';
import type { PlanPoint, PointerSpec } from './tool/machine.js';

const UNITS_PER_FOOT = 120;
/** Width of the ruler gutters along the top and left edges. */
const RULER = 22;
/** Hit-testing every pointer move gets expensive on very large plans. */
const HOVER_PRIMITIVE_LIMIT = 24000;

export interface View {
  scale: number;
  offsetX: number;
  offsetY: number;
}

interface Props {
  scene: Scene | null;
  visibleLayers: Set<Layer>;
  paper: boolean;
  /** When false, the drawing grid is hidden (rulers stay). */
  showGrid?: boolean;
  fitToken: number;
  /** Selected object ids. Empty means nothing is selected. */
  selection: number[];
  onSelect: (ids: number[]) => void;
  /** Fired once a drag ends, with the total movement in logical units. */
  onMoveSelection: (dx: number, dy: number) => void;
  editable: boolean;
  /** Reports the pointer position in logical units, or null when outside. */
  onCursor?: (position: { x: number; y: number } | null) => void;
  onZoom?: (scale: number) => void;
  /** Fired when a inventory item is dropped onto the drawing. */
  onDropItem?: (id: string, x: number, y: number) => void;
  /** Fired when a gear-list line is dragged onto the drawing. */
  onDropGear?: (description: string, x: number, y: number) => void;
  /** Grid step to snap to, in logical units. Zero disables snapping. */
  snapStep?: number;
  /** How rulers and temporary measurements are labelled. */
  units?: UnitSystem;
  /**
   * How to read the next click.
   *
   * The canvas used to take eight tool props and work out what a click meant by
   * testing them in a fixed order, two of them pre-mixed at the call site to
   * squeeze three tools through two slots. It now reads one projection of one
   * value: what mode, whether to snap, whether to hit-test, what to rubber-band.
   * The ordering in `onPointerDown` no longer carries any weight, because the
   * modes are exclusive by construction.
   */
  pointerMode: PointerSpec;
  /** The start point of a half-made span, for the rubber band. */
  spanFrom?: PlanPoint | null;
  /** The completed measure readout; stays visible until the tool is put down. */
  readout?: { from: PlanPoint; to: PlanPoint } | null;
  /** A click that the pointer mode says means something. Already snapped. */
  onCanvasClick?: (at: PlanPoint) => void;
  /** The Hand button and H both ask for the same tool, which App owns. */
  onToggleHand?: () => void;
}

/**
 * A pen grade in screen pixels.
 *
 * Deliberately independent of zoom: a pen has one thickness, and a wall should
 * read as heavier than a chair whether the plan is at 2% or 200%. The floor
 * keeps the finest grade visible on a normal display.
 */
const SCREEN_PIXELS_PER_POINT = 1.7;
function pointsToScreenPixels(points: number): number {
  return Math.max(0.9, points * SCREEN_PIXELS_PER_POINT);
}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface PreparedPrimitive extends Bounds {
  primitive: ScenePrimitive;
  paperColor: string;
  darkColor: string;
  /** Appearance from the shared drafting vocabulary the export also reads. */
  style: DrawingStyle;
}

/** Distance from a point to a line segment, used for hit-testing. */
function distanceToSegment(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - x0, py - y0);
  let t = ((px - x0) * dx + (py - y0) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

/** Even-odd polygon containment so filled equipment can be selected inside its outline. */
function pointInPolygon(x: number, y: number, pts: number[]): boolean {
  if (pts.length < 6) return false;
  let inside = false;
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
    const xi = pts[i];
    const yi = pts[i + 1];
    const xj = pts[j];
    const yj = pts[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Finds the object nearest a point.
 *
 * Ties break toward the physically smaller object, so clicking a chair that
 * overlaps a table selects the chair rather than the table beneath it.
 */
function hitTest(
  prepared: PreparedPrimitive[],
  visible: Set<Layer>,
  x: number,
  y: number,
  tolerance: number,
): number | null {
  let best: { id: number; distance: number; size: number } | null = null;

  for (const item of prepared) {
    const p = item.primitive;
    if (!visible.has(p.layer)) continue;

    let distance = Infinity;

    // Cheap reject before the per-segment work.
    if (
      x < item.minX - tolerance ||
      x > item.maxX + tolerance ||
      y < item.minY - tolerance ||
      y > item.maxY + tolerance
    ) {
      continue;
    }

    if (p.type === 'text' || p.pts.length === 2) {
      distance = Math.hypot(x - p.pts[0], y - p.pts[1]);
    } else {
      for (let i = 0; i + 3 < p.pts.length; i += 2) {
        distance = Math.min(distance, distanceToSegment(x, y, p.pts[i], p.pts[i + 1], p.pts[i + 2], p.pts[i + 3]));
      }
      if (p.type === 'polygon' && p.pts.length >= 4) {
        distance = Math.min(
          distance,
          distanceToSegment(x, y, p.pts[p.pts.length - 2], p.pts[p.pts.length - 1], p.pts[0], p.pts[1]),
        );
        if (pointInPolygon(x, y, p.pts)) distance = 0;
      }
    }

    if (distance > tolerance) continue;
    const size = Math.max(1, (item.maxX - item.minX) * (item.maxY - item.minY));
    if (!best || distance < best.distance - 1 || (Math.abs(distance - best.distance) <= 1 && size < best.size)) {
      best = { id: p.selectId, distance, size };
    }
  }

  return best?.id ?? null;
}

/** COLORREF (0x00BBGGRR) to a CSS colour. */
function colorRefToCss(color: number, paper: boolean): string {
  const r = color & 0xff;
  const g = (color >> 8) & 0xff;
  const b = (color >> 16) & 0xff;
  // White strokes vanish on a light sheet and near-black vanishes on a dark
  // one; flip only those two extremes so plans stay legible either way.
  if (paper && r > 235 && g > 235 && b > 235) return '#31353b';
  if (!paper && r < 40 && g < 40 && b < 40) return '#dfe4ea';
  return `rgb(${r},${g},${b})`;
}

/** Picks a grid step so lines land roughly `target` pixels apart. */
/** Returns a ruler/grid major step in logical units for the current zoom. */
function gridStepUnits(scale: number, targetPx: number, system: UnitSystem): number {
  if (system === 'metric') {
    const metres = [0.1, 0.2, 0.5, 1, 2, 5, 10, 25, 50];
    return metres.map((m) => m * UNITS_PER_METRE).find((u) => u * scale > targetPx) ?? 100 * UNITS_PER_METRE;
  }
  const feet = [1, 2, 5, 10, 25, 50, 100, 250];
  return feet.map((f) => f * UNITS_PER_FOOT).find((u) => u * scale > targetPx) ?? 500 * UNITS_PER_FOOT;
}

function rulerLabel(logical: number, system: UnitSystem): string {
  if (system === 'metric') {
    const metres = logical / UNITS_PER_METRE;
    if (Math.abs(metres) < 1) return `${Math.round(metres * 100)}cm`;
    return Number.isInteger(metres) ? `${metres}m` : `${metres.toFixed(1)}m`;
  }
  return `${Math.round(logical / UNITS_PER_FOOT)}′`;
}

export function PlanCanvas({
  scene,
  visibleLayers,
  paper,
  showGrid = true,
  fitToken,
  selection,
  onSelect,
  onMoveSelection,
  editable,
  onCursor,
  onZoom,
  onDropItem,
  onDropGear,
  snapStep = 0,
  units = 'imperial',
  pointerMode,
  spanFrom,
  readout,
  onCanvasClick,
  onToggleHand,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<View>({ scale: 0.05, offsetX: 0, offsetY: 0 });
  const [size, setSize] = useState({ width: 800, height: 600 });
  const panRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const moveRef = useRef<{ startX: number; startY: number } | null>(null);
  const [nudge, setNudge] = useState<{ dx: number; dy: number } | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [dropping, setDropping] = useState<{
    kind: 'inventory' | 'gear';
    label: string;
    x: number;
    y: number;
  } | null>(null);
  /**
   * Held space pans, so navigating never fights the selection tools.
   *
   * Deliberately NOT part of the tool machine: Space is a transient modifier
   * held during another operation, and the tool value describes what the *next*
   * click will do. Folding one into the other is the kind of coupling this
   * rebuild removed. The persistent Hand tool, which is a tool, lives in the
   * machine — it used to be a fourteenth cell here, force-cleared from an
   * effect because nothing enforced its exclusivity.
   */
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  /** Rubber-band rectangle, in plan units, while dragging on empty space. */
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const marqueeRef = useRef<{ x0: number; y0: number } | null>(null);
  /** Guides shown while a snap is holding, in plan coordinates. */
  const [guides, setGuides] = useState<{ x?: number; y?: number }>({});
  const viewRef = useRef(view);
  const queuedViewRef = useRef<View | null>(null);
  const viewFrameRef = useRef<number | null>(null);
  const hoverFrameRef = useRef<number | null>(null);
  const hoverPointRef = useRef<{ x: number; y: number } | null>(null);

  /**
   * Geometry bounds and display colours change only with the document. Keeping
   * them out of the animation loop makes hit-testing and viewport culling cheap.
   */
  const prepared = useMemo<PreparedPrimitive[]>(() => {
    if (!scene) return [];
    return scene.primitives.map((primitive) => {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < primitive.pts.length; i += 2) {
        minX = Math.min(minX, primitive.pts[i]);
        minY = Math.min(minY, primitive.pts[i + 1]);
        maxX = Math.max(maxX, primitive.pts[i]);
        maxY = Math.max(maxY, primitive.pts[i + 1]);
      }
      return {
        primitive,
        minX,
        minY,
        maxX,
        maxY,
        paperColor: colorRefToCss(primitive.color, true),
        darkColor: colorRefToCss(primitive.color, false),
        style: resolveStyle(primitive),
      };
    });
  }, [scene]);

  const selectionSet = useMemo(() => new Set(selection), [selection]);

  /** One combined bound per selectable object, rebuilt only when layers change. */
  const objectBounds = useMemo(() => {
    const result = new Map<number, Bounds>();
    for (const item of prepared) {
      const p = item.primitive;
      if (!visibleLayers.has(p.layer) || !Number.isFinite(item.minX)) continue;
      const current = result.get(p.selectId);
      if (current) {
        current.minX = Math.min(current.minX, item.minX);
        current.minY = Math.min(current.minY, item.minY);
        current.maxX = Math.max(current.maxX, item.maxX);
        current.maxY = Math.max(current.maxY, item.maxY);
      } else {
        result.set(p.selectId, {
          minX: item.minX,
          minY: item.minY,
          maxX: item.maxX,
          maxY: item.maxY,
        });
      }
    }
    return result;
  }, [prepared, visibleLayers]);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  /** Coalesce high-frequency input so React and the canvas render at most once per frame. */
  const scheduleView = useCallback((update: (current: View) => View) => {
    queuedViewRef.current = update(queuedViewRef.current ?? viewRef.current);
    if (viewFrameRef.current != null) return;
    viewFrameRef.current = window.requestAnimationFrame(() => {
      viewFrameRef.current = null;
      const next = queuedViewRef.current;
      queuedViewRef.current = null;
      if (!next) return;
      viewRef.current = next;
      setView(next);
    });
  }, []);

  useEffect(
    () => () => {
      if (viewFrameRef.current != null) window.cancelAnimationFrame(viewFrameRef.current);
      if (hoverFrameRef.current != null) window.cancelAnimationFrame(hoverFrameRef.current);
    },
    [],
  );

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }));
    observer.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => observer.disconnect();
  }, []);

  /** Fits the whole room on the sheet. Returns false when there is nothing to fit to yet. */
  const fit = useCallback((): boolean => {
    const target = scene?.roomExtent ?? scene?.extent;
    if (!target) return false;

    // Measure the sheet here rather than trusting `size`.
    //
    // `size` starts at a placeholder and only becomes real once the
    // ResizeObserver's update has been rendered — a render later than the
    // first fit, which React flushes while the placeholder is still in state.
    // Fitting to that placeholder left every freshly mounted plan at the wrong
    // zoom and off centre until the Fit button was pressed a second time. The
    // element knows its own size at every one of those moments, so ask it.
    const el = wrapRef.current;
    const width = el ? el.clientWidth : size.width;
    const height = el ? el.clientHeight : size.height;
    if (width < 10 || height < 10) return false;

    const padX = Math.max(width - RULER - 72, 1);
    const padY = Math.max(height - RULER - 72, 1);
    const w = Math.max(target.maxX - target.minX, 1);
    const h = Math.max(target.maxY - target.minY, 1);
    const scale = Math.min(4, Math.max(0.0015, Math.min(padX / w, padY / h)));
    const cx = (target.minX + target.maxX) / 2;
    const cy = (target.minY + target.maxY) / 2;
    setView({
      scale,
      offsetX: (width + RULER) / 2 - cx * scale,
      offsetY: (height + RULER) / 2 - cy * scale,
    });
    return true;
  }, [scene, size.width, size.height]);

  // Space temporarily pans and H toggles a persistent Hand tool. Both are
  // ignored while typing, so navigation never eats text-field input.
  //
  // H asks the machine for the Hand tool rather than setting local state, so
  // picking it puts down whatever else was in hand — the exclusivity that used
  // to be patched in by an effect further down this file.
  const toggleHandRef = useRef(onToggleHand);
  toggleHandRef.current = onToggleHand;
  useEffect(() => {
    const typing = (target: EventTarget | null): boolean => {
      const el = target as HTMLElement | null;
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    };
    const down = (e: KeyboardEvent) => {
      if (typing(e.target)) return;
      if (e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        setSpaceHeld(true);
      } else if (e.key.toLowerCase() === 'h' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.repeat) {
        e.preventDefault();
        toggleHandRef.current?.();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(false);
    };
    // Releasing space outside the window would otherwise leave panning stuck on.
    const blur = () => setSpaceHeld(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  /**
   * Fits the view, but only when asked.
   *
   * `fit` is rebuilt whenever the scene object changes, and every edit produces
   * a new scene — so depending on it here meant each change re-fitted the view.
   * Zoom in on a corner, move one chair, and you were thrown back out to the
   * whole room before the change appeared. The view is the user's; nothing but
   * an explicit request may move it.
   *
   * `fitToken` is bumped when a plan is opened and by the Fit command, which
   * covers both times a fit is actually wanted. The first fit still happens on
   * its own, once the canvas has a size and something to show.
   */
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const fittedFor = useRef<number | null>(null);

  useEffect(() => {
    if (fittedFor.current === fitToken) return;
    if (!scene) return;
    // Only record the token once a fit actually happened, so a canvas that has
    // no size yet is fitted on the render that gives it one.
    if (fitRef.current()) fittedFor.current = fitToken;
  }, [fitToken, scene, size.width]);

  useEffect(() => {
    onZoom?.(view.scale);
  }, [view.scale, onZoom]);

  const zoomBy = (factor: number) => {
    const cx = (size.width + RULER) / 2;
    const cy = (size.height + RULER) / 2;
    scheduleView((v) => {
      const scale = Math.min(4, Math.max(0.0015, v.scale * factor));
      const k = scale / v.scale;
      return { scale, offsetX: cx - (cx - v.offsetX) * k, offsetY: cy - (cy - v.offsetY) * k };
    });
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(size.width * dpr);
    canvas.height = Math.floor(size.height * dpr);
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const sheet = paper ? '#fbfbfb' : '#0e1013';
    ctx.fillStyle = sheet;
    ctx.fillRect(0, 0, size.width, size.height);

    if (!scene) {
      drawRulers(ctx, size, view, paper, units);
      return;
    }

    const { scale, offsetX, offsetY } = view;
    const tx = (x: number) => x * scale + offsetX;
    const ty = (y: number) => y * scale + offsetY;
    // Leave a screen-space margin for strokes and labels; everything beyond it
    // is invisible and need not be sent through the canvas drawing pipeline.
    const viewportPad = 36 / scale;
    const viewport = {
      minX: (-offsetX - 36) / scale,
      minY: (-offsetY - 36) / scale,
      maxX: (size.width - offsetX + 36) / scale,
      maxY: (size.height - offsetY + 36) / scale,
    };

    drawGrid(ctx, size, view, paper, showGrid, units);

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    for (const item of prepared) {
      const p = item.primitive;
      if (!visibleLayers.has(p.layer)) continue;
      const isSelected = selectionSet.has(p.selectId);
      const ox = isSelected && nudge ? nudge.dx : 0;
      const oy = isSelected && nudge ? nudge.dy : 0;
      if (
        item.maxX + ox < viewport.minX - viewportPad ||
        item.minX + ox > viewport.maxX + viewportPad ||
        item.maxY + oy < viewport.minY - viewportPad ||
        item.minY + oy > viewport.maxY + viewportPad
      ) {
        continue;
      }

      const isHovered = !isSelected && hover != null && p.selectId === hover;

      ctx.strokeStyle = isSelected ? '#4d94ff' : isHovered ? '#8bb9ff' : paper ? item.paperColor : item.darkColor;
      ctx.fillStyle = ctx.strokeStyle;
      // The same pen grades the export uses. A point of paper is a different
      // number of screen pixels at every zoom, so it is converted here rather
      // than each renderer inventing its own widths — that divergence is why
      // the canvas and the print never matched.
      ctx.lineWidth = isSelected
        ? 2.2
        : isHovered
          ? 1.6
          : pointsToScreenPixels(item.style.strokePoints);

      switch (p.type) {
        case 'text': {
          if (!p.text) break;
          const fontPx = Math.max(9, Math.min(21, 130 * scale));
          if (fontPx < 7.5) break;
          ctx.font = `${fontPx}px -apple-system, "Segoe UI", system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(p.text, tx(p.pts[0] + ox), ty(p.pts[1] + oy));
          break;
        }
        case 'bezier': {
          if (p.pts.length < 8) break;
          ctx.beginPath();
          ctx.moveTo(tx(p.pts[0] + ox), ty(p.pts[1] + oy));
          ctx.bezierCurveTo(
            tx(p.pts[2] + ox),
            ty(p.pts[3] + oy),
            tx(p.pts[4] + ox),
            ty(p.pts[5] + oy),
            tx(p.pts[6] + ox),
            ty(p.pts[7] + oy),
          );
          ctx.stroke();
          break;
        }
        case 'dimension': {
          ctx.save();
          // Solid, like the export and like a drawing. The dashes here were a
          // hardcoded consequence of the primitive's type, with no way to ask
          // for anything else.
          ctx.globalAlpha = 0.85;
          ctx.beginPath();
          ctx.moveTo(tx(p.pts[0] + ox), ty(p.pts[1] + oy));
          for (let i = 2; i < p.pts.length; i += 2) ctx.lineTo(tx(p.pts[i] + ox), ty(p.pts[i + 1] + oy));
          ctx.stroke();
          ctx.restore();
          break;
        }
        default: {
          ctx.beginPath();
          ctx.moveTo(tx(p.pts[0] + ox), ty(p.pts[1] + oy));
          for (let i = 2; i < p.pts.length; i += 2) ctx.lineTo(tx(p.pts[i] + ox), ty(p.pts[i + 1] + oy));
          if (p.type === 'polygon') ctx.closePath();
          // A deck is a surface. Nothing was ever filled here: fillStyle was set
          // for text and `fill()` was never called for geometry, so a stage read
          // as an empty outline.
          if (item.style.fill && !isSelected && !isHovered) {
            ctx.fillStyle = item.style.fill;
            ctx.fill();
            ctx.fillStyle = ctx.strokeStyle;
          }
          ctx.stroke();
          break;
        }
      }
    }

    for (const id of selection) {
      const b = objectBounds.get(id);
      if (b) drawSelectionFrame(ctx, b, view, nudge);
    }

    if (marquee) drawMarquee(ctx, marquee, view);
    if (guides.x != null || guides.y != null) drawGuides(ctx, guides, size, view);

    // One rubber band, chosen by the tool rather than by testing three cells:
    // a draw tool previews its own shape, a measure or dimension previews the
    // measurement, and a line wants no dimension text because it is drawing.
    if (spanFrom && pointerMode.preview !== 'none') {
      const to = pointer ?? spanFrom;
      if (pointerMode.preview === 'measure') drawMeasurement(ctx, spanFrom, to, view, paper, units);
      else drawShapePreview(ctx, spanFrom, to, pointerMode.preview, view);
    } else if (readout) {
      drawMeasurement(ctx, readout.from, readout.to, view, paper, units);
    }

    drawRulers(ctx, size, view, paper, units);
  }, [
    scene,
    prepared,
    objectBounds,
    view,
    size,
    visibleLayers,
    paper,
    showGrid,
    units,
    selection,
    selectionSet,
    hover,
    nudge,
    spanFrom,
    readout,
    pointerMode,
    pointer,
    marquee,
    guides,
  ]);

  /** Screen pixels to plan coordinates. */
  const toPlan = (e: { clientX: number; clientY: number; currentTarget: Element }) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left - view.offsetX) / view.scale,
      y: (e.clientY - rect.top - view.offsetY) / view.scale,
    };
  };

  /**
   * Wheel and trackpad.
   *
   * A two-finger scroll is how anyone moves around a drawing on a laptop, so it
   * pans. Zoom is the pinch gesture — which Chromium reports as a wheel event
   * with `ctrlKey` set — or ctrl/cmd with the wheel, matching every other
   * drawing tool. Zooming on every wheel event left no way to pan at all
   * without holding Alt, which nobody discovers.
   */
  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const unit = e.deltaMode === 1 ? 18 : e.deltaMode === 2 ? Math.max(size.width, size.height) : 1;
    const deltaX = e.deltaX * unit;
    const deltaY = e.deltaY * unit;

    if (e.ctrlKey || e.metaKey) {
      scheduleView((v) => {
        const factor = Math.exp(-deltaY * 0.0015);
        const scale = Math.min(4, Math.max(0.0015, v.scale * factor));
        const k = scale / v.scale;
        return { scale, offsetX: mx - (mx - v.offsetX) * k, offsetY: my - (my - v.offsetY) * k };
      });
      return;
    }

    // Shift + a conventional mouse wheel pans sideways on both platforms.
    const panX = e.shiftKey && Math.abs(deltaX) < Math.abs(deltaY) ? deltaY : deltaX;
    const panY = e.shiftKey && Math.abs(deltaX) < Math.abs(deltaY) ? 0 : deltaY;
    scheduleView((v) => ({ ...v, offsetX: v.offsetX - panX, offsetY: v.offsetY - panY }));
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);

    // Two decisions, in this order, and the order is now inert: navigation
    // overrides first — holding Space, the Hand tool, a middle/right button or
    // Alt must never place an item or record a point — then whatever the one
    // tool value says. There is no third case to get wrong, because a stamp and
    // a span cannot both be live.
    const wantsPan =
      pointerMode.mode === 'pan' || e.button === 1 || e.button === 2 || e.altKey || spaceHeld || !scene;
    if (wantsPan) {
      panRef.current = { x: e.clientX, y: e.clientY, ox: view.offsetX, oy: view.offsetY };
      return;
    }

    if ((pointerMode.mode === 'stamp' || pointerMode.mode === 'span') && onCanvasClick && e.button === 0) {
      const point = toPlan(e);
      // Association is decided at the actual click location, before optional
      // grid snapping changes the coordinate. This lets a dimension follow the
      // object that was clicked instead of becoming a detached drawing line.
      const nodeId = pointerMode.associate
        ? (hitTest(prepared, visibleLayers, point.x, point.y, 8 / view.scale) ?? undefined)
        : undefined;
      const coordinate =
        pointerMode.snap === 'grid' && snapStep
          ? {
              x: Math.round(point.x / snapStep) * snapStep,
              y: Math.round(point.y / snapStep) * snapStep,
            }
          : point;
      onCanvasClick(nodeId == null ? coordinate : { ...coordinate, nodeId });
      return;
    }

    if (scene) {
      const { x, y } = toPlan(e);
      const hit = hitTest(prepared, visibleLayers, x, y, 8 / view.scale);

      if (hit != null) {
        // Shift extends the selection; a plain click replaces it. Clicking
        // inside an existing selection keeps it, so a group can be dragged.
        const next = e.shiftKey
          ? selection.includes(hit)
            ? selection.filter((id) => id !== hit)
            : [...selection, hit]
          : selection.includes(hit)
            ? selection
            : [hit];
        onSelect(next);

        if (editable && next.length) {
          moveRef.current = { startX: x, startY: y };
          setNudge({ dx: 0, dy: 0 });
          return;
        }
      } else if (e.shiftKey || e.button === 0) {
        // Empty space: start a rubber band rather than panning.
        marqueeRef.current = { x0: x, y0: y };
        setMarquee({ x0: x, y0: y, x1: x, y1: y });
        if (!e.shiftKey) onSelect([]);
        return;
      }
    }

    panRef.current = { x: e.clientX, y: e.clientY, ox: view.offsetX, oy: view.offsetY };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const pan = panRef.current;
    if (pan) {
      scheduleView((v) => ({
        ...v,
        offsetX: pan.ox + (e.clientX - pan.x),
        offsetY: pan.oy + (e.clientY - pan.y),
      }));
      return;
    }

    const plan = toPlan(e);
    onCursor?.(plan);
    if (pointerMode.mode === 'span') setPointer(plan);

    const band = marqueeRef.current;
    if (band) {
      setMarquee({ x0: band.x0, y0: band.y0, x1: plan.x, y1: plan.y });
      return;
    }

    const moving = moveRef.current;
    if (moving) {
      const raw = { dx: plan.x - moving.startX, dy: plan.y - moving.startY };
      const snapped = scene ? applySnap(objectBounds, selection, raw, snapStep, view.scale) : { ...raw, guides: {} };
      setGuides(snapped.guides);
      setNudge({ dx: snapped.dx, dy: snapped.dy });
      return;
    }

    if (scene && editable && scene.primitives.length <= HOVER_PRIMITIVE_LIMIT) {
      hoverPointRef.current = plan;
      if (hoverFrameRef.current == null) {
        hoverFrameRef.current = window.requestAnimationFrame(() => {
          hoverFrameRef.current = null;
          const point = hoverPointRef.current;
          if (point) setHover(hitTest(prepared, visibleLayers, point.x, point.y, 8 / viewRef.current.scale));
        });
      }
    }
  };

  const endDrag = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);

    if (marqueeRef.current && marquee && scene) {
      const box = {
        minX: Math.min(marquee.x0, marquee.x1),
        maxX: Math.max(marquee.x0, marquee.x1),
        minY: Math.min(marquee.y0, marquee.y1),
        maxY: Math.max(marquee.y0, marquee.y1),
      };
      marqueeRef.current = null;
      setMarquee(null);

      // A band smaller than a few pixels is a stray click, not a selection.
      if ((box.maxX - box.minX) * view.scale > 4 || (box.maxY - box.minY) * view.scale > 4) {
        const caught = new Set<number>(e.shiftKey ? selection : []);
        const crossing = marquee.x1 < marquee.x0;
        for (const [id, bounds] of objectBounds) {
          const intersects =
            bounds.maxX >= box.minX &&
            bounds.minX <= box.maxX &&
            bounds.maxY >= box.minY &&
            bounds.minY <= box.maxY;
          const enclosed =
            bounds.minX >= box.minX &&
            bounds.maxX <= box.maxX &&
            bounds.minY >= box.minY &&
            bounds.maxY <= box.maxY;
          // Drafting convention: left-to-right is a containing window;
          // right-to-left is a crossing window.
          if (crossing ? intersects : enclosed) caught.add(id);
        }
        onSelect([...caught]);
      }
      return;
    }

    if (moveRef.current) {
      const moved = nudge;
      moveRef.current = null;
      setNudge(null);
      setGuides({});
      // Ignore the incidental movement of an ordinary click.
      if (moved && Math.hypot(moved.dx, moved.dy) * view.scale > 3) {
        onMoveSelection(moved.dx, moved.dy);
      }
    }
    panRef.current = null;
  };

  // The one place the tool's mode becomes the CSS cursor token, plus the two
  // transient overrides the canvas owns: a held Space and a drag in progress.
  const mode =
    pointerMode.mode === 'span'
      ? 'measure'
      : pointerMode.mode === 'stamp'
        ? 'place'
        : pointerMode.mode === 'pan' || panRef.current
          ? 'pan'
          : 'select';

  // Which half of a two-point tool the next click completes. It is the same
  // thing the on-sheet prompt says in words, published where it can be read
  // without parsing copy: after every click it must flip, and a run of clicks
  // that does not flip it has had one taken from it by something over the
  // sheet.
  const twoPoint: 'start' | 'end' | undefined = pointerMode.parity;

  return (
    <div
      className="canvas-wrap"
      ref={wrapRef}
      data-mode={spaceHeld ? 'pan' : mode}
      data-two-point={twoPoint}
      data-dropping={dropping?.kind}
    >
      <canvas
        ref={canvasRef}
        role="application"
        aria-label="Plan canvas. Click to select, drag to move, press H for the Hand tool, hold Space to pan, and use Control or Command plus the wheel to zoom."
        tabIndex={0}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onContextMenu={(e) => e.preventDefault()}
        onPointerLeave={() => {
          onCursor?.(null);
          setHover(null);
        }}
        onDragOver={(e) => {
          const inventoryDrop =
            !!onDropItem && e.dataTransfer.types.includes('application/x-groundplan-item');
          const gearDrop =
            !!onDropGear && e.dataTransfer.types.includes('application/x-groundplan-gear');
          if (!inventoryDrop && !gearDrop) return;
          // Without this the browser refuses the drop and no drop event fires.
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          const rect = e.currentTarget.getBoundingClientRect();
          const cueWidth = 230;
          const cueHeight = 64;
          setDropping({
            kind: gearDrop ? 'gear' : 'inventory',
            label:
              e.dataTransfer.getData('application/x-groundplan-label') ||
              (gearDrop ? 'Gear item' : 'Inventory item'),
            x: Math.max(8, Math.min(rect.width - cueWidth, e.clientX - rect.left)),
            y: Math.max(8, Math.min(rect.height - cueHeight, e.clientY - rect.top)),
          });
        }}
        onDragLeave={() => setDropping(null)}
        onDrop={(e) => {
          setDropping(null);
          const id = e.dataTransfer.getData('application/x-groundplan-item');
          const description = e.dataTransfer.getData('application/x-groundplan-gear');
          if ((!id || !onDropItem) && (!description || !onDropGear)) return;
          e.preventDefault();
          const { x, y } = toPlan(e);
          const step = snapStep ?? 0;
          const snappedX = step ? Math.round(x / step) * step : x;
          const snappedY = step ? Math.round(y / step) * step : y;
          if (description && onDropGear) onDropGear(description, snappedX, snappedY);
          else if (id && onDropItem) onDropItem(id, snappedX, snappedY);
        }}
      />
      {dropping && (
        <div
          className="canvas-drop-cue"
          role="status"
          aria-live="polite"
          style={{ left: dropping.x, top: dropping.y }}
        >
          <span className="canvas-drop-icon" aria-hidden><IconPlus size={15} /></span>
          <span>
            <strong>{dropping.label}</strong>
            <small>Release to place{snapStep ? ' · grid snap on' : ''}</small>
          </span>
        </div>
      )}
      <div className="zoom-cluster">
        <button
          className={`icon-btn${pointerMode.mode === 'pan' ? ' is-on' : ''}`}
          onClick={() => onToggleHand?.()}
          title="Hand tool — drag to pan (H)"
          aria-label="Hand tool — drag to pan (H)"
          aria-pressed={pointerMode.mode === 'pan'}
        >
          <IconHand />
        </button>
        <button className="icon-btn" onClick={() => zoomBy(1 / 1.3)} title="Zoom out" aria-label="Zoom out">
          <IconMinus />
        </button>
        <span className="zoom-level num">{Math.round(view.scale * 1000) / 10}%</span>
        <button className="icon-btn" onClick={() => zoomBy(1.3)} title="Zoom in" aria-label="Zoom in">
          <IconPlus />
        </button>
        <button className="icon-btn" onClick={fit} title="Zoom to fit (Cmd/Ctrl+0)" aria-label="Zoom to fit">
          <IconFit />
        </button>
      </div>
    </div>
  );
}

/**
 * Adjusts a drag so it lands on something meaningful.
 *
 * Two kinds of snap, in order of usefulness: lining up with an object already
 * on the plan, and landing on the grid. Aligning two hundred chairs by eye is
 * the difference between a drawing that looks drafted and one that looks
 * nudged, so object alignment wins when both are in range.
 */
function applySnap(
  objectBounds: Map<number, Bounds>,
  selection: number[],
  raw: { dx: number; dy: number },
  step: number,
  viewScale: number,
): { dx: number; dy: number; guides: { x?: number; y?: number } } {
  if (!selection.length) return { ...raw, guides: {} };

  const moving = boundsOfMany(objectBounds, selection);
  if (!moving) return { ...raw, guides: {} };

  const centre = {
    x: (moving.minX + moving.maxX) / 2 + raw.dx,
    y: (moving.minY + moving.maxY) / 2 + raw.dy,
  };

  // Snap tolerance is a fixed screen distance, so it feels the same at any zoom.
  const tolerance = 7 / viewScale;
  const selected = new Set(selection);
  const guides: { x?: number; y?: number } = {};
  let dx = raw.dx;
  let dy = raw.dy;
  let bestX: { at: number; gap: number } | null = null;
  let bestY: { at: number; gap: number } | null = null;

  for (const [id, bounds] of objectBounds) {
    if (selected.has(id)) continue;
    const { minX, minY, maxX, maxY } = bounds;

    for (const candidate of [(minX + maxX) / 2, minX, maxX]) {
      const gap = Math.abs(candidate - centre.x);
      if (gap < tolerance && (!bestX || gap < bestX.gap)) bestX = { at: candidate, gap };
    }
    for (const candidate of [(minY + maxY) / 2, minY, maxY]) {
      const gap = Math.abs(candidate - centre.y);
      if (gap < tolerance && (!bestY || gap < bestY.gap)) bestY = { at: candidate, gap };
    }
  }

  if (bestX) {
    dx += bestX.at - centre.x;
    guides.x = bestX.at;
  } else if (step > 0) {
    dx += Math.round(centre.x / step) * step - centre.x;
  }

  if (bestY) {
    dy += bestY.at - centre.y;
    guides.y = bestY.at;
  } else if (step > 0) {
    dy += Math.round(centre.y / step) * step - centre.y;
  }

  return { dx, dy, guides };
}

/** Combined bounding box of a whole selection. */
function boundsOfMany(objectBounds: Map<number, Bounds>, ids: number[]) {
  let box: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  for (const id of ids) {
    const b = objectBounds.get(id);
    if (!b) continue;
    box = box
      ? {
          minX: Math.min(box.minX, b.minX),
          minY: Math.min(box.minY, b.minY),
          maxX: Math.max(box.maxX, b.maxX),
          maxY: Math.max(box.maxY, b.maxY),
        }
      : b;
  }
  return box;
}

/** Alignment guides, drawn only while a snap is actually holding. */
function drawGuides(
  ctx: CanvasRenderingContext2D,
  guides: { x?: number; y?: number },
  size: { width: number; height: number },
  view: View,
): void {
  ctx.save();
  ctx.strokeStyle = '#ff4dd2';
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  if (guides.x != null) {
    const x = Math.round(guides.x * view.scale + view.offsetX) + 0.5;
    ctx.moveTo(x, RULER);
    ctx.lineTo(x, size.height);
  }
  if (guides.y != null) {
    const y = Math.round(guides.y * view.scale + view.offsetY) + 0.5;
    ctx.moveTo(RULER, y);
    ctx.lineTo(size.width, y);
  }
  ctx.stroke();
  ctx.restore();
}

/** The rubber-band rectangle drawn while selecting a group. */
function drawMarquee(
  ctx: CanvasRenderingContext2D,
  band: { x0: number; y0: number; x1: number; y1: number },
  view: View,
): void {
  const x = Math.min(band.x0, band.x1) * view.scale + view.offsetX;
  const y = Math.min(band.y0, band.y1) * view.scale + view.offsetY;
  const w = Math.abs(band.x1 - band.x0) * view.scale;
  const h = Math.abs(band.y1 - band.y0) * view.scale;

  ctx.save();
  ctx.fillStyle = 'rgba(77,148,255,0.12)';
  ctx.strokeStyle = 'rgba(77,148,255,0.7)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));
  ctx.restore();
}

/**
 * Previews the shape a draw tool is about to create.
 *
 * The same dashed accent as the marquee, because both mean the same thing: this
 * is not on the drawing yet.
 */
function drawShapePreview(
  ctx: CanvasRenderingContext2D,
  from: { x: number; y: number },
  to: { x: number; y: number },
  tool: 'line' | 'rect' | 'ellipse',
  view: View,
): void {
  const x0 = from.x * view.scale + view.offsetX;
  const y0 = from.y * view.scale + view.offsetY;
  const x1 = to.x * view.scale + view.offsetX;
  const y1 = to.y * view.scale + view.offsetY;

  ctx.save();
  ctx.strokeStyle = 'rgba(77,148,255,0.9)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 3]);
  ctx.beginPath();

  if (tool === 'line') {
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
  } else if (tool === 'rect') {
    ctx.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
  } else {
    // Drawn from corner to corner, like the rectangle it is inscribed in.
    ctx.ellipse(
      (x0 + x1) / 2,
      (y0 + y1) / 2,
      Math.abs(x1 - x0) / 2,
      Math.abs(y1 - y0) / 2,
      0,
      0,
      Math.PI * 2,
    );
  }

  ctx.stroke();
  ctx.restore();
}

/**
 * Draws a measurement between two points, labelled in the drawing unit system.
 */
function drawMeasurement(
  ctx: CanvasRenderingContext2D,
  from: { x: number; y: number },
  to: { x: number; y: number },
  view: View,
  paper: boolean,
  system: UnitSystem,
): void {
  const x0 = from.x * view.scale + view.offsetX;
  const y0 = from.y * view.scale + view.offsetY;
  const x1 = to.x * view.scale + view.offsetX;
  const y1 = to.y * view.scale + view.offsetY;

  const span = Math.hypot(to.x - from.x, to.y - from.y);
  const label = formatLength(span, system);

  ctx.save();
  ctx.strokeStyle = '#ff9f43';
  ctx.fillStyle = '#ff9f43';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();

  ctx.setLineDash([]);
  for (const [px, py] of [
    [x0, y0],
    [x1, y1],
  ]) {
    ctx.beginPath();
    ctx.arc(px, py, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Keep the readout upright and legible against either sheet colour.
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  ctx.font = '600 12px -apple-system, "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const width = ctx.measureText(label).width + 12;
  ctx.fillStyle = paper ? 'rgba(255,255,255,0.92)' : 'rgba(14,16,19,0.92)';
  ctx.fillRect(mx - width / 2, my - 10, width, 20);
  ctx.strokeStyle = '#ff9f43';
  ctx.lineWidth = 1;
  ctx.strokeRect(mx - width / 2, my - 10, width, 20);
  ctx.fillStyle = '#ff9f43';
  ctx.fillText(label, mx, my);
  ctx.restore();
}

/**
 * Two-tier grid: a fine step for reading small offsets and a heavier line
 * every five, which is how a drafting sheet is ruled.
 */
function drawGrid(
  ctx: CanvasRenderingContext2D,
  size: { width: number; height: number },
  view: View,
  paper: boolean,
  visible = true,
  system: UnitSystem = 'imperial',
): void {
  if (!visible) return;
  const minor = gridStepUnits(view.scale, 9, system);
  const spacing = minor * view.scale;
  if (spacing < 5) return;

  const draw = (step: number, alpha: number) => {
    ctx.save();
    ctx.strokeStyle = paper ? `rgba(20,26,36,${alpha})` : `rgba(150,180,220,${alpha})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const gap = step * view.scale;
    const startX = view.offsetX % gap;
    for (let x = startX; x < size.width; x += gap) {
      if (x < RULER) continue;
      ctx.moveTo(Math.round(x) + 0.5, RULER);
      ctx.lineTo(Math.round(x) + 0.5, size.height);
    }
    const startY = view.offsetY % gap;
    for (let y = startY; y < size.height; y += gap) {
      if (y < RULER) continue;
      ctx.moveTo(RULER, Math.round(y) + 0.5);
      ctx.lineTo(size.width, Math.round(y) + 0.5);
    }
    ctx.stroke();
    ctx.restore();
  };

  draw(minor, paper ? 0.05 : 0.045);
  if (spacing * 5 < Math.max(size.width, size.height)) draw(minor * 5, paper ? 0.11 : 0.09);
}

/** An honest bounds highlight. Resize is available in Properties, not via fake handles. */
function drawSelectionFrame(
  ctx: CanvasRenderingContext2D,
  b: { minX: number; minY: number; maxX: number; maxY: number },
  view: View,
  nudge: { dx: number; dy: number } | null,
): void {
  const dx = nudge?.dx ?? 0;
  const dy = nudge?.dy ?? 0;
  const pad = 5;
  const x0 = (b.minX + dx) * view.scale + view.offsetX - pad;
  const y0 = (b.minY + dy) * view.scale + view.offsetY - pad;
  const x1 = (b.maxX + dx) * view.scale + view.offsetX + pad;
  const y1 = (b.maxY + dy) * view.scale + view.offsetY + pad;

  ctx.save();
  ctx.strokeStyle = 'rgba(77,148,255,0.55)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, Math.round(x1 - x0), Math.round(y1 - y0));

  ctx.restore();
}

/**
 * Rulers along the top and left edges, marked in the drawing unit system.
 *
 * They occlude a strip of the sheet, which is the usual trade in drafting
 * software: knowing the scale at a glance is worth more than the pixels.
 */
function drawRulers(
  ctx: CanvasRenderingContext2D,
  size: { width: number; height: number },
  view: View,
  paper: boolean,
  system: UnitSystem,
): void {
  const bg = paper ? '#f1f1ef' : '#141619';
  const line = paper ? 'rgba(20,26,36,0.16)' : 'rgba(255,255,255,0.12)';
  const text = paper ? 'rgba(20,26,36,0.55)' : 'rgba(236,238,241,0.5)';

  ctx.save();
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, size.width, RULER);
  ctx.fillRect(0, 0, RULER, size.height);

  ctx.strokeStyle = line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, RULER + 0.5);
  ctx.lineTo(size.width, RULER + 0.5);
  ctx.moveTo(RULER + 0.5, 0);
  ctx.lineTo(RULER + 0.5, size.height);
  ctx.stroke();

  const step = gridStepUnits(view.scale, 54, system);
  const gap = step * view.scale;
  if (gap < 12) {
    ctx.restore();
    return;
  }

  ctx.fillStyle = text;
  ctx.font = '9.5px -apple-system, "Segoe UI", system-ui, sans-serif';
  ctx.strokeStyle = line;

  // Horizontal ruler.
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const firstX = Math.ceil((RULER - view.offsetX) / gap) * gap + view.offsetX;
  for (let x = firstX; x < size.width; x += gap) {
    const logical = Math.round((x - view.offsetX) / view.scale / step) * step;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, RULER - 5);
    ctx.lineTo(Math.round(x) + 0.5, RULER);
    ctx.stroke();
    ctx.fillText(rulerLabel(logical, system), Math.round(x) + 3, 11);
  }

  // Vertical ruler, labels rotated to read along the edge.
  const firstY = Math.ceil((RULER - view.offsetY) / gap) * gap + view.offsetY;
  for (let y = firstY; y < size.height; y += gap) {
    const logical = Math.round((y - view.offsetY) / view.scale / step) * step;
    ctx.beginPath();
    ctx.moveTo(RULER - 5, Math.round(y) + 0.5);
    ctx.lineTo(RULER, Math.round(y) + 0.5);
    ctx.stroke();
    ctx.save();
    ctx.translate(11, Math.round(y) + 3);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(rulerLabel(logical, system), 0, 0);
    ctx.restore();
  }

  // Mask the corner where the two rulers meet.
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, RULER, RULER);
  ctx.strokeStyle = line;
  ctx.beginPath();
  ctx.moveTo(0, RULER + 0.5);
  ctx.lineTo(RULER + 0.5, RULER + 0.5);
  ctx.lineTo(RULER + 0.5, 0);
  ctx.stroke();
  ctx.restore();
}
