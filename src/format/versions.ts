/**
 * Comparing two versions of a plan.
 *
 * Groundplan has always had crash recovery and a bounded undo stack, and
 * neither answers the question a revision conversation actually asks: what
 * changed between the layout the client signed off and the one going to the
 * floor. Undo is a way back, not a record — it does not survive closing the
 * plan, and it cannot tell you that the FOH position moved ten feet.
 *
 * The comparison is by placement, not by bytes. Two saves of the same drawing
 * differ in dozens of ways that mean nothing to anybody; what means something
 * is that a screen appeared, four rounds went away, and the podium turned.
 */

import { entryKey } from './schedule.js';
import { UNITS_PER_FOOT } from './rv.js';
import type { PlacedItem } from './definition.js';

export type ChangeKind = 'added' | 'removed' | 'moved' | 'changed';

export interface PlanChange {
  kind: ChangeKind;
  name: string;
  /** Where it is now, or where it was for a removal. */
  x: number;
  y: number;
  /** Where it was, for a move. */
  fromX?: number;
  fromY?: number;
  /** How far it moved, in logical units. */
  distance?: number;
  /** What changed, in words, for a `changed`. */
  detail?: string;
}

export interface PlanDiff {
  added: PlanChange[];
  removed: PlanChange[];
  moved: PlanChange[];
  changed: PlanChange[];
  /** Counts by name, for the summary line. */
  summary: string;
  /** True when the two versions place the same things in the same places. */
  identical: boolean;
}

/**
 * How far something must move to count as moved.
 *
 * An inch is inside the noise of a redraw, a snap step, or a rounding
 * difference between two saves. Half a foot is a decision somebody made.
 */
const MOVE_TOLERANCE = UNITS_PER_FOOT / 2;

/** Degrees of rotation that count as a turn rather than a rounding wobble. */
const ROTATION_TOLERANCE = 1;

/**
 * Matches placements between two versions.
 *
 * Keyed by name and position to the inch, the same scheme the schedule uses,
 * so an item that did not move matches exactly. Anything left unmatched is
 * then paired up by name and nearest position, which is what turns "one gone,
 * one appeared" into "it moved".
 */
export function diffPlans(before: PlacedItem[], after: PlacedItem[]): PlanDiff {
  const beforeByKey = new Map<string, PlacedItem>();
  for (const item of before) beforeByKey.set(entryKey(item.name, item.x, item.y), item);

  const afterByKey = new Map<string, PlacedItem>();
  for (const item of after) afterByKey.set(entryKey(item.name, item.x, item.y), item);

  const added: PlanChange[] = [];
  const removed: PlanChange[] = [];
  const moved: PlanChange[] = [];
  const changed: PlanChange[] = [];

  // Anything present in both, in the same spot, can only have "changed".
  const matched = new Set<string>();
  for (const [key, item] of afterByKey) {
    const was = beforeByKey.get(key);
    if (!was) continue;
    matched.add(key);

    const notes: string[] = [];
    if (Math.abs(item.rotation - was.rotation) > ROTATION_TOLERANCE) {
      notes.push(`turned ${Math.round(item.rotation - was.rotation)}°`);
    }
    if (Math.abs(item.width - was.width) > 1 || Math.abs(item.depth - was.depth) > 1) {
      notes.push('resized');
    }
    if (item.elevation !== was.elevation) {
      notes.push(
        `elevation ${(was.elevation / UNITS_PER_FOOT).toFixed(1)}ft → ` +
          `${(item.elevation / UNITS_PER_FOOT).toFixed(1)}ft`,
      );
    }
    if (notes.length) {
      changed.push({ kind: 'changed', name: item.name, x: item.x, y: item.y, detail: notes.join(', ') });
    }
  }

  const leftoverBefore = [...beforeByKey.entries()].filter(([key]) => !matched.has(key));
  const leftoverAfter = [...afterByKey.entries()].filter(([key]) => !matched.has(key));

  /*
   * Pair the leftovers by name and nearest position.
   *
   * Without this every move reads as a deletion plus an insertion, which is
   * technically true of the file and useless to a person: "24 removed, 24
   * added" says nothing, "the centre bank moved 6ft upstage" says everything.
   */
  const takenAfter = new Set<number>();
  for (const [, item] of leftoverBefore) {
    let best = -1;
    let bestDistance = Infinity;

    leftoverAfter.forEach(([, candidate], index) => {
      if (takenAfter.has(index)) return;
      if (candidate.name !== item.name) return;
      const distance = Math.hypot(candidate.x - item.x, candidate.y - item.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });

    if (best >= 0) {
      takenAfter.add(best);
      const now = leftoverAfter[best]![1];
      if (bestDistance > MOVE_TOLERANCE) {
        moved.push({
          kind: 'moved',
          name: item.name,
          x: now.x,
          y: now.y,
          fromX: item.x,
          fromY: item.y,
          distance: bestDistance,
        });
      }
      const notes: string[] = [];
      if (Math.abs(now.rotation - item.rotation) > ROTATION_TOLERANCE) {
        notes.push(`turned ${Math.round(now.rotation - item.rotation)}°`);
      }
      if (notes.length) {
        changed.push({ kind: 'changed', name: item.name, x: now.x, y: now.y, detail: notes.join(', ') });
      }
    } else {
      removed.push({ kind: 'removed', name: item.name, x: item.x, y: item.y });
    }
  }

  leftoverAfter.forEach(([, item], index) => {
    if (takenAfter.has(index)) return;
    added.push({ kind: 'added', name: item.name, x: item.x, y: item.y });
  });

  const parts: string[] = [];
  if (added.length) parts.push(`${added.length} added`);
  if (removed.length) parts.push(`${removed.length} removed`);
  if (moved.length) parts.push(`${moved.length} moved`);
  if (changed.length) parts.push(`${changed.length} changed`);

  return {
    added,
    removed,
    moved,
    changed,
    summary: parts.length ? parts.join(' · ') : 'No differences',
    identical: !parts.length,
  };
}

/** Groups a diff by item name, which is how somebody reads it out loud. */
export function summariseDiff(diff: PlanDiff): Array<{ name: string; added: number; removed: number; moved: number }> {
  const byName = new Map<string, { name: string; added: number; removed: number; moved: number }>();
  const bump = (name: string, field: 'added' | 'removed' | 'moved') => {
    const entry = byName.get(name) ?? { name, added: 0, removed: 0, moved: 0 };
    entry[field] += 1;
    byName.set(name, entry);
  };
  for (const change of diff.added) bump(change.name, 'added');
  for (const change of diff.removed) bump(change.name, 'removed');
  for (const change of diff.moved) bump(change.name, 'moved');
  return [...byName.values()].sort(
    (a, b) => b.added + b.removed + b.moved - (a.added + a.removed + a.moved) || a.name.localeCompare(b.name),
  );
}
