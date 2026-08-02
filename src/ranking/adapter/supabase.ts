/**
 * The Supabase implementation of RankingDataPort. The ONLY file in this module
 * that knows Supabase exists.
 *
 * Two deliberate choices worth understanding before editing:
 *
 *   1. The client is structurally typed, not imported. `@supabase/supabase-js`
 *      is never imported here, so this package has zero runtime dependencies
 *      and stays installable in an Expo app without version-pinning against the
 *      host app's Supabase client. You pass in whatever client you already have.
 *
 *   2. Nothing here is Node-specific. No `crypto`, no `Buffer`, no `fs`. It runs
 *      on Hermes in an Expo build exactly as it runs in Node in a test.
 *
 * Column names are the guessable ones and are collected in COLUMNS below.
 * Reconcile them against the real schema before shipping — the schema was not
 * available when this was written.
 */

import { CONSTANTS } from '../core/constants.js';
import type {
  ActivityShape,
  Candidate,
  Epoch,
  GivenFeedback,
  ImpressionHistory,
  InterestEvent,
  InterestSource,
  InterestState,
  MetricSlug,
  RankingEventWrite,
  RankingDataPort,
  StoredRegimeState,
  TandemRecord,
  TimeBucket,
  UserId,
  Viewer,
} from '../core/types.js';

// ---------------------------------------------------------------------------
// Minimal structural type for the bit of the Supabase client we use.
// ---------------------------------------------------------------------------

export interface SupabaseLikeQuery {
  select(columns?: string): SupabaseLikeQuery;
  insert(values: unknown): PromiseLike<{ error: unknown }>;
  upsert(values: unknown, opts?: { onConflict?: string }): PromiseLike<{ error: unknown }>;
  delete(): SupabaseLikeQuery;
  eq(column: string, value: unknown): SupabaseLikeQuery;
  in(column: string, values: readonly unknown[]): SupabaseLikeQuery;
  gte(column: string, value: unknown): SupabaseLikeQuery;
  order(column: string, opts?: { ascending?: boolean }): SupabaseLikeQuery;
  limit(count: number): SupabaseLikeQuery;
  maybeSingle(): PromiseLike<{ data: unknown; error: unknown }>;
  then<R>(onfulfilled: (value: { data: unknown; error: unknown }) => R): PromiseLike<R>;
}

export interface SupabaseLike {
  from(table: string): SupabaseLikeQuery;
}

/**
 * Table and column names, in one place, so reconciling with the real schema is
 * a single edit rather than a grep.
 */
export const COLUMNS = {
  profiles: {
    table: 'profiles',
    id: 'id',
    verified: 'is_verified',           // set by the AWS Rekognition face check
    idealSaturday: 'ideal_saturday',
    tandemIntent: 'tandem_intent',
    friendWho: 'friend_who',
  },
  activities: {
    table: 'activities',
    id: 'id',
    hostId: 'host_id',
    category: 'category',
    startsAt: 'starts_at',
    createdAt: 'created_at',
    status: 'status',
    autoAcceptTrusted: 'auto_accept_trusted',
    lat: 'lat',
    lng: 'lng',
    /**
     * Denormalised by trigger, recounted rather than incremented — free on the
     * bulk select the deck already runs. This must never become a per-card
     * fetch: a ranking signal costing a round-trip per card is a ranking signal
     * that gets deleted the first time someone profiles Discover.
     */
    confirmedJoiners: 'confirmed_joiners',
    /**
     * Capacity. `max_participants` ALREADY EXISTS and already means "joiners
     * wanted, excluding the host" — 59 of 63 rows are 1. v1.6 added a
     * `target_joiners` column in ignorance of it; v1.7 drops that column.
     * Two columns for one fact is a data-integrity bug waiting for the first
     * row where they disagree. See SCHEMA.md §1.
     */
    targetJoiners: 'max_participants',
  },
  joinRequests: {
    table: 'join_requests',
    activityId: 'activity_id',
    userId: 'user_id',
    status: 'status',
    createdAt: 'created_at',
  },
  /**
   * The realised PAIRINGS, not the posts. `tandems.status` is the completion
   * signal for the entire system (SCHEMA.md §1) — `activities.status` was the
   * v1.6 guess and it was wrong.
   *
   * Strictly pairwise. A group tandem, when it arrives, is a clique of these
   * rows sharing `tandem_group_id`.
   */
  tandems: {
    table: 'tandems',
    id: 'id',
    userA: 'user_a_id',
    userB: 'user_b_id',
    status: 'status',
    /** [S1] Verified by PRECHECK P3. Absent -> the interest mirror no-ops. */
    activityId: 'activity_id',
    groupId: 'tandem_group_id',
    createdAt: 'created_at',
  },
  /** Already per-pair. Needed no migration; the check-in writes it as-is. */
  tandemFeedback: {
    table: 'tandem_feedback',
    tandemId: 'tandem_id',
    raterId: 'rater_id',
    ratedId: 'rated_id',
    response: 'response',
    createdAt: 'created_at',
  },
  interestEvents: { table: 'interest_events' },
  /**
   * THE impression table (SCHEMA.md §2). `feed_impressions` is deprecated and
   * has zero rows; two tables with overlapping jobs is how a training set ends
   * up split across schemas with no way to join it afterwards.
   */
  rankingEvents: { table: 'ranking_events' },
  interestState: { table: 'user_interest_state' },
} as const;

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const bool = (v: unknown): boolean => v === true;

/** Postgres timestamptz (ISO string) -> epoch ms. Invalid input becomes 0. */
export function toEpoch(v: unknown): Epoch {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return 0;
  const parsed = Date.parse(v);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** epoch ms -> ISO string for writing. Uses Date only at the I/O boundary. */
export function toIso(epoch: Epoch): string {
  return new Date(epoch).toISOString();
}

/** Local hour -> coarse time bucket. */
export function bucketForHour(hour: number): TimeBucket {
  if (hour < 7) return 'early_morning';
  if (hour < 11) return 'morning';
  if (hour < 14) return 'midday';
  if (hour < 17) return 'afternoon';
  if (hour < 21) return 'evening';
  return 'night';
}

export function rowToInterestEvent(row: Row): InterestEvent {
  return {
    id: str(row['id']),
    userId: str(row['user_id']),
    metric: str(row['metric']),
    source: str(row['source'], 'onboarding') as InterestSource,
    polarity: num(row['polarity'], 1) < 0 ? -1 : 1,
    weight: num(row['weight'], 1),
    createdAt: toEpoch(row['created_at']),
    ...(row['source_meta'] ? { sourceMeta: str(row['source_meta']) } : {}),
    ...(row['activity_id'] ? { activityId: str(row['activity_id']) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------

export interface SupabasePortOptions {
  /**
   * Resolve an activity row to the metrics it speaks to. Defaults to
   * [category], which is correct but coarse — override once activities carry
   * tags. Kept injectable so the taxonomy can live in the app, not here.
   */
  metricsForActivity?: (row: Row) => MetricSlug[];

  /** Resolve an activity row to its shape. Defaults to the category mapping. */
  shapeForActivity?: (row: Row) => ActivityShape | undefined;

  /**
   * Distance in miles from the viewer to an activity. Injected because the app
   * owns location permissions and the geo library; this module does no geo.
   */
  distanceMiles: (row: Row) => number;

  /** Generate an id for a new row. Injected: core/ and adapter/ own no UUID impl. */
  newId: () => string;

  /** How far back to pull candidate activities, in days. */
  candidateWindowDays?: number;
}

/**
 * Build a RankingDataPort backed by Supabase.
 *
 * Every method degrades to an empty result rather than throwing, because a
 * ranking layer that can take down the Discover tab is worse than a ranking
 * layer that occasionally ranks badly. Errors surface via `onError`.
 */
export function createSupabaseRankingPort(
  client: SupabaseLike,
  options: SupabasePortOptions,
  onError?: (where: string, error: unknown) => void,
): RankingDataPort {
  const metricsFor = options.metricsForActivity ?? ((row: Row) => [str(row['category'])]);
  const windowDays = options.candidateWindowDays ?? 30;

  const fail = (where: string, error: unknown) => { onError?.(where, error); };

  return {
    async loadViewer(userId: UserId): Promise<Viewer> {
      const empty: Viewer = {
        userId,
        idealSaturday: [],
        tandemIntent: null,
        friendWho: null,
        verified: false,
        activeBuckets: [],
        seenHostIds: [],
        trustedByHostIds: [],
      };

      try {
        const c = COLUMNS.profiles;
        const { data, error } = await client
          .from(c.table).select('*').eq(c.id, userId).maybeSingle();
        if (error || !data) { if (error) fail('loadViewer', error); return empty; }

        const row = data as Row;
        const ideal = row[c.idealSaturday];

        // Hosts the viewer has already been shown, from the impression log.
        const seen = await client
          .from(COLUMNS.rankingEvents.table)
          .select('host_id')
          .eq('user_id', userId)
          .eq('event_type', 'impression');
        const seenRows = ((seen as unknown as { data: Row[] | null }).data) ?? [];

        return {
          ...empty,
          idealSaturday: Array.isArray(ideal) ? ideal.map((x) => String(x)) : [],
          tandemIntent: (row[c.tandemIntent] as ActivityShape) ?? null,
          friendWho: row[c.friendWho] ? str(row[c.friendWho]) : null,
          verified: bool(row[c.verified]),
          seenHostIds: Array.from(new Set(seenRows.map((r) => str(r['host_id'])).filter(Boolean))),
        };
      } catch (error) {
        fail('loadViewer', error);
        return empty;
      }
    },

    async loadCandidates(userId: UserId, opts: { now: Epoch }): Promise<Candidate[]> {
      try {
        const a = COLUMNS.activities;
        const since = toIso(opts.now - windowDays * 86_400_000);
        const res = await client
          .from(a.table)
          .select('*')
          .gte(a.startsAt, since)
          .order(a.startsAt, { ascending: true })
          .limit(500);

        const rows = ((res as unknown as { data: Row[] | null }).data) ?? [];

        return rows
          .filter((row) => str(row[a.hostId]) !== userId)
          .map((row): Candidate => {
            const startsAt = toEpoch(row[a.startsAt]);
            return {
              activityId: str(row[a.id]),
              hostId: str(row[a.hostId]),
              category: str(row[a.category]),
              metrics: metricsFor(row),
              shape: options.shapeForActivity?.(row) ?? ('one_off' as ActivityShape),
              distanceMiles: options.distanceMiles(row),
              startsAt,
              timeBucket: bucketForHour(new Date(startsAt).getHours()),
              postedAt: toEpoch(row[a.createdAt]),
              autoAcceptTrusted: bool(row[a.autoAcceptTrusted]),
              impressionCount: num(row['impression_count'], 0),
              // Denormalised, so this costs nothing beyond the bulk select it
              // already rides on. Left undefined when the column is absent —
              // unknown must not read as "empty, boost it" (see demand.ts).
              ...(typeof row[a.confirmedJoiners] === 'number'
                ? { confirmedJoiners: num(row[a.confirmedJoiners], 0) }
                : {}),
              ...(typeof row[a.targetJoiners] === 'number'
                ? { targetJoiners: num(row[a.targetJoiners], 1) }
                : {}),
              host: {
                hostId: str(row[a.hostId]),
                acceptCount: num(row['host_accept_count'], 0),
                requestCount: num(row['host_request_count'], 0),
                completedCount: num(row['host_completed_count'], 0),
                hostedCount: num(row['host_hosted_count'], 0),
                verified: bool(row['host_verified']),
                activeBuckets: [],
                neverShownToViewer: false,
              },
            };
          });
      } catch (error) {
        fail('loadCandidates', error);
        return [];
      }
    },

    async loadInterestEvents(userId: UserId): Promise<InterestEvent[]> {
      try {
        const res = await client
          .from(COLUMNS.interestEvents.table)
          .select('*')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(2000);
        const rows = ((res as unknown as { data: Row[] | null }).data) ?? [];
        return rows.map(rowToInterestEvent);
      } catch (error) {
        fail('loadInterestEvents', error);
        return [];
      }
    },

    async loadInterestStateCache(userId: UserId): Promise<InterestState | null> {
      try {
        const { data, error } = await client
          .from(COLUMNS.interestState.table)
          .select('*').eq('user_id', userId).maybeSingle();
        if (error || !data) return null;
        const row = data as Row;
        return {
          userId,
          metrics: (row['state'] as InterestState['metrics']) ?? {},
          computedAt: toEpoch(row['computed_at']),
          eventCount: num(row['event_count'], 0),
          eventsHash: str(row['events_hash']),
          paramsFingerprint: str(row['params_fingerprint']),
          version: num(row['version'], 1),
        };
      } catch (error) {
        fail('loadInterestStateCache', error);
        return null;
      }
    },

    async saveInterestStateCache(state: InterestState): Promise<void> {
      try {
        const { error } = await client.from(COLUMNS.interestState.table).upsert({
          user_id: state.userId,
          state: state.metrics,
          event_count: state.eventCount,
          events_hash: state.eventsHash,
          params_fingerprint: state.paramsFingerprint,
          computed_at: toIso(state.computedAt),
          version: state.version,
        }, { onConflict: 'user_id' });
        if (error) fail('saveInterestStateCache', error);
      } catch (error) {
        fail('saveInterestStateCache', error);
      }
    },

    async appendInterestEvent(event): Promise<void> {
      try {
        const { error } = await client.from(COLUMNS.interestEvents.table).insert({
          id: event.id ?? options.newId(),
          user_id: event.userId,
          metric: event.metric,
          source: event.source,
          polarity: event.polarity,
          weight: event.weight,
          source_meta: event.sourceMeta ?? null,
          activity_id: event.activityId ?? null,
          created_at: toIso(event.createdAt),
        });
        if (error) fail('appendInterestEvent', error);
      } catch (error) {
        fail('appendInterestEvent', error);
      }
    },

    async listExplicitStatements(userId: UserId): Promise<InterestEvent[]> {
      try {
        const res = await client
          .from(COLUMNS.interestEvents.table)
          .select('*')
          .eq('user_id', userId)
          .eq('source', 'explicit_statement')
          .order('created_at', { ascending: false });
        const rows = ((res as unknown as { data: Row[] | null }).data) ?? [];
        return rows.map(rowToInterestEvent);
      } catch (error) {
        fail('listExplicitStatements', error);
        return [];
      }
    },

    async deleteExplicitStatement(userId: UserId, metric: MetricSlug): Promise<void> {
      try {
        // The RLS delete policy restricts this to the user's own explicit rows,
        // so a bug here cannot delete behavioural evidence.
        const res = await client
          .from(COLUMNS.interestEvents.table)
          .delete()
          .eq('user_id', userId)
          .eq('metric', metric)
          .eq('source', 'explicit_statement');
        const error = (res as unknown as { error?: unknown }).error;
        if (error) fail('deleteExplicitStatement', error);
      } catch (error) {
        fail('deleteExplicitStatement', error);
      }
    },

    async loadRegimeState(userId: UserId): Promise<StoredRegimeState | null> {
      try {
        const { data, error } = await client
          .from(COLUMNS.interestState.table)
          .select('coverage_ewma,last_regime,coverage_updated_at')
          .eq('user_id', userId).maybeSingle();
        if (error || !data) return null;
        const row = data as Row;
        return {
          coverageEwma: typeof row['coverage_ewma'] === 'number' ? row['coverage_ewma'] : null,
          lastRegime: typeof row['last_regime'] === 'number' ? row['last_regime'] : null,
          updatedAt: row['coverage_updated_at'] ? toEpoch(row['coverage_updated_at']) : null,
        };
      } catch (error) {
        fail('loadRegimeState', error);
        return null;
      }
    },

    async saveRegimeState(userId: UserId, state: StoredRegimeState): Promise<void> {
      try {
        const { error } = await client.from(COLUMNS.interestState.table).upsert({
          user_id: userId,
          coverage_ewma: state.coverageEwma,
          last_regime: state.lastRegime,
          coverage_updated_at: state.updatedAt !== null ? toIso(state.updatedAt) : null,
        }, { onConflict: 'user_id' });
        if (error) fail('saveRegimeState', error);
      } catch (error) {
        fail('saveRegimeState', error);
      }
    },

    async countRecentImpressions(
      userId: UserId, days: number, now: Epoch,
    ): Promise<ImpressionHistory> {
      try {
        const since = toIso(now - days * 86_400_000);
        const res = await client
          .from(COLUMNS.rankingEvents.table)
          .select('created_at')
          .eq('user_id', userId)
          .eq('event_type', 'impression')
          .gte('created_at', since);
        const rows = ((res as unknown as { data: Row[] | null }).data) ?? [];

        // Weeks of history is derived from the OLDEST impression in the window,
        // not from the row count — a user with 400 impressions all from
        // yesterday has one day of history, not twenty weeks of it.
        let oldest = now;
        for (const r of rows) {
          const t = toEpoch(r['created_at']);
          if (t > 0 && t < oldest) oldest = t;
        }
        return {
          count: rows.length,
          weeksOfHistory: (now - oldest) / (7 * 86_400_000),
        };
      } catch (error) {
        fail('countRecentImpressions', error);
        return { count: 0, weeksOfHistory: 0 };
      }
    },

    /**
     * ONE INSERT PER BATCH, never per card.
     *
     * Discover shows one card at a time, so a per-event write would be a network
     * round-trip per swipe. Everything above this is a buffer whose entire job is
     * to make this call rare; a single-row version of this method would exist
     * only to be misused.
     *
     * Errors are reported and swallowed — the buffered writer decides whether to
     * retry, and a rejected promise escaping here would surface a logging failure
     * to a user.
     */
    async logRankingEvents(events: readonly RankingEventWrite[]): Promise<void> {
      if (events.length === 0) return;
      try {
        const { error } = await client.from(COLUMNS.rankingEvents.table).insert(
          events.map((event) => ({
            user_id: event.userId,
            activity_id: event.activityId ?? null,
            host_id: event.hostId ?? null,
            event_type: event.eventType,
            deck_position: event.deckPosition ?? null,
            source: event.source ?? null,
            session_id: event.sessionId ?? null,
            score_snapshot: event.scoreSnapshot ?? null,
            created_at: toIso(event.createdAt),
          })),
        );
        if (error) fail('logRankingEvents', error);
      } catch (error) {
        fail('logRankingEvents', error);
      }
    },

    // -----------------------------------------------------------------------
    // Check-in data path (v1.7 §2.2)
    // -----------------------------------------------------------------------

    async loadCompletedTandems(userId: UserId): Promise<TandemRecord[]> {
      const t = COLUMNS.tandems;
      const a = COLUMNS.activities;

      try {
        // Two queries rather than a join: `tandems.activity_id` is unverified
        // ([S1]), and a join on a column that may not exist fails the whole
        // read. Fetched separately, a missing link degrades the CATEGORY and
        // END TIME to undefined — which checkin.ts already handles — instead of
        // costing the user their check-in entirely.
        const mine = async (column: string) => {
          const res = await client
            .from(t.table).select('*').eq(column, userId).eq(t.status, 'completed');
          return ((res as unknown as { data: Row[] | null }).data) ?? [];
        };

        const rows = [...await mine(t.userA), ...await mine(t.userB)];
        if (rows.length === 0) return [];

        const activityIds = Array.from(new Set(
          rows.map((r) => str(r[t.activityId])).filter(Boolean),
        ));

        const activities = new Map<string, Row>();
        if (activityIds.length > 0) {
          try {
            const res = await client
              .from(a.table).select('*').in(a.id, activityIds);
            for (const row of ((res as unknown as { data: Row[] | null }).data) ?? []) {
              activities.set(str(row[a.id]), row);
            }
          } catch (error) {
            // The link is a nice-to-have. Losing it costs the interest mirror,
            // not the check-in.
            fail('loadCompletedTandems.activities', error);
          }
        }

        const seen = new Set<string>();
        const out: TandemRecord[] = [];

        for (const row of rows) {
          const id = str(row[t.id]);
          if (!id || seen.has(id)) continue;      // a self-tandem would appear twice
          seen.add(id);

          const activityId = str(row[t.activityId]);
          const activity = activityId ? activities.get(activityId) : undefined;
          const endedAt = activity ? activityEndEpoch(activity) : undefined;

          out.push({
            tandemId: id,
            userAId: str(row[t.userA]),
            userBId: str(row[t.userB]),
            status: str(row[t.status]),
            ...(activityId ? { activityId } : {}),
            ...(activity ? { category: str(activity[a.category]) } : {}),
            ...(endedAt !== undefined ? { endedAt } : {}),
            createdAt: toEpoch(row[t.createdAt]),
          });
        }

        return out;
      } catch (error) {
        fail('loadCompletedTandems', error);
        return [];
      }
    },

    async loadGivenFeedback(userId: UserId): Promise<GivenFeedback[]> {
      const f = COLUMNS.tandemFeedback;
      try {
        const res = await client
          .from(f.table)
          .select(`${f.tandemId},${f.ratedId}`)
          .eq(f.raterId, userId);
        const rows = ((res as unknown as { data: Row[] | null }).data) ?? [];
        return rows.map((row) => ({
          tandemId: str(row[f.tandemId]),
          ratedId: str(row[f.ratedId]),
        }));
      } catch (error) {
        // Degrading to "nothing answered yet" would re-ask everyone. Degrading
        // to "everything answered" would ask nobody. The second is the quieter
        // failure and the one a user forgives, so the caller sees an empty list
        // only alongside an error, and getPendingCheckIns bails on it.
        fail('loadGivenFeedback', error);
        throw error;
      }
    },

    async writeCheckIn(answer): Promise<void> {
      const f = COLUMNS.tandemFeedback;
      const values = CONSTANTS.checkin.responseValues;   // [S4] see SCHEMA.md §5
      try {
        const { error } = await client.from(f.table).insert({
          [f.tandemId]: answer.tandemId,
          [f.raterId]: answer.raterId,
          [f.ratedId]: answer.ratedId,
          [f.response]: answer.positive ? values.positive : values.negative,
          [f.createdAt]: toIso(answer.createdAt),
        });
        if (error) fail('writeCheckIn', error);
      } catch (error) {
        fail('writeCheckIn', error);
      }
    },
  };
}

/**
 * When an activity ended.
 *
 * [S3] `activities` may have no end column at all — PRECHECK P5 settles it. The
 * fallback is start plus an assumed duration, and it is only ever used to
 * decide WHEN to ask, so being wrong delays or advances a prompt and cannot
 * corrupt an answer.
 */
function activityEndEpoch(row: Row): Epoch | undefined {
  for (const column of ['ends_at', 'end_time']) {
    const value = row[column];
    if (value) return toEpoch(value);
  }
  const startsAt = toEpoch(row[COLUMNS.activities.startsAt]);
  if (startsAt === 0) return undefined;
  return startsAt + CONSTANTS.checkin.assumedDurationHours * 3_600_000;
}
