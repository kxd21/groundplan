/**
 * Multi-step Shape Editor Wizard: category, seating notes, then a room-builder
 * style outline (base shape + add/cut merges, or manual trace over a photo).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { CATEGORY_LABELS, type Category } from '../../inventory/classify.js';
import { buildNewRoom, type NewRoomShape } from '../../format/new-room.js';
import {
  combineRooms,
  isAxisAligned,
  moveCorner,
  rectRoom,
  type BooleanOp,
} from '../../format/room-edit.js';
import {
  flattenWall,
  roomArea,
  roomBounds,
  roomFromPolygon,
  roomPolygon,
  type RoomModel,
} from '../../format/room.js';
import type { Point } from '../../format/rv.js';
import { UNITS_PER_INCH } from '../../format/rv.js';
import { formatArea, formatLength, parseLength, type UnitSystem } from '../../format/units.js';
import { constrainRoomCorner, type CustomRoomAngleLock } from './custom-room.js';
import { IconDrawEllipse, IconDrawPolygon, IconDrawRect, IconPlus } from './icons.js';
import { TraceDialog } from './TraceDialog.js';

const api = window.groundplan;

/** Prefill when opening the wizard from Inventory to author an elevation. */
export type ShapeWizardSeed = {
  baseName: string;
  category?: Category;
  elevationView: 'front' | 'side';
  /** Plan footprint — suggests silhouette width (front) or depth (side). */
  planWidth?: number;
  planDepth?: number;
};

function elevationSuffix(view: 'front' | 'side'): '(FV)' | '(SV)' {
  return view === 'front' ? '(FV)' : '(SV)';
}

function rectStubPaths(width: number, height: number): Array<{ points: number[]; closed: boolean }> {
  return [{ points: [0, 0, width, 0, width, height, 0, height], closed: true }];
}

const TABLE_CATEGORIES: Category[] = ['table-round', 'table-rect', 'desk'];
const SEATING_STYLES = [
  'theatre',
  'schoolroom',
  'banquet',
  'cabaret',
  'crescent',
  'conference',
  'u-shape',
  'hollow-square',
] as const;

type TableKind = 'other' | 'round' | 'rectangular';
type OutlineBase = Extract<NewRoomShape, 'rectangle' | 'circle' | 'l-shape' | 'u-shape' | 'stadium'>;
type BuildMode = 'preset' | 'manual';

interface RefImage {
  url: string;
  name: string;
  naturalW: number;
  naturalH: number;
  /** Full-res (capped) pixels for auto-trace. */
  imageData: ImageData;
  /** Compressed JPEG for inventory photo attachment after create. */
  photoDataUrl: string;
}

interface Props {
  open: boolean;
  units: UnitSystem;
  /** When set, author a Front/Side elevation silhouette for an existing plan item. */
  seed?: ShapeWizardSeed | null;
  onClose: () => void;
  onCreated: (id: string, name: string) => void;
  onError: (message: string) => void;
  onStatus: (message: string) => void;
}

const OUTLINE_BASES: Array<{ id: OutlineBase; label: string; detail: string; icon: 'rect' | 'ellipse' | 'polygon' }> = [
  { id: 'rectangle', label: 'Rectangle', detail: 'Width × depth', icon: 'rect' },
  { id: 'circle', label: 'Round', detail: 'Oval / circle', icon: 'ellipse' },
  { id: 'stadium', label: 'Stadium', detail: 'Rounded ends', icon: 'ellipse' },
  { id: 'l-shape', label: 'L-shape', detail: 'One recess', icon: 'polygon' },
  { id: 'u-shape', label: 'U-shape', detail: 'Centred recess', icon: 'polygon' },
];

const ANGLE_LOCKS: Array<{ id: CustomRoomAngleLock; label: string }> = [
  { id: 'free', label: 'Free' },
  { id: 'ortho', label: 'Ortho' },
  { id: '45', label: '45°' },
];

function defaultWidth(units: UnitSystem): string {
  return formatLength(60 * 10, units);
}

function defaultNotch(units: UnitSystem): string {
  return formatLength(20 * 10, units);
}

function defaultPatch(units: UnitSystem): string {
  return formatLength(18 * 10, units);
}

function ShapeIcon({ kind }: { kind: (typeof OUTLINE_BASES)[number]['icon'] }) {
  if (kind === 'ellipse') return <IconDrawEllipse size={16} />;
  if (kind === 'polygon') return <IconDrawPolygon size={16} />;
  return <IconDrawRect size={16} />;
}

function loopPath(walls: RoomModel['walls'], tolerance: number): string {
  return (
    walls
      .flatMap((segment, index) => {
        const points = flattenWall(segment, tolerance);
        return points.map(
          (point, pointIndex) => `${index === 0 && pointIndex === 0 ? 'M' : 'L'} ${point.x} ${point.y}`,
        );
      })
      .join(' ') + ' Z'
  );
}

/** Fit an image into a W×D world rect (contain). */
function imageLayout(imgW: number, imgH: number, worldW: number, worldH: number) {
  const scale = Math.min(worldW / Math.max(1, imgW), worldH / Math.max(1, imgH));
  const drawW = imgW * scale;
  const drawH = imgH * scale;
  return {
    x: (worldW - drawW) / 2,
    y: (worldH - drawH) / 2,
    w: drawW,
    h: drawH,
  };
}

async function loadRefImage(file: File): Promise<RefImage> {
  if (!file.type.startsWith('image/')) {
    throw new Error('That is not an image file.');
  }
  const bitmap = await createImageBitmap(file);
  const maxEdge = 1600;
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('The image could not be read.');
  ctx.drawImage(bitmap, 0, 0, w, h);
  const imageData = ctx.getImageData(0, 0, w, h);
  const url = canvas.toDataURL('image/png');

  const thumbScale = Math.min(1, 256 / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * thumbScale));
  const th = Math.max(1, Math.round(h * thumbScale));
  const thumb = document.createElement('canvas');
  thumb.width = tw;
  thumb.height = th;
  thumb.getContext('2d')?.drawImage(canvas, 0, 0, tw, th);
  const photoDataUrl = thumb.toDataURL('image/jpeg', 0.82);

  return {
    url,
    name: file.name,
    naturalW: w,
    naturalH: h,
    imageData,
    photoDataUrl,
  };
}

/** Shift every wall (and hole) by a translation. */
function translateRoom(room: RoomModel, dx: number, dy: number): RoomModel {
  const shiftWalls = (walls: RoomModel['walls']) =>
    walls.map((wall) => ({
      ...wall,
      start: { x: wall.start.x + dx, y: wall.start.y + dy },
      end: { x: wall.end.x + dx, y: wall.end.y + dy },
    }));
  return {
    ...room,
    walls: shiftWalls(room.walls),
    holes: room.holes.map(shiftWalls),
  };
}

/** Centre-origin traced paths → room polygon in the shape builder's 0…W × 0…D box. */
function tracedResultToRoom(result: {
  width: number;
  height: number;
  paths: Array<{ points: number[]; closed: boolean }>;
}): RoomModel | null {
  const path = result.paths[0];
  if (!path || path.points.length < 6) return null;
  const points: Point[] = [];
  for (let i = 0; i + 1 < path.points.length; i += 2) {
    points.push({
      x: path.points[i] + result.width / 2,
      y: path.points[i + 1] + result.height / 2,
    });
  }
  const room = roomFromPolygon(points, 'Shape');
  if (room.walls.length < 3) return null;
  return room;
}

/**
 * Inventory traced icons are centre-origin (placeTracedIcon / palette thumbs).
 * Export the outer outline only — holes are not placeable as cut-outs yet.
 */
function roomToTracedPaths(room: RoomModel): {
  width: number;
  height: number;
  paths: Array<{ points: number[]; closed: boolean }>;
  droppedHoles: number;
} | null {
  const bounds = roomBounds(room);
  if (!bounds) return null;
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const cx = bounds.minX + width / 2;
  const cy = bounds.minY + height / 2;
  const tolerance = Math.max(width, height) / 240;

  const points: number[] = [];
  for (const point of roomPolygon(room.walls, tolerance)) {
    points.push(point.x - cx, point.y - cy);
  }
  if (points.length < 6) return null;

  return {
    width,
    height,
    paths: [{ points, closed: true }],
    droppedHoles: room.holes.length,
  };
}

function clientToSvgPoint(svg: SVGSVGElement, clientX: number, clientY: number): Point | null {
  const ctm = svg.getScreenCTM();
  if (!ctm) return null;
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const local = pt.matrixTransform(ctm.inverse());
  return { x: local.x, y: local.y };
}

function ShapeOutlineStage({
  room,
  patch,
  refImage,
  worldW,
  worldH,
  manualPoints,
  hover,
  interactive,
  editableCorners,
  onPointerWorld,
  onHoverWorld,
  onCornerDrag,
  onCornerDragStart,
}: {
  room: RoomModel | null;
  patch?: { x: number; y: number; w: number; d: number; op: BooleanOp } | null;
  refImage: RefImage | null;
  worldW: number;
  worldH: number;
  manualPoints: Point[];
  hover: Point | null;
  interactive: boolean;
  editableCorners: boolean;
  onPointerWorld: (point: Point, shiftKey: boolean) => void;
  onHoverWorld: (point: Point | null, shiftKey: boolean) => void;
  onCornerDrag: (index: number, point: Point) => void;
  onCornerDragStart?: () => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragIndex = useRef<number | null>(null);

  let minX = 0;
  let minY = 0;
  let maxX = Math.max(1, worldW);
  let maxY = Math.max(1, worldH);

  if (room) {
    const bounds = roomBounds(room);
    if (bounds) {
      minX = Math.min(minX, bounds.minX);
      minY = Math.min(minY, bounds.minY);
      maxX = Math.max(maxX, bounds.maxX);
      maxY = Math.max(maxY, bounds.maxY);
    }
  }
  for (const point of manualPoints) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  if (hover) {
    minX = Math.min(minX, hover.x);
    minY = Math.min(minY, hover.y);
    maxX = Math.max(maxX, hover.x);
    maxY = Math.max(maxY, hover.y);
  }
  if (patch && patch.w > 0 && patch.d > 0) {
    minX = Math.min(minX, patch.x);
    minY = Math.min(minY, patch.y);
    maxX = Math.max(maxX, patch.x + patch.w);
    maxY = Math.max(maxY, patch.y + patch.d);
  }

  const spanW = Math.max(1, maxX - minX);
  const spanH = Math.max(1, maxY - minY);
  const pad = Math.max(spanW, spanH) * 0.08;
  const tolerance = Math.max(spanW, spanH) / 180;
  const viewBox = `${minX - pad} ${minY - pad} ${spanW + pad * 2} ${spanH + pad * 2}`;
  const layout = refImage ? imageLayout(refImage.naturalW, refImage.naturalH, worldW, worldH) : null;
  const closeR = Math.max(worldW, worldH) * 0.025;
  const cornerR = Math.max(spanW, spanH) * 0.014;

  const handlePointer = (event: ReactPointerEvent<SVGSVGElement>, kind: 'down' | 'move' | 'up' | 'leave') => {
    const svg = svgRef.current;
    if (!svg) return;

    if (kind === 'up' || kind === 'leave') {
      if (dragIndex.current != null) {
        dragIndex.current = null;
        try {
          svg.releasePointerCapture(event.pointerId);
        } catch {
          /* ignore */
        }
      }
      if (kind === 'leave' && interactive) onHoverWorld(null, event.shiftKey);
      return;
    }

    const point = clientToSvgPoint(svg, event.clientX, event.clientY);
    if (!point) return;

    if (kind === 'move' && dragIndex.current != null) {
      event.preventDefault();
      onCornerDrag(dragIndex.current, point);
      return;
    }

    if (interactive) {
      if (kind === 'down') {
        event.preventDefault();
        onPointerWorld(point, event.shiftKey);
      } else {
        onHoverWorld(point, event.shiftKey);
      }
    }
  };

  const startCornerDrag = (index: number, event: ReactPointerEvent<SVGCircleElement>) => {
    if (!editableCorners) return;
    event.preventDefault();
    event.stopPropagation();
    dragIndex.current = index;
    onCornerDragStart?.();
    svgRef.current?.setPointerCapture(event.pointerId);
  };

  const previewPoints =
    manualPoints.length > 0
      ? hover
        ? [...manualPoints, hover]
        : manualPoints
      : [];

  return (
    <svg
      ref={svgRef}
      className={`shape-wizard-preview-svg${interactive || editableCorners ? ' is-interactive' : ''}${
        editableCorners ? ' is-editing-corners' : ''
      }`}
      viewBox={viewBox}
      role="img"
      aria-label={
        interactive
          ? 'Click corners to trace the outline'
          : editableCorners
            ? 'Drag corners to refine the outline'
            : 'Shape outline preview'
      }
      onPointerDown={(event) => handlePointer(event, 'down')}
      onPointerMove={(event) => handlePointer(event, 'move')}
      onPointerUp={(event) => handlePointer(event, 'up')}
      onPointerLeave={(event) => handlePointer(event, 'leave')}
    >
      <rect
        className="shape-wizard-preview-guide"
        x={0}
        y={0}
        width={worldW}
        height={worldH}
        vectorEffect="non-scaling-stroke"
      />
      {refImage && layout && (
        <image
          className="shape-wizard-preview-photo"
          href={refImage.url}
          x={layout.x}
          y={layout.y}
          width={layout.w}
          height={layout.h}
          preserveAspectRatio="none"
          opacity={0.88}
        />
      )}
      {room && (
        <>
          <path
            className="shape-wizard-preview-fill"
            fillRule="evenodd"
            d={loopPath(room.walls, tolerance) + room.holes.map((hole) => loopPath(hole, tolerance)).join(' ')}
          />
          {room.walls.map((segment, index) => (
            <polyline
              key={`wall-${index}`}
              className="shape-wizard-preview-wall"
              points={flattenWall(segment, tolerance)
                .map((point) => `${point.x},${point.y}`)
                .join(' ')}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {room.holes.flatMap((hole, holeIndex) =>
            hole.map((segment, index) => (
              <polyline
                key={`hole-${holeIndex}-${index}`}
                className="shape-wizard-preview-hole"
                points={flattenWall(segment, tolerance)
                  .map((point) => `${point.x},${point.y}`)
                  .join(' ')}
                vectorEffect="non-scaling-stroke"
              />
            )),
          )}
          {room.walls.map((segment, index) => (
            <circle
              key={`corner-${index}`}
              className={`shape-wizard-preview-corner${editableCorners ? ' is-editable' : ''}`}
              cx={segment.start.x}
              cy={segment.start.y}
              r={cornerR}
              vectorEffect="non-scaling-stroke"
              onPointerDown={(event) => startCornerDrag(index, event)}
            />
          ))}
        </>
      )}
      {previewPoints.length > 0 && (
        <polyline
          className="shape-wizard-preview-trace"
          points={previewPoints.map((point) => `${point.x},${point.y}`).join(' ')}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {manualPoints.map((point, index) => (
        <circle
          key={`trace-${index}`}
          className={index === 0 ? 'shape-wizard-preview-corner is-start' : 'shape-wizard-preview-corner'}
          cx={point.x}
          cy={point.y}
          r={index === 0 ? closeR * 0.55 : cornerR}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {manualPoints.length >= 3 && (
        <circle
          className="shape-wizard-preview-close-hint"
          cx={manualPoints[0].x}
          cy={manualPoints[0].y}
          r={closeR}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {patch && patch.w > 0 && patch.d > 0 && (
        <rect
          className={
            patch.op === 'difference' ? 'shape-wizard-preview-patch is-cut' : 'shape-wizard-preview-patch is-add'
          }
          x={patch.x}
          y={patch.y}
          width={patch.w}
          height={patch.d}
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}

function allWallsAxisAligned(room: RoomModel): boolean {
  return isAxisAligned([...room.walls, ...room.holes.flat()]);
}

export default function ShapeEditorWizard({
  open,
  units,
  seed = null,
  onClose,
  onCreated,
  onError,
  onStatus,
}: Props) {
  const [step, setStep] = useState(0);
  const [category, setCategory] = useState<Category>('table-round');
  const [name, setName] = useState('');
  const [spanishName, setSpanishName] = useState('');
  const [tableKind, setTableKind] = useState<TableKind>('round');
  const [allowChairs, setAllowChairs] = useState(true);
  const [defaultChairs, setDefaultChairs] = useState(8);
  const [styles, setStyles] = useState<string[]>(['banquet']);
  const [widthText, setWidthText] = useState(() => defaultWidth(units));
  const [depthText, setDepthText] = useState(() => defaultWidth(units));
  const [notchWText, setNotchWText] = useState(() => defaultNotch(units));
  const [notchDText, setNotchDText] = useState(() => defaultNotch(units));
  const [outlineBase, setOutlineBase] = useState<OutlineBase>('rectangle');
  const [buildMode, setBuildMode] = useState<BuildMode>('preset');
  const [refImage, setRefImage] = useState<RefImage | null>(null);
  const [manualPoints, setManualPoints] = useState<Point[]>([]);
  const [hoverPoint, setHoverPoint] = useState<Point | null>(null);
  const [angleLock, setAngleLock] = useState<CustomRoomAngleLock>('free');
  const [draft, setDraft] = useState<RoomModel | null>(null);
  const [history, setHistory] = useState<RoomModel[]>([]);
  const [reshapeOp, setReshapeOp] = useState<BooleanOp>('union');
  const [patchXText, setPatchXText] = useState('0');
  const [patchYText, setPatchYText] = useState('0');
  const [patchWText, setPatchWText] = useState(() => defaultPatch(units));
  const [patchDText, setPatchDText] = useState(() => defaultPatch(units));
  const [traceOpen, setTraceOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [createElevationViews, setCreateElevationViews] = useState(false);
  const [deptDraft, setDeptDraft] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const outlineTouchedRef = useRef(false);

  const categories = useMemo(
    () => (Object.keys(CATEGORY_LABELS) as Category[]).filter((c) => c !== 'not-drawn'),
    [],
  );

  const width = parseLength(widthText, units);
  const depth = parseLength(depthText, units);
  const notchW = parseLength(notchWText, units);
  const notchD = parseLength(notchDText, units);
  const patchX = parseLength(patchXText, units);
  const patchY = parseLength(patchYText, units);
  const patchW = parseLength(patchWText, units);
  const patchD = parseLength(patchDText, units);
  const worldW = width && width > 0 ? width : 600;
  const worldH = depth && depth > 0 ? depth : 600;
  const tracingOpen = buildMode === 'manual' && !draft;
  const editingCorners = Boolean(draft && buildMode === 'manual');

  const onCornerDragStart = useCallback(() => {
    setDraft((current) => {
      if (current) {
        // Push outside the draft updater so Strict Mode cannot double-append.
        setHistory((prev) => {
          if (prev[prev.length - 1] === current) return prev;
          return [...prev, current];
        });
      }
      return current;
    });
  }, []);

  const onCornerDrag = useCallback((index: number, point: Point) => {
    setDraft((current) => {
      if (!current) return current;
      const next = moveCorner(current, index, point);
      return next.ok && next.room ? next.room : current;
    });
  }, []);

  const buildBase = useCallback(
    (base: OutlineBase, w: number, d: number, nw: number, nd: number): RoomModel | null => {
      const diameter = base === 'circle' ? w : Math.max(w, d);
      const built = buildNewRoom(
        {
          shape: base,
          width: w,
          depth: base === 'circle' ? w : d,
          diameter,
          notchWidth: nw,
          notchDepth: nd,
        },
        'Shape',
      );
      if (!built.ok || !built.room) return null;
      // buildNewRoom is centre-origin; the wizard stage / photo is 0…W × 0…D.
      const bounds = roomBounds(built.room);
      if (!bounds) return built.room;
      return translateRoom(built.room, -bounds.minX, -bounds.minY);
    },
    [],
  );

  const seedPatchBeside = useCallback(
    (room: RoomModel) => {
      const bounds = roomBounds(room);
      if (!bounds) return;
      setPatchXText(formatLength(bounds.maxX, units));
      setPatchYText(formatLength(bounds.minY, units));
      const side = Math.max(10, Math.min(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) * 0.35);
      setPatchWText(formatLength(side, units));
      setPatchDText(formatLength(side, units));
    },
    [units],
  );

  const resetOutline = useCallback(
    (base: OutlineBase = outlineBase) => {
      if (!(width && width > 0) || !(depth && depth > 0)) {
        setDraft(null);
        setHistory([]);
        return;
      }
      const nw = notchW && notchW > 0 ? notchW : width * 0.35;
      const nd = notchD && notchD > 0 ? notchD : depth * 0.35;
      const room = buildBase(base, width, depth, nw, nd);
      if (!room) {
        setDraft(null);
        setHistory([]);
        return;
      }
      setDraft(room);
      setHistory([]);
      seedPatchBeside(room);
    },
    [buildBase, depth, notchD, notchW, outlineBase, seedPatchBeside, width],
  );

  const clearManualTrace = useCallback(() => {
    setManualPoints([]);
    setHoverPoint(null);
    setDraft(null);
    setHistory([]);
  }, []);

  const enterManualMode = useCallback(() => {
    setBuildMode('manual');
    clearManualTrace();
  }, [clearManualTrace]);

  const enterPresetMode = useCallback(() => {
    setBuildMode('preset');
    setManualPoints([]);
    setHoverPoint(null);
    setHistory([]);
    resetOutline(outlineBase);
  }, [outlineBase, resetOutline]);

  useEffect(() => {
    if (!open) return;
    setStep(0);
    const elev = seed?.elevationView;
    const elevName = elev
      ? `${seed!.baseName.trim()} ${elevationSuffix(elev)}`
      : '';
    setCategory(seed?.category ?? 'table-round');
    setName(elev ? elevName : '');
    setSpanishName('');
    setTableKind('round');
    setAllowChairs(!elev);
    setDefaultChairs(8);
    setStyles(['banquet']);
    if (elev) {
      const across =
        elev === 'front'
          ? seed?.planWidth && seed.planWidth > 0
            ? seed.planWidth
            : 48 * UNITS_PER_INCH
          : seed?.planDepth && seed.planDepth > 0
            ? seed.planDepth
            : seed?.planWidth && seed.planWidth > 0
              ? seed.planWidth
              : 24 * UNITS_PER_INCH;
      const tall = 48 * UNITS_PER_INCH;
      setWidthText(formatLength(across, units));
      setDepthText(formatLength(tall, units));
      setCreateElevationViews(false);
    } else {
      setWidthText(defaultWidth(units));
      setDepthText(defaultWidth(units));
      setCreateElevationViews(false);
    }
    setNotchWText(defaultNotch(units));
    setNotchDText(defaultNotch(units));
    setOutlineBase('rectangle');
    setBuildMode('preset');
    setRefImage(null);
    setManualPoints([]);
    setHoverPoint(null);
    setAngleLock('free');
    setDraft(null);
    setHistory([]);
    setReshapeOp('union');
    setPatchXText('0');
    setPatchYText('0');
    setPatchWText(defaultPatch(units));
    setPatchDText(defaultPatch(units));
    setTraceOpen(false);
    setBusy(false);
    setDeptDraft('');
    outlineTouchedRef.current = false;
  }, [open, units, seed]);

  useEffect(() => {
    if (!open || step !== 2) return;
    if (buildMode !== 'preset') return;
    if (history.length > 0) return;
    resetOutline(outlineBase);
  }, [open, step, outlineBase, widthText, depthText, notchWText, notchDText, history.length, resetOutline, buildMode]);

  // Seed outline base from table type once when entering step 2 — never fight user picks.
  useEffect(() => {
    if (!open || step !== 2 || buildMode !== 'preset') return;
    if (outlineTouchedRef.current) return;
    if (tableKind === 'round') setOutlineBase('circle');
    else if (tableKind === 'rectangular') setOutlineBase('rectangle');
  }, [open, step, tableKind, buildMode]);

  if (!open) return null;

  const canReshape = Boolean(draft && allWallsAxisAligned(draft));
  const patchPreview =
    canReshape &&
    patchX != null &&
    patchY != null &&
    patchW != null &&
    patchW > 0 &&
    patchD != null &&
    patchD > 0
      ? { x: patchX, y: patchY, w: patchW, d: patchD, op: reshapeOp }
      : null;

  const seatingNote = (): string | undefined => {
    const parts: string[] = [];
    if (allowChairs && defaultChairs > 0) parts.push(`chairs:${defaultChairs}`);
    if (styles.length) parts.push(`styles:${styles.join(',')}`);
    if (spanishName.trim()) parts.push(`es:${spanishName.trim()}`);
    return parts.length ? parts.join(' · ') : undefined;
  };

  const finishPatch = async (id: string | undefined, attachPhoto: boolean) => {
    if (!id) return;
    const patch: { department?: string; notes?: string; photoDataUrl?: string } = {};
    if (deptDraft.trim()) patch.department = deptDraft.trim();
    const note = seatingNote();
    if (note) patch.notes = note;
    if (attachPhoto && refImage?.photoDataUrl) patch.photoDataUrl = refImage.photoDataUrl;
    if (!Object.keys(patch).length) return;
    const reply = await api.inventoryUpdate(id, patch);
    if (!reply.ok) onError(reply.reason ?? 'Could not save shape details');
  };

  const closeManualOutline = (points: Point[]) => {
    if (points.length < 3) {
      onError('Click at least three corners, then close near the first');
      return;
    }
    const room = roomFromPolygon(points, 'Shape');
    if (room.walls.length < 3) {
      onError('That outline could not be closed');
      return;
    }
    setDraft(room);
    setHistory([]);
    setManualPoints([]);
    setHoverPoint(null);
    seedPatchBeside(room);
    onStatus(`Manual outline closed · ${room.walls.length} sides`);
  };

  const onManualPointer = (raw: Point, shiftKey: boolean) => {
    if (!tracingOpen) return;
    if (!(width && width > 0) || !(depth && depth > 0)) {
      onError('Enter the real width and depth first. The photo is scaled to that size');
      return;
    }
    const last = manualPoints[manualPoints.length - 1];
    const point = last ? constrainRoomCorner(last, raw, angleLock, shiftKey) : raw;
    const closeDist = Math.max(worldW, worldH) * 0.03;
    if (manualPoints.length >= 3) {
      const first = manualPoints[0];
      if (Math.hypot(point.x - first.x, point.y - first.y) <= closeDist) {
        closeManualOutline(manualPoints);
        return;
      }
    }
    setManualPoints((prev) => [...prev, point]);
  };

  const onManualHover = (raw: Point | null, shiftKey: boolean) => {
    if (!tracingOpen || !raw) {
      setHoverPoint(null);
      return;
    }
    const last = manualPoints[manualPoints.length - 1];
    setHoverPoint(last ? constrainRoomCorner(last, raw, angleLock, shiftKey) : raw);
  };

  const applyMerge = () => {
    if (!draft) return;
    if (!canReshape) {
      onError('Add / cut needs a rectangular outline. Pick rectangle, L, or U, or reset after curves.');
      return;
    }
    if (patchX == null || patchY == null || !(patchW && patchW > 0) || !(patchD && patchD > 0)) {
      onError('Enter a patch position and size');
      return;
    }
    const next = combineRooms(draft, rectRoom(patchX, patchY, patchW, patchD, 'patch'), reshapeOp);
    if (!next.ok || !next.room) {
      onError(next.reason ?? 'That merge could not be applied');
      return;
    }
    setHistory((prev) => [...prev, draft]);
    setDraft(next.room);
    seedPatchBeside(next.room);
    onStatus(reshapeOp === 'union' ? 'Area added to outline' : 'Cut applied to outline');
  };

  const undoMerge = () => {
    setHistory((prev) => {
      if (!prev.length) return prev;
      const prior = prev[prev.length - 1];
      setDraft(prior);
      seedPatchBeside(prior);
      return prev.slice(0, -1);
    });
  };

  const finishOutline = async () => {
    if (!name.trim()) {
      onError('A shape needs a name');
      return;
    }
    if (tracingOpen && manualPoints.length > 0) {
      onError('Close the outline first. Click near the first corner, or Close outline');
      return;
    }
    if (!draft) {
      onError(buildMode === 'manual' ? 'Trace the outline on the photo first' : 'Build an outline first');
      return;
    }
    const traced = roomToTracedPaths(draft);
    if (!traced || traced.paths.length === 0 || traced.paths[0].points.length < 6) {
      onError('That outline is not closed yet');
      return;
    }
    setBusy(true);
    try {
      const labeled = spanishName.trim() ? `${name.trim()} / ${spanishName.trim()}` : name.trim();
      const reply = await api.inventoryAddTraced({
        name: labeled,
        width: traced.width,
        height: traced.height,
        paths: traced.paths,
        category,
        notes: seatingNote(),
        department: deptDraft.trim() || undefined,
      });
      if (!reply.ok) {
        onError(reply.reason ?? 'could not create the shape');
        return;
      }
      if (reply.id && refImage) await finishPatch(reply.id, true);

      const elevationNames: string[] = [];
      if (createElevationViews && !seed?.elevationView) {
        const elevH = 48 * UNITS_PER_INCH;
        for (const [suffix, across] of [
          ['(FV)', traced.width] as const,
          ['(SV)', traced.height] as const,
        ]) {
          const elevName = `${name.trim()} ${suffix}`;
          const elev = await api.inventoryAddTraced({
            name: elevName,
            width: across,
            height: elevH,
            paths: rectStubPaths(across, elevH),
            category,
            notes: `Elevation stub · ${suffix === '(FV)' ? 'front' : 'side'} of ${name.trim()} — redraw in Shape Editor for a real silhouette`,
            department: deptDraft.trim() || undefined,
          });
          if (elev.ok) elevationNames.push(elevName);
        }
      }

      onStatus(
        traced.droppedHoles > 0
          ? `Created “${labeled}” · interior cuts are not drawn on inventory icons yet`
          : elevationNames.length
            ? `Created “${labeled}” + ${elevationNames.join(' · ')}`
            : seed?.elevationView
              ? `Created elevation “${labeled}”`
              : allowChairs && defaultChairs > 0
                ? `Created “${labeled}” · default ${defaultChairs} chairs`
                : `Created “${labeled}”`,
      );
      if (reply.id) onCreated(reply.id, labeled);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const onUploadImage = async (file: File | undefined) => {
    if (!file) return;
    try {
      const loaded = await loadRefImage(file);
      setRefImage(loaded);
      enterManualMode();
      if (!name.trim()) setName(file.name.replace(/\.[^.]+$/, ''));
      onStatus('Image loaded: set real size, then click each corner on the photo');
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  const needsNotch = outlineBase === 'l-shape' || outlineBase === 'u-shape';

  return (
    <>
      <div className="sheet-backdrop" role="presentation" onClick={onClose}>
        <div
          className="sheet shape-wizard-sheet"
          role="dialog"
          aria-modal="true"
          aria-label="Shape Editor Wizard"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="sheet-title">
            <h2>
              {seed?.elevationView
                ? `Elevation · ${seed.elevationView === 'front' ? 'Front (FV)' : 'Side (SV)'}`
                : `Shape Editor · Step ${step + 1} of 3`}
            </h2>
            <button type="button" className="btn-outline" onClick={onClose}>
              Close
            </button>
          </div>
          <div className="sheet-body">
            {step === 0 && (
              <>
                {seed?.elevationView ? (
                  <p className="hint">
                    Drawing the {seed.elevationView === 'front' ? 'front' : 'side'} silhouette for{' '}
                    <strong>{seed.baseName}</strong>. Width is across the face; height is above
                    floor. Place filters this into Front/Side view.
                  </p>
                ) : null}
                <div className="field">
                  <label htmlFor="shape-cat">Category</label>
                  <select
                    id="shape-cat"
                    value={category}
                    onChange={(e) => setCategory(e.target.value as Category)}
                    disabled={!!seed?.elevationView}
                  >
                    {categories.map((c) => (
                      <option key={c} value={c}>
                        {CATEGORY_LABELS[c]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="shape-name">Name</label>
                  <input
                    id="shape-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Required"
                    required
                    readOnly={!!seed?.elevationView}
                  />
                </div>
                {!seed?.elevationView && (
                  <>
                    <div className="field">
                      <label htmlFor="shape-es">Spanish name (optional)</label>
                      <input id="shape-es" value={spanishName} onChange={(e) => setSpanishName(e.target.value)} />
                    </div>
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={createElevationViews}
                        onChange={(e) => setCreateElevationViews(e.target.checked)}
                      />
                      <span>
                        Also create Front (FV) and Side (SV) stub rectangles — redraw each later for a
                        real elevation silhouette
                      </span>
                    </label>
                  </>
                )}
                <div className="field">
                  <label htmlFor="shape-dept">Inventory department</label>
                  <input
                    id="shape-dept"
                    value={deptDraft}
                    onChange={(e) => setDeptDraft(e.target.value)}
                    placeholder="e.g. Banquet · Tables"
                  />
                </div>
                <p className="hint">Departments group items in the inventory palette (category maintenance).</p>
              </>
            )}

            {step === 1 && (
              <>
                <div className="field">
                  <label>Table type</label>
                  <div className="seg tabs seat-kinds" role="radiogroup">
                    {(
                      [
                        ['other', 'Other'],
                        ['round', 'Round'],
                        ['rectangular', 'Rectangular'],
                      ] as const
                    ).map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        className={tableKind === id ? 'active' : ''}
                        onClick={() => {
                          setTableKind(id);
                          if (id === 'round') setCategory('table-round');
                          if (id === 'rectangular') setCategory('table-rect');
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <label className="check">
                  <input type="checkbox" checked={allowChairs} onChange={(e) => setAllowChairs(e.target.checked)} />
                  Allow chairs
                </label>
                <div className="field">
                  <label htmlFor="shape-chairs">Default chair count</label>
                  <input
                    id="shape-chairs"
                    type="number"
                    min={0}
                    max={24}
                    value={defaultChairs}
                    disabled={!allowChairs}
                    onChange={(e) => setDefaultChairs(Math.max(0, Number(e.target.value) || 0))}
                  />
                </div>
                <fieldset className="erd-styles">
                  <legend>Seating styles (auto-place)</legend>
                  {SEATING_STYLES.map((id) => (
                    <label key={id} className="check">
                      <input
                        type="checkbox"
                        checked={styles.includes(id)}
                        disabled={!TABLE_CATEGORIES.includes(category) && tableKind === 'other'}
                        onChange={(e) => {
                          setStyles((prev) =>
                            e.target.checked ? [...prev, id] : prev.filter((s) => s !== id),
                          );
                        }}
                      />
                      {id}
                    </label>
                  ))}
                </fieldset>
                <p className="hint">Chair count and styles are stored on the inventory item notes for later seating.</p>
              </>
            )}

            {step === 2 && (
              <div className="shape-wizard-outline">
                <div className="shape-wizard-outline-controls">
                  <div className="section-title">
                    <span>How to build</span>
                  </div>
                  <div className="seg tabs seat-kinds" role="tablist" aria-label="Outline build mode">
                    <button
                      type="button"
                      className={buildMode === 'preset' ? 'active' : ''}
                      onClick={enterPresetMode}
                    >
                      Shape presets
                    </button>
                    <button
                      type="button"
                      className={buildMode === 'manual' ? 'active' : ''}
                      onClick={enterManualMode}
                    >
                      Trace photo
                    </button>
                  </div>

                  <div className="shape-wizard-upload">
                    <input
                      ref={fileRef}
                      type="file"
                      accept="image/*"
                      hidden
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = '';
                        void onUploadImage(file);
                      }}
                    />
                    <button type="button" className="btn-outline" onClick={() => fileRef.current?.click()}>
                      {refImage ? 'Replace image…' : 'Upload image…'}
                    </button>
                    {refImage && (
                      <button
                        type="button"
                        className="btn-outline"
                        onClick={() => {
                          setRefImage(null);
                          if (buildMode === 'manual' && !draft) clearManualTrace();
                        }}
                      >
                        Remove image
                      </button>
                    )}
                    {refImage && <small className="hint">{refImage.name}</small>}
                  </div>
                  <p className="hint">
                    Upload a top-down photo or datasheet drawing, set the real size, then click corners on the
                    image — or use auto-trace.
                  </p>

                  <div className="field-row">
                    <div className="field">
                      <label htmlFor="shape-w">
                        {seed?.elevationView
                          ? 'Across face'
                          : buildMode === 'manual'
                            ? 'Real width'
                            : outlineBase === 'circle'
                              ? 'Diameter / width'
                              : 'Width'}
                      </label>
                      <input id="shape-w" value={widthText} onChange={(e) => setWidthText(e.target.value)} />
                    </div>
                    <div className="field">
                      <label htmlFor="shape-d">{seed?.elevationView ? 'Height (AFF to top)' : 'Real depth'}</label>
                      <input id="shape-d" value={depthText} onChange={(e) => setDepthText(e.target.value)} />
                    </div>
                  </div>

                  {buildMode === 'manual' ? (
                    <>
                      <div className="section-title" style={{ marginTop: 8 }}>
                        <span>Manual trace</span>
                      </div>
                      <div className="seg tabs seat-kinds" role="radiogroup" aria-label="Angle lock">
                        {ANGLE_LOCKS.map((lock) => (
                          <button
                            key={lock.id}
                            type="button"
                            className={angleLock === lock.id ? 'active' : ''}
                            onClick={() => setAngleLock(lock.id)}
                          >
                            {lock.label}
                          </button>
                        ))}
                      </div>
                      <p className="hint">
                        {tracingOpen
                          ? refImage
                            ? `Click corners on the photo (${manualPoints.length} so far). Close near the first corner.`
                            : 'Upload an image, or click freely in the size box to draw corners.'
                          : 'Outline closed: add/cut below if it is rectangular, or retrace.'}
                      </p>
                      <div className="actions-row">
                        <button
                          type="button"
                          className="btn-outline"
                          disabled={manualPoints.length === 0}
                          onClick={() => {
                            setManualPoints((prev) => prev.slice(0, -1));
                            setHoverPoint(null);
                          }}
                        >
                          Undo point
                        </button>
                        <button
                          type="button"
                          className="btn-outline"
                          disabled={manualPoints.length < 3}
                          onClick={() => closeManualOutline(manualPoints)}
                        >
                          Close outline
                        </button>
                        <button
                          type="button"
                          className="btn-outline"
                          onClick={() => {
                            clearManualTrace();
                            onStatus('Trace cleared: click corners again');
                          }}
                        >
                          Retrace
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="section-title" style={{ marginTop: 8 }}>
                        <span>Base outline</span>
                      </div>
                      <div className="shape-wizard-bases" role="radiogroup" aria-label="Base outline">
                        {OUTLINE_BASES.map((base) => (
                          <button
                            key={base.id}
                            type="button"
                            className={outlineBase === base.id ? 'is-on' : ''}
                            aria-pressed={outlineBase === base.id}
                            onClick={() => {
                              outlineTouchedRef.current = true;
                              setOutlineBase(base.id);
                              setHistory([]);
                            }}
                          >
                            <ShapeIcon kind={base.icon} />
                            <span>
                              <strong>{base.label}</strong>
                              <small>{base.detail}</small>
                            </span>
                          </button>
                        ))}
                      </div>
                      {needsNotch && (
                        <div className="field-row">
                          <div className="field">
                            <label htmlFor="shape-notch-w">Recess width</label>
                            <input
                              id="shape-notch-w"
                              value={notchWText}
                              onChange={(e) => setNotchWText(e.target.value)}
                            />
                          </div>
                          <div className="field">
                            <label htmlFor="shape-notch-d">Recess depth</label>
                            <input
                              id="shape-notch-d"
                              value={notchDText}
                              onChange={(e) => setNotchDText(e.target.value)}
                            />
                          </div>
                        </div>
                      )}
                    </>
                  )}

                  <div className="section-title" style={{ marginTop: 14 }}>
                    <span>Add / cut</span>
                    <IconPlus size={14} />
                  </div>
                  <p className="hint">
                    {canReshape
                      ? 'Merge a rectangular bay into the outline, or cut an opening out. Same as the room builder.'
                      : tracingOpen
                        ? 'Close the manual outline first, then add or cut if it is rectangular.'
                        : 'Add / cut needs a rectangular (axis-aligned) outline.'}
                  </p>
                  <div className="seg tabs seat-kinds" role="tablist" aria-label="Merge operation">
                    <button
                      type="button"
                      className={reshapeOp === 'union' ? 'active' : ''}
                      onClick={() => setReshapeOp('union')}
                      disabled={!canReshape}
                    >
                      Add area
                    </button>
                    <button
                      type="button"
                      className={reshapeOp === 'difference' ? 'active' : ''}
                      onClick={() => setReshapeOp('difference')}
                      disabled={!canReshape}
                    >
                      Cut out
                    </button>
                  </div>
                  <div className="field-row">
                    <div className="field">
                      <label htmlFor="shape-px">X</label>
                      <input
                        id="shape-px"
                        value={patchXText}
                        onChange={(e) => setPatchXText(e.target.value)}
                        disabled={!canReshape}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="shape-py">Y</label>
                      <input
                        id="shape-py"
                        value={patchYText}
                        onChange={(e) => setPatchYText(e.target.value)}
                        disabled={!canReshape}
                      />
                    </div>
                  </div>
                  <div className="field-row">
                    <div className="field">
                      <label htmlFor="shape-pw">Width</label>
                      <input
                        id="shape-pw"
                        value={patchWText}
                        onChange={(e) => setPatchWText(e.target.value)}
                        disabled={!canReshape}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="shape-pd">Depth</label>
                      <input
                        id="shape-pd"
                        value={patchDText}
                        onChange={(e) => setPatchDText(e.target.value)}
                        disabled={!canReshape}
                      />
                    </div>
                  </div>
                  <div className="actions-row">
                    <button type="button" className="btn-outline" disabled={!canReshape} onClick={applyMerge}>
                      {reshapeOp === 'union' ? 'Add to outline' : 'Cut from outline'}
                    </button>
                    <button type="button" className="btn-outline" disabled={history.length === 0} onClick={undoMerge}>
                      Undo merge
                    </button>
                    {buildMode === 'preset' && (
                      <button
                        type="button"
                        className="btn-outline"
                        onClick={() => {
                          setHistory([]);
                          resetOutline(outlineBase);
                        }}
                      >
                        Reset base
                      </button>
                    )}
                  </div>
                </div>

                <aside className="shape-wizard-preview-panel">
                  <div className="shape-wizard-preview-heading">
                    <b>{tracingOpen ? 'Trace on photo' : 'Live outline'}</b>
                    <span>
                      {draft
                        ? `${formatArea(roomArea(draft), units)} · ${draft.walls.length} sides${
                            draft.holes.length ? ` · ${draft.holes.length} cut` : ''
                          }${history.length ? ` · ${history.length} merge${history.length === 1 ? '' : 's'}` : ''}`
                        : tracingOpen
                          ? `${manualPoints.length} corner${manualPoints.length === 1 ? '' : 's'} · click to add`
                          : 'Enter a width and depth'}
                    </span>
                  </div>
                  <div className={`shape-wizard-preview-stage${tracingOpen ? ' is-tracing' : ''}`}>
                    <ShapeOutlineStage
                      room={draft}
                      patch={patchPreview}
                      refImage={refImage}
                      worldW={worldW}
                      worldH={worldH}
                      manualPoints={manualPoints}
                      hover={hoverPoint}
                      interactive={tracingOpen}
                      editableCorners={editingCorners}
                      onPointerWorld={onManualPointer}
                      onHoverWorld={onManualHover}
                      onCornerDrag={onCornerDrag}
                      onCornerDragStart={onCornerDragStart}
                    />
                  </div>
                  <div className="actions-row">
                    <button type="button" className="btn-outline" onClick={() => setTraceOpen(true)}>
                      Auto-trace…
                    </button>
                    {editingCorners && (
                      <button
                        type="button"
                        className="btn-outline"
                        disabled={history.length === 0}
                        onClick={undoMerge}
                      >
                        Undo edit
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn-solid"
                      disabled={busy || !draft}
                      onClick={() => void finishOutline()}
                    >
                      Create shape
                    </button>
                  </div>
                  {editingCorners && (
                    <p className="hint" style={{ margin: 0 }}>
                      Drag corners on the preview to refine the auto-trace. Photo stays underneath for reference.
                    </p>
                  )}
                </aside>
              </div>
            )}

            <div className="actions-row" style={{ marginTop: 12 }}>
              <button
                type="button"
                className="btn-outline"
                disabled={step === 0}
                onClick={() => setStep((s) => (s === 2 && seed?.elevationView ? 0 : s - 1))}
              >
                Back
              </button>
              {step < 2 && (
                <button
                  type="button"
                  className="btn-solid"
                  disabled={step === 0 && !name.trim()}
                  onClick={() => setStep((s) => (s === 0 && seed?.elevationView ? 2 : s + 1))}
                >
                  Next
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {traceOpen && (
        <TraceDialog
          units={units}
          initialName={name}
          initialWidth={widthText}
          initialDepth={depthText}
          initialImage={refImage?.imageData ?? null}
          initialFileName={refImage?.name ?? ''}
          onClose={() => setTraceOpen(false)}
          onOutline={(result) => {
            const room = tracedResultToRoom(result);
            if (!room) {
              onError('That auto-trace did not produce a usable outline');
              return;
            }
            setBuildMode('manual');
            setManualPoints([]);
            setHoverPoint(null);
            setHistory([]);
            setDraft(room);
            setWidthText(formatLength(result.width, units));
            setDepthText(formatLength(result.height, units));
            seedPatchBeside(room);
            onStatus(
              result.points > 24
                ? `Auto-trace applied · ${room.walls.length} corners: drag points to refine, or Auto-trace again with Fewer corners`
                : `Auto-trace applied · ${room.walls.length} corners: drag points to refine`,
            );
          }}
          onError={onError}
        />
      )}
    </>
  );
}
