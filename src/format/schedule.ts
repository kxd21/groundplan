/**
 * Turning the drawing into paperwork.
 *
 * This is the idea worth stealing from Vectorworks: the plan *is* the database.
 * Every placed item already knows what it is and where it is, so the schedules
 * that currently get retyped — item counts, position reports, a hang plot —
 * should fall out of the drawing rather than be maintained beside it.
 *
 * Extra fields (purpose, channel, weight, power) live in a sidecar keyed by
 * what the item is and roughly where it sits, because object ids are only
 * stable within a single parse and the `.rv4` format has nowhere safe to put
 * arbitrary data.
 */

import { walk, UNITS_PER_FOOT, type RVDocument } from './rv.js';

export interface ScheduleEntry {
  /** Stable-ish key: what it is, and where, to the nearest inch. */
  key: string;
  name: string;
  /** Position in logical units. */
  x: number;
  y: number;
  /** Footprint in logical units. */
  width: number;
  height: number;
  /** Rotation in degrees, normalised to 0–359. */
  rotation: number;
  data?: Record<string, string>;
}

export interface ScheduleGroup {
  name: string;
  count: number;
  entries: ScheduleEntry[];
}

export interface Schedule {
  groups: ScheduleGroup[];
  total: number;
}

/**
 * A key that survives reopening the file.
 *
 * Position is rounded to the inch: enough to tell two chairs apart, coarse
 * enough that a rounding difference on reload does not orphan the data.
 */
export function entryKey(name: string, x: number, y: number): string {
  return `${name.trim().toLowerCase()}@${Math.round(x / 10)},${Math.round(y / 10)}`;
}

/** Builds the schedule from every placed item in a document. */
export function buildSchedule(doc: RVDocument, data?: Record<string, Record<string, string>>): Schedule {
  const groups = new Map<string, ScheduleGroup>();
  let total = 0;

  for (const node of walk(doc)) {
    if (node.cls !== 'RVShape') continue;
    const name = node.labels.find(
      (l) => !/^(Arial|Times|Courier|Helvetica|Tahoma|Verdana|Symbol)/i.test(l),
    );
    if (!name) continue;

    const at = node.points[0] ?? {
      x: (node.bounds.left + node.bounds.right) / 2,
      y: (node.bounds.top + node.bounds.bottom) / 2,
    };
    const key = entryKey(name, at.x, at.y);
    const degrees = node.angle != null ? Math.round((node.angle * 180) / Math.PI) : 0;

    const entry: ScheduleEntry = {
      key,
      name,
      x: at.x,
      y: at.y,
      width: node.bounds.right - node.bounds.left,
      height: node.bounds.bottom - node.bounds.top,
      rotation: ((degrees % 360) + 360) % 360,
      data: data?.[key],
    };

    let group = groups.get(name);
    if (!group) groups.set(name, (group = { name, count: 0, entries: [] }));
    group.count++;
    group.entries.push(entry);
    total++;
  }

  return {
    groups: [...groups.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    total,
  };
}

/** Fields the schedule offers beyond position — the ones this trade uses. */
export const SCHEDULE_FIELDS = ['purpose', 'channel', 'circuit', 'weight', 'power', 'notes'] as const;

/**
 * Renders the schedule as CSV.
 *
 * One row per placed item, positions in feet, so it opens straight into the
 * spreadsheet the shop already works from.
 */
export function scheduleToCsv(schedule: Schedule): string {
  const escape = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const header = ['Item', 'X (ft)', 'Y (ft)', 'Width (ft)', 'Height (ft)', 'Rotation', ...SCHEDULE_FIELDS];
  const rows = [header.join(',')];

  for (const group of schedule.groups) {
    for (const entry of group.entries) {
      rows.push(
        [
          escape(entry.name),
          (entry.x / UNITS_PER_FOOT).toFixed(2),
          (entry.y / UNITS_PER_FOOT).toFixed(2),
          (entry.width / UNITS_PER_FOOT).toFixed(2),
          (entry.height / UNITS_PER_FOOT).toFixed(2),
          `${entry.rotation}`,
          ...SCHEDULE_FIELDS.map((f) => escape(entry.data?.[f] ?? '')),
        ].join(','),
      );
    }
  }

  return rows.join('\n');
}

/** Summary counts, the form a production manager actually reads. */
export function scheduleSummaryCsv(schedule: Schedule): string {
  const escape = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const rows = ['Item,Count'];
  for (const group of schedule.groups) rows.push(`${escape(group.name)},${group.count}`);
  rows.push(`TOTAL,${schedule.total}`);
  return rows.join('\n');
}
