/**
 * Placement fidelity — resolve catalogue names without silent wrong stamps.
 *
 * Card Party recreations failed when "Mixer" armed "Bottle - Mixer" and
 * "Fastfold" armed the smallest Fastfold: search ranked by timesSeen and
 * scripts took the first DOM match. This module is the single policy:
 *
 *   1. Exact normalised name always wins.
 *   2. A unique strong match (starts-with / sole includes) may auto-resolve.
 *   3. Ambiguous queries never pick a winner — callers must show candidates
 *      or require an exact name.
 *
 * `searchInventory` orders results with the same score so the palette list
 * matches what `resolveInventoryQuery` would choose.
 */

import { inventoryMatchScore, normaliseName, type Inventory, type InventoryItem } from './model.js';
import { CATEGORY_LABELS, type Category } from './classify.js';

export type InventoryResolve =
  | { status: 'exact'; item: InventoryItem }
  | { status: 'unique'; item: InventoryItem; reason: string }
  | { status: 'ambiguous'; candidates: InventoryItem[]; reason: string }
  | { status: 'none'; reason: string };

export { inventoryMatchScore };

function haystackMatch(item: InventoryItem, q: string): boolean {
  if (!q) return true;
  const haystack = [
    item.name,
    item.department ?? '',
    item.symbolName ?? '',
    item.category ? CATEGORY_LABELS[item.category] : '',
    item.category ?? '',
  ];
  return haystack.some((text) => normaliseName(text).includes(q));
}

/**
 * Resolves a free-text inventory query under the fidelity contract.
 *
 * Pass `requireExact: true` for layout recipes / automation — only an exact
 * name (or a single unique startswith) is accepted; never a fuzzy category hit.
 */
export function resolveInventoryQuery(
  inventory: Inventory,
  query: string,
  options: { requireExact?: boolean; department?: string | null; category?: Category | null } = {},
): InventoryResolve {
  const q = normaliseName(query);
  if (!q) return { status: 'none', reason: 'empty query' };

  const pool = inventory.items.filter((item) => {
    if (options.department && (item.department ?? 'Unfiled') !== options.department) return false;
    if (options.category && (item.category ?? 'not-drawn') !== options.category) return false;
    return true;
  });

  const exact = pool.find((item) => normaliseName(item.name) === q);
  if (exact) return { status: 'exact', item: exact };

  const scored = pool
    .map((item) => ({ item, score: inventoryMatchScore(item.name, q) }))
    .filter((row) => row.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score || b.item.timesSeen - a.item.timesSeen || a.item.name.localeCompare(b.item.name),
    );

  if (scored.length === 0) {
    // Broader haystack (category labels) — still must be unique to auto-pick.
    const loose = pool.filter((item) => haystackMatch(item, q));
    if (loose.length === 1) {
      return { status: 'unique', item: loose[0]!, reason: 'sole category/name hit' };
    }
    if (loose.length > 1) {
      return {
        status: 'ambiguous',
        candidates: loose.slice(0, 12),
        reason: `${loose.length} items match “${query.trim()}”. Use an exact catalogue name`,
      };
    }
    return { status: 'none', reason: `no inventory item matches “${query.trim()}”` };
  }

  const top = scored[0]!;
  const tied = scored.filter((row) => row.score === top.score);

  if (top.score >= 300 && tied.length === 1) {
    return { status: 'unique', item: top.item, reason: 'unique prefix match' };
  }

  if (options.requireExact) {
    return {
      status: 'ambiguous',
      candidates: tied.map((row) => row.item).slice(0, 12),
      reason: `“${query.trim()}” is not an exact catalogue name`,
    };
  }

  if (tied.length === 1 && top.score >= 200) {
    return { status: 'unique', item: top.item, reason: 'unique strongest includes match' };
  }

  return {
    status: 'ambiguous',
    candidates: (tied.length > 1 ? tied : scored).map((row) => row.item).slice(0, 12),
    reason: `${tied.length > 1 ? tied.length : scored.length} items match “${query.trim()}”. Pick one exactly`,
  };
}

/** Human-readable failure for IPC / UI when resolve is not exact/unique. */
export function resolveFailureMessage(result: InventoryResolve): string | null {
  if (result.status === 'exact' || result.status === 'unique') return null;
  if (result.status === 'none') return result.reason;
  const names = result.candidates
    .slice(0, 5)
    .map((c) => c.name)
    .join(', ');
  return `${result.reason}${names ? ` (e.g. ${names})` : ''}`;
}
