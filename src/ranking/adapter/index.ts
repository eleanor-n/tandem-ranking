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
import { checkInsToPrompt, nextSkipRetry, pendingCheckIns } from '../core/checkin.js';
import { EMPTY_SESSION, noteShown } from '../core/session.js';
import { CONSTANTS } from '../core/constants.js';
import { createInstrumentation } from './instrumentation.js';
import type {
  Instrumentation,
  InstrumentationStorage,
  Scheduler,
} from './instrumentation.js';
import type {
  ActivityId,
  Candidate,
  Epoch,
  InterestEvent,
  InterestSource,
  InterestState,
  MetricSlug,
  PendingCheckIn,
  RankOptions,
  RankResult,
  RankingDataPort,
  ResolvedParams,
  SnapshotApp,
  SessionId,
  SessionShown,
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

  /**
   * Local storage for the impression buffer, so an app kill does not take the
   * last few seconds of instrumentation with it. AsyncStorage satisfies the
   * interface as-is. Omit it and crash persistence is off — a degradation, not
   * a failure.
   */
  storage?: InstrumentationStorage;
  /** Timer source. Omit to use setTimeout. Injected so tests drive time. */
  scheduler?: Scheduler;
  /** Session ids are client-generated, one per app foreground period. */
  newSessionId?: () => SessionId;
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
  /**
   * Fetch, rank, and return a deck. Never throws; never returns short.
   *
   * Within-session diversity is handled for you: the client remembers what it
   * has already returned under this `sessionId` and penalises repeats of those
   * categories and hosts on the next call. Discover fetching "the next few"
   * over and over is the expected usage, not a special case.
   */
  getDeck(
    userId: UserId,
    sessionId: SessionId,
    options?: RankOptions & {
      candidates?: Candidate[];
      /**
       * Context only the app has, written onto every snapshot in this deck
       * (v1.9 §2). Build it off `SNAPSHOT_APP_KEYS` so a typo is a compile
       * error. Anything omitted is written as `null`, which is deliberately
       * different from being absent.
       */
      snapshotApp?: Partial<SnapshotApp>;
    },
  ): Promise<RankResult>;

  /**
   * Forget what a session has shown. Call on app foreground, alongside
   * `instrumentation.startSession()`, if you reuse session ids.
   */
  resetSession(sessionId: SessionId): void;

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

  /**
   * What this user owes a check-in on, in the order to ask (v1.7 §2.2).
   *
   * DATA PATH ONLY. Copy and UI belong to Eleanor; nothing here renders
   * anything, and the answer is never shown to the rated user or turned into a
   * score.
   *
   * Already metered to `CONSTANTS.checkin.maxPromptsPerAppOpen` — call it once
   * per app open and ask what comes back. Pass `{ all: true }` for the full
   * backlog, which is for a debug screen and not for a person.
   */
  getPendingCheckIns(userId: UserId, opts?: { all?: boolean }): Promise<PendingCheckIn[]>;

  /**
   * Record an answer. Writes `tandem_feedback` and mirrors into
   * `interest_events` so the check-in feeds the interest model, which is where
   * the highest-weighted source in the whole table lives.
   *
   * IDEMPOTENT. A double-tap or a retry after a timeout that actually succeeded
   * writes one row, enforced in the database rather than only here.
   *
   * Pass the whole `PendingCheckIn` through: `category` and `activityId` come
   * from it, and without `category` the interest mirror is skipped entirely
   * (see [S1] in SCHEMA.md).
   */
  recordCheckIn(answer: {
    tandemId: string;
    raterId: UserId;
    ratedId: UserId;
    /** The binary answer. `true` = would tandem with them again. */
    response: boolean;
    /** From the pending record. Absent -> the interest mirror is skipped. */
    category?: MetricSlug;
    activityId?: ActivityId;
  }): Promise<void>;

  /**
   * Record that the user dismissed this check-in (v1.9 §3, softened in v1.9.1
   * §3).
   *
   * The dismissal is SOFT: the first call snoozes the prompt for
   * `skipRetryDays`, the second retires it permanently. Call this the same way
   * both times — the escalation is handled here, and a second call for the same
   * pair is the mechanism, not a double-submit.
   *
   * **A SKIP IS NOT A NEGATIVE.** It writes `checkin_skips` and nothing else —
   * no `tandem_feedback` row, no `interest_events` row, no polarity anywhere.
   * A person who did not answer is not a person who said no, and conflating the
   * two teaches people that answering honestly has consequences, which costs
   * the signal permanently rather than just for that row.
   *
   * No `ratedId` parameter, deliberately: there is no judgement about a person
   * here, and an argument that cannot express one cannot be misused to.
   */
  skipCheckIn(tandemId: string, raterId: UserId): Promise<void>;

  /**
   * The buffered impression writer (v1.7 §2.1).
   *
   * Not a set of `logX()` methods on this client, on purpose: every one of them
   * would return a promise, and a promise on the swipe path gets awaited by
   * someone eventually. `record()` is synchronous and cannot throw. See
   * adapter/instrumentation.ts.
   *
   * Call `restore()` once at startup and `startSession()` on every foreground.
   */
  instrumentation: Instrumentation;
}

export function createRankingClient(config: RankingClientConfig): RankingClient {
  const { port, now } = config;
  const newId = config.newId ?? defaultId;

  /**
   * What each live session has already shown (v1.7 §3.2).
   *
   * Held here rather than asked of the caller: Discover fetches "the next few"
   * repeatedly within one session, so every call site would otherwise have to
   * remember to feed the counters back — the kind of contract that holds until
   * the second screen is built.
   *
   * Bounded by eviction rather than by TTL: a session is over when the app
   * backgrounds, and the client does not get told. Keeping the last few is
   * enough for any real navigation pattern and cannot grow.
   */
  const sessionShown = new Map<SessionId, SessionShown>();

  function rememberShown(sessionId: SessionId, result: RankResult): void {
    const next = noteShown(
      sessionShown.get(sessionId) ?? EMPTY_SESSION,
      result.slate.cards,
    );
    sessionShown.set(sessionId, next);

    while (sessionShown.size > CONSTANTS.slate.trackedSessions) {
      const oldest = sessionShown.keys().next().value;
      if (oldest === undefined) break;
      sessionShown.delete(oldest);
    }
  }

  const instrumentation = createInstrumentation({
    port,
    now,
    ...(config.storage ? { storage: config.storage } : {}),
    ...(config.scheduler ? { scheduler: config.scheduler } : {}),
    ...(config.newSessionId ? { newSessionId: config.newSessionId } : {}),
    ...(config.onError ? { onError: config.onError } : {}),
  });

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

      const result = rank(
        {
          viewer, candidates, interestEvents: events, sessionId, now: t,
          regime: reading.regime,
          sessionShown: sessionShown.get(sessionId) ?? EMPTY_SESSION,
          // v1.9 §2. Passed straight through to every snapshot in this deck.
          // Omitted keys are written as null by `buildSnapshotApp`, so an app
          // that supplies nothing still produces well-formed rows.
          ...(options.snapshotApp ? { snapshotApp: options.snapshotApp } : {}),
        },
        options,
        (reason) => config.onError?.('rank', reason.error),
      );

      // Close the loop here rather than making the app thread it. Discover
      // fetches the next few cards over and over inside one session, and every
      // caller would otherwise have to remember to feed the counters back —
      // which is the kind of thing that works until the second screen is built.
      rememberShown(sessionId, result);

      return result;
    },

    resetSession(sessionId) {
      sessionShown.delete(sessionId);
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

    async getPendingCheckIns(userId, opts = {}) {
      try {
        // One round of parallel reads, not three sequential ones. The check-in
        // prompt sits on the app-open path and this is the whole of its cost.
        const [tandems, given, skipped] = await Promise.all([
          port.loadCompletedTandems(userId),
          port.loadGivenFeedback(userId),
          port.loadSkippedCheckIns(userId),
        ]);
        const pending = pendingCheckIns(userId, tandems, given, now(), skipped);
        return opts.all ? pending : checkInsToPrompt(pending);
      } catch (error) {
        // Ask nobody rather than risk re-asking everybody. A check-in the user
        // already answered, asked again, reads as the app not listening — which
        // is worse than one delayed by a session.
        config.onError?.('getPendingCheckIns', error);
        return [];
      }
    },

    async recordCheckIn({ tandemId, raterId, ratedId, response, category, activityId }) {
      const t = now();
      const positive = response;

      await port.writeCheckIn({ tandemId, raterId, ratedId, positive, createdAt: t });

      // Mirror into the interest log. This is the point of the check-in as far
      // as ranking is concerned: checkin_yes carries weight 1.2 at a 120-day
      // half-life, the highest and longest in INTEREST_SOURCES.
      //
      // Skipped when the tandem could not be linked to an activity ([S1]).
      // Guessing a category would be worse than recording nothing — a wrong
      // metric is evidence the user never gave, and the interest log is
      // append-only.
      if (!category) return;

      const source = positive
        ? CONSTANTS.checkin.interestSource.positive
        : CONSTANTS.checkin.interestSource.negative;

      await port.appendInterestEvent({
        id: newId(),
        userId: raterId,
        metric: category,
        source: source as InterestSource,
        polarity: positive ? 1 : -1,
        weight: 1,
        createdAt: t,
        ...(activityId ? { activityId } : {}),
      });

      // And onto the funnel, so check-in rate is measurable alongside
      // everything else rather than requiring its own query.
      instrumentation.record({
        userId: raterId,
        eventType: positive ? 'checkin_yes' : 'checkin_no',
        ...(activityId ? { activityId } : {}),
        hostId: ratedId,
      });
    },

    async skipCheckIn(tandemId, raterId) {
      // The entire implementation. Note what is NOT here: no writeCheckIn, no
      // appendInterestEvent, no polarity of any kind.
      //
      // Also NOT here: an `instrumentation.record()` call. Skip RATE is worth
      // watching — a high one means the prompt is badly timed or badly worded —
      // but `checkin_skips` already carries `created_at`, so the rate is one
      // query away without a `ranking_events` row. Adding a `checkin_skip`
      // event type would mean widening the `ranking_events.event_type` CHECK
      // constraint, whose exact definition is not verifiable from this repo, to
      // record something already recorded.
      //
      // The read below is what makes the skip SOFT (v1.9.1 §3): a first skip
      // earns a retry, a second retires the check-in. It costs one extra round
      // trip on an action taken rarely, which is a better trade than putting the
      // escalation in SQL, where it would be invisible from here and untestable
      // without a database.
      //
      // `loadSkippedCheckIns` degrades to `[]` rather than throwing, so a failed
      // read makes a second skip look like a first and the prompt returns once
      // more. That is the recoverable direction on purpose — an extra prompt is
      // an annoyance, a lost label is permanent.
      const t = now();
      const existing = (await port.loadSkippedCheckIns(raterId))
        .find((s) => s.tandemId === tandemId && s.raterId === raterId);

      await port.writeCheckInSkip({
        tandemId,
        raterId,
        createdAt: t,
        retryAfter: nextSkipRetry(existing, t),
      });
    },

    instrumentation,
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
export { createInstrumentation } from './instrumentation.js';
export { askableFrom, checkInsToPrompt, pendingCheckIns } from '../core/checkin.js';
export { RANKER_ENABLED } from '../core/shipping.js';
export type {
  Instrumentation,
  InstrumentationConfig,
  InstrumentationHealth,
  InstrumentationStorage,
  Scheduler,
} from './instrumentation.js';
export type * from '../core/types.js';
