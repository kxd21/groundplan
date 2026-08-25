/**
 * Stage decks, and the list that gets loaded onto the truck.
 *
 * A stage on a floor plan is normally one rectangle with a note beside it, which
 * is fine for showing where it goes and useless for building it. What the crew
 * needs is the deck count by size, the leg count by height, how much skirt to
 * bring, and where the stairs land — and none of that is derivable from a
 * rectangle, because the rectangle does not know the decks are 4 by 8.
 *
 * So a stage here is a set of levels, each tiled with real decks. The tiling is
 * what makes the build list true: a 24 x 16 stage is twelve 4x8 decks, and a
 * 22 x 16 stage is twelve 4x8 decks plus four 4x4s and a note that the last
 * column is short.
 */

import { rectangularRoom, roomFromPolygon, type RoomModel } from './room.js';
import { UNITS_PER_FOOT, UNITS_PER_INCH, type Point } from './rv.js';

const FT = UNITS_PER_FOOT;
const IN = UNITS_PER_INCH;

/** Deck sizes the trade stocks, longest edge first. */
export const DECK_SIZES: Array<{ label: string; width: number; depth: number }> = [
  { label: "4' x 8'", width: 8 * FT, depth: 4 * FT },
  { label: "6' x 8'", width: 6 * FT, depth: 8 * FT },
  { label: "8' x 6'", width: 8 * FT, depth: 6 * FT },
  { label: "4' x 6'", width: 6 * FT, depth: 4 * FT },
  { label: "4' x 4'", width: 4 * FT, depth: 4 * FT },
  { label: "2' x 8'", width: 8 * FT, depth: 2 * FT },
  { label: "2' x 4'", width: 4 * FT, depth: 2 * FT },
];

/** Leg heights that come in a set. */
export const LEG_HEIGHTS = [8 * IN, 16 * IN, 24 * IN, 32 * IN, 40 * IN, 48 * IN];

export interface Deck {
  id: string;
  x: number;
  y: number;
  width: number;
  depth: number;
  /** Size label, for the build list. */
  size: string;
  /** Deck surface height above the floor. */
  height: number;
  level: number;
}

export interface StageLevel {
  /** Surface height above the floor. */
  height: number;
  /** Footprint of this level. */
  x: number;
  y: number;
  width: number;
  depth: number;
  label?: string;
}

export type StairEdge = 'front' | 'back' | 'left' | 'right';

export interface Stair {
  id: string;
  level: number;
  edge: StairEdge;
  /** Distance along that edge to the near side of the stairs. */
  offset: number;
  width: number;
  /** Rise per tread; the count follows from the level height. */
  riserHeight: number;
  handrail: boolean;
}

/** A ramp is the accessible way onto a stage, and it is not a shallow stair. */
export interface Ramp {
  id: string;
  level: number;
  edge: StairEdge;
  /** Distance along that edge to the near side of the ramp. */
  offset: number;
  width: number;
  /**
   * Run per unit of rise. 12 is the ADA maximum for a new ramp — one foot of
   * run for every inch of rise — and shallower is always allowed.
   */
  slope: number;
  handrail: boolean;
}

/** Guardrail along one edge of one level. */
export interface Rail {
  id: string;
  level: number;
  edge: StairEdge;
  /** Length along that edge. Zero means the whole edge. */
  length: number;
  offset: number;
}

export interface StageBuild {
  id: string;
  name: string;
  levels: StageLevel[];
  stairs: Stair[];
  /** Accessible ramps. Separate from stairs: different parts, different rules. */
  ramps: Ramp[];
  /** Guardrails along named edges. */
  rails: Rail[];
  /** Skirt the visible edges. */
  skirted: boolean;
  /**
   * Force a stock deck size rather than letting the tiler choose.
   *
   * The tiler picks whatever tiles the footprint exactly, which is the right
   * default and the wrong answer when the shop only owns one size. A label
   * from `DECK_SIZES`; anything unrecognised is ignored rather than failing the
   * build.
   */
  preferredDeck?: string;
}

export interface StageSolution {
  decks: Deck[];
  /** Levels that could not be tiled exactly, with what is short. */
  notes: string[];
  /** Total deck surface. */
  area: number;
}

let counter = 0;
const nextId = (prefix: string) => `${prefix}-${(counter++).toString(36)}`;

/**
 * Tiles one level with stock decks.
 *
 * Laid out in rows from the front-left, largest deck first, falling back to
 * smaller stock as the edge is reached. A remainder that no stock size fills is
 * reported rather than fudged — a stage that is 3in over is a real problem on
 * site and hiding it in a rounded rectangle helps nobody.
 */
function tileLevel(
  level: StageLevel,
  index: number,
  notes: string[],
  preferredDeck?: string,
): Deck[] {
  const decks: Deck[] = [];
  const forced = preferredDeck
    ? DECK_SIZES.find((d) => d.label === preferredDeck)
    : undefined;
  if (preferredDeck && !forced) {
    notes.push(`"${preferredDeck}" is not a stock deck size; the tiler chose its own.`);
  }
  /*
   * The stock the tiler may use. Forcing a size means the shop owns one kind
   * of deck, so offering it the rest is not a helpful fallback — it produces a
   * parts list nobody can pull. A footprint that will not tile in the forced
   * size is reported short instead, which is the honest answer.
   */
  const SIZES = forced ? [forced] : DECK_SIZES;
  const primary = forced ?? DECK_SIZES[0];

  let shortDepth = 0;
  let shortWidth = 0;

  /** Prefer a stock size that tiles the level with no remainder; keep 4×8 primary when it fits. */
  const pickDepth = (remaining: number, fullWidth: number) => {
    const fits = SIZES.filter((d) => d.depth <= remaining + 1e-6);
    if (!fits.length) return undefined;
    const exact = fits.filter((d) => Math.abs(remaining % d.depth) < 1e-6);
    const widthFor = (depth: number) =>
      SIZES.filter((s) => s.depth === depth && Math.abs(fullWidth % s.width) < 1e-6).sort(
        (a, b) => b.width - a.width,
      )[0];
    const perfect = exact.filter((d) => widthFor(d.depth));
    if (perfect.length) {
      // Classic 4×8 wins when it tiles both axes — keep existing stage builds stable.
      const primaryWidthOk =
        Math.abs(fullWidth % primary.width) < 1e-6 &&
        Math.abs(remaining % primary.depth) < 1e-6;
      if (primaryWidthOk) {
        const primaryPerfect = perfect.find((d) => Math.abs(d.depth - primary.depth) < 1e-6);
        if (primaryPerfect) return primaryPerfect;
      }
      // Otherwise prefer the tiling with the fewest decks (e.g. 7×6×8 over 14×4×6).
      return perfect.sort((a, b) => {
        const aDecks = (fullWidth / widthFor(a.depth)!.width) * (remaining / a.depth);
        const bDecks = (fullWidth / widthFor(b.depth)!.width) * (remaining / b.depth);
        return aDecks - bDecks || b.depth - a.depth;
      })[0];
    }
    if (exact.length) {
      const primaryExact = exact.find((d) => Math.abs(d.depth - primary.depth) < 1e-6);
      if (primaryExact) return primaryExact;
      return exact.sort((a, b) => b.depth - a.depth)[0];
    }
    return fits.sort((a, b) => b.depth - a.depth)[0];
  };
  const pickWidth = (remaining: number, depth: number) => {
    const fits = SIZES.filter((d) => d.depth === depth && d.width <= remaining + 1e-6);
    if (!fits.length) return undefined;
    const exact = fits.filter((d) => Math.abs(remaining % d.width) < 1e-6).sort((a, b) => b.width - a.width);
    if (exact.length) return exact[0];
    return fits.sort((a, b) => b.width - a.width)[0];
  };

  for (let y = 0; y < level.depth - 1e-6; ) {
    const remainingDepth = level.depth - y;
    const depthChoice = pickDepth(remainingDepth, level.width);
    if (!depthChoice) {
      shortDepth = remainingDepth;
      break;
    }

    for (let x = 0; x < level.width - 1e-6; ) {
      const remainingWidth = level.width - x;
      const choice = pickWidth(remainingWidth, depthChoice.depth);
      if (!choice) {
        shortWidth = Math.max(shortWidth, remainingWidth);
        break;
      }

      decks.push({
        id: nextId('deck'),
        x: level.x + x,
        y: level.y + y,
        width: choice.width,
        depth: choice.depth,
        size: choice.label,
        height: level.height,
        level: index,
      });
      x += choice.width;
    }

    y += depthChoice.depth;
  }

  const name = level.label ?? `Level ${index + 1}`;
  if (shortWidth > 0.5) {
    notes.push(`${name} is ${(shortWidth / FT).toFixed(2)} ft short of a full deck across the front.`);
  }
  if (shortDepth > 0.5) {
    notes.push(`${name} is ${(shortDepth / FT).toFixed(2)} ft short of a full deck front to back.`);
  }
  void primary;

  return decks;
}

/** Works out the decks for a whole build. */
export function solveStage(build: StageBuild): StageSolution {
  const notes: string[] = [];
  const decks: Deck[] = [];

  build.levels.forEach((level, index) => {
    if (level.width <= 0 || level.depth <= 0) {
      notes.push(`${level.label ?? `Level ${index + 1}`} has no size.`);
      return;
    }
    decks.push(...tileLevel(level, index, notes, build.preferredDeck));
  });

  return {
    decks,
    notes,
    area: decks.reduce((sum, d) => sum + d.width * d.depth, 0),
  };
}

// ---------------------------------------------------------------------------
// The build list
// ---------------------------------------------------------------------------

export interface BuildListLine {
  item: string;
  quantity: number;
  detail?: string;
}

/** Treads needed to climb a level, and the rise each one takes. */
export function stairSteps(height: number, riserHeight: number): { count: number; actualRise: number } {
  if (height <= 0 || riserHeight <= 0) return { count: 0, actualRise: 0 };
  const count = Math.max(1, Math.round(height / riserHeight));
  return { count, actualRise: height / count };
}

/**
 * What to load, in the order a crew chief reads it.
 *
 * Legs are counted at four per deck, which is how modular staging is actually
 * built — decks share legs at their corners in theory and nobody packs to that
 * assumption in practice.
 */
export function stageBuildList(build: StageBuild, solution: StageSolution): BuildListLine[] {
  const lines: BuildListLine[] = [];

  const bySize = new Map<string, number>();
  for (const deck of solution.decks) bySize.set(deck.size, (bySize.get(deck.size) ?? 0) + 1);
  for (const [size, quantity] of [...bySize].sort((a, b) => b[1] - a[1])) {
    lines.push({ item: `Deck ${size}`, quantity });
  }

  const byHeight = new Map<number, number>();
  for (const deck of solution.decks) byHeight.set(deck.height, (byHeight.get(deck.height) ?? 0) + 4);
  for (const [height, quantity] of [...byHeight].sort((a, b) => a[0] - b[0])) {
    const stock = LEG_HEIGHTS.find((h) => Math.abs(h - height) < 0.5);
    lines.push({
      item: `Legs ${(height / IN).toFixed(0)}in`,
      quantity,
      detail: stock ? undefined : 'not a stock leg height. Needs adjustable legs or packing',
    });
  }

  if (build.skirted) {
    for (const level of build.levels) {
      const perimeter = 2 * (level.width + level.depth);
      lines.push({
        item: `Skirt for ${level.label ?? 'stage'}`,
        quantity: Math.ceil(perimeter / FT),
        detail: 'linear feet',
      });
    }
  }

  for (const stair of build.stairs) {
    const level = build.levels[stair.level];
    if (!level) continue;
    const steps = stairSteps(level.height, stair.riserHeight);
    lines.push({
      item: `Stair unit ${(stair.width / FT).toFixed(0)}ft`,
      quantity: 1,
      detail: `${steps.count} treads at ${(steps.actualRise / IN).toFixed(1)}in rise`,
    });
    if (stair.handrail) lines.push({ item: 'Handrail', quantity: 2 });
  }

  /*
   * A ramp is priced by its run, not by its rise. One inch of rise needs
   * `slope` inches of run, so a 32in stage at the ADA maximum of 1:12 is
   * thirty-two feet of ramp — which is usually the moment somebody discovers
   * the ramp does not fit in the room, and is exactly why it belongs on the
   * build list rather than in somebody's head.
   */
  for (const ramp of build.ramps) {
    const level = build.levels[ramp.level];
    if (!level) continue;
    const run = level.height * ramp.slope;
    const landings = Math.max(0, Math.ceil(level.height / (30 * IN)) - 1);
    lines.push({
      item: `Ramp ${(ramp.width / FT).toFixed(0)}ft`,
      quantity: 1,
      detail:
        `${(run / FT).toFixed(1)}ft run at 1:${ramp.slope} for ` +
        `${(level.height / IN).toFixed(0)}in rise` +
        (landings ? `, ${landings} intermediate landing${landings === 1 ? '' : 's'}` : ''),
    });
    if (ramp.handrail) {
      lines.push({
        item: 'Ramp handrail',
        quantity: 2,
        detail: `${(run / FT).toFixed(1)}ft each side`,
      });
    }
  }

  for (const rail of build.rails) {
    const level = build.levels[rail.level];
    if (!level) continue;
    const edgeLength =
      rail.edge === 'left' || rail.edge === 'right' ? level.depth : level.width;
    const length = rail.length > 0 ? rail.length : edgeLength;
    lines.push({
      item: `Guardrail ${rail.edge}`,
      quantity: Math.ceil(length / FT),
      detail: `linear feet on ${level.label ?? `level ${rail.level + 1}`}`,
    });
  }

  return lines;
}

/**
 * Flags anything that would fail an inspection or an eyeball on site.
 *
 * These are the checks worth making automatically, not a substitute for the
 * local code: riser heights and guardrail thresholds vary by jurisdiction, and
 * the numbers used here are the common ones rather than any particular
 * authority's.
 */
export function stageWarnings(build: StageBuild): string[] {
  const warnings: string[] = [];

  for (const [index, level] of build.levels.entries()) {
    const name = level.label ?? `Level ${index + 1}`;
    if (level.height > 30 * IN && !build.stairs.some((s) => s.level === index)) {
      warnings.push(`${name} is ${(level.height / IN).toFixed(0)}in high and has no stairs.`);
    }
    if (level.height >= 48 * IN) {
      warnings.push(`${name} is 4 ft or more above the floor. Check whether guardrail is required.`);
    }
  }

  for (const stair of build.stairs) {
    const level = build.levels[stair.level];
    if (!level) {
      warnings.push('A stair is attached to a level that does not exist.');
      continue;
    }
    const steps = stairSteps(level.height, stair.riserHeight);
    // Portable staging is set with 8in risers as standard — a 24in stage is
    // three steps — so the threshold here is above that, not at the 7.75in a
    // building code uses for permanent stairs.
    if (steps.actualRise > 8.25 * IN) {
      warnings.push(`Stairs to ${level.label ?? `level ${stair.level + 1}`} rise ${(steps.actualRise / IN).toFixed(1)}in a step, which is steep.`);
    }
    if (stair.width < 36 * IN) {
      warnings.push('A stair narrower than 36in will be tight for two-way traffic.');
    }
    if (level.height > 30 * IN && !stair.handrail) {
      warnings.push('Stairs over 30in usually need a handrail.');
    }
  }

  for (const ramp of build.ramps) {
    const level = build.levels[ramp.level];
    if (!level) {
      warnings.push('A ramp is attached to a level that does not exist.');
      continue;
    }
    // 1:12 is the ADA maximum for a new ramp. Anything steeper is a slope
    // somebody will struggle with, whatever it is called on the drawing.
    if (ramp.slope < 12) {
      warnings.push(
        `The ramp to ${level.label ?? `level ${ramp.level + 1}`} is 1:${ramp.slope}, ` +
          'steeper than the 1:12 an accessible ramp allows.',
      );
    }
    if (ramp.width < 36 * IN) {
      warnings.push('An accessible ramp needs at least 36in of clear width.');
    }
    // A run this long has to go somewhere, and it is rarely where the drawing
    // first put it.
    const run = level.height * ramp.slope;
    if (run > 30 * FT) {
      warnings.push(
        `The ramp to ${level.label ?? `level ${ramp.level + 1}`} runs ` +
          `${(run / FT).toFixed(0)}ft. Check it fits, and that it has landings.`,
      );
    }
    if (level.height > 30 * IN && !ramp.handrail) {
      warnings.push('A ramp rising more than 30in usually needs handrails both sides.');
    }
  }

  // Guardrail is the answer to the height warning above, so only complain when
  // the height is there and the rail is not.
  for (const [index, level] of build.levels.entries()) {
    if (level.height >= 48 * IN && !build.rails.some((r) => r.level === index)) {
      warnings.push(
        `${level.label ?? `Level ${index + 1}`} is 4ft or more up with no guardrail on the build.`,
      );
    }
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Placing the stage in the room
// ---------------------------------------------------------------------------

/** The stage as a room-shaped object, for reserving floor from the seating. */
export function stageFootprint(build: StageBuild): RoomModel | null {
  if (!build.levels.length) return null;
  const minX = Math.min(...build.levels.map((l) => l.x));
  const minY = Math.min(...build.levels.map((l) => l.y));
  const maxX = Math.max(...build.levels.map((l) => l.x + l.width));
  const maxY = Math.max(...build.levels.map((l) => l.y + l.depth));
  return rectangularRoom(maxX - minX, maxY - minY, build.name, { x: minX, y: minY });
}

/** The area a seating plan should keep clear: the stage plus its stair landings. */
export function stageReservedAreas(build: StageBuild): Array<{ x: number; y: number; width: number; height: number; label: string }> {
  const out: Array<{ x: number; y: number; width: number; height: number; label: string }> = [];

  for (const level of build.levels) {
    out.push({ x: level.x, y: level.y, width: level.width, height: level.depth, label: level.label ?? build.name });
  }

  for (const stair of build.stairs) {
    const level = build.levels[stair.level];
    if (!level) continue;
    // A stair needs its own run plus a landing to step off into.
    const run = Math.max(3 * FT, stairSteps(level.height, stair.riserHeight).count * 11 * IN) + 3 * FT;
    switch (stair.edge) {
      case 'front':
        out.push({ x: level.x + stair.offset, y: level.y + level.depth, width: stair.width, height: run, label: 'Stairs' });
        break;
      case 'back':
        out.push({ x: level.x + stair.offset, y: level.y - run, width: stair.width, height: run, label: 'Stairs' });
        break;
      case 'left':
        out.push({ x: level.x - run, y: level.y + stair.offset, width: run, height: stair.width, label: 'Stairs' });
        break;
      case 'right':
        out.push({ x: level.x + level.width, y: level.y + stair.offset, width: run, height: stair.width, label: 'Stairs' });
        break;
    }
  }

  return out;
}

/** The outline of every deck, for drawing the stage into the plan. */
export function deckOutlines(solution: StageSolution): Point[][] {
  return solution.decks.map((deck) => [
    { x: deck.x, y: deck.y },
    { x: deck.x + deck.width, y: deck.y },
    { x: deck.x + deck.width, y: deck.y + deck.depth },
    { x: deck.x, y: deck.y + deck.depth },
    { x: deck.x, y: deck.y },
  ]);
}

/** A plain single-level stage, which is most of them. */
export function simpleStage(
  x: number,
  y: number,
  width: number,
  depth: number,
  height = 24 * IN,
  name = 'Stage',
  stairEdges: StairEdge[] = ['front'],
): StageBuild {
  const stairs: Stair[] = stairEdges.map((edge) => ({
    id: nextId('stair'),
    level: 0,
    edge,
    offset: edge === 'left' || edge === 'right' ? depth / 2 - 2 * FT : width / 2 - 2 * FT,
    width: 4 * FT,
    riserHeight: 8 * IN,
    handrail: height > 30 * IN,
  }));

  return {
    id: nextId('stage'),
    name,
    levels: [{ x, y, width, depth, height, label: name }],
    stairs,
    ramps: [],
    rails: [],
    skirted: true,
  };
}

/**
 * Two house-riser tiers stacked front-to-back — the Card Party / banquet
 * house-riser pattern (e.g. 8'×42' at 32" in front of 8'×42' at 24").
 */
export function tieredStage(
  x: number,
  y: number,
  width: number,
  front: { depth: number; height: number; label?: string },
  back: { depth: number; height: number; label?: string },
  stairEdges: StairEdge[] = ['left', 'right'],
): StageBuild {
  const frontLevel: StageLevel = {
    x,
    y: y + back.depth,
    width,
    depth: front.depth,
    height: front.height,
    label: front.label ?? `House Riser ${(front.depth / FT).toFixed(0)}' X ${(width / FT).toFixed(0)}' at ${(front.height / IN).toFixed(0)}" Height`,
  };
  const backLevel: StageLevel = {
    x,
    y,
    width,
    depth: back.depth,
    height: back.height,
    label: back.label ?? `House Riser ${(back.depth / FT).toFixed(0)}' X ${(width / FT).toFixed(0)}' at ${(back.height / IN).toFixed(0)}" Height`,
  };
  // Stairs attach to the taller (usually front) level.
  const climbLevel = front.height >= back.height ? 0 : 1;
  const climb = climbLevel === 0 ? frontLevel : backLevel;
  const stairs: Stair[] = stairEdges.map((edge) => ({
    id: nextId('stair'),
    level: climbLevel,
    edge,
    offset: edge === 'left' || edge === 'right' ? climb.depth / 2 - 2 * FT : width / 2 - 2 * FT,
    width: 4 * FT,
    riserHeight: 8 * IN,
    handrail: climb.height > 30 * IN,
  }));

  return {
    id: nextId('stage'),
    name: 'Tiered stage',
    // Front listed first so stair level index 0 matches the climb level when
    // the front is taller (the common case).
    levels: [frontLevel, backLevel],
    stairs,
    ramps: [],
    rails: [],
    skirted: true,
  };
}

/** Tread rectangles for drawing a stair unit on the plan. */
export function stairDeckOutlines(build: StageBuild): Point[][] {
  const out: Point[][] = [];
  for (const stair of build.stairs) {
    const level = build.levels[stair.level];
    if (!level) continue;
    const steps = stairSteps(level.height, stair.riserHeight);
    const tread = 11 * IN;
    for (let i = 0; i < steps.count; i++) {
      const run = (i + 1) * tread;
      let x = 0;
      let y = 0;
      let w = stair.width;
      let d = tread;
      switch (stair.edge) {
        case 'front':
          x = level.x + stair.offset;
          y = level.y + level.depth + i * tread;
          break;
        case 'back':
          x = level.x + stair.offset;
          y = level.y - run;
          break;
        case 'left':
          x = level.x - run;
          y = level.y + stair.offset;
          w = tread;
          d = stair.width;
          break;
        case 'right':
          x = level.x + level.width + i * tread;
          y = level.y + stair.offset;
          w = tread;
          d = stair.width;
          break;
      }
      out.push([
        { x, y },
        { x: x + w, y },
        { x: x + w, y: y + d },
        { x, y: y + d },
        { x, y },
      ]);
    }
  }
  return out;
}

/** Room-shaped outline of a level, for containment tests. */
export function levelOutline(level: StageLevel): RoomModel {
  return roomFromPolygon(
    [
      { x: level.x, y: level.y },
      { x: level.x + level.width, y: level.y },
      { x: level.x + level.width, y: level.y + level.depth },
      { x: level.x, y: level.y + level.depth },
    ],
    level.label ?? 'level',
  );
}

/** One level in a multi-level build, as a caller describes it. */
export interface LevelSpec {
  depth: number;
  height: number;
  label?: string;
}

/**
 * A stage of any number of levels, stacked front to back.
 *
 * `simpleStage` makes one level and `tieredStage` makes exactly two, which
 * covers the common house-riser patterns and stops precisely where a real
 * build gets interesting: a keynote set with a downstage thrust, a main deck
 * and an upstage band riser is three, and an awards show with a stepped
 * chorus is more. The model has always held `StageLevel[]`; this is the
 * builder that fills it.
 *
 * Levels are laid front to back in the order given, each starting where the
 * one before it ended, so the depths are read the way they are quoted on site.
 */
export function multiLevelStage(
  x: number,
  y: number,
  width: number,
  levels: LevelSpec[],
  options: {
    name?: string;
    stairEdges?: StairEdge[];
    rampEdges?: StairEdge[];
    railEdges?: StairEdge[];
    preferredDeck?: string;
    skirted?: boolean;
  } = {},
): StageBuild {
  const name = options.name ?? 'Stage';
  const built: StageLevel[] = [];
  let cursor = y;

  for (const [index, spec] of levels.entries()) {
    if (!(spec.depth > 0)) continue;
    built.push({
      x,
      y: cursor,
      width,
      depth: spec.depth,
      height: spec.height,
      label: spec.label ?? (levels.length === 1 ? name : `${name} level ${index + 1}`),
    });
    cursor += spec.depth;
  }

  if (!built.length) {
    return { id: nextId('stage'), name, levels: [], stairs: [], ramps: [], rails: [], skirted: false };
  }

  // Access attaches to the tallest level: that is the one somebody has to get
  // up to, and the one a code officer asks about.
  const tallest = built.reduce(
    (best, level, index) => (level.height > built[best]!.height ? index : best),
    0,
  );
  const target = built[tallest]!;
  const along = (edge: StairEdge) =>
    edge === 'left' || edge === 'right' ? target.depth : target.width;

  const stairs: Stair[] = (options.stairEdges ?? []).map((edge) => ({
    id: nextId('stair'),
    level: tallest,
    edge,
    offset: Math.max(0, along(edge) / 2 - 2 * FT),
    width: 4 * FT,
    riserHeight: 8 * IN,
    handrail: target.height > 30 * IN,
  }));

  const ramps: Ramp[] = (options.rampEdges ?? []).map((edge) => ({
    id: nextId('ramp'),
    level: tallest,
    edge,
    offset: Math.max(0, along(edge) / 2 - 2 * FT),
    width: 4 * FT,
    slope: 12,
    handrail: target.height > 30 * IN,
  }));

  const rails: Rail[] = (options.railEdges ?? []).map((edge) => ({
    id: nextId('rail'),
    level: tallest,
    edge,
    length: 0,
    offset: 0,
  }));

  return {
    id: nextId('stage'),
    name,
    levels: built,
    stairs,
    ramps,
    rails,
    skirted: options.skirted !== false,
    preferredDeck: options.preferredDeck,
  };
}
