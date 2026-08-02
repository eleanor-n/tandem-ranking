/**
 * The post-tandem check-in scheduler.
 *
 * The signal being scheduled here is the highest-weighted source in the entire
 * interest model and the only route the ranker has to pairwise compatibility.
 * Getting the timing wrong costs answer quality; getting the skip semantics
 * wrong costs answer honesty, which is worse and unrecoverable.
 */

import { describe, expect, it } from 'vitest';
import { askableFrom, checkInsToPrompt, pendingCheckIns } from '../src/ranking/core/checkin.js';
import { CONSTANTS } from '../src/ranking/core/constants.js';
import type { GivenFeedback, TandemRecord } from '../src/ranking/core/types.js';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 6, 1, 12, 0, 0);

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

  it('a SKIP writes nothing, so it comes back next time', () => {
    // The whole design of skip: a person who did not answer is not a person who
    // said no. Storing a skip as a negative teaches people that answering
    // honestly has consequences, and then the signal is worthless.
    const afterSkip: GivenFeedback[] = [];
    expect(pendingCheckIns('u_me', [tandem()], afterSkip, T0)).toHaveLength(1);
  });
});

describe('order and volume', () => {
  it('asks oldest first — a check-in decays in usefulness', () => {
    const tandems = [
      tandem({ tandemId: 'recent', endedAt: T0 - 3 * HOUR }),
      tandem({ tandemId: 'ancient', endedAt: T0 - 800 * HOUR }),
      tandem({ tandemId: 'middle', endedAt: T0 - 100 * HOUR }),
    ];
    expect(pendingCheckIns('u_me', tandems, [], T0).map((p) => p.tandemId))
      .toEqual(['ancient', 'middle', 'recent']);
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
  it('maps to the source slugs that actually carry weight', () => {
    // SCHEMA.md §6. The build prompt names checkin_positive/checkin_negative;
    // this repo's INTEREST_SOURCES table is keyed checkin_yes/checkin_no. Rows
    // written under the other names would match no entry and fold in at ZERO
    // weight — the most predictive signal in the system, silently contributing
    // nothing.
    const { positive, negative } = CONSTANTS.checkin.interestSource;
    expect(CONSTANTS.interest.sources).toHaveProperty(positive);
    expect(CONSTANTS.interest.sources).toHaveProperty(negative);

    const sources = CONSTANTS.interest.sources as Record<string, { weight: number }>;
    expect(sources[positive]!.weight).toBeGreaterThan(0);
    expect(sources[negative]!.weight).toBeGreaterThan(0);
  });

  it('gives the check-in the heaviest weight in the table', () => {
    const weights = Object.values(CONSTANTS.interest.sources).map((s) => s.weight);
    const yes = CONSTANTS.interest.sources[
      CONSTANTS.checkin.interestSource.positive as 'checkin_yes'
    ];
    expect(yes.weight).toBe(Math.max(...weights));
  });
});
