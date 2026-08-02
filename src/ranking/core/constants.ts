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
   * Scale-dependent parameters. Each is a { village, city } pair, resolved ONCE
   * per session by resolveParams() in regime.ts and passed down as plain
   * numbers. Nothing downstream of resolveParams knows the regime exists —
   * score.ts, slate.ts and explain.ts do not import the regime module at all,
   * and tests/purity.test.ts fails the build if they start to.
   */
  scaled: {
    /**
     * [spec §1.5] P_join weights at each end of the continuum.
     *
     * These do NOT each sum to 1 (village sums to 0.85). resolveParams
     * renormalises after interpolating, which is asserted. Renormalising after
     * rather than before is deliberate: it keeps each column readable as the
     * relative importance the spec stated, instead of as pre-divided fractions.
     */
    pJoin: {
      /**
       * Weights the `categoryAffinity` feature, which is the interest model's
       * contribution. Low at village because interest() over three events
       * contributes more variance than signal.
       */
      interestAffinity: { village: 0.10, city: 0.30 },
      /**
       * The simulator's finding made structural. Pure nearest-first beat the
       * full ranker on repeat rate at 40 users; this is the response to that,
       * rather than a global retune that would have been wrong at scale.
       */
      proximity: { village: 0.40, city: 0.20 },
      timeFit: { village: 0.20, city: 0.12 },
      intentMatch: { village: 0.10, city: 0.15 },
      socialContext: { village: 0.05, city: 0.08 },
      /**
       * STUB, both ends. graphAffinity() returns 0 in this build, so the
       * intended city value of 0.15 is deliberately NOT declared here: a
       * non-zero weight on an always-zero feature would survive renormalisation
       * and systematically depress P_join for everyone. Set city to 0.15 in the
       * same commit that implements graphAffinity, not before.
       */
      graphAffinity: { village: 0.0, city: 0.0 },
    },

    /**
     * [spec §1.5] Explore epsilon. Zero at village: exposure is already
     * guaranteed by pool exhaustion, so an explore swap spends a real slot to
     * show a card the user would have seen anyway.
     */
    exploreEpsilon: { village: 0.0, city: 0.15 },

    /**
     * [spec §1.5] Retrieval quotas as FRACTIONS of the deck (they were integers
     * in v1.5). Fractions because the split has to interpolate continuously and
     * integers cannot.
     *
     * fresh_host and random are pinned by the spec at both ends. The remaining
     * mass is split between affinity and proximity; that split is [new, GUESS]
     * — village leans proximity to match its P_join weighting, city keeps the
     * v1.5 2:1 affinity:proximity ratio.
     */
    quotas: {
      affinity: { village: 0.30, city: 0.57 },
      proximity: { village: 0.70, city: 0.28 },
      fresh_host: { village: 0.0, city: 0.10 },
      random: { village: 0.0, city: 0.05 },
      graph: { village: 0.0, city: 0.0 },
    },

    /**
     * [spec §1.5] Slate diversity caps. You cannot diversify a pool that is not
     * diverse: at village scale, capping categories at 2 in a deck of 8 just
     * means relaxing the cap every single time, which is noise.
     */
    maxPerCategory: { village: 8, city: 2 },
    maxPerHost: { village: 3, city: 1 },

    /**
     * [spec §2] Demand-balancing weight. How hard an unfilled, imminent post is
     * boosted. High at village because filling posts IS the objective there.
     */
    demandWeight: { village: 0.50, city: 0.10 },

    /**
     * [spec §2.2] Overflow penalty. Showing someone an already-full post costs
     * them a slot and probably a rejection. Expensive at village scale; at city
     * scale there is another card right behind it.
     */
    overflowPenalty: { village: 0.6, city: 0.2 },

    /**
     * [spec §3] Exhaustion rate. How fast repeat exposure to an already-met host
     * decays. Higher at village because the pool of people is small and running
     * out of new faces is the failure mode there.
     */
    exhaustionRate: { village: 0.35, city: 0.15 },

    /**
     * [spec §1.5] Novelty boost (§1.4). Lower at village: novelty is
     * unmeasurable on three events, and at 1.0 it becomes a mild tiebreak
     * rather than the dominant term it is at city scale.
     */
    noveltyBoost: { village: 1.0, city: 2.5 },
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
     * [v1] R_repeat = 1 + a*repeatableContext + b*rhythmOverlap, range 1.0–1.5.
     * This is a multiplier, not a probability: it says "this pairing could
     * become a habit", which is the business. Raising these tilts the deck
     * further toward routine-shaped tandems.
     */
    rRepeat: {
      base: 1.0,
      repeatableContext: 0.25,
      rhythmOverlap: 0.25,
    },
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
    /** [new] Cards per deck. */
    deckSize: 8,

    /**
     * maxPerCategory and maxPerHost moved to CONSTANTS.scaled in v1.6: you
     * cannot diversify a pool that is not diverse.
     */

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
     * [new] Order in which constraints are relaxed when they cannot all be met.
     * The deck must never shrink because the algorithm got opinionated, so a
     * constraint that would drop a card is abandoned instead. Earlier entries
     * are given up first.
     */
    relaxationOrder: ['maxPerHost', 'maxPerCategory', 'minFreshHostInTop'] as const,
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
     * The wire names for the `interest_events` mirror.
     *
     * NAMING CONFLICT, surfaced rather than resolved silently — see SCHEMA.md §6.
     * The build prompt says `checkin_positive` / `checkin_negative`; this repo
     * has used `checkin_yes` / `checkin_no` since v1.5, and those slugs are
     * load-bearing in three places, one of which is the INTEREST_SOURCES weight
     * table. Writing the other names would produce rows matching no source
     * entry, so they would fold in at ZERO weight — the most predictive signal
     * in the model, silently contributing nothing.
     *
     * Every write routes through this map, so renaming is one edit here plus a
     * widened check constraint, and the weights come along.
     */
    interestSource: {
      positive: 'checkin_yes',
      negative: 'checkin_no',
    },

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
for (const end of ['village', 'city'] as const) {
  const sum = Object.values(CONSTANTS.scaled.pJoin)
    .reduce((acc, pair) => acc + pair[end], 0);
  if (!(sum > 0)) {
    throw new Error(`CONSTANTS.scaled.pJoin.${end} must carry positive weight, got ${sum}`);
  }
}

// Retrieval quotas are fractions of the deck and must each end sum to 1.
for (const end of ['village', 'city'] as const) {
  const sum = Object.values(CONSTANTS.scaled.quotas)
    .reduce((acc, pair) => acc + pair[end], 0);
  if (Math.abs(sum - 1) > 1e-9) {
    throw new Error(`CONSTANTS.scaled.quotas.${end} must sum to 1, got ${sum}`);
  }
}

if (CONSTANTS.regime.coverageHigh <= CONSTANTS.regime.coverageLow) {
  throw new Error('CONSTANTS.regime.coverageHigh must exceed coverageLow');
}

const pCompleteSum = (Object.values(CONSTANTS.score.pComplete) as number[]).reduce((a, b) => a + b, 0);
if (Math.abs(pCompleteSum - 1) > 1e-9) {
  throw new Error(`CONSTANTS.score.pComplete must sum to 1, got ${pCompleteSum}`);
}
