/**
 * The buffered impression writer — v1.7 §2.1.
 *
 * Discover shows ONE CARD AT A TIME. A user "keeps tandeming" until they close
 * the app, and every card they see is a row we want. That makes the naive
 * implementation — await an insert per impression — actively hostile: a network
 * round-trip on the swipe path, on a phone, on a train.
 *
 * So nothing here is awaited from a render. `record()` is synchronous, returns
 * void, and cannot throw. Events accumulate in memory and leave in batches on a
 * timer, on backgrounding, or when enough have piled up.
 *
 * ---------------------------------------------------------------------------
 * The three rules, in priority order
 *
 *   1. NEVER surface an error. A failed log is invisible to the user. There is
 *      no toast, no retry spinner, no thrown promise. `onError` exists for the
 *      developer's console and nothing else reads it.
 *   2. NEVER block a render. Every public method except `flush()` returns
 *      synchronously, and `flush()` is only awaited by lifecycle code.
 *   3. Lose events rather than grow without bound. A phone offline for an hour
 *      drops its oldest events at `maxRetainedEvents` and counts the drops.
 *      Unbounded retention turns a logging layer into a memory leak.
 *
 * ---------------------------------------------------------------------------
 * Crash persistence
 *
 * The buffer is mirrored to injected local storage so an app kill does not take
 * the last ten seconds of impressions with it. The mirror is COALESCED — one
 * write per `persistDebounceMs` at most — because persisting on every enqueue
 * would put a storage write back on the swipe path and undo the whole point.
 *
 * Storage is injected rather than imported: this package has zero runtime
 * dependencies and does not get to decide whether the host app uses
 * AsyncStorage, MMKV or expo-sqlite. Omit it and crash persistence is simply
 * off, which is a degradation and not a failure.
 */

import { CONSTANTS } from '../core/constants.js';
import { validateSnapshotApp } from '../core/snapshot.js';
import type {
  ActivityId,
  Epoch,
  RankResult,
  RankingDataPort,
  RankingEventType,
  RankingEventWrite,
  RetrievalSource,
  ScoreSnapshot,
  SessionId,
  UserId,
} from '../core/types.js';

/** Local key-value storage, injected. AsyncStorage satisfies this as-is. */
export interface InstrumentationStorage {
  load(): Promise<string | null>;
  save(raw: string): Promise<void>;
  clear(): Promise<void>;
}

/** Injected so tests drive time instead of waiting for it. */
export interface Scheduler {
  schedule(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
}

export interface InstrumentationConfig {
  /** Only the batch writer is needed. Deliberately the narrowest dependency. */
  port: Pick<RankingDataPort, 'logRankingEvents'>;
  now: () => Epoch;
  /** Omit for no crash persistence. */
  storage?: InstrumentationStorage;
  /** Omit to use setTimeout. */
  scheduler?: Scheduler;
  /** Session ids are client-generated; supply a real one in production. */
  newSessionId?: () => SessionId;
  flushIntervalMs?: number;
  flushAtEvents?: number;
  /** Developer console only. Nothing user-facing may read this. */
  onError?: (where: string, error: unknown) => void;
}

/** What the writer is doing, for a health check or a debug screen. */
export interface InstrumentationHealth {
  sessionId: SessionId | null;
  buffered: number;
  /** Events discarded because the buffer hit its cap or a batch went poison. */
  dropped: number;
  /** Consecutive failed flushes. Non-zero means the backend is unhappy. */
  consecutiveFailures: number;
  flushing: boolean;
}

export interface Instrumentation {
  /**
   * Begin a foreground period. Returns the session id every subsequent event
   * carries. Calling it again ends the previous session and starts a new one —
   * which is exactly what an app resume should do.
   */
  startSession(sessionId?: SessionId): SessionId;
  currentSessionId(): SessionId | null;

  /** One impression per card, with the full feature snapshot. The main path. */
  recordDeck(userId: UserId, result: RankResult): void;

  /** Everything else: expand, im_in, accept, decline, complete, check-ins. */
  record(event: {
    userId: UserId;
    eventType: RankingEventType;
    activityId?: ActivityId;
    hostId?: UserId;
    deckPosition?: number;
    source?: RetrievalSource;
    scoreSnapshot?: ScoreSnapshot | null;
  }): void;

  /** Send everything buffered. Safe to call at any time; never rejects. */
  flush(): Promise<void>;

  /** Call from the app's background handler. Flushes and persists. */
  appBackgrounded(): Promise<void>;

  /** Call once at startup, before the first session. Recovers a killed buffer. */
  restore(): Promise<void>;

  health(): InstrumentationHealth;

  /** Stop the timer. Does not flush — call flush() first if you want that. */
  dispose(): void;
}

const defaultScheduler: Scheduler = {
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); },
};

let sessionCounter = 0;

/**
 * Fallback session id. Not random and not a UUID — pass your own
 * (`expo-crypto`'s randomUUID) in production. This exists so the writer is
 * usable in a test without wiring anything, and so a missing generator degrades
 * to "sessions are still distinguishable" rather than to a crash.
 */
function defaultSessionId(now: Epoch): SessionId {
  sessionCounter += 1;
  return `s_${now.toString(36)}_${sessionCounter.toString(36)}`;
}

export function createInstrumentation(config: InstrumentationConfig): Instrumentation {
  const c = CONSTANTS.instrumentation;
  const scheduler = config.scheduler ?? defaultScheduler;
  const flushIntervalMs = config.flushIntervalMs ?? c.flushIntervalMs;
  const flushAtEvents = config.flushAtEvents ?? c.flushAtEvents;
  const makeSessionId = config.newSessionId ?? (() => defaultSessionId(config.now()));

  let buffer: RankingEventWrite[] = [];
  let sessionId: SessionId | null = null;
  let dropped = 0;
  let consecutiveFailures = 0;
  let flushing = false;
  /** v1.9 §2.4 — the `app` shape is checked once per session, not per card. */
  let snapshotAppWarned = false;

  let flushTimer: unknown = null;
  let persistTimer: unknown = null;

  const fail = (where: string, error: unknown): void => {
    // Swallowed by design. Rule 1.
    try { config.onError?.(where, error); } catch { /* not even this may throw */ }
  };

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  function persistSoon(): void {
    if (!config.storage || persistTimer !== null) return;
    persistTimer = scheduler.schedule(() => {
      persistTimer = null;
      void persistNow();
    }, c.persistDebounceMs);
  }

  async function persistNow(): Promise<void> {
    if (!config.storage) return;
    try {
      if (buffer.length === 0) await config.storage.clear();
      else await config.storage.save(JSON.stringify(buffer));
    } catch (error) {
      fail('persist', error);
    }
  }

  // -------------------------------------------------------------------------
  // Buffer
  // -------------------------------------------------------------------------

  function enqueue(event: RankingEventWrite): void {
    buffer.push(event);

    // Drop the OLDEST. Recent events are the ones worth keeping, and an
    // unbounded array on a phone that has been offline for an hour is a leak,
    // not a feature.
    if (buffer.length > c.maxRetainedEvents) {
      const excess = buffer.length - c.maxRetainedEvents;
      buffer.splice(0, excess);
      dropped += excess;
    }

    persistSoon();
    if (buffer.length >= flushAtEvents) void flush();
    else armTimer();
  }

  function armTimer(): void {
    if (flushTimer !== null) return;
    flushTimer = scheduler.schedule(() => {
      flushTimer = null;
      void flush();
    }, flushIntervalMs);
  }

  // -------------------------------------------------------------------------
  // Flush
  // -------------------------------------------------------------------------

  async function flush(): Promise<void> {
    if (flushing || buffer.length === 0) return;
    flushing = true;

    const batch = buffer;
    buffer = [];

    try {
      await config.port.logRankingEvents(batch);
      consecutiveFailures = 0;
      await persistNow();
    } catch (error) {
      consecutiveFailures += 1;
      fail('flush', error);

      if (consecutiveFailures >= c.maxFlushRetries) {
        // Abandon it. Retrying a poison batch forever is how a logging layer
        // becomes an outage, and the failure is already counted in health().
        dropped += batch.length;
        consecutiveFailures = 0;
        await persistNow();
      } else {
        // Front of the queue: these are older than anything recorded since.
        buffer = batch.concat(buffer);
        persistSoon();
        armTimer();
      }
    } finally {
      flushing = false;
    }
  }

  // -------------------------------------------------------------------------

  return {
    startSession(id) {
      sessionId = id ?? makeSessionId();
      // Re-arm the §2.4 check. Once per SESSION, not once per process: a new
      // foreground can carry a new app build with a different `app` payload,
      // and a check that fires only on the first launch after install would
      // miss exactly the regression it exists to catch.
      snapshotAppWarned = false;
      return sessionId;
    },

    currentSessionId: () => sessionId,

    recordDeck(userId, result) {
      const at = config.now();
      const { cards } = result.slate;

      // v1.9 §2.4. Once per session, on the first deck that carries a snapshot.
      //
      // Never throws and never blocks a render: a malformed `app` object is a
      // data-quality problem, and taking down someone's Discover tab over one
      // is not a trade anybody would choose. It warns rather than repairing,
      // because silently filling in a missing key would hide the integration
      // gap this check exists to surface.
      if (!snapshotAppWarned) {
        const first = result.snapshots[0];
        if (first) {
          snapshotAppWarned = true;
          const problems = validateSnapshotApp(first.app);
          if (problems.length > 0) {
            config.onError?.(
              'snapshot.app',
              new Error(
                `score_snapshot.app is malformed (${problems.length} issue(s)); ` +
                'impressions are still being logged. ' + problems.join(' | '),
              ),
            );
          }
        }
      }

      for (let i = 0; i < cards.length; i++) {
        const card = cards[i];
        if (!card) continue;
        enqueue({
          userId,
          activityId: card.activityId,
          hostId: card.hostId,
          eventType: 'impression',
          deckPosition: card.position,
          source: card.retrievalSource,
          ...(sessionId !== null ? { sessionId } : {}),
          // A degraded deck produces no snapshots. Logging an empty one would
          // put a row in the training set that looks like a measurement and is
          // not; null is the honest value and the column is nullable for it.
          scoreSnapshot: result.snapshots[i] ?? null,
          createdAt: at,
        });
      }
    },

    record(event) {
      enqueue({
        userId: event.userId,
        eventType: event.eventType,
        ...(event.activityId ? { activityId: event.activityId } : {}),
        ...(event.hostId ? { hostId: event.hostId } : {}),
        ...(event.deckPosition !== undefined ? { deckPosition: event.deckPosition } : {}),
        ...(event.source ? { source: event.source } : {}),
        ...(sessionId !== null ? { sessionId } : {}),
        scoreSnapshot: event.scoreSnapshot ?? null,
        createdAt: config.now(),
      });
    },

    flush,

    async appBackgrounded() {
      if (flushTimer !== null) { scheduler.cancel(flushTimer); flushTimer = null; }
      await flush();
      await persistNow();
    },

    async restore() {
      if (!config.storage) return;
      try {
        const raw = await config.storage.load();
        if (!raw) return;
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return;
        // Recovered events are older than anything this run produced.
        buffer = (parsed as RankingEventWrite[]).concat(buffer);
        if (buffer.length > 0) armTimer();
      } catch (error) {
        // A corrupt buffer is unrecoverable and not worth a retry loop.
        fail('restore', error);
        try { await config.storage.clear(); } catch { /* nothing left to do */ }
      }
    },

    health: () => ({
      sessionId,
      buffered: buffer.length,
      dropped,
      consecutiveFailures,
      flushing,
    }),

    dispose() {
      if (flushTimer !== null) { scheduler.cancel(flushTimer); flushTimer = null; }
      if (persistTimer !== null) { scheduler.cancel(persistTimer); persistTimer = null; }
    },
  };
}
