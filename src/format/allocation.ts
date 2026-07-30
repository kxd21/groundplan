/**
 * What the plan asks for, against what the company owns.
 *
 * The inventory already knows every item that has ever been on a job, and the
 * plan already knows what it places. What nobody could ask was the one question
 * that matters the week before a show: *can we do this out of stock?*
 *
 * Three answers are worth telling apart, and lumping them together is how a
 * shortage gets missed:
 *
 *   - **Short.** We own twelve and the plan wants twenty. Eight to sub-hire.
 *   - **Untracked.** We place it but have never recorded owning any, so the
 *     count is unknown rather than zero. Reporting that as a shortage of twenty
 *     cries wolf; reporting it as fine is worse.
 *   - **Conceptual.** It is on the drawing to show intent — a stage outline, a
 *     dance floor, a "client table" — and is not a thing to load. It should not
 *     appear on a pull sheet at all.
 */

import type { PlacedItem } from './definition.js';
import { normaliseName } from './definition.js';

export type AllocationState = 'ok' | 'short' | 'untracked' | 'conceptual';

export interface Allocation {
  name: string;
  /** How many the company owns, or `null` when that is not recorded. */
  owned: number | null;
  /** How many this plan places. */
  placed: number;
  /** Owned minus placed, or `null` when the stock level is unknown. */
  remaining: number | null;
  /** How many have to come from somewhere else. Zero unless `short`. */
  shortfall: number;
  state: AllocationState;
  /** True when the item's size or height came from a guess. */
  estimated: boolean;
}

/**
 * Names that describe an area rather than a thing to load.
 *
 * These are drawn on nearly every plan and are not equipment. Keeping the list
 * short and specific matters: a rule broad enough to catch "table" would drop
 * every table off the pull sheet.
 */
const CONCEPTUAL = /\b(dance ?floor|stage area|clear|keep clear|egress|exit|aisle|zone|area|tbd|placeholder|client|by others)\b/i;

export interface AllocationOptions {
  /** Extra names to treat as conceptual. */
  conceptual?: string[];
  /** Names never to treat as conceptual, whatever they are called. */
  literal?: string[];
}

/**
 * Compares a plan against stock.
 *
 * `owned` is looked up by the same normalised name the rest of the system uses,
 * so an item matches whether the plan says `Round 60"` and the inventory says
 * `round 60"` or the other way round.
 */
export function allocate(
  items: PlacedItem[],
  owned: Map<string, number>,
  options: AllocationOptions = {},
): Allocation[] {
  const stock = new Map<string, number>();
  for (const [name, count] of owned) stock.set(normaliseName(name), count);

  const extraConceptual = new Set((options.conceptual ?? []).map(normaliseName));
  const literal = new Set((options.literal ?? []).map(normaliseName));

  const counted = new Map<string, { placed: number; estimated: boolean; name: string }>();
  for (const item of items) {
    const key = normaliseName(item.name);
    const entry = counted.get(key);
    if (entry) {
      entry.placed++;
      entry.estimated ||= item.estimated;
    } else {
      counted.set(key, { placed: 1, estimated: item.estimated, name: item.name });
    }
  }

  const out: Allocation[] = [];
  for (const [key, entry] of counted) {
    const isConceptual = !literal.has(key) && (extraConceptual.has(key) || CONCEPTUAL.test(entry.name));
    const have = stock.get(key);

    if (isConceptual) {
      out.push({
        name: entry.name,
        owned: have ?? null,
        placed: entry.placed,
        remaining: have == null ? null : have - entry.placed,
        shortfall: 0,
        state: 'conceptual',
        estimated: entry.estimated,
      });
      continue;
    }

    if (have == null) {
      out.push({
        name: entry.name,
        owned: null,
        placed: entry.placed,
        remaining: null,
        shortfall: 0,
        state: 'untracked',
        estimated: entry.estimated,
      });
      continue;
    }

    const remaining = have - entry.placed;
    out.push({
      name: entry.name,
      owned: have,
      placed: entry.placed,
      remaining,
      shortfall: remaining < 0 ? -remaining : 0,
      state: remaining < 0 ? 'short' : 'ok',
      estimated: entry.estimated,
    });
  }

  // Shortages first — that is what the list is read for — then the unknowns,
  // then everything that is fine.
  const rank: Record<AllocationState, number> = { short: 0, untracked: 1, ok: 2, conceptual: 3 };
  return out.sort((a, b) => rank[a.state] - rank[b.state] || b.placed - a.placed || a.name.localeCompare(b.name));
}

/** Only the lines somebody has to do something about. */
export function shortages(allocations: Allocation[]): Allocation[] {
  return allocations.filter((a) => a.state === 'short');
}

/** Items placed that the inventory has never heard of. */
export function untracked(allocations: Allocation[]): Allocation[] {
  return allocations.filter((a) => a.state === 'untracked');
}

export interface AllocationSummary {
  lines: number;
  toLoad: number;
  shortLines: number;
  shortUnits: number;
  untrackedLines: number;
  conceptualLines: number;
  estimatedLines: number;
  notes: string[];
}

/** The paragraph that goes at the top of a pull sheet. */
export function summariseAllocation(allocations: Allocation[]): AllocationSummary {
  const short = shortages(allocations);
  const unknown = untracked(allocations);
  const conceptual = allocations.filter((a) => a.state === 'conceptual');
  const estimated = allocations.filter((a) => a.estimated && a.state !== 'conceptual');

  const summary: AllocationSummary = {
    lines: allocations.length,
    toLoad: allocations.filter((a) => a.state !== 'conceptual').reduce((n, a) => n + a.placed, 0),
    shortLines: short.length,
    shortUnits: short.reduce((n, a) => n + a.shortfall, 0),
    untrackedLines: unknown.length,
    conceptualLines: conceptual.length,
    estimatedLines: estimated.length,
    notes: [],
  };

  if (summary.shortLines) {
    summary.notes.push(
      `${summary.shortUnits} item${summary.shortUnits === 1 ? '' : 's'} short across ${summary.shortLines} line${
        summary.shortLines === 1 ? '' : 's'
      }: ${short.map((a) => `${a.name} (${a.shortfall})`).join(', ')}.`,
    );
  }
  if (summary.untrackedLines) {
    summary.notes.push(
      `${summary.untrackedLines} line${summary.untrackedLines === 1 ? '' : 's'} are not in the inventory, so stock could not be checked.`,
    );
  }
  if (summary.conceptualLines) {
    summary.notes.push(`${summary.conceptualLines} drawn area${summary.conceptualLines === 1 ? '' : 's'} left off the load list.`);
  }
  if (summary.estimatedLines) {
    summary.notes.push(`${summary.estimatedLines} line${summary.estimatedLines === 1 ? '' : 's'} use estimated sizes.`);
  }
  if (!summary.notes.length) summary.notes.push('Everything on this plan is in stock.');

  return summary;
}

/** The pull sheet, as a spreadsheet. */
export function allocationCsv(allocations: Allocation[]): string {
  const escape = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const rows = ['Item,Placed,Owned,Remaining,Short,Status,Size'];

  for (const line of allocations) {
    rows.push(
      [
        escape(line.name),
        `${line.placed}`,
        line.owned == null ? '' : `${line.owned}`,
        line.remaining == null ? '' : `${line.remaining}`,
        line.shortfall ? `${line.shortfall}` : '',
        line.state,
        line.estimated ? 'estimated' : 'known',
      ].join(','),
    );
  }

  return rows.join('\n');
}
