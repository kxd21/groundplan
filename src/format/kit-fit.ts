/**
 * Which layout kit suits this show?
 *
 * The old answer was `suggestKitForRoom`: bucket the room's area, then find a
 * kit whose NAME matched a regular expression — `/banquet/i`, `/arena|concert/i`,
 * and a fallback of `/card.?party/i`. That is guessing from a filename. A kit
 * called "Card Party South Florida" is a 2,234-seat theatre bank whatever its
 * name suggests, a user's own kit called "Tuesday" matches nothing at all, and
 * a room's area says nothing about whether the show wanted rounds or rows.
 *
 * This scores each kit against what the brief actually asked for and what the
 * room can actually hold, and says why it chose.
 */

import type { LayoutType, ShowBrief } from './show-brief.js';

/** The kit facts a recommendation needs. Mirrors `LayoutKitInfo`. */
export interface KitCandidate {
  id: string;
  name: string;
  source: 'bundled' | 'user';
  chairs: number;
  seatingKinds?: Array<'theatre' | 'schoolroom' | 'round'>;
  hasStage?: boolean;
  capacityGuests?: number;
  extentFt?: { width: number; depth: number };
}

export interface KitSuggestion {
  kitId: string;
  /** Why this one, in a phrase the panel can show. */
  reason: string;
  /** 0..1, for ordering. Not shown. */
  score: number;
  /** True when the kit will not physically fit the room as drawn. */
  oversize: boolean;
}

/** Seating kinds a requested layout implies. */
function kindsFor(layout: LayoutType | undefined): Array<'theatre' | 'schoolroom' | 'round'> {
  switch (layout) {
    case 'banquet':
      return ['round'];
    case 'classroom':
      return ['schoolroom'];
    case 'theatre':
    case 'general-session':
      return ['theatre'];
    // A trade show is booths rather than seating, and a custom layout has said
    // nothing, so neither constrains the seating kind.
    default:
      return [];
  }
}

/**
 * Seats a kit really provides.
 *
 * `capacityGuests` is what a variant kit declares; `chairs` is what it actually
 * places. Prefer the declaration when there is one, because a banquet kit's
 * chair count and its guest count are the same number, while a kit built for a
 * room with a head table is not.
 */
function seatsOf(kit: KitCandidate): number {
  return kit.capacityGuests ?? kit.chairs;
}

/**
 * Picks a kit for a brief and a room.
 *
 * Every term is a fraction so no single one can dominate; capacity is weighted
 * hardest because a layout that seats the wrong number of people is wrong in
 * the way that matters first.
 *
 * Returns null rather than a shrug when there is nothing to go on — no kits, or
 * neither a headcount nor a room to fit against. A recommendation nobody can
 * justify is worse than none, because it will be trusted.
 */
export function suggestKit(
  kits: KitCandidate[],
  brief: ShowBrief | null,
  room?: { widthFt?: number; depthFt?: number },
): KitSuggestion | null {
  if (!kits.length) return null;

  const target = brief?.targetAttendance;
  const wantedKinds = kindsFor(brief?.layoutType);
  const wantsStage = brief?.stageRequired === true;
  const roomW = room?.widthFt ?? 0;
  const roomD = room?.depthFt ?? 0;
  const haveRoom = roomW > 0 && roomD > 0;

  if (!target && !wantedKinds.length && !wantsStage && !haveRoom) return null;

  let best: (KitSuggestion & { kit: KitCandidate }) | null = null;

  for (const kit of kits) {
    const seats = seatsOf(kit);
    const reasons: string[] = [];
    let score = 0;
    let weight = 0;

    /* Capacity — the heaviest term. -------------------------------------- */
    if (target && seats > 0) {
      const ratio = seats / target;
      // Full credit between the target and 25% over it; a kit that seats fewer
      // than asked is penalised in proportion to the shortfall, and one that
      // massively overshoots is penalised for wasting the room.
      const fit =
        ratio >= 1 && ratio <= 1.25
          ? 1
          : ratio < 1
            ? Math.max(0, ratio)
            : Math.max(0, 1 - (ratio - 1.25) / 2);
      score += fit * 3;
      weight += 3;
      if (fit >= 0.95) reasons.push(`seats ${seats.toLocaleString()} for ${target.toLocaleString()}`);
      else if (ratio < 1) reasons.push(`seats ${seats.toLocaleString()}, short of ${target.toLocaleString()}`);
      else reasons.push(`seats ${seats.toLocaleString()}, more than needed`);
    }

    /* Layout kind. -------------------------------------------------------- */
    if (wantedKinds.length && kit.seatingKinds?.length) {
      const matches = kit.seatingKinds.some((k) => wantedKinds.includes(k));
      score += matches ? 2 : 0;
      weight += 2;
      if (matches) {
        reasons.push(
          wantedKinds[0] === 'round'
            ? 'builds rounds'
            : wantedKinds[0] === 'schoolroom'
              ? 'builds classroom rows'
              : 'builds theatre rows',
        );
      }
    }

    /* Stage. -------------------------------------------------------------- */
    if (wantsStage) {
      score += kit.hasStage ? 1 : 0;
      weight += 1;
      if (kit.hasStage) reasons.push('includes a stage');
    }

    /* Does it fit the room as drawn? -------------------------------------- */
    let oversize = false;
    if (haveRoom && kit.extentFt) {
      // Allow either orientation: a kit is a layout, not a fixed object.
      const fitsAsIs = kit.extentFt.width <= roomW && kit.extentFt.depth <= roomD;
      const fitsTurned = kit.extentFt.depth <= roomW && kit.extentFt.width <= roomD;
      oversize = !fitsAsIs && !fitsTurned;
      score += oversize ? 0 : 1;
      weight += 1;
      if (oversize) reasons.push('larger than this room');
    }

    if (!weight) continue;
    const normalised = score / weight;
    const suggestion = {
      kit,
      kitId: kit.id,
      score: normalised,
      oversize,
      reason: reasons.join(' · '),
    };

    if (
      !best ||
      suggestion.score > best.score ||
      // Tie-break toward the smaller kit: over-seating a room is easier to
      // notice and cheaper to fix than discovering it on site.
      (suggestion.score === best.score && seatsOf(kit) < seatsOf(best.kit))
    ) {
      best = suggestion;
    }
  }

  if (!best) return null;
  return { kitId: best.kitId, reason: best.reason, score: best.score, oversize: best.oversize };
}
