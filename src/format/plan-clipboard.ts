/**
 * Stable addressing for objects copied out of an edited plan.
 *
 * RVNode ids are deliberately local to one parse. Structural edits can leave
 * live nodes with ids that are different from the ids assigned after the plan
 * is serialized and parsed again. The clipboard needs a detached snapshot, so
 * it records the selected objects by their root/slot path before reparsing and
 * resolves those paths in the snapshot.
 */

import type { DocumentIndex } from './edit.js';
import type { RVDocument, RVNode } from './rv.js';

export type PlanObjectPath = number[];

/** Returns a node's physical root/slot path, independent of parse-local ids. */
export function planObjectPath(
  doc: RVDocument,
  index: DocumentIndex,
  node: RVNode,
): PlanObjectPath | null {
  const slots: number[] = [];
  const visited = new Set<RVNode>();
  let current = node;

  while (true) {
    if (visited.has(current)) return null;
    visited.add(current);

    const parent = index.parentOf.get(current);
    if (!parent) break;
    const slot = parent.slots.findIndex((entry) => entry.node === current);
    if (slot < 0) return null;
    slots.push(slot);
    current = parent;
  }

  const root = doc.roots.indexOf(current);
  if (root < 0) return null;
  return [root, ...slots.reverse()];
}

/** Resolves a path produced by planObjectPath in another parse of the plan. */
export function planObjectAtPath(doc: RVDocument, path: readonly number[]): RVNode | null {
  if (!path.length || !path.every((part) => Number.isSafeInteger(part) && part >= 0)) return null;
  let current = doc.roots[path[0]];
  if (!current) return null;

  for (let depth = 1; depth < path.length; depth++) {
    const slot = current.slots[path[depth]];
    if (!slot?.node) return null;
    current = slot.node;
  }
  return current;
}

/**
 * Resolves a selection from a live document into a detached serialization
 * snapshot. If both a group and one of its children are selected, only the
 * group is returned so Paste does not duplicate the child twice.
 */
export function snapshotPlanSelection(
  live: RVDocument,
  liveIndex: DocumentIndex,
  ids: readonly number[],
  snapshot: RVDocument,
): RVNode[] {
  const wanted = new Set(ids);
  const selected = [...wanted]
    .map((id) => liveIndex.byId.get(id))
    .filter((node): node is RVNode => !!node);
  const topLevel = selected.filter((node) => {
    let parent = liveIndex.parentOf.get(node);
    while (parent) {
      if (wanted.has(parent.id)) return false;
      parent = liveIndex.parentOf.get(parent);
    }
    return true;
  });

  return topLevel
    .map((node) => planObjectPath(live, liveIndex, node))
    .filter((path): path is PlanObjectPath => !!path)
    .map((path) => planObjectAtPath(snapshot, path))
    .filter((node): node is RVNode => !!node);
}
