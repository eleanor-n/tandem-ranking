/**
 * Term classification — v1.8 §1.1.
 *
 * THE DEFECT THIS FILE EXISTS TO PREVENT.
 *
 * A ranker in a two-sided marketplace does two jobs:
 *
 *   RELEVANCE   which of these is best FOR THIS VIEWER      (per-viewer)
 *   ALLOCATION  who gets seen at all, across all viewers    (population-level)
 *
 * A product of per-viewer scores can only do the first. Any factor in that
 * product whose value does not depend on the viewer performs allocation as an
 * invisible side effect — every client independently sorts the same items
 * upward, because every client was handed the same preference order. Nobody
 * decided to do that. It falls out of the arithmetic.
 *
 * v1.7 §D3 measured it: `P_accept`, `P_complete` and `repeatableContext` are
 * viewer-independent, and the ranker carrying them reached a host-attention
 * Gini of 0.931 while losing to `random` on host retention. Removing them
 * RAISED deck relevance (0.094 -> 0.128), which is the part that settles it.
 * It was never a fairness-versus-relevance tradeoff. The terms were displacing
 * cards the viewer wanted AND concentrating attention, both at once.
 *
 * ---------------------------------------------------------------------------
 * Where it came from
 *
 * The funnel is borrowed from dating-app ranking, where `P_accept` is genuinely
 * two-sided: does THIS person accept YOU. In Tandem it collapsed to
 * `hostReliability` — one global scalar per host — while keeping the
 * architecture that two-sidedness had justified. What was left is a popularity
 * multiplier wearing a two-sided model's clothes.
 *
 * So the repair is not deletion. It is restoring the viewer-dependence that
 * made the term valid, and reclassifying what genuinely cannot be made
 * viewer-dependent.
 *
 * ---------------------------------------------------------------------------
 * The distinction that matters, and why "no global multipliers" is too blunt
 *
 * `exposureBoost` and the demand terms are also viewer-independent. They are
 * fine — they are the allocation job done ON PURPOSE, by terms whose entire
 * content is population state (how many impressions has this had, how full is
 * it). Banning them would ban the only machinery that pushes back on
 * concentration.
 *
 * The rule is therefore not "no global multipliers". It is:
 *
 *   NO GLOBAL *QUALITY* MULTIPLIERS.
 *
 * A global term that ranks items by how good they are, multiplied into a
 * per-viewer product, is the defect. A global term that ranks items by how
 * under-served they are is the corrective. They are opposites and the type
 * system should be able to tell them apart, which is what `TermClass` is for.
 */

/**
 * What a scoring term's value depends on. This is the whole classification.
 */
export type TermClass =
  /**
   * Depends on the viewer. My nearest posts are not your nearest posts, so
   * different clients produce different orderings and no consensus forms.
   * SAFE as a linear multiplier.
   */
  | 'per_viewer'
  /**
   * Depends on the (viewer, host) pair. Same argument as per-viewer, and
   * stronger: a pairwise term cannot even be computed without both sides.
   * SAFE as a linear multiplier.
   */
  | 'pairwise'
  /**
   * Depends only on the item or its host, and ranks it by QUALITY. Identical
   * for every viewer, so multiplying it in makes every client agree about who
   * deserves attention.
   * BANNED as a raw linear multiplier. Must be rank-normalised and dampened,
   * converted to a gate, or dropped.
   */
  | 'global_quality'
  /**
   * Depends only on the item, and ranks it by how UNDER-SERVED it is —
   * impressions received, joiners still needed, time left. Also identical for
   * every viewer, and that is the point: allocation is a population-level job
   * and has to be done by a population-level term.
   * REQUIRED to be global. Safe, and load-bearing.
   */
  | 'global_allocation';

/**
 * Every term the scorer knows about, and what it depends on.
 *
 * Adding a term means adding a line here. There is no default: the type is a
 * total map over the term names, so a new term that nobody classified is a
 * compile error rather than an accidental `global_quality` multiplier.
 */
export const TERM_CLASS = {
  // --- per-viewer -----------------------------------------------------------
  /** The viewer's own interest vector against this post's metrics. */
  categoryAffinity: 'per_viewer',
  /** The viewer's stated intent against the post's shape. */
  intentMatch: 'per_viewer',
  /** Distance from THIS viewer. The strongest per-viewer term in the model. */
  proximity: 'per_viewer',
  /** The viewer's historical time buckets against the post's. */
  timeFit: 'per_viewer',

  // --- pairwise -------------------------------------------------------------
  /** Viewer's friend_who answer against the host's. */
  socialContext: 'pairwise',
  /** Viewer's active buckets against the host's. The habit-formation signal. */
  rhythmOverlap: 'pairwise',
  /** Co-participation distance viewer -> host. Stubbed at neutral. */
  graphAffinity: 'pairwise',
  /**
   * P_accept. MOVED HERE FROM global_quality BY v1.8 §1.2.
   *
   *   hostRank^rho x (1 + pickiness x viewerDeviation(u, a))
   *
   * The move is earned by the `pickiness` factor, not by the viewer argument.
   * A viewer's reputation is one number applied to every card in their deck, so
   * on its own it rescales the deck and reorders nothing — the ordering would
   * still have been `hostRank^rho`, the same global consensus at lower volume.
   * Scaling that reputation by how selective the HOST is makes the term
   * genuinely conditional on the pair.
   *
   * The host half is still global, still rank-normalised, still dampened, and
   * still classified `global_quality` on its own line below. It is admissible
   * here because it no longer appears as a factor of its own.
   */
  acceptLikelihood: 'pairwise',

  // --- global quality: BANNED as raw multipliers ----------------------------
  /**
   * The host's smoothed accept rate. The original offender. Survives only
   * INSIDE `acceptLikelihood`, rank-normalised against the live host population
   * and raised to a damping exponent, never as a factor of its own.
   */
  hostReliability: 'global_quality',
  /**
   * Host completion rate decayed by lead time. Genuinely useful and genuinely
   * global. Converted to a GATE (§1.3) rather than dampened: "will this happen
   * at all" is filter-shaped, and a filter-shaped question asked as a
   * multiplier compounds identically across every viewer.
   */
  completionPrior: 'global_quality',
  /**
   * Post age. Same value for every viewer, so it is global — and it ranks by
   * quality-ish desirability, so it is global_quality. Folded into the
   * completion gate rather than multiplied.
   */
  freshness: 'global_quality',
  /**
   * Category repeatability class. Three distinct values across fourteen
   * categories, identical for everyone. Rank-normalised and dampened, or
   * dropped — v1.8 §3 measures which.
   */
  repeatableContext: 'global_quality',

  // --- global allocation: required to be global -----------------------------
  /**
   * The impression floor. Boosts a post that peers have lapped. Global by
   * necessity — "has this had a fair look" is not a question about the viewer —
   * and anti-concentrating by construction, which is the opposite of the defect.
   */
  exposureBoost: 'global_allocation',
  /**
   * Urgency, overflow and exhaustion, combined. §2's decentralised
   * approximation of a global assignment: a shared signal that makes
   * independent greedy clients collectively behave less greedily.
   */
  demandMultiplier: 'global_allocation',
} as const satisfies Record<string, TermClass>;

export type TermName = keyof typeof TERM_CLASS;

/** Terms that may not appear as a raw factor in the final product. */
export const BANNED_AS_MULTIPLIER: readonly TermName[] =
  (Object.keys(TERM_CLASS) as TermName[])
    .filter((name) => TERM_CLASS[name] === 'global_quality');

/**
 * The guard. Called at module load with the ACTUAL list of factors the score
 * multiplies, so a violation is a crash on import rather than a code review
 * someone skims.
 *
 * A comment saying "don't multiply global quality terms" survives exactly one
 * distracted afternoon. This does not.
 */
export function assertNoGlobalQualityMultipliers(
  multiplicands: readonly TermName[],
): void {
  const offenders = multiplicands.filter(
    (name) => TERM_CLASS[name] === 'global_quality',
  );

  if (offenders.length > 0) {
    throw new Error(
      `Global-quality terms used as raw score multipliers: ${offenders.join(', ')}.\n` +
      'A viewer-independent quality term inside a per-viewer product performs ' +
      'allocation as a side effect: every client sorts the same items up, and ' +
      'host attention concentrates. See core/classification.ts and DIAGNOSTICS.md D3.\n' +
      'Fix it by making the term viewer-dependent, converting it to a gate, ' +
      'rank-normalising and dampening it, or dropping it.',
    );
  }
}
