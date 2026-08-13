/**
 * Full layout-recipe apply — one path for CLI, Electron IPC, and MCP agents.
 *
 * Mutates an open Session through the same edit helpers the UI uses
 * (room / stage / seating / gear / labels). Fails closed on seat totals and
 * exact catalogue names.
 */

import { indexDocument, deleteNode } from '../format/edit.js';
import { placeGear } from '../format/place.js';
import { setPlanIdentity } from '../format/plan-skeleton.js';
import { buildSchedule } from '../format/schedule.js';
import { verifyWritable } from '../format/write.js';
import { UNITS_PER_FOOT, UNITS_PER_INCH, walk, type RVNode } from '../format/rv.js';
import type { Session } from '../main/session.js';
import { addStage, createRectangularRoom } from '../main/plan-model.js';
import type { UnitSystem } from '../format/units.js';
import { deriveRoom, roomBounds } from '../format/room.js';
import type { Inventory } from './model.js';
import {
  applyLayoutRecipeAnnotations,
  applyLayoutRecipeGear,
  applyLayoutRecipeSeating,
  isLayoutRecipe,
  layoutRecipeFitsRoom,
  scaleLayoutRecipeToRoom,
  stageRequestFromRecipe,
  validateLayoutRecipe,
  type LayoutRecipe,
  type LayoutRecipeApplyResult,
} from './layout-recipe.js';

export interface ApplyFullLayoutOptions {
  /** When the plan already has chairs, refuse unless true — and clear seating first. */
  replaceExistingSeating?: boolean;
  /** Also remove non-chair/table furniture before placing recipe gear. */
  replaceExistingGear?: boolean;
  /** Inventory for exact gear/chair name checks. Optional for hermetic stubs. */
  inventory?: Inventory;
  units?: UnitSystem;
  /** Skip writing room when one already exists. Default true. */
  createRoomIfMissing?: boolean;
  /** Replace/recreate rectangular room from recipe even if one exists (CLI rebuild). */
  forceRoom?: boolean;
  /**
   * When the plan already has a room, scale recipe coordinates into that room.
   * Default true. Ignored when forceRoom creates the recipe’s own room size.
   */
  fitToExistingRoom?: boolean;
  /** Apply identity fields from the recipe. Default true. */
  applyIdentity?: boolean;
  includeStage?: boolean;
  includeSeating?: boolean;
  includeGear?: boolean;
  includeAnnotations?: boolean;
}

export interface ApplyFullLayoutResult {
  ok: boolean;
  reason?: string;
  status?: string;
  chairsPlaced: number;
  gearPlaced: number;
  labelsPlaced: number;
  dimensionsPlaced: number;
  stagesPlaced: number;
  created: number[];
  seating?: LayoutRecipeApplyResult['seating'];
}

const CHAIR_NAME_RE = /chair|seat|stool|chiavari/i;
const TABLE_NAME_RE = /table|banquet|cabaret|cocktail|schoolroom|serpentine|high.?top/i;

function shapeCatalogueName(node: RVNode): string {
  return (
    node.labels.find(
      (l) => !/^(Arial|Times|Courier|Helvetica|Tahoma|Verdana|Symbol)/i.test(l),
    ) ?? ''
  );
}

/** Delete RVShape objects whose catalogue name matches. Returns how many were removed. */
export function clearMatchingShapes(
  session: Session,
  match: (name: string) => boolean,
): number {
  let deleted = 0;
  for (let pass = 0; pass < 40; pass++) {
    const index = indexDocument(session.loaded.document);
    const targets: RVNode[] = [];
    for (const node of walk(session.loaded.document)) {
      if (node.cls !== 'RVShape') continue;
      if (match(shapeCatalogueName(node))) targets.push(node);
    }
    if (!targets.length) break;
    const depthOf = (node: RVNode): number => {
      let depth = 0;
      let current: RVNode | undefined = node;
      while (current) {
        const parent = index.parentOf.get(current);
        if (!parent) break;
        depth++;
        current = parent;
      }
      return depth;
    };
    targets.sort((a, b) => depthOf(b) - depthOf(a));
    let removedThisPass = 0;
    for (const node of targets) {
      const live = indexDocument(session.loaded.document);
      const current = live.byId.get(node.id);
      if (!current) continue;
      const result = deleteNode(session.loaded.document, live, current);
      if (result.ok) {
        deleted++;
        removedThisPass++;
      }
    }
    if (removedThisPass) session.refresh();
    else break;
  }
  return deleted;
}

export function clearSeatingShapes(session: Session): number {
  return clearMatchingShapes(
    session,
    (name) => CHAIR_NAME_RE.test(name) || TABLE_NAME_RE.test(name),
  );
}

export function clearGearShapes(session: Session): number {
  return clearMatchingShapes(
    session,
    (name) =>
      Boolean(name) && !CHAIR_NAME_RE.test(name) && !TABLE_NAME_RE.test(name) && !/stage/i.test(name),
  );
}

function chairCount(session: Session): number {
  const schedule = buildSchedule(session.loaded.document);
  return schedule.groups.filter((g) => /chair/i.test(g.name)).reduce((a, g) => a + g.count, 0);
}

function gearNamesOnPlan(session: Session): Set<string> {
  const schedule = buildSchedule(session.loaded.document);
  return new Set(schedule.groups.map((g) => g.name));
}

/**
 * Applies a validated layout recipe onto an already-open Session.
 * Caller owns checkpoint/undo policy for IPC; CLI may wrap with its own.
 */
export function applyFullLayoutRecipe(
  session: Session,
  recipe: LayoutRecipe,
  options: ApplyFullLayoutOptions = {},
): ApplyFullLayoutResult {
  const empty: ApplyFullLayoutResult = {
    ok: false,
    chairsPlaced: 0,
    gearPlaced: 0,
    labelsPlaced: 0,
    dimensionsPlaced: 0,
    stagesPlaced: 0,
    created: [],
  };

  if (!isLayoutRecipe(recipe)) {
    return { ...empty, reason: 'not a groundplan-layout-recipe v1' };
  }

  const validated = validateLayoutRecipe(recipe, options.inventory);
  if (!validated.ok) {
    return { ...empty, reason: validated.reason };
  }

  const existingChairs = chairCount(session);
  if (existingChairs > 0 && !options.replaceExistingSeating) {
    return {
      ...empty,
      reason: `plan already has ${existingChairs} chairs — pass replaceExistingSeating to rebuild seating`,
    };
  }

  const created: number[] = [];
  const units = options.units ?? 'imperial';
  let stagesPlaced = 0;

  if (options.applyIdentity !== false && recipe.identity) {
    const patch: Partial<{ date: string; venue: string; event: string }> = {};
    if (recipe.identity.date) patch.date = recipe.identity.date;
    if (recipe.identity.venue) patch.venue = recipe.identity.venue;
    if (recipe.identity.event) patch.event = recipe.identity.event;
    if (Object.keys(patch).length) {
      const id = setPlanIdentity(session.loaded.document, patch);
      if (!id.ok) return { ...empty, reason: id.reason ?? 'could not set show identity' };
      session.refresh();
    }
  }

  const hasRoom = deriveRoom(session.loaded.document).source !== 'none';
  let working: LayoutRecipe = recipe;
  let fittedToRoom = false;

  if (recipe.room && (options.forceRoom || (!hasRoom && options.createRoomIfMissing !== false))) {
    const width = recipe.room.widthFt * UNITS_PER_FOOT;
    const depth = recipe.room.depthFt * UNITS_PER_FOOT;
    const room = createRectangularRoom(session, width, depth, units);
    if (!room.ok) return { ...empty, reason: room.reason ?? 'could not create room' };
    if (room.created) created.push(...room.created);
    session.refresh();
  } else if (!hasRoom && recipe.room) {
    return { ...empty, reason: 'plan has no room — draw or create one before applying this kit' };
  } else if (
    hasRoom &&
    options.fitToExistingRoom !== false &&
    !options.forceRoom &&
    recipe.room
  ) {
    const derived = deriveRoom(session.loaded.document);
    const bounds = roomBounds(derived.room);
    if (bounds) {
      const widthFt = (bounds.maxX - bounds.minX) / UNITS_PER_FOOT;
      const depthFt = (bounds.maxY - bounds.minY) / UNITS_PER_FOOT;
      if (!layoutRecipeFitsRoom(recipe, widthFt, depthFt)) {
        working = scaleLayoutRecipeToRoom(recipe, widthFt, depthFt);
        fittedToRoom = true;
      }
    }
  }

  if (options.replaceExistingSeating && options.includeSeating !== false) {
    clearSeatingShapes(session);
  }
  if (options.replaceExistingGear && options.includeGear !== false) {
    clearGearShapes(session);
  }

  const includeStage = options.includeStage !== false;
  const includeSeating = options.includeSeating !== false;
  const includeGear = options.includeGear !== false;
  const includeAnnotations = options.includeAnnotations !== false;

  if (includeStage) {
    for (const [i, stage] of (working.stage ?? []).entries()) {
      const req = stageRequestFromRecipe(stage);
      const built = addStage(session, req.x, req.y, req.width, req.depth, req.height, {
        back: req.back,
        stairs: req.stairs,
      });
      if (!built.ok) {
        return { ...empty, reason: `stage ${i + 1}: ${built.reason}`, created };
      }
      if (built.created) created.push(...built.created);
      stagesPlaced++;
      session.refresh();
    }
  }

  let seated: LayoutRecipeApplyResult = {
    ok: true,
    chairsPlaced: 0,
    gearPlaced: 0,
    labelsPlaced: 0,
    dimensionsPlaced: 0,
    seating: [],
  };

  if (includeSeating && working.seating.length) {
    // Seed a chair shape so theatre banks can synthesize without inventory IPC.
    const chair = working.seating[0]?.chair ?? 'Chair';
    let seedId: number | undefined;
    {
      const index = indexDocument(session.loaded.document);
      const seed = placeGear(
        session.loaded.document,
        index,
        chair,
        500 * UNITS_PER_FOOT,
        500 * UNITS_PER_FOOT,
        {
          width: 20.5 * UNITS_PER_INCH,
          height: 23.23 * UNITS_PER_INCH,
        },
      );
      if (seed.ok) {
        seedId = seed.created?.[0];
        session.refresh();
      }
    }

    seated = applyLayoutRecipeSeating(
      session.loaded.document,
      indexDocument(session.loaded.document),
      working,
    );
    if (!seated.ok) {
      return {
        ...empty,
        reason: seated.reason,
        chairsPlaced: seated.chairsPlaced,
        created,
        seating: seated.seating,
      };
    }
    session.refresh();

    if (seedId != null) {
      const index = indexDocument(session.loaded.document);
      const node = index.byId.get(seedId);
      if (node) {
        const removed = deleteNode(session.loaded.document, index, node);
        if (removed.ok) session.refresh();
      }
    }
  }

  let gearPlaced = 0;
  if (includeGear) {
    const geared = applyLayoutRecipeGear(
      session.loaded.document,
      indexDocument(session.loaded.document),
      working,
      options.inventory,
    );
    if (!geared.ok) {
      return {
        ...empty,
        reason: geared.reason,
        chairsPlaced: seated.chairsPlaced,
        gearPlaced: geared.gearPlaced,
        created,
        seating: seated.seating,
      };
    }
    gearPlaced = geared.gearPlaced;
    session.refresh();
  }

  let labelsPlaced = 0;
  let dimensionsPlaced = 0;
  if (includeAnnotations) {
    const notes = applyLayoutRecipeAnnotations(
      session.loaded.document,
      indexDocument(session.loaded.document),
      working,
    );
    if (!notes.ok) {
      return {
        ...empty,
        reason: notes.reason,
        chairsPlaced: seated.chairsPlaced,
        gearPlaced,
        created,
        seating: seated.seating,
      };
    }
    labelsPlaced = notes.labelsPlaced ?? 0;
    dimensionsPlaced = notes.dimensionsPlaced ?? 0;
    session.refresh();
  }

  if (includeGear) {
    for (const name of recipe.expectations.requireGearNames ?? []) {
      if (![...gearNamesOnPlan(session)].some((n) => n === name || n.includes(name))) {
        const onPlan = gearNamesOnPlan(session);
        if (!onPlan.has(name)) {
          const found = [...onPlan].some((n) => n.toLowerCase() === name.toLowerCase());
          if (!found) {
            return {
              ...empty,
              reason: `required gear “${name}” not found on plan after apply`,
              chairsPlaced: seated.chairsPlaced,
              gearPlaced,
              labelsPlaced,
              dimensionsPlaced,
              stagesPlaced,
              created,
              seating: seated.seating,
            };
          }
        }
      }
    }
  }

  const writable = verifyWritable(session.loaded.document);
  if (!writable.ok) {
    return {
      ...empty,
      reason: writable.reason ?? 'plan is not writable after apply',
      chairsPlaced: seated.chairsPlaced,
      gearPlaced,
      labelsPlaced,
      dimensionsPlaced,
      stagesPlaced,
      created,
      seating: seated.seating,
    };
  }

  const parts = [
    includeSeating ? `${seated.chairsPlaced} chairs` : null,
    includeGear ? `${gearPlaced} gear` : null,
    includeStage ? `${stagesPlaced} stage(s)` : null,
  ].filter(Boolean);
  return {
    ok: true,
    status: fittedToRoom
      ? `Applied kit · fitted to room · ${parts.join(' · ')}`
      : `Applied kit · ${parts.join(' · ')}`,
    chairsPlaced: seated.chairsPlaced,
    gearPlaced,
    labelsPlaced,
    dimensionsPlaced,
    stagesPlaced,
    created,
    seating: seated.seating,
  };
}

/** Headless: create blank file bytes from recipe identity/room, then apply. */
export function recipeBlankPlanArgs(recipe: LayoutRecipe) {
  const F = UNITS_PER_FOOT;
  const roomW = (recipe.room?.widthFt ?? 100) * F;
  const roomD = (recipe.room?.depthFt ?? 60) * F;
  return {
    room: { width: roomW, depth: roomD },
    roomName: recipe.identity?.event ?? recipe.identity?.roomLabel ?? 'Untitled plan',
    identity: {
      event: recipe.identity?.event,
      venue: recipe.identity?.venue,
      date: recipe.identity?.date,
    },
    autoDimensions: 'imperial' as const,
  };
}
