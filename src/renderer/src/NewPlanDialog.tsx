/**
 * New Plan is room-first: pick a shape (or venue preset), then land on the plan.
 * Show details (venue / event / date) belong in Show setup after the room exists.
 * The same pure builder powers this preview and the main process write path.
 */

import { useEffect, useMemo, useState } from 'react';

import {
  buildNewRoom,
  type NewRoomCurveMethod,
  type NewRoomShape,
  type NewRoomSpec,
} from '../../format/new-room.js';
import {
  flattenWall,
  roomArea,
  roomBounds,
  roomPerimeter,
  type RoomModel,
} from '../../format/room.js';
import { formatArea, formatLength, parseLength, type UnitSystem } from '../../format/units.js';
import { IconDrawEllipse, IconDrawPolygon, IconDrawRect, IconPlus, IconRuler } from './icons.js';
import type { CustomRoomAngleLock, CustomRoomPrefs } from './custom-room.js';

const api = window.groundplan;

interface Preset {
  label: string;
  /** In feet, as the presets are stated. */
  width: number;
  depth: number;
}

interface Props {
  units: UnitSystem;
  onCreated: (
    doc: unknown,
    options: { startRoomOutline: boolean; customRoom?: CustomRoomPrefs },
  ) => void;
  onCancel: () => void;
  onError: (message: string) => void;
}

const FT = 120;

type RoomChoice = NewRoomShape | 'custom';
type WallTreatment = 'straight' | 'curve';

/** One-click common rooms — boardroom (~20) through concert floor. */
const QUICK_START: Array<{
  id: string;
  label: string;
  detail: string;
  width?: number;
  depth?: number;
  custom?: boolean;
}> = [
  { id: 'boardroom', label: 'Boardroom', detail: "20' × 16' · ~20", width: 20, depth: 16 },
  { id: 'meeting', label: 'Meeting', detail: "30' × 20'", width: 30, depth: 20 },
  { id: 'ballroom', label: 'Ballroom', detail: "60' × 40'", width: 60, depth: 40 },
  { id: 'concert', label: 'Concert floor', detail: "200' × 120'", width: 200, depth: 120 },
  { id: 'custom', label: 'Draw custom', detail: 'Trace next', custom: true },
];

const SHAPES: Array<{
  id: RoomChoice;
  label: string;
  detail: string;
  icon: 'rect' | 'ellipse' | 'polygon';
  advanced?: boolean;
}> = [
  { id: 'rectangle', label: 'Rectangle', detail: 'Exact width × depth', icon: 'rect' },
  { id: 'circle', label: 'Circle', detail: 'Exact curved boundary', icon: 'ellipse' },
  { id: 'custom', label: 'Draw custom', detail: 'Trace any outline next', icon: 'polygon' },
  { id: 'rounded', label: 'Rounded', detail: 'True-radius corners', icon: 'rect', advanced: true },
  { id: 'stadium', label: 'Stadium', detail: 'Two semicircular ends', icon: 'ellipse', advanced: true },
  { id: 'l-shape', label: 'L-shaped', detail: 'One recessed corner', icon: 'polygon', advanced: true },
  { id: 'u-shape', label: 'U-shaped', detail: 'Centred floor recess', icon: 'polygon', advanced: true },
];

const PRIMARY_SHAPES = SHAPES.filter((shape) => !shape.advanced);
const ADVANCED_SHAPES = SHAPES.filter((shape) => shape.advanced);

const CURVE_METHODS: Array<{ id: NewRoomCurveMethod; label: string; short: string; help: string }> = [
  { id: 'radius', label: 'Radius', short: 'Radius', help: 'Arc radius that meets both ends of the wall.' },
  { id: 'sagitta', label: 'Bow depth', short: 'Bow', help: 'How far the wall bows off the straight chord.' },
  { id: 'angle', label: 'Included angle', short: 'Angle', help: 'Degrees of turn — 90° is a quarter round.' },
  { id: 'arc-length', label: 'Arc length', short: 'Arc', help: 'Finished length along the curve (must exceed the chord).' },
];

const RECT_WALL_LABELS = ['Top', 'Right', 'Bottom', 'Left'] as const;

const ANGLE_LOCKS: Array<{ id: CustomRoomAngleLock; label: string; detail: string }> = [
  { id: 'free', label: 'Free', detail: 'Any angle' },
  { id: 'ortho', label: 'Ortho', detail: '90° walls' },
  { id: '45', label: '45°', detail: 'Octagonal snap' },
];

const IconForShape = ({ kind }: { kind: (typeof SHAPES)[number]['icon'] }) =>
  kind === 'ellipse' ? <IconDrawEllipse size={19} /> : kind === 'polygon' ? <IconDrawPolygon size={19} /> : <IconDrawRect size={19} />;

function CustomRoomPreview({
  width,
  depth,
  angleLock,
  showGuide,
}: {
  width: number;
  depth: number;
  angleLock: CustomRoomAngleLock;
  showGuide: boolean;
}) {
  const w = Math.max(1, width);
  const d = Math.max(1, depth);
  const pad = Math.max(w, d) * 0.16;
  const viewBox = `${-w / 2 - pad} ${-d / 2 - pad} ${w + pad * 2} ${d + pad * 2}`;
  // Illustrative irregular footprint inside the working bounds.
  const sample = [
    { x: -w * 0.42, y: -d * 0.38 },
    { x: w * 0.28, y: -d * 0.42 },
    { x: w * 0.44, y: d * 0.05 },
    { x: w * 0.18, y: d * 0.4 },
    { x: -w * 0.36, y: d * 0.34 },
  ];
  const samplePath = sample.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ') + ' Z';

  return (
    <svg className="new-plan-preview-svg" viewBox={viewBox} role="img" aria-label="Custom room drawing preview">
      {showGuide && (
        <rect
          className="new-plan-preview-guide"
          x={-w / 2}
          y={-d / 2}
          width={w}
          height={d}
          vectorEffect="non-scaling-stroke"
        />
      )}
      <path className="new-plan-preview-fill" d={samplePath} />
      <path className="new-plan-preview-wall is-sample" d={samplePath} fill="none" vectorEffect="non-scaling-stroke" />
      {sample.map((point, index) => (
        <circle
          key={index}
          className={index === 0 ? 'new-plan-preview-corner is-start' : 'new-plan-preview-corner'}
          cx={point.x}
          cy={point.y}
          r={Math.max(w, d) * 0.014}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      <text className="new-plan-preview-lock-label" x={0} y={d / 2 + pad * 0.55} textAnchor="middle">
        {angleLock === 'free' ? 'Free angles' : angleLock === 'ortho' ? 'Orthogonal walls' : '45° snap'}
      </text>
    </svg>
  );
}

function RoomPreview({
  room,
  highlightedWall,
  onSelectWall,
}: {
  room: RoomModel;
  highlightedWall: number | null;
  onSelectWall?: (index: number) => void;
}) {
  const bounds = roomBounds(room);
  if (!bounds) return null;
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const pad = Math.max(width, height) * 0.13;
  const tolerance = Math.max(width, height) / 180;
  const viewBox = `${bounds.minX - pad} ${bounds.minY - pad} ${width + pad * 2} ${height + pad * 2}`;

  return (
    <svg className="new-plan-preview-svg" viewBox={viewBox} role="img" aria-label="Room geometry preview">
      <path
        className="new-plan-preview-fill"
        d={room.walls
          .flatMap((segment, index) => {
            const points = flattenWall(segment, tolerance);
            return points.map((point, pointIndex) => `${index === 0 && pointIndex === 0 ? 'M' : 'L'} ${point.x} ${point.y}`);
          })
          .join(' ') + ' Z'}
      />
      {room.walls.map((segment, index) => (
        <polyline
          key={`${index}-${segment.start.x}-${segment.start.y}`}
          className={index === highlightedWall ? 'new-plan-preview-wall is-highlighted' : 'new-plan-preview-wall'}
          points={flattenWall(segment, tolerance).map((point) => `${point.x},${point.y}`).join(' ')}
          vectorEffect="non-scaling-stroke"
          role={onSelectWall ? 'button' : undefined}
          tabIndex={onSelectWall ? 0 : undefined}
          style={onSelectWall ? { cursor: 'pointer' } : undefined}
          onClick={onSelectWall ? () => onSelectWall(index) : undefined}
          onKeyDown={
            onSelectWall
              ? (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelectWall(index);
                  }
                }
              : undefined
          }
        />
      ))}
      {room.walls.map((segment, index) => (
        <circle
          key={`corner-${index}`}
          className="new-plan-preview-corner"
          cx={segment.start.x}
          cy={segment.start.y}
          r={Math.max(width, height) * 0.012}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}

export default function NewPlanDialog({ units, onCreated, onCancel, onError }: Props) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [name, setName] = useState('Untitled plan');
  const [nameOpen, setNameOpen] = useState(false);

  const [shape, setShape] = useState<RoomChoice>('rectangle');
  const [width, setWidth] = useState(() => formatLength(60 * FT, units));
  const [depth, setDepth] = useState(() => formatLength(40 * FT, units));
  const [diameter, setDiameter] = useState(() => formatLength(50 * FT, units));
  const [cornerRadius, setCornerRadius] = useState(() => formatLength(4 * FT, units));
  const [notchWidth, setNotchWidth] = useState(() => formatLength(20 * FT, units));
  const [notchDepth, setNotchDepth] = useState(() => formatLength(15 * FT, units));
  const [wallTreatment, setWallTreatment] = useState<WallTreatment>('straight');
  const [curveWall, setCurveWall] = useState(0);
  const [curveMethod, setCurveMethod] = useState<NewRoomCurveMethod>('radius');
  const [curveValues, setCurveValues] = useState<Record<NewRoomCurveMethod, string>>({
    radius: formatLength(40 * FT, units),
    sagitta: formatLength(5 * FT, units),
    angle: '90',
    'arc-length': formatLength(70 * FT, units),
  });
  const [curveOutward, setCurveOutward] = useState(true);
  const [curveMajor, setCurveMajor] = useState(false);
  const [autoDimensions, setAutoDimensions] = useState(true);
  const [customAngleLock, setCustomAngleLock] = useState<CustomRoomAngleLock>('ortho');
  const [customShowGuide, setCustomShowGuide] = useState(true);
  const [customAutoDimensions, setCustomAutoDimensions] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [customOptionsOpen, setCustomOptionsOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.roomPresets().then(setPresets);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || busy) return;
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [busy, onCancel]);

  const parsed = {
    width: parseLength(width, units),
    depth: parseLength(depth, units),
    diameter: parseLength(diameter, units),
    cornerRadius: parseLength(cornerRadius, units),
    notchWidth: parseLength(notchWidth, units),
    notchDepth: parseLength(notchDepth, units),
  };
  const curveValue = curveMethod === 'angle'
    ? Number(curveValues.angle)
    : parseLength(curveValues[curveMethod], units);
  const planName = name.trim() || 'Untitled plan';
  const customRoom = shape === 'custom';
  const curveEligible = shape === 'rectangle' || shape === 'l-shape' || shape === 'u-shape';

  const baseSpec = useMemo<NewRoomSpec | null>(() => {
    if (shape === 'custom') return null;
    return {
      shape,
      width: parsed.width ?? undefined,
      depth: parsed.depth ?? undefined,
      diameter: parsed.diameter ?? undefined,
      cornerRadius: parsed.cornerRadius ?? undefined,
      notchWidth: parsed.notchWidth ?? undefined,
      notchDepth: parsed.notchDepth ?? undefined,
    };
  }, [shape, parsed.width, parsed.depth, parsed.diameter, parsed.cornerRadius, parsed.notchWidth, parsed.notchDepth]);

  const baseRoom = useMemo(
    () => baseSpec ? buildNewRoom(baseSpec, planName) : null,
    [baseSpec, planName],
  );
  const wallCount = baseRoom?.room?.walls.length ?? 0;
  const selectedWall = Math.min(curveWall, Math.max(0, wallCount - 1));

  const roomSpec = useMemo<NewRoomSpec | null>(() => {
    if (!baseSpec) return null;
    if (!curveEligible || wallTreatment !== 'curve') return baseSpec;
    return {
      ...baseSpec,
      curve: {
        wallIndex: selectedWall,
        method: curveMethod,
        value: curveValue ?? 0,
        outward: curveOutward,
        major: curveMethod === 'radius' && curveMajor,
      },
    };
  }, [baseSpec, curveEligible, wallTreatment, selectedWall, curveMethod, curveValue, curveOutward, curveMajor]);

  const preview = useMemo(
    () => roomSpec ? buildNewRoom(roomSpec, planName) : null,
    [roomSpec, planName],
  );
  const roomReady =
    customRoom
      ? Boolean((parsed.width ?? 0) > 0 && (parsed.depth ?? 0) > 0)
      : Boolean(preview?.ok && preview.room);
  const previewRoom = preview?.room ?? baseRoom?.room;
  const highlightedWall = curveEligible && wallTreatment === 'curve' ? selectedWall : null;
  const customGuideArea =
    customRoom && (parsed.width ?? 0) > 0 && (parsed.depth ?? 0) > 0
      ? (parsed.width! * parsed.depth!)
      : 0;
  const customGuidePerimeter =
    customRoom && (parsed.width ?? 0) > 0 && (parsed.depth ?? 0) > 0
      ? 2 * (parsed.width! + parsed.depth!)
      : 0;

  const choose = (preset: Preset) => {
    if (preset.width <= 0 || preset.depth <= 0) {
      setShape('custom');
      return;
    }
    setShape('rectangle');
    setWallTreatment('straight');
    setWidth(formatLength(preset.width * FT, units));
    setDepth(formatLength(preset.depth * FT, units));
  };

  const create = async (override?: {
    room?: NewRoomSpec;
    custom?: CustomRoomPrefs;
    name?: string;
  }) => {
    const usingCustom = override?.custom != null || (override?.room == null && customRoom);
    if (!override && !roomReady) return;
    setBusy(true);
    try {
      const customPrefs: CustomRoomPrefs | undefined = override?.custom
        ?? (
          usingCustom && (parsed.width ?? 0) > 0 && (parsed.depth ?? 0) > 0
            ? {
                guideWidth: parsed.width!,
                guideDepth: parsed.depth!,
                angleLock: customAngleLock,
                showGuide: customShowGuide,
                autoDimensions: customAutoDimensions,
              }
            : undefined
        );
      const reply = await api.newPlan({
        name: override?.name ?? planName,
        room: customPrefs ? undefined : override?.room ?? roomSpec ?? undefined,
        sheetSize: customPrefs
          ? { width: customPrefs.guideWidth, depth: customPrefs.guideDepth }
          : undefined,
        autoDimensions: !customPrefs && autoDimensions,
        autosave: true,
      });
      if (reply.cancelled) return;
      if (!reply.ok || !reply.doc) {
        onError(reply.reason ?? 'the plan could not be created');
        return;
      }
      onCreated(reply.doc, {
        startRoomOutline: Boolean(customPrefs),
        customRoom: customPrefs,
      });
    } finally {
      setBusy(false);
    }
  };

  const quickStart = (item: (typeof QUICK_START)[number]) => {
    if (item.custom) {
      // One click: empty sheet + outline tool, ortho guide at 60×40.
      void create({
        custom: {
          guideWidth: 60 * FT,
          guideDepth: 40 * FT,
          angleLock: 'ortho',
          showGuide: true,
          autoDimensions: true,
        },
      });
      return;
    }
    if (!(item.width && item.depth)) return;
    setShape('rectangle');
    setWallTreatment('straight');
    setWidth(formatLength(item.width * FT, units));
    setDepth(formatLength(item.depth * FT, units));
    // Keep the plan file name; venue archetype is not the document identity.
    void create({
      room: { shape: 'rectangle', width: item.width * FT, depth: item.depth * FT },
    });
  };

  const curveInputLabel = curveMethod === 'radius'
    ? 'Arc radius'
    : curveMethod === 'sagitta'
      ? 'Bow depth at centre'
      : curveMethod === 'angle'
        ? 'Included angle (degrees)'
        : 'Finished wall length';
  const selectedWallChord = (() => {
    const wall = baseRoom?.room?.walls[selectedWall];
    if (!wall) return 0;
    return Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
  })();
  const wallLabel = (index: number) =>
    shape === 'rectangle' ? RECT_WALL_LABELS[index] ?? `Wall ${index + 1}` : `Wall ${index + 1}`;
  const curveMethodMeta = CURVE_METHODS.find((method) => method.id === curveMethod);

  return (
    <div className="sheet-backdrop" role="presentation" onMouseDown={onCancel}>
      <div
        className="sheet new-plan-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-plan-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="new-plan-head">
          <div>
            <span className="new-plan-eyebrow">New plan</span>
            <h2 id="new-plan-title">Build the room</h2>
            <p>
              From a 20-person boardroom to a full concert floor — pick a size or shape. Show details come
              after the plan opens.
            </p>
          </div>
          <span className="new-plan-unit-badge">{units === 'metric' ? 'Metric' : 'Imperial'}</span>
        </div>

        <div className="new-plan-quick-start" role="group" aria-label="Common rooms">
          {QUICK_START.map((item) => (
            <button
              key={item.id}
              type="button"
              className={item.custom && customRoom ? 'is-on' : undefined}
              disabled={busy}
              onClick={() => quickStart(item)}
            >
              <strong>{item.label}</strong>
              <small>{item.detail}</small>
            </button>
          ))}
        </div>

        <div className="new-plan-body is-room-builder">
          <div className="new-plan-room-workspace">
              <div className="new-plan-room-controls">
                <section className="new-plan-builder-section">
                  <div className="new-plan-section-title">
                    <span>1</span>
                    <div><strong>Choose the boundary</strong><small>Or use a quick start above to skip this.</small></div>
                  </div>
                  <div className="new-plan-shape-grid is-primary" role="radiogroup" aria-label="Starting room shape">
                    {PRIMARY_SHAPES.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        role="radio"
                        aria-checked={shape === item.id}
                        className={shape === item.id ? 'active' : ''}
                        onClick={() => {
                          setShape(item.id);
                          if (item.id !== 'rectangle' && item.id !== 'l-shape' && item.id !== 'u-shape') setWallTreatment('straight');
                        }}
                      >
                        <IconForShape kind={item.icon} />
                        <span><strong>{item.label}</strong><small>{item.detail}</small></span>
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className={`new-plan-advanced-toggle${advancedOpen || ADVANCED_SHAPES.some((item) => item.id === shape) ? ' is-open' : ''}`}
                    aria-expanded={advancedOpen || ADVANCED_SHAPES.some((item) => item.id === shape)}
                    onClick={() => setAdvancedOpen((open) => !open)}
                  >
                    {advancedOpen || ADVANCED_SHAPES.some((item) => item.id === shape)
                      ? 'Hide more shapes & curves'
                      : 'More shapes & curves'}
                  </button>
                  {(advancedOpen || ADVANCED_SHAPES.some((item) => item.id === shape)) && (
                    <div className="new-plan-shape-grid is-advanced" role="radiogroup" aria-label="Advanced room shapes">
                      {ADVANCED_SHAPES.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          role="radio"
                          aria-checked={shape === item.id}
                          className={shape === item.id ? 'active' : ''}
                          onClick={() => {
                            setShape(item.id);
                            setAdvancedOpen(true);
                            if (item.id !== 'rectangle' && item.id !== 'l-shape' && item.id !== 'u-shape') setWallTreatment('straight');
                          }}
                        >
                          <IconForShape kind={item.icon} />
                          <span><strong>{item.label}</strong><small>{item.detail}</small></span>
                        </button>
                      ))}
                    </div>
                  )}
                </section>

                {customRoom ? (
                  <>
                    <section className="new-plan-builder-section">
                      <div className="new-plan-section-title">
                        <span>2</span>
                        <div>
                          <strong>Working size</strong>
                          <small>Sizes the empty sheet and the dashed guide you trace against.</small>
                        </div>
                      </div>
                      <div className="field-row">
                        <div className="field">
                          <label htmlFor="new-plan-custom-width">Guide width</label>
                          <input
                            id="new-plan-custom-width"
                            value={width}
                            aria-invalid={width.trim() !== '' && !((parsed.width ?? 0) > 0)}
                            onChange={(e) => setWidth(e.target.value)}
                          />
                        </div>
                        <div className="field">
                          <label htmlFor="new-plan-custom-depth">Guide depth</label>
                          <input
                            id="new-plan-custom-depth"
                            value={depth}
                            aria-invalid={depth.trim() !== '' && !((parsed.depth ?? 0) > 0)}
                            onChange={(e) => setDepth(e.target.value)}
                          />
                        </div>
                      </div>
                      <div className="field">
                        <label>Common footprints</label>
                        <div className="preset-grid is-compact">
                          {presets
                            .filter((preset) => preset.width > 0 && preset.depth > 0)
                            .map((preset) => {
                              const active =
                                Math.abs((parsed.width ?? 0) - preset.width * FT) < 1 &&
                                Math.abs((parsed.depth ?? 0) - preset.depth * FT) < 1;
                              return (
                                <button
                                  key={preset.label}
                                  type="button"
                                  className={active ? 'preset active' : 'preset'}
                                  onClick={() => {
                                    setWidth(formatLength(preset.width * FT, units));
                                    setDepth(formatLength(preset.depth * FT, units));
                                  }}
                                >
                                  {preset.label}
                                </button>
                              );
                            })}
                        </div>
                      </div>
                    </section>

                    <div className="new-plan-custom-guide" role="status">
                      <IconDrawPolygon size={22} />
                      <span>
                        <strong>Next: click corners on the plan</strong>
                        <small>
                          Click near the start or press Enter to finish · Esc cancels · Finish as rectangle stays available.
                        </small>
                      </span>
                    </div>

                    <button
                      type="button"
                      className={`new-plan-advanced-toggle${customOptionsOpen ? ' is-open' : ''}`}
                      aria-expanded={customOptionsOpen}
                      onClick={() => setCustomOptionsOpen((open) => !open)}
                    >
                      {customOptionsOpen ? 'Hide drawing options' : 'Drawing options'}
                    </button>
                    {customOptionsOpen && (
                      <>
                        <section className="new-plan-builder-section">
                          <div className="new-plan-section-title">
                            <span>3</span>
                            <div>
                              <strong>Corner constraints</strong>
                              <small>Each click locks relative to the previous corner. Hold Shift for a temporary 90°.</small>
                            </div>
                          </div>
                          <div className="seg tabs new-plan-angle-lock" role="radiogroup" aria-label="Corner angle lock">
                            {ANGLE_LOCKS.map((lock) => (
                              <button
                                key={lock.id}
                                type="button"
                                role="radio"
                                aria-checked={customAngleLock === lock.id}
                                className={customAngleLock === lock.id ? 'active' : ''}
                                onClick={() => setCustomAngleLock(lock.id)}
                                title={lock.detail}
                              >
                                <strong>{lock.label}</strong>
                                <small>{lock.detail}</small>
                              </button>
                            ))}
                          </div>
                          <label className="setting-check new-plan-custom-check">
                            <input
                              type="checkbox"
                              checked={customShowGuide}
                              onChange={(e) => setCustomShowGuide(e.target.checked)}
                            />
                            <span>
                              <strong>Show size guide on the plan</strong>
                              <small>Dashed {formatLength(parsed.width ?? 0, units)} × {formatLength(parsed.depth ?? 0, units)} rectangle while you draw.</small>
                            </span>
                          </label>
                        </section>

                        <section className="new-plan-builder-section">
                          <label className="new-plan-dimension-option">
                            <input
                              type="checkbox"
                              checked={customAutoDimensions}
                              onChange={(e) => setCustomAutoDimensions(e.target.checked)}
                            />
                            <IconRuler size={17} />
                            <span>
                              <strong>Dimension walls when finished</strong>
                              <small>Adds a length call-out on every wall after Enter / close.</small>
                            </span>
                          </label>
                        </section>
                      </>
                    )}
                  </>
                ) : (
                  <>
                    <section className="new-plan-builder-section">
                      <div className="new-plan-section-title">
                        <span>2</span>
                        <div><strong>Set the geometry</strong><small>Measurements accept feet/inches or metric entries.</small></div>
                      </div>

                      {shape === 'circle' ? (
                        <div className="field">
                          <label htmlFor="new-plan-diameter">Room diameter</label>
                          <input id="new-plan-diameter" value={diameter} aria-invalid={diameter.trim() !== '' && !((parsed.diameter ?? 0) > 0)} onChange={(e) => setDiameter(e.target.value)} />
                        </div>
                      ) : (
                        <div className="field-row">
                          <div className="field">
                            <label htmlFor="new-plan-width">Outside width</label>
                            <input id="new-plan-width" value={width} aria-invalid={width.trim() !== '' && !((parsed.width ?? 0) > 0)} onChange={(e) => setWidth(e.target.value)} />
                          </div>
                          <div className="field">
                            <label htmlFor="new-plan-depth">Outside depth</label>
                            <input id="new-plan-depth" value={depth} aria-invalid={depth.trim() !== '' && !((parsed.depth ?? 0) > 0)} onChange={(e) => setDepth(e.target.value)} />
                          </div>
                        </div>
                      )}

                      {shape === 'rounded' && (
                        <div className="field">
                          <label htmlFor="new-plan-corner-radius">Corner radius</label>
                          <input id="new-plan-corner-radius" value={cornerRadius} aria-invalid={cornerRadius.trim() !== '' && !((parsed.cornerRadius ?? 0) > 0)} onChange={(e) => setCornerRadius(e.target.value)} />
                          <span className="field-help">Creates tangent fillets with a true build radius—not a visual-only effect.</span>
                        </div>
                      )}

                      {(shape === 'l-shape' || shape === 'u-shape') && (
                        <div className="field-row">
                          <div className="field">
                            <label htmlFor="new-plan-notch-width">Recess width</label>
                            <input id="new-plan-notch-width" value={notchWidth} aria-invalid={notchWidth.trim() !== '' && !((parsed.notchWidth ?? 0) > 0)} onChange={(e) => setNotchWidth(e.target.value)} />
                          </div>
                          <div className="field">
                            <label htmlFor="new-plan-notch-depth">Recess depth</label>
                            <input id="new-plan-notch-depth" value={notchDepth} aria-invalid={notchDepth.trim() !== '' && !((parsed.notchDepth ?? 0) > 0)} onChange={(e) => setNotchDepth(e.target.value)} />
                          </div>
                        </div>
                      )}

                      {shape === 'rectangle' && (
                        <div className="field">
                          <label>Common room sizes</label>
                          <div className="preset-grid is-compact">
                            {presets.filter((preset) => preset.width > 0 && preset.depth > 0).map((preset) => {
                              const active = Math.abs((parsed.width ?? 0) - preset.width * FT) < 1 && Math.abs((parsed.depth ?? 0) - preset.depth * FT) < 1;
                              return <button key={preset.label} type="button" className={active ? 'preset active' : 'preset'} onClick={() => choose(preset)}>{preset.label}</button>;
                            })}
                          </div>
                        </div>
                      )}
                    </section>

                    {curveEligible && (advancedOpen || wallTreatment === 'curve') && (
                      <section className="new-plan-builder-section is-curve-section">
                        <div className="new-plan-section-title">
                          <span>3</span>
                          <div>
                            <strong>Curve a wall</strong>
                            <small>Exact circular arc — click a wall in the preview or pick one below.</small>
                          </div>
                        </div>
                        <div className="seg tabs new-plan-treatment" role="radiogroup" aria-label="Initial wall treatment">
                          <button type="button" className={wallTreatment === 'straight' ? 'active' : ''} onClick={() => setWallTreatment('straight')}>
                            Keep straight
                          </button>
                          <button type="button" className={wallTreatment === 'curve' ? 'active' : ''} onClick={() => setWallTreatment('curve')}>
                            Curve one wall
                          </button>
                        </div>

                        {wallTreatment === 'curve' && (
                          <div className="new-plan-curve-panel">
                            <div className="field">
                              <label>Wall</label>
                              <div className="new-plan-wall-chips" role="radiogroup" aria-label="Wall to curve">
                                {Array.from({ length: wallCount }, (_, index) => (
                                  <button
                                    key={index}
                                    type="button"
                                    role="radio"
                                    aria-checked={selectedWall === index}
                                    className={selectedWall === index ? 'is-on' : ''}
                                    onClick={() => setCurveWall(index)}
                                  >
                                    {wallLabel(index)}
                                  </button>
                                ))}
                              </div>
                              {selectedWallChord > 0 && (
                                <span className="field-help">
                                  Chord {formatLength(selectedWallChord, units)}
                                </span>
                              )}
                            </div>

                            <div className="field">
                              <label>Define by</label>
                              <div className="seg tabs new-plan-curve-methods" role="radiogroup" aria-label="Define curve by">
                                {CURVE_METHODS.map((method) => (
                                  <button
                                    key={method.id}
                                    type="button"
                                    className={curveMethod === method.id ? 'active' : ''}
                                    onClick={() => setCurveMethod(method.id)}
                                    title={method.help}
                                  >
                                    {method.short}
                                  </button>
                                ))}
                              </div>
                              {curveMethodMeta && <span className="field-help">{curveMethodMeta.help}</span>}
                            </div>

                            <div className="field new-plan-curve-value">
                              <label htmlFor="new-plan-curve-value">{curveInputLabel}</label>
                              <input
                                id="new-plan-curve-value"
                                value={curveValues[curveMethod]}
                                aria-invalid={curveValues[curveMethod].trim() !== '' && !((curveValue ?? 0) > 0)}
                                onChange={(e) => setCurveValues((current) => ({ ...current, [curveMethod]: e.target.value }))}
                              />
                              {curveMethod === 'radius' && selectedWallChord > 0 && (
                                <div className="new-plan-curve-presets" role="group" aria-label="Radius presets">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setCurveValues((current) => ({
                                        ...current,
                                        radius: formatLength(selectedWallChord / 2, units),
                                      }))
                                    }
                                  >
                                    ½ chord
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setCurveValues((current) => ({
                                        ...current,
                                        radius: formatLength(selectedWallChord, units),
                                      }))
                                    }
                                  >
                                    = chord
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setCurveValues((current) => ({
                                        ...current,
                                        radius: formatLength(selectedWallChord * 1.5, units),
                                      }))
                                    }
                                  >
                                    1.5×
                                  </button>
                                </div>
                              )}
                            </div>

                            <div className="field">
                              <label>Direction</label>
                              <div className="seg tabs new-plan-curve-direction" role="radiogroup" aria-label="Curve direction">
                                <button type="button" className={curveOutward ? 'active' : ''} onClick={() => setCurveOutward(true)}>
                                  <strong>Out of room</strong>
                                  <small>Bay / bulge</small>
                                </button>
                                <button type="button" className={!curveOutward ? 'active' : ''} onClick={() => setCurveOutward(false)}>
                                  <strong>Into room</strong>
                                  <small>Gains floor</small>
                                </button>
                              </div>
                            </div>

                            {curveMethod === 'radius' && (
                              <div className="field">
                                <label>Arc path</label>
                                <div className="seg tabs new-plan-curve-arc" role="radiogroup" aria-label="Minor or major arc">
                                  <button type="button" className={!curveMajor ? 'active' : ''} onClick={() => setCurveMajor(false)}>
                                    Short way
                                  </button>
                                  <button type="button" className={curveMajor ? 'active' : ''} onClick={() => setCurveMajor(true)}>
                                    Long way
                                  </button>
                                </div>
                              </div>
                            )}

                            <p className="hint new-plan-curve-summary" role="status">
                              {wallLabel(selectedWall)} · {curveMethodMeta?.label.toLowerCase() ?? 'curve'}{' '}
                              {curveValues[curveMethod] || '…'} · {curveOutward ? 'outward' : 'inward'}
                              {curveMethod === 'radius' && curveMajor ? ' · long way' : ''}
                            </p>
                          </div>
                        )}
                      </section>
                    )}

                    <label className="new-plan-dimension-option">
                      <input type="checkbox" checked={autoDimensions} onChange={(e) => setAutoDimensions(e.target.checked)} />
                      <IconRuler size={17} />
                      <span><strong>Dimension the room automatically</strong><small>Add wall lengths and curve radii to the opening drawing.</small></span>
                    </label>
                  </>
                )}
              </div>

              <aside className="new-plan-preview-panel">
                <div className="new-plan-preview-heading">
                  <span>Live room preview</span>
                  <b>{shape === 'custom' ? (roomReady ? 'Ready to draw' : 'Set a size') : roomReady ? 'Ready' : 'Needs attention'}</b>
                </div>
                <div className={customRoom ? 'new-plan-preview-stage is-custom' : 'new-plan-preview-stage'}>
                  {customRoom && roomReady ? (
                    <CustomRoomPreview
                      width={parsed.width!}
                      depth={parsed.depth!}
                      angleLock={customAngleLock}
                      showGuide={customShowGuide}
                    />
                  ) : customRoom ? (
                    <div className="new-plan-custom-preview">
                      <IconDrawPolygon size={42} />
                      <strong>Enter a working width and depth</strong>
                      <span>The sheet opens around that footprint so tracing stays readable.</span>
                    </div>
                  ) : previewRoom ? (
                    <RoomPreview
                      room={previewRoom}
                      highlightedWall={highlightedWall}
                      onSelectWall={
                        curveEligible && wallTreatment === 'curve'
                          ? (index) => {
                              setCurveWall(index);
                              setWallTreatment('curve');
                            }
                          : undefined
                      }
                    />
                  ) : null}
                </div>

                {customRoom && roomReady && (
                  <dl className="new-plan-room-stats">
                    <div><dt>Guide area</dt><dd>{formatArea(customGuideArea, units)}</dd></div>
                    <div><dt>Guide perimeter</dt><dd>{formatLength(customGuidePerimeter, units)}</dd></div>
                    <div><dt>Angle lock</dt><dd>{customAngleLock === 'free' ? 'Free' : customAngleLock === 'ortho' ? 'Ortho' : '45°'}</dd></div>
                    <div><dt>Guide</dt><dd>{customShowGuide ? 'On plan' : 'Hidden'}</dd></div>
                  </dl>
                )}

                {!customRoom && previewRoom && (
                  <dl className="new-plan-room-stats">
                    <div><dt>Floor area</dt><dd>{formatArea(roomArea(previewRoom), units)}</dd></div>
                    <div><dt>Perimeter</dt><dd>{formatLength(roomPerimeter(previewRoom), units)}</dd></div>
                    <div><dt>Wall runs</dt><dd>{previewRoom.walls.length}</dd></div>
                    <div><dt>Curved</dt><dd>{previewRoom.walls.filter((wall) => wall.bulge).length}</dd></div>
                  </dl>
                )}

                {!customRoom && preview && !preview.ok && (
                  <div className="new-plan-geometry-error" role="alert">
                    <strong>Adjust the geometry</strong>
                    <span>{preview.reason}</span>
                  </div>
                )}

                <div className="new-plan-after-create">
                  <strong>{customRoom ? 'After you finish the outline' : 'Still editable after creation'}</strong>
                  <span>
                    {customRoom
                      ? 'Move corners, add or cut walls, round corners, or convert a wall to a true-radius curve from the Room panel.'
                      : 'Move corners, add or remove plot lines, round individual corners, straighten arcs, or change a wall radius from the Room panel.'}
                  </span>
                </div>
              </aside>
            </div>
        </div>

        <div className="new-plan-foot">
          <div className="new-plan-foot-meta">
            {nameOpen ? (
              <div className="field new-plan-name-inline">
                <label htmlFor="new-plan-name">Plan name</label>
                <input
                  id="new-plan-name"
                  type="text"
                  value={name}
                  disabled={busy}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && roomReady) {
                      e.preventDefault();
                      void create();
                    }
                  }}
                />
              </div>
            ) : (
              <button type="button" className="link-btn" disabled={busy} onClick={() => setNameOpen(true)}>
                Rename from “{planName}”
              </button>
            )}
            <span className="new-plan-foot-note">Saves to Documents/Groundplan — rename anytime with Save As.</span>
          </div>
          <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
          <button
            type="button"
            className="primary"
            onClick={() => void create()}
            disabled={busy || !roomReady}
          >
            <IconPlus size={14} />
            {busy ? 'Creating…' : customRoom ? 'Create & draw…' : 'Create plan'}
          </button>
        </div>
      </div>
    </div>
  );
}
