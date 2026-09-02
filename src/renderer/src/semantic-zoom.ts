/**
 * Semantic zoom — how much plan geometry to draw at a given scale.
 *
 * Far out, grouped seating collapses to labelled bank footprints so a
 * ballroom is readable. Everywhere else, furniture keeps the path detail
 * stored in the file — chairs must still look like chairs.
 *
 * Scale is the PlanCanvas view scale (UI % ≈ scale × 100). A typical 60′×40′
 * room fits around 12–15%.
 */

export type SemanticLod = 'blocks' | 'full';

/** Below this, grouped seating collapses to bank footprints. */
export const SEMANTIC_BLOCKS_BELOW = 0.12;

export function semanticLodForScale(scale: number): SemanticLod {
  if (!(scale > 0) || !Number.isFinite(scale)) return 'blocks';
  if (scale < SEMANTIC_BLOCKS_BELOW) return 'blocks';
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
