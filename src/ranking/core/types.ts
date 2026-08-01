/**
 * Pure type declarations for the ranking core.
 *
 * HARD RULE: this file, and everything else under core/, imports nothing.
 * No React, no Supabase, no browser or native globals, no Date.now().
 * Time enters the system exclusively as an injected `now: Epoch` parameter.
 */

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
  /** pJoin * pAccept * pComplete * rRepeat, then exposure adjustments. */
  score: number;
  /** Multiplier applied by the impression floor, 1.0 if it did not fire. */
  exposureBoost: number;
}

export interface ScoredCandidate {
  candidate: Candidate;
  features: FeatureVector;
  funnel: FunnelScore;
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
}

export interface RankResult {
  slate: Slate;
  debug?: SlateDebug;
}

export interface RankOptions {
  /** Deck size. Defaults to CONSTANTS.slate.deckSize. */
  deckSize?: number;
  /** Attach the numeric internals. Never enable this on a UI code path. */
  debug?: boolean;
}

export interface RankInput {
  viewer: Viewer;
  /** Already filtered: blocks removed, time pills applied. */
  candidates: Candidate[];
  /** The viewer's full interest event log. */
  interestEvents: InterestEvent[];
  sessionId: SessionId;
  now: Epoch;
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

  /** Append one interest event. */
  appendInterestEvent(
    event: Omit<InterestEvent, 'id'> & { id?: string },
  ): Promise<void>;

  /** §1.7: explicit statements must be listable and deletable by the user. */
  listExplicitStatements(userId: UserId): Promise<InterestEvent[]>;
  deleteExplicitStatement(userId: UserId, metric: MetricSlug): Promise<void>;

  /** Funnel instrumentation. */
  logRankingEvent(event: RankingEventWrite): Promise<void>;
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
  /** Per-feature values at impression time. The labels for v2's regression. */
  scoreSnapshot?: FeatureVector | null;
  createdAt: Epoch;
}
