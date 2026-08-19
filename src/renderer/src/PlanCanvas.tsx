import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import type { Scene, Layer, ScenePrimitive } from '../../format/scene.js';
import { resolveStyle, type DrawingStyle } from '../../format/style.js';
import { formatLength, UNITS_PER_METRE, type UnitSystem } from '../../format/units.js';
import { IconPlus, IconMinus, IconFit, IconHand } from './icons.js';
import type { PlanPoint, PointerSpec } from './tool/machine.js';
import type { EditablePointPath } from './PointEditor.js';
import type { PlanBackground } from '../../format/companion.js';
import { constrainRoomCorner, type CustomRoomAngleLock } from './custom-room.js';
import type { WallEditSession } from './wall-edit.js';
import { flattenWall } from '../../format/room.js';
import {
  angleAt,
  cursorFor,
  edgeHandleFits,
  frameCorners,
  handlePoints,
  hitHandle,
  resizeFrom,
  rotateFrom,
  HANDLE_HALF,
  type HandleId,
  type TransformFrame,
} from './transform-handles.js';

const UNITS_PER_FOOT = 120;
const UNITS_PER_INCH = 10;
/** Width of the ruler gutters along the top and left edges. */
const RULER = 22;
/** Hit-testing every pointer move gets expensive on very large plans. */
const HOVER_PRIMITIVE_LIMIT = 24000;

type SnapKeys = { shift: boolean; alt: boolean };

/**
 * Step used while dragging / placing on the plan.
 *
 * Plan snap is often a full foot — too coarse for careful edits — so interactive
 * tools clamp to 1″ (or 1 cm) unless Shift asks for a finer step, or Alt leaves
 * the value free (returns 0).
 */
function editSnapStep(snapStep: number, units: UnitSystem, keys: SnapKeys): number {
  if (keys.alt) return 0;
  const inchOrCm = units === 'metric' ? UNITS_PER_METRE / 100 : UNITS_PER_INCH;
  const fine = units === 'metric' ? UNITS_PER_METRE / 1000 : 1; // 1 mm or 0.1″
  const coarse = snapStep > 0 ? Math.min(snapStep, inchOrCm) : inchOrCm;
  return keys.shift ? fine : coarse;
}

function snapScalar(value: number, step: number): number {
  if (!(step > 0)) return value;
  return Math.round(value / step) * step;
}

function snapPlanPoint(
  point: { x: number; y: number },
  snapStep: number,
  units: UnitSystem,
  keys: SnapKeys,
): { x: number; y: number } {
  const step = editSnapStep(snapStep, units, keys);
  if (!(step > 0)) return point;
  return { x: snapScalar(point.x, step), y: snapScalar(point.y, step) };
}

/** Snap a single-axis drag delta (walls, nudges). */
function snapDragDelta(
  delta: number,
  snapStep: number,
  units: UnitSystem,
  keys: SnapKeys,
): number {
  return snapScalar(delta, editSnapStep(snapStep, units, keys));
}

export interface View {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/**
 * Plan y grows UPWARD; screen y grows downward.
 *
 * Room Viewer stores a plan the way a drafter reads one — the stage at y=-57
 * sits at the foot of the sheet with the audience above it, which is exactly
 * how the printed drawing comes out. Feeding those coordinates straight into a
 * canvas drew every plan mirrored top to bottom: the stage jumped to the head
 * of the sheet and the raked banks fanned the wrong way. It went unnoticed
 * because a seating plan is very nearly symmetrical, and the text stayed the
 * right way up.
 *
 * The flip lives here, in the mapping, rather than in a canvas transform. A
 * `ctx.scale(1, -1)` would mirror the glyphs too, and every label would need
 * counter-rotating. It also keeps `screenY` and `planY` exact inverses, which
 * is what lets drags, hit-testing and every write keep working untouched: a
 * drag measured through `planY` produces a delta already in plan space.
 */
export const screenY = (view: View, y: number): number => -y * view.scale + view.offsetY;
export const planY = (view: View, sy: number): number => -(sy - view.offsetY) / view.scale;

interface Props {
  scene: Scene | null;
  visibleLayers: Set<Layer>;
  paper: boolean;
  /** When false, the drawing grid is hidden (rulers stay). */
  showGrid?: boolean;
  /** When false, dragged objects only use grid snapping. */
  objectSnap?: boolean;
  /** Raster underlay rendered in plan coordinates below the editable geometry. */
  background?: PlanBackground | null;
  /** Seat dots tinted by A/V sightline verdict (clear / blocked / …). */
  sightlineMarkers?: Array<{ x: number; y: number; verdict: string }>;
  fitToken: number;
  /** Selected object ids. Empty means nothing is selected. */
  selection: number[];
  onSelect: (ids: number[]) => void;
  /**
   * Objects under the pointer when ≥2 overlap (for the Properties stack list).
   * Cleared when the pointer leaves a stack or selection starts elsewhere.
   */
  onStackCandidates?: (items: Array<{ id: number; name: string }>) => void;
  /** Enriched stack peek for the hover card (elevations filled by App). */
  stackPeekItems?: Array<{ id: number; name: string; elevation?: number }> | null;
  /** Status line when Alt-click cycles the stack. */
  onStackCycle?: (message: string) => void;
  showStackPeek?: boolean;
  /** Surface armed for “Place next on this” — drawn as a warm target. */
  placeOnParentId?: number | null;
  placeOnLabel?: string | null;
  /** Linked stack set for the current selection (parent + children). */
  stackSet?: Array<{ id: number; name: string; elevation: number; kind: string }> | null;
  /** Fired once a drag ends, with the total movement in logical units. */
  onMoveSelection: (dx: number, dy: number) => void;
  /**
   * The selected object's own rectangle, when exactly one thing is selected and
   * it can be transformed. Drives the on-canvas resize and rotate handles; null
   * falls back to the plain bounds highlight.
   */
  transformTarget?: {
    nodeId: number;
    width: number;
    height: number;
    /** Absolute angle when the file stores one; null = rotate-by only. */
    angleDegrees: number | null;
    canResize: boolean;
    canRotate: boolean;
  } | null;
  /** Commit an absolute size from a handle drag, in logical units. */
  onResizeTo?: (nodeId: number, width: number, height: number) => void;
  /** Commit a relative rotation from the rotate grip, in degrees. */
  onRotateBy?: (nodeId: number, degrees: number) => void;
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
  /** Corners already clicked for a multi-point room outline. */
  pathPoints?: PlanPoint[];
  /** Optional dashed W×D guide while tracing a custom room. */
  pathGuide?: { width: number; depth: number } | null;
  /** Corner angle lock while tracing a custom room. */
  pathAngleLock?: CustomRoomAngleLock;
  /** The completed measure readout; stays visible until the tool is put down. */
  readout?: { from: PlanPoint; to: PlanPoint } | null;
  /** A click that the pointer mode says means something. Already snapped. */
  onCanvasClick?: (at: PlanPoint) => void;
  /** The Hand button and H both ask for the same tool, which App owns. */
  onToggleHand?: () => void;
  /** Geometry exposed while the Direct Selection tool is active. */
  directPaths?: EditablePointPath[];
  /** Commits one dragged anchor/control point in plan coordinates. */
  onMovePoint?: (pathNodeId: number, pointIndex: number, x: number, y: number) => void;
  /** Active in-place editor opened by double-clicking a text label. */
  textEditor?: { nodeId: number; value: string } | null;
  onEditText?: (nodeId: number) => void;
  onTextEditorChange?: (value: string) => void;
  onTextEditorCommit?: () => void;
  onTextEditorBlur?: () => void;
  onTextEditorCancel?: () => void;
  /**
   * When set (Room → Outline → One wall), wall segments become clickable and
   * show a mid-edge handle so furniture near the perimeter does not steal edits.
   */
  wallEdit?: WallEditSession | null;
  onPickWall?: (index: number) => void;
  /** Commit a push (perpendicular), curve (bow), or length (chord) drag on one wall. */
  onWallGesture?: (index: number, gesture: 'push' | 'curve' | 'length', amount: number) => void;
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

function wallChordMeta(wall: { startX: number; startY: number; endX: number; endY: number; bulge?: number }) {
  const dx = wall.endX - wall.startX;
  const dy = wall.endY - wall.startY;
  const length = Math.hypot(dx, dy) || 1;
  // Outward normal for CCW outlines (same convention as offsetWall).
  const nx = dy / length;
  const ny = -dx / length;
  const midX = (wall.startX + wall.endX) / 2;
  const midY = (wall.startY + wall.endY) / 2;
  // Positive bulge is a CCW arc whose centre sits inward; the wall itself bows
  // outward (opposite the centre). Sagitta = bulge × half-chord.
  const bulge = wall.bulge ?? 0;
  const existingOutward = bulge ? (bulge * length) / 2 : 0;
  return {
    dx,
    dy,
    length,
    nx,
    ny,
    midX,
    midY,
    handleX: midX + nx * existingOutward,
    handleY: midY + ny * existingOutward,
    existingOutward,
  };
}

function hitTestWall(
  walls: WallEditSession['walls'],
  x: number,
  y: number,
  tolerance: number,
): number | null {
  let best: { index: number; distance: number } | null = null;
  for (const wall of walls) {
    const meta = wallChordMeta(wall);
    const handleDist = Math.hypot(x - meta.handleX, y - meta.handleY);
    let distance = distanceToSegment(x, y, wall.startX, wall.startY, wall.endX, wall.endY);
    // Deep bays sit far off the chord — hit the flattened arc too.
    if (wall.curved && wall.bulge) {
      const pts = flattenWall(
        {
          id: 'hit',
          start: { x: wall.startX, y: wall.startY },
          end: { x: wall.endX, y: wall.endY },
          bulge: wall.bulge,
        },
        Math.max(2, meta.length / 32),
      );
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i]!;
        const b = pts[i + 1]!;
        distance = Math.min(distance, distanceToSegment(x, y, a.x, a.y, b.x, b.y));
      }
    }
    const d = Math.min(distance, handleDist);
    if (d <= tolerance && (!best || d < best.distance)) best = { index: wall.index, distance: d };
  }
  return best?.index ?? null;
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
 * Finds every object under a point, nearest first.
 *
 * Ties break toward the physically smaller object, so a chair that overlaps a
 * table sorts ahead of the table. Callers that only need one winner use
 * `hitTest` (first candidate).
 */
function hitTestCandidates(
  prepared: PreparedPrimitive[],
  visible: Set<Layer>,
  x: number,
  y: number,
  tolerance: number,
): Array<{ id: number; distance: number; size: number; name: string }> {
  const hits: Array<{ id: number; distance: number; size: number; name: string }> = [];
  const seen = new Set<number>();

  for (const item of prepared) {
    const p = item.primitive;
    if (!visible.has(p.layer)) continue;
    if (seen.has(p.selectId)) continue;

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

    if (p.type === 'text') {
      const dx = Math.max(item.minX - x, 0, x - item.maxX);
      const dy = Math.max(item.minY - y, 0, y - item.maxY);
      distance = Math.hypot(dx, dy);
    } else if (p.pts.length === 2) {
      distance = Math.hypot(x - p.pts[0], y - p.pts[1]);
    } else {
      for (let i = 0; i + 3 < p.pts.length; i += 2) {
        distance = Math.min(distance, distanceToSegment(x, y, p.pts[i], p.pts[i + 1], p.pts[i + 2], p.pts[i + 3]));
      }
      // Furniture is picked by its BODY, not just its outline.
      //
      // `primitiveTypeFor` maps RVSegmentRect to 'polygon' but RVSegmentPoly to
      // 'polyline', and a Room Viewer round table is a poly. So a stage could be
      // clicked anywhere on its fill while a table could only be hit within the
      // pick tolerance of its 1px edge — 0.56 ft at 12% zoom, which is less than
      // half a chair. A scan of 34 points across a banquet row selected nothing.
      //
      // Walls and regions stay edge-picked on purpose: their rings enclose the
      // whole floor, so an interior test there would swallow every click on
      // empty ground and break marquee selection.
      const closedBody =
        p.type === 'polygon' || (p.layer === 'furniture' && p.pts.length >= 6);
      if (closedBody && p.pts.length >= 4) {
        distance = Math.min(
          distance,
          distanceToSegment(x, y, p.pts[p.pts.length - 2], p.pts[p.pts.length - 1], p.pts[0], p.pts[1]),
        );
        if (pointInPolygon(x, y, p.pts)) distance = 0;
      }
    }

    if (distance > tolerance) continue;
    const size = Math.max(1, (item.maxX - item.minX) * (item.maxY - item.minY));
    const name = p.owner || p.text || `Object ${p.selectId}`;
    seen.add(p.selectId);
    hits.push({ id: p.selectId, distance, size, name });
  }

  hits.sort((a, b) => {
    if (Math.abs(a.distance - b.distance) > 1) return a.distance - b.distance;
    return a.size - b.size;
  });
  return hits;
}

/** Finds the object nearest a point (first of `hitTestCandidates`). */
function hitTest(
  prepared: PreparedPrimitive[],
  visible: Set<Layer>,
  x: number,
  y: number,
  tolerance: number,
): number | null {
  return hitTestCandidates(prepared, visible, x, y, tolerance)[0]?.id ?? null;
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
  objectSnap = true,
  background = null,
  sightlineMarkers = [],
  fitToken,
  selection,
  onSelect,
  onStackCandidates,
  stackPeekItems = null,
  onStackCycle,
  showStackPeek = true,
  placeOnParentId = null,
  placeOnLabel = null,
  stackSet = null,
  onMoveSelection,
  transformTarget = null,
  onResizeTo,
  onRotateBy,
  editable,
  onCursor,
  onZoom,
  onDropItem,
  onDropGear,
  snapStep = 0,
  units = 'imperial',
  pointerMode,
  spanFrom,
  pathPoints = [],
  pathGuide = null,
  pathAngleLock = 'free',
  readout,
  onCanvasClick,
  onToggleHand,
  directPaths = [],
  onMovePoint,
  textEditor = null,
  onEditText,
  onTextEditorChange,
  onTextEditorCommit,
  onTextEditorBlur,
  onTextEditorCancel,
  wallEdit = null,
  onPickWall,
  onWallGesture,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<View>({ scale: 0.05, offsetX: 0, offsetY: 0 });
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [backgroundImage, setBackgroundImage] = useState<HTMLImageElement | null>(null);
  const panRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const moveRef = useRef<{ startX: number; startY: number } | null>(null);
  const pointMoveRef = useRef<{
    pathNodeId: number;
    pointIndex: number;
    x: number;
    y: number;
  } | null>(null);
  const wallDragRef = useRef<{
    index: number;
    gesture: 'push' | 'curve' | 'length';
    originX: number;
    originY: number;
    nx: number;
    ny: number;
    tx: number;
    ty: number;
    baseLength: number;
    baseAmount: number;
    amount: number;
  } | null>(null);
  const [wallDragPreview, setWallDragPreview] = useState<{
    index: number;
    amount: number;
    baseAmount: number;
    baseLength: number;
    nx: number;
    ny: number;
    tx: number;
    ty: number;
    gesture: 'push' | 'curve' | 'length';
  } | null>(null);
  const [pointPreview, setPointPreview] = useState<{
    pathNodeId: number;
    pointIndex: number;
    x: number;
    y: number;
  } | null>(null);
  const [nudge, setNudge] = useState<{ dx: number; dy: number } | null>(null);
  /** A live resize/rotate drag on the transform handles. */
  const transformRef = useRef<{
    nodeId: number;
    handle: HandleId;
    /** The frame as it stood when the handle was grabbed. */
    frame: TransformFrame;
    startX: number;
    startY: number;
    /** Pointer bearing when a rotate grip was grabbed. */
    grabAngle: number;
    width: number;
    height: number;
    rotateBy: number;
  } | null>(null);
  const [transformPreview, setTransformPreview] = useState<{
    handle: HandleId;
    width: number;
    height: number;
    rotateBy: number;
  } | null>(null);
  /** The handle under the pointer, so the cursor can say what a drag would do. */
  const [hoverHandle, setHoverHandle] = useState<HandleId | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [peekStack, setPeekStack] = useState<Array<{ id: number; name: string }>>([]);
  const [peekCardPos, setPeekCardPos] = useState<{ x: number; y: number } | null>(null);
  const pointerScreenRef = useRef<{ x: number; y: number } | null>(null);
  const stackCycleRef = useRef<{ key: string; index: number; ids: number[] } | null>(null);
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
  const [shiftHeld, setShiftHeld] = useState(false);
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
      if (primitive.type === 'text' && primitive.text && primitive.pts.length >= 2) {
        const lines = primitive.text.replace(/\r/g, '').split('\n');
        const height = Math.max(40, (primitive.textStyle?.size ?? 9) * 10);
        const width = Math.max(
          height,
          ...lines.map((line) => Math.max(1, line.length) * height * 0.58),
        );
        const totalHeight = Math.max(height, lines.length * height * 1.2);
        const angle = ((primitive.textStyle?.angleDegrees ?? 0) * Math.PI) / 180;
        const rotatedWidth = Math.abs(width * Math.cos(angle)) + Math.abs(totalHeight * Math.sin(angle));
        const rotatedHeight = Math.abs(width * Math.sin(angle)) + Math.abs(totalHeight * Math.cos(angle));
        minX = primitive.pts[0] - rotatedWidth / 2;
        maxX = primitive.pts[0] + rotatedWidth / 2;
        minY = primitive.pts[1] - rotatedHeight / 2;
        maxY = primitive.pts[1] + rotatedHeight / 2;
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

  /**
   * The transform frame for the one selected object, or null.
   *
   * Centre comes from the drawn bounds so the handles sit on what is on screen;
   * width, height, and angle come from the document, because the world-aligned
   * bounding box of a rotated object is not its rectangle.
   */
  const transformFrame = useMemo<TransformFrame | null>(() => {
    if (!editable || !transformTarget || selection.length !== 1) return null;
    if (selection[0] !== transformTarget.nodeId) return null;
    if (!(transformTarget.width > 0) || !(transformTarget.height > 0)) return null;
    const b = objectBounds.get(transformTarget.nodeId);
    if (!b) return null;
    return {
      cx: (b.minX + b.maxX) / 2,
      cy: (b.minY + b.maxY) / 2,
      width: transformTarget.width,
      height: transformTarget.height,
      angle: transformTarget.angleDegrees ?? 0,
    };
  }, [editable, transformTarget, selection, objectBounds]);

  /** Handles are a select-mode affordance; they must not fight another tool. */
  const handlesLive = transformFrame != null && pointerMode.mode === 'select' && !wallEdit?.editable;

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  useEffect(() => {
    if (!background?.dataUrl) {
      setBackgroundImage(null);
      return;
    }
    let live = true;
    const image = new Image();
    image.onload = () => {
      if (live) setBackgroundImage(image);
    };
    image.onerror = () => {
      if (live) setBackgroundImage(null);
    };
    image.src = background.dataUrl;
    return () => {
      live = false;
    };
  }, [background?.dataUrl]);

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

  const cursorFrameRef = useRef<number | null>(null);
  const queuedCursorRef = useRef<{ x: number; y: number } | null | undefined>(undefined);
  const scheduleCursor = useCallback(
    (position: { x: number; y: number } | null) => {
      if (!onCursor) return;
      queuedCursorRef.current = position;
      if (cursorFrameRef.current != null) return;
      cursorFrameRef.current = window.requestAnimationFrame(() => {
        cursorFrameRef.current = null;
        const next = queuedCursorRef.current;
        queuedCursorRef.current = undefined;
        if (next === undefined) return;
        onCursor(next);
      });
    },
    [onCursor],
  );

  const stackPeekTimerRef = useRef<number | null>(null);
  const lastStackPeekKeyRef = useRef('');
  const publishStackCandidates = useCallback(
    (peek: Array<{ id: number; name: string }>) => {
      if (!onStackCandidates) return;
      const key = peek.map((item) => item.id).join(',');
      if (key === lastStackPeekKeyRef.current) return;
      lastStackPeekKeyRef.current = key;
      if (stackPeekTimerRef.current != null) window.clearTimeout(stackPeekTimerRef.current);
      // Keep the hover card local and snappy; only lift to App after the set settles.
      stackPeekTimerRef.current = window.setTimeout(() => {
        stackPeekTimerRef.current = null;
        onStackCandidates(peek);
      }, peek.length >= 2 ? 120 : 0);
    },
    [onStackCandidates],
  );

  const nudgeFrameRef = useRef<number | null>(null);
  const queuedNudgeRef = useRef<{ dx: number; dy: number; guides: { x?: number; y?: number } } | null>(null);
  const scheduleNudge = useCallback((next: { dx: number; dy: number }, guides: { x?: number; y?: number }) => {
    queuedNudgeRef.current = { ...next, guides };
    if (nudgeFrameRef.current != null) return;
    nudgeFrameRef.current = window.requestAnimationFrame(() => {
      nudgeFrameRef.current = null;
      const queued = queuedNudgeRef.current;
      queuedNudgeRef.current = null;
      if (!queued) return;
      setGuides(queued.guides);
      setNudge({ dx: queued.dx, dy: queued.dy });
    });
  }, []);

  useEffect(
    () => () => {
      if (viewFrameRef.current != null) window.cancelAnimationFrame(viewFrameRef.current);
      if (hoverFrameRef.current != null) window.cancelAnimationFrame(hoverFrameRef.current);
      if (cursorFrameRef.current != null) window.cancelAnimationFrame(cursorFrameRef.current);
      if (nudgeFrameRef.current != null) window.cancelAnimationFrame(nudgeFrameRef.current);
      if (stackPeekTimerRef.current != null) window.clearTimeout(stackPeekTimerRef.current);
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
      offsetY: (height + RULER) / 2 + cy * scale,
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

  // Resize the backing store only when the CSS size or DPR changes — reallocating
  // on every hover/nudge paint was a major stutter with dense seating.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const nextW = Math.floor(size.width * dpr);
    const nextH = Math.floor(size.height * dpr);
    if (canvas.width !== nextW) canvas.width = nextW;
    if (canvas.height !== nextH) canvas.height = nextH;
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;
  }, [size.width, size.height]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
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

    const { scale, offsetX } = view;
    const tx = (x: number) => x * scale + offsetX;
    const ty = (y: number) => screenY(view, y);
    // Leave a screen-space margin for strokes and labels; everything beyond it
    // is invisible and need not be sent through the canvas drawing pipeline.
    const viewportPad = 36 / scale;
    const viewport = {
      minX: (-offsetX - 36) / scale,
      minY: planY(view, size.height + 36),
      maxX: (size.width - offsetX + 36) / scale,
      maxY: planY(view, -36),
    };

    if (background?.visible && backgroundImage) {
      const centreX = tx(background.x + background.width / 2);
      const centreY = ty(background.y + background.height / 2);
      ctx.save();
      ctx.globalAlpha = background.opacity;
      ctx.globalCompositeOperation = background.blendMode === 'normal' ? 'source-over' : background.blendMode;
      ctx.filter =
        `brightness(${background.brightness}) contrast(${background.contrast}) ` +
        `saturate(${background.saturation}) grayscale(${background.grayscale})`;
      ctx.translate(centreX, centreY);
      ctx.rotate((background.rotation * Math.PI) / 180);
      ctx.scale(background.flipX ? -1 : 1, background.flipY ? -1 : 1);
      ctx.drawImage(
        backgroundImage,
        (-background.width * scale) / 2,
        (-background.height * scale) / 2,
        background.width * scale,
        background.height * scale,
      );
      ctx.restore();
    }

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
          if (!p.text || textEditor?.nodeId === p.nodeId) break;
          const style = p.textStyle;
          const fontPx = Math.max(7, Math.min(96, Math.max(9, 130 * scale) * ((style?.size ?? 9) / 9)));
          const family = (style?.family || 'Arial').replace(/["\\]/g, '');
          const lines = p.text.replace(/\r/g, '').split('\n');
          const lineHeight = fontPx * 1.2;
          ctx.save();
          ctx.translate(tx(p.pts[0] + ox), ty(p.pts[1] + oy));
          ctx.rotate(((style?.angleDegrees ?? 0) * Math.PI) / 180);
          ctx.font = `${style?.italic ? 'italic ' : ''}${style?.bold ? '700' : '400'} ${fontPx}px "${family}", -apple-system, "Segoe UI", sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          lines.forEach((line, index) => {
            const y = (index - (lines.length - 1) / 2) * lineHeight;
            ctx.fillText(line, 0, y);
            if (style?.underline || style?.strikeOut) {
              const half = ctx.measureText(line).width / 2;
              ctx.beginPath();
              ctx.lineWidth = Math.max(1, fontPx / 14);
              if (style.underline) {
                ctx.moveTo(-half, y + fontPx * 0.52);
                ctx.lineTo(half, y + fontPx * 0.52);
              }
              if (style.strikeOut) {
                ctx.moveTo(-half, y);
                ctx.lineTo(half, y);
              }
              ctx.stroke();
            }
          });
          ctx.restore();
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

    // One editable object in select mode gets the real transform frame; every
    // other case keeps the plain highlight.
    const soloTransform = handlesLive && transformFrame && selection.length === 1;
    if (soloTransform && transformFrame) {
      drawTransformFrame(
        ctx,
        transformFrame,
        view,
        transformPreview,
        nudge,
        units,
        transformTarget?.canRotate ?? false,
      );
    }
    for (const id of selection) {
      if (soloTransform) break;
      const b = objectBounds.get(id);
      if (!b) continue;
      // Crowded multi-select: light per-item frames only when the set is small.
      if (selection.length === 1 || selection.length <= 12) {
        drawSelectionFrame(ctx, b, view, nudge, selection.length > 1 ? 'item' : 'solo');
      }
    }
    if (selection.length > 1) {
      const group = boundsOfMany(objectBounds, selection);
      if (group) drawSelectionFrame(ctx, group, view, nudge, 'group', selection.length);
    }

    if (placeOnParentId != null) {
      const b = objectBounds.get(placeOnParentId);
      if (b) {
        drawPlaceOnSurface(ctx, b, view, paper, placeOnLabel ?? 'Place on this');
      }
    }

    if (stackSet && stackSet.length >= 2) {
      drawStackSetOverlay(ctx, objectBounds, stackSet, view, nudge, paper, units, showStackPeek);
    }

    if (wallEdit && wallEdit.walls.length) {
      for (const wall of wallEdit.walls) {
        const selected = wall.index === wallEdit.selected;
        const meta = wallChordMeta(wall);
        const preview =
          wallDragPreview && wallDragPreview.index === wall.index ? wallDragPreview : null;
        const ox = preview && preview.gesture === 'push' ? preview.nx * preview.amount : 0;
        const oy = preview && preview.gesture === 'push' ? preview.ny * preview.amount : 0;
        const curveOff =
          preview && preview.gesture === 'curve'
            ? preview.amount
            : wall.curved
              ? meta.existingOutward
              : 0;
        const lengthOff =
          preview && preview.gesture === 'length' ? preview.amount : 0;
        const ex = wall.endX + ox + (preview?.tx ?? meta.dx / meta.length) * lengthOff;
        const ey = wall.endY + oy + (preview?.ty ?? meta.dy / meta.length) * lengthOff;
        ctx.save();
        ctx.strokeStyle = selected
          ? paper
            ? 'rgba(11, 110, 203, 0.95)'
            : 'rgba(120, 190, 255, 0.95)'
          : paper
            ? 'rgba(11, 110, 203, 0.28)'
            : 'rgba(120, 190, 255, 0.35)';
        ctx.lineWidth = selected ? 3 : 1.5;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(tx(wall.startX + ox), ty(wall.startY + oy));
        if (preview?.gesture === 'curve' || (wall.curved && preview?.gesture !== 'length')) {
          // Circular arc through the handle — same geometry the model stores.
          const sag = curveOff;
          const chord = Math.hypot(ex - (wall.startX + ox), ey - (wall.startY + oy)) || meta.length;
          const bulge = chord > 0 ? (2 * sag) / chord : 0;
          if (Math.abs(bulge) < 1e-9) {
            ctx.lineTo(tx(ex), ty(ey));
          } else {
            const pts = flattenWall(
              {
                id: 'preview',
                start: { x: wall.startX + ox, y: wall.startY + oy },
                end: { x: ex, y: ey },
                bulge,
              },
              // Keep the overlay smooth even when the sheet is zoomed far out.
              Math.min(meta.length / 48, Math.max(0.5, 2 / Math.max(view.scale, 0.02))),
            );
            for (let i = 1; i < pts.length; i++) ctx.lineTo(tx(pts[i]!.x), ty(pts[i]!.y));
          }
        } else {
          ctx.lineTo(tx(ex), ty(ey));
        }
        ctx.stroke();
        if (selected && wallEdit.editable) {
          const hx =
            preview?.gesture === 'length'
              ? (wall.startX + ex) / 2 + ox
              : meta.midX + ox + meta.nx * curveOff;
          const hy =
            preview?.gesture === 'length'
              ? (wall.startY + ey) / 2 + oy
              : meta.midY + oy + meta.ny * curveOff;
          ctx.fillStyle = paper ? '#0b6ecb' : '#8ec5ff';
          ctx.strokeStyle = paper ? '#fff' : '#0d1520';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(tx(hx), ty(hy), 6, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = paper ? 'rgba(11, 110, 203, 0.92)' : 'rgba(180, 220, 255, 0.95)';
          ctx.font = '600 11px Inter, system-ui, sans-serif';
          ctx.textAlign = 'center';
          const tip =
            wallEdit.gesture === 'curve'
              ? 'Curve'
              : wallEdit.gesture === 'length'
                ? 'Length'
                : 'Push';
          let measure = '';
          if (preview) {
            const delta = preview.amount - preview.baseAmount;
            if (preview.gesture === 'length') {
              measure = formatLength(preview.baseLength + preview.amount, units);
            } else if (preview.gesture === 'curve') {
              const bow = formatLength(Math.abs(preview.amount), units);
              measure = `${preview.amount >= 0 ? 'out' : 'in'} ${bow}`;
            } else {
              const signed = `${delta >= 0 ? '+' : '−'}${formatLength(Math.abs(delta), units)}`;
              measure = signed;
            }
          }
          ctx.fillText(measure ? `${tip} · ${measure}` : `Drag · ${tip}`, tx(hx), ty(hy) - 14);
          if (!preview) {
            ctx.font = '500 9px Inter, system-ui, sans-serif';
            ctx.fillText('Shift fine · Alt free', tx(hx), ty(hy) - 26);
          }
        }
        ctx.restore();
      }
    }

    if (pointerMode.mode === 'direct-select') {
      for (const path of directPaths) {
        const points = path.points.map((point) =>
          pointPreview && pointPreview.pathNodeId === path.nodeId && pointPreview.pointIndex === point.index
            ? { ...point, x: pointPreview.x, y: pointPreview.y }
            : point,
        );
        if (points.length >= 2) {
          ctx.save();
          ctx.strokeStyle = paper ? 'rgba(40, 111, 213, .55)' : 'rgba(116, 175, 255, .7)';
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(tx(points[0]!.x), ty(points[0]!.y));
          for (let index = 1; index < points.length; index++) {
            ctx.lineTo(tx(points[index]!.x), ty(points[index]!.y));
          }
          if (path.closed) ctx.closePath();
          ctx.stroke();
          ctx.restore();
        }
        for (const point of points) {
          const px = tx(point.x);
          const py = ty(point.y);
          ctx.save();
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = path.canEdit ? '#1677e8' : '#8993a1';
          ctx.fillStyle = point.role === 'control' ? (paper ? '#ffffff' : '#161a20') : '#1677e8';
          if (point.role === 'control') {
            ctx.beginPath();
            ctx.arc(px, py, 4.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          } else {
            ctx.fillRect(px - 4.5, py - 4.5, 9, 9);
            ctx.strokeRect(px - 4.5, py - 4.5, 9, 9);
          }
          ctx.restore();
        }
      }
    }

    if (marquee) drawMarquee(ctx, marquee, view);
    if (guides.x != null || guides.y != null) drawGuides(ctx, guides, size, view);

    // One rubber band, chosen by the tool rather than by testing three cells:
    // a draw tool previews its own shape, a measure or dimension previews the
    // measurement, and a line wants no dimension text because it is drawing.
    if (spanFrom && pointerMode.preview !== 'none') {
      const to = pointer ?? spanFrom;
      if (pointerMode.preview === 'measure') drawMeasurement(ctx, spanFrom, to, view, paper, units);
      else if (pointerMode.preview !== 'room') drawShapePreview(ctx, spanFrom, to, pointerMode.preview, view);
    } else if (pointerMode.preview === 'room') {
      if (pathGuide && pathGuide.width > 0 && pathGuide.depth > 0) {
        drawRoomPathGuide(ctx, pathGuide, view);
      }
      const live =
        pointer && pathPoints.length
          ? constrainRoomCorner(pathPoints[pathPoints.length - 1]!, pointer, pathAngleLock, shiftHeld)
          : pointer;
      drawRoomPathPreview(ctx, pathPoints, live, view);
    } else if (readout) {
      drawMeasurement(ctx, readout.from, readout.to, view, paper, units);
    }

    if (sightlineMarkers.length) {
      for (const marker of sightlineMarkers) {
        const sx = marker.x * view.scale + view.offsetX;
        const sy = screenY(view, marker.y);
        const fill =
          marker.verdict === 'clear'
            ? 'rgba(46, 160, 67, 0.55)'
            : marker.verdict === 'blocked'
              ? 'rgba(207, 34, 46, 0.65)'
              : marker.verdict === 'too-far' || marker.verdict === 'too-close'
                ? 'rgba(210, 153, 34, 0.6)'
                : 'rgba(88, 96, 105, 0.5)';
        ctx.beginPath();
        ctx.fillStyle = fill;
        ctx.arc(sx, sy, Math.max(3, 4 * view.scale * 12), 0, Math.PI * 2);
        ctx.fill();
      }
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
    pathPoints,
    pathGuide,
    pathAngleLock,
    shiftHeld,
    readout,
    sightlineMarkers,
    pointerMode,
    pointer,
    pointPreview,
    directPaths,
    marquee,
    guides,
    background,
    backgroundImage,
    textEditor,
    wallEdit,
    wallDragPreview,
    placeOnParentId,
    placeOnLabel,
    stackSet,
    showStackPeek,
    handlesLive,
    transformFrame,
    transformPreview,
    transformTarget,
  ]);

  const editingTextPrimitive = useMemo(
    () =>
      textEditor && scene
        ? scene.primitives.find(
            (primitive) => primitive.type === 'text' && primitive.nodeId === textEditor.nodeId,
          ) ?? null
        : null,
    [scene, textEditor],
  );

  const inlineTextStyle = useMemo<CSSProperties | undefined>(() => {
    if (!editingTextPrimitive) return undefined;
    const style = editingTextPrimitive.textStyle;
    const fontPx = Math.max(12, Math.min(72, Math.max(12, 130 * view.scale) * ((style?.size ?? 9) / 9)));
    const longest = Math.max(8, ...textEditor!.value.replace(/\r/g, '').split('\n').map((line) => line.length));
    return {
      left: editingTextPrimitive.pts[0] * view.scale + view.offsetX,
      top: screenY(view, editingTextPrimitive.pts[1]),
      width: Math.max(180, Math.min(560, longest * fontPx * 0.68 + 42)),
      minHeight: Math.max(42, textEditor!.value.replace(/\r/g, '').split('\n').length * fontPx * 1.25 + 18),
      transform: `translate(-50%, -50%) rotate(${style?.angleDegrees ?? 0}deg)`,
      fontFamily: `"${(style?.family || 'Arial').replace(/["\\]/g, '')}", sans-serif`,
      fontSize: `${fontPx}px`,
      fontWeight: style?.bold ? 700 : 400,
      fontStyle: style?.italic ? 'italic' : 'normal',
      textDecoration: [style?.underline ? 'underline' : '', style?.strikeOut ? 'line-through' : '']
        .filter(Boolean)
        .join(' ') || 'none',
      color: colorRefToCss(editingTextPrimitive.color, paper),
    };
  }, [editingTextPrimitive, paper, textEditor, view]);

  /** Screen pixels to plan coordinates. */
  const toPlan = (e: { clientX: number; clientY: number; currentTarget: Element }) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left - view.offsetX) / view.scale,
      y: planY(view, e.clientY - rect.top),
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
      pointerMode.mode === 'pan' ||
      e.button === 1 ||
      e.button === 2 ||
      (e.altKey && pointerMode.mode !== 'direct-select') ||
      spaceHeld ||
      !scene;
    if (wantsPan) {
      panRef.current = { x: e.clientX, y: e.clientY, ox: view.offsetX, oy: view.offsetY };
      return;
    }

    if (pointerMode.mode === 'direct-select' && editable && onMovePoint && e.button === 0) {
      const at = toPlan(e);
      let nearest: { pathNodeId: number; pointIndex: number; x: number; y: number; distance: number } | null = null;
      for (const path of directPaths) {
        if (!path.canEdit) continue;
        for (const point of path.points) {
          const distance = Math.hypot(point.x - at.x, point.y - at.y);
          if (distance <= 10 / view.scale && (!nearest || distance < nearest.distance)) {
            nearest = {
              pathNodeId: path.nodeId,
              pointIndex: point.index,
              x: point.x,
              y: point.y,
              distance,
            };
          }
        }
      }
      if (nearest) {
        pointMoveRef.current = nearest;
        setPointPreview(nearest);
        return;
      }
    }

    // Transform handles beat object hit-testing: a corner grip sits on top of
    // the object it belongs to, and a click there means resize, not re-select.
    if (handlesLive && transformFrame && transformTarget && e.button === 0) {
      const rect = e.currentTarget.getBoundingClientRect();
      const handle = hitHandle(
        transformFrame,
        view,
        e.clientX - rect.left,
        e.clientY - rect.top,
        transformTarget.canRotate,
      );
      const usable = handle === 'rotate' ? transformTarget.canRotate : transformTarget.canResize;
      if (handle && usable) {
        const at = toPlan(e);
        transformRef.current = {
          nodeId: transformTarget.nodeId,
          handle,
          frame: transformFrame,
          startX: at.x,
          startY: at.y,
          grabAngle: angleAt(transformFrame, at.x, at.y),
          width: transformFrame.width,
          height: transformFrame.height,
          rotateBy: 0,
        };
        setTransformPreview({
          handle,
          width: transformFrame.width,
          height: transformFrame.height,
          rotateBy: 0,
        });
        return;
      }
    }

    // Room wall editing beats furniture hit-testing so chairs along a wall
    // cannot steal the click meant for push / curve.
    if (wallEdit && wallEdit.editable && e.button === 0 && pointerMode.mode === 'select') {
      const at = toPlan(e);
      const wallHit = hitTestWall(wallEdit.walls, at.x, at.y, 14 / view.scale);
      if (wallHit != null) {
        onPickWall?.(wallHit);
        onSelect([]);
        const wall = wallEdit.walls.find((entry) => entry.index === wallHit);
        if (wall && (!wall.curved || wallEdit.gesture === 'curve')) {
          const meta = wallChordMeta(wall);
          const nearHandle =
            Math.hypot(at.x - meta.handleX, at.y - meta.handleY) <= 16 / view.scale ||
            wallHit === wallEdit.selected;
          if (nearHandle) {
            const gesture =
              wall.curved && wallEdit.gesture !== 'curve' ? 'curve' : wallEdit.gesture;
            // Length needs a straight chord; curved walls stay on curve drag.
            const activeGesture =
              gesture === 'length' && wall.curved ? 'curve' : gesture;
            wallDragRef.current = {
              index: wallHit,
              gesture: activeGesture,
              originX: at.x,
              originY: at.y,
              nx: meta.nx,
              ny: meta.ny,
              tx: meta.dx / meta.length,
              ty: meta.dy / meta.length,
              baseLength: meta.length,
              baseAmount: activeGesture === 'curve' ? meta.existingOutward : 0,
              amount: activeGesture === 'curve' ? meta.existingOutward : 0,
            };
            setWallDragPreview({
              index: wallHit,
              amount: activeGesture === 'curve' ? meta.existingOutward : 0,
              baseAmount: activeGesture === 'curve' ? meta.existingOutward : 0,
              baseLength: meta.length,
              nx: meta.nx,
              ny: meta.ny,
              tx: meta.dx / meta.length,
              ty: meta.dy / meta.length,
              gesture: activeGesture,
            });
          }
        }
        return;
      }
    }

    // While a stamp stays armed, pressing on something that is ALREADY selected
    // — which is exactly what you just dropped — grabs it to nudge into place
    // instead of stamping a second copy. Everything else still stamps, so
    // placing onto a surface ("Place next on this") is untouched, and you never
    // have to end placing just to move the piece you only just put down.
    const grabArmedSelection =
      pointerMode.mode === 'stamp' &&
      editable &&
      e.button === 0 &&
      !e.shiftKey &&
      selection.length > 0 &&
      (() => {
        // Bounds, not the stroke-distance hit test. `hitTest` measures to the
        // nearest drawn SEGMENT with an 8-screen-pixel tolerance, which at 8%
        // zoom is 0.8 ft — so pressing the middle of a 5.5 ft round table is
        // 2.75 ft from its outline and registers as empty canvas. Testing the
        // press against the bounding box of what is already selected is both
        // generous and safe: it can only ever grab a piece the user just put
        // down, never unrelated geometry, so stamping onto a surface still
        // works everywhere else.
        const p = toPlan(e);
        const slack = 2 / view.scale;
        for (const id of selection) {
          const b = objectBounds.get(id);
          if (!b) continue;
          if (
            p.x >= b.minX - slack &&
            p.x <= b.maxX + slack &&
            p.y >= b.minY - slack &&
            p.y <= b.maxY + slack
          ) {
            return true;
          }
        }
        return false;
      })();

    if (
      (pointerMode.mode === 'stamp' || pointerMode.mode === 'span' || pointerMode.mode === 'path') &&
      onCanvasClick &&
      e.button === 0 &&
      !grabArmedSelection
    ) {
      const point = toPlan(e);
      // Association is decided at the actual click location, before optional
      // grid snapping changes the coordinate. This lets a dimension follow the
      // object that was clicked instead of becoming a detached drawing line.
      const nodeId = pointerMode.associate
        ? (hitTest(prepared, visibleLayers, point.x, point.y, 8 / view.scale) ?? undefined)
        : undefined;
      const coordinate =
        pointerMode.snap === 'grid'
          ? snapPlanPoint(point, snapStep, units, { shift: e.shiftKey, alt: e.altKey })
          : point;
      const constrained =
        pointerMode.mode === 'path' && pathPoints.length
          ? constrainRoomCorner(
              pathPoints[pathPoints.length - 1]!,
              coordinate,
              pathAngleLock,
              e.shiftKey,
            )
          : coordinate;
      onCanvasClick(nodeId == null ? constrained : { ...constrained, nodeId });
      return;
    }

    if (scene) {
      const { x, y } = toPlan(e);
      const tolerance = 8 / view.scale;
      const candidates = hitTestCandidates(prepared, visibleLayers, x, y, tolerance);

      if (candidates.length >= 2) {
        onStackCandidates?.(candidates.map((c) => ({ id: c.id, name: c.name })));
      } else {
        onStackCandidates?.([]);
      }

      if (e.altKey && candidates.length >= 1) {
        e.preventDefault();
        const key = `${Math.round(x / 20)}:${Math.round(y / 20)}:${candidates.map((c) => c.id).join(',')}`;
        let cycle = stackCycleRef.current;
        if (!cycle || cycle.key !== key) {
          cycle = { key, index: 0, ids: candidates.map((c) => c.id) };
        } else {
          cycle = { ...cycle, index: (cycle.index + 1) % cycle.ids.length };
        }
        stackCycleRef.current = cycle;
        const pick = cycle.ids[cycle.index]!;
        const name = candidates.find((c) => c.id === pick)?.name ?? `Object ${pick}`;
        const next = e.shiftKey
          ? selection.includes(pick)
            ? selection.filter((id) => id !== pick)
            : [...selection, pick]
          : [pick];
        onSelect(next);
        onStackCycle?.(
          `${cycle.index + 1} of ${cycle.ids.length} under cursor · ${name}`,
        );
        if (editable && next.length && pointerMode.mode !== 'direct-select' && !e.shiftKey) {
          moveRef.current = { startX: x, startY: y };
          setNudge({ dx: 0, dy: 0 });
        }
        return;
      }

      const hit = candidates[0]?.id ?? null;

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
        stackCycleRef.current = null;

        if (editable && next.length && pointerMode.mode !== 'direct-select') {
          moveRef.current = { startX: x, startY: y };
          setNudge({ dx: 0, dy: 0 });
          return;
        }
      } else if (e.shiftKey || e.button === 0) {
        // Empty space: start a rubber band rather than panning.
        marqueeRef.current = { x0: x, y0: y };
        setMarquee({ x0: x, y0: y, x1: x, y1: y });
        if (!e.shiftKey) onSelect([]);
        onStackCandidates?.([]);
        stackCycleRef.current = null;
        return;
      }
    }

    panRef.current = { x: e.clientX, y: e.clientY, ox: view.offsetX, oy: view.offsetY };
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!editable || !onEditText || !scene || pointerMode.mode !== 'select') return;
    const { x, y } = toPlan(e);
    const hit = hitTest(
      prepared.filter((item) => item.primitive.type === 'text'),
      visibleLayers,
      x,
      y,
      10 / view.scale,
    );
    if (hit == null) return;
    const textPrimitive = prepared.find(
      (item) => item.primitive.type === 'text' && item.primitive.selectId === hit,
    )?.primitive;
    if (!textPrimitive) return;
    e.preventDefault();
    moveRef.current = null;
    setNudge(null);
    onEditText(textPrimitive.nodeId);
  };

  const clearStackPeek = useCallback(() => {
    setPeekStack([]);
    setPeekCardPos(null);
    lastStackPeekKeyRef.current = '';
    if (stackPeekTimerRef.current != null) {
      window.clearTimeout(stackPeekTimerRef.current);
      stackPeekTimerRef.current = null;
    }
    onStackCandidates?.([]);
  }, [onStackCandidates]);

  const peekCardItems = useMemo(() => {
    if (peekStack.length < 2) return [];
    const byId = new Map((stackPeekItems ?? []).map((item) => [item.id, item]));
    return peekStack.map((item) => ({
      id: item.id,
      name: item.name,
      elevation: byId.get(item.id)?.elevation,
    }));
  }, [peekStack, stackPeekItems]);

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    pointerScreenRef.current = { x: e.clientX, y: e.clientY };
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
    scheduleCursor(plan);
    setShiftHeld(e.shiftKey);
    if (pointerMode.mode === 'span' || pointerMode.mode === 'path') setPointer(plan);

    const transforming = transformRef.current;
    if (transforming) {
      if (transforming.handle === 'rotate') {
        const rotateBy = rotateFrom(
          transforming.frame,
          transforming.grabAngle,
          angleAt(transforming.frame, plan.x, plan.y),
          e.shiftKey,
        );
        transforming.rotateBy = rotateBy;
        setTransformPreview({ handle: 'rotate', width: transforming.width, height: transforming.height, rotateBy });
      } else {
        const size = resizeFrom(
          transforming.frame,
          transforming.handle,
          plan.x - transforming.startX,
          plan.y - transforming.startY,
          {
            lockAspect: e.shiftKey,
            snapStep: editSnapStep(snapStep, units, { shift: false, alt: e.altKey }),
          },
        );
        transforming.width = size.width;
        transforming.height = size.height;
        setTransformPreview({ handle: transforming.handle, ...size, rotateBy: 0 });
      }
      return;
    }

    if (pointMoveRef.current) {
      const next = snapPlanPoint(plan, snapStep, units, { shift: e.shiftKey, alt: e.altKey });
      setPointPreview({ ...pointMoveRef.current, ...next });
      return;
    }

    if (wallDragRef.current) {
      const drag = wallDragRef.current;
      const dx = plan.x - drag.originX;
      const dy = plan.y - drag.originY;
      let delta =
        drag.gesture === 'length'
          ? dx * drag.tx + dy * drag.ty
          : dx * drag.nx + dy * drag.ny;
      delta = snapDragDelta(delta, snapStep, units, { shift: e.shiftKey, alt: e.altKey });
      if (drag.gesture === 'length') {
        // Keep a minimal positive chord (~0.1″).
        delta = Math.max(delta, UNITS_PER_INCH / 10 - drag.baseLength);
      }
      let amount = drag.baseAmount + delta;
      if (drag.gesture === 'curve') {
        // Past half-chord the three-point fit becomes a major arc and the room
        // balloons. Keep canvas drags on the minor (bay) side of a semicircle.
        const maxSag = Math.max(0, drag.baseLength / 2 - 1);
        amount = Math.max(-maxSag, Math.min(maxSag, amount));
      }
      drag.amount = amount;
      setWallDragPreview({
        index: drag.index,
        amount,
        baseAmount: drag.baseAmount,
        baseLength: drag.baseLength,
        nx: drag.nx,
        ny: drag.ny,
        tx: drag.tx,
        ty: drag.ty,
        gesture: drag.gesture,
      });
      return;
    }

    const band = marqueeRef.current;
    if (band) {
      setMarquee({ x0: band.x0, y0: band.y0, x1: plan.x, y1: plan.y });
      return;
    }

    const moving = moveRef.current;
    if (moving) {
      const raw = { dx: plan.x - moving.startX, dy: plan.y - moving.startY };
      const snapped = scene
        ? applySnap(objectBounds, selection, raw, snapStep, view.scale, objectSnap, units, {
            shift: e.shiftKey,
            alt: e.altKey,
          })
        : { ...raw, guides: {} };
      scheduleNudge({ dx: snapped.dx, dy: snapped.dy }, snapped.guides);
      return;
    }

    // Cheap, and it has to run before object hover so the cursor over a corner
    // grip says "resize" rather than "select the thing underneath".
    if (handlesLive && transformFrame && transformTarget) {
      const rect = e.currentTarget.getBoundingClientRect();
      const over = hitHandle(
        transformFrame,
        view,
        e.clientX - rect.left,
        e.clientY - rect.top,
        transformTarget.canRotate,
      );
      const usable = over === 'rotate' ? transformTarget.canRotate : transformTarget.canResize;
      setHoverHandle(over && usable ? over : null);
    } else if (hoverHandle) {
      setHoverHandle(null);
    }

    if (scene && editable && scene.primitives.length <= HOVER_PRIMITIVE_LIMIT) {
      hoverPointRef.current = plan;
      if (hoverFrameRef.current == null) {
        hoverFrameRef.current = window.requestAnimationFrame(() => {
          hoverFrameRef.current = null;
          const point = hoverPointRef.current;
          if (!point) return;
          const candidates = hitTestCandidates(
            prepared,
            visibleLayers,
            point.x,
            point.y,
            8 / viewRef.current.scale,
          );
          setHover(candidates[0]?.id ?? null);
          const peek =
            candidates.length >= 2 ? candidates.map((c) => ({ id: c.id, name: c.name })) : [];
          setPeekStack(peek);
          publishStackCandidates(peek);
          if (peek.length >= 2 && wrapRef.current) {
            const rect = wrapRef.current.getBoundingClientRect();
            const client = pointerScreenRef.current;
            const rawX = client ? client.x - rect.left + 14 : point.x * viewRef.current.scale + viewRef.current.offsetX + 14;
            const rawY = client ? client.y - rect.top + 10 : point.y * viewRef.current.scale + viewRef.current.offsetY + 10;
            const cardW = 188;
            const cardH = 28 + peek.length * 28;
            setPeekCardPos({
              x: Math.max(8, Math.min(rect.width - cardW - 8, rawX)),
              y: Math.max(8, Math.min(rect.height - cardH - 8, rawY)),
            });
          } else {
            setPeekCardPos(null);
          }
        });
      }
    }
  };

  const endDrag = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);

    if (transformRef.current) {
      const drag = transformRef.current;
      transformRef.current = null;
      setTransformPreview(null);
      if (drag.handle === 'rotate') {
        // Below a twentieth of a degree this was a click on the grip.
        if (Math.abs(drag.rotateBy) >= 0.05) onRotateBy?.(drag.nodeId, drag.rotateBy);
      } else if (
        Math.abs(drag.width - drag.frame.width) >= 1 ||
        Math.abs(drag.height - drag.frame.height) >= 1
      ) {
        onResizeTo?.(drag.nodeId, drag.width, drag.height);
      }
      return;
    }

    if (pointMoveRef.current) {
      const moved = pointPreview ?? pointMoveRef.current;
      pointMoveRef.current = null;
      setPointPreview(null);
      onMovePoint?.(moved.pathNodeId, moved.pointIndex, moved.x, moved.y);
      return;
    }

    if (wallDragRef.current) {
      const drag = wallDragRef.current;
      wallDragRef.current = null;
      setWallDragPreview(null);
      // Commit on a real move (0.1″ / 1 unit), comparing against the pre-drag value.
      if (Math.abs(drag.amount - drag.baseAmount) >= 1) {
        onWallGesture?.(drag.index, drag.gesture, drag.amount);
      }
      return;
    }

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
    pointerMode.mode === 'span' || pointerMode.mode === 'path'
      ? 'measure'
      : pointerMode.mode === 'stamp'
        ? 'place'
        : pointerMode.mode === 'direct-select'
          ? 'direct-select'
        : pointerMode.mode === 'pan' || panRef.current
          ? 'pan'
          : 'select';

  // Which half of a two-point tool the next click completes. It is the same
  // thing the on-sheet prompt says in words, published where it can be read
  // without parsing copy: after every click it must flip, and a run of clicks
  // that does not flip it has had one taken from it by something over the
  // sheet.
  const twoPoint: 'start' | 'end' | undefined = pointerMode.parity;

  // A drag in progress keeps its cursor even when the pointer runs off the grip.
  const activeHandle = transformPreview?.handle ?? hoverHandle;

  return (
    <div
      className="canvas-wrap"
      ref={wrapRef}
      // A grip under the pointer (or held in a drag) owns the cursor: the arrow
      // has to agree with what a drag from here would actually do.
      style={
        activeHandle && transformFrame
          ? ({ '--canvas-cursor': cursorFor(activeHandle, transformFrame.angle) } as CSSProperties)
          : undefined
      }
      data-handle={activeHandle ? 'on' : undefined}
      data-mode={spaceHeld ? 'pan' : mode}
      data-two-point={twoPoint}
      data-path-points={pointerMode.mode === 'path' ? pathPoints.length : undefined}
      data-dropping={dropping?.kind}
      onPointerLeave={(e) => {
        const related = e.relatedTarget;
        if (related instanceof Node && e.currentTarget.contains(related)) return;
        scheduleCursor(null);
        setHover(null);
        clearStackPeek();
      }}
    >
      <canvas
        ref={canvasRef}
        role="application"
        aria-label="Plan canvas. Click to select, drag to move, press H for the Hand tool, hold Space to pan, and use Control or Command plus the wheel to zoom."
        tabIndex={0}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onDoubleClick={onDoubleClick}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onContextMenu={(e) => e.preventDefault()}
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
          const snapped = snapPlanPoint({ x, y }, snapStep, units, {
            shift: e.shiftKey,
            alt: e.altKey,
          });
          if (description && onDropGear) onDropGear(description, snapped.x, snapped.y);
          else if (id && onDropItem) onDropItem(id, snapped.x, snapped.y);
        }}
      />
      {textEditor && editingTextPrimitive && inlineTextStyle && (
        <textarea
          className="canvas-inline-text-editor"
          aria-label="Edit text on plan"
          autoFocus
          rows={Math.max(1, Math.min(8, textEditor.value.replace(/\r/g, '').split('\n').length))}
          maxLength={254}
          value={textEditor.value}
          style={inlineTextStyle}
          onPointerDown={(event) => event.stopPropagation()}
          onChange={(event) => onTextEditorChange?.(event.target.value)}
          onBlur={() => onTextEditorBlur?.()}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              onTextEditorCancel?.();
            } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              onTextEditorCommit?.();
            }
          }}
        />
      )}
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
      {showStackPeek && peekCardItems.length >= 2 && peekCardPos && (
        <div
          className="stack-hover-card"
          role="dialog"
          aria-label="Stacked items under pointer"
          style={{ left: peekCardPos.x, top: peekCardPos.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="stack-hover-card-header">
            <strong>{peekCardItems.length} stacked</strong>
          </div>
          <ul className="stack-hover-card-list">
            {peekCardItems.map((item, index) => {
              const accent = STACK_PEEK_ACCENTS[index % STACK_PEEK_ACCENTS.length];
              const elev =
                item.elevation != null && item.elevation > 0
                  ? formatLength(item.elevation, units)
                  : 'floor';
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    className={selection.includes(item.id) ? 'is-on' : undefined}
                    style={{ ['--stack-accent' as string]: accent }}
                    onClick={() => {
                      onSelect([item.id]);
                      onStackCycle?.(`${index + 1} of ${peekCardItems.length} · ${item.name}`);
                    }}
                  >
                    <span className="stack-hover-accent" aria-hidden />
                    <span className="stack-hover-body">
                      <strong className="stack-hover-name">{item.name}</strong>
                      <span className="stack-hover-meta">{elev}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <div className="zoom-cluster">
        <button
          className={`icon-btn${pointerMode.mode === 'pan' ? ' is-on' : ''}`}
          onClick={() => onToggleHand?.()}
          title="Hand tool: drag to pan (H)"
          aria-label="Hand tool: drag to pan (H)"
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
  snapStep: number,
  viewScale: number,
  objectSnap: boolean,
  units: UnitSystem = 'imperial',
  keys: SnapKeys = { shift: false, alt: false },
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

  if (objectSnap && !keys.alt && selection.length <= 40) {
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
  }

  const gridStep = editSnapStep(snapStep, units, keys);

  if (bestX) {
    dx += bestX.at - centre.x;
    guides.x = bestX.at;
  } else if (gridStep > 0) {
    dx += snapScalar(centre.x, gridStep) - centre.x;
  }

  if (bestY) {
    dy += bestY.at - centre.y;
    guides.y = bestY.at;
  } else if (gridStep > 0) {
    dy += snapScalar(centre.y, gridStep) - centre.y;
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
    const y = Math.round(screenY(view, guides.y)) + 0.5;
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
  const y = screenY(view, Math.max(band.y0, band.y1));
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
  const y0 = screenY(view, from.y);
  const x1 = to.x * view.scale + view.offsetX;
  const y1 = screenY(view, to.y);

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

/** Dashed working-size guide for custom room tracing. */
function drawRoomPathGuide(
  ctx: CanvasRenderingContext2D,
  guide: { width: number; depth: number },
  view: View,
): void {
  const hw = guide.width / 2;
  const hd = guide.depth / 2;
  const x0 = (-hw) * view.scale + view.offsetX;
  const y0 = screenY(view, -hd);
  const x1 = hw * view.scale + view.offsetX;
  const y1 = screenY(view, hd);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, x1 - x0, y1 - y0);
  ctx.strokeStyle = 'rgba(77, 148, 255, 0.45)';
  ctx.lineWidth = 1.25;
  ctx.setLineDash([7, 5]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(77, 148, 255, 0.04)';
  ctx.fill();
  ctx.restore();
}

/** Live preview for the click-by-click custom room tool. */
function drawRoomPathPreview(
  ctx: CanvasRenderingContext2D,
  points: PlanPoint[],
  pointer: { x: number; y: number } | null,
  view: View,
): void {
  if (!points.length) return;
  const sx = (point: { x: number }) => point.x * view.scale + view.offsetX;
  const sy = (point: { y: number }) => screenY(view, point.y);

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // The committed corners read as the future room floor; the pointer leg and
  // closing leg stay dashed so it is clear they have not been committed yet.
  if (points.length >= 3) {
    ctx.beginPath();
    ctx.moveTo(sx(points[0]), sy(points[0]));
    for (let index = 1; index < points.length; index++) ctx.lineTo(sx(points[index]), sy(points[index]));
    ctx.closePath();
    ctx.fillStyle = 'rgba(77, 148, 255, 0.1)';
    ctx.fill();
  }

  ctx.beginPath();
  ctx.moveTo(sx(points[0]), sy(points[0]));
  for (let index = 1; index < points.length; index++) ctx.lineTo(sx(points[index]), sy(points[index]));
  ctx.strokeStyle = 'rgba(77, 148, 255, 0.95)';
  ctx.lineWidth = 2;
  ctx.stroke();

  const last = points.at(-1)!;
  const live = pointer ?? last;
  ctx.beginPath();
  ctx.moveTo(sx(last), sy(last));
  ctx.lineTo(sx(live), sy(live));
  if (points.length >= 2) ctx.lineTo(sx(points[0]), sy(points[0]));
  ctx.strokeStyle = 'rgba(77, 148, 255, 0.72)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.stroke();
  ctx.setLineDash([]);

  for (const [index, point] of points.entries()) {
    ctx.beginPath();
    ctx.arc(sx(point), sy(point), index === 0 ? 5 : 4, 0, Math.PI * 2);
    ctx.fillStyle = index === 0 ? '#1678d3' : '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#1678d3';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
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
  const y0 = screenY(view, from.y);
  const x1 = to.x * view.scale + view.offsetX;
  const y1 = screenY(view, to.y);

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

/**
 * The transform frame: the object's own rectangle with live handles.
 *
 * Drawn instead of the plain bounds highlight whenever exactly one editable
 * object is selected in select mode. The rectangle is the object's, not the
 * world-aligned box, so the grips sit on the real corners of a rotated riser.
 */
function drawTransformFrame(
  ctx: CanvasRenderingContext2D,
  frame: TransformFrame,
  view: View,
  preview: { handle: HandleId; width: number; height: number; rotateBy: number } | null,
  nudge: { dx: number; dy: number } | null,
  units: UnitSystem,
  canRotate: boolean,
): void {
  // A live drag paints the size and angle it is asking for, not the committed
  // ones, or the frame would lag a whole IPC round-trip behind the pointer.
  const live: TransformFrame = {
    cx: frame.cx + (nudge?.dx ?? 0),
    cy: frame.cy + (nudge?.dy ?? 0),
    width: preview && preview.handle !== 'rotate' ? preview.width : frame.width,
    height: preview && preview.handle !== 'rotate' ? preview.height : frame.height,
    angle: frame.angle + (preview?.rotateBy ?? 0),
  };

  const corners = frameCorners(live, view);
  ctx.save();
  ctx.strokeStyle = 'rgba(77,148,255,0.85)';
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.beginPath();
  corners.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.closePath();
  ctx.stroke();

  const points = handlePoints(live, view, canRotate);

  for (const point of points) {
    if (!edgeHandleFits(live, view, point.id)) continue;
    const active = preview?.handle === point.id;
    if (point.id === 'rotate') {
      // A stem to the top edge, so the grip reads as attached to the object.
      const top = points.find((p) => p.id === 'n');
      if (top) {
        ctx.beginPath();
        ctx.moveTo(top.x, top.y);
        ctx.lineTo(point.x, point.y);
        ctx.strokeStyle = 'rgba(77,148,255,0.55)';
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(point.x, point.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = active ? 'rgba(22,135,248,1)' : '#fff';
      ctx.fill();
      ctx.strokeStyle = 'rgba(22,135,248,0.95)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      continue;
    }
    ctx.beginPath();
    ctx.rect(point.x - HANDLE_HALF, point.y - HANDLE_HALF, HANDLE_HALF * 2, HANDLE_HALF * 2);
    ctx.fillStyle = active ? 'rgba(22,135,248,1)' : '#fff';
    ctx.fill();
    ctx.strokeStyle = 'rgba(22,135,248,0.95)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  if (preview) {
    const label =
      preview.handle === 'rotate'
        ? `${(((live.angle % 360) + 360) % 360).toFixed(1)}°`
        : `${formatLength(live.width, units)} × ${formatLength(live.height, units)}`;
    ctx.font = '600 11px -apple-system, "Segoe UI", system-ui, sans-serif';
    const textWidth = ctx.measureText(label).width;
    const chipW = textWidth + 14;
    const chipH = 20;
    const centre = {
      x: live.cx * view.scale + view.offsetX,
      y: screenY(view, live.cy),
    };
    const lowest = Math.max(...corners.map((c) => c.y));
    const chipX = Math.round(centre.x - chipW / 2);
    const chipY = Math.round(Math.max(RULER + 4, lowest + 10));
    ctx.fillStyle = 'rgba(22,135,248,0.95)';
    ctx.fillRect(chipX, chipY, chipW, chipH);
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(label, chipX + 7, chipY + chipH / 2);
  }
  ctx.restore();
}

/** An honest bounds highlight, for anything the transform frame does not cover. */
function drawSelectionFrame(
  ctx: CanvasRenderingContext2D,
  b: { minX: number; minY: number; maxX: number; maxY: number },
  view: View,
  nudge: { dx: number; dy: number } | null,
  kind: 'solo' | 'item' | 'group' = 'solo',
  count?: number,
): void {
  const dx = nudge?.dx ?? 0;
  const dy = nudge?.dy ?? 0;
  const pad = kind === 'group' ? 8 : 5;
  const x0 = (b.minX + dx) * view.scale + view.offsetX - pad;
  const y0 = screenY(view, b.maxY + dy) - pad;
  const x1 = (b.maxX + dx) * view.scale + view.offsetX + pad;
  const y1 = screenY(view, b.minY + dy) + pad;
  const w = Math.round(x1 - x0);
  const h = Math.round(y1 - y0);
  const left = Math.round(x0) + 0.5;
  const top = Math.round(y0) + 0.5;

  ctx.save();
  if (kind === 'group') {
    ctx.strokeStyle = 'rgba(77,148,255,0.92)';
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.strokeRect(left, top, w, h);
    const label = `${count ?? 0} selected`;
    ctx.font = '600 11px -apple-system, "Segoe UI", system-ui, sans-serif';
    const tw = ctx.measureText(label).width;
    const chipW = tw + 12;
    const chipH = 18;
    const chipX = left;
    const chipY = Math.max(RULER + 4, top - chipH - 4);
    ctx.fillStyle = 'rgba(22,135,248,0.95)';
    ctx.fillRect(chipX, chipY, chipW, chipH);
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, chipX + 6, chipY + chipH / 2);
  } else if (kind === 'item') {
    ctx.strokeStyle = 'rgba(77,148,255,0.28)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(left, top, w, h);
  } else {
    ctx.strokeStyle = 'rgba(77,148,255,0.55)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(left, top, w, h);
  }
  ctx.restore();
}

/** Warm surface ring — the digital “floor” the next piece will sit on. */
function drawPlaceOnSurface(
  ctx: CanvasRenderingContext2D,
  b: { minX: number; minY: number; maxX: number; maxY: number },
  view: View,
  paper: boolean,
  label: string,
): void {
  const pad = 10;
  const left = Math.round(b.minX * view.scale + view.offsetX - pad) + 0.5;
  const top = Math.round(screenY(view, b.maxY) - pad) + 0.5;
  const w = Math.round((b.maxX - b.minX) * view.scale + pad * 2);
  const h = Math.round((b.maxY - b.minY) * view.scale + pad * 2);
  ctx.save();
  ctx.fillStyle = paper ? 'rgba(230, 167, 61, 0.14)' : 'rgba(230, 167, 61, 0.18)';
  ctx.fillRect(left, top, w, h);
  ctx.strokeStyle = paper ? 'rgba(184, 120, 20, 0.95)' : 'rgba(255, 196, 90, 0.95)';
  ctx.lineWidth = 2.5;
  ctx.setLineDash([8, 5]);
  ctx.strokeRect(left, top, w, h);
  ctx.setLineDash([]);

  const chip = `PLACE ON · ${label}`;
  ctx.font = '700 11px -apple-system, "Segoe UI", system-ui, sans-serif';
  const tw = ctx.measureText(chip).width;
  const chipW = tw + 16;
  const chipH = 22;
  const chipX = left;
  const chipY = Math.max(RULER + 4, top - chipH - 6);
  ctx.fillStyle = paper ? 'rgba(184, 120, 20, 0.96)' : 'rgba(230, 167, 61, 0.96)';
  roundRect(ctx, chipX, chipY, chipW, chipH, 6);
  ctx.fill();
  ctx.fillStyle = paper ? '#fff8e8' : '#1a1408';
  ctx.textBaseline = 'middle';
  ctx.fillText(chip, chipX + 8, chipY + chipH / 2);
  ctx.restore();
}

/** Dashed enclosure + height chips for a linked stack set. */
function drawStackSetOverlay(
  ctx: CanvasRenderingContext2D,
  objectBounds: Map<number, { minX: number; minY: number; maxX: number; maxY: number }>,
  stackSet: Array<{ id: number; name: string; elevation: number; kind: string }>,
  view: View,
  nudge: { dx: number; dy: number } | null,
  paper: boolean,
  units: UnitSystem,
  showMarkers: boolean,
): void {
  const ids = stackSet.map((s) => s.id);
  const group = boundsOfMany(objectBounds, ids);
  if (!group) return;
  const dx = nudge?.dx ?? 0;
  const dy = nudge?.dy ?? 0;
  const pad = 12;
  const left = Math.round((group.minX + dx) * view.scale + view.offsetX - pad) + 0.5;
  const top = Math.round(screenY(view, group.maxY + dy) - pad) + 0.5;
  const w = Math.round((group.maxX - group.minX) * view.scale + pad * 2);
  const h = Math.round((group.maxY - group.minY) * view.scale + pad * 2);

  ctx.save();
  ctx.strokeStyle = paper ? 'rgba(79, 184, 121, 0.85)' : 'rgba(110, 210, 150, 0.9)';
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(left, top, w, h);
  ctx.setLineDash([]);

  const title = `STACK · ${stackSet.length} pieces move together`;
  ctx.font = '700 11px -apple-system, "Segoe UI", system-ui, sans-serif';
  const tw = ctx.measureText(title).width;
  const chipW = tw + 14;
  const chipH = 20;
  const chipX = left;
  const chipY = Math.max(RULER + 4, top - chipH - 4);
  ctx.fillStyle = paper ? 'rgba(40, 140, 85, 0.95)' : 'rgba(70, 170, 110, 0.95)';
  roundRect(ctx, chipX, chipY, chipW, chipH, 5);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.fillText(title, chipX + 7, chipY + chipH / 2);

  if (!showMarkers) {
    ctx.restore();
    return;
  }

  // Height callouts at each member centre, sorted low→high digitally.
  const ordered = [...stackSet].sort((a, b) => a.elevation - b.elevation || a.name.localeCompare(b.name));
  ordered.forEach((member, index) => {
    const b = objectBounds.get(member.id);
    if (!b) return;
    const cx = ((b.minX + b.maxX) / 2 + dx) * view.scale + view.offsetX;
    const cy = screenY(view, (b.minY + b.maxY) / 2 + dy);
    const elev =
      member.elevation > 0 ? formatLength(member.elevation, units) : 'floor';
    const tag = `${index + 1}  ${elev}`;
    ctx.font = '600 10px -apple-system, "Segoe UI", system-ui, sans-serif';
    const tagW = ctx.measureText(tag).width + 12;
    const tagH = 16;
    const tagX = cx - tagW / 2;
    const tagY = cy - tagH / 2;
    ctx.fillStyle =
      member.kind === 'focus'
        ? paper
          ? 'rgba(22,135,248,0.95)'
          : 'rgba(77,148,255,0.95)'
        : paper
          ? 'rgba(40, 140, 85, 0.92)'
          : 'rgba(70, 170, 110, 0.92)';
    roundRect(ctx, tagX, tagY, tagW, tagH, 4);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText(tag, tagX + 6, tagY + tagH / 2);
  });
  ctx.restore();
}

const STACK_PEEK_ACCENTS = ['#7c5cfc', '#4a9eff', '#e8b84a', '#4fb879'];

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
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
    const logical = Math.round(planY(view, y) / step) * step;
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
