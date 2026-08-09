/**
 * The post-tandem check-in scheduler.
 *
 * The signal being scheduled here is the highest-weighted source in the entire
 * interest model and the only route the ranker has to pairwise compatibility.
 * Getting the timing wrong costs answer quality; getting the skip semantics
 * wrong costs answer honesty, which is worse and unrecoverable.
 */

import { describe, expect, it } from 'vitest';
import {
  askableFrom,
  askableUntil,
  checkInsToPrompt,
  nextSkipRetry,
  pendingCheckIns,
  skipSuppresses,
} from '../src/ranking/core/checkin.js';
import { CONSTANTS } from '../src/ranking/core/constants.js';
import type { CheckInSkip, GivenFeedback, TandemRecord } from '../src/ranking/core/types.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 6, 1, 12, 0, 0);

/** A skip with an explicit retry, since `retryAfter` is deliberately required. */
function skip(over: Partial<CheckInSkip> = {}): CheckInSkip {
  return { tandemId: 't1', raterId: 'u_me', retryAfter: null, ...over };
}

function tandem(over: Partial<TandemRecord> = {}): TandemRecord {
  return {
    tandemId: 't1',
    userAId: 'u_me',
    userBId: 'u_them',
    status: 'completed',
    activityId: 'a1',
    category: 'coffee',
    endedAt: T0 - 24 * HOUR,
    createdAt: T0 - 26 * HOUR,
    ...over,
  };
}

describe('when to ask', () => {
  it('waits the minimum elapsed time after the activity ended', () => {
    const min = CONSTANTS.checkin.minElapsedHours;
    const t = tandem({ endedAt: T0 - min * HOUR + 1 });   // one ms too soon

    expect(pendingCheckIns('u_me', [t], [], T0)).toEqual([]);
    expect(pendingCheckIns('u_me', [t], [], T0 + 1)).toHaveLength(1);
  });

  it('never asks about something that has not happened yet', () => {
    const future = tandem({ endedAt: T0 + 48 * HOUR });
    expect(pendingCheckIns('u_me', [future], [], T0)).toEqual([]);
  });

  it('falls back to created_at plus an assumed duration with no end time', () => {
    // [S3] activities may have no end column at all. Being wrong here delays or
    // advances a prompt; it cannot corrupt an answer.
    const { assumedDurationHours, minElapsedHours } = CONSTANTS.checkin;
    const t = tandem({ createdAt: T0 - 10 * HOUR });
    delete (t as { endedAt?: number }).endedAt;

    expect(askableFrom(t)).toBe(
      T0 - 10 * HOUR + (assumedDurationHours + minElapsedHours) * HOUR,
    );
    expect(pendingCheckIns('u_me', [t], [], T0)).toHaveLength(1);
  });

  it('only asks about completed tandems', () => {
    for (const status of ['pending', 'cancelled', 'accepted', 'no_show']) {
      expect(pendingCheckIns('u_me', [tandem({ status })], [], T0)).toEqual([]);
    }
  });
});

describe('who to ask about', () => {
  it('resolves exactly one counterpart, because tandems are pairwise', () => {
    const asA = pendingCheckIns('u_me', [tandem()], [], T0);
    expect(asA).toHaveLength(1);
    expect(asA[0]!.ratedId).toBe('u_them');

    const asB = pendingCheckIns('u_them', [tandem()], [], T0);
    expect(asB[0]!.ratedId).toBe('u_me');
    expect(asB[0]!.raterId).toBe('u_them');
  });

  it('ignores tandems the user was not part of', () => {
    const someoneElses = tandem({ userAId: 'u_x', userBId: 'u_y' });
    expect(pendingCheckIns('u_me', [someoneElses], [], T0)).toEqual([]);
  });

  it('carries the activity link through for the interest mirror', () => {
    const [p] = pendingCheckIns('u_me', [tandem()], [], T0);
    expect(p!.category).toBe('coffee');
    expect(p!.activityId).toBe('a1');
  });

  it('still asks when the activity link is missing — it just cannot mirror', () => {
    // [S1] tandems.activity_id is unverified. Losing it must cost the interest
    // event, not the check-in.
    const unlinked = tandem();
    delete (unlinked as { activityId?: string }).activityId;
    delete (unlinked as { category?: string }).category;

    const [p] = pendingCheckIns('u_me', [unlinked], [], T0);
    expect(p).toBeDefined();
    expect(p!.category).toBeUndefined();
  });
});

describe('asked once, and only once', () => {
  const given: GivenFeedback[] = [{ tandemId: 't1', ratedId: 'u_them' }];

  it('drops a pairing the rater has already answered', () => {
    expect(pendingCheckIns('u_me', [tandem()], given, T0)).toEqual([]);
  });

  it('does not confuse the two directions of the same tandem', () => {
    // u_me answered about u_them. u_them still owes an answer about u_me.
    expect(pendingCheckIns('u_them', [tandem()], given, T0)).toHaveLength(1);
  });

  it('a live skip suppresses the prompt', () => {
    expect(pendingCheckIns('u_me', [tandem()], [], T0, [])).toHaveLength(1);
    expect(pendingCheckIns('u_me', [tandem()], [], T0, [skip()])).toEqual([]);
  });

  it('a skip is NOT a negative — it produces no feedback and no polarity', () => {
    // The part that has not changed across three versions, and must not. The
    // type itself is the guarantee: there is no `ratedId` and no polarity to
    // misread, so a skip cannot become a rating by anyone later reading the
    // wrong column.
    expect(Object.keys(skip()).sort()).toEqual(['raterId', 'retryAfter', 'tandemId']);
    expect(skip()).not.toHaveProperty('ratedId');

    // And a skipped tandem leaves the OTHER direction untouched: u_me skipping
    // says nothing about what u_them owes.
    expect(pendingCheckIns('u_them', [tandem()], [], T0, [skip()])).toHaveLength(1);
  });
});

describe('the skip is SOFT (v1.9.1 §3)', () => {
  // v1.9 suppressed permanently. That was an error: `tandem_feedback` is the
  // only source of pairwise data in the system, and one mis-tap should not cost
  // one label forever. One dismissal is ambiguous; two is an answer.

  it('a first skip only delays — the check-in returns after skipRetryDays', () => {
    const retry = T0 + CONSTANTS.checkin.skipRetryDays * DAY;
    const one = [tandem()];

    expect(pendingCheckIns('u_me', one, [], T0, [skip({ retryAfter: retry })])).toEqual([]);
    // One millisecond before the retry: still suppressed.
    expect(pendingCheckIns('u_me', one, [], retry - 1, [skip({ retryAfter: retry })]))
      .toEqual([]);
    // At the retry instant: askable again. The boundary is inclusive, matching
    // `askableFrom`, so the two ends of the schedule agree about `now === t`.
    // The tandem is re-dated relative to the retry so the eligibility window is
    // not what is being measured here.
    const fresh = [tandem({ endedAt: retry - 24 * HOUR })];
    expect(pendingCheckIns('u_me', fresh, [], retry, [skip({ retryAfter: retry })]))
      .toHaveLength(1);
  });

  it('a second skip retires it permanently', () => {
    const farFuture = T0 + 3650 * DAY;
    expect(pendingCheckIns('u_me', [tandem({ endedAt: farFuture - 24 * HOUR })], [], farFuture,
      [skip({ retryAfter: null })])).toEqual([]);
  });

  it('nextSkipRetry escalates on the second skip and only then', () => {
    // The whole policy, as a pure function. Asymmetric on purpose.
    expect(nextSkipRetry(undefined, T0))
      .toBe(T0 + CONSTANTS.checkin.skipRetryDays * DAY);
    expect(nextSkipRetry(skip({ retryAfter: T0 + DAY }), T0)).toBeNull();
    expect(nextSkipRetry(skip({ retryAfter: null }), T0)).toBeNull();
  });

  it('a failed read of existing skips re-asks rather than retiring', () => {
    // `loadSkippedCheckIns` degrades to [] on error, so a second skip arrives
    // here looking like a first. That must produce a retry, not a retirement:
    // an extra prompt is an annoyance, a lost label is permanent. This pins the
    // direction of the degradation, which is the part that is easy to invert.
    expect(nextSkipRetry(undefined, T0)).not.toBeNull();
  });

  it('skipSuppresses reads null as forever and a past retry as askable', () => {
    expect(skipSuppresses(skip({ retryAfter: null }), T0)).toBe(true);
    expect(skipSuppresses(skip({ retryAfter: T0 + 1 }), T0)).toBe(true);
    expect(skipSuppresses(skip({ retryAfter: T0 - 1 }), T0)).toBe(false);
  });

  it('the retry is bounded by the eligibility window, not the other way round', () => {
    // skipRetryDays (5) < eligibilityWindowDays (7), so a retry only has room
    // when the skip happened early. A skip late in the window expires before it
    // can return, and that is intended: the window is the outer bound.
    expect(CONSTANTS.checkin.skipRetryDays)
      .toBeLessThan(CONSTANTS.checkin.eligibilityWindowDays);

    const endedAt = T0 - 6 * DAY;                 // 6 days old: still in window
    const retry = T0 + 2 * DAY;                   // retry lands outside it
    const t = [tandem({ endedAt })];
    expect(pendingCheckIns('u_me', t, [], T0, [skip({ retryAfter: retry })])).toEqual([]);
    expect(pendingCheckIns('u_me', t, [], retry + 1, [skip({ retryAfter: retry })])).toEqual([]);
  });
});

describe('pending check-ins expire (v1.9.1 §2)', () => {
  // Recall on a three-week-old tandem is poor, so those labels would be noise —
  // and noise is worse than absence here, because nothing downstream can tell a
  // guessed answer from a remembered one.

  it('drops a tandem older than the eligibility window', () => {
    const days = CONSTANTS.checkin.eligibilityWindowDays;
    const justInside = tandem({ endedAt: T0 - days * DAY + 1000 });
    const justOutside = tandem({ endedAt: T0 - days * DAY - 1000 });

    expect(pendingCheckIns('u_me', [justInside], [], T0)).toHaveLength(1);
    expect(pendingCheckIns('u_me', [justOutside], [], T0)).toEqual([]);
  });

  it('measures the window from the activity end, not from when it became askable', () => {
    // Otherwise minElapsedHours would silently extend the window, and "how long
    // ago did this happen" — the thing recall actually decays with — would stop
    // being what the constant means.
    const t = tandem({ endedAt: T0 - 3 * DAY });
    expect(askableUntil(t)).toBe(
      T0 - 3 * DAY + CONSTANTS.checkin.eligibilityWindowDays * DAY,
    );
  });

  it('uses the same end-time fallback as askableFrom when there is no end time', () => {
    // [S3] again. The two functions must not disagree about when the activity
    // ended, or a tandem could become askable and expire on different clocks.
    const t = tandem({ createdAt: T0 - 10 * HOUR });
    delete (t as { endedAt?: number }).endedAt;
    const assumedEnd = T0 - 10 * HOUR + CONSTANTS.checkin.assumedDurationHours * HOUR;

    expect(askableFrom(t)).toBe(assumedEnd + CONSTANTS.checkin.minElapsedHours * HOUR);
    expect(askableUntil(t)).toBe(assumedEnd + CONSTANTS.checkin.eligibilityWindowDays * DAY);
  });

  it('is what removes the ordering tradeoff, not just a filter', () => {
    // v1.9 documented a real cost of most-recent-first: with one prompt per app
    // open, an old check-in could be starved indefinitely by fresher arrivals.
    // With the window, the starved one is not waiting — it is gone. Nothing can
    // sit in the queue long enough to be permanently starved.
    const tandems = [
      tandem({ tandemId: 'fresh', endedAt: T0 - 3 * HOUR }),
      tandem({ tandemId: 'ancient', endedAt: T0 - 800 * HOUR }),
    ];
    expect(pendingCheckIns('u_me', tandems, [], T0).map((p) => p.tandemId))
      .toEqual(['fresh']);
  });
});

describe('order and volume', () => {
  it('asks MOST RECENT first — a check-in decays in usefulness', () => {
    // REVERSED in v1.9 §3. v1.7 asked oldest-first to stop a backlog becoming
    // permanent; that is a property of the QUEUE. Most-recent-first is a
    // property of the ANSWER, and with maxPromptsPerAppOpen = 1 only one of the
    // two is available. A six-week-old check-in answered from a vague memory is
    // a row of noise in the highest-weighted signal the system has.
    // All three inside `eligibilityWindowDays`, so this measures the ordering
    // and not the window — those are tested separately below.
    const tandems = [
      tandem({ tandemId: 'recent', endedAt: T0 - 3 * HOUR }),
      tandem({ tandemId: 'oldest', endedAt: T0 - 160 * HOUR }),
      tandem({ tandemId: 'middle', endedAt: T0 - 100 * HOUR }),
    ];
    expect(pendingCheckIns('u_me', tandems, [], T0).map((p) => p.tandemId))
      .toEqual(['recent', 'middle', 'oldest']);
  });

  it('the freshest check-in is the one that actually gets asked', () => {
    // The consequence of the ordering, stated separately because it is what
    // matters: the user only ever sees slice(0, 1) of the above.
    const tandems = [
      tandem({ tandemId: 'last_week', endedAt: T0 - 160 * HOUR }),
      tandem({ tandemId: 'yesterday', endedAt: T0 - 26 * HOUR }),
    ];
    const prompted = checkInsToPrompt(pendingCheckIns('u_me', tandems, [], T0));
    expect(prompted.map((p) => p.tandemId)).toEqual(['yesterday']);
  });

  it('surfaces one per app open, not the backlog', () => {
    // Five check-ins on launch is an interrogation, and the second answer is
    // already worse than the first.
    const tandems = Array.from({ length: 5 }, (_, i) =>
      tandem({ tandemId: `t${i}`, endedAt: T0 - (i + 10) * HOUR }));

    const pending = pendingCheckIns('u_me', tandems, [], T0);
    expect(pending).toHaveLength(5);
    expect(checkInsToPrompt(pending))
      .toHaveLength(CONSTANTS.checkin.maxPromptsPerAppOpen);
  });

  it('is deterministic when two tandems ended at the same instant', () => {
    const tandems = [
      tandem({ tandemId: 'b' }),
      tandem({ tandemId: 'a' }),
    ];
    expect(pendingCheckIns('u_me', tandems, [], T0).map((p) => p.tandemId))
      .toEqual(['a', 'b']);
  });
});

describe('the interest mirror keeps its weights', () => {
  it('maps to source slugs that exist in the weight table', () => {
    // THE DRIFT GUARD. `tandem-matching-v2-framework.md` §1.2 says
    // `checkin_positive` / `checkin_negative`; the canonical slugs are
    // `checkin_yes` / `checkin_no` (SCHEMA.md §6). The wrong names have been
    // reintroduced three builds running because that document gets re-read each
    // pass.
    //
    // The failure they cause is invisible: a source with no entry in the weight
    // table folds in at ZERO weight. Rows appear, counts look right, and the
    // single most predictive signal in the system contributes nothing. There is
    // no error to notice.
    //
    // `constants.ts` also pins this at COMPILE time with `satisfies
    // Record<'positive' | 'negative', InterestSource>`. This test covers the
    // case that clause cannot: someone widening the `InterestSource` union
    // without adding the matching `interest.sources` entry.
    const { positive, negative } = CONSTANTS.checkin.interestSource;
    const sources = CONSTANTS.interest.sources as Record<string, { weight: number }>;

    for (const slug of [positive, negative]) {
      expect(sources, `${slug} has no entry — it would fold in at zero weight`)
        .toHaveProperty(slug);
      expect(sources[slug]!.weight, `${slug} carries no weight`).toBeGreaterThan(0);
    }
  });

  it('gives the check-in the heaviest weight in the table', () => {
    const weights = Object.values(CONSTANTS.interest.sources).map((s) => s.weight);
    const yes = CONSTANTS.interest.sources[
      CONSTANTS.checkin.interestSource.positive as 'checkin_yes'
    ];
    expect(yes.weight).toBe(Math.max(...weights));
  });
});
