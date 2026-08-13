/**
 * The companion document: everything the `.rv4` has nowhere to put.
 *
 * Room Viewer's format is a fixed set of classes with a fixed set of fields.
 * There is no extension point, no user-data blob, no custom-ID slot — which is
 * why a room can be *drawn* but not *described*, why 227 generated chairs stop
 * being a seating plan the moment the loop ends, and why a screen cannot know
 * which projector feeds it. None of that is missing because it was hard; it is
 * missing because the binary has no field for it.
 *
 * So it goes beside the plan instead:
 *
 *   Riverbend Hall.rv4              unchanged, byte-identical, opens in Room Viewer
 *   Riverbend Hall.groundplan.json  the room model, seating configurations,
 *                                    stage builds, AV pairings, layers
 *
 * Two rules keep this honest rather than clever:
 *
 *   1. **The `.rv4` stays canonical for geometry.** Anything the companion
 *      describes is also *drawn* into the plan as ordinary objects, so a legacy
 *      Room Viewer sees a normal file. The companion holds the intent that
 *      produced the drawing, never the drawing itself.
 *   2. **The companion knows when it is lying.** It records a digest of the
 *      archive it describes. Edit the plan somewhere else and the digest stops
 *      matching, at which point the parameters are stale and the app says so
 *      rather than quietly regenerating a room from numbers that no longer
 *      describe it.
 *
 * A plan with no companion behaves exactly as it did before this existed.
 */

import { createHash } from 'node:crypto';

import type { RVDocument } from './rv.js';
import type { AspectRatio, InstanceOverride, ItemSpec, Obstruction } from './definition.js';
import type { RoomModel, WallSegment } from './room.js';
import type { StageBuild, StageLevel, Stair, StairEdge } from './stage.js';
import type { UnitSystem } from './units.js';

export const COMPANION_FORMAT = 'groundplan-companion';
export const COMPANION_VERSION = 1;

/** Identifies the archive a companion was written against. */
export interface PlanFingerprint {
  /** SHA-256 of the archive body — the container is repacked on every save. */
  digest: string;
  bytes: number;
  /** ISO 8601, when the companion was last written. */
  savedAt: string;
}

/** A raster underlay anchored in plan coordinates beneath all drawing geometry. */
export interface PlanBackground {
  name: string;
  dataUrl: string;
  visible: boolean;
  opacity: number;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  flipX: boolean;
  flipY: boolean;
  locked: boolean;
  includeInExport: boolean;
  blendMode: 'normal' | 'multiply' | 'screen' | 'darken' | 'lighten';
  brightness: number;
  contrast: number;
  saturation: number;
  grayscale: number;
}

export interface CompanionDocument {
  format: typeof COMPANION_FORMAT;
  version: typeof COMPANION_VERSION;
  plan: PlanFingerprint;
  units: UnitSystem;
  rooms: RoomModel[];
  /** Definitions for the items this plan places: height, obstruction, seats. */
  library: ItemSpec[];
  /** Per-placement departures from a definition. */
  overrides: InstanceOverride[];
  /** Optional site plan, venue map, or photo shown below the editable plot. */
  background?: PlanBackground;
  /** Authored stage build (deck heights / stairs) — survives reopen for pull lists and DXF Z. */
  stage?: StageBuild;
  /** Keeps a traced room labelled as derived when a background alone creates a sidecar. */
  roomIsDerived?: boolean;
}

/** The sidecar path for a plan. */
export function companionPathFor(planPath: string): string {
  return `${planPath}.groundplan.json`;
}

/**
 * Fingerprints an archive body.
 *
 * Takes the bytes rather than the document on purpose. `doc.source` is the
 * archive as it was *read*, and it does not change as the document is edited —
 * so fingerprinting the document at save time would record the hash of the
 * version that was opened, and the companion would read as stale the moment it
 * was reopened. The caller passes what it is about to write.
 *
 * The body, not the file: the compound-file container is rebuilt from scratch
 * on every save, so two saves of an identical document can differ at the file
 * level while the archive inside them is the same.
 */
export function fingerprint(body: Buffer): PlanFingerprint {
  return {
    digest: createHash('sha256').update(body).digest('hex'),
    bytes: body.length,
    savedAt: new Date().toISOString(),
  };
}

export function createCompanion(
  doc: RVDocument,
  units: UnitSystem = 'imperial',
  rooms: RoomModel[] = [],
  library: ItemSpec[] = [],
  overrides: InstanceOverride[] = [],
): CompanionDocument {
  return {
    format: COMPANION_FORMAT,
    version: COMPANION_VERSION,
    plan: fingerprint(doc.source),
    units,
    rooms,
    library,
    overrides,
  };
}

export type Freshness = 'fresh' | 'stale' | 'missing';

export interface CompanionStatus {
  freshness: Freshness;
  /** Plain-language explanation, suitable for showing to the user. */
  reason?: string;
}

function parseStage(value: unknown): StageBuild | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || !value.id) return null;
  if (typeof value.name !== 'string' || !value.name) return null;
  if (!Array.isArray(value.levels) || !value.levels.length) return null;
  const edges = new Set<StairEdge>(['front', 'back', 'left', 'right']);
  const levels: StageLevel[] = [];
  for (const raw of value.levels) {
    if (!isRecord(raw)) continue;
    const height = typeof raw.height === 'number' && raw.height > 0 ? raw.height : 0;
    const x = typeof raw.x === 'number' ? raw.x : NaN;
    const y = typeof raw.y === 'number' ? raw.y : NaN;
    const width = typeof raw.width === 'number' && raw.width > 0 ? raw.width : 0;
    const depth = typeof raw.depth === 'number' && raw.depth > 0 ? raw.depth : 0;
    if (!(height > 0 && width > 0 && depth > 0 && Number.isFinite(x) && Number.isFinite(y))) continue;
    levels.push({
      height,
      x,
      y,
      width,
      depth,
      ...(typeof raw.label === 'string' && raw.label ? { label: raw.label } : {}),
    });
  }
  if (!levels.length) return null;
  const stairs: Stair[] = [];
  if (Array.isArray(value.stairs)) {
    for (const raw of value.stairs) {
      if (!isRecord(raw)) continue;
      if (typeof raw.id !== 'string' || !raw.id) continue;
      if (typeof raw.edge !== 'string' || !edges.has(raw.edge as StairEdge)) continue;
      const level = typeof raw.level === 'number' && raw.level >= 0 ? Math.floor(raw.level) : 0;
      const offset = typeof raw.offset === 'number' ? raw.offset : 0;
      const width = typeof raw.width === 'number' && raw.width > 0 ? raw.width : 0;
      const riserHeight = typeof raw.riserHeight === 'number' && raw.riserHeight > 0 ? raw.riserHeight : 0;
      if (!(width > 0 && riserHeight > 0)) continue;
      stairs.push({
        id: raw.id,
        level,
        edge: raw.edge as StairEdge,
        offset,
        width,
        riserHeight,
        handrail: raw.handrail === true,
      });
    }
  }
  return {
    id: value.id,
    name: value.name,
    levels,
    stairs,
    skirted: value.skirted === true,
  };
}

/**
 * Decides whether a companion still describes the plan beside it.
 *
 * This is the weak point of a sidecar design and it is checked on every open
 * rather than trusted. A stale companion is not deleted and not applied: the
 * parameters are kept so nothing is lost, and the caller is expected to offer
 * re-deriving the model from what the plan now contains.
 */
export function companionStatus(companion: CompanionDocument | null, doc: RVDocument): CompanionStatus {
  if (!companion) return { freshness: 'missing' };

  const current = createHash('sha256').update(doc.source).digest('hex');
  if (current === companion.plan.digest) return { freshness: 'fresh' };

  return {
    freshness: 'stale',
    reason:
      'This plan has been changed since its Groundplan data was written — probably saved in Room Viewer. ' +
      'The room, seating and stage settings describe the earlier version.',
  };
}

// ---------------------------------------------------------------------------
// Parsing untrusted JSON
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const isFinitePoint = (value: unknown): value is { x: number; y: number } =>
  isRecord(value) &&
  typeof value.x === 'number' &&
  typeof value.y === 'number' &&
  Number.isFinite(value.x) &&
  Number.isFinite(value.y);

function parseWall(value: unknown): WallSegment | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || !value.id) return null;
  if (!isFinitePoint(value.start) || !isFinitePoint(value.end)) return null;

  const segment: WallSegment = {
    id: value.id,
    start: { x: value.start.x, y: value.start.y },
    end: { x: value.end.x, y: value.end.y },
  };
  if (typeof value.bulge === 'number' && Number.isFinite(value.bulge) && value.bulge !== 0) {
    segment.bulge = value.bulge;
  }
  if (typeof value.thickness === 'number' && Number.isFinite(value.thickness) && value.thickness > 0) {
    segment.thickness = value.thickness;
  }
  if (value.virtual === true) segment.virtual = true;
  if (typeof value.label === 'string' && value.label) segment.label = value.label;
  return segment;
}

function parseWallLoop(value: unknown): WallSegment[] | null {
  if (!Array.isArray(value)) return null;
  const walls = value.map(parseWall).filter((w): w is WallSegment => w != null);
  return walls.length ? walls : null;
}

function parseRoom(value: unknown): RoomModel | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || !value.id) return null;

  const walls = parseWallLoop(value.walls);
  if (!walls) return null;

  const room: RoomModel = {
    id: value.id,
    name: typeof value.name === 'string' && value.name ? value.name : 'Room',
    walls,
    holes: Array.isArray(value.holes)
      ? value.holes.map(parseWallLoop).filter((loop): loop is WallSegment[] => loop != null)
      : [],
  };
  if (typeof value.ceilingHeight === 'number' && Number.isFinite(value.ceilingHeight) && value.ceilingHeight > 0) {
    room.ceilingHeight = value.ceilingHeight;
  }
  if (typeof value.reservedArea === 'number' && Number.isFinite(value.reservedArea) && value.reservedArea > 0) {
    room.reservedArea = value.reservedArea;
  }
  return room;
}

const OBSTRUCTIONS = new Set<Obstruction>(['none', 'partial', 'full']);

function parseAspectRatio(value: unknown): AspectRatio | undefined {
  if (!isRecord(value)) return undefined;
  const { w, h } = value;
  if (typeof w !== 'number' || typeof h !== 'number') return undefined;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return undefined;
  return { w, h };
}

/** Reads a positive length, rejecting the negatives and NaNs a hand edit produces. */
function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseSpec(value: unknown): ItemSpec | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || !value.id) return null;
  if (typeof value.name !== 'string' || !value.name) return null;

  const spec: ItemSpec = { id: value.id, name: value.name };
  if (typeof value.category === 'string' && value.category) spec.category = value.category;
  spec.width = positive(value.width);
  spec.depth = positive(value.depth);
  spec.elevation = nonNegative(value.elevation);
  spec.height = nonNegative(value.height);
  if (typeof value.obstruction === 'string' && OBSTRUCTIONS.has(value.obstruction as Obstruction)) {
    spec.obstruction = value.obstruction as Obstruction;
  }
  spec.aspect = parseAspectRatio(value.aspect);
  spec.seats = nonNegative(value.seats);
  spec.weightLb = nonNegative(value.weightLb);
  spec.powerW = nonNegative(value.powerW);
  if (typeof value.notes === 'string' && value.notes) spec.notes = value.notes;
  // A stored definition is a definition, whatever the file says: inference is
  // what happens when there is no stored one, so the flag never survives a save.
  return spec;
}

function parseOverride(value: unknown): InstanceOverride | null {
  if (!isRecord(value)) return null;
  if (typeof value.key !== 'string' || !value.key) return null;

  const override: InstanceOverride = { key: value.key };
  override.elevation = nonNegative(value.elevation);
  override.height = nonNegative(value.height);
  if (typeof value.obstruction === 'string' && OBSTRUCTIONS.has(value.obstruction as Obstruction)) {
    override.obstruction = value.obstruction as Obstruction;
  }
  override.aspect = parseAspectRatio(value.aspect);
  override.seats = nonNegative(value.seats);
  if (typeof value.label === 'string' && value.label) override.label = value.label;
  if (typeof value.layer === 'string' && value.layer) override.layer = value.layer;

  // A key with nothing attached to it is noise from a deleted edit.
  const meaningful = Object.keys(override).some((k) => k !== 'key' && override[k as keyof InstanceOverride] != null);
  return meaningful ? override : null;
}

function parseFingerprint(value: unknown): PlanFingerprint | null {
  if (!isRecord(value)) return null;
  if (typeof value.digest !== 'string' || !/^[0-9a-f]{64}$/.test(value.digest)) return null;
  if (typeof value.bytes !== 'number' || !Number.isFinite(value.bytes)) return null;
  return {
    digest: value.digest,
    bytes: value.bytes,
    savedAt: typeof value.savedAt === 'string' ? value.savedAt : new Date(0).toISOString(),
  };
}

/** Validates an image underlay received from either JSON or the renderer. */
export function parsePlanBackground(value: unknown): PlanBackground | null {
  if (!isRecord(value)) return null;
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 255) return null;
  if (
    typeof value.dataUrl !== 'string' ||
    value.dataUrl.length > 32 * 1024 * 1024 ||
    !/^data:image\/(png|jpe?g|webp);base64,[a-z0-9+/=]+$/i.test(value.dataUrl)
  ) {
    return null;
  }
  const numbers = [value.opacity, value.x, value.y, value.width, value.height, value.rotation];
  if (!numbers.every((number) => typeof number === 'number' && Number.isFinite(number))) return null;
  if ((value.width as number) <= 0 || (value.height as number) <= 0) return null;
  if ((value.opacity as number) < 0 || (value.opacity as number) > 1) return null;
  const appearance = (key: 'brightness' | 'contrast' | 'saturation' | 'grayscale', fallback: number) => {
    const number = value[key];
    return typeof number === 'number' && Number.isFinite(number) ? number : fallback;
  };
  const blendMode =
    value.blendMode === 'multiply' ||
    value.blendMode === 'screen' ||
    value.blendMode === 'darken' ||
    value.blendMode === 'lighten'
      ? value.blendMode
      : 'normal';
  return {
    name: value.name.trim(),
    dataUrl: value.dataUrl,
    visible: value.visible !== false,
    opacity: value.opacity as number,
    x: value.x as number,
    y: value.y as number,
    width: value.width as number,
    height: value.height as number,
    rotation: value.rotation as number,
    flipX: value.flipX === true,
    flipY: value.flipY === true,
    locked: value.locked === true,
    includeInExport: value.includeInExport !== false,
    blendMode,
    brightness: Math.max(0.2, Math.min(2, appearance('brightness', 1))),
    contrast: Math.max(0.2, Math.min(2, appearance('contrast', 1))),
    saturation: Math.max(0, Math.min(2, appearance('saturation', 1))),
    grayscale: Math.max(0, Math.min(1, appearance('grayscale', 0))),
  };
}

/**
 * Reads a companion file.
 *
 * Returns `null` for anything that is not a companion document this version
 * understands. A damaged or future-versioned file is never partly applied:
 * silently dropping half a room model is worse than starting from the plan.
 */
export function parseCompanion(value: unknown): CompanionDocument | null {
  if (!isRecord(value)) return null;
  if (value.format !== COMPANION_FORMAT) return null;
  if (value.version !== COMPANION_VERSION) return null;

  const plan = parseFingerprint(value.plan);
  if (!plan) return null;

  const background = parsePlanBackground(value.background);
  const stage = parseStage(value.stage);
  return {
    format: COMPANION_FORMAT,
    version: COMPANION_VERSION,
    plan,
    units: value.units === 'metric' ? 'metric' : 'imperial',
    rooms: Array.isArray(value.rooms)
      ? value.rooms.map(parseRoom).filter((room): room is RoomModel => room != null)
      : [],
    library: Array.isArray(value.library)
      ? value.library.map(parseSpec).filter((spec): spec is ItemSpec => spec != null)
      : [],
    overrides: Array.isArray(value.overrides)
      ? value.overrides.map(parseOverride).filter((o): o is InstanceOverride => o != null)
      : [],
    ...(background ? { background } : {}),
    ...(stage ? { stage } : {}),
    ...(value.roomIsDerived === true ? { roomIsDerived: true } : {}),
  };
}
