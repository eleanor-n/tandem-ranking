-- =============================================================================
-- v1.9 — the indexes PERF.md §1, §2 and §4 need, and nothing else
--
-- Additive and idempotent. No column is added, dropped or retyped; no trigger
-- changes; no data is written. Every statement is CREATE INDEX IF NOT EXISTS.
-- This migration can be applied while the App Store review is in flight because
-- there is no user-visible behaviour in it at all.
--
-- CONCURRENTLY is used throughout so none of these takes a write lock on a live
-- table. The cost is that each statement must run OUTSIDE a transaction block —
-- if your migration runner wraps files in BEGIN/COMMIT, either strip the
-- CONCURRENTLY keywords (fine at current table sizes: 63 activities, ~16
-- ranking_events) or run this file by hand in the SQL editor.
--
-- ORDER OF APPLICATION: this should land BEFORE impression logging is switched
-- on, not after. Two of these serve queries that the logging itself makes hot.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. The sharpest one: the joiner-recount trigger's hot path
-- -----------------------------------------------------------------------------
-- `tg_activities_recount_joiners` runs a COUNT(*) over join_requests on EVERY
-- insert, update and delete on that table. Recounting absolutely rather than
-- incrementing is the right design — it is self-healing and cannot drift — but
-- it does mean the count lands on the write path of accepting a join request,
-- which is the most common consequential action in the app.
--
-- At 63 activities the scan is free. At 5,000 activities and ~15,000 join
-- requests it is a sequential scan every time somebody taps Accept.
create index concurrently if not exists join_requests_activity_status_idx
  on public.join_requests (activity_id, status);


-- -----------------------------------------------------------------------------
-- 2. loadCandidates — the general starts_at query
-- -----------------------------------------------------------------------------
-- A PARTIAL index already exists (`where confirmed_joiners = 0`, from v1.6, for
-- the demand path). A partial index does not serve the general predicate, so
-- the deck's own filter-and-order has been unindexed since v1.5.
create index concurrently if not exists activities_starts_at_idx
  on public.activities (starts_at);


-- -----------------------------------------------------------------------------
-- 3. loadCandidates — the bounding box (PERF.md §1)
-- -----------------------------------------------------------------------------
-- Serves the lat range; lng is filtered within it. Composite rather than two
-- separate indexes because the query always supplies both, and Postgres can use
-- the leading column for the range scan.
--
-- THIS IS THE CHEAP FIX, NOT THE RIGHT ONE. A lat/lng box stops being selective
-- in a dense metro where every candidate is inside the box anyway — at which
-- point the correct answer is `earthdistance` + GiST, or PostGIS. That is a
-- second migration and an extension dependency, and it is not needed to fix the
-- correctness bug, which is that the 500-row page was ordered by time and
-- therefore was not a spatial page at all.
create index concurrently if not exists activities_geo_idx
  on public.activities (lat, lng);


-- -----------------------------------------------------------------------------
-- 4. The bounded seenHostIds query (PERF.md §2)
-- -----------------------------------------------------------------------------
-- v1.9 bounds that query to 90 days and 5,000 rows. Without this index the
-- bound trades an unbounded network transfer for a sequential scan, which is
-- not obviously a win.
--
-- Column order matters: equality columns first (user_id, event_type), then the
-- range column (created_at). host_id is INCLUDEd so the query is index-only and
-- never touches the heap.
create index concurrently if not exists ranking_events_user_seen_idx
  on public.ranking_events (user_id, event_type, created_at desc)
  include (host_id);


-- -----------------------------------------------------------------------------
-- 5. loadCompletedTandems — two queries per check-in poll
-- -----------------------------------------------------------------------------
-- `tandems` is per-pair with the two participants in separate columns, so
-- "tandems involving me" is two queries and needs two indexes. See SCHEMA.md §3.
create index concurrently if not exists tandems_user_a_idx
  on public.tandems (user_a_id);

create index concurrently if not exists tandems_user_b_idx
  on public.tandems (user_b_id);


-- -----------------------------------------------------------------------------
-- 6. loadGivenFeedback — once per app open
-- -----------------------------------------------------------------------------
create index concurrently if not exists tandem_feedback_rater_idx
  on public.tandem_feedback (rater_id);


-- =============================================================================
-- VERIFY
--
-- Run after applying. Every row should read 'present'.
-- =============================================================================
--
-- select
--   name,
--   case when to_regclass('public.' || name) is null then 'MISSING' else 'present' end as status
-- from unnest(array[
--   'join_requests_activity_status_idx',
--   'activities_starts_at_idx',
--   'activities_geo_idx',
--   'ranking_events_user_seen_idx',
--   'tandems_user_a_idx',
--   'tandems_user_b_idx',
--   'tandem_feedback_rater_idx'
-- ]) as name;
--
-- A CONCURRENTLY build that fails leaves an INVALID index behind, which is not
-- used by the planner and is not obvious from \d. Check for those too:
--
-- select indexrelid::regclass as index
--   from pg_index where not indisvalid;
--
-- Drop and recreate any that come back.
--
-- =============================================================================
-- ROLLBACK
--
-- Indexes only; dropping them restores the previous plans exactly and loses no
-- data. Nothing here needs to be rolled back for correctness — only if one of
-- them turns out to cost more on write than it saves on read.
--
-- drop index concurrently if exists public.join_requests_activity_status_idx;
-- drop index concurrently if exists public.activities_starts_at_idx;
-- drop index concurrently if exists public.activities_geo_idx;
-- drop index concurrently if exists public.ranking_events_user_seen_idx;
-- drop index concurrently if exists public.tandems_user_a_idx;
-- drop index concurrently if exists public.tandems_user_b_idx;
-- drop index concurrently if exists public.tandem_feedback_rater_idx;
-- =============================================================================
