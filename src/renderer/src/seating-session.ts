/**
 * Persist last seating planner request so reopening the overlay does not reset mid-job.
 * Keyed by plan path when available.
 */

const STORAGE_PREFIX = 'groundplan.seating-session.v1:';

export type SeatingSessionSnapshot = {
  style?: string;
  chair?: string;
  table?: string;
  seatsPerTable?: number;
  optimum?: boolean;
  crescent?: boolean;
  placementMode?: 'replace' | 'add';
  splay?: number;
  tablesAcross?: number;
  sectionCentre?: number;
  sectionWing?: number;
  stagger?: boolean;
  stampMode?: 'fill' | 'stamp' | 'piece';
  stampKind?: 'round' | 'theatre' | 'schoolroom';
  stampRows?: number;
  stampPerRow?: number;
  stampAngle?: number;
  stampCount?: number;
  stampGridColumns?: number;
  stampGridRows?: number;
  stampTableSpacing?: number;
};

export function loadSeatingSession(planPath: string | null | undefined): SeatingSessionSnapshot | null {
  if (!planPath || typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + planPath);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SeatingSessionSnapshot;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function saveSeatingSession(
  planPath: string | null | undefined,
  snapshot: SeatingSessionSnapshot,
): void {
  if (!planPath || typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_PREFIX + planPath, JSON.stringify(snapshot));
  } catch {
    /* quota / private mode */
  }
}
