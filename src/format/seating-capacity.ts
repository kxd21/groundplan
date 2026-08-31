/**
 * Layout capacity estimates for the seating planner preview.
 *
 * Compares what the room can hold (solver with no artificial seat cap) against
 * what the current settings would produce, so the panel can say "max ~26 tables"
 * when a requested layout does not fit.
 */

import type { RoomModel } from './room.js';
import type { SeatingPlan } from './seating-plan.js';
import { solveOptimum, solveSeating } from './seating-plan.js';

export interface LayoutCapacityEstimate {
  maxTables: number;
  maxSeats: number;
  /** Tables/seats from the current plan settings (may include dropped positions). */
  currentTables: number;
  currentSeats: number;
  dropped: number;
  /** Human-readable summary for the seating panel. */
  summary: string | null;
}

/** Solve twice: once as configured, once without maxSeats to learn the room ceiling. */
export function estimateLayoutCapacity(
  plan: SeatingPlan,
  room: RoomModel,
  current: { seats: number; tables: number; dropped: number },
): LayoutCapacityEstimate {
  const unlimited = { ...plan, maxSeats: undefined };
  const maxSolution = plan.optimum ? solveOptimum(unlimited, room) : solveSeating(unlimited, room);
  const maxTables = maxSolution.tables.length;
  const maxSeats = maxSolution.seats.length;

  let summary: string | null = null;
  if (current.dropped > 0 || (plan.maxSeats && plan.maxSeats > 0 && current.seats >= (plan.maxSeats ?? 0))) {
    summary = `Maximum estimated capacity: ${maxTables} table${maxTables === 1 ? '' : 's'} / ${maxSeats.toLocaleString()} seat${maxSeats === 1 ? '' : 's'}.`;
    if (current.dropped > 0) {
      summary += ` ${current.dropped} position${current.dropped === 1 ? '' : 's'} could not fit with current spacing.`;
    }
  } else if (maxTables > 0 && current.tables > 0 && current.tables < maxTables * 0.85 && current.dropped === 0) {
    summary = `Room could hold up to ~${maxTables} table${maxTables === 1 ? '' : 's'} (${maxSeats.toLocaleString()} seats) at these clearances.`;
  }

  return {
    maxTables,
    maxSeats,
    currentTables: current.tables,
    currentSeats: current.seats,
    dropped: current.dropped,
    summary,
  };
}
