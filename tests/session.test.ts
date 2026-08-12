/**
 * Within-session diversity penalties — v1.7 §3.2.
 *
 * These replaced the slot caps because the caps were mis-SPECIFIED rather than
 * mistuned: every one was a fraction of a deck of 8, in a product that shows one
 * card at a time and never resets the pool. The tests below are mostly about
 * the properties a quota could not have.
 */

import { describe, expect, it } from 'vitest';
import {
  EMPTY_SESSION,
  categoryCount,
  hostCount,
  noteShown,
  sessionPenalty,
} from '../src/ranking/core/session.js';
import { assembleSlate } from '../src/ranking/core/slate.js';
import { resolveParams } from '../src/ranking/core/regime.js';
import { mulberry32 } from '../src/ranking/core/random.js';
import { CONSTANTS } from '../src/ranking/core/constants.js';
import type { ScoredCandidate } from '../src/ranking/core/types.js';

const card = (category: string, hostId: string) => ({ category, hostId });

describe('the counters', () => {
  it('start empty and fold cards in', () => {
    expect(categoryCount(EMPTY_SESSION, 'coffee')).toBe(0);

    const after = noteShown(EMPTY_SESSION, [
      card('coffee', 'h1'), card('coffee', 'h2'), card('hiking', 'h1'),
    ]);
    expect(categoryCount(after, 'coffee')).toBe(2);
    expect(categoryCount(after, 'hiking')).toBe(1);
    expect(hostCount(after, 'h1')).toBe(2);
  });

  it('are immutable — folding returns a new object', () => {
    const after = noteShown(EMPTY_SESSION, [card('coffee', 'h1')]);
    expect(categoryCount(EMPTY_SESSION, 'coffee')).toBe(0);
    expect(after).not.toBe(EMPTY_SESSION);
  });

  it('survive a round trip through JSON', () => {
    // Plain records rather than Maps, so a session survives a re-render. In a
    // React Native app that matters more than the constant factor.
    const after = noteShown(EMPTY_SESSION, [card('coffee', 'h1'), card('coffee', 'h1')]);
    const revived = JSON.parse(JSON.stringify(after)) as typeof after;
    expect(categoryCount(revived, 'coffee')).toBe(2);
    expect(hostCount(revived, 'h1')).toBe(2);
  });
});

describe('the penalty curve', () => {
  it('leaves an unseen category or host completely untouched', () => {
    expect(sessionPenalty(EMPTY_SESSION, card('coffee', 'h1'), 0.8, 0.6)).toBe(1);
  });

  it('is monotone — the fourth is worse than the third, not forbidden', () => {
    // The whole difference from a cap. A cap makes card 3 free and card 4
    // impossible; this makes each one a little less attractive than the last,
    // which is what a person actually experiences.
    let shown = EMPTY_SESSION;
    let previous = 1;
    for (let i = 0; i < 6; i++) {
      const penalty = sessionPenalty(shown, card('coffee', 'h1'), 0.8, 0.6);
      expect(penalty).toBeLessThanOrEqual(previous);
      expect(penalty).toBeGreaterThan(0);
      previous = penalty;
      shown = noteShown(shown, [card('coffee', 'h1')]);
    }
  });

  it('compounds category and host independently', () => {
    const shown = noteShown(EMPTY_SESSION, [card('coffee', 'h1'), card('coffee', 'h2')]);
    // coffee twice, h1 once.
    expect(sessionPenalty(shown, card('coffee', 'h1'), 0.8, 0.6))
      .toBeCloseTo(0.8 * 0.8 * 0.6, 12);
    // A different host in the same category pays only the category half.
    expect(sessionPenalty(shown, card('coffee', 'h9'), 0.8, 0.6))
      .toBeCloseTo(0.8 * 0.8, 12);
  });

  it('degrades gracefully at any session length', () => {
    // The failure the caps had: "max 2 per 8" is meaningless in a 3-card
    // session and inert in a 40-card one. There is no cliff here at any length.
    for (const length of [1, 3, 8, 40, 200]) {
      let shown = EMPTY_SESSION;
      for (let i = 0; i < length; i++) shown = noteShown(shown, [card('coffee', 'h1')]);
      const penalty = sessionPenalty(shown, card('coffee', 'h1'), 0.8, 0.6);
      expect(penalty).toBeGreaterThan(0);
      expect(Number.isFinite(penalty)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------

function scored(id: string, category: string, hostId: string, score: number): ScoredCandidate {
  return {
    candidate: {
      activityId: id, hostId, category, metrics: [category], shape: 'routine',
      distanceMiles: 1, startsAt: 0, timeBucket: 'morning', postedAt: 0,
      autoAcceptTrusted: false, impressionCount: 0,
      host: {
        hostId, acceptCount: 0, requestCount: 0, completedCount: 0, hostedCount: 0,
        verified: false, activeBuckets: [], neverShownToViewer: false,
      },
    },
    features: {} as ScoredCandidate['features'],
    funnel: { score } as ScoredCandidate['funnel'],
  };
}

describe('slate assembly under the penalties', () => {
  const params = resolveParams(1);
  const rng = () => mulberry32(1);

  it('never shortens the deck, whatever the pool looks like', () => {
    // The governing rule, now structural rather than maintained by a relaxation
    // ladder: a penalised card is still a card, so a short deck is impossible.
    const monoculture = Array.from({ length: 12 }, (_, i) =>
      scored(`m${i}`, 'coffee', 'h1', 1 - i * 0.01));

    const { cards, relaxations } = assembleSlate(monoculture, rng(), params, 8);
    expect(cards).toHaveLength(8);
    expect(relaxations).not.toContain('maxPerCategory');
    expect(relaxations).not.toContain('maxPerHost');
  });

  it('interleaves rather than running out the strongest category first', () => {
    // Five strong coffees and five slightly weaker hikes. Pure score order gives
    // all five coffees; the penalty pulls hiking up as coffee accumulates.
    const pool = [
      ...Array.from({ length: 5 }, (_, i) => scored(`c${i}`, 'coffee', `hc${i}`, 1.0 - i * 0.01)),
      ...Array.from({ length: 5 }, (_, i) => scored(`k${i}`, 'hiking', `hk${i}`, 0.9 - i * 0.01)),
    ];

    const { cards } = assembleSlate(pool, rng(), params, 6);
    const categories = cards.map((c) => c.candidate.category);

    expect(new Set(categories).size).toBe(2);
    expect(categories.filter((c) => c === 'coffee').length).toBeLessThan(6);
  });

  it('honours what earlier decks in the same session already showed', () => {
    const pool = [
      scored('c1', 'coffee', 'h1', 1.0),
      scored('k1', 'hiking', 'h2', 0.7),
    ];

    expect(assembleSlate(pool, rng(), params, 1).cards[0]!.candidate.activityId)
      .toBe('c1');

    // Three coffees already this session: 0.8^3 = 0.512, so 1.0 x 0.512 < 0.7.
    const shown = noteShown(EMPTY_SESSION, [
      card('coffee', 'hx'), card('coffee', 'hy'), card('coffee', 'hz'),
    ]);
    expect(assembleSlate(pool, rng(), params, 1, shown).cards[0]!.candidate.activityId)
      .toBe('k1');
  });

  it('is deterministic — same pool, same session, same deck', () => {
    const pool = Array.from({ length: 10 }, (_, i) =>
      scored(`p${i}`, i % 3 === 0 ? 'coffee' : 'hiking', `h${i % 4}`, 1 - i * 0.02));

    const a = assembleSlate(pool, rng(), params, 8).cards.map((c) => c.candidate.activityId);
    const b = assembleSlate(pool, rng(), params, 8).cards.map((c) => c.candidate.activityId);
    expect(b).toEqual(a);
  });

  it('falls back to plain score order when both penalties are 1', () => {
    // Village scale approaches this, and it is the sanity check that the
    // penalty is doing nothing when it is configured to do nothing.
    const inert = { ...params, categoryPenalty: 1, hostPenalty: 1, exploreEpsilon: 0 };
    const pool = Array.from({ length: 6 }, (_, i) =>
      scored(`p${i}`, 'coffee', 'h1', 1 - i * 0.1));

    expect(assembleSlate(pool, rng(), inert, 6).cards.map((c) => c.candidate.activityId))
      .toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5']);
  });
});

describe('the constants are marked UNMEASURED and stay honest', () => {
  it('both penalties are in (0, 1]', () => {
    for (const name of ['categoryPenalty', 'hostPenalty'] as const) {
      const value = CONSTANTS.collapsed[name];
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});
