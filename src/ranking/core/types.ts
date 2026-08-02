/**
 * Pure type declarations for the ranking core.
 *
 * HARD RULE: this file, and everything else under core/, imports nothing.
 * No React, no Supabase, no browser or native globals, no Date.now().
 * Time enters the system exclusively as an injected `now: Epoch` parameter.
 */

import type { SessionShown } from './session.js';

export type { SessionShown } from './session.js';

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

/** Milliseconds since the Unix epoch. Always injected, never read from a clock. */
export type Epoch = number;

/** A value the model has promised to keep in [0, 1]. Not enforced by the type. */
export type Unit = number;

export type UserId = string;
export type ActivityId = string;
export type SessionId = string;

/**
 * An interest metric slug, e.g. 'coffee', 'fitness', 'deep_conversation'.
 * Callers resolve free text to a slug before it reaches this module; the core
 * does no NLP and no fuzzy matching.
 */
export type MetricSlug = string;

/** Activity category slug, e.g. 'coffee', 'hiking'. Categories map onto metrics. */
export type CategorySlug = string;

// ---------------------------------------------------------------------------
// Interest event log (framework §1.1)
// ---------------------------------------------------------------------------

/**
 * Where a piece of interest evidence came from. Each source carries its own
 * weight and half-life — see INTEREST_SOURCES in constants.ts. Adding a source
 * is a data edit there, never a new `case` in a switch.
 */
export type InterestSource =
  | 'onboarding'          // answers given at signup
  | 'explicit_statement'  // user directly said "I'm into this" (§1.7)
  | 'post_created'        // user authored an activity in this metric
  | 'join_requested'      // user asked to join
  | 'join_accepted'       // the host said yes
  | 'tandem_completed'    // it actually happened
  | 'checkin_yes'         // post-tandem "would you do this again?" -> yes
  | 'checkin_no'          // ...                                   -> no
  | 'expand';             // card opened for detail (v1.5: recorded, weight 0)

/** One immutable row of the interest log. */
export interface InterestEvent {
  id: string;
  userId: UserId;
  metric: MetricSlug;
  source: InterestSource;
  /** +1 "yes, this", -1 "not this". */
  polarity: 1 | -1;
  /** Per-event strength before the source weight is applied. Usually 1. */
  weight: number;
  createdAt: Epoch;
  /** 'backfill' marks synthetic rows derived from pre-v1.5 data. */
  sourceMeta?: string;
  activityId?: ActivityId;
}

/**
 * A single event's contribution to a metric, retained so the explanation layer
 * can name *why* a metric ranks where it does. This provenance cannot be
 * reconstructed after the fold, which is why computeInterestState returns it.
 */
export interface EvidenceContribution {
  eventId: string;
  source: InterestSource;
  metric: MetricSlug;
  createdAt: Epoch;
  /** Signed, post-decay, post-source-weight contribution to raw evidence. */
  contribution: number;
  /** Decay multiplier applied, in [0, 1]. 1.0 = brand new. */
  decayFactor: number;
  activityId?: ActivityId;
}

/** The modelled state of one metric for one user, at one instant. */
export interface MetricState {
  metric: MetricSlug;

  /** Decayed, source-weighted sum of positive evidence. Unbounded above. */
  rawPositive: number;
  /** Same for negative evidence. Stored positive; subtracted downstream. */
  rawNegative: number;

  /** sat(rawPositive) less the penalised negative term. In [0, 1]. (§1.3) */
  interest: Unit;

  /** Recency x under-exploredness. High for new, thin, fresh interests. (§1.4) */
  novelty: Unit;

  /** How much evidence exists at all. 1 - uncertainty. In [0, 1]. */
  confidence: Unit;

  /**
   * interest lifted by the novelty prior. This — not `interest` — is what
   * orders metrics and feeds categoryAffinity. Can exceed 1 before
   * normalisation; normaliseSalience() brings the set back into [0, 1].
   */
  salience: number;

  /** Raw count of events folded in (both polarities). */
  eventCount: number;

  /** Epoch of the most recent event for this metric, or null if none. */
  lastEventAt: Epoch | null;

  /** Top contributing events, descending by |contribution|. (§1.1 provenance) */
  topContributors: EvidenceContribution[];
}

/** The full interest vector plus the metadata needed to cache it safely. */
export interface InterestState {
  userId: UserId;
  /** Keyed by metric slug. Metrics with zero evidence are absent, not zeroed. */
  metrics: Record<MetricSlug, MetricState>;
  /** The `now` the state was computed against. Decay makes this load-bearing. */
  computedAt: Epoch;
  /** Number of events folded in. Used to detect a stale cache. */
  eventCount: number;
  /** Order-independent fingerprint of the folded event ids. */
  eventsHash: string;
  /**
   * Fingerprint of the density-scaled parameters the fold used. The vector
   * depends on noveltyBoost, which moves with density, so a cache computed
   * under one regime must not be served under another.
   */
  paramsFingerprint: string;
  version: number;
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

/** Which retrieval source produced a candidate. Logged on every impression. */
export type RetrievalSource =
  | 'affinity'    // matches the viewer's top-salience metrics
  | 'proximity'   // nearby, regardless of taste
  | 'fresh_host'  // host the viewer has never been shown
  | 'graph'       // co-participation graph — STUB in v1.5, always empty
  | 'random';     // seeded explore

/** Time-of-day bucket. Coarse on purpose: users do not have precise routines. */
export type TimeBucket =
  | 'early_morning' | 'morning' | 'midday'
  | 'afternoon' | 'evening' | 'night';

/** The shape of a post — routine vs one-off — used for intent matching. */
export type ActivityShape = 'routine' | 'one_off' | 'deeper_conversation';

/** Everything the ranker knows about one host, from the viewer's perspective. */
export interface HostSnapshot {
  hostId: UserId;
  /** Lifetime accept/request counts. Prior-smoothed before use. */
  acceptCount: number;
  requestCount: number;
  /** Lifetime completed/hosted counts. Prior-smoothed before use. */
  completedCount: number;
  hostedCount: number;
  /** Identity-verified (AWS Rekognition face check passed). Not a taste signal. */
  verified: boolean;
  /** Time buckets this host is historically active in. */
  activeBuckets: TimeBucket[];
  /** Onboarding answer slugs, for socialContext overlap. */
  friendWho?: string;
  idealSaturday?: string[];
  /**
   * The host's own tandem_intent answer, when known. Required before the
   * explanation layer may claim "you're both here for X" — the post's shape is
   * not the same thing as the host having said it.
   */
  tandemIntent?: ActivityShape;
  /** True if the viewer has never been shown any post by this host. */
  neverShownToViewer: boolean;
}

/** One activity, already filtered for blocks and time pills, ready to score. */
export interface Candidate {
  activityId: ActivityId;
  hostId: UserId;
  category: CategorySlug;
  /** Metrics this activity speaks to. Usually [category] plus facets. */
  metrics: MetricSlug[];
  shape: ActivityShape;
  /** Great-circle miles from the viewer. */
  distanceMiles: number;
  /** When the activity happens. */
  startsAt: Epoch;
  timeBucket: TimeBucket;
  /** When the post was created. Drives freshness. */
  postedAt: Epoch;
  host: HostSnapshot;
  /** Host has auto-accept on for trusted viewers. */
  autoAcceptTrusted: boolean;
  /** How many impressions this post has had, for the impression floor. */
  impressionCount: number;

  /**
   * Accepted joiners so far (§2.1). Denormalised onto `activities` and
   * maintained by a trigger, so the existing bulk query picks it up for free —
   * this must never become a per-card fetch.
   *
   * `undefined` means UNKNOWN, which is not the same as 0. An unknown count
   * contributes no urgency at all, so a post whose data failed to load cannot
   * be boosted as if it were empty.
   */
  confirmedJoiners?: number;

  /** Capacity. Defaults to 1: a tandem is two people. */
  targetJoiners?: number;

  /** Completed tandems between this viewer and this host, for exhaustion (§3). */
  completedTogether?: number;

  /**
   * Does this viewer want more of this host? From the post-tandem check-in:
   * yes -> high, no -> low, unknown -> undefined (treated as neutral 0.5).
   * The only signal that separates repeat-seeking from variety-seeking.
   */
  repeatAffinity?: number;
  /** Which retrieval source surfaced it. Assigned during retrieval. */
  retrievalSource?: RetrievalSource;
}

/** The viewer. Everything here is first-party in-app data. */
export interface Viewer {
  userId: UserId;
  /** Onboarding answers, already mapped to slugs by the caller. */
  idealSaturday: string[];
  tandemIntent: ActivityShape | null;
  friendWho: string | null;
  verified: boolean;
  /** Time buckets the viewer historically joins or posts in. */
  activeBuckets: TimeBucket[];
  /** Hosts the viewer has previously been shown, for fresh_host detection. */
  seenHostIds: UserId[];
  /** Viewers the host trusts — drives auto-accept. */
  trustedByHostIds: UserId[];
}

// ---------------------------------------------------------------------------
// Density-scaled parameters (v1.6 §1.4)
// ---------------------------------------------------------------------------

/** A parameter declared at both ends of the density continuum. */
export interface Scaled<T> {
  village: T;
  city: T;
}

/**
 * The flat parameter object every scoring module consumes.
 *
 * These types live HERE rather than in regime.ts on purpose. score.ts, slate.ts,
 * retrieval.ts and explain.ts need the shape but must not import the regime
 * module — if they could, one of them would eventually reach past the resolved
 * values for the regime scalar itself and branch on it. Everything below is a
 * plain number, so a module holding one of these cannot recover the density it
 * came from even if someone tries. tests/purity.test.ts enforces the import ban.
 */
export interface ResolvedParams {
  /** P_join weights, renormalised to sum exactly 1 at every point. */
  pJoin: {
    /** Weights the categoryAffinity feature — the interest model's contribution. */
    interestAffinity: number;
    proximity: number;
    timeFit: number;
    intentMatch: number;
    socialContext: number;
    graphAffinity: number;
  };
  /** Retrieval quotas as fractions of the deck, summing to 1. */
  quotas: Record<RetrievalSource, number>;
  exploreEpsilon: number;
  /**
   * Within-session diversity penalties (v1.7 §3.2), in (0, 1]. These REPLACE
   * the v1.6 `maxPerCategory` / `maxPerHost` slot caps, which were fractions of
   * a deck of 8 in a product that shows one card at a time and never resets the
   * pool — a quota over a window that does not exist.
   *
   *   S_final x= categoryPenalty ^ shownThisSession(category)
   *   S_final x= hostPenalty     ^ shownThisSession(host)
   */
  categoryPenalty: number;
  hostPenalty: number;
  /** delta in S x (1 + delta * urgency) — demand balancing (§2). */
  demandWeight: number;
  /** sigma in S x (1 - sigma * overflow) — already-full penalty (§2.2). */
  overflowPenalty: number;
  /** Rate in exhaustion = 1 - exp(-rate * completedTogether) (§3). */
  exhaustionRate: number;
  /** beta in salience = interest x (1 + beta * novelty) (§1.4). */
  noveltyBoost: number;
  /**
   * Exponent on P_accept, P_complete and R_repeat (v1.7 §3.3). 1 is the full
   * funnel; 0 raises each to the identity, leaving S = P_join. A number rather
   * than a flag so the ship gate needs no branch and the continuity test covers
   * it like everything else.
   */
  funnelExponent: number;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Every 0..1 feature, kept separately so it can be logged and later learned. */
export interface FeatureVector {
  categoryAffinity: Unit;
  intentMatch: Unit;
  proximity: Unit;
  timeFit: Unit;
  socialContext: Unit;
  hostReliability: Unit;
  acceptLikelihood: Unit;
  completionPrior: Unit;
  repeatableContext: Unit;
  rhythmOverlap: Unit;
  freshness: Unit;
  /** STUB in v1.5: always 0. See features.ts → graphAffinity. */
  graphAffinity: Unit;
}

/** The decomposed funnel. */
export interface FunnelScore {
  pJoin: number;
  pAccept: number;
  pComplete: number;
  rRepeat: number;
  /** pJoin * pAccept * pComplete * rRepeat, then exposure and demand adjustments. */
  score: number;
  /** Multiplier applied by the impression floor, 1.0 if it did not fire. */
  exposureBoost: number;
  /** How badly this post needs a joiner, in [0, 1] (§2.1). */
  urgency: number;
  /** How over-subscribed it already is, in [0, 1] (§2.2). */
  overflow: number;
  /** How worn out this viewer/host pairing is, in [0, 1] (§3). */
  exhaustion: number;
}

export interface ScoredCandidate {
  candidate: Candidate;
  features: FeatureVector;
  funnel: FunnelScore;
}

/**
 * What gets written to `ranking_events.score_snapshot` on every impression.
 *
 * THE POINT OF THE v1.7 BUILD. Every feature the system can compute is recorded
 * here, **including the ones the shipped ordering ignores** — the whole shelved
 * ranker's feature set is computed on every deck and logged, while only
 * proximity, demand and the session penalties decide the order.
 *
 * That asymmetry is deliberate and it is cheap. Features cost microseconds;
 * unlogged history is unrecoverable. Without this, the day someone wants to know
 * whether `timeFit` predicts anything, the answer is "run the experiment for
 * three months first".
 *
 * Resolved parameters are NOT stored per row — they are a pure function of
 * (`algo`, `regime`), so storing them would be ~16 numbers duplicated onto every
 * impression to record something already reconstructable from a git tag.
 */
export interface ScoreSnapshot {
  /**
   * Schema version of this object. Bump it when the shape changes, and never
   * reinterpret an older `v` under newer rules — a training set silently
   * spanning two feature definitions is worse than one that spans none.
   */
  v: number;
  /** Every feature computed, whether or not the shipped ordering used it. */
  features: FeatureVector;
  /** The decomposed funnel, including factors currently gated off. */
  funnel: FunnelScore;
  /** Density scalar in force, 0 village to 1 city. */
  regime: number;
  /** False when the ranker was shelved and the deck was proximity-ordered. */
  rankerEnabled: boolean;
  /** Identifies the parameter table in force, so `regime` can be resolved later. */
  algo: string;
}

// ---------------------------------------------------------------------------
// Explanations (framework §5)
// ---------------------------------------------------------------------------

export type ReasonKind =
  | 'ideal_saturday'
  | 'explicit_interest'
  | 'behavioral_affinity'
  | 'intent_match'
  | 'proximity'
  | 'rhythm'
  | 'fresh_host'
  | 'category_fallback';

/** A reason line, plus the strength that earned it its place. */
export interface Reason {
  kind: ReasonKind;
  /** Rendered copy, lowercase, in Sunny's voice. Only provable claims. */
  text: string;
  /** Contribution that selected this reason. Never surfaced to the UI. */
  strength: number;
  /** Slots that were interpolated, for testing and for i18n later. */
  vars: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Slate / public output
// ---------------------------------------------------------------------------

/**
 * What the UI receives. Note what is NOT here: no score, no probability, no
 * compatibility percentage. Numbers turn people into inventory.
 */
export interface SlateCard {
  activityId: ActivityId;
  hostId: UserId;
  category: CategorySlug;
  /** Zero-based position in the deck. */
  position: number;
  /** The one reason line the card shows. */
  reason: Reason;
  /** Logged with the impression event so conversion can be split by source. */
  retrievalSource: RetrievalSource;
}

export interface Slate {
  userId: UserId;
  sessionId: SessionId;
  cards: SlateCard[];
  /** True when scoring threw and the deck fell back to proximity order. */
  degraded: boolean;
  computedAt: Epoch;
}

/** Debug payload. Only present when rank() is called with { debug: true }. */
export interface SlateDebug {
  scored: ScoredCandidate[];
  interest: InterestState;
  retrieval: Record<RetrievalSource, ActivityId[]>;
  /** Constraints that had to be relaxed to keep the deck full. */
  relaxations: string[];
  seed: number;
  /** The density scalar in force: 0 fully village, 1 fully city. */
  regime: number;
  /** Every scale-dependent parameter, after interpolation. */
  params: ResolvedParams;
}

export interface RankResult {
  slate: Slate;
  /**
   * One snapshot per card in `slate.cards`, same order.
   *
   * Deliberately a SIBLING of `slate` rather than a field on `SlateCard`. The
   * slate is the UI-facing type and a test greps its serialisation for numbers;
   * telemetry hangs off the result instead, so a component that renders
   * `slate.cards` cannot accidentally reach a score.
   *
   * Always populated, including when `debug` is off — instrumentation is not a
   * debugging affordance, it is the deliverable.
   */
  snapshots: ScoreSnapshot[];
  debug?: SlateDebug;
}

export interface RankOptions {
  /** Deck size. Defaults to CONSTANTS.slate.deckSize. */
  deckSize?: number;
  /** Attach the numeric internals. Never enable this on a UI code path. */
  debug?: boolean;
  /**
   * DIAGNOSTICS ONLY. Replaces resolved parameters after the ship gate has run.
   *
   * This exists so an offline experiment can vary one weight across a sweep
   * without editing `constants.ts`, running, and reverting — a dance that leaves
   * no trace in the diff and is therefore indistinguishable from tuning. Every
   * number in `DIAGNOSTICS.md` was produced through this field, so every
   * diagnostic's configuration is visible in the script that ran it.
   *
   * A test asserts nothing under `adapter/` ever sets it. If you are reaching
   * for it in application code, you want a constant.
   */
  paramsOverride?: Partial<ResolvedParams>;
}

export interface RankInput {
  viewer: Viewer;
  /** Already filtered: blocks removed, time pills applied. */
  candidates: Candidate[];
  /** The viewer's full interest event log. */
  interestEvents: InterestEvent[];
  sessionId: SessionId;
  now: Epoch;
  /**
   * Density scalar in [0, 1], normally computed by the adapter from stored
   * coverage history. When omitted, rank() derives a one-shot reading from the
   * candidate pool size — correct for a first-ever session, and for the
   * simulator, which has no persistence.
   */
  regime?: number;
  /**
   * What this session has already put in front of the viewer (v1.7 §3.2).
   *
   * Discover shows one card at a time and the pool does not reset, so diversity
   * has to be measured against the SESSION rather than against a deck. Omit it
   * and every deck behaves as a fresh session — correct for a first fetch, and
   * for the simulator, which drives one deck per day.
   *
   * `SessionShown` is declared in core/session.ts rather than here because it
   * carries behaviour (the fold and the penalty function) and this file carries
   * none.
   */
  sessionShown?: SessionShown;
}

// ---------------------------------------------------------------------------
// Data port — the seam between the pure core and any backend
// ---------------------------------------------------------------------------

/**
 * Implement this to wire the ranker to a backend. adapter/supabase.ts is one
 * implementation; a REST or in-memory implementation is equally valid. The core
 * never sees this interface — only adapter/index.ts does.
 */
export interface RankingDataPort {
  loadViewer(userId: UserId): Promise<Viewer>;
  loadCandidates(userId: UserId, opts: { now: Epoch }): Promise<Candidate[]>;
  loadInterestEvents(userId: UserId): Promise<InterestEvent[]>;

  /** Cache read/write. Both may no-op; the ranker recomputes if absent. */
  loadInterestStateCache(userId: UserId): Promise<InterestState | null>;
  saveInterestStateCache(state: InterestState): Promise<void>;

  /**
   * Coverage/regime persistence (v1.6 §1.2). Smoothing and hysteresis need
   * somewhere to live between sessions; without this the regime is recomputed
   * from scratch every time, which defeats the point of smoothing it.
   *
   * Losing this is a degradation, not a correctness failure — the regime
   * re-derives from the live pool, it just moves more abruptly for a while.
   */
  loadRegimeState(userId: UserId): Promise<StoredRegimeState | null>;
  saveRegimeState(userId: UserId, state: StoredRegimeState): Promise<void>;

  /** Impressions in the last `days`, for the cardsViewedPerWeek term. */
  countRecentImpressions(userId: UserId, days: number, now: Epoch): Promise<ImpressionHistory>;

  /** Append one interest event. */
  appendInterestEvent(
    event: Omit<InterestEvent, 'id'> & { id?: string },
  ): Promise<void>;

  /** §1.7: explicit statements must be listable and deletable by the user. */
  listExplicitStatements(userId: UserId): Promise<InterestEvent[]>;
  deleteExplicitStatement(userId: UserId, metric: MetricSlug): Promise<void>;

  /**
   * Funnel instrumentation. BATCHED, deliberately.
   *
   * There is no single-event method on the port. One network call per card is
   * how instrumentation becomes the thing that gets deleted the first time
   * someone profiles the Discover tab, and a one-card-at-a-time Discover makes
   * that per-card cost land on every swipe.
   *
   * Implementations must not throw: the buffered writer above this treats a
   * rejection as "retry, then drop", and a throw that escapes it would surface
   * a logging failure to a user.
   */
  logRankingEvents(events: readonly RankingEventWrite[]): Promise<void>;

  // -------------------------------------------------------------------------
  // Check-in data path (v1.7 §2.2)
  // -------------------------------------------------------------------------

  /**
   * Completed pairings this user was part of. Reads `tandems`, whose `status`
   * is the completion signal for the whole system — NOT `activities.status`,
   * and NOT `tandem_completions` (2 rows against 23 completed tandems; see
   * SCHEMA.md §1).
   */
  loadCompletedTandems(userId: UserId): Promise<TandemRecord[]>;

  /** Feedback this user has already given, so nobody is asked twice. */
  loadGivenFeedback(userId: UserId): Promise<GivenFeedback[]>;

  /**
   * Record one check-in answer. Writes `tandem_feedback` — which is already
   * per-pair (`tandem_id`, `rater_id`, `rated_id`, `response`) and needed no
   * migration at all.
   */
  writeCheckIn(answer: CheckInAnswer): Promise<void>;
}

/** One check-in answer, on its way to `tandem_feedback`. */
export interface CheckInAnswer {
  tandemId: string;
  raterId: UserId;
  ratedId: UserId;
  /** Would you tandem with them again? */
  positive: boolean;
  createdAt: Epoch;
}

// ---------------------------------------------------------------------------
// Check-in data path (v1.7 §2.2)
// ---------------------------------------------------------------------------

/**
 * One realised pairing. `tandems` is strictly PAIRWISE — this is the primitive,
 * and a group tandem is a clique of these sharing `groupId`, not a row with
 * three participants. See SCHEMA.md §3.
 */
export interface TandemRecord {
  tandemId: string;
  /** The two participants. Order is as stored; the check-in derives rater/rated. */
  userAId: UserId;
  userBId: UserId;
  /** 'completed' is the completion signal for the whole system. */
  status: string;
  /**
   * The post this pairing came from, when the link exists. [S1 in SCHEMA.md §5]
   * Without it the check-in still writes feedback; only the interest mirror and
   * the timing gate degrade.
   */
  activityId?: ActivityId;
  /** Category of the linked activity, for the `interest_events` mirror. */
  category?: CategorySlug;
  /** When the activity ended. Falls back to a start-plus-duration estimate. */
  endedAt?: Epoch;
  createdAt: Epoch;
}

/** A check-in this user owes, resolved and ready to ask. */
export interface PendingCheckIn {
  tandemId: string;
  /** The user being asked. */
  raterId: UserId;
  /** The counterpart being rated. Exactly one, because tandems are pairwise. */
  ratedId: UserId;
  activityId?: ActivityId;
  category?: CategorySlug;
  /** When the tandem ended — the ordering key. Oldest first. */
  endedAt: Epoch;
}

/** A feedback row that already exists, so the same pairing is never asked twice. */
export interface GivenFeedback {
  tandemId: string;
  ratedId: UserId;
}

/** What the adapter persists between sessions for the density estimate. */
export interface StoredRegimeState {
  coverageEwma: number | null;
  lastRegime: number | null;
  updatedAt: Epoch | null;
}

export interface ImpressionHistory {
  /** Impressions counted in the window. */
  count: number;
  /** How many weeks of history actually exist, which gates using the count. */
  weeksOfHistory: number;
}

export type RankingEventType =
  | 'impression' | 'advance' | 'expand' | 'im_in'
  | 'accept' | 'decline' | 'complete' | 'repeat'
  | 'checkin_yes' | 'checkin_no';

export interface RankingEventWrite {
  userId: UserId;
  activityId?: ActivityId;
  hostId?: UserId;
  eventType: RankingEventType;
  deckPosition?: number;
  source?: RetrievalSource;
  /**
   * Client-generated, one per app foreground period. There is no server-side
   * session concept and this build does not add one — a session is "the stretch
   * of cards someone looked at in one sitting", which only the client can see.
   */
  sessionId?: SessionId;
  /** Every feature and funnel factor at impression time. See ScoreSnapshot. */
  scoreSnapshot?: ScoreSnapshot | null;
  createdAt: Epoch;
}
