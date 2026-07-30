/**
 * Screens, projectors, and whether anyone can actually see them.
 *
 * The format has nowhere to record that this projector feeds that screen, so a
 * plan can show both and be silently wrong: the throw is short, the lens is
 * wrong, the front rows are inside the cone, or a drape line crosses it. All of
 * that is checkable arithmetic, and none of it was being checked.
 *
 * Two jobs here. **Pairing** works out where a projector has to stand for a
 * given image, and whether the lens on the truck will do it. **Sightlines**
 * take the seating solution and the placed items — with the heights and
 * obstruction the definition layer gives them — and report which seats cannot
 * see the screen and why.
 *
 * The viewing-distance rules are the trade's: no closer than twice the image
 * height, no further than six times for detailed content or eight for video,
 * and no more than 45 degrees off the centreline. They are guidance, stated as
 * guidance, not a standard anyone certifies against.
 */

import { aspectValue, screenFromWidth, type AspectRatio, type PlacedItem } from './definition.js';
import type { SeatPosition } from './seating-plan.js';
import { UNITS_PER_FOOT, type Point } from './rv.js';

const FT = UNITS_PER_FOOT;

export interface Screen {
  id: string;
  /** Centre of the image surface, on the floor plan. */
  x: number;
  y: number;
  /** Direction the image faces, in radians. */
  facing: number;
  /** Image width in logical units. */
  imageWidth: number;
  aspect: AspectRatio;
  /** Bottom of the image above the floor. */
  bottomHeight: number;
  label?: string;
}

export interface Projector {
  id: string;
  x: number;
  y: number;
  /** Lens throw ratio range: distance divided by image width. */
  throwMin: number;
  throwMax: number;
  /** Lumens, for the brightness check. */
  lumens?: number;
  /** Height above the floor. */
  height: number;
  label?: string;
}

/** Image height that follows from the width and the ratio. */
export function imageHeight(screen: Screen): number {
  return screenFromWidth(screen.imageWidth, screen.aspect).height;
}

/** Top of the image above the floor. */
export function imageTop(screen: Screen): number {
  return screen.bottomHeight + imageHeight(screen);
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

export interface Pairing {
  screenId: string;
  projectorId: string;
  /** Floor distance from the projector to the screen. */
  distance: number;
  /** The ratio that distance and image width imply. */
  throwRatio: number;
  ok: boolean;
  /** Everything wrong with this pairing, in plain words. */
  problems: string[];
  /** Where the projector would have to stand for its lens range. */
  workingRange: { min: number; max: number };
}

/**
 * Checks a projector against a screen.
 *
 * The single most common mistake this catches is a projector placed where the
 * room has space rather than where its lens reaches — a 1.8:1 lens on a 16 ft
 * image needs 28.8 ft, and no amount of rigging fixes 20.
 */
export function pairScreen(screen: Screen, projector: Projector): Pairing {
  const distance = Math.hypot(screen.x - projector.x, screen.y - projector.y);
  const throwRatio = screen.imageWidth > 0 ? distance / screen.imageWidth : Infinity;
  const problems: string[] = [];

  const workingRange = {
    min: projector.throwMin * screen.imageWidth,
    max: projector.throwMax * screen.imageWidth,
  };

  if (throwRatio < projector.throwMin) {
    problems.push(
      `Too close: ${(distance / FT).toFixed(1)} ft gives a ${throwRatio.toFixed(2)}:1 throw, ` +
        `and this lens starts at ${projector.throwMin.toFixed(2)}:1 ` +
        `(${(workingRange.min / FT).toFixed(1)} ft for a ${(screen.imageWidth / FT).toFixed(0)} ft image).`,
    );
  } else if (throwRatio > projector.throwMax) {
    problems.push(
      `Too far: ${(distance / FT).toFixed(1)} ft gives a ${throwRatio.toFixed(2)}:1 throw, ` +
        `and this lens stops at ${projector.throwMax.toFixed(2)}:1 ` +
        `(${(workingRange.max / FT).toFixed(1)} ft maximum).`,
    );
  }

  // Off-axis: the projector should be roughly square to the screen or the image
  // keystones beyond what corner correction can fix without cropping.
  const bearing = Math.atan2(projector.y - screen.y, projector.x - screen.x);
  let offAxis = bearing - screen.facing;
  while (offAxis > Math.PI) offAxis -= 2 * Math.PI;
  while (offAxis < -Math.PI) offAxis += 2 * Math.PI;
  const offAxisDegrees = Math.abs((offAxis * 180) / Math.PI);
  if (offAxisDegrees > 15) {
    problems.push(`The projector is ${offAxisDegrees.toFixed(0)} degrees off the screen centreline.`);
  }

  if (projector.lumens != null) {
    // About 50 lumens per square foot of image, which is what a ballroom with
    // the house lights up actually needs. The textbook 12 foot-lambert figure
    // assumes a darkened room and specs projectors far too small for this work.
    const squareFeet = (screen.imageWidth / FT) * (imageHeight(screen) / FT);
    const wanted = squareFeet * 50;
    if (projector.lumens < wanted) {
      problems.push(
        `${projector.lumens.toLocaleString('en-US')} lumens is dim for a ${Math.round(squareFeet)} sq ft image ` +
          `in ambient light — reckon on ${Math.round(wanted).toLocaleString('en-US')}.`,
      );
    }
  }

  return { screenId: screen.id, projectorId: projector.id, distance, throwRatio, ok: problems.length === 0, problems, workingRange };
}

/**
 * The floor area a projector's beam crosses.
 *
 * Drawn on the plan, this is what stops a truss, a chandelier or a camera
 * platform being put through the middle of the picture.
 */
export function projectionCone(screen: Screen, projector: Projector): Point[] {
  const half = screen.imageWidth / 2;
  const across = { x: Math.cos(screen.facing + Math.PI / 2), y: Math.sin(screen.facing + Math.PI / 2) };
  return [
    { x: projector.x, y: projector.y },
    { x: screen.x + across.x * half, y: screen.y + across.y * half },
    { x: screen.x - across.x * half, y: screen.y - across.y * half },
    { x: projector.x, y: projector.y },
  ];
}

/** Where a projector must stand, as a distance band along the screen's axis. */
export function throwPositions(screen: Screen, throwMin: number, throwMax: number): { near: Point; far: Point } {
  const back = { x: Math.cos(screen.facing), y: Math.sin(screen.facing) };
  const near = throwMin * screen.imageWidth;
  const far = throwMax * screen.imageWidth;
  return {
    near: { x: screen.x + back.x * near, y: screen.y + back.y * near },
    far: { x: screen.x + back.x * far, y: screen.y + back.y * far },
  };
}

// ---------------------------------------------------------------------------
// Sightlines
// ---------------------------------------------------------------------------

export type SightlineVerdict = 'clear' | 'too-close' | 'too-far' | 'off-axis' | 'blocked';

export interface SeatView {
  seat: SeatPosition;
  verdict: SightlineVerdict;
  /** Distance to the screen, in image heights — the number the rules use. */
  imageHeights: number;
  /** Degrees off the screen centreline. */
  offAxis: number;
  /** What is in the way, when the verdict is `blocked`. */
  blockedBy?: string;
}

export interface SightlineOptions {
  /** Eye height of a seated viewer. */
  eyeHeight?: number;
  /** Furthest acceptable distance, in image heights. */
  maxImageHeights?: number;
  /** Closest acceptable distance, in image heights. */
  minImageHeights?: number;
  /** Widest acceptable angle off the centreline, in degrees. */
  maxOffAxis?: number;
}

/** A seated adult's eye, about 4 ft off the floor. */
const DEFAULT_EYE = 48 * 10;

/**
 * Does the line from an eye to the bottom of the image clear an obstacle?
 *
 * Only the bottom edge matters: anything that blocks it crops the picture, and
 * anything that clears it leaves the whole image visible.
 */
function blockedBy(
  from: Point,
  eye: number,
  screen: Screen,
  obstacles: PlacedItem[],
): PlacedItem | null {
  const target = { x: screen.x, y: screen.y };
  const bottom = screen.bottomHeight;
  const span = Math.hypot(target.x - from.x, target.y - from.y);
  if (span < 1e-6) return null;

  for (const item of obstacles) {
    if (item.obstruction === 'none') continue;
    if (item.top <= eye && item.top <= bottom) continue;

    // Where along the sightline does this item sit?
    const t =
      ((item.x - from.x) * (target.x - from.x) + (item.y - from.y) * (target.y - from.y)) / (span * span);
    if (t <= 0.02 || t >= 0.98) continue;

    const closest = { x: from.x + (target.x - from.x) * t, y: from.y + (target.y - from.y) * t };
    const across = Math.hypot(item.x - closest.x, item.y - closest.y);
    // Half the item's smaller dimension, as a rough radius.
    const radius = Math.max(item.width, item.depth) / 2;
    if (across > radius) continue;

    // Height of the sightline where it passes the item.
    const lineHeight = eye + (bottom - eye) * t;
    if (item.top > lineHeight) return item;
  }

  return null;
}

/**
 * Grades every seat against a screen.
 *
 * The blocking test uses the heights and obstruction flags from the definition
 * layer, which is the whole reason that layer exists: without it, every object
 * is a footprint on the floor and no sightline question can be asked at all.
 */
export function checkSightlines(
  seats: SeatPosition[],
  screen: Screen,
  obstacles: PlacedItem[] = [],
  options: SightlineOptions = {},
): SeatView[] {
  const eye = options.eyeHeight ?? DEFAULT_EYE;
  const maxHeights = options.maxImageHeights ?? 6;
  const minHeights = options.minImageHeights ?? 2;
  const maxOffAxis = options.maxOffAxis ?? 45;
  const height = imageHeight(screen);

  return seats.map((seat) => {
    const distance = Math.hypot(seat.x - screen.x, seat.y - screen.y);
    const imageHeights = height > 0 ? distance / height : Infinity;

    let offAxis = Math.atan2(seat.y - screen.y, seat.x - screen.x) - screen.facing;
    while (offAxis > Math.PI) offAxis -= 2 * Math.PI;
    while (offAxis < -Math.PI) offAxis += 2 * Math.PI;
    const offAxisDegrees = Math.abs((offAxis * 180) / Math.PI);

    const base = { seat, imageHeights, offAxis: offAxisDegrees };

    const blocker = blockedBy({ x: seat.x, y: seat.y }, eye, screen, obstacles);
    if (blocker) return { ...base, verdict: 'blocked' as const, blockedBy: blocker.name };
    if (imageHeights < minHeights) return { ...base, verdict: 'too-close' as const };
    if (imageHeights > maxHeights) return { ...base, verdict: 'too-far' as const };
    if (offAxisDegrees > maxOffAxis) return { ...base, verdict: 'off-axis' as const };
    return { ...base, verdict: 'clear' as const };
  });
}

export interface SightlineSummary {
  total: number;
  clear: number;
  tooClose: number;
  tooFar: number;
  offAxis: number;
  blocked: number;
  /** Plain-language lines for the report. */
  notes: string[];
}

/** Totals a sightline check, in the form that goes on a report. */
export function summariseSightlines(views: SeatView[]): SightlineSummary {
  const count = (verdict: SightlineVerdict) => views.filter((v) => v.verdict === verdict).length;
  const summary: SightlineSummary = {
    total: views.length,
    clear: count('clear'),
    tooClose: count('too-close'),
    tooFar: count('too-far'),
    offAxis: count('off-axis'),
    blocked: count('blocked'),
    notes: [],
  };

  if (summary.tooFar) summary.notes.push(`${summary.tooFar} seats are further than six image heights — the text will be hard to read.`);
  if (summary.tooClose) summary.notes.push(`${summary.tooClose} seats are inside two image heights and will be craning.`);
  if (summary.offAxis) summary.notes.push(`${summary.offAxis} seats are more than 45 degrees off the screen.`);
  if (summary.blocked) {
    const culprits = [...new Set(views.filter((v) => v.verdict === 'blocked').map((v) => v.blockedBy))];
    summary.notes.push(`${summary.blocked} seats are blocked by ${culprits.filter(Boolean).join(', ')}.`);
  }
  if (!summary.notes.length && summary.total) summary.notes.push('Every seat has a clear view.');

  return summary;
}

/**
 * Finds the things the audience is meant to be looking at.
 *
 * Reads the `sightTarget` flag the shape editor sets, so a sightline study can
 * be run on a plan without anybody re-entering where the screens are. Items
 * with an aspect ratio and a height become screens at their drawn width;
 * anything else flagged as a target — a stage, a podium — is treated as a
 * surface of its own footprint.
 */
export function screensFromItems(items: PlacedItem[]): Screen[] {
  return items
    .filter((item) => item.spec.sightTarget)
    .map((item, index) => ({
      id: `target-${index}-${item.key}`,
      x: item.x,
      y: item.y,
      // A drawn item faces the way it was turned; zero rotation faces up the
      // page, which is down the room toward the audience.
      facing: ((item.rotation + 90) * Math.PI) / 180,
      imageWidth: item.width,
      aspect: item.aspect ?? { w: 16, h: 9 },
      bottomHeight: item.elevation,
      label: item.name,
    }));
}

/**
 * The image width that would serve the furthest seat.
 *
 * The question asked in reverse: rather than checking a screen, size one.
 */
export function recommendImageWidth(seats: SeatPosition[], screen: Pick<Screen, 'x' | 'y' | 'aspect'>, maxImageHeights = 6): number {
  if (!seats.length) return 0;
  const furthest = seats.reduce(
    (max, s) => Math.max(max, Math.hypot(s.x - screen.x, s.y - screen.y)),
    0,
  );
  const wantedHeight = furthest / maxImageHeights;
  return wantedHeight * aspectValue(screen.aspect);
}
