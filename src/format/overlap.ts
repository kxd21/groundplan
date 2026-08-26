/**
 * Two things in the same place.
 *
 * A floor plan is a claim about physical space, so two objects sharing it is
 * either deliberate — a laptop on a table, a chair on a riser, a truss over a
 * stage — or a mistake nobody notices until the crew is standing in the room
 * holding something that will not fit. The drawing looks identical either way.
 *
 * This says when it has happened and what the three honest answers are: it goes
 * on top, it goes underneath, or it goes next to. Nothing here decides which;
 * only the person who knows what the objects are can do that, and being asked
 * once beats discovering it on site.
 *
 * Deliberately axis-aligned. Rotated furniture has a tighter true footprint
 * than its bounding box, so this over-reports rather than under-reports, and a
 * question that is occasionally unnecessary is cheaper than a collision that is
 * never raised. The `fraction` is what keeps that tolerable — see below.
 */

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface OverlapCandidate extends Box {
  id: number;
  name: string;
}

export interface Overlap {
  id: number;
  name: string;
  /** Shared area in square logical units. */
  area: number;
  /**
   * How much of the SMALLER object is buried, 0..1.
   *
   * Of the two, the smaller one is the one whose placement is in question: a
   * chair 90% inside a table is a real stack whichever was drawn first, while
   * the same area shared between two seating banks is a nudge. Measuring
   * against the smaller object is what makes one threshold work for a laptop
   * and for a 2,000-seat bank.
   */
  fraction: number;
}

const area = (b: Box): number => Math.max(0, b.maxX - b.minX) * Math.max(0, b.maxY - b.minY);

/** The shared rectangle, or null when they only touch or miss. */
export function intersection(a: Box, b: Box): Box | null {
  const minX = Math.max(a.minX, b.minX);
  const maxX = Math.min(a.maxX, b.maxX);
  const minY = Math.max(a.minY, b.minY);
  const maxY = Math.min(a.maxY, b.maxY);
  // Strictly greater: two objects sharing an edge are next to each other, which
  // is what a tidy plan looks like, not what a collision looks like.
  if (!(maxX > minX) || !(maxY > minY)) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * What the subject is sitting in.
 *
 * `minFraction` defaults to a tenth of the smaller object. Below that the
 * objects are touching or barely clipping — routine in a tight room, and not
 * worth interrupting anybody over.
 */
export function findOverlaps(
  subject: Box,
  others: OverlapCandidate[],
  minFraction = 0.1,
): Overlap[] {
  const subjectArea = area(subject);
  if (!(subjectArea > 0)) return [];

  const found: Overlap[] = [];
  for (const other of others) {
    const shared = intersection(subject, other);
    if (!shared) continue;
    const smaller = Math.min(subjectArea, area(other));
    if (!(smaller > 0)) continue;
    const sharedArea = area(shared);
    const fraction = sharedArea / smaller;
    if (fraction < minFraction) continue;
    found.push({ id: other.id, name: other.name, area: sharedArea, fraction });
  }
  // Deepest first: the thing most buried is the one being asked about.
  return found.sort((a, b) => b.fraction - a.fraction || b.area - a.area);
}

export interface Nudge {
  dx: number;
  dy: number;
  /** Which way it went, for the sentence shown to the user. */
  direction: 'left' | 'right' | 'up' | 'down';
}

/**
 * The shortest move that puts the subject beside everything it is inside.
 *
 * Tries all four directions and takes the smallest, so an object half over a
 * table's left edge slides left rather than travelling across it. `gap` is
 * added so the result is next to the blocker rather than exactly touching it —
 * a plan where two footprints share an edge reads as a collision to the next
 * person, even though it measures as clear.
 *
 * Returns null when nothing clears, which happens when the subject is boxed in
 * on all four sides. Silence is the right answer there: the tool cannot know
 * which neighbour is the one to disturb.
 */
export function besidePosition(
  subject: Box,
  blockers: Box[],
  gap = 0,
  limit?: Box,
): Nudge | null {
  if (!blockers.length) return null;

  const width = subject.maxX - subject.minX;
  const height = subject.maxY - subject.minY;

  const options: Nudge[] = [];
  for (const blocker of blockers) {
    options.push({ dx: blocker.minX - gap - subject.maxX, dy: 0, direction: 'left' });
    options.push({ dx: blocker.maxX + gap - subject.minX, dy: 0, direction: 'right' });
    options.push({ dx: 0, dy: blocker.minY - gap - subject.maxY, direction: 'down' });
    options.push({ dx: 0, dy: blocker.maxY + gap - subject.minY, direction: 'up' });
  }

  const moved = (n: Nudge): Box => ({
    minX: subject.minX + n.dx,
    maxX: subject.maxX + n.dx,
    minY: subject.minY + n.dy,
    maxY: subject.maxY + n.dy,
  });

  const clears = (n: Nudge): boolean => {
    const box = moved(n);
    if (limit) {
      // Sliding an object through a wall to avoid a table is not a fix.
      if (box.minX < limit.minX || box.maxX > limit.maxX) return false;
      if (box.minY < limit.minY || box.maxY > limit.maxY) return false;
    }
    return blockers.every((b) => intersection(box, b) === null);
  };

  const viable = options
    .filter((n) => Math.hypot(n.dx, n.dy) > 0)
    .filter(clears)
    .sort((a, b) => Math.hypot(a.dx, a.dy) - Math.hypot(b.dx, b.dy));

  const best = viable[0];
  if (!best) return null;
  // A move longer than the object itself is not "beside" in any useful sense;
  // it is throwing the object somewhere else on the plan.
  if (Math.hypot(best.dx, best.dy) > Math.max(width, height) * 3) return null;
  return best;
}

/** One line naming what the subject landed in. */
export function describeOverlap(overlaps: Overlap[]): string {
  if (!overlaps.length) return '';
  const [first] = overlaps;
  const deep = Math.round(first!.fraction * 100);
  if (overlaps.length === 1) return `Overlaps ${first!.name} (${deep}%)`;
  return `Overlaps ${first!.name} and ${overlaps.length - 1} other${overlaps.length === 2 ? '' : 's'}`;
}
