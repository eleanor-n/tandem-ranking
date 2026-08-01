/**
 * Hand-built fixtures. No random generation anywhere in the test suite — a test
 * that fails only on some seeds is a test nobody trusts.
 *
 * T0 is a fixed epoch so every age in the suite is exact. All other timestamps
 * are expressed as offsets from it.
 */

import type {
  Candidate,
  Epoch,
  HostSnapshot,
  InterestEvent,
  InterestSource,
  TimeBucket,
  Viewer,
} from '../../src/ranking/core/types.js';

/** 2026-01-01T12:00:00Z. Arbitrary, fixed, never "now". */
export const T0: Epoch = Date.UTC(2026, 0, 1, 12, 0, 0);

export const DAY = 86_400_000;
export const HOUR = 3_600_000;

/** An epoch `days` before T0. */
export const daysAgo = (days: number): Epoch => T0 - days * DAY;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

let eventSeq = 0;

export function makeEvent(overrides: Partial<InterestEvent> & {
  metric: string;
  source: InterestSource;
}): InterestEvent {
  eventSeq += 1;
  return {
    id: `e${eventSeq}`,
    userId: 'viewer',
    polarity: 1,
    weight: 1,
    createdAt: T0,
    ...overrides,
  };
}

/** `count` events on one metric, evenly spread over the last `spanDays`. */
export function spreadEvents(
  metric: string,
  source: InterestSource,
  count: number,
  spanDays: number,
  idPrefix: string,
): InterestEvent[] {
  const out: InterestEvent[] = [];
  for (let i = 0; i < count; i++) {
    // i = 0 is the oldest, at spanDays ago; the newest is at ~0 days ago.
    const age = count === 1 ? 0 : (spanDays * (count - 1 - i)) / (count - 1);
    out.push({
      id: `${idPrefix}${i}`,
      userId: 'viewer',
      metric,
      source,
      polarity: 1,
      weight: 1,
      createdAt: T0 - age * DAY,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export function makeHost(overrides: Partial<HostSnapshot> & { hostId: string }): HostSnapshot {
  return {
    acceptCount: 6,
    requestCount: 8,
    completedCount: 5,
    hostedCount: 6,
    verified: false,
    activeBuckets: ['morning'],
    neverShownToViewer: false,
    ...overrides,
  };
}

export function makeViewer(overrides: Partial<Viewer> = {}): Viewer {
  return {
    userId: 'viewer',
    idealSaturday: ['coffee_and_a_book'],
    tandemIntent: 'routine',
    friendWho: 'do_the_thing',
    verified: true,
    activeBuckets: ['morning'],
    seenHostIds: ['host_a', 'host_b', 'host_c', 'host_d', 'host_e'],
    trustedByHostIds: [],
    ...overrides,
  };
}

/** A viewer who has just finished onboarding: no history at all. */
export function coldStartViewer(): Viewer {
  return makeViewer({
    userId: 'newbie',
    idealSaturday: ['farmers_market_morning'],
    tandemIntent: 'routine',
    friendWho: null,
    verified: false,
    activeBuckets: [],
    seenHostIds: [],
  });
}

// ---------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------

export function makeCandidate(overrides: Partial<Candidate> & { activityId: string }): Candidate {
  const hostId = overrides.hostId ?? `host_${overrides.activityId}`;
  const category = overrides.category ?? 'coffee';
  return {
    hostId,
    category,
    metrics: [category],
    shape: 'routine',
    distanceMiles: 2,
    startsAt: T0 + 2 * DAY,
    timeBucket: 'morning' as TimeBucket,
    postedAt: T0 - 6 * HOUR,
    autoAcceptTrusted: false,
    impressionCount: 10,
    host: makeHost({ hostId }),
    ...overrides,
  };
}

/**
 * A twelve-card pool with deliberate structure:
 *   - four coffee, three fitness, two hiking, two concerts, one markets
 *   - two fresh hosts (host_f, host_g), both further away than the rest, so the
 *     fresh-host guarantee has to actively promote them rather than get them
 *     for free
 *   - distances increasing with index, so proximity order is index order
 */
export function standardPool(): Candidate[] {
  const spec: Array<[string, string, string, number, boolean]> = [
    // id,   category,   host,      miles, freshHost
    ['a01', 'coffee',   'host_a',   0.4, false],
    ['a02', 'coffee',   'host_b',   0.9, false],
    ['a03', 'fitness',  'host_c',   1.3, false],
    ['a04', 'coffee',   'host_a',   1.8, false],
    ['a05', 'hiking',   'host_d',   2.2, false],
    ['a06', 'fitness',  'host_e',   2.7, false],
    ['a07', 'markets',  'host_b',   3.1, false],
    ['a08', 'concerts', 'host_c',   3.6, false],
    ['a09', 'coffee',   'host_d',   4.0, false],
    ['a10', 'fitness',  'host_e',   4.5, false],
    ['a11', 'hiking',   'host_f',   5.2, true],
    ['a12', 'concerts', 'host_g',   6.0, true],
  ];

  return spec.map(([id, category, hostId, miles, fresh]) =>
    makeCandidate({
      activityId: id,
      category,
      metrics: [category],
      hostId,
      distanceMiles: miles,
      host: makeHost({ hostId, neverShownToViewer: fresh }),
    }),
  );
}
