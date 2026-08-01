-- =============================================================================
-- ranking_v1_6_scale
--
-- Density adaptation (v1.6). Two additions, both additive and both idempotent:
--
--   1. Coverage/regime persistence on user_interest_state, so the EWMA and the
--      hysteresis band have somewhere to live between sessions. Without
--      persistence the regime is recomputed from scratch every session, which
--      defeats the entire point of smoothing it.
--
--   2. A denormalised joiner count on activities, maintained by a trigger, so
--      the demand-balancing term (§2) can read fillRatio from the SAME bulk
--      query the deck already runs. This must never become a per-card fetch —
--      a ranking signal that costs one round-trip per card is a ranking signal
--      that gets deleted the first time someone profiles the Discover tab.
--
-- Depends on 20260731120000_ranking_v1_5.sql.
--
-- >>> REVIEW BEFORE APPLYING <<<
-- The joiner trigger assumes join_requests(activity_id, user_id, status) with
-- 'accepted' as the terminal state. Marked [CONFIG] below. Reconcile with the
-- real schema first; the backfill statement at the end recomputes counts from
-- whatever join_requests actually contains, so a wrong guess is recoverable.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Regime persistence
-- -----------------------------------------------------------------------------
-- user_interest_state remains a CACHE. These columns are the one exception
-- worth naming: coverage_ewma and last_regime are not derivable from
-- interest_events, because they summarise impression history and pool size over
-- time. Losing them is not a correctness failure — the regime re-derives from
-- the current pool on the next session, it just loses its smoothing and will
-- move more abruptly for a few weeks.
alter table if exists public.user_interest_state
  add column if not exists coverage_ewma real;

alter table if exists public.user_interest_state
  add column if not exists coverage_updated_at timestamptz;

alter table if exists public.user_interest_state
  add column if not exists last_regime real;

-- Fingerprint of the density-scaled parameters the cached vector was folded
-- with. The interest vector depends on noveltyBoost, which moves with density,
-- so a vector computed under one regime must not be served under another.
alter table if exists public.user_interest_state
  add column if not exists params_fingerprint text;

do $$
begin
  if to_regclass('public.user_interest_state') is not null then
    -- Sanity bounds. A regime outside [0, 1] means a client wrote garbage, and
    -- the resolver would clamp it anyway — better to reject it at the door.
    if not exists (
      select 1 from pg_constraint
      where conrelid = 'public.user_interest_state'::regclass
        and conname = 'user_interest_state_last_regime_range'
    ) then
      alter table public.user_interest_state
        add constraint user_interest_state_last_regime_range
        check (last_regime is null or (last_regime >= 0 and last_regime <= 1));
    end if;

    if not exists (
      select 1 from pg_constraint
      where conrelid = 'public.user_interest_state'::regclass
        and conname = 'user_interest_state_coverage_nonneg'
    ) then
      alter table public.user_interest_state
        add constraint user_interest_state_coverage_nonneg
        check (coverage_ewma is null or coverage_ewma >= 0);
    end if;
  end if;
end
$$;


-- -----------------------------------------------------------------------------
-- 2. Denormalised joiner count on activities
-- -----------------------------------------------------------------------------
alter table if exists public.activities
  add column if not exists confirmed_joiners integer not null default 0;

-- Capacity. Null means "no explicit capacity", which the ranker reads as 1 —
-- a tandem is two people, so one joiner fills it.
alter table if exists public.activities
  add column if not exists target_joiners integer;

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

-- Partial index for "posts that still need someone", which is the query the
-- demand signal cares about and the one an ops dashboard will want.
create index if not exists activities_unfilled_idx
  on public.activities (starts_at)
  where confirmed_joiners = 0;


-- -----------------------------------------------------------------------------
-- 3. Keep the count true
-- -----------------------------------------------------------------------------
-- Recomputed rather than incremented. An incrementing trigger drifts the first
-- time a row is updated twice, or deleted, or backfilled — and a drifted demand
-- signal is worse than none, because it silently boosts posts that are actually
-- full. Recomputing is O(joiners per activity), which is a handful of rows.
create or replace function public.tg_activities_recount_joiners()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_activity uuid;
begin
  target_activity := coalesce(new.activity_id, old.activity_id);   -- [CONFIG]
  if target_activity is null then
    return coalesce(new, old);
  end if;

  update public.activities a
     set confirmed_joiners = (
       select count(*)
       from public.join_requests jr                                -- [CONFIG]
       where jr.activity_id = target_activity
         and jr.status = 'accepted'                                -- [CONFIG]
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


-- -----------------------------------------------------------------------------
-- 4. Backfill the count for rows that predate the trigger
-- -----------------------------------------------------------------------------
-- Idempotent by construction: it is an absolute recount, not an increment, so
-- running the whole migration twice converges rather than doubling.
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

commit;


-- =============================================================================
-- ROLLBACK
-- =============================================================================
-- Fully reverses this migration. Dropping coverage_ewma/last_regime loses the
-- smoothing history: the regime re-derives from the live pool on the next
-- session, so this is a degradation rather than a data loss, but decks will
-- move more abruptly for a few weeks afterwards.
--
-- begin;
--
-- drop trigger if exists trg_activities_recount_joiners on public.join_requests;
-- drop function if exists public.tg_activities_recount_joiners();
--
-- drop index if exists public.activities_unfilled_idx;
--
-- alter table public.activities
--   drop constraint if exists activities_confirmed_joiners_nonneg;
-- alter table public.activities drop column if exists confirmed_joiners;
-- alter table public.activities drop column if exists target_joiners;
--
-- alter table public.user_interest_state
--   drop constraint if exists user_interest_state_last_regime_range;
-- alter table public.user_interest_state
--   drop constraint if exists user_interest_state_coverage_nonneg;
-- alter table public.user_interest_state drop column if exists coverage_ewma;
-- alter table public.user_interest_state drop column if exists coverage_updated_at;
-- alter table public.user_interest_state drop column if exists last_regime;
-- alter table public.user_interest_state drop column if exists params_fingerprint;
--
-- commit;
-- =============================================================================
