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

export interface RankingClient {
  /** Fetch, rank, and return a deck. Never throws; never returns short. */
  getDeck(
    userId: UserId,
    sessionId: SessionId,
    options?: RankOptions & { candidates?: Candidate[] },
  ): Promise<RankResult>;

  /** The user's interest vector, cache-backed. */
  getInterestState(userId: UserId): Promise<InterestState>;

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

  async function loadState(userId: UserId): Promise<InterestState> {
    const events = await port.loadInterestEvents(userId);
    const cached = await port.loadInterestStateCache(userId);
    const t = now();

    if (isCacheFresh(cached, events.map((e) => e.id), t)) {
      return cached as InterestState;
    }

    const fresh = computeInterestState(events, t, userId);
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

      return rank(
        { viewer, candidates, interestEvents: events, sessionId, now: t },
        options,
        (reason) => config.onError?.('rank', reason.error),
      );
    },

    getInterestState: loadState,

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
export { createSupabaseRankingPort } from './supabase.js';
export type * from '../core/types.js';
