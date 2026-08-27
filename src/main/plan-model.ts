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
import { checkSightlines, summariseSightlines, type Screen, type SightlineSummary } from '../format/av.js';
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
  roomPolygon,
  wallLength,
  type RoomModel,
} from '../format/room.js';
import { combineRooms, curveWall, rectRoom, roomProblems, setWallRadius } from '../format/room-edit.js';
import { applyRoom } from '../format/room-render.js';
import {
  createSeatingPlan,
  solveSeating,
  STYLE_DEFAULTS,
  type ReservedArea,
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
import { walk, UNITS_PER_FOOT, type RVDocument } from '../format/rv.js';
import { addRoot, appendChild, indexDocument } from '../format/edit.js';
import { placeGear, parseDimensions } from '../format/place.js';
import { createSegment, createShape } from '../format/synthesize.js';
import { walkItems, type GearList } from '../gear/model.js';
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
  /**
   * Seating layouts on this plan, keyed by name. Each remembers the objects it
   * drew (so regenerating replaces only its own) and the footprint it occupies
   * (so the other layouts reserve around it). One plan can carry a main house, a
   * VIP block and a riser bank at once, each solved independently.
   */
  regions: Map<string, SeatingRegion>;
  /** The stage as last built, for the report. */
  stage: StageBuild | null;
}

interface SeatingRegion {
  ids: number[];
  area?: ReservedArea;
}

function emptyState(): PlanModelState {
  return {
    companion: null,
    freshness: 'missing',
    derived: true,
    derivedSource: 'none',
    rendered: null,
    regions: new Map(),
    stage: null,
  };
}

let state: PlanModelState = emptyState();

export function resetPlanModel(): void {
  state = emptyState();
}

/** Reads the companion beside a plan, or derives one from the drawing. */
export async function openPlanModel(planPath: string, doc: RVDocument, units: UnitSystem): Promise<void> {
  const loaded = await loadCompanion(planPath, doc, units);
  state = {
    ...emptyState(),
    companion: loaded.companion,
    freshness: loaded.freshness,
    reason: loaded.reason,
    derived: loaded.derived,
    derivedSource: loaded.derived ? deriveRoom(doc).source : 'none',
    // A companion that is fresh describes what is drawn, so its room is also
    // what was last rendered. A derived one was read back off the drawing,
    // which amounts to the same thing.
    rendered: loaded.companion.rooms[0] ?? null,
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
  /** Top-left of the room's bounds, so callers can position against it. */
  x: number;
  y: number;
  /** Ready to display in the user's units. */
  areaText: string;
  perimeterText: string;
  sizeText: string;
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
  /** Named seating layouts already on the plan, so the panel can re-tune them. */
  seatingRegions: string[];
  /** Placed items, summarised — what the allocation and legend are built from. */
  itemCount: number;
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
    x: bounds ? bounds.minX : 0,
    y: bounds ? bounds.minY : 0,
    areaText: formatArea(roomArea(room), units),
    perimeterText: formatLength(roomPerimeter(room), units),
    sizeText: `${formatLength(width, units)} × ${formatLength(height, units)}`,
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
    seatingRegions: [...state.regions.keys()],
    seatingStyles: (Object.keys(STYLE_DEFAULTS) as SeatingStyle[]).map((id) => ({
      id,
      label: STYLE_LABELS[id],
      needsTable: TABLE_STYLES.has(id),
    })),
    itemCount: placedItems(doc).length,
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
export function curveRoomWall(session: Session, wallIndex: number, radius: number, units: UnitSystem): ModelEdit {
  const doc = session.loaded.document;
  const room = currentRoom(doc);
  if (!room) return { ok: false, reason: 'there is no room to change yet' };

  const curved =
    !radius || !Number.isFinite(radius)
      ? curveWall(room, wallIndex, 0)
      : setWallRadius(room, wallIndex, radius);
  if (!curved.ok || !curved.room) return { ok: false, reason: curved.reason };

  const drawn = applyRoom(doc, curved.room, state.rendered ?? room);
  if (!drawn.ok) return { ok: false, reason: drawn.reason };

  state.rendered = curved.room;
  setRoom(doc, curved.room, units);
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

/**
 * Rings the room in pipe and drape.
 *
 * A real show masks the walls with a run of drape, which the corpus stores as a
 * line of "Pipe and Drape" panels — Card Party has 51 of them. Placing those by
 * hand, one panel at a time, is what makes draping a room from scratch
 * impractical, so this lays the whole run along the room outline in one step:
 * each wall is divided into panels of roughly `panelWidth`, and each panel is a
 * thin rectangle named so it counts in the inventory like the real thing.
 */
export function drapePerimeter(session: Session, panelWidth = 10 * UNITS_PER_FOOT): ModelEdit {
  const doc = session.loaded.document;
  const room = currentRoom(doc);
  if (!room) return { ok: false, reason: 'there is no room outline to drape' };

  const poly = roomPolygon(room.walls);
  if (poly.length < 2) return { ok: false, reason: 'this room has no walls to drape' };

  const panel = Math.max(2 * UNITS_PER_FOOT, panelWidth);
  const thickness = UNITS_PER_FOOT; // reads as a ~1 ft deep masking line on the plan
  const host = stageHost(doc);
  const created: number[] = [];

  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1) continue;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const nx = -uy;
    const ny = ux;
    const count = Math.max(1, Math.round(len / panel));
    const panelLen = len / count;

    for (let k = 0; k < count; k++) {
      const t = (k + 0.5) * panelLen;
      const cx = a.x + ux * t;
      const cy = a.y + uy * t;
      const hl = panelLen / 2;
      const ht = thickness / 2;
      const corners = [
        { x: -ux * hl - nx * ht, y: -uy * hl - ny * ht },
        { x: ux * hl - nx * ht, y: uy * hl - ny * ht },
        { x: ux * hl + nx * ht, y: uy * hl + ny * ht },
        { x: -ux * hl + nx * ht, y: -uy * hl + ny * ht },
        { x: -ux * hl - nx * ht, y: -uy * hl - ny * ht },
      ];
      const shape = createShape(doc, { name: 'Pipe and Drape', x: cx, y: cy, outline: [corners] });
      if (!shape.ok || !shape.node) return { ok: false, reason: shape.reason };
      const added = host ? appendChild(doc, host, shape.node) : addRoot(doc, shape.node);
      if (!added.ok) return { ok: false, reason: added.reason };
      created.push(shape.node.id);
    }
  }

  if (!created.length) return { ok: false, reason: 'the room outline was too small to drape' };
  return { ok: true, created, note: `${created.length} drape panels around the room.` };
}

/** Cable, consumables and hardware that no one draws on a floor plan. */
const NOT_DRAWN =
  /\b(cable|jumper|xlr|sdi|hdmi|cat\s*6|cat6|dmx|soca|edison|feeder|adapter|adaptor|battery|batteries|barrel|coupler|shackle|clamp|tape|clip|bolt|sandbag|case|bag|strap|spanset|zipties?|screw|pin|whip|breakout|snake|loom|power supply|remote|gel|gaff)\b/i;

/**
 * Places every drawable line of a gear list onto the plan.
 *
 * A gear list holds descriptions and quantities but no positions — the truck
 * doesn't know where anything goes — so the pieces are laid out in a tidy
 * staging grid below the room for the user to drag into place. That turns "150
 * lines on the manifest" into 150 real objects in one step instead of arming
 * and clicking each one, which is what made dressing a plan from a list
 * impractical. Cable and consumables are skipped so they don't become
 * room-sized boxes.
 */
export function placeGearList(
  session: Session,
  list: GearList,
): ModelEdit & { placed?: number } {
  const doc = session.loaded.document;

  const room = currentRoom(doc);
  const bounds = room ? roomBounds(room) : null;
  const originX = bounds ? bounds.minX : 0;
  const startY = (bounds ? bounds.maxY : 0) + 10 * UNITS_PER_FOOT;
  // Flow the staging grid across a strip as wide as the room, so it sits neatly
  // below the plan rather than trailing off to one side.
  const stripWidth = bounds ? Math.max(40 * UNITS_PER_FOOT, bounds.maxX - bounds.minX) : 240 * UNITS_PER_FOOT;
  const gap = 2 * UNITS_PER_FOOT;
  const MAX = 1500;

  const created: number[] = [];
  let placed = 0;
  let cursorX = originX;
  let rowY = startY;
  let rowHeight = 0;
  let index = indexDocument(doc);

  for (const item of walkItems(list)) {
    if (item.children.length || item.note) continue; // packages/instructions are not objects
    const description = item.description.trim();
    if (!description || NOT_DRAWN.test(description)) continue;
    const qty = Math.max(0, Math.min(Math.round(item.quantity || 0), 200));

    // Size each staging cell to the item's own footprint so a screen or a stage
    // deck doesn't land on top of its neighbours the way a fixed pitch would.
    const size = parseDimensions(description);
    const w = Math.max(2 * UNITS_PER_FOOT, size.width);
    const h = Math.max(2 * UNITS_PER_FOOT, size.height);
    const cellW = w + gap;
    const cellH = h + gap;

    for (let n = 0; n < qty && placed < MAX; n++) {
      if (cursorX > originX && cursorX - originX + cellW > stripWidth) {
        cursorX = originX;
        rowY += rowHeight;
        rowHeight = 0;
      }
      const cx = cursorX + w / 2;
      const cy = rowY + h / 2;
      const result = placeGear(doc, index, description, cx, cy, { width: w, height: h });
      if (result.ok && result.created?.length) {
        created.push(...result.created);
        placed++;
        // A synthesized shape must enter the index before it can be cloned by
        // name; a matched clone reuses a template already in it.
        if (result.method !== 'matched') index = indexDocument(doc);
      }
      cursorX += cellW;
      rowHeight = Math.max(rowHeight, cellH);
    }
  }

  if (!placed) return { ok: false, reason: 'this gear list has nothing drawable to place' };
  return {
    ok: true,
    created,
    placed,
    note: `Placed ${placed} gear object${placed === 1 ? '' : 's'} in a staging grid below the room.`,
  };
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
  depth?: number;
  perimeter?: number;
  aisle?: number;
  rowsPerBlock?: number;
  centreAisle?: number;
  stagger?: boolean;
  splay?: number;
  blocksAcross?: number;
  tableDiameter?: number;
  seatsPerTable?: number;
  maxSeats?: number;
  /** Which named layout this run belongs to. Defaults to "Main". */
  regionId?: string;
  /** Confine this layout to a rectangle (a zone). Omit to fill the room. */
  areaX?: number;
  areaY?: number;
  areaWidth?: number;
  areaHeight?: number;
}

function planFrom(request: SeatingRequestView): SeatingPlan {
  const plan = createSeatingPlan(request.style, { x: request.focusX, y: request.focusY });
  if (request.seatSpacing && request.seatSpacing > 0) plan.seatSpacing = request.seatSpacing;
  if (request.rowSpacing && request.rowSpacing > 0) plan.rowSpacing = request.rowSpacing;
  if (request.front != null) plan.clearances.front = Math.max(0, request.front);
  if (request.depth != null) plan.clearances.depth = Math.max(0, request.depth);
  if (request.perimeter != null) plan.clearances.perimeter = Math.max(0, request.perimeter);
  if (request.aisle != null) plan.clearances.aisle = Math.max(0, request.aisle);
  if (request.rowsPerBlock != null) plan.clearances.rowsPerBlock = Math.max(0, Math.floor(request.rowsPerBlock));
  if (request.centreAisle != null) plan.clearances.centreAisle = Math.max(0, request.centreAisle);
  if (request.stagger != null) plan.stagger = request.stagger;
  if (request.tableDiameter && request.tableDiameter > 0) plan.tableDiameter = request.tableDiameter;
  if (request.seatsPerTable && request.seatsPerTable > 0) plan.seatsPerTable = request.seatsPerTable;
  if (request.maxSeats && request.maxSeats > 0) plan.maxSeats = request.maxSeats;

  const blocks = request.blocksAcross && request.blocksAcross > 1 ? Math.floor(request.blocksAcross) : 1;
  plan.blocksAcross = blocks;

  // Splayed banks and side-by-side straight blocks are two different houses;
  // when blocks are asked for they win, so the splay fan is only built for a
  // single-block layout.
  if (blocks <= 1 && request.splay && Math.abs(request.splay) > 0.5) {
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

/** The layout this request targets; "Main" is the default single house. */
function regionKey(request: SeatingRequestView): string {
  return (request.regionId ?? 'Main').trim() || 'Main';
}

/** The zone a request confines its seating to, if any. */
function requestArea(request: SeatingRequestView): ReservedArea | undefined {
  if (!request.areaWidth || !request.areaHeight || request.areaWidth <= 0 || request.areaHeight <= 0) {
    return undefined;
  }
  return { x: request.areaX ?? 0, y: request.areaY ?? 0, width: request.areaWidth, height: request.areaHeight };
}

/**
 * A plan scoped to one region: confined to its zone, and reserving the stage
 * plus every *other* region's footprint so the layouts never overlap. This is
 * the shared reservation registry that lets several houses coexist.
 */
function planForRegion(request: SeatingRequestView): SeatingPlan {
  const plan = planFrom(request);
  const area = requestArea(request);
  if (area) {
    plan.area = { minX: area.x, minY: area.y, maxX: area.x + area.width, maxY: area.y + area.height };
  }
  const key = regionKey(request);
  const others: ReservedArea[] = [];
  for (const [id, region] of state.regions) {
    if (id !== key && region.area) others.push(region.area);
  }
  if (others.length) plan.reserved = [...plan.reserved, ...others];
  return plan;
}

export interface SeatingPreview {
  seats: number;
  tables: number;
  rows: number;
  dropped: number;
  notes: string[];
}

/** Solves without drawing, so the panel can show the count as sliders move. */
export function previewSeating(session: Session, request: SeatingRequestView): SeatingPreview {
  const room = currentRoom(session.loaded.document);
  if (!room) return { seats: 0, tables: 0, rows: 0, dropped: 0, notes: ['This plan has no room outline yet.'] };

  const solution = solveSeating(planForRegion(request), room);
  return {
    seats: solution.seats.length,
    tables: solution.tables.length,
    rows: solution.rowCount,
    dropped: solution.dropped,
    notes: solution.notes,
  };
}

/**
 * Draws a seating layout into a named region, replacing only that region's
 * previous run and leaving every other layout on the plan untouched.
 */
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

  const key = regionKey(request);
  const plan = planForRegion(request);
  const solution: SeatingSolution = solveSeating(plan, room);
  if (!solution.seats.length && !solution.tables.length) {
    return { ok: false, reason: 'that layout does not fit in this area' };
  }
  if (solution.tables.length && !table?.trim()) {
    return { ok: false, reason: 'this layout needs a table as well as a chair' };
  }

  const previous = state.regions.get(key)?.ids ?? [];
  const drawn = renderSeating(doc, indexDocument(doc), solution, { chair, table }, previous);
  if (!drawn.ok) return { ok: false, reason: drawn.reason, created: drawn.created };

  state.regions.set(key, { ids: drawn.created, area: requestArea(request) });
  const notes = [...solution.notes];
  notes.unshift(
    drawn.removed
      ? `Replaced the “${key}” layout (${drawn.removed} items).`
      : `Placed the “${key}” layout.`,
  );
  return { ok: true, created: drawn.created, note: notes.join(' ') || undefined };
}

/** Names of the seating layouts currently on the plan. */
export function seatingRegionNames(): string[] {
  return [...state.regions.keys()];
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

  const host = stageHost(doc);
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

/** Where a placed shape should live: the room container, else document level. */
function stageHost(doc: RVDocument) {
  for (const node of walk(doc)) {
    if (node.fields.childCountAt == null) continue;
    if (node.cls === 'RVRoomDef' || node.cls === 'RVRoom') return node;
  }
  return null;
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

  const host = stageHost(doc);
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
