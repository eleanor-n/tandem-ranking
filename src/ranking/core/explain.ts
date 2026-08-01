/**
 * The explanation layer — framework §5.
 *
 * At beta liquidity, ranking four cards barely matters. Making the card's
 * reason line TRUE matters enormously.
 *
 * Two hard rules, both enforced structurally rather than by good intentions:
 *
 *   1. Only claims provable from data. Every template below is built from a
 *      value the caller can point at — a shared onboarding answer, a stored
 *      explicit statement, a distance, a bucket overlap. Nothing is inferred,
 *      nothing is embellished, and when nothing clears the bar the card falls
 *      back to the existing canned category line rather than inventing.
 *
 *   2. No numbers that rank people. Distances are fine — a distance is a fact
 *      about the world. Scores, probabilities and compatibility percentages are
 *      not, and none of them can reach this module's output: `Reason.strength`
 *      exists for tie-breaking and is stripped before the UI type.
 */

import { CONSTANTS } from './constants.js';
import { explicitMetrics } from './features.js';
import { rankedMetrics } from './interest.js';
import type {
  Candidate,
  FeatureVector,
  InterestState,
  Reason,
  ReasonKind,
  Viewer,
} from './types.js';

/** Human-facing label for a metric or category slug. */
function label(slug: string): string {
  return slug.replace(/_/g, ' ');
}

/** Distance phrasing. Under half a mile we stop quoting numbers and say walkable. */
function distancePhrase(miles: number): string {
  if (miles <= CONSTANTS.explain.walkableMiles) return 'a few minutes away';
  if (miles < CONSTANTS.explain.wholeMilesAbove) return `${miles.toFixed(1)} miles away`;
  return `${Math.round(miles)} miles away`;
}

/**
 * Every reason the data can currently support, with the strength that earned
 * it. Strength is on a comparable scale across kinds — each is the underlying
 * feature value or contribution, all of which live in [0, 1].
 */
export function candidateReasons(
  viewer: Viewer,
  candidate: Candidate,
  features: FeatureVector,
  state: InterestState,
): Reason[] {
  const out: Reason[] = [];

  // --- shared onboarding answer -------------------------------------------
  // The most checkable claim available: the user typed this themselves and can
  // verify it in two taps.
  const stated = explicitMetrics(viewer);
  const shared = candidate.metrics.find((m) => stated.has(m));
  if (shared && candidate.host.idealSaturday?.length) {
    // Only claim mutuality if the host actually said it too.
    const hostStated = new Set(candidate.host.idealSaturday);
    if (hostStated.has(shared) || candidate.metrics.some((m) => hostStated.has(m))) {
      out.push({
        kind: 'ideal_saturday',
        text: `you both put ${label(shared)} in your ideal saturday.`,
        strength: 1,
        vars: { thing: label(shared) },
      });
    }
  }

  // --- explicit statement --------------------------------------------------
  // The user directly told us. Rank it high: acting visibly on a stated
  // preference is what makes stating one feel worth doing.
  for (const metric of candidate.metrics) {
    const m = state.metrics[metric];
    const fromStatement = m?.topContributors.some(
      (c) => c.source === 'explicit_statement' && c.contribution > 0,
    );
    if (fromStatement) {
      out.push({
        kind: 'explicit_interest',
        text: `you told us you're into ${label(metric)}.`,
        strength: m ? m.interest : 0,
        vars: { metric: label(metric) },
      });
      break;
    }
  }

  // --- behavioural affinity ------------------------------------------------
  // "You keep saying yes to X" is only honest if there is actually a pattern,
  // so it requires more than one behavioural event behind it.
  const top = rankedMetrics(state)[0];
  if (top && candidate.metrics.includes(top.metric)) {
    const behavioural = top.topContributors.filter(
      (c) => c.source !== 'onboarding' && c.source !== 'explicit_statement',
    ).length;
    if (behavioural >= 2) {
      out.push({
        kind: 'behavioral_affinity',
        text: `you keep saying yes to ${label(top.metric)}.`,
        strength: features.categoryAffinity,
        vars: { category: label(top.metric) },
      });
    }
  }

  // --- intent match --------------------------------------------------------
  // Two variants, and the difference matters. The post's SHAPE matching the
  // viewer's intent is a one-sided fact and gets one-sided copy. "You're both
  // here for X" is a claim about the host, and may only be made when the host
  // actually answered the question the same way.
  if (viewer.tandemIntent && features.intentMatch >= CONSTANTS.features.intentMatch.exact) {
    const mutual = candidate.host.tandemIntent === viewer.tandemIntent;
    out.push({
      kind: 'intent_match',
      text: mutual
        ? `you're both here for ${label(viewer.tandemIntent)}.`
        : `${label(viewer.tandemIntent)} — which is what you said you came for.`,
      strength: features.intentMatch,
      vars: { intent: label(viewer.tandemIntent), mutual: String(mutual) },
    });
  }

  // --- proximity -----------------------------------------------------------
  out.push({
    kind: 'proximity',
    text: `${distancePhrase(candidate.distanceMiles)}. basically no excuse.`,
    strength: features.proximity,
    vars: { distance: distancePhrase(candidate.distanceMiles) },
  });

  // --- rhythm --------------------------------------------------------------
  // Requires real history on both sides; the thin-data default must not be
  // allowed to masquerade as an observation.
  if (
    viewer.activeBuckets.length > 0 &&
    candidate.host.activeBuckets.length > 0 &&
    features.rhythmOverlap > CONSTANTS.features.thinDataDefault
  ) {
    out.push({
      kind: 'rhythm',
      text: `you're both usually out around this time.`,
      strength: features.rhythmOverlap,
      vars: {},
    });
  }

  // --- fresh host ----------------------------------------------------------
  if (candidate.host.neverShownToViewer) {
    out.push({
      kind: 'fresh_host',
      text: `new face round here.`,
      strength: 0.5,
      vars: {},
    });
  }

  return out;
}

/**
 * The canned per-category line. This is what the card said before v1.5 and it
 * remains the floor: a true generic sentence beats a specific one we cannot
 * back up.
 */
export function fallbackReason(candidate: Candidate): Reason {
  return {
    kind: 'category_fallback',
    text: `${label(candidate.category)}, nearby.`,
    strength: 0,
    vars: { category: label(candidate.category) },
  };
}

/**
 * Pick the one line the card shows.
 *
 * Threshold first, then priority, then strength. Priority beats strength on
 * purpose: a shared onboarding answer at strength 0.6 is a better thing to say
 * than a proximity line at 0.9, because the user can check it and it is about
 * the two of them rather than about geography.
 */
export function selectReason(
  viewer: Viewer,
  candidate: Candidate,
  features: FeatureVector,
  state: InterestState,
): Reason {
  const eligible = candidateReasons(viewer, candidate, features, state)
    .filter((r) => r.strength >= CONSTANTS.explain.minStrength);

  if (eligible.length === 0) return fallbackReason(candidate);

  const priority = CONSTANTS.explain.priority as readonly ReasonKind[];
  const rankOf = (k: ReasonKind) => {
    const i = priority.indexOf(k);
    return i === -1 ? priority.length : i;
  };

  return eligible.sort(
    (a, b) => rankOf(a.kind) - rankOf(b.kind) || b.strength - a.strength,
  )[0] as Reason;
}
