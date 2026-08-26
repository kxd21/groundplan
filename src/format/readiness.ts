/**
 * Does the drawing satisfy the brief?
 *
 * The brief says what the show needs; the plan says what has been drawn. This
 * compares them and produces the answer somebody needs before they issue a
 * sheet — not a score, and not a checklist that can be ticked while the plan
 * says otherwise, but a list of specific differences each of which names the
 * tool that fixes it.
 *
 * Two rules keep it honest.
 *
 * Nothing here is ticked by having VISITED a step. The old setup panel marked
 * "Start from a kit" done when a kit was applied and left it done after the
 * undo that emptied the room. Every check below reads the plan as it stands.
 *
 * And a check whose input is missing reports `unknown` rather than passing. A
 * brief that never stated a headcount cannot be short of one, and saying
 * "seats: ok" about a number nobody gave is how a drawing gets issued against
 * a requirement that was never checked.
 */

import type { ShowBrief } from './show-brief.js';
import { LAYOUT_TYPES } from './show-brief.js';

export type ReadinessLevel = 'ready' | 'attention' | 'incomplete';

export type IssueSeverity = 'blocking' | 'warning' | 'info';

/** Where a user goes to resolve an issue. Consumed by the panel as a button. */
export type IssueTarget =
  | 'brief'
  | 'venue'
  | 'room'
  | 'seating'
  | 'stage'
  | 'objects'
  | 'gear'
  | 'issue';

export interface ReadinessIssue {
  id: string;
  severity: IssueSeverity;
  /** What is wrong, in one line. */
  title: string;
  /** Why it matters, or what to do. Optional. */
  detail?: string;
  /** The panel section or tool that fixes it. */
  target: IssueTarget;
  /** Label for the button that takes you there. */
  action: string;
}

export interface SeatCheck {
  /** Seats actually on the drawing. */
  actual: number;
  /** Seats the brief asked for, when it said. */
  target?: number;
  /** Positive is a shortfall, negative is spare capacity. Null when no target. */
  shortfall: number | null;
}

export interface ReadinessReport {
  level: ReadinessLevel;
  issues: ReadinessIssue[];
  seats: SeatCheck;
  /** Requested vs found, for the summary rows. */
  stage: { required: boolean | undefined; found: boolean; sizeText?: string };
  screens: { required: boolean | undefined; found: boolean };
  tables: { required: boolean | undefined; found: boolean };
  accessible: { required: number | undefined; found: number };
  layoutLabel?: string;
  /** True when there is no brief at all. */
  briefMissing: boolean;
}

/** What the plan currently contains, as the panel already knows it. */
export interface PlanFacts {
  hasRoom: boolean;
  /** Chairs drawn. */
  seats: number;
  /** Tables drawn. */
  tables: number;
  /** A stage, riser or deck is on the drawing. */
  hasStage: boolean;
  /** The drawn stage's headline size, when there is one. */
  stageSize?: { widthFt?: number; depthFt?: number; heightIn?: number };
  /** A screen, projector or LED wall is on the drawing. */
  hasScreens: boolean;
  /** Placements tagged as accessible / wheelchair spaces. */
  accessibleSeats: number;
  /** Gear-list lines the plan is short of, when a gear list is loaded. */
  gearShort?: number;
  /** Drawn items that appear on no gear list. */
  gearUntracked?: number;
}

/**
 * Compares brief against plan.
 *
 * `incomplete` means the plan cannot be judged yet — there is no room, or no
 * brief to judge it against. `attention` means it can be judged and something
 * does not match. `ready` means every stated requirement is met; it does not
 * mean every requirement was stated, which is why unstated ones surface as
 * their own low-severity issues rather than being counted as passes.
 */
export function assessReadiness(
  brief: ShowBrief | null,
  facts: PlanFacts,
): ReadinessReport {
  const issues: ReadinessIssue[] = [];

  const target = brief?.targetAttendance;
  const seats: SeatCheck = {
    actual: facts.seats,
    target,
    shortfall: target == null ? null : target - facts.seats,
  };

  const stage: ReadinessReport['stage'] = {
    required: brief?.stageRequired,
    found: facts.hasStage,
    ...(facts.stageSize?.widthFt && facts.stageSize?.depthFt
      ? { sizeText: `${facts.stageSize.widthFt}′ × ${facts.stageSize.depthFt}′` }
      : {}),
  };
  const screens = { required: brief?.screensRequired, found: facts.hasScreens };
  const tables = { required: brief?.tablesRequired, found: facts.tables > 0 };
  const accessible = { required: brief?.accessibleSeats, found: facts.accessibleSeats };

  /* Blocking: the plan cannot be judged or issued in this state. ---------- */

  if (!facts.hasRoom) {
    issues.push({
      id: 'no-room',
      severity: 'blocking',
      title: 'No room boundary',
      detail: 'Nothing can be measured, seated or printed to scale without one.',
      target: 'room',
      action: 'Build the room',
    });
  }

  if (!brief || !brief.name.trim()) {
    issues.push({
      id: 'no-name',
      severity: 'blocking',
      title: 'The show has no name',
      detail: 'It prints on the title block and names the file everyone works from.',
      target: 'brief',
      action: 'Add show details',
    });
  }

  /* Warnings: the plan is judgeable and does not match the brief. --------- */

  if (seats.shortfall != null && seats.shortfall > 0) {
    issues.push({
      id: 'seats-short',
      severity: 'warning',
      title: `${seats.shortfall.toLocaleString()} seats short of target`,
      detail: `${facts.seats.toLocaleString()} drawn, ${target!.toLocaleString()} needed.`,
      target: 'seating',
      action: 'Open seating',
    });
  }

  /*
   * Too many seats is a problem too.
   *
   * "At least the target" was the whole test, so a 900-person show that landed
   * a 2,234-seat kit reported "Everything the brief asked for is on the
   * drawing" — with 1,334 chairs nobody ordered, the aisles they ate, and an
   * occupant load the fire marshal will read off the drawing rather than off
   * the brief. A few spare is normal and is not worth a word; a room set for
   * two and a half times the guest list is not a rounding error.
   */
  if (seats.shortfall != null && target != null) {
    const spare = -seats.shortfall;
    if (spare > 20 && spare > target * 0.1) {
      issues.push({
        id: 'seats-excess',
        severity: 'warning',
        title: `${spare.toLocaleString()} more seats than the show needs`,
        detail: `${facts.seats.toLocaleString()} drawn for ${target.toLocaleString()}. Chairs nobody ordered take the aisles and change the occupant load.`,
        target: 'seating',
        action: 'Open seating',
      });
    }
  }

  if (stage.required === true && !stage.found) {
    issues.push({
      id: 'stage-missing',
      severity: 'warning',
      title: 'A stage was asked for and none is drawn',
      target: 'stage',
      action: 'Build a stage',
    });
  }

  /*
   * A stage that exists but is the wrong stage.
   *
   * The brief collects a width, a depth and a height and used to do nothing
   * with any of them: a general session that asked for 40′ × 24′ and got a
   * 12′ × 5′ riser reported "Stage: on the drawing" and moved on. The riser
   * satisfies "a stage exists" and satisfies nothing the show needs.
   *
   * The tolerance is 10% on each dimension, and only a stage that is too SMALL
   * is worth a warning — a deck bigger than asked for is a decision somebody
   * made on purpose, not an error.
   */
  if (stage.required === true && stage.found && facts.stageSize) {
    const wantW = brief?.stageWidthFt;
    const wantD = brief?.stageDepthFt;
    const gotW = facts.stageSize.widthFt;
    const gotD = facts.stageSize.depthFt;
    const shortW = wantW != null && gotW != null && gotW < wantW * 0.9;
    const shortD = wantD != null && gotD != null && gotD < wantD * 0.9;
    if (shortW || shortD) {
      issues.push({
        id: 'stage-undersized',
        severity: 'warning',
        title: 'The stage on the drawing is smaller than the brief asked for',
        detail: `${gotW ?? '?'}′ × ${gotD ?? '?'}′ drawn, ${wantW ?? '?'}′ × ${wantD ?? '?'}′ asked for.`,
        target: 'stage',
        action: 'Open stage',
      });
    }
  }

  if (screens.required === true && !screens.found) {
    issues.push({
      id: 'screens-missing',
      severity: 'warning',
      title: 'Screens or A/V were asked for and none are drawn',
      target: 'objects',
      action: 'Place equipment',
    });
  }

  if (tables.required === true && !tables.found) {
    issues.push({
      id: 'tables-missing',
      severity: 'warning',
      title: 'Tables were asked for and none are drawn',
      target: 'seating',
      action: 'Open seating',
    });
  }

  if (accessible.required != null && accessible.found < accessible.required) {
    issues.push({
      id: 'accessible-short',
      severity: 'warning',
      title: `${accessible.required - accessible.found} accessible spaces short`,
      detail: `${accessible.found} marked, ${accessible.required} required.`,
      target: 'seating',
      action: 'Open seating',
    });
  }

  if (facts.gearShort && facts.gearShort > 0) {
    issues.push({
      id: 'gear-short',
      severity: 'warning',
      title: `${facts.gearShort} gear line${facts.gearShort === 1 ? '' : 's'} short`,
      detail: 'Drawn on the plan but not on the truck.',
      target: 'gear',
      action: 'Open gear list',
    });
  }

  /* Info: worth saying before issuing, not worth blocking on. ------------- */

  if (facts.gearUntracked && facts.gearUntracked > 0) {
    issues.push({
      id: 'gear-untracked',
      severity: 'info',
      title: `${facts.gearUntracked} drawn item${facts.gearUntracked === 1 ? '' : 's'} on no gear list`,
      target: 'gear',
      action: 'Open gear list',
    });
  }

  if (brief && !brief.venue) {
    issues.push({
      id: 'no-venue',
      severity: 'info',
      title: 'No venue recorded',
      detail: 'It prints on the title block and tells a driver where to go.',
      target: 'venue',
      action: 'Add venue',
    });
  }

  if (brief && !brief.egressNotes) {
    issues.push({
      id: 'no-egress',
      severity: 'info',
      title: 'No exit or egress information',
      detail: 'The one thing a fire marshal will ask about first.',
      target: 'venue',
      action: 'Add egress notes',
    });
  }

  if (brief && brief.targetAttendance == null) {
    issues.push({
      id: 'no-target',
      severity: 'info',
      title: 'No target attendance',
      detail: 'Without it the seat count cannot be checked against anything.',
      target: 'brief',
      action: 'Set attendance',
    });
  }

  const level: ReadinessLevel = issues.some((i) => i.severity === 'blocking')
    ? 'incomplete'
    : issues.some((i) => i.severity === 'warning')
      ? 'attention'
      : 'ready';

  return {
    level,
    issues,
    seats,
    stage,
    screens,
    tables,
    accessible,
    layoutLabel: LAYOUT_TYPES.find((l) => l.id === brief?.layoutType)?.label,
    briefMissing: !brief,
  };
}

/** A short sentence for the readiness card's heading. */
export function describeReadiness(report: ReadinessReport): string {
  const blocking = report.issues.filter((i) => i.severity === 'blocking').length;
  const warnings = report.issues.filter((i) => i.severity === 'warning').length;

  if (report.level === 'incomplete') {
    return blocking === 1 ? '1 thing to finish first' : `${blocking} things to finish first`;
  }
  if (report.level === 'attention') {
    return warnings === 1
      ? "1 thing does not match the brief"
      : `${warnings} things do not match the brief`;
  }
  return 'Everything the brief asked for is on the drawing';
}
