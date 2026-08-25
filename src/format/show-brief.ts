/**
 * The show, described once.
 *
 * Groundplan already knew four things about a job — venue, event, date and
 * contact — and kept them in the legacy file's trailer, which is where the
 * original editor put them and where the title block still reads them from.
 * Four fields is enough to label a drawing and nothing like enough to build
 * one from: nothing recorded who the client was, how many people were coming,
 * what kind of room they were coming to, or whether a stage was wanted.
 *
 * So the headcount a user typed into New Plan picked a room preset and was
 * then thrown away, and the finished drawing had no idea what it was supposed
 * to satisfy. This is the record that survives, and that the plan can be
 * checked against.
 *
 * It lives in the companion sidecar rather than the .rv4, because the .rv4 is
 * a 2013 binary format that the original Room Viewer still has to be able to
 * open. Nothing here touches it. The four trailer fields stay in the trailer
 * and stay in step with their counterparts here — see `identityFromBrief`.
 */

export const SHOW_BRIEF_VERSION = 2;

export type ShowStatus = 'planning' | 'review' | 'approved' | 'complete';

export type LayoutType =
  | 'theatre'
  | 'banquet'
  | 'classroom'
  | 'general-session'
  | 'trade-show'
  | 'custom';

export const SHOW_STATUSES: ReadonlyArray<{ id: ShowStatus; label: string }> = [
  { id: 'planning', label: 'Planning' },
  { id: 'review', label: 'In review' },
  { id: 'approved', label: 'Approved' },
  { id: 'complete', label: 'Complete' },
];

export const LAYOUT_TYPES: ReadonlyArray<{ id: LayoutType; label: string; hint: string }> = [
  { id: 'theatre', label: 'Theatre', hint: 'Rows of chairs, no tables' },
  { id: 'banquet', label: 'Banquet', hint: 'Rounds with chairs' },
  { id: 'classroom', label: 'Classroom', hint: 'Rows of tables with chairs' },
  { id: 'general-session', label: 'General session', hint: 'Theatre with stage and screens' },
  { id: 'trade-show', label: 'Trade show', hint: 'Booths and aisles' },
  { id: 'custom', label: 'Custom', hint: 'Something else' },
];

/**
 * What somebody knows about a show before the drawing exists.
 *
 * Every field except `name` is optional, and absent means "not said yet"
 * rather than "no". A brief that has only been half filled in is the normal
 * state of a brief, and the readiness check reports what is missing rather
 * than the model refusing to hold it.
 */
export interface ShowBrief {
  version: typeof SHOW_BRIEF_VERSION;

  /* Basic ---------------------------------------------------------------- */
  /** The show's name. The one field worth insisting on. */
  name: string;
  client?: string;
  jobNumber?: string;
  status: ShowStatus;
  /** ISO date strings (YYYY-MM-DD), or a full ISO timestamp. Free-form. */
  eventStart?: string;
  eventEnd?: string;
  loadIn?: string;
  loadOut?: string;

  /* Venue ---------------------------------------------------------------- */
  venue?: string;
  roomName?: string;
  address?: string;
  venueContact?: string;
  productionContact?: string;
  accessNotes?: string;

  /* Layout goals --------------------------------------------------------- */
  /** People expected. The number the finished plan is measured against. */
  targetAttendance?: number;
  layoutType?: LayoutType;
  stageRequired?: boolean;
  /** Wanted stage size in feet. Absent means "a stage, size to be decided". */
  stageWidthFt?: number;
  stageDepthFt?: number;
  stageHeightIn?: number;
  screensRequired?: boolean;
  tablesRequired?: boolean;

  /* Constraints ---------------------------------------------------------- */
  /** Minimum aisle width in inches. */
  minAisleIn?: number;
  /** Wheelchair spaces the room has to provide. */
  accessibleSeats?: number;
  riggingAllowed?: boolean;
  riggingNotes?: string;
  powerNotes?: string;
  egressNotes?: string;
  productionNotes?: string;

  /** ISO timestamp of the last edit, for the summary line. */
  updatedAt?: string;
}

/** A brief with nothing said yet beyond a name. */
export function emptyShowBrief(name = ''): ShowBrief {
  return { version: SHOW_BRIEF_VERSION, name, status: 'planning' };
}

/** True when nothing beyond the defaults has been filled in. */
export function briefIsEmpty(brief: ShowBrief | null | undefined): boolean {
  if (!brief) return true;
  const { version, status, updatedAt, name, ...rest } = brief;
  void version;
  void updatedAt;
  if (name.trim()) return false;
  if (status !== 'planning') return false;
  return Object.values(rest).every((v) => v === undefined || v === '' || v === null);
}

const str = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

const bool = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

/**
 * A positive number, or nothing.
 *
 * Zero is rejected along with negatives and NaN: a target attendance of zero
 * is somebody clearing the field, not a show nobody is coming to, and storing
 * it would make the readiness check report a shortfall of nothing.
 */
const count = (value: unknown, max = 1_000_000): number | undefined => {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(max, Math.round(n));
};

const decimal = (value: unknown, max = 100_000): number | undefined => {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(max, Math.round(n * 100) / 100);
};

function parseStatus(value: unknown): ShowStatus {
  return SHOW_STATUSES.some((s) => s.id === value) ? (value as ShowStatus) : 'planning';
}

function parseLayoutType(value: unknown): LayoutType | undefined {
  return LAYOUT_TYPES.some((l) => l.id === value) ? (value as LayoutType) : undefined;
}

/**
 * Reads a brief out of whatever the sidecar holds.
 *
 * Returns null rather than a default brief when there is nothing there: a plan
 * from before this existed has no brief, and inventing an empty one would
 * write a sidecar for every legacy file that was merely opened, and would make
 * "has a brief" untestable.
 *
 * Unknown fields are dropped and bad values fall back to absent, so a sidecar
 * hand-edited into nonsense degrades to a thinner brief rather than failing
 * the plan open.
 */
export function parseShowBrief(input: unknown): ShowBrief | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Record<string, unknown>;

  // Version 1 was the same shape without `updatedAt`; nothing to migrate but
  // the number. Anything newer than we know is read on a best-effort basis
  // rather than discarded — a field we do not understand is not a reason to
  // lose the client's name.
  const name = typeof value.name === 'string' ? value.name.trim() : '';

  const brief: ShowBrief = {
    version: SHOW_BRIEF_VERSION,
    name,
    status: parseStatus(value.status),
  };

  const assign = <K extends keyof ShowBrief>(key: K, v: ShowBrief[K] | undefined) => {
    if (v !== undefined) brief[key] = v;
  };

  assign('client', str(value.client));
  assign('jobNumber', str(value.jobNumber));
  assign('eventStart', str(value.eventStart));
  assign('eventEnd', str(value.eventEnd));
  assign('loadIn', str(value.loadIn));
  assign('loadOut', str(value.loadOut));

  assign('venue', str(value.venue));
  assign('roomName', str(value.roomName));
  assign('address', str(value.address));
  assign('venueContact', str(value.venueContact));
  assign('productionContact', str(value.productionContact));
  assign('accessNotes', str(value.accessNotes));

  assign('targetAttendance', count(value.targetAttendance, 500_000));
  assign('layoutType', parseLayoutType(value.layoutType));
  assign('stageRequired', bool(value.stageRequired));
  assign('stageWidthFt', decimal(value.stageWidthFt, 2000));
  assign('stageDepthFt', decimal(value.stageDepthFt, 2000));
  assign('stageHeightIn', decimal(value.stageHeightIn, 240));
  assign('screensRequired', bool(value.screensRequired));
  assign('tablesRequired', bool(value.tablesRequired));

  assign('minAisleIn', decimal(value.minAisleIn, 600));
  assign('accessibleSeats', count(value.accessibleSeats, 10_000));
  assign('riggingAllowed', bool(value.riggingAllowed));
  assign('riggingNotes', str(value.riggingNotes));
  assign('powerNotes', str(value.powerNotes));
  assign('egressNotes', str(value.egressNotes));
  assign('productionNotes', str(value.productionNotes));

  assign('updatedAt', str(value.updatedAt));

  // A record with no name and nothing else said is not a brief.
  if (briefIsEmpty(brief)) return null;
  return brief;
}

/** Applies a patch, dropping keys set to empty so a cleared field really clears. */
export function patchShowBrief(current: ShowBrief | null, patch: Partial<ShowBrief>): ShowBrief {
  const base = current ?? emptyShowBrief();
  const next: ShowBrief = { ...base, version: SHOW_BRIEF_VERSION };

  for (const [key, raw] of Object.entries(patch) as Array<[keyof ShowBrief, unknown]>) {
    if (key === 'version') continue;
    if (key === 'name') {
      next.name = typeof raw === 'string' ? raw.trim() : base.name;
      continue;
    }
    if (key === 'status') {
      next.status = parseStatus(raw);
      continue;
    }
    // Clearing a field means removing it, not storing "". Otherwise a sidecar
    // accumulates empty strings that read as "said, and said nothing".
    if (raw === undefined || raw === null || raw === '') {
      delete next[key];
      continue;
    }
    (next as unknown as Record<string, unknown>)[key] = raw;
  }

  next.updatedAt = new Date().toISOString();
  return next;
}

/**
 * The four legacy trailer fields, derived from the brief.
 *
 * The title block, the DXF export and the original Room Viewer all read the
 * trailer, so the brief cannot be the only place this lives. Keeping them in
 * step in one direction — brief to trailer — means there is one author and no
 * chance of the two disagreeing about which is right.
 *
 * `event` takes the show's name because that is what the trailer's event field
 * has always meant, and what the title block prints.
 */
export function identityFromBrief(brief: ShowBrief): {
  event?: string;
  venue?: string;
  date?: string;
  contact?: string;
} {
  const out: { event?: string; venue?: string; date?: string; contact?: string } = {};
  if (brief.name) out.event = brief.name;
  // A room name is the more specific answer when there is one: "Marriott
  // Grand Ballroom East" tells a driver more than "Marriott".
  const venue = [brief.venue, brief.roomName].filter(Boolean).join(' · ');
  if (venue) out.venue = venue;
  if (brief.eventStart) out.date = brief.eventStart;
  const contact = brief.productionContact ?? brief.venueContact;
  if (contact) out.contact = contact;
  return out;
}

/** Seeds a brief from the trailer fields a legacy plan already carries. */
export function briefFromIdentity(identity: {
  event?: string;
  venue?: string;
  date?: string;
  contact?: string;
}): ShowBrief | null {
  const brief = emptyShowBrief(identity.event?.trim() ?? '');
  if (identity.venue?.trim()) brief.venue = identity.venue.trim();
  if (identity.date?.trim()) brief.eventStart = identity.date.trim();
  if (identity.contact?.trim()) brief.productionContact = identity.contact.trim();
  return briefIsEmpty(brief) ? null : brief;
}

/** One line describing the show, for a summary card. */
export function describeBrief(brief: ShowBrief): string {
  const parts: string[] = [];
  if (brief.client) parts.push(brief.client);
  if (brief.venue) parts.push(brief.venue);
  if (brief.targetAttendance) parts.push(`${brief.targetAttendance.toLocaleString()} people`);
  const layout = LAYOUT_TYPES.find((l) => l.id === brief.layoutType);
  if (layout) parts.push(layout.label);
  return parts.join(' · ');
}
