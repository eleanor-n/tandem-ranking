/**
 * Adapter tests.
 *
 * WHY THESE DID NOT EXIST UNTIL v1.9
 *
 * `core/` has 200 tests and `adapter/` had none. The stated reason was that the
 * adapter is "just I/O" and the structural `SupabaseLike` type keeps it honest.
 *
 * The type checks the SHAPE of the query builder. It cannot check the SHAPE OF
 * THE QUERY, and that is where the bug was: `loadCandidates` paged 500 rows
 * ordered by `starts_at` with no spatial predicate, so a proximity-first ranker
 * was handed a set selected by time. Typechecks clean, runs fast, returns the
 * wrong candidates. It took a read-through audit to find, and a test like the
 * ones below would have caught it the day it was written.
 *
 * These assert the QUERIES, not the results: which columns are filtered, with
 * which operators, and whether the result set is bounded. That is the class of
 * defect the adapter is actually prone to.
 */

import { describe, expect, it } from 'vitest';
import {
  CANDIDATE_LIMIT,
  SEEN_HOST_ROW_LIMIT,
  SEEN_HOST_WINDOW_DAYS,
  SPATIAL_FILTER_UNBOUNDED,
  createSupabaseRankingPort,
  type SupabaseLike,
  type SupabaseLikeQuery,
} from '../src/ranking/adapter/supabase.js';
import { createRankingClient } from '../src/ranking/adapter/index.js';
import { CONSTANTS } from '../src/ranking/core/constants.js';
import type { CheckInSkip, RankingDataPort } from '../src/ranking/core/types.js';

// ---------------------------------------------------------------------------
// A recording fake
// ---------------------------------------------------------------------------

interface Call { op: string; args: unknown[] }

interface Recorded {
  table: string;
  calls: Call[];
}

/** Every filter applied to a query, as `op:column` -> value. */
function filters(rec: Recorded): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const c of rec.calls) {
    if (['eq', 'gte', 'lte', 'in'].includes(c.op)) {
      out.set(`${c.op}:${String(c.args[0])}`, c.args[1]);
    }
  }
  return out;
}

function opArg(rec: Recorded, op: string): unknown {
  return rec.calls.find((c) => c.op === op)?.args[0];
}

function makeClient(rowsFor: (table: string) => unknown[]): {
  client: SupabaseLike;
  recorded: Recorded[];
} {
  const recorded: Recorded[] = [];

  const build = (table: string): SupabaseLikeQuery => {
    const rec: Recorded = { table, calls: [] };
    recorded.push(rec);

    const data = () => ({ data: rowsFor(table), error: null });

    const q: SupabaseLikeQuery = {
      select: (...a: unknown[]) => { rec.calls.push({ op: 'select', args: a }); return q; },
      insert: (...a: unknown[]) => {
        rec.calls.push({ op: 'insert', args: a });
        return Promise.resolve({ error: null });
      },
      upsert: (...a: unknown[]) => {
        rec.calls.push({ op: 'upsert', args: a });
        return Promise.resolve({ error: null });
      },
      delete: (...a: unknown[]) => { rec.calls.push({ op: 'delete', args: a }); return q; },
      eq: (...a: unknown[]) => { rec.calls.push({ op: 'eq', args: a }); return q; },
      in: (...a: unknown[]) => { rec.calls.push({ op: 'in', args: a }); return q; },
      gte: (...a: unknown[]) => { rec.calls.push({ op: 'gte', args: a }); return q; },
      lte: (...a: unknown[]) => { rec.calls.push({ op: 'lte', args: a }); return q; },
      order: (...a: unknown[]) => { rec.calls.push({ op: 'order', args: a }); return q; },
      limit: (...a: unknown[]) => { rec.calls.push({ op: 'limit', args: a }); return q; },
      maybeSingle: () => {
        rec.calls.push({ op: 'maybeSingle', args: [] });
        const rows = rowsFor(table);
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      then: <R,>(onfulfilled: (v: { data: unknown; error: unknown }) => R) =>
        Promise.resolve(data()).then(onfulfilled),
    } as SupabaseLikeQuery;

    return q;
  };

  return { client: { from: build }, recorded };
}

const NOW = 1_760_000_000_000;

function activityRow(i: number): Record<string, unknown> {
  return {
    id: `a${i}`, host_id: `h${i}`, category: 'coffee',
    starts_at: new Date(NOW + 86_400_000).toISOString(),
    created_at: new Date(NOW - 86_400_000).toISOString(),
    lat: 40.7, lng: -73.9, auto_accept_trusted: false,
    confirmed_joiners: 0, max_participants: 1,
  };
}

function makePort(opts: {
  activities?: unknown[];
  seen?: unknown[];
  bounds?: { minLat: number; maxLat: number; minLng: number; maxLng: number } | null;
  onError?: (where: string, e: unknown) => void;
}) {
  const { client, recorded } = makeClient((table) => {
    if (table === 'activities') return opts.activities ?? [];
    if (table === 'ranking_events') return opts.seen ?? [];
    if (table === 'profiles') return [{ id: 'u1', is_verified: true, ideal_saturday: [] }];
    return [];
  });

  const port = createSupabaseRankingPort(
    client,
    {
      distanceMiles: () => 1,
      newId: () => 'id',
      now: () => NOW,
      ...(opts.bounds !== undefined
        ? { viewerBounds: () => opts.bounds ?? null }
        : {}),
    },
    opts.onError,
  );

  return { port, recorded };
}

// ---------------------------------------------------------------------------

describe('loadCandidates spatial filtering (PERF.md §1)', () => {
  it('puts the bounding box in the WHERE clause, not in client-side code', () => {
    const { port, recorded } = makePort({
      bounds: { minLat: 40.5, maxLat: 40.9, minLng: -74.1, maxLng: -73.7 },
    });

    return port.loadCandidates('u1', { now: NOW }).then(() => {
      const rec = recorded.find((r) => r.table === 'activities') as Recorded;
      const f = filters(rec);

      expect(f.get('gte:lat')).toBe(40.5);
      expect(f.get('lte:lat')).toBe(40.9);
      expect(f.get('gte:lng')).toBe(-74.1);
      expect(f.get('lte:lng')).toBe(-73.7);
    });
  });

  it('still bounds the page, so the box cannot be a licence to return everything', () => {
    const { port, recorded } = makePort({
      bounds: { minLat: 0, maxLat: 1, minLng: 0, maxLng: 1 },
    });
    return port.loadCandidates('u1', { now: NOW }).then(() => {
      const rec = recorded.find((r) => r.table === 'activities') as Recorded;
      expect(opArg(rec, 'limit')).toBe(CANDIDATE_LIMIT);
    });
  });

  it('omits the box entirely when none is supplied, rather than inventing one', () => {
    // Guessing a box from the activity set would be worse than not filtering:
    // it would look filtered and be arbitrary. This module does no geo.
    const { port, recorded } = makePort({ bounds: null });
    return port.loadCandidates('u1', { now: NOW }).then(() => {
      const rec = recorded.find((r) => r.table === 'activities') as Recorded;
      const f = filters(rec);
      expect(f.has('gte:lat')).toBe(false);
      expect(f.has('lte:lng')).toBe(false);
    });
  });

  it('stays SILENT when unbounded but the page did not fill', () => {
    // Below the limit the unfiltered query is exactly correct — every activity
    // in the window came back. Warning here would train people to ignore it.
    const errors: string[] = [];
    const { port } = makePort({
      bounds: null,
      activities: Array.from({ length: 10 }, (_, i) => activityRow(i)),
      onError: (where) => errors.push(where),
    });
    return port.loadCandidates('u1', { now: NOW }).then(() => {
      expect(errors).not.toContain(SPATIAL_FILTER_UNBOUNDED);
    });
  });

  it('RAISES when unbounded and the page filled — the moment the bug goes live', () => {
    const errors: string[] = [];
    const { port } = makePort({
      bounds: null,
      activities: Array.from({ length: CANDIDATE_LIMIT }, (_, i) => activityRow(i)),
      onError: (where) => errors.push(where),
    });
    return port.loadCandidates('u1', { now: NOW }).then(() => {
      expect(errors).toContain(SPATIAL_FILTER_UNBOUNDED);
    });
  });

  it('does not raise when the page filled but a box WAS supplied', () => {
    const errors: string[] = [];
    const { port } = makePort({
      bounds: { minLat: 0, maxLat: 90, minLng: -180, maxLng: 180 },
      activities: Array.from({ length: CANDIDATE_LIMIT }, (_, i) => activityRow(i)),
      onError: (where) => errors.push(where),
    });
    return port.loadCandidates('u1', { now: NOW }).then(() => {
      expect(errors).not.toContain(SPATIAL_FILTER_UNBOUNDED);
    });
  });

  it('never returns the viewer their own posts', () => {
    const mine = { ...activityRow(1), host_id: 'u1' };
    const { port } = makePort({ bounds: null, activities: [mine, activityRow(2)] });
    return port.loadCandidates('u1', { now: NOW }).then((cands) => {
      expect(cands.map((c) => c.hostId)).not.toContain('u1');
      expect(cands).toHaveLength(1);
    });
  });
});

describe('loadViewer seenHostIds is bounded (PERF.md §2)', () => {
  it('bounds by time AND by row count', () => {
    const { port, recorded } = makePort({ seen: [] });
    return port.loadViewer('u1').then(() => {
      const rec = recorded.find((r) => r.table === 'ranking_events') as Recorded;
      expect(rec).toBeDefined();

      const f = filters(rec);
      expect(f.get('eq:user_id')).toBe('u1');
      expect(f.get('eq:event_type')).toBe('impression');

      const since = f.get('gte:created_at');
      expect(typeof since).toBe('string');
      const expected = new Date(NOW - SEEN_HOST_WINDOW_DAYS * 86_400_000).toISOString();
      expect(since).toBe(expected);

      expect(opArg(rec, 'limit')).toBe(SEEN_HOST_ROW_LIMIT);
    });
  });

  it('dedupes host ids rather than returning one entry per impression', () => {
    const seen = [
      { host_id: 'h1' }, { host_id: 'h1' }, { host_id: 'h1' }, { host_id: 'h2' },
    ];
    const { port } = makePort({ seen });
    return port.loadViewer('u1').then((v) => {
      expect(v.seenHostIds.sort()).toEqual(['h1', 'h2']);
    });
  });

  it('selects only host_id, not the whole event row', () => {
    // The rows are discarded down to a Set of ids; pulling score_snapshot jsonb
    // across the wire to do that would be the expensive version of this query.
    const { port, recorded } = makePort({ seen: [] });
    return port.loadViewer('u1').then(() => {
      const rec = recorded.find((r) => r.table === 'ranking_events') as Recorded;
      expect(opArg(rec, 'select')).toBe('host_id');
    });
  });
});

describe('failure is contained', () => {
  it('a throwing client degrades to an empty deck rather than taking Discover down', () => {
    const client: SupabaseLike = {
      from: () => { throw new Error('network'); },
    };
    const errors: string[] = [];
    const port = createSupabaseRankingPort(
      client,
      { distanceMiles: () => 1, newId: () => 'id', now: () => NOW },
      (where) => errors.push(where),
    );
    return port.loadCandidates('u1', { now: NOW }).then((cands) => {
      expect(cands).toEqual([]);
      expect(errors).toContain('loadCandidates');
    });
  });
});

// ---------------------------------------------------------------------------
// v1.9 §3 — the check-in write path
// ---------------------------------------------------------------------------

describe('check-in writes (v1.9 §3)', () => {
  function port(opts: { skips?: unknown[] } = {}) {
    const { client, recorded } = makeClient((table) => {
      if (table === 'checkin_skips') return opts.skips ?? [];
      return [];
    });
    return {
      p: createSupabaseRankingPort(
        client,
        { distanceMiles: () => 1, newId: () => 'id', now: () => NOW },
      ),
      recorded,
    };
  }

  it('an answer UPSERTS on (tandem_id, rater_id), so a double-tap is one row', () => {
    // A double-tap and a retry-after-a-timeout-that-actually-succeeded both
    // produce a second write no client-side guard prevents — and
    // `tandem_feedback` row count is the beta's headline metric, so
    // double-counting there overstates the one number anybody is watching.
    const { p, recorded } = port();
    return p.writeCheckIn({
      tandemId: 't1', raterId: 'u1', ratedId: 'u2', positive: true, createdAt: NOW,
    }).then(() => {
      const rec = recorded.find((r) => r.table === 'tandem_feedback') as Recorded;
      const upsert = rec.calls.find((c) => c.op === 'upsert');
      expect(upsert, 'must upsert, not insert').toBeDefined();
      expect(rec.calls.find((c) => c.op === 'insert')).toBeUndefined();
      expect((upsert!.args[1] as { onConflict: string }).onConflict)
        .toBe('tandem_id,rater_id');
    });
  });

  it('a SKIP writes checkin_skips and touches NOTHING else', () => {
    // The load-bearing assertion in this file. A skip must not reach
    // tandem_feedback (it would inflate the headline metric) and must not reach
    // interest_events (it would become a negative rating).
    const { p, recorded } = port();
    return p.writeCheckInSkip({
      tandemId: 't1', raterId: 'u1', createdAt: NOW, retryAfter: NOW + 1000,
    }).then(() => {
      const tables = recorded.map((r) => r.table);
      expect(tables).toContain('checkin_skips');
      expect(tables).not.toContain('tandem_feedback');
      expect(tables).not.toContain('interest_events');
    });
  });

  it('the skip row carries no rated_id and no polarity', () => {
    const { p, recorded } = port();
    return p.writeCheckInSkip({
      tandemId: 't1', raterId: 'u1', createdAt: NOW, retryAfter: NOW + 1000,
    }).then(() => {
      const rec = recorded.find((r) => r.table === 'checkin_skips') as Recorded;
      const written = rec.calls.find((c) => c.op === 'upsert')!.args[0] as Record<string, unknown>;
      expect(Object.keys(written).sort())
        .toEqual(['created_at', 'rater_id', 'retry_after', 'tandem_id']);
      expect(written).not.toHaveProperty('rated_id');
      expect(written).not.toHaveProperty('response');
      expect(written).not.toHaveProperty('polarity');
    });
  });

  it('a retirement writes SQL NULL, not a missing column (v1.9.1 §3)', () => {
    // The second skip is an UPDATE onto an existing row. If `retry_after` were
    // omitted from the payload rather than sent as null, the upsert would leave
    // the first skip's retry in place and the check-in would come back a third
    // time — the exact behaviour the retirement exists to stop.
    const { p, recorded } = port();
    return p.writeCheckInSkip({
      tandemId: 't1', raterId: 'u1', createdAt: NOW, retryAfter: null,
    }).then(() => {
      const rec = recorded.find((r) => r.table === 'checkin_skips') as Recorded;
      const written = rec.calls.find((c) => c.op === 'upsert')!.args[0] as Record<string, unknown>;
      expect('retry_after' in written).toBe(true);
      expect(written['retry_after']).toBeNull();
    });
  });

  it('loading skips filters to the one user and carries raterId and retryAfter back', () => {
    const iso = new Date(NOW + 5 * 86_400_000).toISOString();
    const { p, recorded } = port({
      skips: [
        { tandem_id: 't1', rater_id: 'u1', retry_after: iso },
        { tandem_id: 't2', rater_id: 'u1', retry_after: null },
      ],
    });
    return p.loadSkippedCheckIns('u1').then((skips) => {
      const rec = recorded.find((r) => r.table === 'checkin_skips') as Recorded;
      expect(filters(rec).get('eq:rater_id')).toBe('u1');
      // raterId is carried so pendingCheckIns can filter rather than trust:
      // both directions of a tandem share a tandemId.
      //
      // retryAfter must come back as null and NOT as 0. `toEpoch` maps anything
      // unparseable to 0, which here would read as "askable since 1970" and
      // silently un-retire every retired skip — hence `epochOrNull`.
      expect(skips).toEqual([
        { tandemId: 't1', raterId: 'u1', retryAfter: NOW + 5 * 86_400_000 },
        { tandemId: 't2', raterId: 'u1', retryAfter: null },
      ]);
    });
  });

  it('a failing skip load degrades to "nothing skipped", which re-asks', () => {
    // Of the two failure directions this is the recoverable one: an extra
    // prompt is an annoyance, a check-in silently never asked is a permanently
    // missing row in the highest-weighted signal in the model.
    const client: SupabaseLike = { from: () => { throw new Error('down'); } };
    const errors: string[] = [];
    const p = createSupabaseRankingPort(
      client,
      { distanceMiles: () => 1, newId: () => 'id', now: () => NOW },
      (where) => errors.push(where),
    );
    return p.loadSkippedCheckIns('u1').then((skips) => {
      expect(skips).toEqual([]);
      expect(errors).toContain('loadSkippedCheckIns');
    });
  });
});

// ---------------------------------------------------------------------------
// The client's skip escalation (v1.9.1 §3)
// ---------------------------------------------------------------------------
// `nextSkipRetry` is tested pure in checkin.test.ts and `writeCheckInSkip` is
// tested above. What is untested by either is the GLUE: skipCheckIn reads the
// existing skips, decides, and writes. That composition is where a soft skip
// silently becomes a hard one — read the wrong user's rows, or forget to read
// at all, and every skip looks like a first skip forever.

describe('skipCheckIn escalates on the second skip', () => {
  function client(existing: CheckInSkip[]) {
    const writes: Array<{ tandemId: string; raterId: string; retryAfter: number | null }> = [];
    const loadedFor: string[] = [];
    const port = {
      async loadSkippedCheckIns(userId: string) {
        loadedFor.push(userId);
        return existing.filter((s) => s.raterId === userId);
      },
      async writeCheckInSkip(skip: {
        tandemId: string; raterId: string; createdAt: number; retryAfter: number | null;
      }) {
        writes.push({
          tandemId: skip.tandemId, raterId: skip.raterId, retryAfter: skip.retryAfter,
        });
      },
    } as unknown as RankingDataPort;
    return {
      ranking: createRankingClient({ port, now: () => NOW }),
      writes,
      loadedFor,
    };
  }

  it('a first skip writes a retry, not a retirement', () => {
    const { ranking, writes, loadedFor } = client([]);
    return ranking.skipCheckIn('t1', 'u1').then(() => {
      expect(loadedFor).toEqual(['u1']);
      expect(writes).toEqual([{
        tandemId: 't1',
        raterId: 'u1',
        retryAfter: NOW + CONSTANTS.checkin.skipRetryDays * 86_400_000,
      }]);
    });
  });

  it('a second skip on the same pair retires it', () => {
    const { ranking, writes } = client([
      { tandemId: 't1', raterId: 'u1', retryAfter: NOW + 1000 },
    ]);
    return ranking.skipCheckIn('t1', 'u1').then(() => {
      expect(writes[0]!.retryAfter).toBeNull();
    });
  });

  it('a skip on a DIFFERENT tandem is still a first skip', () => {
    // The lookup must key on the pair, not just the user. Matching on rater
    // alone would retire a check-in the person has never dismissed.
    const { ranking, writes } = client([
      { tandemId: 't_other', raterId: 'u1', retryAfter: NOW + 1000 },
    ]);
    return ranking.skipCheckIn('t1', 'u1').then(() => {
      expect(writes[0]!.retryAfter).not.toBeNull();
    });
  });

  it("someone else's skip on the same tandem does not retire mine", () => {
    // Both directions of a tandem share a tandemId. Keying on it alone would
    // let one person's dismissal retire their counterpart's — the same pairwise
    // bug the CheckInSkip type was reshaped to prevent, one layer up.
    const { ranking, writes } = client([
      { tandemId: 't1', raterId: 'u_other', retryAfter: NOW + 1000 },
    ]);
    return ranking.skipCheckIn('t1', 'u1').then(() => {
      expect(writes[0]!.retryAfter).not.toBeNull();
    });
  });
});
