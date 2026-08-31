/**
 * Collision feedback helpers for place/move.
 *
 * Main returns overlap hits on blocked place/move; App will outline those ids
 * in red on the canvas. This module only formats copy and shares types.
 */

import { describeOverlap, type Overlap } from '../../format/overlap.js';

export type OverlapHit = Overlap;

export type PlaceMoveOverlapOptions = {
  allowOverlap?: boolean;
  nudge?: boolean;
};

export type CollisionChoice = 'nudge' | 'allow' | 'cancel';

/** Status-line / banner text for a blocked or previewed overlap. */
export function formatCollisionStatus(overlaps: OverlapHit[]): string {
  return describeOverlap(overlaps);
}

/** Short prompt when the user must choose nudge, allow, or cancel. */
export function formatCollisionPrompt(overlaps: OverlapHit[]): string {
  const status = formatCollisionStatus(overlaps);
  if (!status) return '';
  return `${status}. Nudge beside, allow overlap, or cancel.`;
}
