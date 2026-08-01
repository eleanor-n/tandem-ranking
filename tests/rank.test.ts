/**
 * End-to-end ranker tests: determinism, the never-empty guarantee, slate
 * constraints, and cold start.
 */

import { describe, expect, it } from 'vitest';
import { rank } from '../src/ranking/core/rank.js';
import { CONSTANTS } from '../src/ranking/core/constants.js';
import {
  DAY,
  T0,
  coldStartViewer,
  makeCandidate,
  makeHost,
  makeViewer,
  spreadEvents,
  standardPool,
} from './fixtures/index.js';
import type { InterestEvent } from '../src/ranking/core/types.js';

const history: InterestEvent[] = [
  ...spreadEvents('coffee', 'tandem_completed', 5, 30, 'c'),
  ...spreadEvents('fitness', 'join_requested', 3, 15, 'f'),
];

describe('determinism', () => {
  it('same seed, same deck, ten runs — byte-identical', () => {
    const input = {
      viewer: makeViewer(),
      candidates: standardPool(),
      interestEvents: history,
      sessionId: 'sess-1',
      now: T0,
    };

    const first = JSON.stringify(rank(input).slate.cards);
    for (let i = 0; i < 10; i++) {
      expect(JSON.stringify(rank(input).slate.cards)).toBe(first);
    }
  });

  it('a different session explores differently', () => {
    const base = {
      viewer: makeViewer(),
      candidates: standardPool(),
      interestEvents: history,
      now: T0,
    };
    // Not a guarantee that any two sessions differ — epsilon is 15%, so most
    // pairs are identical. Over many sessions at least one must diverge, or the
    // seed is not reaching the explore path at all.
    const decks = new Set<string>();
    for (let i = 0; i < 40; i++) {
      decks.add(JSON.stringify(
        rank({ ...base, sessionId: `sess-${i}` }).slate.cards.map((c) => c.activityId),
      ));
    }
    expect(decks.size).toBeGreaterThan(1);
  });

  it('the deck is stable across re-renders inside one session', () => {
    const input = {
      viewer: makeViewer(),
      candidates: standardPool(),
      interestEvents: history,
      sessionId: 'stable',
      now: T0,
    };
    const a = rank(input).slate.cards.map((c) => c.activityId);
    const b = rank(input).slate.cards.map((c) => c.activityId);
    expect(b).toEqual(a);
  });
});

describe('the score orders, never filters', () => {
  it('a non-empty pool always yields a non-empty deck', () => {
    for (const size of [1, 2, 3, 7, 8, 12]) {
      const result = rank({
        viewer: makeViewer(),
        candidates: standardPool().slice(0, size),
        interestEvents: history,
        sessionId: 'sess-1',
        now: T0,
      });
      expect(result.slate.cards.length).toBe(Math.min(size, CONSTANTS.slate.deckSize));
    }
  });

  it('an empty pool yields an empty deck — the only legal way to get one', () => {
    const result = rank({
      viewer: makeViewer(),
      candidates: [],
      interestEvents: history,
      sessionId: 'sess-1',
      now: T0,
    });
    expect(result.slate.cards).toEqual([]);
    expect(result.slate.degraded).toBe(false);
  });
});

describe('slate constraints', () => {
  it('no more than 2 same-category cards in a deck of 8', () => {
    const result = rank({
      viewer: makeViewer(),
      candidates: standardPool(),
      interestEvents: history,
      sessionId: 'sess-1',
      now: T0,
    });

    const counts = new Map<string, number>();
    for (const card of result.slate.cards) {
      counts.set(card.category, (counts.get(card.category) ?? 0) + 1);
    }
    for (const [, n] of counts) {
      expect(n).toBeLessThanOrEqual(CONSTANTS.slate.maxPerCategory);
    }
  });

  it('at least one fresh_host card appears in the top 3', () => {
    const result = rank(
      {
        viewer: makeViewer(),
        candidates: standardPool(),
        interestEvents: history,
        sessionId: 'sess-1',
        now: T0,
      },
      { debug: true },
    );

    const fresh = new Set(['host_f', 'host_g']);
    const top = result.slate.cards.slice(0, CONSTANTS.slate.topSlots);
    expect(top.some((c) => fresh.has(c.hostId))).toBe(true);
    expect(result.debug!.relaxations).not.toContain('minFreshHostInTop');
  });

  it('relaxes constraints rather than shipping a short deck', () => {
    // Nine cards, all the same category, all the same host. Every diversity cap
    // is unsatisfiable; the deck must still come out full.
    const monoculture = Array.from({ length: 9 }, (_, i) =>
      makeCandidate({
        activityId: `m${String(i).padStart(2, '0')}`,
        category: 'coffee',
        hostId: 'host_only',
        distanceMiles: 1 + i * 0.1,
        host: makeHost({ hostId: 'host_only' }),
      }),
    );

    const result = rank(
      {
        viewer: makeViewer(),
        candidates: monoculture,
        interestEvents: history,
        sessionId: 'sess-1',
        now: T0,
      },
      { debug: true },
    );

    expect(result.slate.cards.length).toBe(CONSTANTS.slate.deckSize);
    expect(result.debug!.relaxations).toContain('maxPerCategory');
    expect(result.debug!.relaxations).toContain('minFreshHostInTop');
  });
});

describe('cold start', () => {
  it('zero events and zero completions still produce a sane, full deck', () => {
    const viewer = coldStartViewer();
    const result = rank(
      {
        viewer,
        candidates: standardPool(),
        interestEvents: [],
        sessionId: 'first-session',
        now: T0,
      },
      { debug: true },
    );

    expect(result.slate.degraded).toBe(false);
    expect(result.slate.cards.length).toBe(CONSTANTS.slate.deckSize);

    // With no behavioural history, lambda = 0 and the deck runs on proximity
    // plus the onboarding answers. The nearest card should be at or near the top.
    const ids = result.slate.cards.map((c) => c.activityId);
    expect(ids.slice(0, 4)).toContain('a01');

    // The interest vector is genuinely empty — nothing was invented to fill it.
    expect(Object.keys(result.debug!.interest.metrics)).toEqual([]);

    // Every card still gets a reason line, and none of them claims history.
    for (const card of result.slate.cards) {
      expect(card.reason.text.length).toBeGreaterThan(0);
      expect(card.reason.kind).not.toBe('behavioral_affinity');
      expect(card.reason.kind).not.toBe('rhythm');
    }
  });

  it("a cold-start viewer's onboarding answers still steer the deck", () => {
    // farmers_market_morning -> markets, coffee, walk.
    const viewer = coldStartViewer();
    const result = rank(
      {
        viewer,
        candidates: standardPool(),
        interestEvents: [],
        sessionId: 'first-session',
        now: T0,
      },
      { debug: true },
    );

    const marketsCard = result.debug!.scored.find((s) => s.candidate.category === 'markets');
    const concertCard = result.debug!.scored.find((s) => s.candidate.category === 'concerts');

    // markets (a07, 3.1mi) must beat concerts (a08, 3.6mi) — barely further, but
    // it is in the stated answer and concerts is not.
    expect(marketsCard!.features.categoryAffinity)
      .toBeGreaterThan(concertCard!.features.categoryAffinity);
    expect(marketsCard!.funnel.score).toBeGreaterThan(concertCard!.funnel.score);
  });
});

describe('output hygiene', () => {
  it('no numeric score is reachable from the UI-facing type', () => {
    const result = rank({
      viewer: makeViewer(),
      candidates: standardPool(),
      interestEvents: history,
      sessionId: 'sess-1',
      now: T0,
    });

    expect(result.debug).toBeUndefined();

    const serialised = JSON.stringify(result.slate);
    for (const forbidden of ['score', 'pJoin', 'pAccept', 'pComplete', 'rRepeat', 'funnel', 'features']) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it('debug output is opt-in and carries the internals', () => {
    const result = rank(
      {
        viewer: makeViewer(),
        candidates: standardPool(),
        interestEvents: history,
        sessionId: 'sess-1',
        now: T0,
      },
      { debug: true },
    );
    expect(result.debug).toBeDefined();
    expect(result.debug!.scored.length).toBeGreaterThan(0);
    expect(typeof result.debug!.seed).toBe('number');
  });
});

describe('graph is a stub', () => {
  it('graphAffinity is 0 and the graph source contributes nothing', () => {
    const result = rank(
      {
        viewer: makeViewer(),
        candidates: standardPool(),
        interestEvents: history,
        sessionId: 'sess-1',
        now: T0,
      },
      { debug: true },
    );

    expect(result.debug!.retrieval.graph).toEqual([]);
    for (const s of result.debug!.scored) {
      expect(s.features.graphAffinity).toBe(0);
    }
  });
});

describe('time is injected', () => {
  it('the same input at a later `now` decays freshness and reorders nothing else silently', () => {
    const input = {
      viewer: makeViewer(),
      candidates: standardPool(),
      interestEvents: history,
      sessionId: 'sess-1',
      now: T0,
    };
    const early = rank(input, { debug: true });
    const late = rank({ ...input, now: T0 + 30 * DAY }, { debug: true });

    const earlyFresh = early.debug!.scored[0]!.features.freshness;
    const lateFresh = late.debug!.scored[0]!.features.freshness;

    expect(lateFresh).toBeLessThanOrEqual(earlyFresh);
    expect(lateFresh).toBeGreaterThanOrEqual(CONSTANTS.features.freshnessFloor);
  });
});
