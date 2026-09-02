/**
 * Semantic zoom — how much plan geometry to draw at a given scale.
 *
 * At far-out zooms a ballroom of chairs is noise; banks read as blocks with a
 * seat count. Mid zoom keeps furniture as simple footprints. Close-in keeps
 * the full path detail the file stores.
 *
 * Scale is the PlanCanvas view scale (1.0 ≈ 100% UI zoom).
 */

export type SemanticLod = 'blocks' | 'simplified' | 'full';

/** Below this, grouped seating collapses to bank footprints. */
export const SEMANTIC_BLOCKS_BELOW = 0.03;
/** Below this (and at/above blocks), furniture draws as filled bounds. */
export const SEMANTIC_SIMPLIFIED_BELOW = 0.1;

export function semanticLodForScale(scale: number): SemanticLod {
  if (!(scale > 0) || !Number.isFinite(scale)) return 'blocks';
  if (scale < SEMANTIC_BLOCKS_BELOW) return 'blocks';
  if (scale < SEMANTIC_SIMPLIFIED_BELOW) return 'simplified';
  return 'full';
}

export interface ObjectGroupRef {
  hubId: number;
  memberIds: number[];
}

export interface BankOverlay {
  hubId: number;
  memberIds: number[];
  count: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Build drawable bank footprints from group membership + per-object bounds.
 * Members missing from the bounds map (hidden layer, culled) are skipped; a
 * bank needs at least two visible members to draw.
 */
export function bankOverlaysFromGroups(
  groups: ObjectGroupRef[],
  objectBounds: Map<number, { minX: number; minY: number; maxX: number; maxY: number }>,
): BankOverlay[] {
  const out: BankOverlay[] = [];
  for (const group of groups) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let visible = 0;
    for (const id of group.memberIds) {
      const b = objectBounds.get(id);
      if (!b) continue;
      visible++;
      minX = Math.min(minX, b.minX);
      minY = Math.min(minY, b.minY);
      maxX = Math.max(maxX, b.maxX);
      maxY = Math.max(maxY, b.maxY);
    }
    if (visible < 2 || !Number.isFinite(minX)) continue;
    out.push({
      hubId: group.hubId,
      memberIds: group.memberIds,
      count: group.memberIds.length,
      minX,
      minY,
      maxX,
      maxY,
    });
  }
  return out;
}

/** Member ids that belong to any listed group (for skipping per-chair draw). */
export function bankMemberIdSet(groups: ObjectGroupRef[]): Set<number> {
  const out = new Set<number>();
  for (const group of groups) {
    for (const id of group.memberIds) out.add(id);
  }
  return out;
}
