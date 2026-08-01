/**
 * The public API. This is the only thing the app should import.
 *
 * Everything under core/ is pure and knows nothing about where data comes from.
 * Everything under adapter/ is I/O. This file is the join: it takes a
 * RankingDataPort, fetches, calls the pure ranker, and writes the instrumentation.
 *
 * Usage in an Expo app:
 *
 *   const ranking = createRankingClient({
 *     port: createSupabaseRankingPort(supabase, { distanceMiles, newId: uuid }),
 *     now: () => Date.now(),
 *   });
 *
 *   const { slate } = await ranking.getDeck(userId, sessionId);
 *   // slate.cards -> render. There is no score on them, by construction.
 */

import { rank } from '../core/rank.js';
import { buildExplicitStatement, computeInterestState, isCacheFresh, rebuildInterestStateFromEvents } from '../core/interest.js';
import { computeRegime, paramsFingerprint, resolveParams } from '../core/regime.js';
import { CONSTANTS } from '../core/constants.js';
import type {
  ActivityId,
  Candidate,
  Epoch,
  FeatureVector,
  InterestEvent,
  InterestSource,
  InterestState,
  MetricSlug,
  RankOptions,
  RankResult,
  RankingDataPort,
  RankingEventType,
  ResolvedParams,
  RetrievalSource,
  SessionId,
  UserId,
} from '../core/types.js';

export interface RankingClientConfig {
  port: RankingDataPort;
  /**
   * The clock. Injected so tests and the simulator can drive time. The core
   * never calls this; only this file does, once per operation.
   */
  now: () => Epoch;
  /** Id generator for new interest events. */
  newId?: () => string;
  /** Called whenever the ranker degrades or the port errors. Wire to your logger. */
  onError?: (where: string, error: unknown) => void;
}

/** Everything the density estimate resolved to. Debug-gated; never UI-facing. */
export interface RegimeDebug {
  /** This week's raw coverage: eligible posts per week / cards viewed per week. */
  coverage: number;
  coverageEwma: number;
  /** The scalar actually in force after hysteresis. 0 village, 1 city. */
  regime: number;
  /** What the smoothed coverage implied before hysteresis. */
  regimeUnsmoothed: number;
  /** True when hysteresis suppressed a move — the reason for a "stuck" regime. */
  held: boolean;
  eligiblePostsPerWeek: number;
  cardsViewedPerWeek: number | null;
  weeksOfHistory: number;
  /** Every scale-dependent parameter, after interpolation. */
  params: ResolvedParams;
}

export interface RankingClient {
  /** Fetch, rank, and return a deck. Never throws; never returns short. */
  getDeck(
    userId: UserId,
    sessionId: SessionId,
    options?: RankOptions & { candidates?: Candidate[] },
  ): Promise<RankResult>;

  /** The user's interest vector, cache-backed. */
  getInterestState(userId: UserId): Promise<InterestState>;

  /**
   * Coverage, smoothing, the regime scalar and the full resolved parameter set.
   *
   * DEBUG ONLY. Nothing here may reach a UI: the regime is an implementation
   * detail of how hard the ranker is trying, and telling a user they are in
   * "village mode" invites them to reason about an internal that will change.
   */
  getRegimeDebug(userId: UserId): Promise<RegimeDebug>;

  /** Recompute from the event log, ignoring and refreshing the cache. */
  rebuildInterestState(userId: UserId): Promise<InterestState>;

  /** §1.7 — record "I'm into this" / "not for me". `metric` is a resolved slug. */
  recordExplicitStatement(
    userId: UserId, metric: MetricSlug, polarity: 1 | -1,
  ): Promise<void>;

  /** §1.7 — list and remove statements. Both are user-facing affordances. */
  listExplicitStatements(userId: UserId): Promise<InterestEvent[]>;
  removeExplicitStatement(userId: UserId, metric: MetricSlug): Promise<void>;

  /** Record a behavioural interest event (join, post, completion, check-in). */
  recordInterest(params: {
    userId: UserId;
    metric: MetricSlug;
    source: InterestSource;
    polarity?: 1 | -1;
    activityId?: ActivityId;
  }): Promise<void>;

  /** Funnel instrumentation. */
  logImpression(params: {
    userId: UserId;
    activityId: ActivityId;
    hostId: UserId;
    deckPosition: number;
    source: RetrievalSource;
    features?: FeatureVector | null;
  }): Promise<void>;

  logEvent(params: {
    userId: UserId;
    eventType: RankingEventType;
    activityId?: ActivityId;
    hostId?: UserId;
    deckPosition?: number;
    source?: RetrievalSource;
  }): Promise<void>;
}

export function createRankingClient(config: RankingClientConfig): RankingClient {
  const { port, now } = config;
  const newId = config.newId ?? defaultId;

  /**
   * Measure this user's density and resolve the parameters for the session.
   *
   * `eligiblePostsPerWeek` is passed in rather than re-queried: the deck fetch
   * has already loaded the eligible pool, and counting it again would be a
   * second round-trip for a number we are holding.
   */
  async function readRegime(
    userId: UserId,
    eligiblePostsPerWeek: number,
  ): Promise<{ reading: ReturnType<typeof computeRegime>; observation: {
    eligiblePostsPerWeek: number; cardsViewedPerWeek: number | null; weeksOfHistory: number;
  } }> {
    const t = now();
    const windowDays = CONSTANTS.regime.coverageWindowDays;

    const [stored, impressions] = await Promise.all([
      port.loadRegimeState(userId),
      port.countRecentImpressions(userId, windowDays, t),
    ]);

    const observation = {
      eligiblePostsPerWeek,
      cardsViewedPerWeek: impressions.count > 0 ? impressions.count : null,
      weeksOfHistory: impressions.weeksOfHistory,
    };

    const reading = computeRegime(observation, stored);

    // Fire-and-forget. A failed regime write costs smoothing, not correctness.
    void port.saveRegimeState(userId, {
      coverageEwma: reading.coverageEwma,
      lastRegime: reading.regime,
      updatedAt: t,
    }).catch((e) => config.onError?.('saveRegimeState', e));

    return { reading, observation };
  }

  async function loadState(userId: UserId, noveltyBoost?: number): Promise<InterestState> {
    const events = await port.loadInterestEvents(userId);
    const cached = await port.loadInterestStateCache(userId);
    const t = now();

    const boost = noveltyBoost ?? CONSTANTS.interest.noveltyBoostDefault;
    const fingerprint = `nb:${boost.toFixed(4)}`;

    if (isCacheFresh(cached, events.map((e) => e.id), t, fingerprint)) {
      return cached as InterestState;
    }

    const fresh = computeInterestState(events, t, userId, { noveltyBoost: boost });
    // Fire-and-forget: a failed cache write must not fail the deck.
    void port.saveInterestStateCache(fresh).catch((e) => config.onError?.('saveCache', e));
    return fresh;
  }

  return {
    async getDeck(userId, sessionId, options = {}) {
      const t = now();
      const [viewer, events] = await Promise.all([
        port.loadViewer(userId),
        port.loadInterestEvents(userId),
      ]);

      const candidates = options.candidates
        ?? await port.loadCandidates(userId, { now: t });

      // The density estimate reads the pool we already have in hand.
      const { reading } = await readRegime(userId, candidates.length);

      return rank(
        {
          viewer, candidates, interestEvents: events, sessionId, now: t,
          regime: reading.regime,
        },
        options,
        (reason) => config.onError?.('rank', reason.error),
      );
    },

    getInterestState: (userId) => loadState(userId),

    async getRegimeDebug(userId) {
      const candidates = await port.loadCandidates(userId, { now: now() });
      const { reading, observation } = await readRegime(userId, candidates.length);
      return {
        ...reading,
        ...observation,
        params: resolveParams(reading.regime),
      };
    },

    async rebuildInterestState(userId) {
      const events = await port.loadInterestEvents(userId);
      const state = rebuildInterestStateFromEvents(events, now(), userId);
      await port.saveInterestStateCache(state);
      return state;
    },

    async recordExplicitStatement(userId, metric, polarity) {
      const event = buildExplicitStatement({
        id: newId(), userId, metric, polarity, now: now(),
      });
      await port.appendInterestEvent(event);
    },

    listExplicitStatements(userId) {
      return port.listExplicitStatements(userId);
    },

    removeExplicitStatement(userId, metric) {
      return port.deleteExplicitStatement(userId, metric);
    },

    async recordInterest({ userId, metric, source, polarity = 1, activityId }) {
      await port.appendInterestEvent({
        id: newId(),
        userId, metric, source, polarity,
        weight: 1,
        createdAt: now(),
        ...(activityId ? { activityId } : {}),
      });
    },

    async logImpression({ userId, activityId, hostId, deckPosition, source, features }) {
      await port.logRankingEvent({
        userId, activityId, hostId, deckPosition, source,
        eventType: 'impression',
        scoreSnapshot: features ?? null,
        createdAt: now(),
      });
    },

    async logEvent({ userId, eventType, activityId, hostId, deckPosition, source }) {
      await port.logRankingEvent({
        userId, eventType,
        ...(activityId ? { activityId } : {}),
        ...(hostId ? { hostId } : {}),
        ...(deckPosition !== undefined ? { deckPosition } : {}),
        ...(source ? { source } : {}),
        createdAt: now(),
      });
    },
  };
}

/**
 * Fallback id generator. Not a UUID and not cryptographically random — pass
 * your own (`expo-crypto`'s randomUUID, say) in production. This exists so the
 * client is usable in a test without wiring anything.
 */
let idCounter = 0;
function defaultId(): string {
  idCounter += 1;
  return `evt_${idCounter.toString(36)}_${(idCounter * 2654435761 % 4294967296).toString(36)}`;
}

// ---------------------------------------------------------------------------
// Re-exports: the pure core, for callers that want to rank without a backend
// (the simulator does exactly this).
// ---------------------------------------------------------------------------

export { rank } from '../core/rank.js';
export { CONSTANTS } from '../core/constants.js';
export {
  computeInterestState,
  rebuildInterestStateFromEvents,
  rankedMetrics,
  normalisedSalience,
  sat,
  decayFactor,
  noveltyTerm,
} from '../core/interest.js';
export {
  computeRegime,
  paramsFingerprint,
  resolveParams,
  resolve,
} from '../core/regime.js';
export { createSupabaseRankingPort } from './supabase.js';
export type * from '../core/types.js';
