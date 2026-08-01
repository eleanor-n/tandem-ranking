/**
 * Demand balancing and exhaustion — v1.6 §2 and §3.
 *
 * Both are multipliers on S, and both exist because a greedy per-viewer ranker
 * has two blind spots that only matter at low density:
 *
 *   §2 It cannot see the other viewers. Every client independently ranking
 *      "best card for me" produces a deck where the same three popular posts
 *      fill up and everything else gets nobody. At 40 users the right objective
 *      is a global assignment — every post gets at least one joiner — and this
 *      is the decentralised approximation of it: a shared demand signal that
 *      makes independent greedy clients collectively behave like an assignment.
 *
 *   §3 It cannot see that you have already met these people. Nothing in v1.5
 *      models a user who has done coffee with their four nearest neighbours and
 *      is bored. This is a large part of why a pure proximity baseline looked so
 *      strong in the v1.5 simulator: nothing ever punished it for showing the
 *      same faces forever.
 *
 * Neither knows the regime exists. Both take resolved parameters, and both
 * become no-ops as those parameters go to zero — which is what makes this one
 * algorithm rather than two.
 */

import type {
  Candidate,
  Epoch,
  ResolvedParams,
  Unit,
  Viewer,
} from './types.js';
import { CONSTANTS } from './constants.js';

const MS_PER_DAY = 86_400_000;

export interface DemandAdjustment {
  /** The combined multiplier applied to S. */
  multiplier: number;
  urgency: Unit;
  overflow: Unit;
  exhaustion: Unit;
}

/** Used when a caller scores without demand context — every term inert. */
export const NEUTRAL_DEMAND: DemandAdjustment = {
  multiplier: 1,
  urgency: 0,
  overflow: 0,
  exhaustion: 0,
};

// ---------------------------------------------------------------------------
// §2 Demand balancing
// ---------------------------------------------------------------------------

/**
 * How full a post is. `targetJoiners` defaults to 1 — a tandem is two people, so
 * one joiner fills it.
 *
 * Returns null when the joiner count is unknown, which is different from zero.
 * An unknown count must not read as "nobody has joined, boost it hard": that
 * would systematically favour posts whose data failed to load.
 */
export function fillRatio(candidate: Candidate): number | null {
  if (candidate.confirmedJoiners === undefined) return null;
  const target = Math.max(1, candidate.targetJoiners ?? CONSTANTS.demand.defaultTargetJoiners);
  return Math.max(0, candidate.confirmedJoiners) / target;
}

/**
 * How soon this post needs someone. A tandem tomorrow with nobody signed up is
 * maximally urgent; one three weeks out has time to fill itself.
 *
 * Floored rather than zeroed at the far end: a post a month away with no joiners
 * still deserves some help, just not much.
 */
export function timePressure(candidate: Candidate, now: Epoch): Unit {
  const daysUntil = (candidate.startsAt - now) / MS_PER_DAY;
  const raw = 1 - daysUntil / CONSTANTS.demand.timePressureHorizonDays;
  return clamp(raw, CONSTANTS.demand.timePressureFloor, 1);
}

/**
 * urgency = (1 - min(fillRatio, 1)) x timePressure
 *
 * Zero for a post that is already full, and zero for one that is far away in
 * time. Maximal for the empty-and-imminent case, which is exactly the post that
 * is about to teach a host that this app does not work.
 */
export function urgency(candidate: Candidate, now: Epoch): Unit {
  const fill = fillRatio(candidate);
  // Unknown joiner count -> no urgency claim. See fillRatio().
  if (fill === null) return 0;
  return (1 - Math.min(fill, 1)) * timePressure(candidate, now);
}

/** How over-subscribed a post is, in [0, 1]. Zero until it is actually full. */
export function overflow(candidate: Candidate): Unit {
  const fill = fillRatio(candidate);
  if (fill === null) return 0;
  return clamp(fill - 1, 0, 1);
}

// ---------------------------------------------------------------------------
// §3 Exhaustion
// ---------------------------------------------------------------------------

/**
 * How much this viewer has already had of this host.
 *
 *   exhaustion = 1 - exp(-rate x completedTogether)
 *
 * Saturating, so the tenth tandem together does not read as ten times the
 * fatigue of the first. `rate` moves with density: higher at village scale,
 * where the pool of people is small and running out of new faces is the failure
 * mode.
 */
export function exhaustion(
  candidate: Candidate,
  params: ResolvedParams,
): Unit {
  const together = Math.max(0, candidate.completedTogether ?? 0);
  if (together === 0) return 0;
  return 1 - Math.exp(-params.exhaustionRate * together);
}

/**
 * Whether the viewer WANTS more of this host, from the post-tandem check-in.
 *
 *   checkin_yes -> high, checkin_no -> low, unknown -> 0.5
 *
 * This is the only thing in the entire system that can tell repeat-seeking apart
 * from variety-seeking. Two tandems with someone you said yes to should barely
 * suppress; two with someone you said nothing about should suppress noticeably;
 * a `checkin_no` should suppress hard.
 *
 * KNOWN TEMPORARY WEAKNESS: check-in data does not exist yet, so in production
 * today this returns the neutral 0.5 for every pairing and exhaustion acts as a
 * uniform damper on all repeats — including the good ones, which are the north
 * star. That is a gap waiting on data, not a design choice. See INFERENCES.md.
 */
export function repeatAffinity(candidate: Candidate): Unit {
  const a = candidate.repeatAffinity;
  if (a === undefined || Number.isNaN(a)) return CONSTANTS.demand.unknownRepeatAffinity;
  return clamp(a, 0, 1);
}

// ---------------------------------------------------------------------------

/**
 * The whole adjustment:
 *
 *   S_final = S x (1 + delta x urgency)
 *               x (1 - sigma x overflow)
 *               x (1 - exhaustion x (1 - repeatAffinity))
 *
 * Note the exhaustion term is gated by repeatAffinity, not merely added to it.
 * A host you have enthusiastically said yes to twice has repeatAffinity near 1,
 * so `(1 - repeatAffinity)` is near 0 and the suppression vanishes entirely —
 * which it must, because becoming a habit with someone is the point.
 *
 * Every factor is >= 0 and the product is clamped at a floor rather than being
 * allowed to reach zero, because the score ORDERS and never filters. A card
 * multiplied to exactly zero would be indistinguishable from an ineligible one
 * and would sort arbitrarily against its equally-zero peers.
 */
export function demandAdjustment(
  _viewer: Viewer,
  candidate: Candidate,
  now: Epoch,
  params: ResolvedParams,
): DemandAdjustment {
  const u = urgency(candidate, now);
  const o = overflow(candidate);
  const e = exhaustion(candidate, params);
  const want = repeatAffinity(candidate);

  const multiplier = Math.max(
    CONSTANTS.demand.multiplierFloor,
    (1 + params.demandWeight * u) *
      (1 - params.overflowPenalty * o) *
      (1 - e * (1 - want)),
  );

  return { multiplier, urgency: u, overflow: o, exhaustion: e };
}

function clamp(x: number, lo: number, hi: number): number {
  if (Number.isNaN(x)) return lo;
  return x < lo ? lo : x > hi ? hi : x;
}
