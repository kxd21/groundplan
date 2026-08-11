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
import { UNITS_PER_FOOT, UNITS_PER_INCH } from '../format/rv.js';
import type { Session } from '../main/session.js';
import { addStage, createRectangularRoom } from '../main/plan-model.js';
import type { UnitSystem } from '../format/units.js';
import { deriveRoom } from '../format/room.js';
import type { Inventory } from './model.js';
import {
  applyLayoutRecipeAnnotations,
  applyLayoutRecipeGear,
  applyLayoutRecipeSeating,
  isLayoutRecipe,
  stageRequestFromRecipe,
  validateLayoutRecipe,
  type LayoutRecipe,
  type LayoutRecipeApplyResult,
} from './layout-recipe.js';

export interface ApplyFullLayoutOptions {
  /** When the plan already has chairs, refuse unless true. */
  replaceExistingSeating?: boolean;
  /** Inventory for exact gear/chair name checks. Optional for hermetic stubs. */
  inventory?: Inventory;
  units?: UnitSystem;
  /** Skip writing room when one already exists. Default true. */
  createRoomIfMissing?: boolean;
  /** Replace/recreate rectangular room from recipe even if one exists (CLI rebuild). */
  forceRoom?: boolean;
  /** Apply identity fields from the recipe. Default true. */
  applyIdentity?: boolean;
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
  if (recipe.room && (options.forceRoom || (!hasRoom && options.createRoomIfMissing !== false))) {
    const width = recipe.room.widthFt * UNITS_PER_FOOT;
    const depth = recipe.room.depthFt * UNITS_PER_FOOT;
    const room = createRectangularRoom(session, width, depth, units);
    if (!room.ok) return { ...empty, reason: room.reason ?? 'could not create room' };
    if (room.created) created.push(...room.created);
    session.refresh();
  } else if (!hasRoom && recipe.room) {
    return { ...empty, reason: 'plan has no room — draw or create one before applying this kit' };
  }

  for (const [i, stage] of (recipe.stage ?? []).entries()) {
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

  // Seed a chair shape so theatre banks can synthesize without inventory IPC.
  const chair = recipe.seating[0]?.chair ?? 'Chair';
  let seedId: number | undefined;
  {
    const index = indexDocument(session.loaded.document);
    const seed = placeGear(session.loaded.document, index, chair, 500 * UNITS_PER_FOOT, 500 * UNITS_PER_FOOT, {
      width: 20.5 * UNITS_PER_INCH,
      height: 23.23 * UNITS_PER_INCH,
    });
    if (seed.ok) {
      seedId = seed.created?.[0];
      session.refresh();
    }
  }

  const seated = applyLayoutRecipeSeating(
    session.loaded.document,
    indexDocument(session.loaded.document),
    recipe,
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

  const geared = applyLayoutRecipeGear(
    session.loaded.document,
    indexDocument(session.loaded.document),
    recipe,
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
  session.refresh();

  const notes = applyLayoutRecipeAnnotations(
    session.loaded.document,
    indexDocument(session.loaded.document),
    recipe,
  );
  if (!notes.ok) {
    return {
      ...empty,
      reason: notes.reason,
      chairsPlaced: seated.chairsPlaced,
      gearPlaced: geared.gearPlaced,
      created,
      seating: seated.seating,
    };
  }
  session.refresh();

  for (const name of recipe.expectations.requireGearNames ?? []) {
    if (![...gearNamesOnPlan(session)].some((n) => n === name || n.includes(name))) {
      // Soft check: gear may be placed under a slightly different schedule label.
      const onPlan = gearNamesOnPlan(session);
      if (!onPlan.has(name)) {
        // Exact-name placement used catalogue name; schedule uses that name.
        const found = [...onPlan].some((n) => n.toLowerCase() === name.toLowerCase());
        if (!found) {
          return {
            ...empty,
            reason: `required gear “${name}” not found on plan after apply`,
            chairsPlaced: seated.chairsPlaced,
            gearPlaced: geared.gearPlaced,
            labelsPlaced: notes.labelsPlaced,
            dimensionsPlaced: notes.dimensionsPlaced,
            stagesPlaced,
            created,
            seating: seated.seating,
          };
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
      gearPlaced: geared.gearPlaced,
      labelsPlaced: notes.labelsPlaced,
      dimensionsPlaced: notes.dimensionsPlaced,
      stagesPlaced,
      created,
      seating: seated.seating,
    };
  }

  return {
    ok: true,
    status: `Applied kit · ${seated.chairsPlaced} chairs · ${geared.gearPlaced} gear · ${stagesPlaced} stage(s)`,
    chairsPlaced: seated.chairsPlaced,
    gearPlaced: geared.gearPlaced,
    labelsPlaced: notes.labelsPlaced,
    dimensionsPlaced: notes.dimensionsPlaced,
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
