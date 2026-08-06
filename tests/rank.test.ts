/**
 * End-to-end ranker tests: determinism, the never-empty guarantee, slate
 * constraints, and cold start.
 */

import { describe, expect, it } from 'vitest';
import { rank } from '../src/ranking/core/rank.js';
import { resolveParams } from '../src/ranking/core/regime.js';
import { RANKER_ENABLED } from '../src/ranking/core/shipping.js';
import { EMPTY_SESSION, noteShown } from '../src/ranking/core/session.js';
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

/**
 * v1.6: these tests pin `regime` explicitly.
 *
 * The 12-post standardPool() genuinely reads as village density (coverage 0.6),
 * and at village scale there is no explore epsilon, no category cap and no
 * fresh-host slot — by design, because the viewer will see the whole pool
 * anyway. Tests of city-scale behaviour therefore have to say so, rather than
 * relying on the old fixed constants.
 */
const CITY = { regime: 1 } as const;
const VILLAGE = { regime: 0 } as const;

/**
 * v1.7: the ranker is SHELVED, not deleted.
 *
 * `RANKER_ENABLED` is false, so by default `rank()` orders by proximity, demand
 * and the session penalties — no affinity retrieval, no explore swap, no
 * reserved fresh-host slot, no funnel factors. Tests that exercise the shelved
 * machinery have to wake it up, and they do it the same way the diagnostics do:
 * by handing back the ungated parameters.
 *
 * This is the point of the parameter-override design. The shelved code is not a
 * second path that rots — it is the live path with different numbers, and these
 * tests keep running against it every commit. The day the flag flips, the
 * ranker works, because it never stopped being tested.
 */
const rankerOn = (regime: number) => ({ paramsOverride: resolveParams(regime) });

describe('determinism', () => {
  it('same seed, same deck, ten runs — byte-identical', () => {
    const input = {
      viewer: makeViewer(),
      candidates: standardPool(),
      interestEvents: history,
      sessionId: 'sess-1',
      now: T0,
      ...CITY,
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
      ...CITY,
    };
    // Not a guarantee that any two sessions differ — epsilon is 15%, so most
    // pairs are identical. Over many sessions at least one must diverge, or the
    // seed is not reaching the explore path at all.
    const decks = new Set<string>();
    for (let i = 0; i < 40; i++) {
      decks.add(JSON.stringify(
        rank({ ...base, sessionId: `sess-${i}` }, rankerOn(1))
          .slate.cards.map((c) => c.activityId),
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
      ...CITY,
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
  it('penalises repeats within a deck rather than capping them', () => {
    // v1.7 §3.2. The v1.6 test asserted "no more than 2 of a category per 8".
    // That constraint was mis-specified, not mistuned: Discover shows one card
    // at a time and never resets the pool, so a cap expressed per-deck applies
    // to a window that does not exist.
    //
    // What replaces it is monotone rather than binary — the fourth coffee is
    // worse than the third, not forbidden where the third was free.
    const monoculture = Array.from({ length: 12 }, (_, i) =>
      makeCandidate({
        activityId: `m${String(i).padStart(2, '0')}`,
        category: i % 2 === 0 ? 'coffee' : 'hiking',
        hostId: `host_${i}`,
        distanceMiles: 1 + i * 0.05,
        host: makeHost({ hostId: `host_${i}` }),
      }),
    );

    const result = rank(
      {
        viewer: makeViewer(),
        candidates: monoculture,
        interestEvents: history,
        sessionId: 'sess-1',
        now: T0,
        ...CITY,
      },
      { debug: true, ...rankerOn(1) },
    );

    // Both categories appear: the penalty pulls the deck off a pure run of the
    // strongest one without forbidding anything.
    const categories = new Set(result.slate.cards.map((c) => c.category));
    expect(categories.size).toBe(2);
    expect(result.slate.cards.length).toBe(CONSTANTS.slate.deckSize);
  });

  it('carries the penalty ACROSS decks within one session', () => {
    // The property the caps could not have. Two fetches in one session are one
    // continuous stream of cards from the user's side; they do not know where
    // one ended and the next began.
    const pool = standardPool();
    const base = {
      viewer: makeViewer(),
      candidates: pool,
      interestEvents: history,
      sessionId: 'sess-1',
      now: T0,
      ...CITY,
    };

    const first = rank(base, { deckSize: 3 });
    const firstHost = first.slate.cards[0]!.hostId;

    // Tell the ranker that host has now been shown four times this session.
    const shown = noteShown(
      EMPTY_SESSION,
      Array.from({ length: 4 }, () => ({ category: 'irrelevant', hostId: firstHost })),
    );
    const second = rank({ ...base, sessionShown: shown }, { deckSize: 3 });

    // 0.6^4 is a ~87% discount at city scale. Whatever was on top before is not
    // on top now.
    expect(second.slate.cards[0]!.hostId).not.toBe(firstHost);
  });

  it('at least one fresh_host card appears in the top 3, at city scale', () => {
    const result = rank(
      {
        viewer: makeViewer(),
        candidates: standardPool(),
        interestEvents: history,
        sessionId: 'sess-1',
        now: T0,
        ...CITY,
      },
      { debug: true, ...rankerOn(1) },
    );

    const fresh = new Set(['host_f', 'host_g']);
    const top = result.slate.cards.slice(0, CONSTANTS.slate.topSlots);
    expect(top.some((c) => fresh.has(c.hostId))).toBe(true);
    expect(result.debug!.relaxations).not.toContain('minFreshHostInTop');
  });

  it('ships a full deck from a monoculture with NOTHING to relax', () => {
    // Nine cards, all the same category, all the same host — the pool that
    // forced v1.6's relaxation ladder to give up both caps.
    //
    // v1.7 has no ladder because it has nothing to relax. A hard cap could make
    // the deck come out short, which is why the ladder existed; a penalised
    // card is still a card, so the failure mode stopped existing rather than
    // being handled. The deck is full and no cap relaxation is recorded,
    // because there are no caps.
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
        ...CITY,
      },
      { debug: true, ...rankerOn(1) },
    );

    expect(result.slate.cards.length).toBe(CONSTANTS.slate.deckSize);
    expect(result.debug!.relaxations).not.toContain('maxPerCategory');
    expect(result.debug!.relaxations).not.toContain('maxPerHost');
    // The fresh-host guarantee is the only displacement rule left, and this
    // pool genuinely contains no fresh host — that is supply information, not a
    // failure.
    expect(result.debug!.relaxations).toEqual(['minFreshHostInTop']);
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
        ...CITY,
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

describe('the §2.3 claim, now reachable only by configuring it (v1.8 §2)', () => {
  // v1.6 §2.3 claimed that at village scale the fairness rules stop being
  // DISPLACEMENT rules and become ORDERING rules: nothing needs a reserved slot
  // when the whole pool gets shown anyway, because urgency surfaces an unfilled
  // new host's post on its own.
  //
  // v1.8 §2 collapsed the density pairs, so "village scale" is no longer a
  // configuration the system can be in. The claim is not refuted — it was never
  // tested against data — it is simply no longer reachable by setting `regime`.
  // These tests now configure the parameters directly, which keeps the claim
  // exercised and makes explicit what used to be implied by a scalar.

  it('spends no slots on explore or fresh-host quotas when they are zero', () => {
    const result = rank(
      {
        viewer: makeViewer(),
        candidates: standardPool(),
        interestEvents: history,
        sessionId: 'sess-1',
        now: T0,
        ...VILLAGE,
      },
      {
        debug: true,
        paramsOverride: {
          exploreEpsilon: 0,
          quotas: { affinity: 0.7, proximity: 0.3, fresh_host: 0, random: 0, graph: 0 },
        },
      },
    );

    expect(result.debug!.params.exploreEpsilon).toBe(0);
    expect(result.debug!.retrieval.random).toEqual([]);
    expect(result.debug!.retrieval.fresh_host).toEqual([]);
  });

  it("a new host's first post reaches the top 3 with NO fresh-host slot", () => {
    // The §2.3 claim itself, with the parameters it needs supplied explicitly
    // rather than arriving via a regime scalar: a strong demand weight and no
    // reserved fresh-host slot. A brand-new host's post has fillRatio 0, so
    // urgency surfaces it without anything being displaced.
    const pool = standardPool().map((c) =>
      c.hostId === 'host_g'
        // Brand-new host, nobody signed up, happening in two days, and
        // deliberately the FURTHEST card in the pool so proximity cannot be
        // what rescues it.
        ? { ...c, confirmedJoiners: 0, startsAt: T0 + 2 * DAY }
        // Everyone else is already full, so overflow damps them.
        : { ...c, confirmedJoiners: 2 },
    );

    const result = rank(
      {
        viewer: makeViewer(),
        candidates: pool,
        interestEvents: history,
        sessionId: 'sess-1',
        now: T0,
        ...VILLAGE,
      },
      {
        debug: true,
        paramsOverride: {
          ...resolveParams(0),
          demandWeight: 0.5,
          overflowPenalty: 0.6,
          exploreEpsilon: 0,
          quotas: { affinity: 0.3, proximity: 0.7, fresh_host: 0, random: 0, graph: 0 },
        },
      },
    );

    const top3 = result.slate.cards.slice(0, 3).map((c) => c.hostId);
    expect(top3).toContain('host_g');
    // And it got there without the fresh-host machinery firing at all.
    expect(result.debug!.params.quotas.fresh_host).toBe(0);
    expect(result.debug!.retrieval.fresh_host).toEqual([]);
  });

  it('barely penalises repeats when the pool has no diversity to spend', () => {
    const result = rank(
      {
        viewer: makeViewer(),
        candidates: standardPool(),
        interestEvents: history,
        sessionId: 'sess-1',
        now: T0,
        ...VILLAGE,
      },
      { debug: true },
    );
    // Near 1 at village: penalising the second coffee when coffee is most of
    // what exists demotes the whole pool uniformly, which is a no-op with extra
    // steps.
    expect(result.debug!.params.categoryPenalty)
      .toBe(CONSTANTS.collapsed.categoryPenalty);
    // No relaxation is recorded, because nothing was constrained in the first
    // place. Relaxations should mean "we wanted to and could not", not "n/a".
    expect(result.debug!.relaxations).toEqual([]);
  });
});

describe('regime is derived when not supplied', () => {
  it('a small pool reads as village without being told', () => {
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
    // 12 eligible posts against the default 20 cards/week is coverage 0.6.
    expect(result.debug!.regime).toBe(0);
  });

  it('a large pool reads as city without being told', () => {
    const big = Array.from({ length: 120 }, (_, i) =>
      makeCandidate({
        activityId: `b${String(i).padStart(3, '0')}`,
        hostId: `bh${i % 30}`,
        category: ['coffee', 'fitness', 'hiking', 'markets'][i % 4] as string,
        distanceMiles: 0.5 + (i % 12) * 0.4,
        host: makeHost({ hostId: `bh${i % 30}` }),
      }),
    );

    const result = rank(
      {
        viewer: makeViewer(),
        candidates: big,
        interestEvents: history,
        sessionId: 'sess-1',
        now: T0,
      },
      { debug: true },
    );
    expect(result.debug!.regime).toBe(1);
    expect(result.debug!.params.categoryPenalty)
      .toBe(CONSTANTS.collapsed.categoryPenalty);
  });
});
