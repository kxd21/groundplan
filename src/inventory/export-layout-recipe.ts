/**
 * Best-effort export of an open plan into a layout recipe (AI round-trip).
 * Gear and labels come from the schedule; seating is one synthetic bank
 * matching total chairs (AI or human can split into banks later).
 */

import type { RVDocument } from '../format/rv.js';
import { UNITS_PER_FOOT, walk } from '../format/rv.js';
import { planIdentity } from '../format/plan-skeleton.js';
import { deriveRoom, roomBounds } from '../format/room.js';
import { buildSchedule } from '../format/schedule.js';
import {
  LAYOUT_RECIPE_FORMAT,
  LAYOUT_RECIPE_VERSION,
  type LayoutRecipe,
  type LayoutRecipeGear,
  type LayoutRecipeLabel,
  type LayoutRecipeSeatingBlock,
} from './layout-recipe.js';

export function exportLayoutRecipe(doc: RVDocument): LayoutRecipe {
  const identity = planIdentity(doc) ?? { event: '', venue: '', date: '', contact: '' };
  const derived = deriveRoom(doc);
  const bounds = derived.source !== 'none' ? roomBounds(derived.room) : null;
  const schedule = buildSchedule(doc);

  const chairGroups = schedule.groups.filter((g) => /chair/i.test(g.name));
  const chairTotal = chairGroups.reduce((a, g) => a + g.count, 0);
  const primaryChair = chairGroups.sort((a, b) => b.count - a.count)[0]?.name ?? 'Chair';

  const gear: LayoutRecipeGear[] = [];
  for (const group of schedule.groups) {
    if (/chair/i.test(group.name)) continue;
    if (/stage/i.test(group.name)) continue;
    for (const entry of group.entries) {
      gear.push({
        name: group.name,
        xFt: entry.x / UNITS_PER_FOOT,
        yFt: entry.y / UNITS_PER_FOOT,
      });
    }
  }

  const labels: LayoutRecipeLabel[] = [];
  for (const node of walk(doc)) {
    if (node.cls !== 'RVLabel') continue;
    const text = (node.labels[0] ?? '').trim();
    if (!text) continue;
    const at = node.points[0] ?? {
      x: (node.bounds.left + node.bounds.right) / 2,
      y: (node.bounds.top + node.bounds.bottom) / 2,
    };
    labels.push({
      text,
      xFt: at.x / UNITS_PER_FOOT,
      yFt: at.y / UNITS_PER_FOOT,
    });
  }

  let seating: LayoutRecipeSeatingBlock[] = [];
  if (chairTotal > 0) {
    const banks = Math.max(1, Math.round(chairTotal / 140));
    const perBank = Math.floor(chairTotal / banks);
    const remainder = chairTotal - perBank * banks;
    seating = Array.from({ length: banks }, (_, i) => {
      const count = perBank + (i < remainder ? 1 : 0);
      const rows = Math.max(1, Math.round(count / 14));
      const lengths = Array.from({ length: rows }, (__, r) =>
        r < rows - 1 ? Math.ceil(count / rows) : Math.max(1, count - Math.ceil(count / rows) * (rows - 1)),
      );
      const sum = lengths.reduce((a, b) => a + b, 0);
      if (sum !== count && lengths.length) lengths[lengths.length - 1]! += count - sum;
      return {
        xFt: bounds
          ? (bounds.minX + bounds.maxX) / 2 / UNITS_PER_FOOT + (i - (banks - 1) / 2) * 20
          : i * 20,
        yFt: bounds ? (bounds.minY + bounds.maxY) / 2 / UNITS_PER_FOOT : 0,
        chair: primaryChair,
        rowLengths: lengths,
        expectCount: count,
      };
    });
  }

  return {
    format: LAYOUT_RECIPE_FORMAT,
    version: LAYOUT_RECIPE_VERSION,
    identity: {
      event: identity.event || undefined,
      venue: identity.venue || undefined,
      date: identity.date || undefined,
      roomLabel: derived.room.name || undefined,
    },
    room: bounds
      ? {
          widthFt: (bounds.maxX - bounds.minX) / UNITS_PER_FOOT,
          depthFt: (bounds.maxY - bounds.minY) / UNITS_PER_FOOT,
        }
      : undefined,
    seating,
    gear: gear.slice(0, 400),
    labels: labels.slice(0, 100),
    expectations: {
      chairs: seating.reduce((a, b) => a + b.expectCount, 0),
      requireGearNames: [...new Set(gear.map((g) => g.name))].slice(0, 40),
    },
  };
}
