-- =============================================================================
-- HOST ATTENTION CONCENTRATION
--
-- v1.8 §4. Run these in the SQL editor with the service role. They are analysis
-- queries and must NOT be issued from a client: `ranking_events` has no client
-- read policy, and a per-host aggregate over the impression log is not a thing
-- a phone should be computing.
--
-- ---------------------------------------------------------------------------
-- WHY THIS IS WATCHED
--
-- Host-attention concentration is a known failure mode of this system with a
-- known cause. v1.7 §D3 measured a Gini of 0.931 in simulation and traced it to
-- viewer-independent quality terms multiplied into a per-viewer score: every
-- client independently sorts the same hosts up, because every client was handed
-- the same preference order.
--
-- v1.8 §1 repaired the arithmetic. But the repair was validated against a
-- simulator that was authored alongside the ranker it grades, and the shipped
-- deck is a different algorithm again (proximity x demand x session penalties).
-- Neither of those is a reason to trust a number from the sim about production.
--
-- So: measure it live.
--
-- ---------------------------------------------------------------------------
-- READ THE ZERO-IMPRESSION COUNT FIRST
--
-- Gini is the right summary statistic and the wrong headline. It is one number
-- between 0 and 1 that nobody has intuition for, and a change from 0.62 to 0.68
-- reads as noise to anyone not already looking for it.
--
-- The number that predicts churn is HOW MANY HOSTS GOT NOTHING. A host whose
-- post received zero impressions in a week did not have a bad week — they had
-- an invisible one, and the frozen population model puts an 18% chance on them
-- never posting again, compounding at 1.6x per consecutive empty post.
--
-- Report both. Lead with the count.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. The headline: hosts who got nothing
-- -----------------------------------------------------------------------------
-- One row per window. `posted` is the denominator that matters — a host who did
-- not post cannot have been starved of impressions, and including them would
-- dilute the number until it stopped moving.
--
-- WATCH: `zero_impression_hosts / posting_hosts` trending up. That is the
-- flywheel stalling, and it shows up here weeks before it shows up in retention.

with windows as (
  select * from (values (7), (28)) as w(days)
),
posting_hosts as (
  select w.days, a.host_id
    from windows w
    join public.activities a
      on a.created_at >= now() - make_interval(days => w.days)
   group by w.days, a.host_id
),
host_impressions as (
  select w.days, r.host_id, count(*) as impressions
    from windows w
    join public.ranking_events r
      on r.created_at >= now() - make_interval(days => w.days)
     and r.event_type = 'impression'
     and r.host_id is not null
   group by w.days, r.host_id
)
select
  p.days                                                    as window_days,
  count(*)                                                  as posting_hosts,
  count(*) filter (where coalesce(i.impressions, 0) = 0)    as zero_impression_hosts,
  round(
    100.0 * count(*) filter (where coalesce(i.impressions, 0) = 0) / nullif(count(*), 0),
    1
  )                                                         as pct_invisible,
  -- The other tail: how much of all attention the top decile absorbed.
  round(
    100.0 * sum(i.impressions) filter (
      where i.impressions >= (
        select percentile_cont(0.9) within group (order by i2.impressions)
          from host_impressions i2 where i2.days = p.days
      )
    ) / nullif(sum(i.impressions), 0),
    1
  )                                                         as pct_attention_to_top_decile
  from posting_hosts p
  left join host_impressions i on i.days = p.days and i.host_id = p.host_id
 group by p.days
 order by p.days;


-- -----------------------------------------------------------------------------
-- 2. Gini over impressions per host
-- -----------------------------------------------------------------------------
--   gini = 2 * sum(i * x_i) / (n * sum(x_i)) - (n + 1) / n
-- with x sorted ascending and i the 1-based rank.
--
-- 0 = every host got the same number of impressions.
-- 1 = one host got all of them.
--
-- Hosts who posted but received nothing are included as zeros. Excluding them
-- would be measuring concentration only among hosts who were already being
-- seen, which is the question that cannot go wrong.
--
-- REFERENCE POINTS from the frozen simulator at N=600 (DIAGNOSTICS.md), for
-- orientation only — a simulator's absolute values do not transfer, but the
-- ORDERING of the algorithms should:
--   0.93  the v1.7 ranker, before the funnel repair
--   0.65  random ordering
--   0.40  the shipped configuration
-- A production number above ~0.75 warrants looking at what changed.

with windows as (
  select * from (values (7), (28)) as w(days)
),
per_host as (
  select
    w.days,
    a.host_id,
    coalesce((
      select count(*)
        from public.ranking_events r
       where r.host_id = a.host_id
         and r.event_type = 'impression'
         and r.created_at >= now() - make_interval(days => w.days)
    ), 0) as impressions
  from windows w
  join public.activities a
    on a.created_at >= now() - make_interval(days => w.days)
  group by w.days, a.host_id
),
ranked as (
  select
    days,
    impressions,
    row_number() over (partition by days order by impressions) as rn,
    count(*)  over (partition by days)                          as n,
    sum(impressions) over (partition by days)                   as total
  from per_host
)
select
  days                                        as window_days,
  n                                           as hosts,
  total                                       as impressions,
  case
    when n = 0 or total = 0 then null
    else round(
      (2.0 * sum(rn::numeric * impressions) / (n * total)) - ((n + 1.0) / n),
      3
    )
  end                                         as gini_impressions
  from ranked
 group by days, n, total
 order by days;


-- -----------------------------------------------------------------------------
-- 3. Gini over `im_in` per host
-- -----------------------------------------------------------------------------
-- Impressions measure what the RANKER did. Joins measure what people did with
-- what it showed them.
--
-- The gap between the two is the interesting quantity. If join-Gini is much
-- higher than impression-Gini, attention is being spread fairly and demand is
-- concentrating anyway — that is a product fact (some hosts are genuinely more
-- appealing) and not a ranking defect. If they track each other, the ranker is
-- manufacturing the concentration, which is the §D3 signature.

with windows as (
  select * from (values (7), (28)) as w(days)
),
per_host as (
  select
    w.days,
    a.host_id,
    coalesce((
      select count(*)
        from public.ranking_events r
       where r.host_id = a.host_id
         and r.event_type = 'im_in'
         and r.created_at >= now() - make_interval(days => w.days)
    ), 0) as joins
  from windows w
  join public.activities a
    on a.created_at >= now() - make_interval(days => w.days)
  group by w.days, a.host_id
),
ranked as (
  select
    days,
    joins,
    row_number() over (partition by days order by joins) as rn,
    count(*)  over (partition by days)                    as n,
    sum(joins) over (partition by days)                   as total
  from per_host
)
select
  days                                    as window_days,
  n                                       as hosts,
  total                                   as joins,
  case
    when n = 0 or total = 0 then null
    else round(
      (2.0 * sum(rn::numeric * joins) / (n * total)) - ((n + 1.0) / n),
      3
    )
  end                                     as gini_joins
  from ranked
 group by days, n, total
 order by days;


-- -----------------------------------------------------------------------------
-- 4. The named hosts, for a human to look at
-- -----------------------------------------------------------------------------
-- A distribution statistic tells you something is wrong. This tells you who it
-- happened to, which is what makes anyone act on it.

select
  a.host_id,
  count(distinct a.id)                                    as posts_7d,
  coalesce(sum(imp.impressions), 0)                       as impressions_7d,
  coalesce(sum(imp.joins), 0)                             as joins_7d,
  min(a.created_at)                                       as first_post_in_window
  from public.activities a
  left join lateral (
    select
      count(*) filter (where r.event_type = 'impression') as impressions,
      count(*) filter (where r.event_type = 'im_in')      as joins
      from public.ranking_events r
     where r.activity_id = a.id
       and r.created_at >= now() - interval '7 days'
  ) imp on true
 where a.created_at >= now() - interval '7 days'
 group by a.host_id
having coalesce(sum(imp.impressions), 0) = 0
 order by posts_7d desc, first_post_in_window
 limit 50;


-- =============================================================================
-- CAVEAT ON EARLY READINGS
--
-- `ranking_events` had 16 rows at the time this was written, and the v1.7
-- instrumentation is what starts filling it. Gini over a handful of hosts is
-- almost pure sampling noise: with 10 hosts and 40 impressions, a Gini of 0.5
-- and one of 0.7 are not distinguishable.
--
-- Do not act on these numbers until the 28-day window covers at least a few
-- hundred impressions across a few dozen posting hosts. v1.7 §D4 is the
-- cautionary tale — a confident three-seed verdict there was backwards, and it
-- was backwards in the direction that validated the existing design.
-- =============================================================================
