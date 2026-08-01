-- =============================================================================
-- ranking_v1_5
--
-- Framework §4. Adds the instrumentation and interest-model storage that the
-- v1.5 ranking layer needs.
--
-- Design rules honoured here:
--   * Idempotent. Every statement is guarded; running twice is a no-op.
--   * Additive only. No existing column is dropped, renamed or retyped, so
--     existing reads keep working while old clients are still deployed.
--   * RLS posture matches the existing one: a user may INSERT rows they own,
--     nobody may SELECT from the client. Analysis happens in the SQL editor
--     with the service role.
--   * `user_interest_state` is a CACHE. It is fully rebuildable from
--     `interest_events` alone (see src/ranking/core/interest.ts →
--     rebuildInterestStateFromEvents). Never treat it as source of truth.
--
-- Assumed pre-existing objects (this migration degrades gracefully if the
-- names differ — see the DO blocks, which skip rather than fail):
--   profiles(id uuid pk)
--   activities(id uuid pk, host_id uuid, category text, created_at timestamptz)
--   ranking_events(...)                      -- created by the v1 migration
--   a participation table linking users to activities
--
-- >>> REVIEW BEFORE APPLYING <<<
-- The completion trigger needs to know (a) which table holds participants and
-- (b) which column flips when a tandem completes. Both are configured in the
-- CONFIGURATION block below. Defaults are a guess based on the v1 spec; edit
-- them to match the real schema before running this against production.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 0. Extensions
-- -----------------------------------------------------------------------------
create extension if not exists "pgcrypto";  -- gen_random_uuid()


-- -----------------------------------------------------------------------------
-- 1. ranking_events: new event types + retrieval source tag
-- -----------------------------------------------------------------------------

-- 1a. `source` records which retrieval source put the card in the deck
--     ('affinity' | 'proximity' | 'fresh_host' | 'graph' | 'random').
--     Without this you cannot tell an explore impression from an exploit one,
--     which makes every downstream conversion rate uninterpretable.
alter table if exists public.ranking_events
  add column if not exists source text;

-- 1b. Widen the event_type check constraint to add 'expand', 'checkin_yes',
--     'checkin_no'. Done by drop-and-recreate because Postgres has no
--     ALTER CONSTRAINT for check expressions. The constraint name is looked up
--     dynamically so this works regardless of what the v1 migration called it.
do $$
declare
  con record;
begin
  if to_regclass('public.ranking_events') is null then
    raise notice 'ranking_events does not exist; skipping constraint widening';
    return;
  end if;

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
        'impression',   -- card was rendered to the viewer
        'advance',      -- viewer moved past the card without acting
        'expand',       -- viewer opened the card for detail (v1.5: emitted, not consumed)
        'im_in',        -- viewer tapped join
        'accept',       -- host accepted the request
        'decline',      -- host declined the request
        'complete',     -- the tandem happened
        'repeat',       -- a repeat tandem with the same counterpart
        'checkin_yes',  -- post-tandem: "would you tandem with them again?" -> yes
        'checkin_no'    -- ...                                             -> no
      ))
  $ck$;
end
$$;

create index if not exists ranking_events_activity_type_idx
  on public.ranking_events (activity_id, event_type);

-- Supporting index for per-user funnel queries; cheap and always wanted.
create index if not exists ranking_events_user_created_idx
  on public.ranking_events (user_id, created_at desc);


-- -----------------------------------------------------------------------------
-- 2. interest_events — the append-only interest log (framework §1.1)
-- -----------------------------------------------------------------------------
-- One row per piece of evidence that a user cares about a metric. Never
-- updated, never deleted except by the owning user removing an explicit
-- statement. The whole interest vector is a pure function of this table.
create table if not exists public.interest_events (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,

  -- Metric slug, e.g. 'coffee', 'fitness', 'deep_conversation'. Resolved by the
  -- caller; this table stores no free text and does no NLP.
  metric       text not null,

  -- Which behaviour produced this evidence. Drives weight and half-life via the
  -- table in src/ranking/core/constants.ts (INTEREST_SOURCES). Deliberately not
  -- a DB enum: adding a source must not require a migration.
  source       text not null,

  -- +1 for "I like this", -1 for "not for me". Explicit statements and
  -- checkin_no are the only current producers of -1.
  polarity     smallint not null default 1 check (polarity in (-1, 1)),

  -- Per-event strength multiplier, before the source weight is applied.
  -- Explicit statements write 1.0 (framework §1.7).
  weight       real not null default 1.0 check (weight >= 0),

  -- Provenance for explanations and for excluding synthetic rows.
  -- 'backfill' marks rows derived by scripts/backfill-interest-events.ts.
  source_meta  text,
  activity_id  uuid references public.activities(id) on delete set null,

  created_at   timestamptz not null default now()
);

-- The hot path: "give me this user's events, newest first".
create index if not exists interest_events_user_created_idx
  on public.interest_events (user_id, created_at desc);

-- Explicit statements must be listable and deletable per (user, metric).
create index if not exists interest_events_user_metric_idx
  on public.interest_events (user_id, metric);

-- One explicit statement per (user, metric). Re-stating overwrites rather than
-- stacking, so a user cannot accidentally 10x their own weight by tapping twice.
create unique index if not exists interest_events_explicit_unique_idx
  on public.interest_events (user_id, metric)
  where source = 'explicit_statement';


-- -----------------------------------------------------------------------------
-- 3. graph_edges — co-participation graph (WRITTEN in v1.5, NOT READ)
-- -----------------------------------------------------------------------------
-- Rows accumulate from day one so that when the graph retrieval source and
-- graphAffinity() are switched on later there is real history to switch on to.
-- Nothing in v1.5 reads this table. See src/ranking/core/features.ts.
create table if not exists public.graph_edges (
  user_a     uuid not null references public.profiles(id) on delete cascade,
  user_b     uuid not null references public.profiles(id) on delete cascade,

  -- Number of completed tandems the pair has shared. The intended affinity
  -- signal is a decayed version of this, not the raw count.
  weight     integer not null default 0,

  first_seen timestamptz not null default now(),
  last_seen  timestamptz not null default now(),

  -- Canonical ordering: the edge is undirected, stored once, with user_a < user_b.
  primary key (user_a, user_b),
  constraint graph_edges_canonical_order check (user_a < user_b)
);

create index if not exists graph_edges_user_b_idx on public.graph_edges (user_b);
create index if not exists graph_edges_last_seen_idx on public.graph_edges (last_seen desc);


-- -----------------------------------------------------------------------------
-- 4. user_interest_state — CACHE ONLY
-- -----------------------------------------------------------------------------
-- Materialised interest vector so a cold client does not have to pull the whole
-- event log. Authoritative source is interest_events; this may be truncated at
-- any time and rebuilt. `events_hash` + `event_count` let a client detect that
-- the cache is stale without recomputing it.
create table if not exists public.user_interest_state (
  user_id      uuid primary key references public.profiles(id) on delete cascade,

  -- { "<metric>": { "interest": 0.42, "novelty": 0.1, "confidence": 0.6,
  --                 "salience": 0.5, "raw": 1.9, "evidence": [...] }, ... }
  state        jsonb not null default '{}'::jsonb,

  -- Number of interest_events folded into `state`, and a cheap fingerprint of
  -- them. Mismatch against a live count means the cache is stale.
  event_count  integer not null default 0,
  events_hash  text,

  -- Wall-clock the state was computed *as of*. Decay is time-dependent, so a
  -- state computed long ago is wrong even if no new events arrived.
  computed_at  timestamptz not null default now(),
  version      integer not null default 1
);


-- -----------------------------------------------------------------------------
-- 5. Row Level Security
-- -----------------------------------------------------------------------------
-- Posture: insert-your-own, select-nothing. Analysis runs with the service role.
alter table public.interest_events    enable row level security;
alter table public.graph_edges        enable row level security;
alter table public.user_interest_state enable row level security;

do $$
begin
  -- interest_events: user inserts their own evidence.
  if not exists (select 1 from pg_policies
                 where schemaname='public' and tablename='interest_events'
                   and policyname='interest_events_insert_own') then
    create policy interest_events_insert_own on public.interest_events
      for insert to authenticated
      with check (auth.uid() = user_id);
  end if;

  -- interest_events: user may delete ONLY their own explicit statements
  -- (framework §1.7 requires explicit statements be reversible). Behavioural
  -- evidence is immutable — you cannot un-attend a tandem.
  if not exists (select 1 from pg_policies
                 where schemaname='public' and tablename='interest_events'
                   and policyname='interest_events_delete_own_explicit') then
    create policy interest_events_delete_own_explicit on public.interest_events
      for delete to authenticated
      using (auth.uid() = user_id and source = 'explicit_statement');
  end if;

  -- interest_events: user may SELECT only their own explicit statements, so the
  -- "interests you told us about" screen can render. Behavioural rows stay
  -- invisible to the client, consistent with "the score is never shown".
  if not exists (select 1 from pg_policies
                 where schemaname='public' and tablename='interest_events'
                   and policyname='interest_events_select_own_explicit') then
    create policy interest_events_select_own_explicit on public.interest_events
      for select to authenticated
      using (auth.uid() = user_id and source = 'explicit_statement');
  end if;

  -- user_interest_state: the client both reads and writes its own cache row.
  if not exists (select 1 from pg_policies
                 where schemaname='public' and tablename='user_interest_state'
                   and policyname='user_interest_state_rw_own') then
    create policy user_interest_state_rw_own on public.user_interest_state
      for all to authenticated
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;

  -- graph_edges: no client policy at all. Written by a SECURITY DEFINER trigger,
  -- read only by the service role. RLS enabled with zero policies = deny all.
end
$$;


-- -----------------------------------------------------------------------------
-- 6. Completion trigger -> graph_edges
-- -----------------------------------------------------------------------------
-- CONFIGURATION -------------------------------------------------------------
--   participants table : public.activity_participants(activity_id, user_id)
--   completion flag    : activities.status transitioning to 'completed'
-- If the real schema differs, change the two references marked [CONFIG] below.
-- ---------------------------------------------------------------------------
create or replace function public.tg_graph_edges_on_completion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  participants uuid[];
begin
  -- Only fire on the transition INTO completed, not on every update of an
  -- already-completed row. Without this guard, editing a completed tandem
  -- double-counts the edge.
  if new.status is not distinct from old.status then
    return new;
  end if;
  if new.status <> 'completed' then                       -- [CONFIG] flag value
    return new;
  end if;

  -- Host + everyone who actually attended. A join request that was never
  -- accepted is not a shared experience and must not create an edge.
  select array_agg(distinct uid)
    into participants
  from (
    select new.host_id as uid
    union
    select ap.user_id
    from public.activity_participants ap                  -- [CONFIG] table
    where ap.activity_id = new.id
      and coalesce(ap.status, 'accepted') = 'accepted'
  ) s
  where uid is not null;

  if participants is null or array_length(participants, 1) < 2 then
    return new;
  end if;

  -- Every unordered pair, canonicalised to user_a < user_b.
  insert into public.graph_edges (user_a, user_b, weight, first_seen, last_seen)
  select least(a, b), greatest(a, b), 1, now(), now()
  from unnest(participants) a, unnest(participants) b
  where a < b
  on conflict (user_a, user_b) do update
    set weight    = public.graph_edges.weight + 1,
        last_seen = now();

  return new;
end
$$;

drop trigger if exists trg_graph_edges_on_completion on public.activities;

do $$
begin
  if to_regclass('public.activities') is not null
     and to_regclass('public.activity_participants') is not null then
    create trigger trg_graph_edges_on_completion
      after update on public.activities
      for each row
      execute function public.tg_graph_edges_on_completion();
  else
    raise notice 'activities/activity_participants not found; graph trigger not attached';
  end if;
end
$$;

commit;


-- =============================================================================
-- ROLLBACK
-- =============================================================================
-- Reverses everything above. The event_type constraint is restored to the v1
-- set. Dropping the tables discards accumulated interest and graph history —
-- export them first if the rollback is not immediate.
--
-- begin;
--
-- drop trigger if exists trg_graph_edges_on_completion on public.activities;
-- drop function if exists public.tg_graph_edges_on_completion();
--
-- drop table if exists public.user_interest_state;
-- drop table if exists public.graph_edges;
-- drop table if exists public.interest_events;
--
-- drop index if exists public.ranking_events_activity_type_idx;
-- drop index if exists public.ranking_events_user_created_idx;
--
-- alter table public.ranking_events
--   drop constraint if exists ranking_events_event_type_check;
-- alter table public.ranking_events
--   add constraint ranking_events_event_type_check
--   check (event_type in
--     ('impression','advance','im_in','accept','decline','complete','repeat'));
--
-- alter table public.ranking_events drop column if exists source;
--
-- commit;
-- =============================================================================
