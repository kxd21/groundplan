/**
 * Comparing the gear list against the drawing.
 *
 * Groundplan holds both halves of a job — what was ordered and what was drawn —
 * which nothing else in this workflow does. That makes one question answerable
 * that otherwise gets answered on the loading dock: does the plan match the
 * pull?
 *
 * Three kinds of mismatch matter, and they fail differently:
 *
 *   - **On the list, not on the plan.** Either the drawing is unfinished or the
 *     item is being shipped without a home. Common and usually benign for
 *     cable, serious for a projector.
 *   - **On the plan, not on the list.** The truck will leave without it. This
 *     is the expensive one.
 *   - **Different counts.** Twelve chairs drawn, ten pulled.
 *
 * Matching is by name, normalised, because the gear list and the shape
 * catalogue are maintained by different people and agree only loosely.
 */

import type { Scene } from '../format/scene.js';
import { walkItems, type GearList } from './model.js';

export type ReconcileStatus = 'match' | 'missing-on-plan' | 'missing-on-list' | 'count';

export interface ReconcileRow {
  name: string;
  status: ReconcileStatus;
  /** Quantity on the gear list, summed across departments. */
  listed: number;
  /** How many are drawn on the plan. */
  drawn: number;
  department?: string;
}

export interface ReconcileReport {
  /**
   * Immutable snapshot identity. Consumers can compare it with the active
   * pair before presenting or acting on a cached report.
   */
  identity: ReconcileIdentity;
  rows: ReconcileRow[];
  matched: number;
  missingOnPlan: number;
  missingOnList: number;
  countMismatch: number;
  /**
   * Items ignored because they are never drawn: cable, adapters, batteries and
   * the like. Counting those as "missing from the plan" would bury the real
   * findings under hundreds of rows.
   */
  ignored: number;
}

export interface ReconcileContext {
  planId?: string;
  planRevision?: number;
  planPath?: string;
  comparedAt?: string;
}

export interface ReconcileIdentity {
  gear: {
    id?: string;
    revision: number;
    jobNumber?: string;
    title: string;
    fingerprint: string;
  };
  plan: {
    id?: string;
    revision?: number;
    path?: string;
    title?: string;
    fingerprint: string;
  };
  comparedAt: string;
}

/** Consumables and cable that no one puts on a floor plan. */
const NOT_DRAWN =
  /\b(cable|jumper|xlr|sdi|hdmi|cat\s*6|cat6|dmx|soca|edison|feeder|adapter|adaptor|battery|batteries|barrel|coupler|shackle|clamp|tape|clip|bolt|sandbag|case|bag|strap|spanset|zipties?|screw|pin|whip|breakout|snake|loom|power supply|ac adapter|remote|stand|drive|thumb drive|adapter)\b/i;

function normalise(name: string): string {
  return name
    .toLowerCase()
    .replace(/[”“]/g, '"')
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Two names refer to the same thing when one contains the other.
 *
 * `Round 60"` on the list and `Round 60" Table` on the plan are the same table;
 * requiring an exact string match would report both as missing.
 */
function related(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  return a.includes(b) || b.includes(a);
}

function fingerprint(parts: string[]): string {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      hash ^= part.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

export function gearFingerprint(list: GearList): string {
  const parts = [list.id ?? '', list.jobNumber ?? '', list.title, list.location ?? ''];
  for (const department of list.departments) {
    parts.push(department.id, department.name);
    const visit = (items: ReturnType<typeof walkItems>) => {
      for (const item of items) {
        parts.push(
          item.id,
          String(item.quantity),
          item.description,
          item.note ? 'note' : 'item',
          item.checked ? 'checked' : 'open',
        );
      }
    };
    visit(walkItems({ ...list, departments: [department] }));
  }
  return fingerprint(parts);
}

export function planInventoryFingerprint(scene: Scene): string {
  const parts = scene.inventory
    .map((item) => `${normalise(item.name)}\u0000${item.count}`)
    .sort();
  return fingerprint([scene.title ?? '', ...parts]);
}

export function reconcileIdentity(
  list: GearList,
  scene: Scene,
  context: ReconcileContext = {},
): ReconcileIdentity {
  return {
    gear: {
      id: list.id,
      revision: Number.isSafeInteger(list.revision) ? list.revision! : 0,
      jobNumber: list.jobNumber,
      title: list.title,
      fingerprint: gearFingerprint(list),
    },
    plan: {
      id: context.planId,
      revision: context.planRevision,
      path: context.planPath,
      title: scene.title,
      fingerprint: planInventoryFingerprint(scene),
    },
    comparedAt: context.comparedAt ?? new Date().toISOString(),
  };
}

/** True only while both inputs still represent the snapshot in the report. */
export function isReconcileReportCurrent(
  report: ReconcileReport,
  list: GearList,
  scene: Scene,
  context: ReconcileContext = {},
): boolean {
  const current = reconcileIdentity(list, scene, { ...context, comparedAt: report.identity.comparedAt });
  return (
    report.identity.gear.id === current.gear.id &&
    report.identity.gear.revision === current.gear.revision &&
    report.identity.gear.fingerprint === current.gear.fingerprint &&
    report.identity.plan.id === current.plan.id &&
    report.identity.plan.revision === current.plan.revision &&
    report.identity.plan.path === current.plan.path &&
    report.identity.plan.fingerprint === current.plan.fingerprint
  );
}

export function reconcile(
  list: GearList,
  scene: Scene,
  context: ReconcileContext = {},
): ReconcileReport {
  const listed = new Map<string, { name: string; quantity: number; department?: string }>();

  for (const department of list.departments) {
    for (const item of walkItems({ ...list, departments: [department] })) {
      if (item.note) continue;
      const key = normalise(item.description);
      const existing = listed.get(key);
      if (existing) existing.quantity += item.quantity;
      else listed.set(key, { name: item.description, quantity: item.quantity, department: department.name });
    }
  }

  const drawn = new Map<string, { name: string; count: number }>();
  for (const item of scene.inventory) {
    drawn.set(normalise(item.name), { name: item.name, count: item.count });
  }

  const rows: ReconcileRow[] = [];
  const usedDrawn = new Set<string>();
  let ignored = 0;

  for (const [key, entry] of listed) {
    let match: { key: string; name: string; count: number } | null = null;
    for (const [dk, d] of drawn) {
      if (related(key, dk)) {
        match = { key: dk, ...d };
        break;
      }
    }

    if (!match) {
      // Cable and consumables are never drawn; saying so every time is noise.
      if (NOT_DRAWN.test(entry.name)) {
        ignored++;
        continue;
      }
      rows.push({
        name: entry.name,
        status: 'missing-on-plan',
        listed: entry.quantity,
        drawn: 0,
        department: entry.department,
      });
      continue;
    }

    usedDrawn.add(match.key);
    rows.push({
      name: entry.name,
      status: entry.quantity === match.count ? 'match' : 'count',
      listed: entry.quantity,
      drawn: match.count,
      department: entry.department,
    });
  }

  for (const [key, entry] of drawn) {
    if (usedDrawn.has(key)) continue;
    rows.push({ name: entry.name, status: 'missing-on-list', listed: 0, drawn: entry.count });
  }

  // Problems first, then the biggest discrepancies.
  const rank: Record<ReconcileStatus, number> = {
    'missing-on-list': 0,
    'count': 1,
    'missing-on-plan': 2,
    match: 3,
  };
  rows.sort(
    (a, b) => rank[a.status] - rank[b.status] || Math.abs(b.listed - b.drawn) - Math.abs(a.listed - a.drawn),
  );

  return {
    identity: reconcileIdentity(list, scene, context),
    rows,
    matched: rows.filter((r) => r.status === 'match').length,
    missingOnPlan: rows.filter((r) => r.status === 'missing-on-plan').length,
    missingOnList: rows.filter((r) => r.status === 'missing-on-list').length,
    countMismatch: rows.filter((r) => r.status === 'count').length,
    ignored,
  };
}
