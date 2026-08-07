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
  CheckInSkip,
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
  /** Added in v1.9 for the `loadCandidates` bounding box. See PERF.md §1. */
  lte(column: string, value: unknown): SupabaseLikeQuery;
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
  /**
   * v1.9 §3. Its own table rather than a `response` value on `tandem_feedback`,
   * because `tandem_feedback` row count is the beta's headline health metric
   * and a skip is not an answer. See the v1.9 migration header.
   */
  checkinSkips: {
    table: 'checkin_skips',
    tandemId: 'tandem_id',
    raterId: 'rater_id',
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

/** A latitude/longitude box in degrees. Inclusive on all four sides. */
export interface SpatialBounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/**
 * Raised through `onError` when a full candidate page comes back and no
 * bounding box was supplied — i.e. the exact condition under which the deck
 * silently stops being proximity-filtered. Distinct string so the app can alert
 * on it rather than treating it as one more transient query failure.
 */
export const SPATIAL_FILTER_UNBOUNDED = 'loadCandidates:unbounded-full-page';

/**
 * Page size for the candidate pull. Named because the failure mode in PERF.md
 * §1 is precisely "the page filled up", and a magic 500 buried in a query chain
 * makes that condition impossible to talk about.
 */
export const CANDIDATE_LIMIT = 500;

/**
 * How far back `seenHostIds` looks. PERF.md §2.
 *
 * 90 days because `neverShownToViewer` is a fairness signal rather than a
 * memory — a host the viewer has not seen in three months is functionally
 * fresh to them.
 */
export const SEEN_HOST_WINDOW_DAYS = 90;

/**
 * Belt and braces on the same query. The window bounds it in TIME; this bounds
 * it in ROWS, so a single hyperactive account cannot reintroduce the unbounded
 * transfer inside the window. Truncation is safe here in a way it is not
 * elsewhere: a missing id makes a host read as fresh, which is the direction
 * that shows someone MORE new hosts rather than hiding posts.
 */
export const SEEN_HOST_ROW_LIMIT = 5_000;

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

  /**
   * The viewer's bounding box, for SERVER-SIDE spatial filtering.
   *
   * WHY THIS EXISTS (PERF.md §1, the audit's most important finding).
   *
   * `loadCandidates` pages with `limit(CANDIDATE_LIMIT) order by starts_at`.
   * That limit is ordered by TIME, not distance. Once the activity count
   * exceeds the limit, the page is the soonest-starting posts GLOBALLY — and
   * the shipped algorithm is proximity-first, so it then sorts a set that was
   * never filtered by proximity. A user in Brooklyn with 200 posts inside their
   * radius can receive a page containing almost none of them.
   *
   * That is a correctness bug, not a speed one, and it degrades SILENTLY as the
   * map fills in. There is no error, no slow query, and no way to see it from
   * the client except that the deck quietly stops being local.
   *
   * Returning `null` disables spatial filtering and restores the old behaviour
   * — correct while the whole activity table fits inside one page, and wrong
   * afterwards. `loadCandidates` therefore raises a diagnostic through
   * `onError` at exactly the moment it starts to matter: a full page came back
   * and no box was supplied. See `SPATIAL_FILTER_UNBOUNDED`.
   *
   * Units are degrees. The app owns the projection because the app owns the
   * geo library; a degree of longitude is not a degree of latitude outside the
   * equator, and this module is not going to pretend otherwise.
   */
  viewerBounds?: (userId: UserId) => SpatialBounds | null;

  /** Generate an id for a new row. Injected: core/ and adapter/ own no UUID impl. */
  newId: () => string;

  /** How far back to pull candidate activities, in days. */
  candidateWindowDays?: number;

  /**
   * Clock. `loadCandidates` receives `now` as a parameter; `loadViewer` does
   * not, and needs one for the `seenHostIds` window. Injected rather than
   * calling `Date.now()` inline so the window is testable — the purity test
   * only guards `core/`, but "the adapter is allowed to" is a poor reason to
   * make a query untestable.
   */
  now?: () => number;
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
  const clock = options.now ?? (() => Date.now());

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
        //
        // PERF.md §2. This was unbounded: every impression the user had ever
        // received, over the wire, to build a Set of a couple of hundred ids.
        // At 30 cards a day that is ~11,000 rows a year and it never plateaus —
        // fine in every test, and eventually fine in no production.
        //
        // The window is the fix, and it is also more correct. `neverShownToViewer`
        // is a FAIRNESS signal, not a memory: a host the viewer has not seen in
        // three months is functionally fresh to them, and treating them as
        // already-seen forever means a host who had one bad week is permanently
        // stale to everyone who scrolled past them once.
        //
        // Needs `ranking_events_user_seen_idx` (PERF.md §4) or this trades an
        // unbounded transfer for a sequential scan.
        const seenSince = toIso(clock() - SEEN_HOST_WINDOW_DAYS * 86_400_000);
        const seen = await client
          .from(COLUMNS.rankingEvents.table)
          .select('host_id')
          .eq('user_id', userId)
          .eq('event_type', 'impression')
          .gte('created_at', seenSince)
          .limit(SEEN_HOST_ROW_LIMIT);
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
        const bounds = options.viewerBounds?.(userId) ?? null;

        // PERF.md §1. The box goes in the WHERE clause so the limit applies to
        // posts the viewer could actually attend, rather than to the soonest
        // posts on earth. Postgres uses `activities_geo_idx` for the lat range
        // and filters lng within it.
        let query = client
          .from(a.table)
          .select('*')
          .gte(a.startsAt, since);

        if (bounds) {
          query = query
            .gte(a.lat, bounds.minLat).lte(a.lat, bounds.maxLat)
            .gte(a.lng, bounds.minLng).lte(a.lng, bounds.maxLng);
        }

        const res = await query
          .order(a.startsAt, { ascending: true })
          .limit(CANDIDATE_LIMIT);

        const rows = ((res as unknown as { data: Row[] | null }).data) ?? [];

        // The alarm, raised only when the bug is actually live: a full page
        // means the limit bound the result, and no box means it was bound by
        // time. Below the limit the unfiltered query is exactly correct, which
        // is why this cannot simply warn on a missing box at construction.
        if (!bounds && rows.length >= CANDIDATE_LIMIT) {
          fail(
            SPATIAL_FILTER_UNBOUNDED,
            new Error(
              `loadCandidates returned a full page of ${CANDIDATE_LIMIT} with no ` +
              'viewerBounds. The page is now the soonest-starting activities ' +
              'globally, not the nearest, and a proximity-first deck built from ' +
              'it is wrong rather than slow. Supply SupabasePortOptions.viewerBounds.',
            ),
          );
        }

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
        // UPSERT, not insert. A double-tap and a retry-after-a-timeout-that-
        // actually-succeeded both produce a second write that no client-side
        // guard prevents, and `tandem_feedback` row count is the beta's
        // headline metric — double-counting there would overstate the one
        // number anybody is watching.
        //
        // Conflict target is (tandem_id, rater_id), matching
        // `tandem_feedback_one_per_rater_idx`. `rated_id` is excluded because
        // tandems are pairwise: a rater has exactly one counterpart, and
        // including it would let a malformed duplicate through under a
        // different `rated_id`.
        //
        // Last write wins, so a person who taps "no" then reopens and taps
        // "yes" ends with "yes" — which is the answer they meant.
        const { error } = await client.from(f.table).upsert({
          [f.tandemId]: answer.tandemId,
          [f.raterId]: answer.raterId,
          [f.ratedId]: answer.ratedId,
          [f.response]: answer.positive ? values.positive : values.negative,
          [f.createdAt]: toIso(answer.createdAt),
        }, { onConflict: `${f.tandemId},${f.raterId}` });
        if (error) fail('writeCheckIn', error);
      } catch (error) {
        fail('writeCheckIn', error);
      }
    },

    async loadSkippedCheckIns(userId: UserId): Promise<CheckInSkip[]> {
      const s = COLUMNS.checkinSkips;
      try {
        const res = await client
          .from(s.table)
          .select(`${s.tandemId},${s.raterId}`)
          .eq(s.raterId, userId);
        const rows = ((res as unknown as { data: Row[] | null }).data) ?? [];
        return rows.map((row) => ({
          tandemId: str(row[s.tandemId]),
          raterId: str(row[s.raterId]),
        }));
      } catch (error) {
        // Degrade to "nothing was skipped", which RE-ASKS rather than never
        // asking. Of the two directions this is the recoverable one: an extra
        // prompt is an annoyance, a check-in silently never asked is a
        // permanently missing row in the highest-weighted signal in the model.
        fail('loadSkippedCheckIns', error);
        return [];
      }
    },

    async writeCheckInSkip(skip): Promise<void> {
      const s = COLUMNS.checkinSkips;
      try {
        // Upsert for the same reason as above; the table's primary key is
        // (tandem_id, rater_id), so skipping twice is one row.
        //
        // NOTE what is absent: no rated_id, no polarity, no interest_events
        // mirror. A skip is not a negative and the write path has nowhere to
        // put one even by accident.
        const { error } = await client.from(s.table).upsert({
          [s.tandemId]: skip.tandemId,
          [s.raterId]: skip.raterId,
          [s.createdAt]: toIso(skip.createdAt),
        }, { onConflict: `${s.tandemId},${s.raterId}` });
        if (error) fail('writeCheckInSkip', error);
      } catch (error) {
        fail('writeCheckInSkip', error);
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
