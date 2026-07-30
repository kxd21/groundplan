/**
 * Stable schedule fields for a legacy format that has no custom-ID slot.
 *
 * Records keep a UUID plus their last-known anchor. On rebuild, a one-to-one
 * matcher follows modest moves and safe renames. Ambiguous rows are left
 * unbound instead of silently attaching customer data to the wrong object.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import type { RVDocument } from '../format/rv.js';
import {
  buildSchedule,
  SCHEDULE_FIELDS,
  type Schedule,
  type ScheduleEntry,
} from '../format/schedule.js';
import { atomicWriteJson } from './storage.js';

interface ScheduleAnchor {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}

interface ScheduleMetadataRecord {
  id: string;
  anchor: ScheduleAnchor;
  fields: Record<string, string>;
}

interface ScheduleMetadataFile {
  format: 'groundplan-schedule';
  version: 2;
  entries: ScheduleMetadataRecord[];
}

export interface StableScheduleResult {
  schedule: Schedule;
  warnings: string[];
  damaged: boolean;
}

const dataFileFor = (planPath: string): string => `${planPath}.groundplan-data.json`;
const normalise = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, ' ');
const entriesOf = (schedule: Schedule): ScheduleEntry[] =>
  schedule.groups.flatMap((group) => group.entries);

function anchorOf(entry: ScheduleEntry): ScheduleAnchor {
  return {
    name: entry.name,
    x: entry.x,
    y: entry.y,
    width: entry.width,
    height: entry.height,
    rotation: entry.rotation,
  };
}

function validFields(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const allowed = new Set<string>(SCHEDULE_FIELDS);
  return Object.fromEntries(
    Object.entries(value).flatMap(([field, fieldValue]) =>
      allowed.has(field) && typeof fieldValue === 'string' && fieldValue.trim()
        ? [[field, fieldValue.trim()]]
        : [],
    ),
  );
}

function parseAnchor(value: unknown): ScheduleAnchor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.name !== 'string' ||
    !['x', 'y', 'width', 'height', 'rotation'].every(
      (key) => typeof raw[key] === 'number' && Number.isFinite(raw[key]),
    )
  ) {
    return null;
  }
  return raw as unknown as ScheduleAnchor;
}

function parseV2(value: unknown): ScheduleMetadataFile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.format !== 'groundplan-schedule' || raw.version !== 2 || !Array.isArray(raw.entries)) {
    return null;
  }
  const ids = new Set<string>();
  const entries: ScheduleMetadataRecord[] = [];
  for (const valueEntry of raw.entries) {
    if (!valueEntry || typeof valueEntry !== 'object' || Array.isArray(valueEntry)) continue;
    const entry = valueEntry as Record<string, unknown>;
    const anchor = parseAnchor(entry.anchor);
    if (typeof entry.id !== 'string' || !entry.id || ids.has(entry.id) || !anchor) continue;
    ids.add(entry.id);
    entries.push({ id: entry.id, anchor, fields: validFields(entry.fields) });
  }
  return { format: 'groundplan-schedule', version: 2, entries };
}

function legacyAnchor(key: string): ScheduleAnchor | null {
  const match = key.match(/^(.*)@(-?\d+),(-?\d+)(?:#\d+)?$/);
  if (!match) return null;
  return {
    name: match[1],
    x: Number(match[2]) * 10,
    y: Number(match[3]) * 10,
    width: 0,
    height: 0,
    rotation: 0,
  };
}

function migrateLegacy(value: unknown): ScheduleMetadataFile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries: ScheduleMetadataRecord[] = [];
  for (const [key, fields] of Object.entries(value)) {
    const anchor = legacyAnchor(key);
    const safeFields = validFields(fields);
    if (!anchor || Object.keys(safeFields).length === 0) continue;
    entries.push({ id: randomUUID(), anchor, fields: safeFields });
  }
  return { format: 'groundplan-schedule', version: 2, entries };
}

async function loadMetadata(
  planPath: string,
): Promise<{ file: ScheduleMetadataFile; migrated: boolean; damaged: boolean }> {
  const path = dataFileFor(planPath);
  if (!existsSync(path)) {
    return {
      file: { format: 'groundplan-schedule', version: 2, entries: [] },
      migrated: false,
      damaged: false,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return {
      file: { format: 'groundplan-schedule', version: 2, entries: [] },
      migrated: false,
      damaged: true,
    };
  }
  const current = parseV2(parsed);
  if (current) return { file: current, migrated: false, damaged: false };
  const legacy = migrateLegacy(parsed);
  if (legacy) return { file: legacy, migrated: true, damaged: false };
  return {
    file: { format: 'groundplan-schedule', version: 2, entries: [] },
    migrated: false,
    damaged: true,
  };
}

async function saveMetadata(planPath: string, file: ScheduleMetadataFile): Promise<void> {
  const path = dataFileFor(planPath);
  await atomicWriteJson(path, file, {
    backupPath: existsSync(path) ? `${path}.bak` : undefined,
  });
}

function matchScore(anchor: ScheduleAnchor, entry: ScheduleEntry): number {
  const distance = Math.hypot(anchor.x - entry.x, anchor.y - entry.y);
  const sizeDistance = Math.abs(anchor.width - entry.width) + Math.abs(anchor.height - entry.height);
  const sameName = normalise(anchor.name) === normalise(entry.name);

  // Same-name objects may move substantially, but reject absurdly distant
  // matches. A rename is accepted only when the footprint stayed at the same
  // location, which is much less likely to bind the wrong row.
  if (sameName && distance <= 100 * 120) return distance + sizeDistance * 0.05;
  if (!sameName && distance <= 10 && (anchor.width === 0 || sizeDistance <= 20)) {
    return 1_000 + distance + sizeDistance;
  }
  return Number.POSITIVE_INFINITY;
}

function anchorChanged(a: ScheduleAnchor, b: ScheduleAnchor): boolean {
  return (
    a.name !== b.name ||
    a.x !== b.x ||
    a.y !== b.y ||
    a.width !== b.width ||
    a.height !== b.height ||
    a.rotation !== b.rotation
  );
}

export async function buildStableSchedule(
  doc: RVDocument,
  planPath: string,
): Promise<StableScheduleResult> {
  const schedule = buildSchedule(doc);
  const currentEntries = entriesOf(schedule);
  currentEntries.forEach((entry, index) => {
    entry.key = `pending:${index}:${entry.key}`;
    entry.data = undefined;
  });

  const loaded = await loadMetadata(planPath);
  const warnings: string[] = [];
  if (loaded.damaged) {
    warnings.push('Schedule metadata is damaged; it was left untouched.');
    return { schedule, warnings, damaged: true };
  }

  const unused = new Set(currentEntries);
  let changed = loaded.migrated;
  let ambiguous = 0;
  for (const record of loaded.file.entries) {
    const candidates = [...unused]
      .map((entry) => ({ entry, score: matchScore(record.anchor, entry) }))
      .filter((candidate) => Number.isFinite(candidate.score))
      .sort((a, b) => a.score - b.score);
    if (!candidates.length) continue;
    if (candidates.length > 1 && Math.abs(candidates[0].score - candidates[1].score) < 0.001) {
      ambiguous++;
      continue;
    }
    const matched = candidates[0].entry;
    unused.delete(matched);
    matched.key = record.id;
    matched.data = record.fields;
    const nextAnchor = anchorOf(matched);
    if (anchorChanged(record.anchor, nextAnchor)) {
      record.anchor = nextAnchor;
      changed = true;
    }
  }

  const orphaned = loaded.file.entries.length - (currentEntries.length - unused.size);
  if (ambiguous) warnings.push(`${ambiguous} schedule field record${ambiguous === 1 ? '' : 's'} need review because matching was ambiguous.`);
  if (orphaned > 0) warnings.push(`${orphaned} schedule field record${orphaned === 1 ? '' : 's'} could not be matched to a placed item.`);
  if (changed) await saveMetadata(planPath, loaded.file);
  return { schedule, warnings, damaged: false };
}

export async function setStableScheduleField(
  doc: RVDocument,
  planPath: string,
  key: string,
  field: string,
  value: string,
): Promise<StableScheduleResult> {
  if (!(SCHEDULE_FIELDS as readonly string[]).includes(field)) {
    throw new Error('that schedule field is not supported');
  }
  const stable = await buildStableSchedule(doc, planPath);
  if (stable.damaged) throw new Error(stable.warnings[0] ?? 'schedule metadata is damaged');
  const entry = entriesOf(stable.schedule).find((candidate) => candidate.key === key);
  if (!entry) throw new Error('that schedule row no longer exists');

  const loaded = await loadMetadata(planPath);
  let record = loaded.file.entries.find((candidate) => candidate.id === key);
  if (!record) {
    record = { id: randomUUID(), anchor: anchorOf(entry), fields: {} };
    loaded.file.entries.push(record);
    entry.key = record.id;
  }
  const trimmed = value.trim();
  if (trimmed) record.fields[field] = trimmed;
  else delete record.fields[field];
  entry.data = record.fields;
  record.anchor = anchorOf(entry);
  await saveMetadata(planPath, loaded.file);
  return { ...stable, schedule: stable.schedule };
}
