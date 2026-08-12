/**
 * The buffered impression writer.
 *
 * The properties under test are the three rules from adapter/instrumentation.ts,
 * in priority order: never surface an error, never block a render, lose events
 * rather than grow without bound. Everything else is detail.
 */

import { describe, expect, it, vi } from 'vitest';
import { createInstrumentation } from '../src/ranking/adapter/instrumentation.js';
import type {
  InstrumentationStorage,
  Scheduler,
} from '../src/ranking/adapter/instrumentation.js';
import { rank } from '../src/ranking/core/rank.js';
import { CONSTANTS } from '../src/ranking/core/constants.js';
import { SNAPSHOT_VERSION } from '../src/ranking/core/snapshot.js';
import type { RankingEventWrite } from '../src/ranking/core/types.js';
import { T0, makeViewer, standardPool } from './fixtures/index.js';

// ---------------------------------------------------------------------------
// A scheduler tests can step by hand. Real timers make timing tests flaky and
// slow, and flaky timing tests get deleted.
// ---------------------------------------------------------------------------

function manualScheduler() {
  const queue = new Map<number, { fn: () => void; at: number }>();
  let seq = 0;
  let clock = 0;

  const scheduler: Scheduler = {
    schedule(fn, ms) {
      seq += 1;
      queue.set(seq, { fn, at: clock + ms });
      return seq;
    },
    cancel(handle) { queue.delete(handle as number); },
  };

  return {
    scheduler,
    /** Advance time and run everything that comes due. */
    advance(ms: number) {
      clock += ms;
      for (const [id, task] of [...queue]) {
        if (task.at <= clock) { queue.delete(id); task.fn(); }
      }
    },
    pending: () => queue.size,
  };
}

function collector() {
  const written: RankingEventWrite[] = [];
  const batches: number[] = [];
  return {
    written,
    batches,
    port: {
      async logRankingEvents(events: readonly RankingEventWrite[]) {
        batches.push(events.length);
        written.push(...events);
      },
    },
  };
}

function memoryStorage(): InstrumentationStorage & { raw: () => string | null } {
  let value: string | null = null;
  return {
    async load() { return value; },
    async save(raw) { value = raw; },
    async clear() { value = null; },
    raw: () => value,
  };
}

const deck = () => rank({
  viewer: makeViewer(),
  candidates: standardPool(),
  interestEvents: [],
  sessionId: 'sess',
  now: T0,
});

// ---------------------------------------------------------------------------

describe('the impression writer batches', () => {
  it('writes nothing until a flush trigger fires', async () => {
    const { port, written } = collector();
    const clock = manualScheduler();
    const inst = createInstrumentation({
      port, now: () => T0, scheduler: clock.scheduler,
    });
    inst.startSession('s1');

    inst.record({ userId: 'u1', eventType: 'expand', activityId: 'a01' });
    expect(written).toEqual([]);
    expect(inst.health().buffered).toBe(1);

    clock.advance(CONSTANTS.instrumentation.flushIntervalMs);
    await Promise.resolve();
    expect(written.length).toBe(1);
  });

  it('flushes early once enough events pile up', async () => {
    const { port, written, batches } = collector();
    const clock = manualScheduler();
    const inst = createInstrumentation({
      port, now: () => T0, scheduler: clock.scheduler, flushAtEvents: 5,
    });
    inst.startSession('s1');

    for (let i = 0; i < 5; i++) {
      inst.record({ userId: 'u1', eventType: 'advance', activityId: `a${i}` });
    }
    await Promise.resolve();

    expect(written.length).toBe(5);
    // One insert, not five. This is the entire reason the buffer exists: a
    // one-card-at-a-time Discover would otherwise put a round-trip on a swipe.
    expect(batches).toEqual([5]);
  });

  it('flushes on backgrounding', async () => {
    const { port, written } = collector();
    const clock = manualScheduler();
    const inst = createInstrumentation({ port, now: () => T0, scheduler: clock.scheduler });
    inst.startSession('s1');
    inst.record({ userId: 'u1', eventType: 'im_in', activityId: 'a01' });

    await inst.appBackgrounded();
    expect(written.length).toBe(1);
    expect(inst.health().buffered).toBe(0);
  });

  it('records one impression per card, with position, source and session', async () => {
    const { port, written } = collector();
    const clock = manualScheduler();
    const inst = createInstrumentation({ port, now: () => T0, scheduler: clock.scheduler });
    inst.startSession('sess-42');

    const result = deck();
    inst.recordDeck('u1', result);
    await inst.flush();

    expect(written.length).toBe(result.slate.cards.length);
    written.forEach((event, i) => {
      expect(event.eventType).toBe('impression');
      expect(event.deckPosition).toBe(i);
      expect(event.sessionId).toBe('sess-42');
      expect(event.hostId).toBe(result.slate.cards[i]!.hostId);
      expect(event.source).toBe(result.slate.cards[i]!.retrievalSource);
    });
  });
});

describe('the snapshot carries the whole feature set', () => {
  it('logs every feature, including the ones the shipped ordering ignores', async () => {
    const { port, written } = collector();
    const clock = manualScheduler();
    const inst = createInstrumentation({ port, now: () => T0, scheduler: clock.scheduler });
    inst.startSession('s1');
    inst.recordDeck('u1', deck());
    await inst.flush();

    const snapshot = written[0]!.scoreSnapshot!;

    // The ordering uses proximity only. All of these are computed anyway,
    // because features are cheap and unlogged history is unrecoverable.
    for (const feature of [
      'categoryAffinity', 'intentMatch', 'proximity', 'timeFit', 'socialContext',
      'hostReliability', 'acceptLikelihood', 'completionPrior',
      'repeatableContext', 'rhythmOverlap', 'freshness', 'graphAffinity',
    ] as const) {
      expect(typeof snapshot.computed.features[feature], feature).toBe('number');
    }

    // And the funnel factors, which the ship gate raises to the identity but
    // which are still computed so "would the funnel have done better?" stays
    // answerable offline rather than needing another three months of data.
    for (const factor of ['pJoin', 'pAccept', 'pComplete', 'rRepeat'] as const) {
      expect(typeof snapshot.computed.funnel[factor], factor).toBe('number');
    }

    expect(snapshot.v).toBe(SNAPSHOT_VERSION);
    expect(snapshot.computed.algo).toBe(CONSTANTS.instrumentation.algoVersion);
    expect(snapshot.computed.rankerEnabled).toBe(false);
  });

  it('a degraded deck logs a null snapshot rather than a fabricated one', async () => {
    const { port, written } = collector();
    const clock = manualScheduler();
    const inst = createInstrumentation({ port, now: () => T0, scheduler: clock.scheduler });
    inst.startSession('s1');

    // Force the fallback: a candidate with no host object explodes in scoring.
    const broken = standardPool().map((c) => ({ ...c, host: undefined as never }));
    const result = rank({
      viewer: makeViewer(), candidates: broken, interestEvents: [],
      sessionId: 'sess', now: T0,
    });
    expect(result.slate.degraded).toBe(true);

    inst.recordDeck('u1', result);
    await inst.flush();

    // Null, not {}. A zeroed snapshot would sit in the training set looking
    // like a measurement.
    expect(written.length).toBeGreaterThan(0);
    for (const event of written) expect(event.scoreSnapshot).toBeNull();
  });
});

describe('failure is invisible and bounded', () => {
  it('never throws when the backend rejects', async () => {
    const inst = createInstrumentation({
      port: { logRankingEvents: () => Promise.reject(new Error('offline')) },
      now: () => T0,
      scheduler: manualScheduler().scheduler,
    });
    inst.startSession('s1');
    inst.record({ userId: 'u1', eventType: 'expand' });

    await expect(inst.flush()).resolves.toBeUndefined();
  });

  it('retries, then abandons a poison batch rather than looping forever', async () => {
    const attempts = { n: 0 };
    const inst = createInstrumentation({
      port: {
        logRankingEvents: () => { attempts.n += 1; return Promise.reject(new Error('nope')); },
      },
      now: () => T0,
      scheduler: manualScheduler().scheduler,
    });
    inst.startSession('s1');
    inst.record({ userId: 'u1', eventType: 'expand' });

    for (let i = 0; i < CONSTANTS.instrumentation.maxFlushRetries; i++) await inst.flush();

    expect(attempts.n).toBe(CONSTANTS.instrumentation.maxFlushRetries);
    expect(inst.health().buffered).toBe(0);
    expect(inst.health().dropped).toBe(1);

    // And it does not keep trying.
    await inst.flush();
    expect(attempts.n).toBe(CONSTANTS.instrumentation.maxFlushRetries);
  });

  it('drops the OLDEST events at the cap rather than growing without bound', () => {
    const { port } = collector();
    const inst = createInstrumentation({
      port, now: () => T0,
      scheduler: manualScheduler().scheduler,
      flushAtEvents: Number.MAX_SAFE_INTEGER,   // never flush; simulate offline
    });
    inst.startSession('s1');

    const cap = CONSTANTS.instrumentation.maxRetainedEvents;
    for (let i = 0; i < cap + 25; i++) {
      inst.record({ userId: 'u1', eventType: 'advance', activityId: `a${i}` });
    }

    expect(inst.health().buffered).toBe(cap);
    expect(inst.health().dropped).toBe(25);
  });

  it('reports errors to the developer hook and nowhere else', async () => {
    const onError = vi.fn();
    const inst = createInstrumentation({
      port: { logRankingEvents: () => Promise.reject(new Error('boom')) },
      now: () => T0,
      scheduler: manualScheduler().scheduler,
      onError,
    });
    inst.startSession('s1');
    inst.record({ userId: 'u1', eventType: 'expand' });
    await inst.flush();

    expect(onError).toHaveBeenCalledWith('flush', expect.any(Error));
  });
});

describe('crash persistence', () => {
  it('mirrors the buffer to storage, coalesced rather than per event', async () => {
    const { port } = collector();
    const storage = memoryStorage();
    const clock = manualScheduler();
    const inst = createInstrumentation({
      port, now: () => T0, scheduler: clock.scheduler, storage,
      flushAtEvents: Number.MAX_SAFE_INTEGER,
    });
    inst.startSession('s1');

    inst.record({ userId: 'u1', eventType: 'expand', activityId: 'a01' });
    inst.record({ userId: 'u1', eventType: 'expand', activityId: 'a02' });
    // Nothing written yet — a storage write per enqueue would put I/O back on
    // the swipe path, which is the cost the buffer exists to avoid.
    expect(storage.raw()).toBeNull();

    clock.advance(CONSTANTS.instrumentation.persistDebounceMs);
    await Promise.resolve();
    expect(JSON.parse(storage.raw() as string)).toHaveLength(2);
  });

  it('recovers a killed buffer on the next start', async () => {
    const { port, written } = collector();
    const storage = memoryStorage();
    const clock = manualScheduler();

    const first = createInstrumentation({
      port, now: () => T0, scheduler: clock.scheduler, storage,
      flushAtEvents: Number.MAX_SAFE_INTEGER,
    });
    first.startSession('s1');
    first.record({ userId: 'u1', eventType: 'im_in', activityId: 'a01' });
    clock.advance(CONSTANTS.instrumentation.persistDebounceMs);
    await Promise.resolve();
    first.dispose();                       // the crash

    const second = createInstrumentation({
      port, now: () => T0, scheduler: clock.scheduler, storage,
    });
    await second.restore();
    await second.flush();

    expect(written.map((e) => e.activityId)).toEqual(['a01']);
  });

  it('discards a corrupt buffer instead of retrying it forever', async () => {
    const { port } = collector();
    const storage = memoryStorage();
    await storage.save('{ not json');
    const onError = vi.fn();

    const inst = createInstrumentation({
      port, now: () => T0, scheduler: manualScheduler().scheduler, storage, onError,
    });
    await inst.restore();

    expect(inst.health().buffered).toBe(0);
    expect(storage.raw()).toBeNull();
    expect(onError).toHaveBeenCalled();
  });
});

describe('sessions', () => {
  it('are client-generated, one per foreground period', () => {
    const { port } = collector();
    const inst = createInstrumentation({
      port, now: () => T0, scheduler: manualScheduler().scheduler,
    });

    expect(inst.currentSessionId()).toBeNull();
    const a = inst.startSession();
    const b = inst.startSession();
    expect(a).not.toBe(b);
    expect(inst.currentSessionId()).toBe(b);
  });
});
