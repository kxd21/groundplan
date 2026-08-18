/**
 * The plan's model, as the window sees it.
 *
 * Everything the format layer learned to do — rooms, curves, parametric
 * seating, stage builds, sightlines, allocation — reaches the UI through here.
 * The renderer never sees a `RoomModel` or a `SeatingPlan`; it sees numbers and
 * text it can put on screen, and sends back intents.
 *
 * Two pieces of state live for as long as the document is open:
 *
 *   - **The companion.** Loaded when a plan opens, written when it saves. A
 *     plan with none gets a room derived from its own wall geometry, so every
 *     one of the files that already exist has area, perimeter and capacity on
 *     first open without anyone redrawing anything.
 *   - **What was last drawn.** The room as it was rendered, and the object ids
 *     the seating produced. Both are what make redrawing replace rather than
 *     accumulate, and neither can be recovered from the `.rv4`, which is why
 *     they are held here and persisted beside it.
 */

import { allocate, summariseAllocation, type Allocation } from '../format/allocation.js';
import { createDimension } from '../format/annotate.js';
import { placeGear } from '../format/place.js';
import {
  checkSightlines,
  recommendImageWidth,
  screensFromItems,
  summariseSightlines,
  type Screen,
  type SightlineSummary,
  type SightlineVerdict,
} from '../format/av.js';
import type { CompanionDocument, PlanBackground } from '../format/companion.js';
import { createCompanion, parsePlanBackground } from '../format/companion.js';
import { instanceKey, resolveInstances, SpecLibrary, type PlacedItem } from '../format/definition.js';
import { dimensionRoom as dimensionRoomDrawings } from '../format/dimension.js';
import { renderDimensions } from '../format/dimension-render.js';
import { buildLegend, defaultLayers, titleBlockFor } from '../format/layers.js';
import { buildNewRoom, type NewRoomSpec } from '../format/new-room.js';
import { buildReport } from '../format/report.js';
import {
  allCapacities,
  arcOf,
  circularRoom,
  deriveRoom,
  describeRoom,
  rectangularRoom,
  roomArea,
  roomBounds,
  roomFromPolygon,
  roomPerimeter,
  simplifyCollinear,
  wallLength,
  type RoomModel,
} from '../format/room.js';
import {
  addCorner,
  combineRooms,
  curveWall,
  fitWallThroughPoint,
  isAxisAligned,
  moveCorner,
  rectRoom,
  removeCorner,
  roundAllCorners,
  roomProblems,
  roundCorner,
  setWallLength,
  setWallRadius,
  setWallSagitta,
  setWallAngle,
  setWallArcLength,
  offsetWall,
  type RoomEditResult,
} from '../format/room-edit.js';
import { applyRoom } from '../format/room-render.js';
import {
  createSeatingPlan,
  solveOptimum,
  solveSeating,
  STYLE_DEFAULTS,
  type SeatingPlan,
  type SeatingSolution,
  type SeatingStyle,
} from '../format/seating-plan.js';
import { renderSeating } from '../format/seating-render.js';
import {
  simpleStage,
  solveStage,
  stageBuildList,
  stageReservedAreas,
  stageWarnings,
  stairDeckOutlines,
  tieredStage,
  type StageBuild,
} from '../format/stage.js';
import { formatArea, formatLength, type UnitSystem } from '../format/units.js';
import { UNITS_PER_FOOT, type Point, type RVDocument } from '../format/rv.js';
import { addRoot, appendChild, indexDocument } from '../format/edit.js';
import { planBody, planName } from '../format/plan-skeleton.js';
import { createSegment, createShape } from '../format/synthesize.js';
import { companionPathFor, loadCompanion, saveCompanion } from './companion-store.js';
import type { Session } from './session.js';

// ---------------------------------------------------------------------------
// State that belongs to the open document
// ---------------------------------------------------------------------------

interface PlanModelState {
  companion: CompanionDocument | null;
  freshness: 'fresh' | 'stale' | 'missing';
  reason?: string;
  derived: boolean;
  /** The room as it was last drawn, so redrawing can find and move it. */
  rendered: RoomModel | null;
  /**
   * How a room that nobody authored was arrived at.
   *
   * A derived room is put in the companion so everything downstream has one to
   * work with, but it must not then claim to have come from the companion — the
   * difference between "traced off the walls" and "the extent of the drawing"
   * is exactly what the user needs to judge the area by.
   */
  derivedSource: 'walls' | 'region' | 'extent' | 'none';
  /** Objects created by every currently managed seating section. */
  seatingIds: number[];
  /** Counts for managed seating on the drawing (preview counts are separate). */
  placedSeatCounts: { chairs: number; tables: number } | null;
  /** Clearances from the last seating preview/apply, for the status bar. */
  lastClearances: {
    front: number;
    side: number;
    wing: number;
    rear: number;
    centreAisle: number;
    perimeter: number;
    aisle: number;
    frontWall: number;
  } | null;
  lastSeatCounts: { chairs: number; tables: number } | null;
  /** The stage as last built, for the report. */
  stage: StageBuild | null;
}

const EMPTY: PlanModelState = {
  companion: null,
  freshness: 'missing',
  derived: true,
  derivedSource: 'none',
  rendered: null,
  seatingIds: [],
  placedSeatCounts: null,
  lastClearances: null,
  lastSeatCounts: null,
  stage: null,
};

let state: PlanModelState = { ...EMPTY };

/** Ceiling entered at New Plan before walls exist (custom / site-plan path). */
let pendingCeilingHeight: number | undefined;

export function resetPlanModel(): void {
  state = { ...EMPTY };
  pendingCeilingHeight = undefined;
}

/** Remember a ceiling height until the first authored room lands. */
export function setPendingCeilingHeight(height: number | undefined): void {
  pendingCeilingHeight =
    typeof height === 'number' && Number.isFinite(height) && height > 0 ? height : undefined;
}

function takePendingCeiling(room: RoomModel): RoomModel {
  if (room.ceilingHeight && room.ceilingHeight > 0) return room;
  if (!pendingCeilingHeight) return room;
  const height = pendingCeilingHeight;
  pendingCeilingHeight = undefined;
  return { ...room, ceilingHeight: height };
}

/** Reads the companion beside a plan, or derives one from the drawing. */
export async function openPlanModel(planPath: string, doc: RVDocument, units: UnitSystem): Promise<void> {
  const loaded = await loadCompanion(planPath, doc, units);
  state = {
    companion: loaded.companion,
    freshness: loaded.freshness,
    reason: loaded.reason,
    derived: loaded.derived,
    derivedSource: loaded.derived ? deriveRoom(doc).source : 'none',
    // A companion that is fresh describes what is drawn, so its room is also
    // what was last rendered. A derived one was read back off the drawing,
    // which amounts to the same thing.
    rendered: loaded.companion.rooms[0] ?? null,
    seatingIds: [],
    placedSeatCounts: null,
    lastClearances: null,
    lastSeatCounts: null,
    stage: loaded.companion.stage ?? null,
  };
}

/**
 * Writes the companion, if there is anything worth keeping.
 *
 * Takes the archive body that was written rather than the document, because the
 * fingerprint has to describe what reached disk.
 */
export async function savePlanModel(planPath: string, body: Buffer): Promise<void> {
  const companion = state.companion;
  if (!companion) return;
  // Nothing has been authored: the room in there was read off the drawing and
  // can be read off it again, so writing a sidecar would only litter the folder
  // beside a plan the user never touched.
  const worthKeeping =
    !state.derived ||
    !!companion.background ||
    !!companion.stage ||
    companion.overrides.length > 0 ||
    companion.library.length > 0;
  if (!worthKeeping) return;
  await saveCompanion(planPath, body, companion);
  state.freshness = 'fresh';
}

/** In-memory companion for crash journals (may include unsaved room/meta). */
export function companionSnapshot(): CompanionDocument | null {
  return state.companion ? structuredClone(state.companion) : null;
}

/** Restores a companion recovered from the crash journal. */
export function adoptCompanionSnapshot(companion: CompanionDocument): void {
  state.companion = companion;
  state.derived = companion.roomIsDerived === true;
  state.freshness = 'fresh';
  state.reason = undefined;
  state.rendered = companion.rooms[0] ?? null;
  state.derivedSource = state.derived ? state.derivedSource : 'none';
  state.stage = companion.stage ?? null;
}

/** The current room, from the companion or derived from the drawing. */
function currentRoom(doc: RVDocument): RoomModel | null {
  const saved = state.companion?.rooms[0];
  if (saved && saved.walls.length >= 3 && state.freshness !== 'stale') return saved;
  const derived = deriveRoom(doc);
  return derived.room.walls.length >= 3 ? derived.room : null;
}

function setRoom(doc: RVDocument, room: RoomModel, units: UnitSystem): void {
  if (!state.companion) state.companion = createCompanion(doc, units);
  state.companion.rooms = [room];
  state.companion.roomIsDerived = false;
  state.derived = false;
}

/**
 * Marks geometry created by New Plan as authored, preserving its exact arcs in
 * the companion instead of re-deriving only the flattened RV polylines.
 */
export function adoptAuthoredRoom(session: Session, room: RoomModel, units: UnitSystem): void {
  const next = takePendingCeiling(room);
  setRoom(session.loaded.document, next, units);
  state.rendered = next;
  state.derivedSource = 'none';
  state.reason = undefined;
}

/** Uniformly scales the companion underlay about the plan origin (same as RV geometry). */
export function scaleCompanionBackground(factor: number): PlanBackground | null {
  const background = state.companion?.background;
  if (!background) return null;
  if (!Number.isFinite(factor) || factor <= 0) return background;
  const next: PlanBackground = {
    ...background,
    x: background.x * factor,
    y: background.y * factor,
    width: background.width * factor,
    height: background.height * factor,
  };
  state.companion!.background = next;
  return next;
}

/** Sets or removes the raster underlay and persists it without dirtying the RV file. */
export async function updatePlanBackground(
  session: Session,
  value: unknown,
  units: UnitSystem,
): Promise<{ ok: boolean; reason?: string; background?: PlanBackground | null }> {
  const background = value == null ? null : parsePlanBackground(value);
  if (value != null && !background) return { ok: false, reason: 'that background image is invalid' };
  if (!state.companion) state.companion = createCompanion(session.loaded.document, units);
  state.companion.background = background ?? undefined;
  state.companion.roomIsDerived = state.derived;
  // Fingerprint the last disk revision, never dirty in-memory edits — otherwise
  // a background-only write would claim the companion matches unsaved RV bytes.
  await saveCompanion(session.path, session.savedArchiveBody(), state.companion);
  state.freshness = 'fresh';
  return { ok: true, background };
}

/** Renames the room and/or sets ceiling height on the companion model. */
export function updateRoomMeta(
  session: Session,
  patch: { name?: string; ceilingHeight?: number },
  units: UnitSystem,
): ModelEdit {
  const doc = session.loaded.document;
  const room = currentRoom(doc);
  if (!room) return { ok: false, reason: 'there is no room to update yet' };
  const next: RoomModel = { ...room };
  if (typeof patch.name === 'string' && patch.name.trim()) next.name = patch.name.trim();
  if (patch.ceilingHeight != null) {
    next.ceilingHeight = patch.ceilingHeight > 0 ? patch.ceilingHeight : undefined;
  }
  setRoom(doc, next, units);
  return { ok: true };
}

export interface AvSummaryView {
  screens: number;
  seatsGraded: number;
  clear: number;
  blocked: number;
  tooFar: number;
  tooClose: number;
  offAxis: number;
  notes: string[];
  recommendWidthText: string;
}

/** Sightline / screen summary for the Event Room Data A/V tab. */
export function avSummary(session: Session, units: UnitSystem): AvSummaryView {
  const doc = session.loaded.document;
  const items = placedItems(doc);
  const screens = screensFromItems(items);
  const seats = items
    .filter((item) => /chair|seat/i.test(item.name) || /chair/i.test(item.spec?.category ?? ''))
    .map((item, index) => ({
      x: item.x,
      y: item.y,
      rotation: item.rotation,
      row: 0,
      seat: index,
      section: 0,
    }));
  if (!screens.length) {
    return {
      screens: 0,
      seatsGraded: 0,
      clear: 0,
      blocked: 0,
      tooFar: 0,
      tooClose: 0,
      offAxis: 0,
      notes: ['No screen targets on the plan yet. Place a screen or mark a stage as a sight target.'],
      recommendWidthText: '',
    };
  }
  const primary = screens[0]!;
  const summary = summariseSightlines(checkSightlines(seats, primary, items));
  const recommend = recommendImageWidth(seats, primary);
  return {
    screens: screens.length,
    seatsGraded: summary.total,
    clear: summary.clear,
    blocked: summary.blocked,
    tooFar: summary.tooFar,
    tooClose: summary.tooClose,
    offAxis: summary.offAxis,
    notes: summary.notes,
    recommendWidthText: recommend > 0 ? formatLength(recommend, units) : '',
  };
}

// ---------------------------------------------------------------------------
// What the renderer is given
// ---------------------------------------------------------------------------

export interface RoomWallSummary {
  index: number;
  /** The corner that begins this wall, for outline editing controls. */
  startX: number;
  startY: number;
  startXText: string;
  startYText: string;
  /** The corner that ends this wall. */
  endX: number;
  endY: number;
  /** Chord / arc length in logical units. */
  length: number;
  lengthText: string;
  curved: boolean;
  /** Arc radius in logical units when curved; otherwise 0. */
  radius: number;
  radiusText: string;
  /** Signed bulge (0 when straight). Used for mid-wall curve handles. */
  bulge: number;
}

export interface RoomSummary {
  name: string;
  /** Best description of the authored boundary, for safe redraw defaults. */
  shape: 'rectangle' | 'circle' | 'custom';
  /** How the outline was arrived at, so the UI can be honest about it. */
  source: 'companion' | 'walls' | 'region' | 'extent' | 'none';
  closed: boolean;
  walls: number;
  /** Per-wall facts for curve / reshape controls. */
  wallDetails: RoomWallSummary[];
  holes: number;
  curved: number;
  /** True when every wall is axis-aligned and straight — required for Add/Cut rectangle. */
  axisAligned: boolean;
  /** Raw logical units, for anything that needs to compute. */
  area: number;
  perimeter: number;
  width: number;
  height: number;
  /** Ceiling height in logical units, when known. */
  ceilingHeight: number;
  /** Top-left of the room's bounds, so callers can position against it. */
  x: number;
  y: number;
  /** Ready to display in the user's units. */
  areaText: string;
  perimeterText: string;
  sizeText: string;
  ceilingText: string;
  summary: string;
  problems: string[];
  capacities: Array<{ layout: string; low: number; high: number; squareFeetEach: number }>;
}

export interface PlanModelView {
  units: UnitSystem;
  room: RoomSummary | null;
  companion: {
    freshness: 'fresh' | 'stale' | 'missing';
    reason?: string;
    derived: boolean;
    path: string;
  };
  /** Raster site plan or venue image drawn below the plot. */
  background: PlanBackground | null;
  /** Layout styles the seating panel offers. */
  seatingStyles: Array<{ id: SeatingStyle; label: string; needsTable: boolean }>;
  /** Placed items, summarised — what the allocation and legend are built from. */
  itemCount: number;
  /** Last seating clearances / counts for the status bar. */
  seatingStatus: {
    clearances: NonNullable<PlanModelState['lastClearances']>;
    chairs: number;
    tables: number;
  } | null;
  stage: { present: boolean; buildList: Array<{ item: string; quantity: number; detail?: string }>; warnings: string[] } | null;
}

const STYLE_LABELS: Record<SeatingStyle, string> = {
  theatre: 'Theatre',
  'theatre-curved': 'Theatre, curved',
  chevron: 'Chevron',
  schoolroom: 'Classroom',
  banquet: 'Banquet rounds',
  cabaret: 'Cabaret',
  crescent: 'Crescent rounds',
  conference: 'Conference',
  'u-shape': 'U-shape',
  'hollow-square': 'Hollow square',
  reception: 'Reception',
  perimeter: 'Perimeter',
};

const TABLE_STYLES = new Set<SeatingStyle>([
  'banquet',
  'cabaret',
  'crescent',
  'schoolroom',
  'conference',
  'u-shape',
  'hollow-square',
  'reception',
]);

function summarise(room: RoomModel | null, source: RoomSummary['source'], units: UnitSystem): RoomSummary | null {
  if (!room || room.walls.length < 3) return null;
  const bounds = roomBounds(room);
  const width = bounds ? bounds.maxX - bounds.minX : 0;
  const height = bounds ? bounds.maxY - bounds.minY : 0;
  const arcs = room.walls.map((segment) => arcOf(segment));
  const looksCircular =
    room.walls.length === 4 &&
    arcs.every((arc) => !!arc && Math.abs(Math.abs(arc.sweep) - Math.PI / 2) < 1e-6) &&
    arcs.every((arc) => !arc || Math.abs(arc.radius - (arcs[0]?.radius ?? 0)) <= 1);
  const lengths = room.walls.map((segment) => wallLength(segment));
  const looksRectangular =
    room.walls.length === 4 &&
    room.walls.every((segment) => !segment.bulge) &&
    room.walls.every((segment, index) => {
      const next = room.walls[(index + 1) % room.walls.length];
      const ax = segment.end.x - segment.start.x;
      const ay = segment.end.y - segment.start.y;
      const bx = next.end.x - next.start.x;
      const by = next.end.y - next.start.y;
      return Math.abs(ax * bx + ay * by) <= Math.max(1, lengths[index] * lengths[(index + 1) % 4] * 1e-6);
    }) &&
    Math.abs(lengths[0] - lengths[2]) <= 1 &&
    Math.abs(lengths[1] - lengths[3]) <= 1;

  return {
    name: room.name,
    shape: looksCircular ? 'circle' : looksRectangular ? 'rectangle' : 'custom',
    source,
    closed: roomProblems(room).length === 0,
    walls: room.walls.length,
    wallDetails: room.walls.map((segment, index) => {
      const arc = arcOf(segment);
      const length = wallLength(segment);
      return {
        index,
        startX: segment.start.x,
        startY: segment.start.y,
        startXText: formatLength(segment.start.x, units),
        startYText: formatLength(segment.start.y, units),
        endX: segment.end.x,
        endY: segment.end.y,
        length,
        lengthText: formatLength(length, units),
        curved: Boolean(segment.bulge),
        radius: arc?.radius ?? 0,
        radiusText: arc ? formatLength(arc.radius, units) : '',
        bulge: segment.bulge ?? 0,
      };
    }),
    holes: room.holes.length,
    curved: room.walls.filter((w) => w.bulge).length,
    axisAligned: isAxisAligned(room.walls),
    area: roomArea(room),
    perimeter: roomPerimeter(room),
    width,
    height,
    ceilingHeight: room.ceilingHeight && room.ceilingHeight > 0 ? room.ceilingHeight : 0,
    x: bounds ? bounds.minX : 0,
    y: bounds ? bounds.minY : 0,
    areaText: formatArea(roomArea(room), units),
    perimeterText: formatLength(roomPerimeter(room), units),
    sizeText:
      room.ceilingHeight && room.ceilingHeight > 0
        ? `${formatLength(width, units)} × ${formatLength(height, units)} × ${formatLength(room.ceilingHeight, units)} ceiling`
        : `${formatLength(width, units)} × ${formatLength(height, units)}`,
    ceilingText:
      room.ceilingHeight && room.ceilingHeight > 0 ? formatLength(room.ceilingHeight, units) : '',
    summary: describeRoom(room),
    problems: roomProblems(room),
    capacities: allCapacities(room),
  };
}

export function planModelView(session: Session, units: UnitSystem): PlanModelView {
  const doc = session.loaded.document;
  const roomResolved = resolvePlanRoom(doc);
  const room = roomResolved.room;
  const source: RoomSummary['source'] = roomResolved.source;

  const stageSolution = state.stage ? solveStage(state.stage) : null;

  return {
    units,
    room: summarise(room, source, units),
    companion: {
      freshness: state.freshness,
      reason:
        state.reason ??
        (roomResolved.derivedDetail ? describeSource(roomResolved.derivedDetail) : undefined),
      derived: state.derived,
      path: companionPathFor(session.path),
    },
    background: state.companion?.background ?? null,
    seatingStyles: (Object.keys(STYLE_DEFAULTS) as SeatingStyle[]).map((id) => ({
      id,
      label: STYLE_LABELS[id],
      needsTable: TABLE_STYLES.has(id),
    })),
    itemCount: placedItems(doc).length,
    seatingStatus:
      state.lastClearances && state.lastSeatCounts
        ? {
            clearances: state.lastClearances,
            chairs: state.lastSeatCounts.chairs,
            tables: state.lastSeatCounts.tables,
          }
        : null,
    stage:
      state.stage && stageSolution
        ? {
            present: true,
            buildList: stageBuildList(state.stage, stageSolution),
            warnings: [...stageSolution.notes, ...stageWarnings(state.stage)],
          }
        : null,
  };
}

/**
 * Authored companion room when fresh, otherwise the room derived from walls.
 * Shared by seating, wall setback, and the model view.
 */
export function resolvePlanRoom(doc: RVDocument): {
  room: RoomModel;
  source: RoomSummary['source'];
  derivedDetail?: ReturnType<typeof deriveRoom>['source'];
} {
  const saved = state.companion?.rooms[0];
  const usingSaved = !!saved && saved.walls.length >= 3 && state.freshness !== 'stale';
  if (usingSaved) {
    return {
      room: saved!,
      source: state.derived ? state.derivedSource : 'companion',
    };
  }
  const derived = deriveRoom(doc);
  return {
    room: derived.room,
    source: derived.source,
    derivedDetail: derived.source,
  };
}

function describeSource(source: 'walls' | 'region' | 'extent' | 'none'): string | undefined {
  if (source === 'extent') {
    return 'No wall outline could be traced, so this is the extent of the drawing. Treat the area as an over-estimate.';
  }
  if (source === 'none') return 'This plan has no wall geometry, so it has no room outline yet.';
  return undefined;
}

function placedItems(doc: RVDocument): PlacedItem[] {
  const library = new SpecLibrary(state.companion?.library ?? []);
  return resolveInstances(doc, library, state.companion?.overrides ?? []);
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export interface ModelEdit {
  ok: boolean;
  reason?: string;
  created?: number[];
  /** Something worth telling the user that is not a failure. */
  note?: string;
}

/** Replaces the authored room while preserving conflict reporting and undo. */
function replaceAuthoredRoom(session: Session, room: RoomModel, units: UnitSystem): ModelEdit {
  const doc = session.loaded.document;
  // Prefer the companion's last render; if missing (opened plan, no sidecar),
  // fall back to the derived current room so Redraw replaces walls instead of stacking.
  const previous = state.rendered ?? currentRoom(doc) ?? undefined;
  // Keep ceiling / name across redraws unless the new room already sets them.
  const next: RoomModel = takePendingCeiling({
    ...room,
    name: room.name || previous?.name || 'Room',
    ceilingHeight: room.ceilingHeight ?? previous?.ceilingHeight,
  });
  const drawn = applyRoom(doc, next, previous);
  if (!drawn.ok) return { ok: false, reason: drawn.reason };

  state.rendered = next;
  setRoom(doc, next, units);
  return {
    ok: true,
    created: drawn.createdIds,
    note:
      drawn.unmatched > 0
        ? `${drawn.unmatched} wall${drawn.unmatched === 1 ? '' : 's'} from the previous room could not be found and ${
            drawn.unmatched === 1 ? 'was' : 'were'
          } left alone.`
        : undefined,
  };
}

/** Draws a rectangular room, replacing whatever this drew before. */
export function createRectangularRoom(
  session: Session,
  width: number,
  height: number,
  units: UnitSystem,
): ModelEdit {
  if (!(width > 0) || !(height > 0)) return { ok: false, reason: 'enter a width and a depth' };
  if (width > 2000 * UNITS_PER_FOOT || height > 2000 * UNITS_PER_FOOT) {
    return { ok: false, reason: 'that is larger than any room this format can hold' };
  }

  const bounds = state.rendered ? roomBounds(state.rendered) : null;
  const origin = bounds ? { x: bounds.minX, y: bounds.minY } : { x: 0, y: 0 };
  const room = rectangularRoom(width, height, state.rendered?.name ?? planName(session.loaded.document) ?? 'Room', origin);

  return replaceAuthoredRoom(session, room, units);
}

/** Draws a true circular room, replacing the previously authored outline. */
export function createCircularRoom(session: Session, diameter: number, units: UnitSystem): ModelEdit {
  if (!(diameter > 0)) return { ok: false, reason: 'enter a positive diameter' };
  if (diameter > 2000 * UNITS_PER_FOOT) {
    return { ok: false, reason: 'that is larger than any room this format can hold' };
  }

  const bounds = state.rendered ? roomBounds(state.rendered) : null;
  const origin = bounds ? { x: bounds.minX, y: bounds.minY } : { x: 0, y: 0 };
  const room = circularRoom(diameter, state.rendered?.name ?? planName(session.loaded.document) ?? 'Room', origin);
  return replaceAuthoredRoom(session, room, units);
}

/** Draws advanced New Plan geometry (L/U/stadium/rounded/curves) onto the open plan. */
export function createRoomFromSpec(session: Session, spec: NewRoomSpec, units: UnitSystem): ModelEdit {
  const name = state.rendered?.name ?? planName(session.loaded.document) ?? 'Room';
  const built = buildNewRoom(spec, name);
  if (!built.ok || !built.room) return { ok: false, reason: built.reason ?? 'that room could not be built' };
  return replaceAuthoredRoom(session, built.room, units);
}

const OUTLINE_TOLERANCE = 1;

function orientation(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegment(a: Point, b: Point, point: Point): boolean {
  return (
    Math.abs(orientation(a, b, point)) <= OUTLINE_TOLERANCE &&
    point.x >= Math.min(a.x, b.x) - OUTLINE_TOLERANCE &&
    point.x <= Math.max(a.x, b.x) + OUTLINE_TOLERANCE &&
    point.y >= Math.min(a.y, b.y) - OUTLINE_TOLERANCE &&
    point.y <= Math.max(a.y, b.y) + OUTLINE_TOLERANCE
  );
}

function segmentsMeet(a: Point, b: Point, c: Point, d: Point): boolean {
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);
  const abStraddles =
    (abC > OUTLINE_TOLERANCE && abD < -OUTLINE_TOLERANCE) ||
    (abC < -OUTLINE_TOLERANCE && abD > OUTLINE_TOLERANCE);
  const cdStraddles =
    (cdA > OUTLINE_TOLERANCE && cdB < -OUTLINE_TOLERANCE) ||
    (cdA < -OUTLINE_TOLERANCE && cdB > OUTLINE_TOLERANCE);
  if (abStraddles && cdStraddles) return true;
  return (
    onSegment(a, b, c) ||
    onSegment(a, b, d) ||
    onSegment(c, d, a) ||
    onSegment(c, d, b)
  );
}

function outlineCrossesItself(points: Point[]): boolean {
  for (let first = 0; first < points.length; first++) {
    const firstNext = (first + 1) % points.length;
    for (let second = first + 1; second < points.length; second++) {
      const secondNext = (second + 1) % points.length;
      // Neighbouring walls are meant to share one corner.
      if (first === second || firstNext === second || secondNext === first) continue;
      if (segmentsMeet(points[first], points[firstNext], points[second], points[secondNext])) return true;
    }
  }
  return false;
}

/** Draws a closed room from corners clicked in order on the plan. */
export function createPolygonalRoom(session: Session, input: Point[], units: UnitSystem): ModelEdit {
  if (!Array.isArray(input)) return { ok: false, reason: 'the room outline is invalid' };
  if (input.length > 512) return { ok: false, reason: 'this outline has too many corners' };

  const clean: Point[] = [];
  for (const point of input) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      return { ok: false, reason: 'every room corner needs a valid position' };
    }
    const previous = clean[clean.length - 1];
    if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) > OUTLINE_TOLERANCE) {
      clean.push({ x: point.x, y: point.y });
    }
  }
  if (
    clean.length > 1 &&
    Math.hypot(clean[0].x - clean.at(-1)!.x, clean[0].y - clean.at(-1)!.y) <= OUTLINE_TOLERANCE
  ) {
    clean.pop();
  }

  const corners = simplifyCollinear(clean, OUTLINE_TOLERANCE);
  if (corners.length < 3) return { ok: false, reason: 'click at least three different corners' };
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  if (
    Math.max(...xs) - Math.min(...xs) > 2000 * UNITS_PER_FOOT ||
    Math.max(...ys) - Math.min(...ys) > 2000 * UNITS_PER_FOOT
  ) {
    return { ok: false, reason: 'that is larger than any room this format can hold' };
  }
  if (outlineCrossesItself(corners)) {
    return { ok: false, reason: 'the room outline crosses itself. Undo a corner and trace around the edge in order' };
  }

  const room = roomFromPolygon(corners, state.rendered?.name ?? planName(session.loaded.document) ?? 'Room');
  if (roomArea(room) <= 1) return { ok: false, reason: 'the room outline does not enclose any floor' };
  return replaceAuthoredRoom(session, room, units);
}

function commitRoomEdit(
  session: Session,
  current: RoomModel,
  edited: RoomEditResult,
  units: UnitSystem,
): ModelEdit {
  if (!edited.ok || !edited.room) return { ok: false, reason: edited.reason };
  const doc = session.loaded.document;
  const drawn = applyRoom(doc, edited.room, state.rendered ?? current);
  if (!drawn.ok) return { ok: false, reason: drawn.reason };
  state.rendered = edited.room;
  setRoom(doc, edited.room, units);
  return {
    ok: true,
    created: drawn.createdIds,
    note:
      drawn.unmatched > 0
        ? `${drawn.unmatched} wall${drawn.unmatched === 1 ? '' : 's'} from the previous room could not be found and ${
            drawn.unmatched === 1 ? 'was' : 'were'
          } left alone.`
        : undefined,
  };
}

/** Moves one outline corner and stretches its adjoining plot lines. */
export function moveRoomCorner(
  session: Session,
  index: number,
  x: number,
  y: number,
  units: UnitSystem,
): ModelEdit {
  const room = currentRoom(session.loaded.document);
  if (!room) return { ok: false, reason: 'there is no room to adjust yet' };
  return commitRoomEdit(session, room, moveCorner(room, index, { x, y }), units);
}

/** Splits one wall at its midpoint, adding a corner and another plot line. */
export function addRoomCorner(session: Session, wallIndex: number, units: UnitSystem): ModelEdit {
  const room = currentRoom(session.loaded.document);
  if (!room) return { ok: false, reason: 'there is no room to adjust yet' };
  return commitRoomEdit(session, room, addCorner(room, wallIndex), units);
}

/** Removes one corner and joins its neighbouring plot lines. */
export function removeRoomCorner(session: Session, index: number, units: UnitSystem): ModelEdit {
  const room = currentRoom(session.loaded.document);
  if (!room) return { ok: false, reason: 'there is no room to adjust yet' };
  return commitRoomEdit(session, room, removeCorner(room, index), units);
}

/** Trims the adjoining walls and inserts a tangent rounded corner. */
export function roundRoomCorner(session: Session, index: number, radius: number, units: UnitSystem): ModelEdit {
  const room = currentRoom(session.loaded.document);
  if (!room) return { ok: false, reason: 'there is no room to adjust yet' };
  return commitRoomEdit(session, room, roundCorner(room, index, radius), units);
}

/** Applies one consistent radius to every sharp corner in the outline. */
export function roundAllRoomCorners(session: Session, radius: number, units: UnitSystem): ModelEdit {
  const room = currentRoom(session.loaded.document);
  if (!room) return { ok: false, reason: 'there is no room to adjust yet' };
  return commitRoomEdit(session, room, roundAllCorners(room, radius), units);
}

/** Adds or cuts a rectangle from the current room. */
export function reshapeRoom(
  session: Session,
  op: 'union' | 'difference',
  x: number,
  y: number,
  width: number,
  height: number,
  units: UnitSystem,
): ModelEdit {
  const doc = session.loaded.document;
  const room = currentRoom(doc);
  if (!room) return { ok: false, reason: 'there is no room to change yet' };
  if (!(width > 0) || !(height > 0)) return { ok: false, reason: 'enter a width and a depth' };

  const combined = combineRooms(room, rectRoom(x, y, width, height), op);
  if (!combined.ok || !combined.room) return { ok: false, reason: combined.reason };

  const drawn = applyRoom(doc, combined.room, state.rendered ?? room);
  if (!drawn.ok) return { ok: false, reason: drawn.reason };

  state.rendered = combined.room;
  setRoom(doc, combined.room, units);
  return { ok: true, created: drawn.createdIds };
}

/** How a wall curve is measured when authoring from the Room panel. */
export type RoomCurveMethod = 'radius' | 'sagitta' | 'angle' | 'arc-length';

/** Bows one wall. Pass value 0 (any method) to straighten. */
export function curveRoomWall(
  session: Session,
  wallIndex: number,
  value: number,
  units: UnitSystem,
  options: { major?: boolean; method?: RoomCurveMethod; outward?: boolean } = {},
): ModelEdit {
  const doc = session.loaded.document;
  const room = currentRoom(doc);
  if (!room) return { ok: false, reason: 'there is no room to change yet' };

  let curved;
  if (!value || !Number.isFinite(value)) {
    curved = curveWall(room, wallIndex, 0);
  } else {
    const method = options.method ?? 'radius';
    const direction = options.outward ? 1 : -1;
    if (method === 'radius') {
      curved = setWallRadius(room, wallIndex, direction * Math.abs(value), options.major === true);
    } else if (method === 'sagitta') {
      curved = setWallSagitta(room, wallIndex, direction * Math.abs(value));
    } else if (method === 'angle') {
      curved = setWallAngle(room, wallIndex, direction * Math.abs(value));
    } else {
      curved = setWallArcLength(room, wallIndex, Math.abs(value));
      if (curved.ok && curved.room) {
        const bulge = curved.room.walls[wallIndex]?.bulge ?? 0;
        curved = curveWall(curved.room, wallIndex, direction * Math.abs(bulge));
      }
    }
  }
  if (!curved.ok || !curved.room) return { ok: false, reason: curved.reason };

  const drawn = applyRoom(doc, curved.room, state.rendered ?? room);
  if (!drawn.ok) return { ok: false, reason: drawn.reason };

  state.rendered = curved.room;
  setRoom(doc, curved.room, units);
  return {
    ok: true,
    created: drawn.createdIds,
    note:
      drawn.unmatched > 0
        ? `${drawn.unmatched} wall${drawn.unmatched === 1 ? '' : 's'} from the previous room could not be found and ${
            drawn.unmatched === 1 ? 'was' : 'were'
          } left alone.`
        : undefined,
  };
}

/**
 * Bows a wall so the arc passes through a plan point (canvas drag handle).
 * Direction cannot invert relative to the handle — the curve must hit it.
 */
export function curveRoomWallThrough(
  session: Session,
  wallIndex: number,
  through: { x: number; y: number },
  units: UnitSystem,
): ModelEdit {
  const doc = session.loaded.document;
  const room = currentRoom(doc);
  if (!room) return { ok: false, reason: 'there is no room to change yet' };
  if (!Number.isFinite(through.x) || !Number.isFinite(through.y)) {
    return { ok: false, reason: 'that curve point is not valid' };
  }

  const target = room.walls[wallIndex];
  if (!target) return { ok: false, reason: 'no such wall' };
  // Keep canvas through-points on the minor arc unless the panel asks for major.
  const chord = Math.hypot(target.end.x - target.start.x, target.end.y - target.start.y);
  const mid = { x: (target.start.x + target.end.x) / 2, y: (target.start.y + target.end.y) / 2 };
  const dx = target.end.x - target.start.x;
  const dy = target.end.y - target.start.y;
  const nx = chord > 0 ? dy / chord : 0;
  const ny = chord > 0 ? -dx / chord : 0;
  const sag = (through.x - mid.x) * nx + (through.y - mid.y) * ny;
  const maxSag = Math.max(0, chord / 2 - 1);
  const clamped =
    Math.abs(sag) > maxSag && maxSag > 0
      ? { x: mid.x + nx * Math.sign(sag) * maxSag, y: mid.y + ny * Math.sign(sag) * maxSag }
      : through;

  const curved = fitWallThroughPoint(room, wallIndex, clamped);
  if (!curved.ok || !curved.room) return { ok: false, reason: curved.reason };

  const drawn = applyRoom(doc, curved.room, state.rendered ?? room);
  if (!drawn.ok) return { ok: false, reason: drawn.reason };

  state.rendered = curved.room;
  setRoom(doc, curved.room, units);
  return {
    ok: true,
    created: drawn.createdIds,
    note:
      drawn.unmatched > 0
        ? `${drawn.unmatched} wall${drawn.unmatched === 1 ? '' : 's'} from the previous room could not be found and ${
            drawn.unmatched === 1 ? 'was' : 'were'
          } left alone.`
        : undefined,
  };
}

/** Sets one wall's length, keeping its start corner fixed. */
export function lengthenRoomWall(session: Session, wallIndex: number, length: number, units: UnitSystem): ModelEdit {
  const doc = session.loaded.document;
  const room = currentRoom(doc);
  if (!room) return { ok: false, reason: 'there is no room to change yet' };

  const next = setWallLength(room, wallIndex, length);
  if (!next.ok || !next.room) return { ok: false, reason: next.reason };

  const drawn = applyRoom(doc, next.room, state.rendered ?? room);
  if (!drawn.ok) return { ok: false, reason: drawn.reason };

  state.rendered = next.room;
  setRoom(doc, next.room, units);
  return { ok: true, created: drawn.createdIds };
}

/**
 * Pushes or pulls one straight wall perpendicular to itself.
 * Positive distance grows the room (outward for a CCW outline).
 */
export function offsetRoomWall(
  session: Session,
  wallIndex: number,
  distance: number,
  units: UnitSystem,
): ModelEdit {
  const doc = session.loaded.document;
  const room = currentRoom(doc);
  if (!room) return { ok: false, reason: 'there is no room to change yet' };

  const next = offsetWall(room, wallIndex, distance);
  if (!next.ok || !next.room) return { ok: false, reason: next.reason };

  const drawn = applyRoom(doc, next.room, state.rendered ?? room);
  if (!drawn.ok) return { ok: false, reason: drawn.reason };

  state.rendered = next.room;
  setRoom(doc, next.room, units);
  return { ok: true, created: drawn.createdIds };
}

/** Dimensions every wall of the room. */
export function dimensionTheRoom(session: Session, units: UnitSystem): ModelEdit {
  const doc = session.loaded.document;
  const room = currentRoom(doc);
  if (!room) return { ok: false, reason: 'there is no room outline to dimension' };

  const drawings = dimensionRoomDrawings(room, units);
  if (!drawings.length) return { ok: false, reason: 'this room has no walls to dimension' };

  const drawn = renderDimensions(doc, drawings);
  if (!drawn.ok) return { ok: false, reason: drawn.reason, created: drawn.created };
  return { ok: true, created: drawn.created, note: `${drawings.length} dimensions added.` };
}

// ---------------------------------------------------------------------------
// Seating
// ---------------------------------------------------------------------------

export interface SeatingRequestView {
  style: SeatingStyle;
  focusX: number;
  focusY: number;
  seatSpacing?: number;
  rowSpacing?: number;
  front?: number;
  perimeter?: number;
  aisle?: number;
  rowsPerBlock?: number;
  centreAisle?: number;
  side?: number;
  wing?: number;
  rear?: number;
  frontWall?: number;
  stagger?: boolean;
  splay?: number;
  tableDiameter?: number;
  seatsPerTable?: number;
  maxSeats?: number;
  /** Prefer denser packing within clearances. */
  optimum?: boolean;
  /** Crescent open-side for round layouts (also available as a style). */
  crescent?: boolean;
  banquetEndChairs?: boolean;
  banquetRotate90?: boolean;
  chairsBothSides?: boolean;
  tablesAcross?: number;
  /** Seats/tables across the centre bank when sectioning is on. */
  sectionCentre?: number;
  /** Seats/tables across each wing when sectioning is on. */
  sectionWing?: number;
  /** Keep managed seating and add this solution as another independent bank. */
  append?: boolean;
}

function planFrom(request: SeatingRequestView): SeatingPlan {
  const plan = createSeatingPlan(request.style, { x: request.focusX, y: request.focusY });
  if (request.seatSpacing && request.seatSpacing > 0) plan.seatSpacing = request.seatSpacing;
  if (request.rowSpacing && request.rowSpacing > 0) plan.rowSpacing = request.rowSpacing;
  if (request.front != null) plan.clearances.front = Math.max(0, request.front);
  if (request.perimeter != null) plan.clearances.perimeter = Math.max(0, request.perimeter);
  if (request.aisle != null) plan.clearances.aisle = Math.max(0, request.aisle);
  if (request.rowsPerBlock != null) plan.clearances.rowsPerBlock = Math.max(0, Math.floor(request.rowsPerBlock));
  if (request.centreAisle != null) plan.clearances.centreAisle = Math.max(0, request.centreAisle);
  if (request.side != null) plan.clearances.side = Math.max(0, request.side);
  if (request.wing != null) plan.clearances.wing = Math.max(0, request.wing);
  if (request.rear != null) plan.clearances.rear = Math.max(0, request.rear);
  if (request.frontWall != null) plan.clearances.frontWall = Math.max(0, request.frontWall);
  if (request.stagger != null) plan.stagger = request.stagger;
  if (request.tableDiameter && request.tableDiameter > 0) plan.tableDiameter = request.tableDiameter;
  if (request.seatsPerTable && request.seatsPerTable > 0) plan.seatsPerTable = request.seatsPerTable;
  if (request.maxSeats && request.maxSeats > 0) plan.maxSeats = request.maxSeats;
  if (request.optimum != null) plan.optimum = request.optimum;
  if (request.crescent != null) plan.crescent = request.crescent;
  if (!plan.banquet) plan.banquet = { stagger: 'none', endChairs: 0, rotate90: false };
  if (request.banquetEndChairs != null) plan.banquet.endChairs = request.banquetEndChairs ? 2 : 0;
  if (request.banquetRotate90 != null) plan.banquet.rotate90 = request.banquetRotate90;
  if (request.stagger) plan.banquet.stagger = 'half';
  if (!plan.block) plan.block = { chairsBothSides: false, tablesAcross: 0 };
  if (request.chairsBothSides != null) plan.block.chairsBothSides = request.chairsBothSides;
  if (request.tablesAcross != null && request.tablesAcross > 0) {
    plan.block.tablesAcross = Math.floor(request.tablesAcross);
  }
  if (request.sectionCentre != null || request.sectionWing != null) {
    plan.sectioning = {
      enabled: true,
      centre: request.sectionCentre != null && request.sectionCentre > 0 ? Math.floor(request.sectionCentre) : 8,
      wing: request.sectionWing != null && request.sectionWing > 0 ? Math.floor(request.sectionWing) : 4,
    };
  }

  if (request.splay && Math.abs(request.splay) > 0.5) {
    plan.sections = [
      { splay: -Math.abs(request.splay), gap: 2 * UNITS_PER_FOOT },
      { splay: 0, gap: 0 },
      { splay: Math.abs(request.splay), gap: 2 * UNITS_PER_FOOT },
    ];
  }

  // A stage already built takes its floor out of the count.
  if (state.stage) plan.reserved = stageReservedAreas(state.stage);
  return plan;
}

export interface SeatingPreview {
  seats: number;
  tables: number;
  rows: number;
  dropped: number;
  notes: string[];
  clearances: {
    front: number;
    side: number;
    wing: number;
    rear: number;
    centreAisle: number;
    perimeter: number;
    aisle: number;
    frontWall: number;
  };
}

/** Solves without drawing, so the panel can show the count as sliders move. */
export function previewSeating(session: Session, request: SeatingRequestView): SeatingPreview {
  const room = currentRoom(session.loaded.document);
  const emptyClearances = {
    front: 0,
    side: 0,
    wing: 0,
    rear: 0,
    centreAisle: 0,
    perimeter: 0,
    aisle: 0,
    frontWall: 0,
  };
  if (!room) {
    return {
      seats: 0,
      tables: 0,
      rows: 0,
      dropped: 0,
      notes: ['This plan has no room outline yet.'],
      clearances: emptyClearances,
    };
  }

  const plan = planFrom(request);
  const solution = plan.optimum ? solveOptimum(plan, room) : solveSeating(plan, room);
  // Preview must not write shared plan-model state — rapid slider updates would
  // race applySeating / planModelView seatingStatus. Return clearances locally.
  const clearances = {
    front: plan.clearances.front,
    side: plan.clearances.side,
    wing: plan.clearances.wing,
    rear: plan.clearances.rear,
    centreAisle: plan.clearances.centreAisle,
    perimeter: plan.clearances.perimeter,
    aisle: plan.clearances.aisle,
    frontWall: plan.clearances.frontWall,
  };
  return {
    seats: solution.seats.length,
    tables: solution.tables.length,
    rows: solution.rowCount,
    dropped: solution.dropped,
    notes: solution.notes,
    clearances,
  };
}

/** Draws a seating layout, replacing managed seating or adding another bank. */
export function applySeating(
  session: Session,
  request: SeatingRequestView,
  chair: string,
  table?: string,
): ModelEdit {
  const doc = session.loaded.document;
  const room = currentRoom(doc);
  if (!room) return { ok: false, reason: 'draw or trace a room outline first' };
  if (!chair.trim()) return { ok: false, reason: 'choose a chair to place' };

  const plan = planFrom(request);
  const solution: SeatingSolution = plan.optimum ? solveOptimum(plan, room) : solveSeating(plan, room);
  if (!solution.seats.length && !solution.tables.length) {
    return { ok: false, reason: 'that layout does not fit in this room' };
  }
  if (solution.tables.length && !table?.trim()) {
    return { ok: false, reason: 'this layout needs a table as well as a chair' };
  }

  const append = request.append === true;
  const drawn = renderSeating(
    doc,
    indexDocument(doc),
    solution,
    { chair, table },
    append ? [] : state.seatingIds,
  );
  if (!drawn.ok) return { ok: false, reason: drawn.reason, created: drawn.created };

  state.seatingIds = append ? [...state.seatingIds, ...drawn.created] : drawn.created;
  const previousPlaced = append ? state.placedSeatCounts : null;
  state.placedSeatCounts = {
    chairs: (previousPlaced?.chairs ?? 0) + solution.seats.length,
    tables: (previousPlaced?.tables ?? 0) + solution.tables.length,
  };
  state.lastClearances = {
    front: plan.clearances.front,
    side: plan.clearances.side,
    wing: plan.clearances.wing,
    rear: plan.clearances.rear,
    centreAisle: plan.clearances.centreAisle,
    perimeter: plan.clearances.perimeter,
    aisle: plan.clearances.aisle,
    frontWall: plan.clearances.frontWall,
  };
  state.lastSeatCounts = { ...state.placedSeatCounts };
  const notes = [...solution.notes];
  if (drawn.removed) notes.unshift(`Replaced the previous layout (${drawn.removed} items).`);
  else if (append) notes.unshift(`Added a seating section (${drawn.chairs} chairs${drawn.tables ? `, ${drawn.tables} tables` : ''}).`);
  return { ok: true, created: drawn.created, note: notes.join(' ') || undefined };
}

// ---------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------

export function addStage(
  session: Session,
  x: number,
  y: number,
  width: number,
  depth: number,
  height: number,
  options?: {
    /** Second tier behind the front deck (tiered house-riser builds). */
    back?: { depth: number; height: number };
    /** Which edges get stair units. Default: front for single, left+right for tiered. */
    stairs?: Array<'front' | 'back' | 'left' | 'right'>;
  },
): ModelEdit & { buildList?: Array<{ item: string; quantity: number; detail?: string }>; warnings?: string[] } {
  if (!(width > 0) || !(depth > 0)) return { ok: false, reason: 'enter a stage width and depth' };

  const doc = session.loaded.document;
  const stairEdges =
    options?.stairs ??
    (options?.back ? (['left', 'right'] as const) : (['front'] as const));
  const build = options?.back
    ? tieredStage(
        x,
        y,
        width,
        { depth, height },
        { depth: options.back.depth, height: options.back.height },
        [...stairEdges],
      )
    : simpleStage(x, y, width, depth, height, 'Stage', [...stairEdges]);
  const solution = solveStage(build);
  if (!solution.decks.length) return { ok: false, reason: 'no stock deck fits a stage that size' };

  // Drawn as one placed shape whose outline is the footprint plus every deck
  // and stair tread, so the crew can see the build while the stage stays a
  // single object that can be selected, moved and counted like anything else.
  const levels = build.levels;
  const minX = Math.min(...levels.map((l) => l.x));
  const minY = Math.min(...levels.map((l) => l.y));
  const maxX = Math.max(...levels.map((l) => l.x + l.width));
  const maxY = Math.max(...levels.map((l) => l.y + l.depth));
  const centre = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  const rect = (rx: number, ry: number, rw: number, rd: number) => [
    { x: rx - centre.x, y: ry - centre.y },
    { x: rx + rw - centre.x, y: ry - centre.y },
    { x: rx + rw - centre.x, y: ry + rd - centre.y },
    { x: rx - centre.x, y: ry + rd - centre.y },
    { x: rx - centre.x, y: ry - centre.y },
  ];

  const footprint = levels.map((l) => rect(l.x, l.y, l.width, l.depth));
  const decks = solution.decks.map((d) => rect(d.x, d.y, d.width, d.depth));
  const outline = [...footprint, ...decks];
  const totalDepth = maxY - minY;
  const name = options?.back
    ? `Tiered stage ${(width / UNITS_PER_FOOT).toFixed(0)}' x ${(totalDepth / UNITS_PER_FOOT).toFixed(0)}'`
    : `Stage ${(width / UNITS_PER_FOOT).toFixed(0)}' x ${(depth / UNITS_PER_FOOT).toFixed(0)}' x ${(height / 10).toFixed(0)}"`;

  const shape = createShape(doc, { name, x: centre.x, y: centre.y, outline });
  if (!shape.ok || !shape.node) return { ok: false, reason: shape.reason };

  const host = planBody(doc);
  const added = host ? appendChild(doc, host, shape.node) : addRoot(doc, shape.node);
  if (!added.ok) return { ok: false, reason: added.reason };

  const created = [shape.node.id];

  // Stairs stay a sibling so the stage still measures as its deck footprint
  // (resize / inventory counts stay honest). They are linked in the editor so
  // move / delete / duplicate keep the pair together.
  const stairPolys = stairDeckOutlines(build);
  if (stairPolys.length) {
    const xs = stairPolys.flatMap((poly) => poly.map((p) => p.x));
    const ys = stairPolys.flatMap((poly) => poly.map((p) => p.y));
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const local = stairPolys.map((poly) => poly.map((p) => ({ x: p.x - cx, y: p.y - cy })));
    const stair = createShape(doc, {
      name: `Stairs · ${name}`,
      x: cx,
      y: cy,
      outline: local,
    });
    if (stair.ok && stair.node) {
      const placed = host ? appendChild(doc, host, stair.node) : addRoot(doc, stair.node);
      if (placed.ok) created.push(stair.node.id);
    }
  }

  state.stage = build;
  if (!state.companion) state.companion = createCompanion(doc, 'imperial');
  state.companion.stage = structuredClone(build);
  return {
    ok: true,
    created,
    buildList: stageBuildList(build, solution),
    warnings: [...solution.notes, ...stageWarnings(build)],
    note: `${solution.decks.length} decks${build.stairs.length ? `, ${build.stairs.length} stair unit${build.stairs.length === 1 ? '' : 's'}` : ''}.`,
  };
}

export function clearStage(): void {
  state.stage = null;
  if (state.companion) delete state.companion.stage;
}

/**
 * Elevations for DXF INSERT Z — companion overrides / inferred specs, with
 * stage deck height applied to stage / stair shapes.
 */
export function placementElevations(session: Session): Map<string, number> {
  const items = placedItems(session.loaded.document);
  const map = new Map<string, number>();
  const stageTop = state.stage
    ? Math.max(0, ...state.stage.levels.map((level) => level.height))
    : 0;
  for (const item of items) {
    let elev = item.elevation;
    if (stageTop > 0 && /\b(stage|riser|deck|platform|stair)/i.test(item.name)) {
      elev = Math.max(elev, stageTop);
    }
    if (elev > 0) map.set(item.key, elev);
  }
  return map;
}

/** Writes a per-placement elevation (AFF) into the companion overrides. */
export function setInstanceElevation(
  session: Session,
  key: string,
  elevation: number | null,
  units: UnitSystem,
): ModelEdit {
  const doc = session.loaded.document;
  if (!state.companion) state.companion = createCompanion(doc, units);
  const trimmed = key.trim();
  if (!trimmed) return { ok: false, reason: 'no placement selected' };
  const next = state.companion.overrides.filter((o) => o.key !== trimmed);
  if (elevation != null && elevation >= 0) {
    next.push({ key: trimmed, elevation });
  }
  state.companion.overrides = next;
  return {
    ok: true,
    note:
      elevation != null && elevation >= 0
        ? `Height set to ${(elevation / UNITS_PER_FOOT).toFixed(2)} ft above floor`
        : 'Height cleared',
  };
}

/** Selection helper — elevation for the inspector. */
export function selectionElevation(
  session: Session,
  nodeId: number,
): { key: string; elevation: number; inferred: boolean } | null {
  const item = placedItems(session.loaded.document).find((p) => p.nodeId === nodeId);
  if (!item) return null;
  const override = state.companion?.overrides.find((o) => o.key === item.key);
  return {
    key: item.key,
    elevation: item.elevation,
    inferred: item.estimated && override?.elevation == null,
  };
}

/**
 * Places a named open polyline (power / data run) that counts on the schedule.
 */
export function addCablePath(
  session: Session,
  name: string,
  points: Array<{ x: number; y: number }>,
): ModelEdit {
  if (points.length < 2) return { ok: false, reason: 'click at least two points for a cable run' };
  const label = name.trim() || 'Power run';
  const doc = session.loaded.document;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const local = points.map((p) => ({ x: p.x - cx, y: p.y - cy }));
  // Open polyline: do not close back to start.
  const shape = createShape(doc, {
    name: label,
    x: cx,
    y: cy,
    outline: [local],
  });
  if (!shape.ok || !shape.node) return { ok: false, reason: shape.reason };
  const host = planBody(doc);
  const added = host ? appendChild(doc, host, shape.node) : addRoot(doc, shape.node);
  if (!added.ok) return { ok: false, reason: added.reason };

  // Length note on companion library for the schedule.
  const length = points.slice(1).reduce((sum, p, i) => {
    const prev = points[i]!;
    return sum + Math.hypot(p.x - prev.x, p.y - prev.y);
  }, 0);
  if (!state.companion) state.companion = createCompanion(doc, 'imperial');
  const existing = state.companion.library.find((s) => s.name.toLowerCase() === label.toLowerCase());
  if (!existing) {
    state.companion.library.push({
      id: `path:${label.toLowerCase().replace(/\s+/g, '-')}`,
      name: label,
      category: 'power',
      height: 0,
      elevation: 0,
      notes: `Run length ~${(length / UNITS_PER_FOOT).toFixed(1)} ft`,
    });
  }
  state.companion.overrides = [
    ...state.companion.overrides.filter((o) => o.key !== instanceKey(label, cx, cy)),
    { key: instanceKey(label, cx, cy), layer: 'power', label: `${(length / UNITS_PER_FOOT).toFixed(1)} ft` },
  ];

  return {
    ok: true,
    created: [shape.node.id],
    note: `Placed ${label} · ${(length / UNITS_PER_FOOT).toFixed(1)} ft`,
  };
}

/**
 * Places a Fastfold-style screen and a projector at a typical throw distance,
 * then a throw dimension between them.
 */
export function placeScreenProjectorPair(
  session: Session,
  at: { x: number; y: number },
  screenName = 'Fastfold Screen',
  projectorName = 'Projector',
): ModelEdit {
  const doc = session.loaded.document;
  const index = indexDocument(doc);
  const imageWidth = 16 * UNITS_PER_FOOT;
  const throwDist = 1.5 * imageWidth;
  const screen = placeGear(doc, index, screenName, at.x, at.y);
  if (!screen.ok) return { ok: false, reason: screen.reason ?? 'could not place the screen' };
  const nextIndex = indexDocument(doc);
  const projector = placeGear(doc, nextIndex, projectorName, at.x, at.y + throwDist);
  if (!projector.ok) {
    return {
      ok: true,
      created: screen.created,
      note: 'Screen placed: no projector match in inventory; place one and set throw manually',
    };
  }
  const created = [...(screen.created ?? []), ...(projector.created ?? [])];
  const dimIndex = indexDocument(doc);
  const dim = createDimension(doc, dimIndex, at.x, at.y, at.x, at.y + throwDist);
  if (dim.ok && dim.created?.length) created.push(...dim.created);
  return {
    ok: true,
    created,
    note: `Placed ${screenName} + ${projectorName} with throw dimension`,
  };
}

export interface SightlineMarker {
  x: number;
  y: number;
  verdict: SightlineVerdict;
}

/** Seat markers for canvas tint from the current sightline check. */
export function sightlineMarkers(session: Session): SightlineMarker[] {
  const items = placedItems(session.loaded.document);
  const screens = screensFromItems(items);
  if (!screens.length) return [];
  const screen = screens[0]!;
  const seats = items
    .filter((item) => /chair|seat/i.test(item.name) || /chair/i.test(item.spec?.category ?? ''))
    .map((item, index) => ({
      x: item.x,
      y: item.y,
      rotation: item.rotation,
      row: 0,
      seat: index,
      section: 0,
    }));
  if (!seats.length) return [];
  const views = checkSightlines(seats, screen, items);
  return views.map((view) => ({
    x: view.seat.x,
    y: view.seat.y,
    verdict: view.verdict,
  }));
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

export type DrawTool = 'line' | 'rect' | 'ellipse';

/** How finely an ellipse is drawn, in segments around the full turn. */
const ELLIPSE_SEGMENTS = 64;

/**
 * Draws a line, rectangle or ellipse from two corners.
 *
 * The synthesis layer has been able to write all three since the spike; what
 * was missing was any way for a person to ask for one. An ellipse becomes a
 * closed polyline, because Room Viewer's own arc class carries four points of
 * construction data whose meaning was never recovered — a polyline is certainly
 * right where a half-guessed arc would only probably be.
 */
export function drawShape(
  session: Session,
  tool: DrawTool,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): ModelEdit {
  if (![x1, y1, x2, y2].every((n) => Number.isFinite(n))) {
    return { ok: false, reason: 'those points are not on the plan' };
  }

  const doc = session.loaded.document;
  const left = Math.min(x1, x2);
  const right = Math.max(x1, x2);
  const top = Math.min(y1, y2);
  const bottom = Math.max(y1, y2);

  if (tool !== 'line' && (right - left < 1 || bottom - top < 1)) {
    return { ok: false, reason: 'drag out a shape with some size to it' };
  }
  if (tool === 'line' && Math.hypot(x2 - x1, y2 - y1) < 1) {
    return { ok: false, reason: 'those two points are the same' };
  }

  let built;
  if (tool === 'line') {
    built = createSegment(doc, { cls: 'RVSegmentLine', points: [{ x: x1, y: y1 }, { x: x2, y: y2 }] });
  } else if (tool === 'rect') {
    built = createSegment(doc, {
      cls: 'RVSegmentRect',
      points: [
        { x: left, y: top },
        { x: right, y: top },
        { x: right, y: bottom },
        { x: left, y: bottom },
      ],
    });
  } else {
    const cx = (left + right) / 2;
    const cy = (top + bottom) / 2;
    const rx = (right - left) / 2;
    const ry = (bottom - top) / 2;
    const points = [];
    for (let i = 0; i <= ELLIPSE_SEGMENTS; i++) {
      const angle = (i / ELLIPSE_SEGMENTS) * 2 * Math.PI;
      points.push({ x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) });
    }
    built = createSegment(doc, { cls: 'RVSegmentPoly', points });
  }

  if (!built.ok || !built.node) return { ok: false, reason: built.reason };

  const host = planBody(doc);
  const added = host ? appendChild(doc, host, built.node) : addRoot(doc, built.node);
  if (!added.ok) return { ok: false, reason: added.reason };

  return { ok: true, created: [built.node.id] };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export interface ReportOptions {
  units: UnitSystem;
  scale: string;
  venue?: string;
  client?: string;
  event?: string;
  date?: string;
  drawnBy?: string;
  revision?: string;
  /** Stock levels by item name, for the allocation section. */
  owned?: Array<{ name: string; quantity: number }>;
  /** A screen to check sightlines against. */
  screen?: {
    x: number;
    y: number;
    facing: number;
    imageWidth: number;
    aspectW: number;
    aspectH: number;
    bottomHeight: number;
  };
  seating?: SeatingRequestView;
}

/** Builds the plan report as Markdown. */
export function planReport(session: Session, options: ReportOptions): string {
  const doc = session.loaded.document;
  const room = currentRoom(doc);
  const items = placedItems(doc);

  let allocation: Allocation[] | undefined;
  if (options.owned?.length) {
    allocation = allocate(items, new Map(options.owned.map((o) => [o.name, o.quantity])));
  }

  let seating: SeatingSolution | undefined;
  if (options.seating && room) seating = solveSeating(planFrom(options.seating), room);

  let sightlines: SightlineSummary | undefined;
  if (options.screen && seating?.seats.length) {
    const screen: Screen = {
      id: 'screen',
      x: options.screen.x,
      y: options.screen.y,
      facing: options.screen.facing,
      imageWidth: options.screen.imageWidth,
      aspect: { w: options.screen.aspectW, h: options.screen.aspectH },
      bottomHeight: options.screen.bottomHeight,
    };
    sightlines = summariseSightlines(checkSightlines(seating.seats, screen, items));
  }

  const stageSolution = state.stage ? solveStage(state.stage) : null;

  return buildReport({
    title: titleBlockFor(session.scene.title ?? session.loaded.name, options.scale, {
      venue: options.venue,
      client: options.client,
      event: options.event,
      date: options.date,
      drawnBy: options.drawnBy,
      revision: options.revision,
    }),
    units: options.units,
    room: room ?? undefined,
    items,
    seating,
    stage: state.stage && stageSolution ? { build: state.stage, solution: stageSolution } : undefined,
    allocation,
    sightlines,
    legend: buildLegend(items, defaultLayers(), {}),
    warnings: [
      ...(state.freshness === 'stale' && state.reason ? [state.reason] : []),
      ...(room ? roomProblems(room) : []),
    ],
  });
}

/** The allocation table on its own, for the equipment panel. */
export function planAllocation(
  session: Session,
  owned: Array<{ name: string; quantity: number }>,
): { lines: Allocation[]; summary: ReturnType<typeof summariseAllocation> } {
  const items = placedItems(session.loaded.document);
  const lines = allocate(items, new Map(owned.map((o) => [o.name, o.quantity])));
  return { lines, summary: summariseAllocation(lines) };
}
