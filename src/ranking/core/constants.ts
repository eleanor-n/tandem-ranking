/**
 * Every tunable number in the ranking layer.
 *
 * There are no magic numbers anywhere else in this module. If you find one,
 * that is a bug. Each entry says what it does and what raising it would do,
 * because these are the arguments to have with data later and they need to be
 * legible to someone who did not write them.
 *
 * Provenance key:
 *   [v1]  taken directly from the v1 spec
 *   [new] chosen here; see INFERENCES.md for the reasoning
 */

import type {
  ActivityShape,
  CategorySlug,
  InterestSource,
  MetricSlug,
  RetrievalSource,
  TimeBucket,
} from './types.js';

/** Weight and half-life for one class of interest evidence. */
export interface InterestSourceSpec {
  /** Multiplier on the event's own weight. Higher = this behaviour counts more. */
  weight: number;
  /**
   * Days for the contribution to halve. Higher = the interest persists longer
   * after the behaviour stops. Infinity means never decay.
   */
  halfLifeDays: number;
  /** Human-readable note for whoever changes it next. */
  note: string;
}

export const CONSTANTS = {
  // =========================================================================
  // Interest model (framework §1.1–1.4, §1.7)
  // =========================================================================
  interest: {
    /**
     * [new] The source weight/half-life table. DATA, not a switch statement —
     * adding a source is an entry here and nothing else.
     *
     * Ordering principle: weight tracks how much the behaviour cost the user.
     * Showing up to a tandem costs more than tapping a card, so it counts more.
     * Half-life tracks how long the behaviour stays informative.
     */
    sources: {
      checkin_yes: {
        weight: 1.2,
        halfLifeDays: 120,
        note: 'The gold label. "Would you do this again?" -> yes is the single most predictive signal in the system, so it outweighs everything and fades slowest.',
      },
      tandem_completed: {
        weight: 1.0,
        halfLifeDays: 90,
        note: 'You actually went. Strongest purely behavioural evidence. Raising the half-life makes long-dormant interests keep surfacing.',
      },
      explicit_statement: {
        weight: 1.0,
        halfLifeDays: 180,
        note: 'The user said so directly (§1.7). Weight fixed at 1.0 by spec. Long half-life so a stated interest is not silently overruled by a month of not doing it.',
      },
      checkin_no: {
        weight: 0.8,
        halfLifeDays: 90,
        note: 'Negative evidence. Deliberately lighter than checkin_yes: one bad tandem is usually about the person, not the activity.',
      },
      post_created: {
        weight: 0.8,
        halfLifeDays: 60,
        note: 'Authoring is a stronger want-signal than joining — you did the work of proposing it. Raising this makes the deck mirror what people post rather than what they attend.',
      },
      join_accepted: {
        weight: 0.7,
        halfLifeDays: 60,
        note: 'Committed, but not yet proof you showed up.',
      },
      onboarding: {
        weight: 0.6,
        halfLifeDays: 365,
        note: 'The cold-start backbone. Long half-life so a new user is not stranded, moderate weight so three tap answers cannot outvote real behaviour once it exists.',
      },
      join_requested: {
        weight: 0.5,
        halfLifeDays: 45,
        note: 'Intent without consummation. Cheap to emit, so it fades fast.',
      },
      expand: {
        weight: 0.0,
        halfLifeDays: 21,
        note: 'DELIBERATELY ZERO in v1.5. Expand events are recorded but not consumed — the revealed/desired split (§1.5) needs history that does not exist yet. Raise above 0 (0.15 is the intended starting point) once a few weeks of expand data have accumulated.',
      },
    } satisfies Record<InterestSource, InterestSourceSpec>,

    /**
     * [new] k in sat(x) = x / (x + k). Evidence needed to reach interest 0.5.
     * Raising it makes interest build more slowly and makes the model harder to
     * convince — good at scale, bad at 40 users where nobody has many events.
     * At k = 2 the 40th event moves interest by 0.35% of what the 1st did.
     */
    saturationK: 2.0,

    /**
     * [new] How hard negative evidence pushes back:
     *   interest = clamp(sat(pos) - negativeEvidenceScale * sat(neg), 0, 1)
     * Raising it lets a single bad experience bury a category. Kept below 1 so
     * negatives temper an interest rather than erase it.
     */
    negativeEvidenceScale: 0.7,

    /**
     * [new] Days for the novelty recency term to decay by 1/e:
     *   recency = exp(-weightedMeanAgeDays / noveltyRecencyTauDays)
     * Raising it keeps older interests looking "fresh" for longer.
     */
    noveltyRecencyTauDays: 30,

    /**
     * How much novelty lifts a metric's salience:
     *   salience = interest * (1 + noveltyBoost * novelty)
     *
     * MOVED TO CONSTANTS.scaled.noveltyBoost in v1.6 — it scales 1.0 (village)
     * to 2.5 (city), because novelty is unmeasurable on three events. This
     * value remains as the default used when no resolved params are supplied,
     * and is the city end, so v1.5 behaviour is preserved for callers that do
     * not pass params.
     */
    noveltyBoostDefault: 2.5,

    /** [new] How many contributing events to retain per metric for explanations. */
    topContributorsPerMetric: 3,

    /**
     * [new] Contributions below this are dropped before the fold. Purely a
     * performance and noise guard; raising it discards weak-but-real evidence.
     */
    minContribution: 1e-4,

    /**
     * [new] Half-life applied to a source this build has never heard of. Such
     * events contribute zero weight anyway; this exists so the fallback spec is
     * well-formed rather than to be tuned.
     */
    unknownSourceHalfLifeDays: 30,

    /**
     * [spec §1.7] The weight an explicit statement is recorded at. Fixed by the
     * framework — an explicit statement is an explicit statement, and letting
     * this drift would make "I'm into this" mean different things over time.
     */
    explicitStatementWeight: 1.0,

    /** [new] Bumped when the fold changes shape, to invalidate cached states. */
    stateVersion: 1,

    /**
     * [new] A cached interest state older than this is recomputed even if no
     * new events arrived, because decay is time-dependent. Raising it saves
     * compute and serves staler interest vectors.
     */
    cacheMaxAgeMinutes: 60,
  },

  // =========================================================================
  // Features (framework §3, v1 feature dictionary)
  // =========================================================================
  features: {
    /** [v1] proximity = exp(-miles / proximityDecayMiles). ~0.78 at 1mi, 0.29 at 5mi. */
    proximityDecayMiles: 4,

    /** [v1] freshness = exp(-hoursSincePosted / freshnessDecayHours), floored. */
    freshnessDecayHours: 48,
    /** [v1] Floor so old posts are not buried alive. */
    freshnessFloor: 0.3,

    /** [v1] Beta prior on accept rate: (accepts + a) / (requests + a + b). New host starts at 0.5. */
    acceptPriorAlpha: 2,
    acceptPriorBeta: 2,

    /** [v1] Same prior shape for completion rate. */
    completionPriorAlpha: 2,
    completionPriorBeta: 2,

    /**
     * [v1] Multiplier for an identity-verified host (AWS Rekognition face check).
     * Capped at 1.0 after applying. Raising it makes verification a bigger
     * ranking lever, which is a growth incentive but edges toward pay-to-win.
     */
    verifiedHostBoost: 1.1,
    /** [v1] Hosts accept verified requesters more often, so verified viewers rank up. */
    verifiedViewerBoost: 1.05,

    /** [v1] Lead time beyond this decays completionPrior toward distantPlanFloor. */
    leadTimeDecayDays: 5,
    /** [v1] Floor that distant plans decay toward. Distant plans die. */
    distantPlanFloor: 0.6,

    /** [new] Default for any behavioural feature with no history. Degrade to "reasonable". */
    thinDataDefault: 0.5,

    /**
     * [v1.8 §1.2] P_accept, repaired.
     *
     *   P_accept(a, u) = hostRank(a)^rho x (1 + pickiness(a) x viewerDeviation(u, a))
     *
     * The original was `hostReliability` with a x1.05 nudge for a verified
     * viewer — one global scalar per host, in a term whose whole justification
     * was two-sidedness. Every client sorted the same hosts up. Gini 0.931.
     *
     * Two things changed, and they fix different halves of the problem:
     *
     *   MAGNITUDE. `hostRank` is rank-normalised against the live host pool
     *   rather than used raw, then raised to `hostAcceptDamping`. Being the
     *   most reliable host should be an advantage, not a monopoly.
     *   Rank-normalisation also makes the term scale-invariant, which a raw
     *   accept rate is not: a 0.8 accept rate means something different in a
     *   pool where everyone is at 0.9 than in one where everyone is at 0.4.
     *
     *   CONSENSUS. `pickiness` is what actually restores two-sidedness. A
     *   viewer's reputation is the same number for every card they see, so on
     *   its own it rescales their whole deck uniformly and changes no ordering
     *   at all. Multiplied by how selective the HOST is, it becomes genuinely
     *   pairwise: a host who accepts everyone does not care about your record,
     *   a selective one does. That is what "does THIS host accept YOU" means,
     *   and without it the repair would be cosmetic.
     */
    acceptance: {
      /**
       * rho. 0 flattens the host term entirely, 1 is raw rank.
       *
       * [v1.9 — MEASURED, and set by a pre-registered abort rather than by
       * tuning.]
       *
       * v1.8 §1.5 committed in advance: "If Gini stays above ~0.75, the repair
       * failed and the terms should be dropped rather than repaired." The §3
       * sweep then measured, at N=600 over 24 seeds, a host Gini of 0.842
       * (+/-0.002) at rho=0.5. That is not near the line. The abort fires, and
       * this is the response the abort specified.
       *
       * The dose-response says the same thing from the other direction, and
       * says it about the mechanism rather than the threshold:
       *
       *   rho    retention   zero-joiner   Gini
       *   0      0.922       16.7%         0.511
       *   0.5    0.848       32.9%         0.821
       *   1.0    0.814       43.9%         0.892
       *
       * Monotone on five metrics. Every unit of raw host rank left in the
       * product buys concentration and pays for it in supply.
       *
       * WHAT SURVIVES AT ZERO — and this is NOT the clean story it looks like.
       *
       * The intended reading is that rho damps the host-rank MAIN EFFECT (the
       * viewer-independent part, the `global_quality` part, the part that
       * manufactures consensus) while leaving the INTERACTION intact: a
       * selective host weighs your record more heavily than an open one does.
       *
       * That is not what rho=0 actually does, and the tests caught it.
       *
       *   P_accept = clamp01( rank^rho * (1 + pickiness * deviation) )
       *
       * At rho=0 the first factor is exactly 1 — the ceiling. So any POSITIVE
       * viewer deviation multiplies 1 by something >1 and is clipped straight
       * back to 1 by clamp01. Measured:
       *
       *   rho=0     coffee-matching viewer 1.180 -> 1.000
       *             neutral viewer         1.000 -> 1.000    ordering LOST
       *   rho=0.25  0.664 vs 0.562                           ordering kept
       *
       * So rho=0 keeps the interaction only on the DOWNSIDE. It can penalise a
       * poor record; it cannot reward a good one, and every above-neutral
       * viewer is indistinguishable from every other for every host.
       *
       * This is left at 0 anyway, deliberately, because 0 is the value the §3
       * sweep MEASURED — the winning arm had this clipping in it, so 0.922
       * retention is the number for the clipped form, not for some better one
       * that has never been run. Setting rho=0 here reproduces the measurement.
       * Changing the functional form to remove the clip would be a new design
       * with no measurement behind it, and it is not being done under an abort.
       *
       * See DIAGNOSTICS.md §F1. `tests/accept.test.ts` pins the clipping so it
       * cannot be rediscovered by accident, and FUNNEL.md carries the open
       * question: whether the un-clipped form beats this one is UNMEASURED, and
       * it is the first thing to run next.
       */
      hostAcceptDamping: 0,

      /**
       * [new] Saturation constant for viewer experience: sat(n) = n / (n + k).
       * At k = 3, three completed tandems reads as half-experienced. Low
       * because the signal saturates fast in reality — a host cares that you
       * have shown up before, not that you have shown up forty times.
       */
      experienceK: 3,

      /**
       * [new] Weights on the viewer-side deviation. Sum to 1 so the deviation
       * stays interpretable as "how far from a neutral requester".
       *
       * `followThrough` dominates because it is the only one that answers the
       * question a host is actually asking: if I say yes, will you turn up.
       */
      weights: {
        verification: 0.10,
        experience: 0.15,
        followThrough: 0.35,
        categoryFamiliarity: 0.20,
        /**
         * STUB — graphCloseness returns exactly neutral, so this weight
         * contributes exactly zero deviation. Unlike the P_join case (§F2),
         * declaring a real weight here is SAFE: the deviation form is centred
         * at neutral, so an inert term adds 0 rather than surviving
         * renormalisation and depressing everyone. Set the feature live and
         * this weight starts working with no other edit.
         */
        graphCloseness: 0.20,
      },

      /**
       * [UNMEASURED] Bounds on the deviation, before pickiness scales it.
       * Asymmetric on purpose: a bad record should cost you more than a good
       * one gains, because that is how hosts behave — but the floor is well
       * above -1 so the deck never becomes a reputation gate.
       */
      deviationFloor: -0.40,
      deviationCeiling: 0.25,
    },

    /**
     * [v1] repeatableContext by category class. The platonic-specific weighting:
     * friendship forms through recurrence, so recurring contexts get structural
     * preference. This is the single most product-shaping constant here — it is
     * what makes a Tuesday study session outrank a Saturday concert.
     */
    repeatableContext: {
      routine: 1.0,      // coffee, study, fitness, errands, markets
      occasional: 0.5,   // food, hiking, games, sports
      one_off: 0.25,     // concerts, events
    },

    /** [new] intentMatch lookup: exact / adjacent / mismatch. */
    intentMatch: {
      exact: 1.0,
      adjacent: 0.5,
      mismatch: 0.0,
    },

    /** [new] socialContext when friend_who answers match exactly / are compatible / clash. */
    socialContext: {
      same: 1.0,
      compatible: 0.6,
      different: 0.25,
    },

    /**
     * [new] Blend of explicit and behavioural affinity (v1 formula):
     *   lambda = min(totalEvents / behaviouralPivot, behaviouralCap)
     * Raising behaviouralPivot keeps new users on their onboarding answers for
     * longer. behaviouralCap < 1 guarantees the explicit signal never fully
     * disappears, which is what stops the feed collapsing onto one category.
     */
    behaviouralPivot: 20,
    behaviouralCap: 0.8,
  },

  // =========================================================================
  // Density / regime (v1.6 §1)
  // =========================================================================
  //
  // The objective itself changes with density, so the parameters do too. There
  // is exactly one algorithm; "village" and "city" are the two ends of a
  // continuum, not two code paths. Village behaviour is the mathematical limit
  // of city behaviour as regime -> 0.
  //
  // Why: at 40 users with ~12 live posts a viewer can enumerate the whole
  // eligible pool in a week. Ordering barely matters (everything gets shown
  // anyway), explore quotas spend real slots for zero information (the explore
  // card would have been seen regardless), and interest() is computed from so
  // few events that it is mostly variance. The binding constraint at that size
  // is LIQUIDITY — a host posting, getting nobody, and never posting again.
  // At scale the binding constraint flips to ATTENTION and the current
  // greedy-per-viewer ranking is correct.
  regime: {
    /**
     * [new, GUESS] Coverage below which a user is fully "village".
     * coverage = eligiblePostsPerWeek / cardsViewedPerWeek. Below 1.5 the user
     * literally cannot exhaust their pool in a week, so ordering is nearly moot.
     * Raising it keeps users in village mode longer.
     */
    coverageLow: 1.5,

    /**
     * [new, GUESS] Coverage above which a user is fully "city". At 4x the pool
     * is four times what they will look at, so selection is doing real work.
     * Raising it delays the transition to city parameters.
     */
    coverageHigh: 4.0,

    /** [spec §1.2] EWMA smoothing factor over weekly coverage. */
    coverageEwmaAlpha: 0.3,

    /**
     * [spec §1.2] Hysteresis band on the regime scalar. The regime only moves if
     * the newly-implied value differs from the last emitted one by more than
     * this. Without it, raw weekly coverage flips regime week to week and the
     * user experiences the deck inexplicably changing character.
     * Raising it makes the deck more stable and slower to adapt.
     */
    hysteresisBand: 0.15,

    /**
     * [spec §1.1] Assumed cards viewed per week before there is enough
     * impression history to measure it. Two weeks of history is the threshold.
     */
    defaultCardsViewedPerWeek: 20,
    minWeeksOfHistory: 2,

    /**
     * [new] Days of eligible posts that constitute "per week". Coverage is
     * defined weekly; this is the window both terms are measured over.
     */
    coverageWindowDays: 7,
  },

  /**
   * COLLAPSED PARAMETERS — v1.8 §2.
   *
   * These were `{ village, city }` pairs through v1.7. They are now single
   * constants, and `resolveParams` is an identity over them.
   *
   * ---------------------------------------------------------------------------
   * Why
   *
   * The density argument is structurally sound: at 40 users a viewer enumerates
   * their whole pool in a week, ordering barely matters, and the binding
   * constraint is liquidity rather than attention. Nothing about that reasoning
   * has been refuted.
   *
   * But of the twelve pairs declared, exactly ONE was ever swept — proximity,
   * in v1.7 §D4 — and that sweep found the primary metric FLAT in the parameter
   * at every density, with the repeat-rate gain LARGEST at N=600, which is the
   * opposite of what the `{0.40, 0.20}` pair asserts. The other eleven were
   * asserted and never tested.
   *
   * §D4 also showed this harness can produce a confident three-seed verdict that
   * is backwards, and that the backwards verdict was the one VALIDATING the
   * existing design. Twelve untested pairs is twelve chances to be confidently
   * wrong in the comfortable direction.
   *
   * So: shelved, not deleted. The regime machinery — coverage, EWMA, hysteresis,
   * `resolve()`, the `Scaled<T>` type — is all intact and all still tested. It
   * currently has nothing to modulate.
   *
   * REACTIVATION CONDITION: a swept pair that beats its collapsed constant at
   * 6+ seeds and 2 standard errors. Not a plausible argument — a measurement,
   * to the same bar §D4 had to invent when its own first answer was noise.
   *
   * Values are the CITY column throughout. The city end is the one the system
   * grows into, and it is where v1.5's original constants sat before the pairs
   * were introduced.
   */
  collapsed: {
    /**
     * [spec §1.5] P_join weights. Do not sum to 1; `resolveParams` renormalises,
     * which keeps this table readable as relative importances rather than as
     * pre-divided fractions.
     */
    pJoin: {
      interestAffinity: 0.30,
      /**
       * ⚠️ THE ONE VALUE WITH SWEPT EVIDENCE, AND THE EVIDENCE IS AWKWARD.
       *
       * v1.7 §D4 swept this 0.10-0.80 at three densities, six seeds. On host
       * retention — the primary metric — it is FLAT within noise everywhere, so
       * the sweep identified no optimum and the city default stands. On repeat
       * rate it rises monotonically and is still rising at 0.80, the top of the
       * range, with the largest gain at N=600.
       *
       * Taking 0.20 is the non-tuning choice: the primary metric does not
       * distinguish the candidates, and picking the repeat-rate direction would
       * be tuning a constant to improve a metric. Recorded in DIAGNOSTICS.md
       * §C rather than resolved here — the pending experiment is a sweep wider
       * than 0.80, not an edit.
       */
      proximity: 0.20,
      timeFit: 0.12,
      intentMatch: 0.15,
      socialContext: 0.08,
      /**
       * STUB. graphAffinity() returns 0, so a non-zero weight here would
       * survive renormalisation and cap P_join below 1 for everyone
       * (INFERENCES §F2). Set it in the same commit that implements the feature.
       */
      graphAffinity: 0.0,
    },

    /** [spec §1.5] Explore epsilon. */
    exploreEpsilon: 0.15,

    /** [spec §1.5] Retrieval quotas as fractions of the deck. Must sum to 1. */
    quotas: {
      affinity: 0.57,
      proximity: 0.28,
      fresh_host: 0.10,
      random: 0.05,
      graph: 0.0,
    },

    /**
     * [v1.7 §3.2, UNMEASURED] Within-session diversity penalties.
     *
     *   S_final x= categoryPenalty ^ shownThisSession(category)
     *   S_final x= hostPenalty     ^ shownThisSession(host)
     *
     * Still UNMEASURED, and still must not be tuned against `feed_impressions`,
     * which is empty. These get set from real `ranking_events` data after the
     * beta.
     */
    categoryPenalty: 0.80,
    hostPenalty: 0.60,

    /** [spec §2] Demand-balancing weight. */
    demandWeight: 0.10,

    /** [spec §2.2] Overflow penalty on an already-full post. */
    overflowPenalty: 0.2,

    /**
     * [spec §3] Exhaustion rate — DISABLED since v1.7 §3.1.
     *
     * REACTIVATION CONDITION: check-in data exists in `tandem_feedback`.
     * `repeatAffinity` gates this term and has no data, so it damps good repeats
     * and bad ones identically — against the metric it exists to serve.
     */
    exhaustionRate: 0.0,

    /**
     * The v1.6 tuned exhaustion values, parked rather than deleted so
     * reactivation is a one-line swap. Nothing reads this.
     */
    exhaustionRateWhenReactivated: 0.15,

    /** [spec §1.5] Novelty boost (§1.4). */
    noveltyBoost: 2.5,
  },

  // =========================================================================
  // Scoring weights (framework §4, v1 hand weights)
  // =========================================================================
  score: {
    /** [v1] P_complete = 0.7*completionPrior + 0.3*freshness. */
    pComplete: {
      completionPrior: 0.7,
      freshness: 0.3,
    },

    /**
     * [v1.8 §1.3, UNMEASURED] The completion GATE.
     *
     * P_complete no longer multiplies the score. "Will this post actually
     * happen" is a genuinely useful and genuinely global question, but it is
     * FILTER-SHAPED — and a filter-shaped question asked as a multiplier
     * compounds identically across every viewer, which is the §D3 defect
     * exactly.
     *
     * So: posts scoring below this are ordered to the TAIL of the deck. Not
     * removed. The framework's absolute rule is that the score orders and never
     * filters, and a low-completion post stays reachable — it is simply last.
     * `tests/gate.test.ts` asserts that no value of this constant, including 1,
     * can produce an empty or short deck.
     *
     * 0.25 is low on purpose. This is meant to catch the host who has flaked
     * four times running, not to express a preference between a 0.6 and a 0.7.
     */
    completionFloor: 0.25,

    /**
     * [v1] R_repeat = 1 + a*repeatableContext + b*rhythmOverlap, range 1.0–1.5.
     * This is a multiplier, not a probability: it says "this pairing could
     * become a habit", which is the business. Raising these tilts the deck
     * further toward routine-shaped tandems.
     */
    rRepeat: {
      base: 1.0,
      /**
       * Weight on the DAMPENED, RANK-NORMALISED repeatable-context term.
       *
       * [v1.9 — DROPPED, executing §1.4's pre-registration.]
       *
       * §1.4 said: run it kept and dropped, because "dampen it" and "delete it"
       * are both defensible and only a measurement separates them. §3.4 ran
       * both. Nothing separated — every metric landed inside the seed-to-seed
       * spread in both configurations.
       *
       * An inert term is not neutral. It is a `global_quality` entry that costs
       * a rank-normalisation pass over the candidate pool on every deck build,
       * carries a damping exponent someone will eventually try to tune, and
       * stands as a standing invitation to reintroduce the v1.7 defect the next
       * time somebody decides it "should probably matter more". Dropping it is
       * simplification, not tuning: the measurement that would justify keeping
       * it was run, pre-registered, and came back null.
       *
       * If it is ever restored, restore it as a rank-normalised term with a
       * damping exponent — not as a raw multiplier. `classification.ts` will
       * fail the build otherwise, which is the point of that file.
       */
      repeatableContext: 0,
      rhythmOverlap: 0.25,
    },

    /**
     * [v1.8 §1.4, UNMEASURED] Damping exponent on the rank-normalised
     * repeatable-context term. Same shape and same reason as
     * `features.acceptance.hostAcceptDamping`.
     *
     * Note what damping does and does not fix. It reduces the MAGNITUDE of the
     * consensus this term creates; it does not make the term viewer-dependent,
     * because a category's repeatability is the same fact for everybody. That
     * is why §3.4 measures keeping it against dropping it rather than treating
     * a lower exponent as the answer.
     */
    repeatableContextDamping: 0.5,
  },

  // =========================================================================
  // Retrieval (framework §3.1)
  // =========================================================================
  retrieval: {
    /**
     * Quotas moved to CONSTANTS.scaled.quotas in v1.6 — they are fractions of
     * the deck now, and they interpolate with density. Sources are still drained
     * in SOURCE_ORDER, so earlier sources win ties on dedup.
     */

    /** [new] Sources that absorb slots left unfilled by others, in order. */
    backfillOrder: ['affinity', 'proximity', 'random'] as RetrievalSource[],

    /**
     * [new] Over-fetch multiplier: retrieve this many times the deck size before
     * slate assembly, so constraint repair has spare cards to swap in. Raising
     * it costs nothing at beta scale and gives the slate layer more room.
     */
    overFetchFactor: 3,

    /** [new] How many top-salience metrics the affinity source considers. */
    affinityMetricDepth: 5,

    /** [new] A metric below this salience is not worth retrieving against. */
    affinityMinSalience: 0.05,

    /**
     * [v1 §5] Impression floor. A post under `impressionFloor` impressions while
     * peers are at `impressionPeer`+ gets a score multiplier. Stops good posts
     * dying from a cold first hour. Raising the boost destabilises the ordering.
     */
    impressionFloor: 5,
    impressionPeer: 20,
    impressionBoost: 1.25,
  },

  // =========================================================================
  // Demand balancing and exhaustion (v1.6 §2, §3)
  // =========================================================================
  demand: {
    /**
     * [spec §2.1] targetJoiners when a post does not declare one. A tandem is
     * two people, so one joiner fills it and the overflow penalty starts biting
     * on the second — which is probably the right product behaviour anyway.
     */
    defaultTargetJoiners: 1,

    /**
     * [spec §2.1] Days out at which timePressure reaches its floor.
     * timePressure = clamp(1 - daysUntilStart / horizon, floor, 1).
     * Raising it makes distant posts compete with imminent ones for the boost.
     */
    timePressureHorizonDays: 7,

    /**
     * [spec §2.1] Floor on timePressure. Non-zero so a post a month out with no
     * joiners still gets some help — just not much.
     */
    timePressureFloor: 0.2,

    /**
     * [spec §3] repeatAffinity when there is no check-in answer for a pairing.
     * Neutral by construction. NOTE: check-in data does not exist yet, so this
     * is currently the value for EVERY pairing, which makes exhaustion a uniform
     * damper rather than a discriminating one. Known temporary weakness.
     */
    unknownRepeatAffinity: 0.5,

    /**
     * [new] Floor on the combined demand multiplier. The score orders and never
     * filters, so no card may be multiplied to exactly zero — a zeroed card is
     * indistinguishable from an ineligible one and sorts arbitrarily against its
     * equally-zeroed peers.
     */
    multiplierFloor: 0.01,
  },

  // =========================================================================
  // Slate assembly (framework §3.3)
  // =========================================================================
  slate: {
    /**
     * [new] Cards per deck.
     *
     * v1.7 note: this is a FETCH size, not a window. Discover shows one card at
     * a time and keeps going, so the deck is "the next few", not "the session".
     * Nothing may be expressed as a fraction of it — see scaled.categoryPenalty
     * for what that mistake cost.
     */
    deckSize: 8,

    /**
     * maxPerCategory / maxPerHost are GONE as of v1.7. They were reserved-slot
     * rules in a product with no slots. Replaced by the within-session
     * multiplicative penalties in CONSTANTS.scaled.
     */

    /**
     * [new] How many sessions' shown-counters the client keeps in memory.
     *
     * A session ends when the app backgrounds and nothing tells the ranking
     * client about it, so these are evicted oldest-first rather than expired.
     * Enough for any real navigation pattern, and it cannot grow.
     */
    trackedSessions: 8,

    /** [spec] At least this many fresh_host cards must appear within topSlots. */
    minFreshHostInTop: 1,
    /** [spec] The "top of deck" window the fresh-host guarantee applies to. */
    topSlots: 3,

    /**
     * exploreEpsilon moved to CONSTANTS.scaled in v1.6. It is 0 at village
     * scale: exposure is already guaranteed by pool exhaustion, so the swap
     * would spend a slot showing a card the user was going to see anyway.
     */

    /** [v1 §5] Zero-based position that the epsilon swap targets. */
    exploreSwapPosition: 1,

    /**
     * [new] Constraints that can still be given up, in order.
     *
     * v1.7 emptied most of this. The cap relaxation ladder existed because a
     * hard cap could make the deck come out short; a multiplicative penalty
     * cannot, since a penalised card is still a card. The fresh-host guarantee
     * is the only displacement rule left, and it is off while the ranker is
     * shelved.
     */
    relaxationOrder: ['minFreshHostInTop'] as const,
  },

  // =========================================================================
  // Explanations (framework §5)
  // =========================================================================
  explain: {
    /**
     * [new] A reason must clear this contribution to be shown. Below it, the
     * card falls back to the canned category line. Raising it means fewer,
     * truer reason lines — the right direction to err in.
     */
    minStrength: 0.15,

    /**
     * [new] Tie-break priority when several reasons clear the threshold.
     * Earlier wins. Ordered by how verifiable and how specific the claim is:
     * a shared onboarding answer is checkable by the user, "you keep saying yes
     * to coffee" is not.
     */
    priority: [
      'ideal_saturday',
      'explicit_interest',
      'rhythm',
      'behavioral_affinity',
      'intent_match',
      'proximity',
      'fresh_host',
      'category_fallback',
    ] as const,

    /** [new] Distance under this renders as "a few minutes away" not a number. */
    walkableMiles: 0.5,

    /**
     * [new] Above this many miles, distance is rounded to whole miles. Nobody
     * needs "12.3 miles away" — the decimal implies a precision the phone's
     * location fix does not have.
     */
    wholeMilesAbove: 10,
  },

  // =========================================================================
  // Post-tandem check-in (v1.7 §2.2)
  // =========================================================================
  //
  // "Would you tandem with them again?" — the single most predictive signal in
  // the system, and the ONLY route the ranker has to pairwise compatibility.
  // Exhaustion (§3) is gated on it, which is why exhaustion is switched off
  // until it exists (see scaled.exhaustionRate).
  //
  // This module owns the DATA PATH only. Copy and UI belong to Eleanor.
  //
  // Two rules that are product decisions, not implementation details:
  //   * never shown to the rated user, and never rendered as a score
  //   * skippable, and a skip is NOT a negative — someone who did not answer is
  //     not someone who said no, and conflating them teaches people that the
  //     honest answer has consequences
  checkin: {
    /**
     * [spec §2.2] Minimum elapsed time after the activity ends before asking.
     * Asking on the walk home reads as surveillance and gets an answer about
     * the last five minutes rather than the tandem.
     */
    minElapsedHours: 2,

    /**
     * [UNMEASURED] Assumed activity length when `activities` has no end time
     * ([S3] in SCHEMA.md). Only used to decide WHEN to ask, so being wrong
     * costs a delayed or early prompt, never a wrong answer. Set it from real
     * data once there is any.
     */
    assumedDurationHours: 2,

    /**
     * [spec §2.2] At most one prompt per app open. A queue of five check-ins on
     * launch is an interrogation, and the second answer is already worse than
     * the first.
     */
    maxPromptsPerAppOpen: 1,

    /**
     * [UNMEASURED] [v1.9.1 §2] How long after a tandem ends it stays askable.
     *
     * Past this, the check-in is dropped rather than queued. Not asking is the
     * INTENDED behaviour, not a loss: recall on a three-week-old coffee is poor,
     * and an answer given from a vague memory is a row of noise in the
     * highest-weighted signal the system has. A label you cannot trust is worse
     * than no label, because nothing downstream can tell them apart.
     *
     * This is also what makes the most-recent-first ordering safe. Without a
     * window, pending check-ins accumulate forever and `maxPromptsPerAppOpen = 1`
     * means an old one could be starved indefinitely by fresher arrivals — a
     * real cost, documented as such in v1.9. With the window, the same check-in
     * simply expires, which is what should happen to it anyway. The ordering
     * tradeoff is not resolved so much as dissolved.
     *
     * Raising it buys more labels of worse quality. Lowering it does the
     * reverse. 7 days is a guess at where recall falls off and needs replacing
     * the moment there is answer-latency data to fit it to.
     */
    eligibilityWindowDays: 7,

    /**
     * [UNMEASURED] [v1.9.1 §3] How long a skipped check-in waits before it may
     * be asked once more.
     *
     * The skip is SOFT. A first skip sets a retry this many days out; a second
     * skip on the same (tandem, rater) retires it permanently. v1.9 specified
     * hard suppression and that was an error: labels are the scarcest resource
     * in this system, and one mis-tap should not cost one permanently.
     *
     * Asymmetric on purpose. One dismissal is ambiguous — a mis-tap, a bad
     * moment, a person mid-something-else. Two is an answer, and continuing to
     * ask past it reads as the app not listening.
     *
     * The retry is still subject to `eligibilityWindowDays`, so a skip late in
     * the window expires before it can return. That is the common case and it
     * is fine: 5 < 7 only leaves room when the skip happened early.
     */
    skipRetryDays: 5,

    /**
     * The wire names for the `interest_events` mirror.
     *
     * **CANONICAL: `checkin_yes` / `checkin_no`.** See SCHEMA.md §6.
     *
     * `tandem-matching-v2-framework.md` §1.2 says `checkin_positive` /
     * `checkin_negative`. It is wrong, and it is the ROOT CAUSE of a drift that
     * has been reintroduced three builds running: the document gets re-read each
     * pass, the wrong slugs come back, and they get re-rejected here.
     *
     * Why they must be rejected: these slugs key `CONSTANTS.interest.sources`
     * (`checkin_yes` is weight 1.2 at a 120-day half-life — the highest and
     * longest in the table). A row written under a name with no entry there
     * folds in at ZERO weight. Nothing errors, the row count looks right, and
     * the single most predictive signal in the model contributes nothing.
     *
     * The `satisfies` clause below is what makes that a BUILD failure rather
     * than a quiet one: these values must be members of `InterestSource`, which
     * is the same union `interest.sources` is keyed by. `tests/checkin.test.ts`
     * asserts the same thing at runtime, for the case where someone widens the
     * union without adding the table entry.
     *
     * Every write routes through this map, so if the framework document is ever
     * declared authoritative, renaming is one edit here plus a widened check
     * constraint — and the weights come along.
     */
    interestSource: {
      positive: 'checkin_yes',
      negative: 'checkin_no',
    } satisfies Record<'positive' | 'negative', InterestSource>,

    /**
     * [S4 in SCHEMA.md] What goes in `tandem_feedback.response`. The column's
     * type could not be verified from the repo; PRECHECK P6 settles it, and if
     * it is text rather than boolean this is the one edit.
     */
    responseValues: {
      positive: true,
      negative: false,
    },
  },

  // =========================================================================
  // The ship gate (v1.7 §3.3)
  // =========================================================================
  shipping: {
    /**
     * Exponent applied to P_accept, P_complete and R_repeat. At 1 the funnel is
     * the full v1.5 product; at 0 each factor raises to the identity and S is
     * P_join alone.
     *
     * An exponent rather than a boolean so the gate stays a NUMBER: intermediate
     * values are meaningful (0.5 is a half-strength funnel), the continuity test
     * covers it, and nothing downstream has to branch.
     */
    funnelExponent: 1,

    /** What the exponent becomes while the ranker is shelved. See shipping.ts. */
    shelvedFunnelExponent: 0,
  },

  // =========================================================================
  // Instrumentation (v1.7 §2.1)
  // =========================================================================
  //
  // The deliverable. Every card shown writes one ranking_events row carrying the
  // FULL feature set — including every feature the shipped ordering ignores —
  // because features are cheap and unlogged history is unrecoverable.
  //
  // Everything here is about not making that expensive. A ranking layer that
  // costs a network round-trip per swipe is a ranking layer that gets deleted.
  instrumentation: {
    /**
     * Bumped when ScoreSnapshot changes shape. Never reinterpret an older `v`
     * under newer rules: a training set that silently spans two feature
     * definitions is worse than one that spans none.
     */
    snapshotVersion: 1,

    /**
     * Identifies the parameter table in force, so `regime` can be resolved back
     * into the full weight set offline. Storing the ~16 resolved numbers on
     * every impression would duplicate something already reconstructable from a
     * git tag.
     */
    algoVersion: 'v1.7',

    /**
     * [UNMEASURED] Flush cadence. Short enough that a backgrounded app has lost
     * little, long enough that a fast swiper batches. Nobody knows the real
     * swipe rate yet — that is what this build exists to find out.
     */
    flushIntervalMs: 10_000,

    /** [UNMEASURED] Flush early once this many events are buffered. */
    flushAtEvents: 20,

    /**
     * [UNMEASURED] Coalescing delay before mirroring the buffer to local
     * storage. Persisting on every enqueue would put a storage write on the
     * swipe path, which is the cost this whole design exists to avoid.
     */
    persistDebounceMs: 1_000,

    /**
     * Hard cap on the retained buffer. Past this, the OLDEST events are dropped:
     * a phone offline for an hour must not accumulate an unbounded array, and
     * recent events are the ones worth keeping. Drops are counted, never raised.
     */
    maxRetainedEvents: 500,

    /**
     * Consecutive failed flushes before the batch is abandoned. Retrying a
     * poison batch forever is how a logging layer becomes an outage.
     */
    maxFlushRetries: 3,
  },

  // =========================================================================
  // Determinism
  // =========================================================================
  random: {
    /** [new] FNV-1a offset basis / prime. Standard values; do not tune. */
    fnvOffset: 2166136261,
    fnvPrime: 16777619,
  },
} as const;

// ---------------------------------------------------------------------------
// Static mapping tables
//
// These are data, not logic. They live here so that adding a category is one
// edit in one file. The onboarding maps are the cold-start backbone: a brand
// new user with zero behaviour is ranked entirely through them.
// ---------------------------------------------------------------------------

/** Which repeatability class a category falls into. [v1] */
export const CATEGORY_REPEATABILITY: Record<CategorySlug, keyof typeof CONSTANTS.features.repeatableContext> = {
  coffee: 'routine',
  study: 'routine',
  fitness: 'routine',
  errands: 'routine',
  markets: 'routine',
  walk: 'routine',
  food: 'occasional',
  hiking: 'occasional',
  games: 'occasional',
  sports: 'occasional',
  art: 'occasional',
  music: 'occasional',
  concerts: 'one_off',
  events: 'one_off',
};

/** Default repeatability for a category not in the table above. */
export const DEFAULT_REPEATABILITY: keyof typeof CONSTANTS.features.repeatableContext = 'occasional';

/** Which shape a category implies, for intentMatch. [v1] */
export const CATEGORY_SHAPE: Record<CategorySlug, ActivityShape> = {
  coffee: 'deeper_conversation',
  study: 'routine',
  fitness: 'routine',
  errands: 'routine',
  markets: 'routine',
  walk: 'routine',
  food: 'deeper_conversation',
  hiking: 'one_off',
  games: 'one_off',
  sports: 'routine',
  art: 'one_off',
  music: 'one_off',
  concerts: 'one_off',
  events: 'one_off',
};

/**
 * ideal_saturday answer slug -> metrics it implies. [v1: "farmers market
 * morning" maps to markets + coffee]. Extend freely; unknown answers are
 * ignored rather than erroring, so onboarding can ship new options first.
 */
export const IDEAL_SATURDAY_METRICS: Record<string, MetricSlug[]> = {
  farmers_market_morning: ['markets', 'coffee', 'walk'],
  long_hike: ['hiking', 'fitness', 'walk'],
  coffee_and_a_book: ['coffee', 'study'],
  gym_then_brunch: ['fitness', 'food'],
  museum_wander: ['art', 'walk'],
  pickup_game: ['sports', 'fitness'],
  cook_something: ['food'],
  live_music: ['music', 'concerts'],
  errands_and_a_podcast: ['errands', 'walk'],
  board_games: ['games'],
};

/** tandem_intent answer slug -> the shape it wants. [v1] */
export const TANDEM_INTENT_SHAPE: Record<string, ActivityShape> = {
  someone_for_the_routine: 'routine',
  try_something_new: 'one_off',
  real_conversation: 'deeper_conversation',
};

/**
 * Shapes that are adjacent rather than identical, for the 0.5 bucket.
 * Symmetric; only one direction is listed and lookups check both.
 */
export const ADJACENT_SHAPES: [ActivityShape, ActivityShape][] = [
  ['routine', 'deeper_conversation'],
];

/**
 * friend_who answer slugs that are compatible without being the same.
 * Symmetric, same lookup rule as ADJACENT_SHAPES.
 */
export const COMPATIBLE_FRIEND_WHO: [string, string][] = [
  ['do_the_thing', 'low_key_regular'],
  ['talk_it_through', 'someone_new'],
];

/** Time buckets in clock order, so adjacency is index distance. */
export const TIME_BUCKET_ORDER: TimeBucket[] = [
  'early_morning', 'morning', 'midday', 'afternoon', 'evening', 'night',
];

/** Credit given to a neighbouring time bucket in timeFit / rhythmOverlap. [new] */
export const ADJACENT_BUCKET_CREDIT = 0.5;

// ---------------------------------------------------------------------------
// Load-time invariants. Cheap, and they catch the failure mode where someone
// retunes a weight and forgets the others have to move too.
// ---------------------------------------------------------------------------

// P_join weights are renormalised to 1 after interpolation (see regime.ts), so
// the columns themselves need not sum to 1 — but each end must carry positive
// mass, or resolveParams would divide by zero at that extreme.
{
  const sum = (Object.values(CONSTANTS.collapsed.pJoin) as number[])
    .reduce((acc, w) => acc + w, 0);
  if (!(sum > 0)) {
    throw new Error(`CONSTANTS.collapsed.pJoin must carry positive weight, got ${sum}`);
  }
}

// Retrieval quotas are fractions of the deck and must sum to 1.
{
  const sum = (Object.values(CONSTANTS.collapsed.quotas) as number[])
    .reduce((acc, q) => acc + q, 0);
  if (Math.abs(sum - 1) > 1e-9) {
    throw new Error(`CONSTANTS.collapsed.quotas must sum to 1, got ${sum}`);
  }
}

if (CONSTANTS.regime.coverageHigh <= CONSTANTS.regime.coverageLow) {
  throw new Error('CONSTANTS.regime.coverageHigh must exceed coverageLow');
}

// Session penalties must be in (0, 1]. A penalty of 0 is a hard cap wearing a
// multiplier's clothes: it drives the score to exactly zero, which makes the
// card indistinguishable from an ineligible one and sorts it arbitrarily
// against its equally-zeroed peers. The score ORDERS and never filters.
for (const name of ['categoryPenalty', 'hostPenalty'] as const) {
  const value = CONSTANTS.collapsed[name];
  if (!(value > 0 && value <= 1)) {
    throw new Error(`CONSTANTS.collapsed.${name} must be in (0, 1], got ${value}`);
  }
}

const pCompleteSum = (Object.values(CONSTANTS.score.pComplete) as number[]).reduce((a, b) => a + b, 0);
if (Math.abs(pCompleteSum - 1) > 1e-9) {
  throw new Error(`CONSTANTS.score.pComplete must sum to 1, got ${pCompleteSum}`);
}
