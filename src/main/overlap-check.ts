/**
 * AABB overlap candidates for place/move — scene or live document.
 *
 * Deliberately axis-aligned (same as `format/overlap.ts`). Walls/region are
 * skipped by default: thin wall boxes false-positive against furniture that
 * sits along the perimeter. Stack-on pairs are filtered by the caller so a
 * laptop on a table is not treated as a mistake.
 */

import { classify, type Category } from '../inventory/classify.js';
import {
  besidePosition,
  describeOverlap,
  findOverlaps,
  type Box,
  type Overlap,
  type OverlapCandidate,
} from '../format/overlap.js';
import { measureNode } from '../format/edit.js';
import { shapeName } from '../format/definition.js';
import { walk, type RVDocument, type RVNode } from '../format/rv.js';
import type { Scene } from '../format/scene.js';
import { objectLinkPairKey, type ObjectLinkKind } from './object-links.js';

export interface PlaceMoveOverlapOptions {
  allowOverlap?: boolean;
  nudge?: boolean;
}

export type OverlapHit = Overlap;

export interface OverlapDecision {
  /** Clear, or allowed / already nudged. */
  ok: true;
  /** When nudge moved the subject; callers apply this delta (or re-place). */
  nudge?: { dx: number; dy: number; direction: 'left' | 'right' | 'up' | 'down' };
}

export interface OverlapBlocked {
  ok: false;
  reason: string;
  overlaps: OverlapHit[];
  /** Insertion-point / centre after a beside nudge, when one exists. */
  suggested?: { x: number; y: number };
}

/** World AABB for a placed shape from insertion + measured outline. */
export function worldAabb(node: RVNode): OverlapCandidate | null {
  if (node.cls !== 'RVShape') return null;
  const name = shapeName(node) ?? node.labels[0] ?? 'item';
  const at = node.points[0] ?? {
    x: (node.bounds.left + node.bounds.right) / 2,
    y: (node.bounds.top + node.bounds.bottom) / 2,
  };
  const measured = measureNode(node);
  let width = measured.width;
  let height = measured.height;
  if (!(width > 0 && height > 0)) {
    width = node.bounds.right - node.bounds.left;
    height = node.bounds.bottom - node.bounds.top;
  }
  if (!(width > 0 && height > 0)) return null;
  return {
    id: node.id,
    name,
    minX: at.x - width / 2,
    minY: at.y - height / 2,
    maxX: at.x + width / 2,
    maxY: at.y + height / 2,
  };
}

/**
 * Union AABB per selectable object from the flattened scene.
 *
 * @param excludeWalls default true — skip walls/region layers
 */
export function overlapCandidatesFromScene(
  scene: Scene,
  options?: { excludeWalls?: boolean; excludeIds?: Iterable<number> },
): OverlapCandidate[] {
  const exclude = new Set(options?.excludeIds ?? []);
  const excludeWalls = options?.excludeWalls !== false;
  const byId = new Map<number, OverlapCandidate>();

  for (const primitive of scene.primitives) {
    if (primitive.type === 'text' || primitive.type === 'dimension') continue;
    if (excludeWalls && (primitive.layer === 'walls' || primitive.layer === 'region')) continue;
    if (exclude.has(primitive.selectId)) continue;
    const pts = primitive.pts;
    if (pts.length < 2) continue;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i + 1 < pts.length; i += 2) {
      const x = pts[i]!;
      const y = pts[i + 1]!;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    if (!(maxX > minX && maxY > minY)) continue;

    const existing = byId.get(primitive.selectId);
    if (!existing) {
      byId.set(primitive.selectId, {
        id: primitive.selectId,
        name: primitive.owner ?? primitive.cls,
        minX,
        minY,
        maxX,
        maxY,
      });
    } else {
      existing.minX = Math.min(existing.minX, minX);
      existing.minY = Math.min(existing.minY, minY);
      existing.maxX = Math.max(existing.maxX, maxX);
      existing.maxY = Math.max(existing.maxY, maxY);
      if (primitive.owner) existing.name = primitive.owner;
    }
  }

  return [...byId.values()];
}

/** Placed RVShapes in the live document (for checks inside an edit). */
export function overlapCandidatesFromDocument(
  doc: RVDocument,
  options?: { excludeIds?: Iterable<number> },
): OverlapCandidate[] {
  const exclude = new Set(options?.excludeIds ?? []);
  const out: OverlapCandidate[] = [];
  for (const node of walk(doc)) {
    if (node.cls !== 'RVShape') continue;
    if (exclude.has(node.id)) continue;
    const box = worldAabb(node);
    if (box) out.push(box);
  }
  return out;
}

/** Drop candidates that are stack-on linked to any of the subject ids. */
export function excludeStackOnPairs(
  subjectIds: Iterable<number>,
  candidates: OverlapCandidate[],
  kinds: Map<string, ObjectLinkKind>,
): OverlapCandidate[] {
  const subjects = [...subjectIds];
  if (!subjects.length) return candidates;
  return candidates.filter((candidate) => {
    for (const id of subjects) {
      if (kinds.get(objectLinkPairKey(id, candidate.id)) === 'stack-on') return false;
    }
    return true;
  });
}

export function translateBox(box: Box, dx: number, dy: number): Box {
  return {
    minX: box.minX + dx,
    minY: box.minY + dy,
    maxX: box.maxX + dx,
    maxY: box.maxY + dy,
  };
}

function objectCategory(name: string): Category {
  return classify(name).category;
}

/**
 * Category-aware overlap exceptions — deliberate stacks the user expects.
 * Everything else at or above the overlap threshold is blocked.
 */
export function isAllowedOverlap(subjectName: string, otherName: string, fraction: number): boolean {
  const a = objectCategory(subjectName);
  const b = objectCategory(otherName);
  if (a === b && a === 'truss' && fraction < 0.35) return true;
  if (a === 'projector' && (b === 'riser' || b === 'table-round' || b === 'table-rect' || b === 'desk')) {
    return true;
  }
  if (a === 'person' && b === 'chair') return true;
  if (a === 'speaker' && (b === 'riser' || b === 'truss')) return true;
  if ((a === 'flat-panel' || a === 'screen') && (b === 'riser' || b === 'truss' || b === 'table-rect')) {
    return true;
  }
  return false;
}

function filterBlockingOverlaps(
  subjectName: string,
  overlaps: Overlap[],
  others: OverlapCandidate[],
): Overlap[] {
  return overlaps.filter((hit) => {
    const other = others.find((c) => c.id === hit.id);
    if (!other) return true;
    return !isAllowedOverlap(subjectName, other.name, hit.fraction);
  });
}

/**
 * Decide whether a subject box may occupy its current (or proposed) place.
 *
 * `anchor` is the insertion / centre used for `suggested` when nudging beside.
 */
export function decideOverlap(
  subject: Box,
  others: OverlapCandidate[],
  anchor: { x: number; y: number },
  options?: PlaceMoveOverlapOptions & { subjectName?: string },
): OverlapDecision | OverlapBlocked {
  const raw = findOverlaps(subject, others);
  const overlaps = options?.subjectName
    ? filterBlockingOverlaps(options.subjectName, raw, others)
    : raw;
  if (!overlaps.length) return { ok: true };

  if (options?.allowOverlap) return { ok: true };

  const blockers: Box[] = [];
  for (const hit of overlaps) {
    const box = others.find((c) => c.id === hit.id);
    if (box) blockers.push(box);
  }
  const nudge = besidePosition(subject, blockers);
  const suggested = nudge
    ? { x: anchor.x + nudge.dx, y: anchor.y + nudge.dy }
    : undefined;

  if (options?.nudge) {
    if (!nudge) {
      return {
        ok: false,
        reason: describeOverlap(overlaps),
        overlaps,
        suggested,
      };
    }
    return { ok: true, nudge };
  }

  return {
    ok: false,
    reason: describeOverlap(overlaps),
    overlaps,
    suggested,
  };
}
