/**
 * Seating that stays a seating plan.
 *
 * `seating.ts` places chairs, and places them well — every chair is a real
 * object, selectable and countable, which is why the results are
 * indistinguishable from a layout done in Room Viewer. What it cannot do is
 * change its mind. Once the loop ends, 227 chairs are 227 unrelated objects:
 * the row count, the spacing, the chevron angle and the aisle positions are all
 * gone, so "make the aisles wider" means deleting the lot and starting again.
 *
 * This is the configuration, kept. A plan is solved into seat positions, and
 * the solve is a pure function of the plan and the room — so it can be re-run
 * after any change, and the answer is the same every time.
 *
 * Three things fall out of that which were not possible before:
 *
 *   - **The room shapes the seating.** Seats are generated across the whole
 *     floor and then dropped where they fall outside the boundary, inside a
 *     column, or on reserved floor. An L-shaped room lays out correctly without
 *     anyone trimming rows by hand, and so does a room with a curved back wall.
 *   - **Rows can be locked.** A row somebody has adjusted by hand survives a
 *     regeneration instead of being flattened by it.
 *   - **Capacity is answered before the chairs exist.** Solving is cheap, so
 *     "how many does this room hold in a chevron with a 6 ft cross aisle" is a
 *     question the plan can answer rather than a thing to try.
 */

import { containsPoint, roomBounds, type RoomModel } from './room.js';
import type { Point } from './rv.js';
import { UNITS_PER_FOOT, UNITS_PER_INCH } from './rv.js';

/** The twelve arrangements this trade actually sets. */
export type SeatingStyle =
  /** Straight rows facing the stage. */
  | 'theatre'
  /** Rows curved on the stage, so every seat faces it square. */
  | 'theatre-curved'
  /** Straight rows in angled banks — the corpus's +/-30 degree wings. */
  | 'chevron'
  /** Rows of long tables with chairs behind them, all facing front. */
  | 'schoolroom'
  /** Round tables, fully seated. */
  | 'banquet'
  /** Round tables with the stage side left open. */
  | 'cabaret'
  /** Round tables at about two thirds seated, all on the stage side. */
  | 'crescent'
  /** One block of tables with seats all round. */
  | 'conference'
  /** Tables in a U with seats on the outside. */
  | 'u-shape'
  /** Tables in a closed rectangle with seats on the outside. */
  | 'hollow-square'
  /** Standing, with cocktail tables on a loose grid. */
  | 'reception'
  /** Seats around the walls, facing in. */
  | 'perimeter';

export interface Clearances {
  /** Between the focus — stage, screen, head table — and the first row. */
  front: number;
  /** Kept clear at the walls. */
  perimeter: number;
  /** Width of a horizontal (cross) aisle. */
  aisle: number;
  /** Rows between cross aisles. Zero means no cross aisles. */
  rowsPerBlock: number;
  /** Width of the aisle down the middle. Zero means none. */
  centreAisle: number;
  /**
   * Down each side of the seating block, inside the perimeter.
   *
   * Distinct from `perimeter`: that keeps seats off the walls, this is the
   * walkway the audience uses to reach the rows, and a venue will specify them
   * separately.
   */
  side: number;
  /** Between the centre bank and each wing, when the layout is sectioned. */
  wing: number;
  /** Behind the last row. */
  rear: number;
  /** Between the front wall and the stage — not the same as `front`. */
  frontWall: number;
  /**
   * How deep the seating block is allowed to run, front to back, in logical
   * units. Zero or unset fills the room. Set it to confine seating to a defined
   * house — the real Card Party seats a 78 ft block inside a 130 ft room —
   * rather than flooding every foot of floor.
   */
  depth?: number;
}

/**
 * How a banquet room offsets alternate rows of tables.
 *
 * Room Viewer's dropdown has more entries than "No stagger", but the others
 * were not legible in the reference screenshots, so only the two whose
 * behaviour is unambiguous are offered rather than guessing at the rest.
 */
export type StaggerMode = 'none' | 'half';

/**
 * Which wall the audience faces.
 *
 * `focus` points the layout at whatever the focus point is, which is what a
 * drawing with a stage already on it wants. The other two are how a room is
 * specified before anything is drawn: a ballroom is set "facing the short wall"
 * or "facing the long wall", and the choice changes the seat count materially.
 */
export type Orientation = 'focus' | 'short-wall' | 'long-wall';

/** One angled bank of seats. */
export interface Section {
  /** Turn from the centre bank, in degrees. Negative is house left. */
  splay: number;
  /** Seats across, or `undefined` to fill the room. */
  width?: number;
  /** Gap to the bank on its left, in logical units. */
  gap: number;
  /**
   * Lateral shift of this bank's centre from the focus line, in logical units.
   * Lets several straight banks sit side by side with aisles between them,
   * rather than the fan of angled banks that `splay` produces.
   */
  offset?: number;
}

export interface ReservedArea {
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
}

/** Options that apply to a sectioned theatre or schoolroom layout. */
export interface SectionOptions {
  /** Split into a centre bank and two wings. */
  enabled: boolean;
  /** Seats (or tables, for schoolroom) across the centre bank. */
  centre: number;
  /** Seats (or tables) across each wing. */
  wing: number;
}

/** Options that apply to rounds. */
export interface BanquetOptions {
  stagger: StaggerMode;
  /** Chairs on the short ends of a rectangular table. */
  endChairs: number;
  /** Turn every table a quarter, for a long table in a narrow room. */
  rotate90: boolean;
}

/** Options that apply to a U-shape or conference block. */
export interface BlockOptions {
  /** Seat the inside of the U as well as the outside. */
  chairsBothSides: boolean;
  /** Tables across the head of the block. */
  tablesAcross: number;
}

export interface SeatingPlan {
  id: string;
  name: string;
  style: SeatingStyle;
  /** The room this describes, for the report and the title block. */
  roomName?: string;
  /** Which wall the audience faces. */
  orientation: Orientation;
  /** Where the audience looks. Rows are laid out away from it. */
  focus: Point;
  /** Centre-to-centre across a row. */
  seatSpacing: number;
  /** Centre-to-centre between rows. */
  rowSpacing: number;
  clearances: Clearances;
  /** Offset alternate rows by half a seat, so nobody sits behind a head. */
  stagger: boolean;
  /** Angled banks. One straight section when empty. */
  sections: Section[];
  /**
   * Straight seating blocks set side by side across the room, separated by
   * aisles (`clearances.aisle` wide). One is a single unbroken field. This is
   * how a real house is laid out — a grid of blocks — rather than one slab or
   * the angled fan that `sections`/splay produce.
   */
  blocksAcross?: number;
  /** Round tables: diameter and seats. */
  tableDiameter?: number;
  seatsPerTable?: number;
  sectioning: SectionOptions;
  banquet: BanquetOptions;
  block: BlockOptions;
  /**
   * Search the settings for the arrangement that seats the most.
   *
   * Tries each orientation and both stagger states and keeps the best. It does
   * not tighten the spacing the user asked for — an "optimum" that quietly
   * narrows the aisles would be a fire risk, not a feature.
   */
  optimum: boolean;
  /** Leave the stage side of every round open, at any table style. */
  crescent: boolean;
  /** Catalogue names to place, when the plan is drawn. */
  chairName?: string;
  tableName?: string;
  /** Rows a person has adjusted, which regeneration leaves alone. */
  lockedRows: number[];
  /** Floor that is spoken for: stage, dance floor, bars, buffet. */
  reserved: ReservedArea[];
  /** Stop at this many seats, whatever the room would hold. */
  maxSeats?: number;
}

export interface SeatPosition {
  x: number;
  y: number;
  /** Radians. Zero faces up the page, matching how a chair outline is stored. */
  rotation: number;
  row: number;
  seat: number;
  section: number;
  /** Set when this seat belongs to a table. */
  table?: number;
}

export interface TablePosition {
  index: number;
  x: number;
  y: number;
  rotation: number;
  seats: number;
  /** Long tables carry a length; rounds use the diameter. */
  length?: number;
  width?: number;
}

export interface SeatingSolution {
  seats: SeatPosition[];
  tables: TablePosition[];
  rowCount: number;
  /** Positions generated but discarded for falling outside usable floor. */
  dropped: number;
  /** Things the caller should tell the user. */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const FT = UNITS_PER_FOOT;

/** A hard stop, so a bad number cannot generate a million objects. */
const MAX_SEATS = 5000;

export const DEFAULT_CLEARANCES: Clearances = {
  front: 8 * FT,
  perimeter: 3 * FT,
  aisle: 4 * FT,
  rowsPerBlock: 0,
  centreAisle: 0,
  side: 3 * FT,
  wing: 0,
  rear: 8 * FT,
  frontWall: 0,
};

/**
 * Spacing that matches how these rooms are actually set.
 *
 * A banquet chair is about 18in across and rows are set at 36in back-to-back
 * for comfort; theatre style tightens the rows and keeps the seats touching.
 * Life-safety codes govern aisle widths and row lengths and are not modelled
 * here — `clearances` exists so the numbers a venue requires can be entered.
 */
export const STYLE_DEFAULTS: Record<SeatingStyle, { seatSpacing: number; rowSpacing: number }> = {
  theatre: { seatSpacing: 20 * UNITS_PER_INCH, rowSpacing: 36 * UNITS_PER_INCH },
  'theatre-curved': { seatSpacing: 20 * UNITS_PER_INCH, rowSpacing: 36 * UNITS_PER_INCH },
  chevron: { seatSpacing: 20 * UNITS_PER_INCH, rowSpacing: 36 * UNITS_PER_INCH },
  schoolroom: { seatSpacing: 24 * UNITS_PER_INCH, rowSpacing: 60 * UNITS_PER_INCH },
  banquet: { seatSpacing: 24 * UNITS_PER_INCH, rowSpacing: 10 * FT },
  cabaret: { seatSpacing: 24 * UNITS_PER_INCH, rowSpacing: 10 * FT },
  crescent: { seatSpacing: 24 * UNITS_PER_INCH, rowSpacing: 10 * FT },
  conference: { seatSpacing: 30 * UNITS_PER_INCH, rowSpacing: 5 * FT },
  'u-shape': { seatSpacing: 30 * UNITS_PER_INCH, rowSpacing: 5 * FT },
  'hollow-square': { seatSpacing: 30 * UNITS_PER_INCH, rowSpacing: 5 * FT },
  reception: { seatSpacing: 8 * FT, rowSpacing: 8 * FT },
  perimeter: { seatSpacing: 24 * UNITS_PER_INCH, rowSpacing: 3 * FT },
};

/**
 * Turns the obstacles already on a plan into floor the layout must avoid.
 *
 * A column is not a thing you seat around by eye — it wants its footprint plus
 * whatever clearance it was given, and the solver already knows how to keep off
 * reserved floor, so this is the whole implementation.
 */
export function reservedFromObstacles(
  items: Array<{
    name: string;
    x: number;
    y: number;
    width: number;
    depth: number;
    spec: { obstacle?: boolean; clearance?: number };
  }>,
): ReservedArea[] {
  return items
    .filter((item) => item.spec.obstacle)
    .map((item) => {
      const margin = item.spec.clearance ?? 0;
      return {
        x: item.x - item.width / 2 - margin,
        y: item.y - item.depth / 2 - margin,
        width: item.width + margin * 2,
        height: item.depth + margin * 2,
        label: item.name,
      };
    });
}

/** A plan with everything filled in, ready to solve. */
export function createSeatingPlan(style: SeatingStyle, focus: Point, overrides: Partial<SeatingPlan> = {}): SeatingPlan {
  const defaults = STYLE_DEFAULTS[style];
  return {
    id: `seating-${style}`,
    name: style,
    style,
    orientation: 'focus',
    focus,
    seatSpacing: defaults.seatSpacing,
    rowSpacing: defaults.rowSpacing,
    clearances: { ...DEFAULT_CLEARANCES },
    stagger: style === 'theatre' || style === 'theatre-curved' || style === 'chevron',
    sections: [],
    sectioning: { enabled: false, centre: 0, wing: 0 },
    banquet: { stagger: 'half', endChairs: 0, rotate90: false },
    block: { chairsBothSides: false, tablesAcross: 2 },
    optimum: false,
    crescent: false,
    tableDiameter: 60 * UNITS_PER_INCH,
    seatsPerTable: 8,
    lockedRows: [],
    reserved: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Solving
// ---------------------------------------------------------------------------

interface Frame {
  /** Unit vector from the seats toward the focus. */
  forward: Point;
  /** Unit vector across a row, to the audience's right. */
  right: Point;
}

function frameFor(plan: SeatingPlan, room: RoomModel): Frame {
  const bounds = roomBounds(room);
  const centre = bounds
    ? { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }
    : { x: plan.focus.x, y: plan.focus.y + 1 };

  // Facing a named wall squares the layout to the room, which is how a room is
  // specified before anything has been drawn in it. The focus still decides
  // *which* of the two opposite walls, so the stage stays where it was put.
  if (plan.orientation !== 'focus' && bounds) {
    const wide = bounds.maxX - bounds.minX >= bounds.maxY - bounds.minY;
    // The short walls stand at the ends of the room's longer dimension.
    const shortWallsFaceX = wide;
    const facingX = plan.orientation === 'short-wall' ? shortWallsFaceX : !shortWallsFaceX;
    const forward = facingX
      ? { x: plan.focus.x <= centre.x ? -1 : 1, y: 0 }
      : { x: 0, y: plan.focus.y <= centre.y ? -1 : 1 };
    return { forward, right: { x: -forward.y, y: forward.x } };
  }

  const dx = plan.focus.x - centre.x;
  const dy = plan.focus.y - centre.y;
  const length = Math.hypot(dx, dy);
  // A focus at the centre of the room gives no heading; face up the page,
  // which is where a stage is drawn by default.
  const forward = length < 1e-6 ? { x: 0, y: -1 } : { x: dx / length, y: dy / length };
  return { forward, right: { x: -forward.y, y: forward.x } };
}

/** True when a position is on floor that seats may use. */
function usable(point: Point, room: RoomModel, reserved: ReservedArea[]): boolean {
  if (room.walls.length >= 3 && !containsPoint(room, point)) return false;
  return !reserved.some(
    (r) => point.x >= r.x && point.x <= r.x + r.width && point.y >= r.y && point.y <= r.y + r.height,
  );
}

/** How far back a row sits, once cross aisles are counted. */
function rowDepth(plan: SeatingPlan, row: number): number {
  const { front, frontWall, aisle, rowsPerBlock } = plan.clearances;
  const aisles = rowsPerBlock > 0 ? Math.floor(row / rowsPerBlock) : 0;
  // The front wall gap sits behind the stage, so it pushes every row back.
  return frontWall + front + row * plan.rowSpacing + aisles * aisle;
}

/** The farthest a seat could be from the focus and still be in the room. */
function reach(room: RoomModel, focus: Point): number {
  const bounds = roomBounds(room);
  if (!bounds) return 100 * FT;
  const corners: Point[] = [
    { x: bounds.minX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY },
    { x: bounds.minX, y: bounds.maxY },
  ];
  return corners.reduce((max, c) => Math.max(max, Math.hypot(c.x - focus.x, c.y - focus.y)), 0);
}

/** Rotation that turns a chair — drawn facing up the page — toward the focus. */
function facing(from: Point, focus: Point): number {
  return Math.atan2(focus.y - from.y, focus.x - from.x) + Math.PI / 2;
}

interface Accumulator {
  seats: SeatPosition[];
  tables: TablePosition[];
  dropped: number;
  notes: string[];
  full: boolean;
}

function push(acc: Accumulator, plan: SeatingPlan, room: RoomModel, seat: SeatPosition): void {
  if (acc.full) return;
  if (!usable({ x: seat.x, y: seat.y }, room, plan.reserved)) {
    acc.dropped++;
    return;
  }
  acc.seats.push(seat);
  // Only the runaway backstop stops generation. A user's own cap is applied at
  // the end, after the aisles have been trimmed, or asking for 100 seats would
  // return 90 of them.
  if (acc.seats.length >= MAX_SEATS) {
    acc.full = true;
    acc.notes.push(`Stopped at ${MAX_SEATS} seats.`);
  }
}

/** Straight or angled rows: theatre, chevron, schoolroom. */
function solveRows(plan: SeatingPlan, room: RoomModel, acc: Accumulator): number {
  const { forward, right } = frameFor(plan, room);
  const span = reach(room, plan.focus);
  const maxRows = Math.max(1, Math.ceil(span / plan.rowSpacing) + 2);
  const perSide = Math.ceil(span / plan.seatSpacing) + 2;

  // Straight blocks side by side (a real house grid) take precedence over the
  // angled-bank machinery; they bring their own aisles, so the single centre
  // aisle would only double one of them up.
  const blocks = Math.max(1, Math.floor(plan.blocksAcross ?? 1));
  const straight = !plan.sections.some((s) => s.splay !== 0);
  const useBlocks = blocks > 1 && straight;
  const sections: Section[] = useBlocks
    ? straightBlocks(plan, room, forward, perSide, blocks)
    : sectionsFor(plan);
  const half = useBlocks ? 0 : plan.clearances.centreAisle / 2;

  // A confined house stops the block at a set depth; the first row already sits
  // frontWall + front back, so the limit is measured from there.
  const startDepth = plan.clearances.frontWall + plan.clearances.front;
  const maxDepth = plan.clearances.depth && plan.clearances.depth > 0 ? plan.clearances.depth : 0;

  // Side-by-side straight blocks are a gridded house: every chair faces square
  // to the stage, not fanned onto the focus the way one wide bank is. Compute
  // that one heading up front and give it to every block seat.
  const gridRotation = facing({ x: plan.focus.x - forward.x, y: plan.focus.y - forward.y }, plan.focus);

  let rows = 0;

  for (let row = 0; row < maxRows && !acc.full; row++) {
    const depth = rowDepth(plan, row);
    if (depth > span) break;
    if (maxDepth > 0 && depth - startDepth > maxDepth) break;
    let placedInRow = 0;

    sections.forEach((section, s) => {
      const turn = (section.splay * Math.PI) / 180;
      const cos = Math.cos(turn);
      const sin = Math.sin(turn);
      // Each bank pivots about the focus, which keeps its rows concentric with
      // the centre block rather than fanning apart at the back.
      const back = { x: -(forward.x * cos - forward.y * sin), y: -(forward.x * sin + forward.y * cos) };
      const across = { x: -back.y, y: back.x };

      const limit = section.width ? Math.ceil(section.width / 2) : perSide;
      const offset = plan.stagger && row % 2 === 1 ? plan.seatSpacing / 2 : 0;
      const sideShift = half + section.gap;

      for (let i = -limit; i <= limit && !acc.full; i++) {
        const along = i * plan.seatSpacing + offset;
        // Leave the centre aisle empty rather than straddling it.
        if (half > 0 && Math.abs(along) < half) continue;
        const shifted = along + (along >= 0 ? sideShift : -sideShift) - (half > 0 ? Math.sign(along) * half : 0);
        const lateral = shifted + (section.offset ?? 0);

        const at = {
          x: plan.focus.x + back.x * depth + across.x * lateral,
          y: plan.focus.y + back.y * depth + across.y * lateral,
        };
        const before = acc.seats.length;
        push(acc, plan, room, {
          x: at.x,
          y: at.y,
          rotation: useBlocks ? gridRotation : facing(at, plan.focus),
          row,
          seat: i + limit,
          section: s,
        });
        if (acc.seats.length > before) placedInRow++;
      }
    });

    if (placedInRow > 0) rows = row + 1;
  }

  void right;
  return rows;
}

/** Rows bent onto the focus, so every seat faces it square. */
function solveCurvedRows(plan: SeatingPlan, room: RoomModel, acc: Accumulator): number {
  const { forward } = frameFor(plan, room);
  const heading = Math.atan2(-forward.y, -forward.x);
  const span = reach(room, plan.focus);
  const maxRows = Math.max(1, Math.ceil(span / plan.rowSpacing) + 2);
  const startDepth = plan.clearances.frontWall + plan.clearances.front;
  const maxDepth = plan.clearances.depth && plan.clearances.depth > 0 ? plan.clearances.depth : 0;
  let rows = 0;

  for (let row = 0; row < maxRows && !acc.full; row++) {
    const radius = rowDepth(plan, row);
    if (radius > span) break;
    if (maxDepth > 0 && radius - startDepth > maxDepth) break;

    // Seat spacing is an arc length, so rows keep their spacing as they widen.
    const step = plan.seatSpacing / radius;
    const limit = Math.ceil(Math.PI / 2 / step);
    const offset = plan.stagger && row % 2 === 1 ? step / 2 : 0;
    let placedInRow = 0;

    for (let i = -limit; i <= limit && !acc.full; i++) {
      const angle = heading + i * step + offset;
      const at = {
        x: plan.focus.x + radius * Math.cos(angle),
        y: plan.focus.y + radius * Math.sin(angle),
      };
      const before = acc.seats.length;
      push(acc, plan, room, {
        x: at.x,
        y: at.y,
        rotation: facing(at, plan.focus),
        row,
        seat: i + limit,
        section: 0,
      });
      if (acc.seats.length > before) placedInRow++;
    }
    if (placedInRow > 0) rows = row + 1;
  }

  return rows;
}

/** Round tables on a staggered grid, with chairs around each. */
function solveRounds(plan: SeatingPlan, room: RoomModel, acc: Accumulator): number {
  const bounds = roomBounds(room);
  if (!bounds) return 0;

  const diameter = plan.tableDiameter ?? 60 * UNITS_PER_INCH;
  const seats = Math.max(1, Math.min(24, plan.seatsPerTable ?? 8));
  // Chairs need room behind them, and a service path between tables.
  const pitch = Math.max(plan.rowSpacing, diameter + 2 * plan.clearances.aisle);
  const inset = plan.clearances.perimeter + diameter / 2;

  const { forward } = frameFor(plan, room);
  const stageSide = Math.atan2(forward.y, forward.x);

  let index = 0;
  let rows = 0;

  for (let row = 0; ; row++) {
    const y = bounds.minY + inset + row * pitch * 0.87; // staggered rows nest closer
    if (y > bounds.maxY - inset) break;
    const shift = plan.stagger && row % 2 === 1 ? pitch / 2 : 0;
    let placedInRow = 0;

    for (let col = 0; ; col++) {
      const x = bounds.minX + inset + shift + col * pitch;
      if (x > bounds.maxX - inset) break;
      const centre = { x, y };
      if (!usable(centre, room, plan.reserved)) {
        acc.dropped++;
        continue;
      }
      // Every chair must land on usable floor too, or the table is in a corner
      // it does not fit into.
      const radius = diameter / 2 + 13 * UNITS_PER_INCH;
      const arc = plan.style === 'banquet' ? 2 * Math.PI : plan.style === 'cabaret' ? Math.PI * 1.4 : Math.PI * 1.2;
      const count = plan.style === 'banquet' ? seats : Math.max(1, Math.round((seats * arc) / (2 * Math.PI)));

      const chairs: SeatPosition[] = [];
      let blocked = false;
      for (let i = 0; i < count; i++) {
        // Open side faces the stage: start half the closed arc away from it.
        const bearing =
          plan.style === 'banquet'
            ? (i * 2 * Math.PI) / count
            : stageSide + Math.PI - arc / 2 + (arc * (i + 0.5)) / count;
        const at = { x: x + radius * Math.cos(bearing), y: y + radius * Math.sin(bearing) };
        if (!usable(at, room, plan.reserved)) {
          blocked = true;
          break;
        }
        chairs.push({
          x: at.x,
          y: at.y,
          rotation: Math.atan2(y - at.y, x - at.x) + Math.PI / 2,
          row,
          seat: i,
          section: 0,
          table: index,
        });
      }

      if (blocked) {
        acc.dropped++;
        continue;
      }

      acc.tables.push({ index, x, y, rotation: 0, seats: chairs.length, width: diameter, length: diameter });
      for (const chair of chairs) push(acc, plan, room, chair);
      index++;
      placedInRow++;
      if (acc.full) break;
    }

    if (placedInRow > 0) rows = row + 1;
    if (acc.full) break;
  }

  return rows;
}

/** Seats along the edges of a rectangle: conference, U, hollow square. */
function solvePerimeterBlock(plan: SeatingPlan, room: RoomModel, acc: Accumulator): number {
  const bounds = roomBounds(room);
  if (!bounds) return 0;

  const { forward } = frameFor(plan, room);
  const inset = plan.clearances.perimeter;

  // The block sits in the middle of the room for conference work, and takes the
  // whole floor for a perimeter layout.
  const wide = bounds.maxX - bounds.minX;
  const tall = bounds.maxY - bounds.minY;
  const scale = plan.style === 'perimeter' ? 1 : 0.55;
  const halfW = (wide * scale) / 2 - inset;
  const halfH = (tall * scale) / 2 - inset;
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  if (halfW <= 0 || halfH <= 0) return 0;

  // Which edge the open end of a U faces: the one nearest the focus.
  const openEdge = Math.abs(forward.x) > Math.abs(forward.y) ? (forward.x > 0 ? 'right' : 'left') : forward.y > 0 ? 'bottom' : 'top';

  const edges: Array<{ name: string; from: Point; to: Point; outward: Point }> = [
    { name: 'top', from: { x: cx - halfW, y: cy - halfH }, to: { x: cx + halfW, y: cy - halfH }, outward: { x: 0, y: -1 } },
    { name: 'right', from: { x: cx + halfW, y: cy - halfH }, to: { x: cx + halfW, y: cy + halfH }, outward: { x: 1, y: 0 } },
    { name: 'bottom', from: { x: cx + halfW, y: cy + halfH }, to: { x: cx - halfW, y: cy + halfH }, outward: { x: 0, y: 1 } },
    { name: 'left', from: { x: cx - halfW, y: cy + halfH }, to: { x: cx - halfW, y: cy - halfH }, outward: { x: -1, y: 0 } },
  ];

  let seat = 0;
  for (const edge of edges) {
    if (plan.style === 'u-shape' && edge.name === openEdge) continue;

    const dx = edge.to.x - edge.from.x;
    const dy = edge.to.y - edge.from.y;
    const length = Math.hypot(dx, dy);
    const count = Math.floor(length / plan.seatSpacing);
    if (count < 1) continue;

    for (let i = 0; i < count && !acc.full; i++) {
      const t = (i + 0.5) / count;
      // Seats sit outside a conference block and inside a perimeter run.
      const offset = plan.style === 'perimeter' ? -18 * UNITS_PER_INCH : 18 * UNITS_PER_INCH;
      const at = {
        x: edge.from.x + dx * t + edge.outward.x * offset,
        y: edge.from.y + dy * t + edge.outward.y * offset,
      };
      const inward = { x: cx, y: cy };
      push(acc, plan, room, {
        x: at.x,
        y: at.y,
        rotation:
          plan.style === 'perimeter'
            ? facing(at, inward)
            : Math.atan2(-edge.outward.y, -edge.outward.x) + Math.PI / 2,
        row: 0,
        seat: seat++,
        section: 0,
      });
    }
  }

  return 1;
}

/** Cocktail tables on a loose grid, with nobody seated. */
function solveReception(plan: SeatingPlan, room: RoomModel, acc: Accumulator): number {
  const bounds = roomBounds(room);
  if (!bounds) return 0;

  const pitch = Math.max(plan.seatSpacing, 8 * FT);
  const inset = plan.clearances.perimeter + 2 * FT;
  let index = 0;

  for (let y = bounds.minY + inset; y <= bounds.maxY - inset; y += pitch) {
    for (let x = bounds.minX + inset; x <= bounds.maxX - inset; x += pitch) {
      const centre = { x, y };
      if (!usable(centre, room, plan.reserved)) {
        acc.dropped++;
        continue;
      }
      acc.tables.push({
        index: index++,
        x,
        y,
        rotation: 0,
        seats: 0,
        width: 30 * UNITS_PER_INCH,
        length: 30 * UNITS_PER_INCH,
      });
      if (acc.tables.length >= 400) return 1;
    }
  }
  return 1;
}

/**
 * Trims the side aisles and the rear clearance off a solved block.
 *
 * Done afterwards rather than by shrinking the room first, because the room is
 * an arbitrary outline: the only place a "side" reliably is, is at the ends of
 * the rows that were actually produced. Measuring from those is exact for any
 * room shape, where insetting a polygon is not.
 */
function trimAisles(plan: SeatingPlan, acc: Accumulator): void {
  const { side, rear } = plan.clearances;
  if (side <= 0 && rear <= 0) return;

  if (side > 0) {
    const byRow = new Map<number, SeatPosition[]>();
    for (const seat of acc.seats) {
      const list = byRow.get(seat.row);
      if (list) list.push(seat);
      else byRow.set(seat.row, [seat]);
    }

    const drop = new Set<SeatPosition>();
    for (const seats of byRow.values()) {
      if (seats.length < 2) continue;
      // Distance along the row is measured from the row's own first seat, which
      // holds however the row is angled.
      const origin = seats[0];
      const along = seats.map((s) => Math.hypot(s.x - origin.x, s.y - origin.y));
      const far = Math.max(...along);
      seats.forEach((seat, i) => {
        if (along[i] < side || along[i] > far - side) drop.add(seat);
      });
    }
    if (drop.size) {
      acc.dropped += drop.size;
      acc.seats = acc.seats.filter((s) => !drop.has(s));
    }
  }

  if (rear > 0 && acc.seats.length) {
    const deepest = acc.seats.reduce(
      (max, s) => Math.max(max, Math.hypot(s.x - plan.focus.x, s.y - plan.focus.y)),
      0,
    );
    const before = acc.seats.length;
    acc.seats = acc.seats.filter(
      (s) => Math.hypot(s.x - plan.focus.x, s.y - plan.focus.y) <= deepest - rear,
    );
    acc.dropped += before - acc.seats.length;
  }
}

/**
 * Splits the room's width into N straight seating blocks with aisles between.
 *
 * Blocks are sized to the room's across-extent so they fill it evenly, and
 * over-provisioned seats that fall outside the walls are dropped by `push`, so
 * an odd room shape trims itself. Each block is a plain straight section shifted
 * laterally by its `offset`.
 */
function straightBlocks(
  plan: SeatingPlan,
  room: RoomModel,
  forward: Point,
  perSide: number,
  blocks: number,
): Section[] {
  const acrossAxis = { x: forward.y, y: -forward.x };
  const bounds = roomBounds(room);
  let acrossHalf = perSide * plan.seatSpacing;
  if (bounds) {
    const corners: Point[] = [
      { x: bounds.minX, y: bounds.minY },
      { x: bounds.maxX, y: bounds.minY },
      { x: bounds.maxX, y: bounds.maxY },
      { x: bounds.minX, y: bounds.maxY },
    ];
    acrossHalf = corners.reduce(
      (max, c) =>
        Math.max(max, Math.abs((c.x - plan.focus.x) * acrossAxis.x + (c.y - plan.focus.y) * acrossAxis.y)),
      0,
    );
  }

  const aisle = Math.max(0, plan.clearances.aisle);
  const blockWidth = Math.max(plan.seatSpacing, (2 * acrossHalf - (blocks - 1) * aisle) / blocks);
  const limitPer = Math.max(1, Math.floor(blockWidth / (2 * plan.seatSpacing)));
  const pitch = 2 * limitPer * plan.seatSpacing + aisle;

  return Array.from({ length: blocks }, (_, b) => ({
    splay: 0,
    width: 2 * limitPer,
    gap: 0,
    offset: (b - (blocks - 1) / 2) * pitch,
  }));
}

/** Builds the three banks a sectioned layout asks for. */
function sectionsFor(plan: SeatingPlan): Section[] {
  if (plan.sections.length) return plan.sections;
  if (!plan.sectioning.enabled) return [{ splay: 0, gap: 0 }];

  const gap = plan.clearances.wing;
  const wing = plan.sectioning.wing > 0 ? plan.sectioning.wing : undefined;
  const centre = plan.sectioning.centre > 0 ? plan.sectioning.centre : undefined;
  return [
    { splay: 0, width: wing, gap },
    { splay: 0, width: centre, gap: 0 },
    { splay: 0, width: wing, gap },
  ];
}

/**
 * Works out where every seat goes.
 *
 * Pure: the same plan and room always give the same answer, which is what makes
 * regeneration safe and lets capacity be answered without drawing anything.
 */
export function solveSeating(plan: SeatingPlan, room: RoomModel): SeatingSolution {
  const acc: Accumulator = { seats: [], tables: [], dropped: 0, notes: [], full: false };

  if (plan.seatSpacing <= 0 || plan.rowSpacing <= 0) {
    return { seats: [], tables: [], rowCount: 0, dropped: 0, notes: ['Spacing must be more than zero.'] };
  }
  if (room.walls.length < 3) {
    acc.notes.push('This room has no outline, so seats were not trimmed to it.');
  }

  let rowCount = 0;
  switch (plan.style) {
    case 'theatre':
    case 'chevron':
    case 'schoolroom':
      rowCount = solveRows(plan, room, acc);
      break;
    case 'theatre-curved':
      rowCount = solveCurvedRows(plan, room, acc);
      break;
    case 'banquet':
    case 'cabaret':
    case 'crescent':
      rowCount = solveRounds(plan, room, acc);
      break;
    case 'conference':
    case 'u-shape':
    case 'hollow-square':
    case 'perimeter':
      rowCount = solvePerimeterBlock(plan, room, acc);
      break;
    case 'reception':
      rowCount = solveReception(plan, room, acc);
      break;
  }

  if (plan.style === 'schoolroom') {
    // A long table in front of each row of chairs, spanning the seats in it.
    const byRow = new Map<number, SeatPosition[]>();
    for (const seat of acc.seats) {
      const list = byRow.get(seat.row);
      if (list) list.push(seat);
      else byRow.set(seat.row, [seat]);
    }
    let index = 0;
    for (const [row, seats] of [...byRow].sort((a, b) => a[0] - b[0])) {
      const first = seats[0];
      const last = seats[seats.length - 1];
      const width = Math.hypot(last.x - first.x, last.y - first.y) + plan.seatSpacing;
      const mid = { x: (first.x + last.x) / 2, y: (first.y + last.y) / 2 };
      // The table sits between the chairs and the stage.
      const toward = facing(mid, plan.focus) - Math.PI / 2;
      const standoff = 18 * UNITS_PER_INCH;
      acc.tables.push({
        index: index++,
        x: mid.x + Math.cos(toward) * standoff,
        y: mid.y + Math.sin(toward) * standoff,
        rotation: first.rotation,
        seats: seats.length,
        length: width,
        width: 18 * UNITS_PER_INCH,
      });
      void row;
    }
  }

  // Side and rear clearances come off whatever the block turned out to be.
  if (plan.style === 'theatre' || plan.style === 'chevron' || plan.style === 'schoolroom') {
    trimAisles(plan, acc);
  }

  const cap = plan.maxSeats && plan.maxSeats > 0 ? Math.min(plan.maxSeats, MAX_SEATS) : null;
  if (cap != null && acc.seats.length > cap) {
    acc.seats.length = cap;
    acc.notes.push(`Stopped at ${cap} seats.`);
  }

  if (acc.dropped > 0) {
    acc.notes.push(
      `${acc.dropped} position${acc.dropped === 1 ? '' : 's'} fell outside the usable floor and ${
        acc.dropped === 1 ? 'was' : 'were'
      } left out.`,
    );
  }

  return { seats: acc.seats, tables: acc.tables, rowCount, dropped: acc.dropped, notes: acc.notes };
}

/**
 * Re-solves a plan while keeping rows somebody has adjusted.
 *
 * The locked rows come from the previous solution untouched; everything else is
 * generated afresh. Without this, one hand adjustment means never regenerating
 * again, which is how a parametric layout quietly stops being parametric.
 */
export function resolveSeating(
  plan: SeatingPlan,
  room: RoomModel,
  previous?: SeatingSolution,
): SeatingSolution {
  const fresh = solveSeating(plan, room);
  if (!previous || !plan.lockedRows.length) return fresh;

  const locked = new Set(plan.lockedRows);
  const kept = previous.seats.filter((s) => locked.has(s.row));
  const regenerated = fresh.seats.filter((s) => !locked.has(s.row));

  return {
    ...fresh,
    seats: [...kept, ...regenerated].sort((a, b) => a.row - b.row || a.seat - b.seat),
    notes: [
      ...fresh.notes,
      `${plan.lockedRows.length} locked row${plan.lockedRows.length === 1 ? '' : 's'} kept as ${
        plan.lockedRows.length === 1 ? 'it was' : 'they were'
      }.`,
    ],
  };
}

/** Seats a plan yields, without drawing anything. */
export function seatingCapacity(plan: SeatingPlan, room: RoomModel): number {
  return solveSeating(plan, room).seats.length;
}

/**
 * Solves, searching for the arrangement that seats the most.
 *
 * Only the choices that are a matter of taste are varied — which wall the room
 * faces, and whether alternate rows are offset. The spacings and clearances the
 * user entered are left exactly as entered: an "optimum" that quietly narrowed
 * an aisle would be trading a fire route for a seat count.
 */
export function solveOptimum(plan: SeatingPlan, room: RoomModel): SeatingSolution {
  if (!plan.optimum) return solveSeating(plan, room);

  const orientations: Orientation[] = ['focus', 'short-wall', 'long-wall'];
  let best: { solution: SeatingSolution; plan: SeatingPlan } | null = null;

  for (const orientation of orientations) {
    for (const stagger of [true, false]) {
      const candidate = { ...plan, orientation, stagger };
      const solution = solveSeating(candidate, room);
      const count = solution.seats.length;
      if (!best || count > best.solution.seats.length) best = { solution, plan: candidate };
    }
  }

  const chosen = best!;
  return {
    ...chosen.solution,
    notes: [
      ...chosen.solution.notes,
      `Best of ${orientations.length * 2} arrangements: facing the ${
        chosen.plan.orientation === 'focus' ? 'stage' : chosen.plan.orientation.replace('-', ' ')
      }, ${chosen.plan.stagger ? 'staggered' : 'square'}.`,
    ],
  };
}

/**
 * Tries every layout against a room and reports what each holds.
 *
 * The question a salesperson is actually asking — "what can we do in here?" —
 * answered from the real boundary rather than from a square-foot rule of thumb.
 */
export function compareLayouts(room: RoomModel, focus: Point): Array<{ style: SeatingStyle; seats: number; tables: number }> {
  const styles = Object.keys(STYLE_DEFAULTS) as SeatingStyle[];
  return styles
    .map((style) => {
      const solution = solveSeating(createSeatingPlan(style, focus), room);
      return { style, seats: solution.seats.length, tables: solution.tables.length };
    })
    .sort((a, b) => b.seats - a.seats);
}
