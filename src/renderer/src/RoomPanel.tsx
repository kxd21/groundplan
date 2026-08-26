/**
 * The Room tab: the room, what it seats, what is built on it.
 *
 * Everything here is driven by the model in the main process, and the split is
 * deliberate. Solving a seating layout is cheap and changes nothing, so the
 * count updates as the numbers are typed and the user sees what a six-foot
 * cross aisle costs *before* four hundred chairs land on the drawing. Only
 * "Place" mutates anything.
 *
 * Measurements are typed, not spun. People say `40'`, `12' 6"`, `3.6m` — a
 * numeric stepper in tenths of an inch would be useless — so every size field
 * takes text and parses it, and holds its last good value when the text is
 * mid-edit and does not parse yet.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { PlanModelView, SeatingPreview } from '../../main/plan-model.js';
import { formatLength, parseLength, type UnitSystem } from '../../format/units.js';
import type { NewRoomShape, NewRoomSpec } from '../../format/new-room.js';
import type { Doc } from './App.js';
import {
  IconChair,
  IconDrawEllipse,
  IconDrawPolygon,
  IconDrawRect,
  IconEdit,
  IconPlus,
  IconRuler,
  IconTrash,
  IconWarning,
} from './icons.js';
import { SnappySlider } from './SnappySlider.js';
import type { WallEditSession } from './wall-edit.js';

const api = window.groundplan;

interface Props {
  /** Room keeps outline/more; seating and refine are dedicated destinations. */
  mode?: 'room' | 'seating' | 'refine';
  doc: Doc;
  onDoc: (doc: Doc) => void;
  onStatus: (message: string) => void;
  onError: (message: string) => void;
  onSelect: (ids: number[]) => void;
  drawingRoomOutline: boolean;
  onDrawRoomOutline: () => void;
  /** After Draw/Redraw rectangle or circle — New Plan custom may need an immediate save. */
  onRoomAuthored?: () => void | Promise<void>;
  /** Live clearance readouts for the status bar (preview + place). */
  onSeatingStatus?: (
    status: {
      front: number;
      side: number;
      wing: number;
      rear: number;
      centreAisle: number;
    } | null,
  ) => void;
  /** Fired after Place / Add seating section succeeds. */
  onSeatingApplied?: () => void;
  /** Live wall-edit overlay for the plan canvas (click wall, drag mid-handle). */
  onWallEditChange?: (session: WallEditSession | null) => void;
  /** External wall pick from the canvas. */
  wallPickIndex?: number | null;
  /** Ribbon “Edit walls” mode — keeps One wall editing armed. */
  editWallsMode?: boolean;
  /** Room layout workspace focus: walls vs whole-room reshape. */
  workspaceFocus?: 'walls' | 'room';
  /** When Edit walls is on, ribbon Push/Curve/Length drives the panel action. */
  preferredWallAction?: 'push' | 'curve' | 'length';
  onPreferredWallActionChange?: (action: 'push' | 'curve' | 'length') => void;
  /** Colour seats by A/V sightline grade on the plan canvas. */
  showSightlineMarkers?: boolean;
  onShowSightlineMarkersChange?: (next: boolean) => void;
}

/**
 * A text field holding a measurement.
 *
 * Keeps the raw text so a half-typed `12'` is not fought with, and reports the
 * parsed value only when there is one.
 */
function useLength(initial: number, units: UnitSystem): {
  text: string;
  setText: (value: string) => void;
  value: number | null;
  /** The text is a measurement. Zero counts — "no centre aisle" is an answer. */
  valid: boolean;
  /** It is also a size, which is what a width or a depth has to be. */
  positive: boolean;
} {
  const [text, setText] = useState(() => formatLength(initial, units));

  // Switching the unit system rewrites the box, which is the whole point of
  // the toggle: the same measurement, said the other way.
  useEffect(() => {
    setText((current) => {
      const parsed = parseLength(current, units === 'metric' ? 'imperial' : 'metric');
      return parsed == null ? current : formatLength(parsed, units);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [units]);

  const value = parseLength(text, units);
  return { text, setText, value, valid: value != null, positive: value != null && value > 0 };
}

function LengthField({
  id,
  label,
  hint,
  field,
  units,
  disabled,
  onBlur,
}: {
  id: string;
  label: string;
  /**
   * What this clearance actually is.
   *
   * These are Room Viewer's terms and several are indistinguishable from their
   * label alone — "Front" and "Front wall" are different distances, and so are
   * "Aisle" and "Centre aisle". The model has always documented them; the panel
   * never did, so the first thing an experienced planner asked on opening it
   * was which was which.
   */
  hint?: string;
  field: ReturnType<typeof useLength>;
  units: UnitSystem;
  disabled?: boolean;
  onBlur?: () => void;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="text"
        inputMode="text"
        value={field.text}
        disabled={disabled}
        placeholder={units === 'metric' ? 'e.g. 120cm' : "e.g. 4' 6\""}
        title={
          units === 'metric'
            ? 'Metres or centimetres (bare number = metres). ft/in suffixes also work.'
            : 'Feet or inches (bare number = feet). cm/m/mm suffixes also work.'
        }
        aria-invalid={field.text.trim() !== '' && !field.valid}
        onChange={(e) => field.setText(e.target.value)}
        onBlur={onBlur}
      />
      {hint ? <small className="field-hint">{hint}</small> : null}
    </div>
  );
}

export default function RoomPanel({
  mode = 'room',
  doc,
  onDoc,
  onStatus,
  onError,
  onSelect,
  drawingRoomOutline,
  onDrawRoomOutline,
  onRoomAuthored,
  onSeatingStatus,
  onSeatingApplied,
  onWallEditChange,
  wallPickIndex = null,
  editWallsMode = false,
  workspaceFocus,
  preferredWallAction,
  onPreferredWallActionChange,
  showSightlineMarkers = false,
  onShowSightlineMarkersChange,
}: Props) {
  const [model, setModel] = useState<PlanModelView | null>(null);
  const [busy, setBusy] = useState(false);
  const units: UnitSystem = model?.units ?? 'imperial';

  const refresh = useCallback(async () => {
    setModel(await api.planModel());
  }, []);

  // The model is derived from the document, so it is re-read whenever the
  // document changes rather than kept in step by hand.
  useEffect(() => {
    let cancelled = false;
    void api.planModel().then((next) => {
      if (!cancelled) setModel(next);
    });
    return () => {
      cancelled = true;
    };
  }, [doc.revision, doc.path]);

  /** Runs an edit, folds the new document back in, and reports the outcome. */
  const run = useCallback(
    async (
      what: string,
      call: () => Promise<{ ok: boolean; reason?: string; note?: string; doc?: unknown; created?: number[] }>,
    ) => {
      setBusy(true);
      try {
        const reply = await call();
        if (!reply.ok) {
          onError(reply.reason ?? `${what} failed`);
          return false;
        }
        if (reply.doc) onDoc(reply.doc as Doc);
        if (reply.created?.length) onSelect(reply.created);
        onStatus(reply.note ? `${what}. ${reply.note}` : what);
        await refresh();
        return true;
      } finally {
        setBusy(false);
      }
    },
    [onDoc, onError, onSelect, onStatus, refresh],
  );

  const room = model?.room ?? null;
  const editable = doc.editable && !busy;

  // ---- Room ---------------------------------------------------------------
  const [roomShape, setRoomShape] = useState<NewRoomShape | 'custom'>('rectangle');
  const width = useLength(40 * 120, units);
  const depth = useLength(30 * 120, units);
  const roomCornerRadius = useLength(4 * 120, units);
  const roomNotchWidth = useLength(20 * 120, units);
  const roomNotchDepth = useLength(15 * 120, units);

  useEffect(() => {
    if (drawingRoomOutline) setRoomShape('custom');
  }, [drawingRoomOutline]);

  const roomSpecReady = (() => {
    if (roomShape === 'custom') return false;
    if (roomShape === 'circle') return width.positive;
    if (roomShape === 'rounded') return width.positive && depth.positive && roomCornerRadius.positive;
    if (roomShape === 'l-shape' || roomShape === 'u-shape') {
      return width.positive && depth.positive && roomNotchWidth.positive && roomNotchDepth.positive;
    }
    return width.positive && depth.positive;
  })();

  const buildRoomSpec = (): NewRoomSpec | null => {
    if (roomShape === 'custom' || !roomSpecReady) return null;
    if (roomShape === 'circle') return { shape: 'circle', diameter: width.value! };
    if (roomShape === 'rounded') {
      return {
        shape: 'rounded',
        width: width.value!,
        depth: depth.value!,
        cornerRadius: roomCornerRadius.value!,
      };
    }
    if (roomShape === 'l-shape' || roomShape === 'u-shape') {
      return {
        shape: roomShape,
        width: width.value!,
        depth: depth.value!,
        notchWidth: roomNotchWidth.value!,
        notchDepth: roomNotchDepth.value!,
      };
    }
    return { shape: roomShape, width: width.value!, depth: depth.value! };
  };

  // ---- Reshape / curve ----------------------------------------------------
  const [outlineMode, setOutlineMode] = useState<'walls' | 'reshape'>('walls');
  const [wallAction, setWallAction] = useState<'move' | 'length' | 'curve' | 'push' | 'round' | 'corners'>('push');
  const wallPush = useLength(2 * 120, units);
  const [reshapeOp, setReshapeOp] = useState<'union' | 'difference'>('union');
  const reshapeX = useLength(0, units);
  const reshapeY = useLength(0, units);
  const reshapeW = useLength(10 * 120, units);
  const reshapeD = useLength(10 * 120, units);
  const [editCorner, setEditCorner] = useState(0);
  const cornerX = useLength(0, units);
  const cornerY = useLength(0, units);
  const cornerRadius = useLength(2 * 120, units);
  const curveRadius = useLength(20 * 120, units);
  const curveSagitta = useLength(5 * 120, units);
  const curveArcLength = useLength(50 * 120, units);
  const [curveAngleText, setCurveAngleText] = useState('90');
  const [curveMethod, setCurveMethod] = useState<'radius' | 'sagitta' | 'angle' | 'arc-length'>('radius');
  const wallLengthField = useLength(40 * 120, units);
  /** False = bow into the room; true = bow outward. */
  const [curveOutward, setCurveOutward] = useState(false);
  const [curveMajor, setCurveMajor] = useState(false);
  const selectedWall = room?.wallDetails?.[editCorner];
  const selectedWallCurved = Boolean(selectedWall?.curved);
  const selectedWallChord = selectedWall?.length ?? 0;
  const curveAngleValue = Number(curveAngleText);
  const curveValueReady =
    curveMethod === 'angle'
      ? Number.isFinite(curveAngleValue) && curveAngleValue > 0 && curveAngleValue < 360
      : curveMethod === 'radius'
        ? curveRadius.positive
        : curveMethod === 'sagitta'
          ? curveSagitta.positive
          : curveArcLength.positive;
  const curveValue =
    curveMethod === 'angle'
      ? curveAngleValue
      : curveMethod === 'radius'
        ? curveRadius.value
        : curveMethod === 'sagitta'
          ? curveSagitta.value
          : curveArcLength.value;
  const selectedCornerCanRound = Boolean(
    room?.wallDetails?.length &&
    !room.wallDetails[editCorner]?.curved &&
    !room.wallDetails[(editCorner - 1 + room.wallDetails.length) % room.wallDetails.length]?.curved
  );
  const canReshapeRect =
    Boolean(room) && room!.axisAligned && room!.curved === 0;

  type RoomPanelTab = 'outline' | 'seating' | 'more';
  const [roomPanelTab, setRoomPanelTab] = useState<RoomPanelTab>(() =>
    mode === 'seating' ? 'seating' : 'outline',
  );

  useEffect(() => {
    setRoomPanelTab(mode === 'seating' ? 'seating' : 'outline');
  }, [mode]);

  // Refine workspace arms wall editing; focus picks walls vs whole-room reshape.
  useEffect(() => {
    if (mode === 'refine') {
      setOutlineMode(workspaceFocus === 'room' ? 'reshape' : 'walls');
      setRoomPanelTab('outline');
    }
  }, [mode, workspaceFocus]);

  // Seed the size fields from the room the plan already has.
  //
  // Without this they sit at the 40 x 30 defaults whatever the plan holds, and
  // the button beside them reads "Redraw room" once a room exists — so on a
  // 245ft hall one click silently resizes it to 40ft. Seeding once per plan
  // makes the control describe the room it will act on, and leaves whatever
  // the user types alone after that.
  const [sizeSeeded, setSizeSeeded] = useState(false);
  useEffect(() => {
    setSizeSeeded(false);
  }, [doc.path]);
  useEffect(() => {
    if (!room || sizeSeeded || room.width <= 0 || room.height <= 0) return;
    width.setText(formatLength(room.width, units));
    depth.setText(formatLength(room.height, units));
    setSizeSeeded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, units, sizeSeeded]);

  const [shapeSeeded, setShapeSeeded] = useState(false);
  useEffect(() => {
    setShapeSeeded(false);
  }, [doc.path]);
  useEffect(() => {
    if (!room || shapeSeeded) return;
    setRoomShape(room.shape);
    if (room.shape === 'custom') setOutlineMode('walls');
    setShapeSeeded(true);
  }, [room, shapeSeeded]);

  // Seed reshape origin from the room once per open plan, so "Add area"
  // starts beside the current outline rather than at the origin.
  const [reshapeSeeded, setReshapeSeeded] = useState(false);
  useEffect(() => {
    setReshapeSeeded(false);
  }, [doc.path]);
  useEffect(() => {
    if (!room || reshapeSeeded) return;
    reshapeX.setText(formatLength(room.x + room.width, units));
    reshapeY.setText(formatLength(room.y, units));
    setReshapeSeeded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, units, reshapeSeeded]);

  // Seed wall fields when the selected corner changes — not on every geometry
  // mutation, so typed radius/length aren't wiped mid-edit.
  useEffect(() => {
    const detail = room?.wallDetails?.[editCorner];
    if (!detail) return;
    cornerX.setText(detail.startXText);
    cornerY.setText(detail.startYText);
    wallLengthField.setText(detail.lengthText);
    if (detail.curved && detail.radius > 0) {
      curveRadius.setText(detail.radiusText);
      setCurveMethod('radius');
    } else if (detail.length > 0) {
      // Half-chord is a usable starting radius for a gentle bay.
      curveRadius.setText(formatLength(detail.length / 2, units));
      curveSagitta.setText(formatLength(detail.length * 0.12, units));
      curveArcLength.setText(formatLength(detail.length * 1.15, units));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editCorner]);

  // After a successful wall edit, refresh fields from the new geometry once.
  const wallGeometryEpoch = room?.wallDetails?.[editCorner]
    ? `${editCorner}:${room.wallDetails[editCorner].length}:${room.wallDetails[editCorner].radius}:${room.wallDetails[editCorner].startX}:${room.wallDetails[editCorner].startY}`
    : '';
  const lastWallSeedEpoch = useRef('');
  useEffect(() => {
    if (!wallGeometryEpoch || wallGeometryEpoch === lastWallSeedEpoch.current) return;
    // First paint for a corner is handled by editCorner effect; skip until an edit lands.
    if (!lastWallSeedEpoch.current) {
      lastWallSeedEpoch.current = wallGeometryEpoch;
      return;
    }
    lastWallSeedEpoch.current = wallGeometryEpoch;
    const detail = room?.wallDetails?.[editCorner];
    if (!detail) return;
    cornerX.setText(detail.startXText);
    cornerY.setText(detail.startYText);
    wallLengthField.setText(detail.lengthText);
    if (detail.curved && detail.radius > 0) {
      curveRadius.setText(detail.radiusText);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallGeometryEpoch]);

  useEffect(() => {
    lastWallSeedEpoch.current = '';
  }, [editCorner]);

  // After reshape, wall count can shrink — keep the picker on a real wall.
  useEffect(() => {
    const count = room?.wallDetails?.length ?? 0;
    if (count === 0) return;
    if (editCorner >= count) setEditCorner(0);
  }, [room?.wallDetails, editCorner]);

  // Canvas picks a wall — sync the inspector picker.
  useEffect(() => {
    if (wallPickIndex == null) return;
    const count = room?.wallDetails?.length ?? 0;
    if (wallPickIndex >= 0 && wallPickIndex < count) setEditCorner(wallPickIndex);
  }, [wallPickIndex, room?.wallDetails?.length]);

  // Ribbon Edit walls (inspector) keeps One wall armed — not the refine dock.
  useEffect(() => {
    if (editWallsMode && mode !== 'refine') setOutlineMode('walls');
  }, [editWallsMode, mode]);

  useEffect(() => {
    if (preferredWallAction) setWallAction(preferredWallAction);
  }, [preferredWallAction]);

  // Publish wall-edit overlay while One wall mode is active (or Edit walls is on).
  useEffect(() => {
    if (!onWallEditChange) return;
    const armed =
      (mode === 'room' && outlineMode === 'walls') ||
      editWallsMode ||
      mode === 'refine';
    if (!armed || !room?.wallDetails?.length) {
      onWallEditChange(null);
      return;
    }
    const gesture =
      wallAction === 'curve' ? 'curve' : wallAction === 'length' ? 'length' : 'push';
    onWallEditChange({
      walls: room.wallDetails.map((wall) => ({
        index: wall.index,
        startX: wall.startX,
        startY: wall.startY,
        endX: wall.endX,
        endY: wall.endY,
        curved: wall.curved,
        bulge: wall.bulge ?? 0,
        length: wall.length,
      })),
      selected: editCorner,
      gesture,
      editable,
    });
    return () => onWallEditChange(null);
  }, [
    onWallEditChange,
    mode,
    outlineMode,
    editWallsMode,
    room?.wallDetails,
    editCorner,
    wallAction,
    editable,
  ]);

  // ---- Event Room Data / seating ------------------------------------------
  type ErdTab = 'seating' | 'spacing' | 'av' | 'design';
  const [erdTab, setErdTab] = useState<ErdTab>('seating');
  const [roomName, setRoomName] = useState('');
  const ceiling = useLength(10 * 120, units);
  const [rvStyle, setRvStyle] = useState<
    'schoolroom' | 'theatre' | 'banquet' | 'hollow-square' | 'u-shape' | 'conference' | 'custom'
  >('theatre');
  const [style, setStyle] = useState('theatre');
  const [chair, setChair] = useState('');
  const [table, setTable] = useState('');
  const [seatsPerTableDraft, setSeatsPerTableDraft] = useState('8');
  const seatsPerTable = (() => {
    const n = Number(seatsPerTableDraft);
    return Number.isFinite(n) ? Math.max(0, Math.min(24, n)) : 0;
  })();
  const [rowsPerBlockDraft, setRowsPerBlockDraft] = useState('');
  const rowsPerBlock = (() => {
    const n = Number(rowsPerBlockDraft);
    return Number.isFinite(n) ? Math.max(0, n) : 0;
  })();
  const [optimum, setOptimum] = useState(false);
  const [crescent, setCrescent] = useState(false);
  const [stagger, setStagger] = useState(true);
  const [splay, setSplay] = useState(0);
  const [sectionCentre, setSectionCentre] = useState(0);
  const [sectionWing, setSectionWing] = useState(0);
  const [seatingPlacementMode, setSeatingPlacementMode] = useState<'replace' | 'add'>('replace');
  const [banquetEndChairs, setBanquetEndChairs] = useState(false);
  const [banquetRotate90, setBanquetRotate90] = useState(false);
  const [chairsBothSides, setChairsBothSides] = useState(false);
  const [tablesAcross, setTablesAcross] = useState(0);
  const seatSpacing = useLength(20 * 10, units);
  const rowSpacing = useLength(36 * 10, units);
  const frontClearance = useLength(8 * 120, units);
  const sideClearance = useLength(4 * 120, units);
  const wingClearance = useLength(4 * 120, units);
  const rearClearance = useLength(4 * 120, units);
  const frontWallClearance = useLength(0, units);
  const aisleClearance = useLength(0, units);
  const centreAisle = useLength(0, units);
  const [preview, setPreview] = useState<SeatingPreview | null>(null);
  const [av, setAv] = useState<Awaited<ReturnType<typeof api.avSummary>>>(null);

  const styleInfo = model?.seatingStyles.find((s) => s.id === style);
  const needsTable = styleInfo?.needsTable ?? false;

  // Where the audience looks: a point beyond the front wall, so every seat is
  // turned towards the front of the room rather than towards a spot inside the
  // seating itself.
  const focus = useMemo(() => {
    const extent = doc.scene.roomExtent;
    if (!extent) return { x: 0, y: 0 };
    return { x: (extent.minX + extent.maxX) / 2, y: extent.minY - 6 * 120 };
  }, [doc.scene.roomExtent]);

  // Where the stage is built: against the inside of the front wall.
  //
  // This used to reuse the seating focus, which sits six feet beyond that wall
  // — so an 8ft stage was drawn with six of its feet outside the room, and its
  // floor came off the seating count in floor the room never had.
  const stageOrigin = useMemo(() => {
    const extent = doc.scene.roomExtent;
    if (!extent) return { x: 0, y: 0 };
    return { x: (extent.minX + extent.maxX) / 2, y: extent.minY };
  }, [doc.scene.roomExtent]);

  // Seed room name / ceiling once per plan open.
  const [metaSeeded, setMetaSeeded] = useState(false);
  useEffect(() => {
    setMetaSeeded(false);
  }, [doc.path]);
  useEffect(() => {
    if (!room || metaSeeded) return;
    setRoomName(room.name || '');
    if (room.ceilingHeight > 0) ceiling.setText(formatLength(room.ceilingHeight, units));
    setMetaSeeded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, units, metaSeeded]);

  useEffect(() => {
    if (rvStyle !== 'custom') setStyle(rvStyle);
  }, [rvStyle]);

  const seatingRequest = useMemo(
    () => ({
      style: (crescent && needsTable ? 'crescent' : style) as never,
      focusX: focus.x,
      focusY: focus.y,
      seatSpacing: seatSpacing.value ?? undefined,
      rowSpacing: rowSpacing.value ?? undefined,
      front: frontClearance.value ?? undefined,
      side: sideClearance.value ?? undefined,
      wing: wingClearance.value ?? undefined,
      rear: rearClearance.value ?? undefined,
      frontWall: frontWallClearance.value ?? undefined,
      aisle: aisleClearance.value ?? undefined,
      centreAisle: centreAisle.value ?? 0,
      rowsPerBlock,
      stagger,
      splay,
      seatsPerTable: seatsPerTable > 0 ? seatsPerTable : undefined,
      optimum,
      crescent,
      banquetEndChairs,
      banquetRotate90,
      chairsBothSides,
      tablesAcross: tablesAcross > 0 ? tablesAcross : undefined,
      sectionCentre: sectionCentre > 0 ? sectionCentre : undefined,
      sectionWing: sectionWing > 0 ? sectionWing : undefined,
      append: seatingPlacementMode === 'add',
    }),
    [
      style,
      crescent,
      needsTable,
      focus.x,
      focus.y,
      seatSpacing.value,
      rowSpacing.value,
      frontClearance.value,
      sideClearance.value,
      wingClearance.value,
      rearClearance.value,
      frontWallClearance.value,
      aisleClearance.value,
      centreAisle.value,
      rowsPerBlock,
      stagger,
      splay,
      seatsPerTable,
      optimum,
      banquetEndChairs,
      banquetRotate90,
      chairsBothSides,
      tablesAcross,
      sectionCentre,
      sectionWing,
      seatingPlacementMode,
    ],
  );

  // Live count. Solving is pure and cheap, so this runs on every change —
  // seeing the cost of a wider aisle is the point of the panel.
  useEffect(() => {
    let cancelled = false;
    if (!room) {
      setPreview(null);
      onSeatingStatus?.(null);
      return;
    }
    void api.seatingPreview(seatingRequest).then((result) => {
      if (cancelled) return;
      setPreview(result);
      if (result?.clearances) {
        onSeatingStatus?.({
          front: result.clearances.front,
          side: result.clearances.side,
          wing: result.clearances.wing,
          rear: result.clearances.rear,
          centreAisle: result.clearances.centreAisle,
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [room, seatingRequest, onSeatingStatus]);

  useEffect(() => {
    if (erdTab !== 'av') return;
    let cancelled = false;
    void api.avSummary().then((result) => {
      if (!cancelled) setAv(result);
    });
    return () => {
      cancelled = true;
    };
  }, [erdTab, doc.revision]);

  const saveRoomMeta = useCallback(async () => {
    const patch: { name?: string; ceilingHeight?: number } = {};
    if (roomName.trim()) patch.name = roomName.trim();
    if (ceiling.value != null && ceiling.value > 0) patch.ceilingHeight = ceiling.value;
    const reply = await api.roomMeta(patch);
    if (!reply.ok) onError(reply.reason ?? 'could not update the room');
    else {
      onStatus(reply.note ?? 'Room details saved');
      await refresh();
    }
  }, [roomName, ceiling.value, onError, onStatus, refresh]);

  // ---- Stage --------------------------------------------------------------
  const stageWidth = useLength(24 * 120, units);
  const stageDepth = useLength(16 * 120, units);
  const stageHeight = useLength(24 * 10, units);

  const names = doc.scene.inventory.map((i) => i.name);

  // Shapes already on the plan are the best chairs and tables to seat with,
  // because they place as the real drawn symbol rather than a box. But a plan
  // that has just been created has none — so on a brand-new room the only
  // thing the chair picker could offer was the stage, and seating could not be
  // placed at all until something had been put on the drawing by hand.
  //
  // The equipment library is the other honest source, so offer it too, keeping
  // the plan's own shapes first and dropping anything already listed there.
  const [libraryNames, setLibraryNames] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    void api
      .inventoryList('', null, null)
      .then((state) => {
        if (!cancelled) setLibraryNames(state.items.map((item) => item.name));
      })
      .catch(() => {
        /* the picker still works from the plan's own shapes */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const onPlan = new Set(names);
  const fromLibrary = libraryNames.filter((name) => !onPlan.has(name));

  /** Chair and table pickers offer the same two groups. */
  const shapeOptions = (
    <>
      {names.length > 0 && (
        <optgroup label="On this plan">
          {names.map((name) => (
            <option key={`plan:${name}`} value={name}>
              {name}
            </option>
          ))}
        </optgroup>
      )}
      {fromLibrary.length > 0 && (
        <optgroup label="From the equipment library">
          {fromLibrary.map((name) => (
            <option key={`lib:${name}`} value={name}>
              {name}
            </option>
          ))}
        </optgroup>
      )}
    </>
  );

  if (!model) {
    return (
      <div className="section">
        <p className="hint">Open a plan to see its room.</p>
      </div>
    );
  }

  return (
    <>
      {mode === 'refine' && (
        <div className="room-refine-panel-hero">
          <strong>{workspaceFocus === 'walls' ? 'Wall editing' : 'Whole-room layout'}</strong>
          <small>
            {workspaceFocus === 'walls'
              ? 'Select a wall on the plan, then push, curve, or stretch it.'
              : 'Change overall size, add or cut space, then refine each wall on the plan.'}
          </small>
        </div>
      )}

      {mode === 'room' && (
      <div className="seg tabs room-panel-tabs" role="tablist" aria-label="Room panel">
        {(
          [
            ['outline', 'Outline'],
            ['more', 'More'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={roomPanelTab === id}
            className={roomPanelTab === id ? 'active' : ''}
            onClick={() => setRoomPanelTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      )}

      {roomPanelTab === 'outline' && (
        <>
      {/* ---------------------------------------------------------------- */}
      <div className="section">
        <div className="section-title">
          <span>Room</span>
          {room && (
            <span className="section-count">
              {room.sizeText}
              {room.curved > 0 ? ` · ${room.curved} curved` : ''}
            </span>
          )}
        </div>

        {room ? (
          <p className="room-summary-line">
            {room.areaText} floor · {room.walls} wall{room.walls === 1 ? '' : 's'}
            {room.ceilingText ? ` · ${room.ceilingText} ceiling` : ''}
            {room.holes > 0 ? ` · ${room.holes} cut-out${room.holes === 1 ? '' : 's'}` : ''}
          </p>
        ) : (
          <p className="hint">No outline yet. Draw one below.</p>
        )}

        <div className="field-row">
          <div className="field">
            <label htmlFor="room-outline-name">Room name</label>
            <input
              id="room-outline-name"
              type="text"
              value={roomName}
              disabled={!editable}
              onChange={(e) => setRoomName(e.target.value)}
              onBlur={() => void saveRoomMeta()}
            />
          </div>
          <LengthField
            id="room-outline-ceiling"
            label="Ceiling height"
            field={ceiling}
            units={units}
            disabled={!editable}
            onBlur={() => void saveRoomMeta()}
          />
        </div>
        <div className="actions-row" style={{ marginBottom: 10 }}>
          <button type="button" className="btn-outline" disabled={!editable} onClick={() => void saveRoomMeta()}>
            Save room
          </button>
        </div>

        {room?.source === 'extent' && (
          <div className="notice" role="status">
            <IconWarning size={14} />
            <span>
              No wall outline could be traced, so this is the extent of the drawing. Treat the area as an
              over-estimate.
            </span>
          </div>
        )}
        {room?.problems.map((problem) => (
          <div className="notice" role="status" key={problem}>
            <IconWarning size={14} />
            <span>{problem}</span>
          </div>
        ))}

        {model.companion.freshness === 'stale' && model.companion.reason && (
          <div className="notice" role="status">
            <IconWarning size={14} />
            <span>{model.companion.reason}</span>
          </div>
        )}

        <div className="room-shape-picker is-expanded" role="radiogroup" aria-label="Room shape">
          {(
            [
              ['rectangle', 'Rectangle', 'Width and depth', IconDrawRect],
              ['rounded', 'Rounded', 'True-radius corners', IconDrawRect],
              ['circle', 'Circle', 'Exact diameter', IconDrawEllipse],
              ['stadium', 'Stadium', 'Semicircle ends', IconDrawEllipse],
              ['l-shape', 'L-shaped', 'One recessed corner', IconDrawPolygon],
              ['u-shape', 'U-shaped', 'Centred recess', IconDrawPolygon],
              ['custom', 'Draw custom', 'Click every corner', IconDrawPolygon],
            ] as const
          ).map(([shape, label, description, Icon]) => (
            <button
              type="button"
              key={shape}
              className={roomShape === shape ? 'active' : ''}
              role="radio"
              aria-checked={roomShape === shape}
              disabled={!editable}
              onClick={() => {
                if (drawingRoomOutline && shape !== 'custom') onDrawRoomOutline();
                setRoomShape(shape);
              }}
            >
              <Icon size={17} />
              <span><strong>{label}</strong><small>{description}</small></span>
            </button>
          ))}
        </div>

        {roomShape === 'circle' ? (
          <div className="field-row room-shape-fields is-single">
            <LengthField id="room-diameter" label="Diameter" field={width} units={units} disabled={!editable} />
          </div>
        ) : roomShape !== 'custom' ? (
          <div className="field-row room-shape-fields">
            <LengthField id="room-width" label="Width" field={width} units={units} disabled={!editable} />
            <LengthField id="room-depth" label="Depth" field={depth} units={units} disabled={!editable} />
          </div>
        ) : null}
        {roomShape === 'rounded' && (
          <div className="field-row room-shape-fields is-single">
            <LengthField id="room-corner-radius" label="Corner radius" field={roomCornerRadius} units={units} disabled={!editable} />
          </div>
        )}
        {(roomShape === 'l-shape' || roomShape === 'u-shape') && (
          <div className="field-row room-shape-fields">
            <LengthField id="room-notch-width" label="Recess width" field={roomNotchWidth} units={units} disabled={!editable} />
            <LengthField id="room-notch-depth" label="Recess depth" field={roomNotchDepth} units={units} disabled={!editable} />
          </div>
        )}
        {roomShape === 'custom' && (
          <div className={`room-outline-guide${drawingRoomOutline ? ' is-active' : ''}`} role="status">
            <IconDrawPolygon size={18} />
            <span>
              <strong>{drawingRoomOutline ? 'Drawing on the plan' : 'Trace the room on the plan'}</strong>
              <small>
                {drawingRoomOutline
                  ? 'Click corners in order. Click near the start or press Enter to finish.'
                  : 'Three or more corners, then click near the first corner or press Enter.'}
              </small>
            </span>
          </div>
        )}
        <div className="actions-row">
          {roomShape === 'custom' ? (
            <button
              type="button"
              className={drawingRoomOutline ? 'is-on' : ''}
              onClick={onDrawRoomOutline}
              disabled={!editable}
              title={drawingRoomOutline ? 'Cancel the custom room outline' : 'Click each corner on the plan'}
            >
              <IconDrawPolygon size={14} />
              {drawingRoomOutline ? 'Cancel outline' : room ? 'Redraw custom' : 'Draw custom'}
            </button>
          ) : (
            <button
              onClick={() =>
                void (async () => {
                  const spec = buildRoomSpec();
                  if (!spec) return;
                  const ok = await run(
                    room && room.source === 'companion' ? `Redraw ${roomShape}` : `Drew ${roomShape} room`,
                    () => api.roomCreateFromSpec(spec),
                  );
                  if (ok) {
                    await saveRoomMeta();
                    await onRoomAuthored?.();
                  }
                })()
              }
              disabled={!editable || !roomSpecReady}
              title={
                doc.editable
                  ? room
                    ? `Redraw as ${roomShape}`
                    : `Draw a ${roomShape} room`
                  : 'This plan is open read-only'
              }
            >
              {roomShape === 'circle' ? <IconDrawEllipse size={14} /> : <IconPlus size={14} />}
              {room && room.source === 'companion'
                ? `Redraw ${roomShape}`
                : `Draw ${roomShape}`}
            </button>
          )}
          <button
            onClick={() => void run('Room dimensioned', () => api.roomDimension())}
            disabled={!editable || !room}
            title="Add a dimension to every wall"
          >
            <IconRuler size={14} />
            Dimension
          </button>
        </div>
      </div>

      {room && (
        <div className="section">
          <div className="section-title">
            <span>Edit walls</span>
            <span className="section-count">{room.walls}</span>
          </div>

          <div className="room-outline-modes" role="tablist" aria-label="Wall editing mode">
            <button
              type="button"
              role="tab"
              aria-selected={outlineMode === 'walls'}
              className={outlineMode === 'walls' ? 'active' : ''}
              onClick={() => setOutlineMode('walls')}
              disabled={!editable}
            >
              <IconEdit size={15} />
              <span><strong>One wall</strong><small>Move, length, curve</small></span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={outlineMode === 'reshape'}
              className={outlineMode === 'reshape' ? 'active' : ''}
              onClick={() => setOutlineMode('reshape')}
              disabled={!editable}
            >
              <IconPlus size={15} />
              <span><strong>Add / cut</strong><small>Rectangular patch</small></span>
            </button>
          </div>

          {outlineMode === 'reshape' ? (
            <div className="room-outline-pane" role="tabpanel">
              <p className="hint">
                {canReshapeRect
                  ? 'Add a rectangular bay or cut a rectangular opening from the room.'
                  : room.curved > 0
                    ? 'Straighten curved walls first, then add or cut.'
                    : 'Needs a rectangular (axis-aligned) room. Use Freeform above for angled shapes.'}
              </p>
              <div className="seg tabs seat-kinds" role="tablist" aria-label="Reshape operation">
                <button
                  type="button"
                  className={reshapeOp === 'union' ? 'active' : ''}
                  onClick={() => setReshapeOp('union')}
                  disabled={!editable || !canReshapeRect}
                >
                  Add area
                </button>
                <button
                  type="button"
                  className={reshapeOp === 'difference' ? 'active' : ''}
                  onClick={() => setReshapeOp('difference')}
                  disabled={!editable || !canReshapeRect}
                >
                  Cut out
                </button>
              </div>

              <div className="field-row">
                <LengthField id="reshape-x" label="X" field={reshapeX} units={units} disabled={!editable || !canReshapeRect} />
                <LengthField id="reshape-y" label="Y" field={reshapeY} units={units} disabled={!editable || !canReshapeRect} />
              </div>
              <div className="field-row">
                <LengthField id="reshape-w" label="Width" field={reshapeW} units={units} disabled={!editable || !canReshapeRect} />
                <LengthField id="reshape-d" label="Depth" field={reshapeD} units={units} disabled={!editable || !canReshapeRect} />
              </div>
              <div className="actions-row">
                <button
                  type="button"
                  onClick={() =>
                    void run(reshapeOp === 'union' ? 'Area added' : 'Cut-out applied', () =>
                      api.roomReshape(
                        reshapeOp,
                        reshapeX.value!,
                        reshapeY.value!,
                        reshapeW.value!,
                        reshapeD.value!,
                      ),
                    )
                  }
                  disabled={
                    !editable ||
                    !canReshapeRect ||
                    !reshapeX.valid ||
                    !reshapeY.valid ||
                    !reshapeW.positive ||
                    !reshapeD.positive
                  }
                >
                  <IconPlus size={14} />
                  {reshapeOp === 'union' ? 'Add to room' : 'Cut from room'}
                </button>
              </div>
            </div>
          ) : (
            <div className="room-outline-pane" role="tabpanel">
              <div className="field room-corner-select">
                <label htmlFor="outline-line">Wall</label>
                <select
                  id="outline-line"
                  value={editCorner}
                  onChange={(e) => setEditCorner(Number(e.target.value))}
                  disabled={!editable || !(room.wallDetails?.length)}
                >
                  {(room.wallDetails ?? []).map((wall) => (
                    <option key={wall.index} value={wall.index}>
                      Wall {wall.index + 1} · {wall.lengthText}
                      {wall.curved ? ` · curved` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <p className="hint room-wall-hint">
                Use <strong>Edit walls</strong> in the top bar, click a wall, then drag the handle.
                Push · Curve · Length snap to <strong>1″</strong> (Shift = fine, Alt = free). Arrow keys nudge the selected wall.
                {selectedWallCurved && selectedWall?.radiusText
                  ? ` · Wall ${editCorner + 1} radius ${selectedWall.radiusText} · arc ${selectedWall.lengthText}`
                  : selectedWall
                    ? ` · Wall ${editCorner + 1} · ${selectedWall.lengthText}`
                    : ''}
              </p>

              <div className="seg tabs wall-action-tabs" role="tablist" aria-label="What to change">
                {(
                  [
                    ['push', 'Push'],
                    ['curve', 'Curve'],
                    ['length', 'Length'],
                    ['move', 'Move'],
                    ['round', 'Round'],
                    ['corners', 'Corners'],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={wallAction === id}
                    className={wallAction === id ? 'active' : ''}
                    onClick={() => {
                      setWallAction(id);
                      if (id === 'push' || id === 'curve' || id === 'length') {
                        onPreferredWallActionChange?.(id);
                      }
                    }}
                    disabled={!editable}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {wallAction === 'push' && (
                <div className="room-edit-card is-prominent">
                  <div className="room-edit-card-title">
                    <strong>Push / pull this wall</strong>
                    <small>
                      Drag the mid-wall handle on the plan, or set a distance here. Positive grows the room.
                    </small>
                  </div>
                  <SnappySlider
                    label="Move wall"
                    values={[-10 * 120, -5 * 120, -2 * 120, -120, -60, -10, 0, 10, 60, 120, 2 * 120, 5 * 120, 10 * 120]}
                    defaultValue={2 * 120}
                    min={-20 * 120}
                    max={20 * 120}
                    step={1}
                    compact
                    disabled={!editable || selectedWallCurved}
                    value={wallPush.value ?? 2 * 120}
                    config={{
                      labelFormatter: (value) => formatLength(value, units),
                    }}
                    onChange={(next) => wallPush.setText(formatLength(next, units))}
                  />
                  <p className="hint">
                    Drag the slider to set the distance, then Apply. The room updates when you apply — not while dragging.
                  </p>
                  {selectedWallCurved && (
                    <p className="hint">Straighten the wall (Curve → Straighten) before pushing it.</p>
                  )}
                  <div className="actions-row room-edit-actions">
                    <button
                      type="button"
                      className="btn-solid"
                      disabled={!editable || !wallPush.valid || selectedWallCurved || !(wallPush.value !== 0)}
                      onClick={() =>
                        void run('Wall moved', () => api.roomWallOffset(editCorner, wallPush.value!))
                      }
                    >
                      Apply push / pull
                    </button>
                  </div>
                </div>
              )}

              {wallAction === 'curve' && (
                <div className="room-edit-card is-prominent room-curve-card">
                  <div className="room-edit-card-title">
                    <strong>Curve this wall</strong>
                    <small>
                      {selectedWall
                        ? `Wall ${editCorner + 1} · chord ${selectedWall.lengthText}${selectedWallCurved ? ` · now R ${selectedWall.radiusText}` : ''}`
                        : 'Bend the whole wall into a circular arc.'}
                    </small>
                  </div>

                  <div className="seg tabs room-curve-methods" role="radiogroup" aria-label="Define curve by">
                    {(
                      [
                        ['radius', 'Radius'],
                        ['sagitta', 'Bow'],
                        ['angle', 'Angle'],
                        ['arc-length', 'Arc len'],
                      ] as const
                    ).map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        className={curveMethod === id ? 'active' : ''}
                        onClick={() => setCurveMethod(id)}
                        disabled={!editable}
                        title={
                          id === 'radius'
                            ? 'Arc radius to both ends'
                            : id === 'sagitta'
                              ? 'How far the wall bows off the chord'
                              : id === 'angle'
                                ? 'Included angle of the arc'
                                : 'Finished wall length along the curve'
                        }
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  {curveMethod === 'radius' && (
                    <div className="field-row is-single">
                      <LengthField id="curve-radius" label="Arc radius" field={curveRadius} units={units} disabled={!editable} />
                    </div>
                  )}
                  {curveMethod === 'sagitta' && (
                    <div className="field-row is-single">
                      <LengthField id="curve-sagitta" label="Bow depth at centre" field={curveSagitta} units={units} disabled={!editable} />
                    </div>
                  )}
                  {curveMethod === 'angle' && (
                    <div className="field">
                      <label htmlFor="curve-angle">Included angle (degrees)</label>
                      <input
                        id="curve-angle"
                        className="num"
                        type="number"
                        min={1}
                        max={359}
                        step={5}
                        value={curveAngleText}
                        disabled={!editable}
                        onChange={(e) => setCurveAngleText(e.target.value)}
                      />
                    </div>
                  )}
                  {curveMethod === 'arc-length' && (
                    <div className="field-row is-single">
                      <LengthField id="curve-arc-length" label="Finished wall length" field={curveArcLength} units={units} disabled={!editable} />
                    </div>
                  )}

                  {curveMethod === 'radius' && selectedWallChord > 0 && (
                    <div className="room-curve-presets" role="group" aria-label="Radius presets">
                      <button
                        type="button"
                        disabled={!editable}
                        onClick={() => curveRadius.setText(formatLength(selectedWallChord / 2, units))}
                      >
                        ½ chord
                      </button>
                      <button
                        type="button"
                        disabled={!editable}
                        onClick={() => curveRadius.setText(formatLength(selectedWallChord, units))}
                      >
                        = chord
                      </button>
                      <button
                        type="button"
                        disabled={!editable}
                        onClick={() => curveRadius.setText(formatLength(selectedWallChord * 1.5, units))}
                      >
                        1.5× chord
                      </button>
                    </div>
                  )}

                  <div className="field">
                    <label>Direction</label>
                    <div className="seg tabs room-curve-direction" role="radiogroup" aria-label="Curve direction">
                      <button
                        type="button"
                        className={!curveOutward ? 'active' : ''}
                        onClick={() => setCurveOutward(false)}
                        disabled={!editable}
                      >
                        <strong>Into room</strong>
                        <small>Gains floor</small>
                      </button>
                      <button
                        type="button"
                        className={curveOutward ? 'active' : ''}
                        onClick={() => setCurveOutward(true)}
                        disabled={!editable}
                      >
                        <strong>Out of room</strong>
                        <small>Bay / bulge</small>
                      </button>
                    </div>
                  </div>

                  {curveMethod === 'radius' && (
                    <div className="field">
                      <label>Arc path</label>
                      <div className="seg tabs room-curve-arc" role="radiogroup" aria-label="Minor or major arc">
                        <button
                          type="button"
                          className={!curveMajor ? 'active' : ''}
                          onClick={() => setCurveMajor(false)}
                          disabled={!editable}
                        >
                          Short way
                        </button>
                        <button
                          type="button"
                          className={curveMajor ? 'active' : ''}
                          onClick={() => setCurveMajor(true)}
                          disabled={!editable}
                        >
                          Long way
                        </button>
                      </div>
                    </div>
                  )}

                  <p className="hint room-curve-summary">
                    {curveMethod === 'radius'
                      ? `Radius ${curveRadius.text || '…'} · ${curveOutward ? 'outward' : 'inward'}${curveMajor ? ' · major arc' : ''}`
                      : curveMethod === 'sagitta'
                        ? `Bow ${curveSagitta.text || '…'} off the chord · ${curveOutward ? 'outward' : 'inward'}`
                        : curveMethod === 'angle'
                          ? `${curveAngleText || '…'}° included · ${curveOutward ? 'outward' : 'inward'}`
                          : `Arc length ${curveArcLength.text || '…'} · ${curveOutward ? 'outward' : 'inward'}`}
                  </p>

                  <div className="actions-row room-edit-actions">
                    <button
                      type="button"
                      className="primary"
                      onClick={() => {
                        if (curveValue == null || !(curveValue > 0)) return;
                        void run('Wall curved', () =>
                          api.roomCurve(editCorner, curveValue, {
                            method: curveMethod,
                            outward: curveOutward,
                            major: curveMethod === 'radius' && curveMajor,
                          }),
                        );
                      }}
                      disabled={!editable || !curveValueReady || !(room.wallDetails?.length)}
                    >
                      Apply curve
                    </button>
                    <button
                      type="button"
                      onClick={() => void run('Wall straightened', () => api.roomCurve(editCorner, 0))}
                      disabled={!editable || !selectedWallCurved}
                      title={selectedWallCurved ? 'Make this wall straight again' : 'Already straight'}
                    >
                      Straighten
                    </button>
                  </div>
                </div>
              )}

              {wallAction === 'length' && (
                <div className="room-edit-card">
                  <div className="room-edit-card-title">
                    <strong>Wall length</strong>
                    <small>Keeps the start corner fixed and moves the far end.</small>
                  </div>
                  <div className="field-row is-single">
                    <LengthField
                      id="wall-length"
                      label="Length"
                      field={wallLengthField}
                      units={units}
                      disabled={!editable || selectedWallCurved}
                    />
                  </div>
                  <div className="actions-row room-edit-actions">
                    <button
                      type="button"
                      className="primary"
                      onClick={() =>
                        void run('Wall length set', () => api.roomWallLength(editCorner, wallLengthField.value!))
                      }
                      disabled={
                        !editable ||
                        selectedWallCurved ||
                        !wallLengthField.positive ||
                        !(room.wallDetails?.length)
                      }
                      title={
                        selectedWallCurved
                          ? 'Straighten this wall before changing its length'
                          : 'Set length from the start corner'
                      }
                    >
                      Set length
                    </button>
                  </div>
                  {selectedWallCurved && (
                    <p className="hint">Straighten the wall first (Curve → Straighten), then set length.</p>
                  )}
                </div>
              )}

              {wallAction === 'move' && (
                <div className="room-edit-card">
                  <div className="room-edit-card-title">
                    <strong>Move corner {editCorner + 1}</strong>
                    <small>The start of this wall. Both walls that meet here will stretch.</small>
                  </div>
                  <div className="field-row">
                    <LengthField id="corner-x" label="X" field={cornerX} units={units} disabled={!editable} />
                    <LengthField id="corner-y" label="Y" field={cornerY} units={units} disabled={!editable} />
                  </div>
                  <div className="actions-row room-edit-actions">
                    <button
                      type="button"
                      className="primary"
                      onClick={() => void run('Corner moved', () =>
                        api.roomCornerMove(editCorner, cornerX.value!, cornerY.value!),
                      )}
                      disabled={!editable || !cornerX.valid || !cornerY.valid}
                    >
                      <IconEdit size={13} />
                      Move corner
                    </button>
                  </div>
                </div>
              )}

              {wallAction === 'round' && (
                <div className="room-edit-card">
                  <div className="room-edit-card-title">
                    <strong>Round corner {editCorner + 1}</strong>
                    <small>Trims the sharp corner into a smooth arc of this radius.</small>
                  </div>
                  <div className="field-row is-single">
                    <LengthField id="corner-radius" label="Corner radius" field={cornerRadius} units={units} disabled={!editable} />
                  </div>
                  <div className="actions-row room-edit-actions">
                    <button
                      type="button"
                      className="primary"
                      onClick={() => void run('Corner rounded', () =>
                        api.roomCornerRound(editCorner, cornerRadius.value!),
                      )}
                      disabled={!editable || !cornerRadius.positive || !selectedCornerCanRound}
                      title={
                        selectedCornerCanRound
                          ? 'Round this corner'
                          : 'Both walls at this corner must be straight'
                      }
                    >
                      Round corner
                    </button>
                    <button
                      type="button"
                      onClick={() => void run('All corners rounded', () =>
                        api.roomCornersRoundAll(cornerRadius.value!),
                      )}
                      disabled={!editable || !cornerRadius.positive || room.curved > 0}
                      title={
                        room.curved > 0
                          ? 'Straighten curved walls before rounding every corner'
                          : 'Round every corner to this radius'
                      }
                    >
                      Round all
                    </button>
                  </div>
                </div>
              )}

              {wallAction === 'corners' && (
                <div className="room-edit-card">
                  <div className="room-edit-card-title">
                    <strong>Add or remove a corner</strong>
                    <small>Split this wall in half, or remove corner {editCorner + 1}.</small>
                  </div>
                  <div className="actions-row room-edit-actions">
                    <button
                      type="button"
                      onClick={() => void run('Corner added', () => api.roomCornerAdd(editCorner))}
                      disabled={!editable || selectedWallCurved}
                      title={
                        selectedWallCurved
                          ? 'Straighten this curved wall before splitting it'
                          : 'Split this wall at its midpoint'
                      }
                    >
                      <IconPlus size={13} />
                      Split wall
                    </button>
                    <button
                      type="button"
                      onClick={() => void run('Corner removed', () => api.roomCornerRemove(editCorner))}
                      disabled={!editable || room.walls <= 3}
                      title={
                        room.walls <= 3
                          ? 'A room needs at least three corners'
                          : 'Remove this corner'
                      }
                    >
                      <IconTrash size={13} />
                      Remove corner
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
        </>
      )}

      {roomPanelTab === 'seating' && (
        <>
      <div className="seating-panel-hero">
        <span className="seating-panel-hero-icon" aria-hidden>
          <IconChair size={20} />
        </span>
        <span className="seating-panel-hero-copy">
          <small>Seating generator</small>
          <strong>Seating planner</strong>
          <span>Design full-room seating with a live capacity preview.</span>
        </span>
        {preview && (
          <span className="seating-panel-hero-count">
            <strong>{preview.seats.toLocaleString()}</strong>
            <small>seats</small>
          </span>
        )}
      </div>

      {/* ---------------------------------------------------------------- */}
      <div className="section">
        <div className="section-title">
          <span>Seating layout</span>
          {preview && (
            <span className="section-count">
              {preview.seats} seat{preview.seats === 1 ? '' : 's'}
              {preview.tables > 0 && `, ${preview.tables} table${preview.tables === 1 ? '' : 's'}`}
            </span>
          )}
        </div>

        <div className="seating-settings-tabs" role="tablist" aria-label="Seating settings">
          {(
            [
              ['seating', 'Layout'],
              ['spacing', 'Spacing'],
              ['av', 'A/V'],
              ['design', 'Advanced'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={erdTab === id}
              className={erdTab === id ? 'active' : ''}
              onClick={() => setErdTab(id)}
            >
              {label}
            </button>
          ))}
        </div>

        {erdTab === 'seating' && (
          <>
            <fieldset className="erd-styles" disabled={!editable}>
              <legend>Style</legend>
              {(
                [
                  ['schoolroom', 'Schoolroom'],
                  ['theatre', 'Theatre'],
                  ['banquet', 'Banquet'],
                  ['hollow-square', 'Hollow Square'],
                  ['u-shape', 'U-Shape'],
                  ['conference', 'Conference'],
                  ['custom', 'Custom'],
                ] as const
              ).map(([id, label]) => (
                <label key={id} className="check">
                  <input
                    type="radio"
                    name="erd-style"
                    checked={rvStyle === id}
                    onChange={() => setRvStyle(id)}
                  />
                  {label}
                </label>
              ))}
            </fieldset>

            {rvStyle === 'custom' && (
              <div className="field">
                <label htmlFor="seat-style">Layout</label>
                <select id="seat-style" value={style} onChange={(e) => setStyle(e.target.value)} disabled={!editable}>
                  {model.seatingStyles.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="field-row">
              <div className="field">
                <label htmlFor="seat-chair-name">Chair type</label>
                <select id="seat-chair-name" value={chair} onChange={(e) => setChair(e.target.value)} disabled={!editable}>
                  <option value="">Choose…</option>
                  {shapeOptions}
                </select>
              </div>
              <div className="field">
                <label htmlFor="seat-table-name">Table type</label>
                <select
                  id="seat-table-name"
                  value={table}
                  onChange={(e) => setTable(e.target.value)}
                  disabled={!editable || !needsTable}
                >
                  <option value="">Choose…</option>
                  {shapeOptions}
                </select>
              </div>
            </div>

            <div className="field-row">
              <div className="field">
                <label htmlFor="seats-per-table">Chairs per table</label>
                <input
                  id="seats-per-table"
                  type="number"
                  min={0}
                  max={24}
                  value={seatsPerTableDraft}
                  disabled={!editable || !needsTable}
                  onChange={(e) => setSeatsPerTableDraft(e.target.value)}
                  onBlur={() => {
                    const n = Number(seatsPerTableDraft);
                    if (!Number.isFinite(n)) setSeatsPerTableDraft('0');
                    else setSeatsPerTableDraft(String(Math.max(0, Math.min(24, Math.round(n)))));
                  }}
                />
              </div>
              <div className="field" style={{ justifyContent: 'center', gap: 8 }}>
                <label
                  className="check"
                  title="Tries each orientation and both stagger settings and keeps whichever seats the most. It never narrows the spacing you asked for — an optimum that quietly closed the aisles would be a fire risk, not a feature."
                >
                  <input
                    type="checkbox"
                    checked={optimum}
                    disabled={!editable}
                    onChange={(e) => setOptimum(e.target.checked)}
                  />
                  Optimum
                </label>
                <label
                  className="check"
                  title="Leaves the stage side of every round open, so nobody is seated with their back to the screen."
                >
                  <input
                    type="checkbox"
                    checked={crescent}
                    disabled={!editable || !needsTable}
                    onChange={(e) => setCrescent(e.target.checked)}
                  />
                  Crescent
                </label>
              </div>
            </div>

            <dl className="prop-grid seating-preview-grid" aria-label="Live seating preview">
              <div>
                <dt>Total seats</dt>
                <dd>{preview?.seats ?? '—'}</dd>
              </div>
              <div>
                <dt>Tables</dt>
                <dd>{preview?.tables ?? '—'}</dd>
              </div>
              <div>
                <dt>Rows</dt>
                <dd>{preview?.rows ?? '—'}</dd>
              </div>
            </dl>
          </>
        )}

        {erdTab === 'spacing' && (
          <>
            <div className="field-row">
              <LengthField id="seat-spacing" label="Seat spacing" field={seatSpacing} units={units} disabled={!editable} />
              <LengthField id="row-spacing" label="Row spacing" field={rowSpacing} units={units} disabled={!editable} />
            </div>
            <div className="field-row">
              <LengthField id="front-clearance" label="Front" hint="Focus to the first row — stage, screen or head table." field={frontClearance} units={units} disabled={!editable} />
              <LengthField id="rear-clearance" label="Rear" hint="Behind the last row." field={rearClearance} units={units} disabled={!editable} />
            </div>
            <div className="field-row">
              <LengthField id="side-clearance" label="Side" hint="The walkway down each side that people use to reach the rows." field={sideClearance} units={units} disabled={!editable} />
              <LengthField id="wing-clearance" label="Wing" hint="Between the centre bank and each angled wing." field={wingClearance} units={units} disabled={!editable} />
            </div>
            <div className="field-row">
              <LengthField id="front-wall" label="Front wall" hint="Front wall to the stage. Not the same as Front, which starts at the stage." field={frontWallClearance} units={units} disabled={!editable} />
              <LengthField id="aisle-clearance" label="Aisle" hint="A cross aisle running side to side, every few rows." field={aisleClearance} units={units} disabled={!editable} />
            </div>
            <div className="field-row">
              <LengthField id="centre-aisle" label="Centre aisle" hint="One aisle straight down the middle. Zero means none." field={centreAisle} units={units} disabled={!editable} />
              <div className="field">
                <label htmlFor="rows-per-block">Rows per block</label>
                <input
                  id="rows-per-block"
                  type="number"
                  min={0}
                  max={60}
                  value={rowsPerBlockDraft}
                  disabled={!editable}
                  onChange={(e) => setRowsPerBlockDraft(e.target.value)}
                  onBlur={() => {
                    const n = Number(rowsPerBlockDraft);
                    if (!Number.isFinite(n) || rowsPerBlockDraft.trim() === '') setRowsPerBlockDraft('');
                    else setRowsPerBlockDraft(String(Math.max(0, Math.min(60, Math.round(n)))));
                  }}
                />
              </div>
            </div>
          </>
        )}

        {erdTab === 'av' && (
          <>
            {av ? (
              <>
                <dl className="prop-grid">
                  <dt>Screens</dt>
                  <dd>{av.screens}</dd>
                  <dt>Seats graded</dt>
                  <dd>{av.seatsGraded}</dd>
                  <dt>Clear</dt>
                  <dd>{av.clear}</dd>
                  <dt>Blocked</dt>
                  <dd>{av.blocked}</dd>
                  <dt>Too far</dt>
                  <dd>{av.tooFar}</dd>
                  <dt>Too close</dt>
                  <dd>{av.tooClose}</dd>
                  <dt>Off-axis</dt>
                  <dd>{av.offAxis}</dd>
                  {av.recommendWidthText ? (
                    <>
                      <dt>Recommended width</dt>
                      <dd>{av.recommendWidthText}</dd>
                    </>
                  ) : null}
                </dl>
                {av.notes.map((note) => (
                  <p className="hint" key={note}>
                    {note}
                  </p>
                ))}
                {onShowSightlineMarkersChange && (
                  <label className="check" style={{ marginTop: 10 }}>
                    <input
                      type="checkbox"
                      checked={showSightlineMarkers}
                      onChange={(event) => onShowSightlineMarkersChange(event.target.checked)}
                    />
                    Show seat grades on the plan
                  </label>
                )}
              </>
            ) : (
              <p className="hint">Loading A/V summary…</p>
            )}
          </>
        )}

        {erdTab === 'design' && (
          <>
            <div className="room-slider-stack">
              <p className="field-hint" style={{ margin: '0 0 8px' }}>
                Splay turns the side banks in towards the stage, so the wings face the screen
                instead of facing across the room. Zero is a single straight block.
              </p>
              <SnappySlider
                label="Bank splay"
                values={[0, 15, 30, 45, 60]}
                defaultValue={0}
                min={0}
                max={60}
                step={1}
                suffix="°"
                compact
                disabled={!editable}
                value={splay}
                onChange={(next) => setSplay(Math.max(0, Math.min(60, next)))}
              />
              <SnappySlider
                label="Tables across"
                values={[0, 4, 8, 12, 20, 40]}
                defaultValue={0}
                min={0}
                max={40}
                step={1}
                compact
                disabled={!editable}
                value={tablesAcross}
                onChange={(next) => setTablesAcross(Math.max(0, next))}
              />
              <SnappySlider
                label="Section centre"
                values={[0, 4, 8, 12, 20, 40]}
                defaultValue={0}
                min={0}
                max={40}
                step={1}
                compact
                disabled={!editable}
                value={sectionCentre}
                onChange={(next) => setSectionCentre(Math.max(0, next))}
              />
              <SnappySlider
                label="Section wing"
                values={[0, 4, 8, 12, 20, 40]}
                defaultValue={0}
                min={0}
                max={40}
                step={1}
                compact
                disabled={!editable}
                value={sectionWing}
                onChange={(next) => setSectionWing(Math.max(0, next))}
              />
            </div>
            <label className="check">
              <input type="checkbox" checked={stagger} disabled={!editable} onChange={(e) => setStagger(e.target.checked)} />
              Stagger alternate rows
            </label>
            {(style === 'banquet' || style === 'cabaret' || style === 'crescent' || rvStyle === 'banquet') && (
              <>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={banquetEndChairs}
                    disabled={!editable}
                    onChange={(e) => setBanquetEndChairs(e.target.checked)}
                  />
                  Banquet end chairs
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={banquetRotate90}
                    disabled={!editable}
                    onChange={(e) => setBanquetRotate90(e.target.checked)}
                  />
                  Banquet rotate 90°
                </label>
              </>
            )}
            {(style === 'schoolroom' || style === 'conference' || style === 'u-shape' || style === 'hollow-square') && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={chairsBothSides}
                  disabled={!editable}
                  onChange={(e) => setChairsBothSides(e.target.checked)}
                />
                Chairs both sides (block)
              </label>
            )}
            <p className="hint">Section centre/wing counts enable sectioning when either is greater than zero.</p>
          </>
        )}

        {preview?.notes.map((note) => (
          <p className="hint" key={note}>
            {note}
          </p>
        ))}

        <div className="seating-placement-mode">
          <span>Placement mode</span>
          <div className="seg tabs" role="radiogroup" aria-label="Seating placement mode">
            <button
              type="button"
              role="radio"
              aria-checked={seatingPlacementMode === 'replace'}
              className={seatingPlacementMode === 'replace' ? 'active' : ''}
              onClick={() => setSeatingPlacementMode('replace')}
              disabled={!editable}
            >
              Replace layout
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={seatingPlacementMode === 'add'}
              className={seatingPlacementMode === 'add' ? 'active' : ''}
              onClick={() => setSeatingPlacementMode('add')}
              disabled={!editable}
            >
              Add section
            </button>
          </div>
        </div>

        <div className="actions-row">
          <button
            className="btn-primary seating-place-button"
            onClick={() =>
              void run(
                seatingPlacementMode === 'add' ? 'Seating section added' : 'Seating placed',
                () => api.seatingApply(seatingRequest, chair, table || undefined),
              ).then((ok) => {
                if (ok) onSeatingApplied?.();
              })
            }
            disabled={!editable || !room || !chair || (needsTable && !table) || !preview?.seats}
            title={
              !room
                ? 'Draw a room first'
                : !chair
                  ? 'Choose a chair to place'
                  : seatingPlacementMode === 'add'
                    ? 'Add this as another seating section'
                    : 'Place this layout, replacing managed seating'
            }
          >
            <IconPlus size={14} />
            {seatingPlacementMode === 'add' ? 'Add seating section' : 'Place seating'}
          </button>
        </div>
        <p className="hint">
          The count above is what the room will actually take — seats that fall outside the walls, inside a column or on
          reserved floor are left out. Replace keeps one managed layout; Add section preserves the existing banks for
          multi-part arrangements.
        </p>
      </div>
        </>
      )}

      {roomPanelTab === 'more' && (
        <>
      {room && (
        <div className="section">
          <div className="section-title">
            <span>Capacity</span>
          </div>
          <table className="capacity-table">
            <thead>
              <tr>
                <th>Layout</th>
                <th>People</th>
                <th>Each</th>
              </tr>
            </thead>
            <tbody>
              {room.capacities.map((c) => (
                <tr key={c.layout}>
                  <td>{c.layout}</td>
                  <td>{c.low === c.high ? c.low : `${c.low}–${c.high}`}</td>
                  <td>{c.squareFeetEach} sq ft</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">
            Estimated from usable floor area — not an occupancy figure.
          </p>
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      <div className="section">
        <div className="section-title">
          <span>Stage</span>
        </div>
        <div className="field-row">
          <LengthField id="stage-width" label="Width" field={stageWidth} units={units} disabled={!editable} />
          <LengthField id="stage-depth" label="Depth" field={stageDepth} units={units} disabled={!editable} />
        </div>
        <LengthField id="stage-height" label="Deck height" field={stageHeight} units={units} disabled={!editable} />

        <div className="actions-row">
          <button
            onClick={() =>
              void run('Stage added', () =>
                api.stageAdd(
                  stageOrigin.x - (stageWidth.value ?? 0) / 2,
                  stageOrigin.y,
                  stageWidth.value!,
                  stageDepth.value!,
                  stageHeight.value!,
                ),
              )
            }
            disabled={!editable || !stageWidth.positive || !stageDepth.positive}
            title="Build a stage from stock decks"
          >
            <IconPlus size={14} />
            Add stage
          </button>
        </div>

        {model.stage && (
          <>
            <table className="capacity-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Qty</th>
                </tr>
              </thead>
              <tbody>
                {model.stage.buildList.map((line) => (
                  <tr key={line.item}>
                    <td>
                      {line.item}
                      {line.detail && <span className="muted"> — {line.detail}</span>}
                    </td>
                    <td>{line.quantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {model.stage.warnings.map((warning) => (
              <div className="notice" role="status" key={warning}>
                <IconWarning size={14} />
                <span>{warning}</span>
              </div>
            ))}
          </>
        )}
        <p className="hint">
          The stage is drawn as one object whose outline shows every deck, so the layout is visible and it still moves
          and counts as a single item. Its floor is taken out of the seating count.
        </p>
      </div>

      {/* ---------------------------------------------------------------- */}
      <div className="section">
        <div className="section-title">
          <span>Report</span>
        </div>
        <p className="hint">
          The room, its capacity, the seating, the stage build list and the legend, as one document.
        </p>
        <div className="actions-row">
          <button
            onClick={async () => {
              const reply = await api.reportExport({
                units,
                scale: '1/8" = 1\'',
                seating: room ? seatingRequest : undefined,
              });
              if (reply.cancelled) return;
              if (!reply.ok) onError(reply.reason ?? 'the report could not be written');
              else onStatus(`Report saved to ${reply.path}`);
            }}
            disabled={busy}
          >
            Export report…
          </button>
        </div>
      </div>
        </>
      )}
    </>
  );
}
