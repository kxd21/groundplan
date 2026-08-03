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
import {
  checkSightlines,
  recommendImageWidth,
  screensFromItems,
  summariseSightlines,
  type Screen,
  type SightlineSummary,
} from '../format/av.js';
import type { CompanionDocument } from '../format/companion.js';
import { createCompanion } from '../format/companion.js';
import { resolveInstances, SpecLibrary, type PlacedItem } from '../format/definition.js';
import { dimensionRoom as dimensionRoomDrawings } from '../format/dimension.js';
import { renderDimensions } from '../format/dimension-render.js';
import { buildLegend, defaultLayers, titleBlockFor } from '../format/layers.js';
import { buildReport } from '../format/report.js';
import {
  allCapacities,
  arcOf,
  deriveRoom,
  describeRoom,
  rectangularRoom,
  roomArea,
  roomBounds,
  roomPerimeter,
  wallLength,
  type RoomModel,
} from '../format/room.js';
import { combineRooms, curveWall, rectRoom, roomProblems, setWallLength, setWallRadius } from '../format/room-edit.js';
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
  type StageBuild,
} from '../format/stage.js';
import { formatArea, formatLength, type UnitSystem } from '../format/units.js';
import { UNITS_PER_FOOT, type RVDocument } from '../format/rv.js';
import { addRoot, appendChild, indexDocument } from '../format/edit.js';
import { planBody } from '../format/plan-skeleton.js';
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
  /** Objects the last seating render created. */
  seatingIds: number[];
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
  lastClearances: null,
  lastSeatCounts: null,
  stage: null,
};

let state: PlanModelState = { ...EMPTY };

export function resetPlanModel(): void {
  state = { ...EMPTY };
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
    lastClearances: null,
    lastSeatCounts: null,
    stage: null,
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
  if (state.derived) return;
  await saveCompanion(planPath, body, companion);
  state.freshness = 'fresh';
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
  state.derived = false;
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
  lengthText: string;
  curved: boolean;
  /** Arc radius in logical units when curved; otherwise 0. */
  radius: number;
  radiusText: string;
}

export interface RoomSummary {
  name: string;
  /** How the outline was arrived at, so the UI can be honest about it. */
  source: 'companion' | 'walls' | 'region' | 'extent' | 'none';
  closed: boolean;
  walls: number;
  /** Per-wall facts for curve / reshape controls. */
  wallDetails: RoomWallSummary[];
  holes: number;
  curved: number;
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

  return {
    name: room.name,
    source,
    closed: roomProblems(room).length === 0,
    walls: room.walls.length,
    wallDetails: room.walls.map((segment, index) => {
      const arc = arcOf(segment);
      return {
        index,
        lengthText: formatLength(wallLength(segment), units),
        curved: Boolean(segment.bulge),
        radius: arc?.radius ?? 0,
        radiusText: arc ? formatLength(arc.radius, units) : '',
      };
    }),
    holes: room.holes.length,
    curved: room.walls.filter((w) => w.bulge).length,
    area: roomArea(room),
    perimeter: roomPerimeter(room),
    width,
    height,
    ceilingHeight: room.ceilingHeight && room.ceilingHeight > 0 ? room.ceilingHeight : 0,
    x: bounds ? bounds.minX : 0,
    y: bounds ? bounds.minY : 0,
    areaText: formatArea(roomArea(room), units),
    perimeterText: formatLength(roomPerimeter(room), units),
    sizeText: `${formatLength(width, units)} × ${formatLength(height, units)}`,
    ceilingText:
      room.ceilingHeight && room.ceilingHeight > 0 ? formatLength(room.ceilingHeight, units) : '',
    summary: describeRoom(room),
    problems: roomProblems(room),
    capacities: allCapacities(room),
  };
}

export function planModelView(session: Session, units: UnitSystem): PlanModelView {
  const doc = session.loaded.document;
  const saved = state.companion?.rooms[0];
  const usingSaved = !!saved && saved.walls.length >= 3 && state.freshness !== 'stale';
  const derived = usingSaved ? null : deriveRoom(doc);
  const room = usingSaved ? saved! : derived!.room;
  // A room the user has authored is the companion's; one that was only derived
  // reports where it actually came from, however it is being stored.
  const source: RoomSummary['source'] = usingSaved
    ? state.derived
      ? state.derivedSource
      : 'companion'
    : derived!.source;

  const stageSolution = state.stage ? solveStage(state.stage) : null;

  return {
    units,
    room: summarise(room, source, units),
    companion: {
      freshness: state.freshness,
      reason: state.reason ?? (derived && !usingSaved ? describeSource(derived.source) : undefined),
      derived: state.derived,
      path: companionPathFor(session.path),
    },
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

function describeSource(source: 'walls' | 'region' | 'extent' | 'none'): string | undefined {
  if (source === 'extent') {
    return 'No wall outline could be traced, so this is the extent of the drawing — treat the area as an over-estimate.';
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

  const doc = session.loaded.document;
  const bounds = state.rendered ? roomBounds(state.rendered) : null;
  const origin = bounds ? { x: bounds.minX, y: bounds.minY } : { x: 0, y: 0 };
  const room = rectangularRoom(width, height, state.rendered?.name ?? 'Room', origin);

  const drawn = applyRoom(doc, room, state.rendered ?? undefined);
  if (!drawn.ok) return { ok: false, reason: drawn.reason };

  state.rendered = room;
  setRoom(doc, room, units);
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

/** Bows one wall to a radius. Pass radius 0 to straighten. */
export function curveRoomWall(
  session: Session,
  wallIndex: number,
  radius: number,
  units: UnitSystem,
  major = false,
): ModelEdit {
  const doc = session.loaded.document;
  const room = currentRoom(doc);
  if (!room) return { ok: false, reason: 'there is no room to change yet' };

  const curved =
    !radius || !Number.isFinite(radius)
      ? curveWall(room, wallIndex, 0)
      : setWallRadius(room, wallIndex, radius, major);
  if (!curved.ok || !curved.room) return { ok: false, reason: curved.reason };

  const drawn = applyRoom(doc, curved.room, state.rendered ?? room);
  if (!drawn.ok) return { ok: false, reason: drawn.reason };

  state.rendered = curved.room;
  setRoom(doc, curved.room, units);
  return { ok: true, created: drawn.createdIds };
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
  state.lastSeatCounts = { chairs: solution.seats.length, tables: solution.tables.length };
  return {
    seats: solution.seats.length,
    tables: solution.tables.length,
    rows: solution.rowCount,
    dropped: solution.dropped,
    notes: solution.notes,
    clearances: state.lastClearances,
  };
}

/** Draws a seating layout, replacing the one this drew before. */
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

  const drawn = renderSeating(doc, indexDocument(doc), solution, { chair, table }, state.seatingIds);
  if (!drawn.ok) return { ok: false, reason: drawn.reason, created: drawn.created };

  state.seatingIds = drawn.created;
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
  state.lastSeatCounts = { chairs: solution.seats.length, tables: solution.tables.length };
  const notes = [...solution.notes];
  if (drawn.removed) notes.unshift(`Replaced the previous layout (${drawn.removed} items).`);
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
): ModelEdit & { buildList?: Array<{ item: string; quantity: number; detail?: string }>; warnings?: string[] } {
  if (!(width > 0) || !(depth > 0)) return { ok: false, reason: 'enter a stage width and depth' };

  const doc = session.loaded.document;
  const build = simpleStage(x, y, width, depth, height, 'Stage');
  const solution = solveStage(build);
  if (!solution.decks.length) return { ok: false, reason: 'no stock deck fits a stage that size' };

  // Drawn as one placed shape whose outline is the footprint plus every deck,
  // so the crew can see the deck layout while the stage stays a single object
  // that can be selected, moved and counted like anything else on the plan.
  const centre = { x: x + width / 2, y: y + depth / 2 };
  const rect = (rx: number, ry: number, rw: number, rd: number) => [
    { x: rx - centre.x, y: ry - centre.y },
    { x: rx + rw - centre.x, y: ry - centre.y },
    { x: rx + rw - centre.x, y: ry + rd - centre.y },
    { x: rx - centre.x, y: ry + rd - centre.y },
    { x: rx - centre.x, y: ry - centre.y },
  ];

  const outline = [rect(x, y, width, depth), ...solution.decks.map((d) => rect(d.x, d.y, d.width, d.depth))];
  const name = `Stage ${(width / UNITS_PER_FOOT).toFixed(0)}' x ${(depth / UNITS_PER_FOOT).toFixed(0)}' x ${(height / 10).toFixed(0)}"`;

  const shape = createShape(doc, { name, x: centre.x, y: centre.y, outline });
  if (!shape.ok || !shape.node) return { ok: false, reason: shape.reason };

  const host = planBody(doc);
  const added = host ? appendChild(doc, host, shape.node) : addRoot(doc, shape.node);
  if (!added.ok) return { ok: false, reason: added.reason };

  state.stage = build;
  return {
    ok: true,
    created: [shape.node.id],
    buildList: stageBuildList(build, solution),
    warnings: [...solution.notes, ...stageWarnings(build)],
    note: `${solution.decks.length} decks.`,
  };
}

export function clearStage(): void {
  state.stage = null;
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
