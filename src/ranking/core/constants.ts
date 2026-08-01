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
     * [new] How much novelty lifts a metric's salience:
     *   salience = interest * (1 + noveltyBoost * novelty)
     * This is the anti-homophily dial. Raising it surfaces thin new interests
     * over well-established ones — the thing that stops the model deciding
     * someone is "a coffee person" forever. At 2.5, two five-day-old events
     * outrank forty events smeared over 200 days, which is the spec's stated
     * intent. Lowering it below ~2.0 inverts that.
     */
    noveltyBoost: 2.5,

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
  // Scoring weights (framework §4, v1 hand weights)
  // =========================================================================
  score: {
    /** [v1] P_join = weighted sum. Must sum to 1.0; asserted at module load. */
    pJoin: {
      categoryAffinity: 0.35,
      intentMatch: 0.20,
      proximity: 0.20,
      timeFit: 0.15,
      socialContext: 0.10,
      /**
       * [new] STUB. graphAffinity is always 0 in v1.5, so this weight is inert.
       * When the graph is switched on, take this from categoryAffinity and
       * proximity rather than adding it on top, or P_join drifts above 1.
       */
      graphAffinity: 0.0,
    },

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
     * [new] Candidates each source contributes to a deck of `slate.deckSize`.
     * Quotas are targets, not caps on the pool: an under-filling source hands
     * its slots to the sources in `backfillOrder`. Sources are drained in this
     * declaration order, so earlier sources win ties on dedup.
     *
     * Raising `random` trades relevance for marketplace health — correct at 40
     * users, wrong at 40,000.
     */
    quotas: {
      affinity: 4,
      proximity: 2,
      fresh_host: 1,
      random: 1,
      /** STUB: the graph source returns [] in v1.5, so this quota is redistributed. */
      graph: 0,
    } satisfies Record<RetrievalSource, number>,

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
  // Slate assembly (framework §3.3)
  // =========================================================================
  slate: {
    /** [new] Cards per deck. */
    deckSize: 8,

    /** [spec] At most this many cards of the same category per deck. */
    maxPerCategory: 2,

    /** [new] At most this many cards from the same host per deck. */
    maxPerHost: 1,

    /** [spec] At least this many fresh_host cards must appear within topSlots. */
    minFreshHostInTop: 1,
    /** [spec] The "top of deck" window the fresh-host guarantee applies to. */
    topSlots: 3,

    /**
     * [v1 §5] Explore epsilon: with this probability, swap position 2 with a
     * uniformly random lower-ranked card. Seeded, so it is deterministic per
     * (user, session). At 40 users this arguably wants to be higher; at scale
     * it comes down.
     */
    exploreEpsilon: 0.15,
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

const pJoinSum = (Object.values(CONSTANTS.score.pJoin) as number[]).reduce((a, b) => a + b, 0);
if (Math.abs(pJoinSum - 1) > 1e-9) {
  throw new Error(`CONSTANTS.score.pJoin must sum to 1, got ${pJoinSum}`);
}

const pCompleteSum = (Object.values(CONSTANTS.score.pComplete) as number[]).reduce((a, b) => a + b, 0);
if (Math.abs(pCompleteSum - 1) > 1e-9) {
  throw new Error(`CONSTANTS.score.pComplete must sum to 1, got ${pCompleteSum}`);
}
