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

import type {
  ActivityShape,
  Candidate,
  Epoch,
  ImpressionHistory,
  InterestEvent,
  InterestSource,
  InterestState,
  MetricSlug,
  RankingEventWrite,
  RankingDataPort,
  StoredRegimeState,
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
    /** Denormalised by trigger in the v1.6 migration — free on the bulk select. */
    confirmedJoiners: 'confirmed_joiners',
    targetJoiners: 'target_joiners',
  },
  joinRequests: {
    table: 'join_requests',
    activityId: 'activity_id',
    userId: 'user_id',
    status: 'status',
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
  };
}
