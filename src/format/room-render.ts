/**
 * Drawing a room model into the plan.
 *
 * The companion holds the room as parameters; the `.rv4` has to hold it as
 * ordinary geometry, or a legacy Room Viewer opening the same file sees an
 * empty document. This is the bridge, and its whole job is to be *idempotent*:
 * applying a room twice must leave one room, not two.
 *
 * That is harder than it sounds, because the format has nowhere to write "this
 * wall belongs to Groundplan". So the previous model is used as the record:
 * given the room as it was last drawn, each of its walls is found in the plan
 * by its exact coordinates, and then moved. Walls that cannot be found are left
 * alone rather than guessed at — a plan edited in Room Viewer since keeps
 * whatever the user did there, and the walls this could not account for are
 * reported so the caller can say so.
 */

import { appendChild, addRoot, deleteNode, indexDocument, setPoints } from './edit.js';
import { planBody, planWalls } from './plan-skeleton.js';
import { flattenWall, type RoomModel, type WallSegment } from './room.js';
import { walk, type Point, type RVDocument, type RVNode } from './rv.js';
import { createContainer, createSegment, type SynthesizableSegment } from './synthesize.js';

/**
 * Deliberately not an `EditResult`: that type's `created` is a list of object
 * ids, and these counts are about walls, which are not one-to-one with objects.
 */
export interface RoomRenderResult {
  ok: boolean;
  reason?: string;
  /** Walls moved in place. */
  updated: number;
  /** Walls drawn for the first time. */
  created: number;
  /** Walls removed because the room no longer has them. */
  removed: number;
  /**
   * Walls of the previous model that could not be found in the plan, usually
   * because it was edited elsewhere. Nothing was done to them.
   */
  unmatched: number;
  /** Objects this created, so the caller can select what it just drew. */
  createdIds: number[];
}

/** How finely an arc is drawn: a hundredth of an inch off the true curve. */
const RENDER_TOLERANCE = 0.1;

/** The points a wall is drawn as. Straight runs are two; arcs are flattened. */
function renderPoints(segment: WallSegment): Point[] {
  return flattenWall(segment, RENDER_TOLERANCE);
}

/** A wall's geometry as an exact key, for finding it again in the plan. */
function signature(points: Point[]): string {
  return points.map((p) => `${p.x},${p.y}`).join(' ');
}

const DRAWABLE = new Set(['RVSegmentLine', 'RVSegmentPoly', 'RVSegmentRect', 'RVDimensionLine']);

/** Every drawn segment in the plan, indexed by its coordinates. */
function indexGeometry(doc: RVDocument): Map<string, RVNode> {
  const out = new Map<string, RVNode>();
  for (const node of walk(doc)) {
    if (!DRAWABLE.has(node.cls) || !node.points.length) continue;
    const key = signature(node.points);
    // First wins: a plan with two identical walls is ambiguous, and moving the
    // wrong one is worse than moving neither.
    if (!out.has(key)) out.set(key, node);
  }
  return out;
}

/**
 * Where new wall geometry should go.
 *
 * Only a container that means "room" will do. An `RVGeometry` would accept the
 * children happily, but the ones in a plan belong to placed shapes, and a wall
 * filed under a table is classified as furniture — so the room would draw
 * correctly, save correctly, and then fail to be recognised as a room when the
 * file was reopened. `plan-skeleton.ts` owns both answers now — this used to be
 * one of six copies of the same search, two of which walked the roots backwards.
 */
function findWallHost(doc: RVDocument): RVNode | null {
  return planWalls(doc) ?? planBody(doc);
}

function classFor(points: Point[]): SynthesizableSegment {
  return points.length === 2 ? 'RVSegmentLine' : 'RVSegmentPoly';
}

/**
 * Draws a room into the plan, replacing the walls of `previous`.
 *
 * Pass `previous` as the room as it was last drawn — normally the copy in the
 * companion document. Omit it the first time a room is drawn.
 *
 * The caller must run `verifyWritable` before saving. Nothing here writes to
 * disk, and a failed verification means the document should be discarded
 * rather than repaired.
 */
export function applyRoom(doc: RVDocument, room: RoomModel, previous?: RoomModel): RoomRenderResult {
  const result: RoomRenderResult = {
    ok: true,
    updated: 0,
    created: 0,
    removed: 0,
    unmatched: 0,
    createdIds: [],
  };

  const geometry = indexGeometry(doc);

  // Pair each wall of the previous model with the object that drew it.
  const drawnBefore = new Map<string, RVNode>();
  for (const segment of previous?.walls ?? []) {
    const node = geometry.get(signature(renderPoints(segment)));
    if (node) drawnBefore.set(segment.id, node);
    else result.unmatched++;
  }

  const wanted = new Map(room.walls.map((w) => [w.id, w]));

  // Walls the room no longer has come out of the plan.
  for (const [id, node] of [...drawnBefore]) {
    if (wanted.has(id)) continue;
    const index = indexDocument(doc);
    if (deleteNode(doc, index, node).ok) result.removed++;
    drawnBefore.delete(id);
  }

  let host: RVNode | null = null;
  const ensureHost = (): RVNode | null => {
    if (host) return host;
    host = findWallHost(doc);
    if (host) return host;
    // A plan with no container to put walls in gets one.
    const made = createContainer(doc, { cls: 'RVWalls' });
    if (!made.ok || !made.node) return null;
    if (!addRoot(doc, made.node).ok) return null;
    host = made.node;
    return host;
  };

  for (const segment of room.walls) {
    const points = renderPoints(segment);
    const existing = drawnBefore.get(segment.id);

    // A wall that kept its shape class can be moved rather than replaced,
    // which preserves the pen and fill bytes the original object carried.
    if (existing && existing.fields.pointCount === points.length) {
      const moved = setPoints(doc, existing, points);
      if (moved.ok) {
        result.updated++;
        continue;
      }
    }

    // Otherwise it is replaced: a straight wall that became a curve needs a
    // different number of points, and the array cannot be resized in place.
    if (existing) {
      const index = indexDocument(doc);
      if (deleteNode(doc, index, existing).ok) result.removed++;
    }

    const container = ensureHost();
    if (!container) {
      return { ...result, ok: false, reason: 'this plan has nowhere to put wall geometry' };
    }

    const built = createSegment(doc, { cls: classFor(points), points });
    if (!built.ok || !built.node) {
      return { ...result, ok: false, reason: built.reason ?? 'the wall could not be built' };
    }
    const added = appendChild(doc, container, built.node);
    if (!added.ok) return { ...result, ok: false, reason: added.reason };

    result.createdIds.push(built.node.id);
    result.created++;
  }

  return result;
}
