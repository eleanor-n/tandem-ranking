/**
 * The never-empty guarantee.
 *
 * Isolated in its own file because it mocks the scoring module, and vi.mock is
 * hoisted to the top of whichever file declares it.
 *
 * This is the single most important behavioural test in the suite. Everything
 * else is about ranking well; this is about the Discover tab still working when
 * ranking fails.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/ranking/core/score.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ranking/core/score.js')>();
  return {
    ...actual,
    scoreCandidates: () => {
      throw new Error('simulated scoring failure');
    },
  };
});

const { rank } = await import('../src/ranking/core/rank.js');
const { CONSTANTS } = await import('../src/ranking/core/constants.js');
const { T0, makeViewer, standardPool } = await import('./fixtures/index.js');

describe('fallback', () => {
  it('scoring throwing produces a proximity-ordered, non-empty deck', () => {
    const onDegrade = vi.fn();

    const result = rank(
      {
        viewer: makeViewer(),
        candidates: standardPool(),
        interestEvents: [],
        sessionId: 'sess-1',
        now: T0,
      },
      {},
      onDegrade,
    );

    // Degraded, not broken.
    expect(result.slate.degraded).toBe(true);
    expect(result.slate.cards.length).toBe(CONSTANTS.slate.deckSize);

    // The failure is visible to the caller rather than silently swallowed.
    expect(onDegrade).toHaveBeenCalledOnce();

    // Fixture distances increase with activityId, so proximity order is id order.
    const ids = result.slate.cards.map((c) => c.activityId);
    expect(ids).toEqual([...ids].sort());

    // Still a true reason line on every card — just the generic one.
    expect(result.slate.cards.every((c) => c.reason.kind === 'category_fallback')).toBe(true);
  });

  it('degrades rather than throwing, even with a single candidate', () => {
    const result = rank({
      viewer: makeViewer(),
      candidates: standardPool().slice(0, 1),
      interestEvents: [],
      sessionId: 'sess-1',
      now: T0,
    });
    expect(result.slate.cards.length).toBe(1);
    expect(result.slate.degraded).toBe(true);
  });
});
