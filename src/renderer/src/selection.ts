import type { Scene } from '../../format/scene.js';

/**
 * Reduces a list of freshly created node ids to the top-level objects a person
 * actually selects.
 *
 * A placed catalogue item — a chair, a table, a stage — is one `RVShape` drawn
 * from several nodes: an `RVGeometry` and its outline segments. The edit layer
 * reports every one of those node ids as "created" (the companion needs them all
 * to undo the placement), but selecting the lot means placing a single chair
 * lights up "4 items", and generating a seating block of 4,900 chairs selects
 * ~19,600 internal segments instead of the chairs.
 *
 * The scene already knows which object a click resolves to: every primitive
 * carries the `selectId` of the shape it belongs to. So the selection after a
 * create is the set of `selectId`s of the primitives that were created — one per
 * placed shape — which is exactly what clicking each shape would have selected.
 */
export function selectableIds(created: number[], scene: Scene): number[] {
  if (!created.length) return created;
  const createdSet = new Set(created);
  const out = new Set<number>();
  for (const primitive of scene.primitives) {
    if (createdSet.has(primitive.nodeId) || createdSet.has(primitive.selectId)) {
      out.add(primitive.selectId);
    }
  }
  // A created object with no drawn primitive of its own (nothing to hit-test)
  // falls back to the raw list rather than selecting nothing.
  return out.size ? [...out] : created;
}
