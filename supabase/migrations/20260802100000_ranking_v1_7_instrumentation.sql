-- =============================================================================
-- ranking_v1_7_instrumentation
--
-- Instrumentation and schema reconciliation. Read SCHEMA.md first — it records
-- what the live database actually contains, and it OVERRIDES the v1.5 and v1.6
-- migrations wherever they disagree.
--
-- What this does:
--   0. PRECHECK — run this block by hand FIRST. It is pure SELECTs and changes
--      nothing. Every assumption this migration makes has a query here.
--   1. Removes the v1.5 graph trigger, which targets a table that DOES NOT
--      EXIST (public.activity_participants) and therefore never fired.
--   2. ranking_events becomes the one impression table: + session_id,
--      score_snapshot made nullable.
--   3. feed_impressions is deprecated by comment. Zero rows, so nothing moves.
--   4. activities.target_joiners is DROPPED — v1.6 added it without knowing
--      that activities.max_participants already exists and means the same thing.
--   5. tandems gains tandem_group_id, for the future clique representation.
--   6. graph_edges becomes a derived aggregate over tandems, rebuildable from
--      scratch, with no trigger to go silently wrong.
--
-- Idempotent throughout. Additive except for the two removals named above, both
-- of which are corrections of this repo's own earlier guesses and neither of
-- which can hold data anyone has read.
--
-- Depends on 20260731120000_ranking_v1_5.sql and 20260801090000_ranking_v1_6_scale.sql,
-- but does not require either to have been applied — every statement is guarded.
-- =============================================================================


-- =============================================================================
-- 0. PRECHECK  —  RUN THIS BY HAND BEFORE APPLYING ANYTHING BELOW
-- =============================================================================
-- Nothing in this block writes. Paste it into the SQL editor, read the output,
-- and only then run the migration. Each query is labelled with the assumption
-- it tests and what to do if the answer is not the expected one.
--
-- ---------------------------------------------------------------------------
-- P1. Which of the tables we care about actually exist?
--     EXPECT: activities, tandems, tandem_completions, tandem_feedback,
--             join_requests, ranking_events, feed_impressions present.
--             activity_participants ABSENT.
--     IF activity_participants EXISTS: stop and re-read SCHEMA.md §1 — the
--     whole basis for dropping the v1.5 trigger changes.
--
-- select t.name,
--        (to_regclass('public.' || t.name) is not null) as exists
--   from unnest(array[
--     'activities','tandems','tandem_completions','tandem_feedback',
--     'join_requests','ranking_events','feed_impressions','graph_edges',
--     'interest_events','user_interest_state','activity_participants'
--   ]) as t(name)
--  order by 2 desc, 1;
--
-- ---------------------------------------------------------------------------
-- P2. Row counts, to confirm the numbers SCHEMA.md is built on.
--     EXPECT: activities 63, tandems(completed) 23, tandem_completions 2,
--             tandem_feedback 0, ranking_events 16, feed_impressions 0.
--     IF feed_impressions > 0: someone is writing to it. Find the writer before
--     deprecating, or you will lose data silently.
--
-- select 'activities'          as t, count(*) from public.activities
-- union all select 'tandems (completed)', count(*) from public.tandems where status = 'completed'
-- union all select 'tandems (all)',       count(*) from public.tandems
-- union all select 'tandem_completions',  count(*) from public.tandem_completions
-- union all select 'tandem_feedback',     count(*) from public.tandem_feedback
-- union all select 'ranking_events',      count(*) from public.ranking_events
-- union all select 'feed_impressions',    count(*) from public.feed_impressions
-- union all select 'join_requests',       count(*) from public.join_requests;
--
-- ---------------------------------------------------------------------------
-- P3. [S1] Does tandems link to the activity it came from?
--     EXPECT: a column named activity_id.
--     IF ABSENT: the check-in cannot resolve a category or an end time. It will
--     still write tandem_feedback; the interest_events mirror degrades to a
--     no-op. Set CONSTANTS.checkin.linkedToActivity = false and say so.
--
-- select column_name, data_type, is_nullable
--   from information_schema.columns
--  where table_schema = 'public' and table_name = 'tandems'
--  order by ordinal_position;
--
-- ---------------------------------------------------------------------------
-- P4. [S2] Is 'accepted' the terminal accepted state on join_requests?
--     EXPECT: 'accepted' present and the dominant non-pending value.
--     IF DIFFERENT: change the three [CONFIG] literals in the v1.6 migration's
--     tg_activities_recount_joiners() and re-run its backfill.
--
-- select status, count(*) from public.join_requests group by 1 order by 2 desc;
--
-- ---------------------------------------------------------------------------
-- P5. [S3] Does activities have an end time, and does max_participants mean
--     what SCHEMA.md says?
--     EXPECT: max_participants present, 59 of 63 equal to 1.
--     IF ends_at IS ABSENT: the check-in falls back to
--     starts_at + CONSTANTS.checkin.assumedDurationHours. That constant is
--     UNMEASURED — set it from real data when there is some.
--
-- select column_name, data_type
--   from information_schema.columns
--  where table_schema = 'public' and table_name = 'activities'
--    and column_name in ('starts_at','ends_at','end_time','duration_minutes',
--                        'max_participants','confirmed_joiners','target_joiners',
--                        'impression_count','status');
--
-- select max_participants, count(*) from public.activities group by 1 order by 1;
--
-- ---------------------------------------------------------------------------
-- P6. [S4] What shape does tandem_feedback.response take?
--     EXPECT: a boolean, or a text with two values.
--     Set CONSTANTS.checkin.responseValues to match.
--
-- select column_name, data_type, is_nullable
--   from information_schema.columns
--  where table_schema = 'public' and table_name = 'tandem_feedback'
--  order by ordinal_position;
--
-- ---------------------------------------------------------------------------
-- P7. [S5] Were the v1.5 / v1.6 migrations applied?
--     EXPECT: either all of these present, or none. A partial result means a
--     previous migration failed halfway — investigate before adding to it.
--
-- select c.name, (to_regclass('public.' || c.tbl) is not null
--                 and exists (select 1 from information_schema.columns
--                              where table_schema='public' and table_name=c.tbl
--                                and column_name=c.col)) as present
--   from (values
--     ('v1.5 ranking_events.source',            'ranking_events',     'source'),
--     ('v1.5 interest_events',                  'interest_events',    'metric'),
--     ('v1.6 activities.confirmed_joiners',     'activities',         'confirmed_joiners'),
--     ('v1.6 activities.target_joiners (BAD)',  'activities',         'target_joiners'),
--     ('v1.6 uis.coverage_ewma',                'user_interest_state','coverage_ewma')
--   ) as c(name, tbl, col);
--
-- ---------------------------------------------------------------------------
-- P8. Is the v1.5 graph trigger attached? (It should NOT be — its guard checks
--     for activity_participants, which does not exist.)
--     EXPECT: zero rows. Any row means the trigger IS live and has been writing
--     graph_edges from activities.status, which is the wrong signal entirely.
--
-- select tgname, relname
--   from pg_trigger t join pg_class c on c.oid = t.tgrelid
--  where tgname = 'trg_graph_edges_on_completion';
--
-- ---------------------------------------------------------------------------
-- P9. What ranking_events already looks like, so the 16 rows survive.
--     EXPECT: no session_id column; score_snapshot present and jsonb.
--
-- select column_name, data_type, is_nullable
--   from information_schema.columns
--  where table_schema = 'public' and table_name = 'ranking_events'
--  order by ordinal_position;
--
-- =============================================================================


begin;

-- -----------------------------------------------------------------------------
-- 1. Remove the v1.5 completion trigger
-- -----------------------------------------------------------------------------
-- It fires on activities.status -> 'completed' and reads
-- public.activity_participants. Neither is right:
--
--   * activity_participants DOES NOT EXIST. The v1.5 DO block guards on
--     to_regclass(), so the trigger was almost certainly never attached and
--     graph_edges has been empty since day one. Silent, which is the bad kind.
--   * activities.status is not the completion signal. tandems.status is.
--
-- Dropped unconditionally rather than conditionally: if it somehow IS attached,
-- it is writing edges from the wrong signal and must stop.
drop trigger if exists trg_graph_edges_on_completion on public.activities;
drop function if exists public.tg_graph_edges_on_completion();


-- -----------------------------------------------------------------------------
-- 2. ranking_events is the one impression table
-- -----------------------------------------------------------------------------
-- Client-generated, one per app foreground period. There is no server-side
-- session concept and this build does not invent one — a session is "the
-- stretch of cards a person looked at in one sitting", which only the client
-- can observe.
alter table if exists public.ranking_events
  add column if not exists session_id text;

do $$
begin
  if to_regclass('public.ranking_events') is null then
    raise notice 'ranking_events absent; skipping v1.7 instrumentation columns';
    return;
  end if;

  -- The 16 existing rows predate the current snapshot shape. They are NOT
  -- migrated — rewriting them would be inventing history. Making the column
  -- nullable is what lets them stay honest.
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'ranking_events'
       and column_name = 'score_snapshot' and is_nullable = 'NO'
  ) then
    alter table public.ranking_events alter column score_snapshot drop not null;
  end if;

  -- Same treatment for source: an event logged outside a deck (a completion, a
  -- check-in) has no retrieval source and must not be forced to invent one.
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'ranking_events'
       and column_name = 'source' and is_nullable = 'NO'
  ) then
    alter table public.ranking_events alter column source drop not null;
  end if;
end
$$;

-- The session funnel query: "what did this person see, in order, in one
-- sitting, and what did they do about it".
create index if not exists ranking_events_session_idx
  on public.ranking_events (user_id, session_id, created_at);

-- Widen event_type for the check-in events the v1.7 data path emits. Same
-- drop-and-recreate as v1.5, for the same reason (no ALTER for check exprs).
do $$
declare
  con record;
begin
  if to_regclass('public.ranking_events') is null then return; end if;

  for con in
    select conname
      from pg_constraint
     where conrelid = 'public.ranking_events'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%event_type%'
  loop
    execute format('alter table public.ranking_events drop constraint %I', con.conname);
  end loop;

  execute $ck$
    alter table public.ranking_events
      add constraint ranking_events_event_type_check
      check (event_type in (
        'impression',   -- card was rendered
        'advance',      -- moved past without acting
        'expand',       -- opened the card for detail
        'im_in',        -- tapped join
        'accept',       -- host accepted
        'decline',      -- host declined
        'complete',     -- the tandem happened
        'repeat',       -- a repeat tandem with the same counterpart
        'checkin_yes',  -- post-tandem "again?" -> yes
        'checkin_no'    -- ...                  -> no
      ))
  $ck$;
end
$$;


-- -----------------------------------------------------------------------------
-- 3. Deprecate feed_impressions
-- -----------------------------------------------------------------------------
-- Zero rows, so nothing is lost. Two tables with overlapping jobs is how a
-- training set ends up split across schemas with no way to join it afterwards.
-- ranking_events wins because it has host_id and it has data.
--
-- The comment is the durable half of this; the other half is an architectural
-- test (tests/purity.test.ts) that fails if any source file names the table.
do $$
begin
  if to_regclass('public.feed_impressions') is not null then
    execute $c$
      comment on table public.feed_impressions is
        'DEPRECATED 2026-08-02 — superseded by ranking_events. Do not write. '
        'ranking_events carries host_id and already has data; see SCHEMA.md §2.'
    $c$;
  end if;
end
$$;


-- -----------------------------------------------------------------------------
-- 4. activities: max_participants IS the capacity column
-- -----------------------------------------------------------------------------
-- v1.6 added target_joiners without knowing max_participants already existed
-- and already means "joiners wanted, excluding the host". Two columns for one
-- fact is a data-integrity bug waiting for the first row where they disagree.
--
-- Dropped rather than kept-and-ignored: a column nothing writes but something
-- might read is worse than no column.
alter table if exists public.activities
  drop column if exists target_joiners;

-- confirmed_joiners and its recount trigger are from v1.6 and were CORRECT.
-- Re-asserted here so v1.7 applies cleanly on a database that never saw v1.6.
alter table if exists public.activities
  add column if not exists confirmed_joiners integer not null default 0;

do $$
begin
  if to_regclass('public.activities') is not null
     and not exists (
       select 1 from pg_constraint
        where conrelid = 'public.activities'::regclass
          and conname = 'activities_confirmed_joiners_nonneg'
     ) then
    alter table public.activities
      add constraint activities_confirmed_joiners_nonneg
      check (confirmed_joiners >= 0);
  end if;
end
$$;

create index if not exists activities_unfilled_idx
  on public.activities (starts_at)
  where confirmed_joiners = 0;

-- Recount, never increment. An incrementing trigger drifts the first time a row
-- is updated twice, deleted, or backfilled — and a drifted demand signal is
-- worse than none, because it silently boosts posts that are already full.
create or replace function public.tg_activities_recount_joiners()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_activity uuid;
begin
  target_activity := coalesce(new.activity_id, old.activity_id);
  if target_activity is null then
    return coalesce(new, old);
  end if;

  update public.activities a
     set confirmed_joiners = (
       select count(*)
         from public.join_requests jr
        where jr.activity_id = target_activity
          and jr.status = 'accepted'          -- [S2] verified by PRECHECK P4
     )
   where a.id = target_activity;

  return coalesce(new, old);
end
$$;

drop trigger if exists trg_activities_recount_joiners on public.join_requests;

do $$
begin
  if to_regclass('public.join_requests') is not null
     and to_regclass('public.activities') is not null then
    create trigger trg_activities_recount_joiners
      after insert or update or delete on public.join_requests
      for each row
      execute function public.tg_activities_recount_joiners();
  else
    raise notice 'join_requests/activities not found; joiner recount trigger not attached';
  end if;
end
$$;

-- Backfill. Idempotent by construction: an absolute recount, not an increment.
do $$
begin
  if to_regclass('public.join_requests') is not null
     and to_regclass('public.activities') is not null then
    update public.activities a
       set confirmed_joiners = coalesce(counts.n, 0)
      from (
        select jr.activity_id, count(*) as n
          from public.join_requests jr
         where jr.status = 'accepted'
         group by jr.activity_id
      ) counts
     where counts.activity_id = a.id
       and a.confirmed_joiners is distinct from counts.n;
  end if;
end
$$;


-- -----------------------------------------------------------------------------
-- 5. tandems: room for the future group representation
-- -----------------------------------------------------------------------------
-- tandems is strictly pairwise and stays that way. A group tandem, when it
-- arrives, is a CLIQUE of pairwise rows sharing this identifier — three people
-- is three rows (A-B, A-C, B-C), not one row with three participants.
--
-- Everything downstream is already pair-keyed (graph_edges, tandem_feedback's
-- rater/rated, exhaustion's completedTogether) and needs no change under that
-- model. That is the entire reason for choosing it.
--
-- No group support is implemented here. This column and one README paragraph
-- are the whole of it.
alter table if exists public.tandems
  add column if not exists tandem_group_id uuid;

create index if not exists tandems_group_idx
  on public.tandems (tandem_group_id)
  where tandem_group_id is not null;


-- -----------------------------------------------------------------------------
-- 6. graph_edges becomes a derived aggregate
-- -----------------------------------------------------------------------------
-- tandems is ALREADY an edge list: pairwise, with a completion status. Keeping
-- a second copy in sync by trigger buys nothing and adds a failure mode — which
-- is exactly the one that hit v1.6.
--
-- Recomputed from scratch instead. A missed or broken refresh loses nothing,
-- because the source of truth is tandems and the aggregate is reproducible at
-- any time. Call it from a cron, after a backfill, or by hand; correctness does
-- not depend on when.
create table if not exists public.graph_edges (
  user_a     uuid not null,
  user_b     uuid not null,
  weight     integer not null default 0,
  first_seen timestamptz not null default now(),
  last_seen  timestamptz not null default now(),
  primary key (user_a, user_b),
  constraint graph_edges_canonical_order check (user_a < user_b)
);

alter table if exists public.graph_edges
  add column if not exists rebuilt_at timestamptz;

alter table public.graph_edges enable row level security;
-- No policy = deny all. Written by a SECURITY DEFINER function, read by the
-- service role only.

create or replace function public.rebuild_graph_edges()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  edge_count integer;
begin
  if to_regclass('public.tandems') is null then
    raise notice 'tandems not found; graph_edges left untouched';
    return 0;
  end if;

  -- Full recompute inside one transaction. Readers see the old aggregate or the
  -- new one, never a half-built one.
  delete from public.graph_edges;

  insert into public.graph_edges (user_a, user_b, weight, first_seen, last_seen, rebuilt_at)
  select least(t.user_a_id, t.user_b_id),
         greatest(t.user_a_id, t.user_b_id),
         count(*),
         min(t.created_at),
         max(t.created_at),
         now()
    from public.tandems t
   where t.status = 'completed'
     and t.user_a_id is not null
     and t.user_b_id is not null
     and t.user_a_id <> t.user_b_id
   group by 1, 2;

  get diagnostics edge_count = row_count;
  return edge_count;
end
$$;

comment on function public.rebuild_graph_edges() is
  'Recomputes graph_edges from scratch over tandems WHERE status = ''completed''. '
  'Idempotent and safe to run at any time; graph_edges is a derived aggregate, '
  'not a source of truth. Consumption is stubbed at zero — see src/ranking/core/features.ts.';

-- Build it once now, so there is history to switch the graph on to later.
do $$
declare
  n integer;
begin
  if to_regclass('public.tandems') is not null then
    select public.rebuild_graph_edges() into n;
    raise notice 'graph_edges rebuilt: % edges', n;
  end if;
end
$$;

commit;


-- =============================================================================
-- ROLLBACK
-- =============================================================================
-- Reverses v1.7. Note what it does NOT restore: the v1.5 graph trigger. That
-- trigger references a table that does not exist and fires on the wrong signal;
-- putting it back would be restoring a bug. If you genuinely need it, take it
-- from 20260731120000_ranking_v1_5.sql §6 and read SCHEMA.md §1 first.
--
-- begin;
--
-- drop function if exists public.rebuild_graph_edges();
-- alter table public.graph_edges drop column if exists rebuilt_at;
--
-- drop index if exists public.tandems_group_idx;
-- alter table public.tandems drop column if exists tandem_group_id;
--
-- -- Restores the v1.6 duplicate capacity column. It will be empty; the ranker
-- -- reads activities.max_participants and nothing writes this.
-- alter table public.activities add column if not exists target_joiners integer;
--
-- comment on table public.feed_impressions is null;
--
-- drop index if exists public.ranking_events_session_idx;
-- alter table public.ranking_events drop column if exists session_id;
--
-- commit;
-- =============================================================================
