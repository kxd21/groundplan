/**
 * Cable runs, by what is actually in them.
 *
 * A cable path used to be a named polyline and nothing more, which meant a
 * drawing could say "there is a run from FOH to stage" and could not say
 * whether it was fibre, a soca, or a pair of XLRs. Those are different
 * conversations: one is a rental line item, one is a floor-loading and
 * egress question, and one decides whether the run is even legal to tape down
 * next to the other.
 *
 * Each kind gets a line convention of its own so the drawing reads without a
 * key, and a rate so the schedule can total footage per type.
 */

import { UNITS_PER_FOOT } from './rv.js';

export type CableKind = 'power' | 'audio' | 'video' | 'network' | 'fiber' | 'dmx';

export interface CableSpec {
  id: CableKind;
  label: string;
  /** What a user would write on the drawing. */
  shortLabel: string;
  /**
   * Dash pattern in printed points. Absent means a solid line.
   *
   * The patterns follow the usual drafting habit of "heavier and more solid
   * means more dangerous": power is solid, signal is dashed, and the light
   * stuff is finely dotted.
   */
  dash?: number[];
  /** Stroke weight in printed points. */
  strokePoints: number;
  /** Line colour as CSS. Muted, because the plan is the subject. */
  stroke: string;
  /** Words that mean this kind, for classifying a run somebody typed a name for. */
  match: RegExp;
}

export const CABLE_KINDS: CableSpec[] = [
  {
    id: 'power',
    label: 'Power',
    shortLabel: 'PWR',
    strokePoints: 1.2,
    stroke: '#b3453a',
    match: /\b(power|feeder|soca|edison|distro|circuit|l6-?20|cam ?lock)\b/i,
  },
  {
    id: 'audio',
    label: 'Audio',
    shortLabel: 'AUD',
    dash: [5, 3],
    strokePoints: 0.9,
    stroke: '#7a5ea8',
    match: /\b(audio|xlr|mic line|snake|analog|line level)\b/i,
  },
  {
    id: 'video',
    label: 'Video (SDI)',
    shortLabel: 'SDI',
    dash: [7, 3],
    strokePoints: 0.9,
    stroke: '#2f7d70',
    match: /\b(sdi|video|hd-?sdi|3g|12g|coax|bnc)\b/i,
  },
  {
    id: 'network',
    label: 'Network',
    shortLabel: 'NET',
    dash: [3, 3],
    strokePoints: 0.8,
    stroke: '#2f6ba8',
    match: /\b(network|ethernet|cat ?5e?|cat ?6a?|dante|artnet|lan)\b/i,
  },
  {
    id: 'fiber',
    label: 'Fibre',
    shortLabel: 'FIB',
    dash: [9, 2, 2, 2],
    strokePoints: 0.9,
    stroke: '#c08a2e',
    match: /\b(fib(re|er)|smpte|singlemode|multimode|om[34]|lc\b|opticalcon)\b/i,
  },
  {
    id: 'dmx',
    label: 'DMX',
    shortLabel: 'DMX',
    dash: [2, 2],
    strokePoints: 0.8,
    stroke: '#6b8a3a',
    match: /\b(dmx|control|5 ?pin|rdm|sacn)\b/i,
  },
];

const BY_ID = new Map(CABLE_KINDS.map((kind) => [kind.id, kind]));

export function cableSpec(kind: CableKind): CableSpec {
  return BY_ID.get(kind) ?? CABLE_KINDS[0]!;
}

/**
 * Which reading wins when a run's name matches more than one kind.
 *
 * "Fiber to video world" is fibre going to the video department, and testing in
 * report order called it video — the destination beating the medium. A run is
 * named for what is in it and where it goes, and only the first of those is
 * what you order.
 *
 * So: the specific media first, then the generic ones, then power last as the
 * catch-all it already is.
 */
const MATCH_PRECEDENCE: readonly CableKind[] = [
  'fiber',
  'dmx',
  'network',
  'audio',
  'video',
  'power',
];

export function classifyCable(name: string): CableKind {
  for (const id of MATCH_PRECEDENCE) {
    if (BY_ID.get(id)?.match.test(name)) return id;
  }
  return 'power';
}

/** A run as the schedule lists it. */
export interface CableRun {
  name: string;
  kind: CableKind;
  /** Length in logical units, along the path as drawn. */
  length: number;
}

export interface CableScheduleLine {
  kind: CableKind;
  label: string;
  runs: number;
  /** Total length in feet, as drawn. */
  feet: number;
  /**
   * Feet to order, rounded up to the next stock length.
   *
   * Nobody orders 47ft of SDI. Runs get made up from 25s, 50s and 100s, and
   * ordering the drawn length is how a show ends up three feet short at the
   * far end of the room.
   */
  orderFeet: number;
}

/** Stock cable lengths, in feet. */
export const STOCK_LENGTHS = [10, 25, 50, 100, 150, 200, 250, 300];

/** The next stock length at or above a run, or the run rounded up to 50s. */
export function toStockLength(feet: number): number {
  const stock = STOCK_LENGTHS.find((length) => length >= feet);
  return stock ?? Math.ceil(feet / 50) * 50;
}

/**
 * The cable schedule: how much of what to put on the truck.
 *
 * Totals are per kind rather than per run, because that is how cable is pulled
 * and how it is billed. The drawn total and the order total are both shown: the
 * gap between them is the slack, and somebody should see it rather than
 * discover it.
 */
export function cableSchedule(runs: CableRun[]): {
  lines: CableScheduleLine[];
  totalFeet: number;
  totalOrderFeet: number;
} {
  const byKind = new Map<CableKind, { runs: number; feet: number; orderFeet: number }>();

  for (const run of runs) {
    const feet = run.length / UNITS_PER_FOOT;
    const current = byKind.get(run.kind) ?? { runs: 0, feet: 0, orderFeet: 0 };
    current.runs += 1;
    current.feet += feet;
    current.orderFeet += toStockLength(feet);
    byKind.set(run.kind, current);
  }

  const lines: CableScheduleLine[] = [];
  let totalFeet = 0;
  let totalOrderFeet = 0;

  // Report in the fixed kind order, not insertion order, so two plans of the
  // same show compare line for line.
  for (const spec of CABLE_KINDS) {
    const entry = byKind.get(spec.id);
    if (!entry) continue;
    lines.push({
      kind: spec.id,
      label: spec.label,
      runs: entry.runs,
      feet: entry.feet,
      orderFeet: entry.orderFeet,
    });
    totalFeet += entry.feet;
    totalOrderFeet += entry.orderFeet;
  }

  return { lines, totalFeet, totalOrderFeet };
}
