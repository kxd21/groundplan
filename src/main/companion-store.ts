/**
 * Reading and writing the companion document beside a plan.
 *
 * The rules this enforces are the ones that make a sidecar safe to rely on:
 *
 *   - A damaged companion is never partly applied and never overwritten. The
 *     file is left exactly as it is and the plan opens as though there were no
 *     companion, so a JSON syntax error costs nothing but the extra data.
 *   - A stale companion — the plan was edited in Room Viewer since — is loaded
 *     but reported as stale. Deleting it would throw away work; applying it
 *     silently would describe a room that is no longer there.
 *   - Writing goes through the same atomic write and backup chain the rest of
 *     the app's persistent data uses.
 */

import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';

import type { RVDocument } from '../format/rv.js';
import {
  companionPathFor,
  companionStatus,
  createCompanion,
  fingerprint,
  parseCompanion,
  type CompanionDocument,
  type Freshness,
} from '../format/companion.js';
import { deriveRoom } from '../format/room.js';
import type { UnitSystem } from '../format/units.js';
import { atomicWriteJson } from './storage.js';

export interface LoadedCompanion {
  companion: CompanionDocument;
  freshness: Freshness;
  /** Set when the file exists but could not be read as a companion. */
  damaged: boolean;
  /** Plain-language note for the UI, when there is something to say. */
  reason?: string;
  /**
   * True when the room model was recovered from the plan's own geometry rather
   * than read from the companion — which is what happens on any of the files
   * that existed before this feature.
   */
  derived: boolean;
}

/**
 * Loads the companion for a plan, falling back to deriving one.
 *
 * The fallback is the point: every plan gets a room model, area, perimeter and
 * capacity on first open, whether or not anyone has ever saved companion data
 * for it. Nothing is written to disk here — a derived model is offered, and it
 * becomes real only when the user saves.
 */
export async function loadCompanion(
  planPath: string,
  doc: RVDocument,
  units: UnitSystem = 'imperial',
): Promise<LoadedCompanion> {
  const path = companionPathFor(planPath);

  const deriveFresh = (): LoadedCompanion => {
    const { room, source, closed } = deriveRoom(doc);
    return {
      companion: createCompanion(doc, units, room.walls.length ? [room] : []),
      freshness: 'missing',
      damaged: false,
      derived: true,
      reason:
        source === 'extent'
          ? 'No wall outline could be traced, so the room is the extent of the drawing — treat its area as an over-estimate.'
          : source === 'none'
            ? 'This plan has no wall geometry, so it has no room outline yet.'
            : closed
              ? undefined
              : 'The wall outline did not close, so the area is a best guess.',
    };
  };

  if (!existsSync(path)) return deriveFresh();

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return {
      ...deriveFresh(),
      damaged: true,
      reason: 'The Groundplan data file beside this plan is damaged. It has been left untouched.',
    };
  }

  const companion = parseCompanion(parsed);
  if (!companion) {
    return {
      ...deriveFresh(),
      damaged: true,
      reason:
        'The Groundplan data file beside this plan was written by a different version. It has been left untouched.',
    };
  }

  const status = companionStatus(companion, doc);
  return {
    companion,
    freshness: status.freshness,
    damaged: false,
    derived: companion.roomIsDerived === true,
    reason: status.reason,
  };
}

/**
 * Writes the companion, restamping it against the document being saved.
 *
 * Called after the `.rv4` is written, never before, and given the archive body
 * that was written rather than the document: the fingerprint has to describe
 * the bytes that actually landed on disk, or the companion reads as stale the
 * next time the plan is opened.
 */
export async function saveCompanion(
  planPath: string,
  body: Buffer,
  companion: CompanionDocument,
): Promise<void> {
  const path = companionPathFor(planPath);
  const next: CompanionDocument = { ...companion, plan: fingerprint(body) };
  await atomicWriteJson(path, next, {
    backupPath: existsSync(path) ? `${path}.bak` : undefined,
  });
}

/**
 * Removes the companion.
 *
 * Only ever in response to an explicit request — "forget the Groundplan data
 * for this plan" — because the plan is fully usable without it and the data is
 * not recoverable from the `.rv4`.
 */
export async function discardCompanion(planPath: string): Promise<void> {
  await rm(companionPathFor(planPath), { force: true });
}

/** Where the companion for a plan lives, for the UI to show. */
export { companionPathFor };
