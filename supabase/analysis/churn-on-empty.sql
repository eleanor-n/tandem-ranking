-- =============================================================================
-- CHURN AFTER AN EMPTY POST — measuring the model's load-bearing guess
--
-- Run in the SQL editor with the service role.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS IS FOR
--
-- `scripts/population.ts` contains three numbers that were authored, not
-- measured:
--
--     churnPerEmptyPost   0.18     quit for good after a post that got nobody
--     churnPerFilledPost  0.01     quit after a post that filled
--     churnCompounding    1.6      per consecutive empty post
--
-- Every simulator conclusion about demand balancing is downstream of the first
-- one. That is not a general complaint about simulation — it is specific and
-- mechanical. `demandWeight` boosts under-filled posts; the benefit of doing so
-- is the churn it averts; the churn it averts is `churnPerEmptyPost`. Sweeping
-- demandWeight against this model is close to asking the model to restate its
-- own assumption back as a finding, and the sweep's answer (5x the shipped
-- weight is best) should be read in that light.
--
-- The DIRECTION is robust — demand balancing helped in every configuration
-- tested, which is a weaker claim resting on much less. The MAGNITUDE is not.
--
-- So measure the guess. One number, from live data, replacing an invented one.
--
-- ---------------------------------------------------------------------------
-- READ THIS BEFORE READING THE RESULT
--
-- At the time of writing the database holds ~63 activities and ~23 completed
-- tandems. After restricting to each host's FIRST post, and to first posts old
-- enough that a return would have shown up, the denominator will be somewhere
-- in the low tens. **A proportion measured on n=25 has a 95% interval roughly
-- ±0.16 wide.** It will not distinguish 0.18 from 0.05. It may not distinguish
-- 0.18 from 0.40.
--
-- Query 1 therefore reports the Wilson interval alongside the point estimate,
-- and query 4 reports how large n needs to get. Read the interval. A point
-- estimate from this query, quoted on its own, is the same error as ranking
-- four arms 0.011 apart without standard errors.
--
-- DECISION RULE, fixed in advance so the answer cannot be read selectively:
--
--   * interval excludes 0.18 and sits BELOW it
--       -> the sim overstates empty-post churn; ablation C's margin is
--          substantially authored, and demandWeight should not be raised on
--          the strength of it.
--   * interval excludes 0.18 and sits ABOVE it
--       -> the sim understates it; the demand recommendation is conservative.
--   * interval CONTAINS 0.18  (the likely outcome at current n)
--       -> not yet measured. The assumption is neither confirmed nor refuted.
--          Do not treat "contains 0.18" as "0.18 is right" — an interval from
--          0.04 to 0.42 contains almost every value anyone would propose.
--          Raise demandWeight modestly on the direction alone, and re-run this
--          when n clears the threshold in query 4.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 0. Parameters
-- -----------------------------------------------------------------------------
-- OBSERVATION_DAYS is the window a host gets to come back in before we are
-- willing to call them gone. It must be long enough that a returning host would
-- probably have returned: the model's posting rate is 0.18/day, i.e. a mean gap
-- near 5.5 days, so 30 days is roughly five expected posts of patience.
--
-- Too short and every recent host is miscounted as churned. Too long and the
-- denominator shrinks to nothing. 30 is a compromise; run it at 21 and 45 too
-- and check the answer is not an artifact of the choice.

\set observation_days 30


-- -----------------------------------------------------------------------------
-- 1. The headline: churn after an empty first post, with its interval
-- -----------------------------------------------------------------------------
-- "Churn" here is RIGHT-CENSORED and weaker than the model's version. The model
-- churns a host permanently. This measures "has not posted again within
-- OBSERVATION_DAYS", which includes people who will come back in week seven.
-- It is therefore an UPPER bound on true quit-for-good, and the gap between the
-- two grows the shorter the window.

with first_posts as (
  select distinct on (a.host_id)
    a.host_id,
    a.id           as first_activity_id,
    a.created_at   as first_created_at,
    a.starts_at    as first_starts_at,
    coalesce(a.confirmed_joiners, 0) as first_joiners
  from public.activities a
  order by a.host_id, a.created_at
),
observed as (
  -- The post has happened AND the host has had a fair chance to come back.
  select *
    from first_posts
   where first_starts_at < now()
     and first_starts_at < now() - make_interval(days => :observation_days)
),
outcomes as (
  select
    o.host_id,
    (o.first_joiners = 0) as was_empty,
    exists (
      select 1 from public.activities a2
       where a2.host_id = o.host_id
         and a2.created_at > o.first_starts_at   -- after they knew how it went
    ) as came_back
  from observed o
),
tallied as (
  select
    was_empty,
    count(*)                                  as n,
    count(*) filter (where not came_back)     as churned
  from outcomes
  group by was_empty
)
select
  case when was_empty then 'first post got NOBODY' else 'first post filled' end as cohort,
  n,
  churned,
  round(churned::numeric / nullif(n, 0), 3)                    as churn_rate,
  -- Wilson score interval, 95%. Correct at small n where the normal
  -- approximation is not; it also cannot produce a bound outside [0,1], which
  -- the textbook interval cheerfully does at these counts.
  round(
    ( (churned::numeric / n) + 1.96^2 / (2*n)
      - 1.96 * sqrt( ((churned::numeric/n) * (1 - churned::numeric/n) + 1.96^2/(4*n)) / n )
    ) / (1 + 1.96^2/n), 3)                                     as ci_low,
  round(
    ( (churned::numeric / n) + 1.96^2 / (2*n)
      + 1.96 * sqrt( ((churned::numeric/n) * (1 - churned::numeric/n) + 1.96^2/(4*n)) / n )
    ) / (1 + 1.96^2/n), 3)                                     as ci_high,
  case when was_empty then 0.18 else 0.01 end                  as model_assumes
  from tallied
 order by was_empty desc;


-- -----------------------------------------------------------------------------
-- 2. The compounding assumption (churnCompounding = 1.6)
-- -----------------------------------------------------------------------------
-- Does the second consecutive empty post kill more hosts than the first?
--
-- This will almost certainly be empty or n<5 at current volume. That is a
-- finding — it means the compounding factor is entirely unmeasured, and the
-- fact that it is 1.6 rather than 1.0 has been silently shaping every churn
-- number the sim has produced. Run it anyway so the emptiness is on the record.

with ordered as (
  select
    a.host_id,
    a.starts_at,
    coalesce(a.confirmed_joiners, 0) = 0 as empty,
    row_number() over (partition by a.host_id order by a.created_at) as seq
  from public.activities a
  where a.starts_at < now()
),
streaks as (
  select
    host_id, starts_at, seq, empty,
    -- Length of the run of empties ending at this post.
    seq - max(case when not empty then seq else 0 end)
          over (partition by host_id order by seq
                rows between unbounded preceding and current row) as empty_streak
  from ordered
),
at_risk as (
  select
    s.host_id, s.starts_at, s.empty_streak,
    exists (
      select 1 from public.activities a2
       where a2.host_id = s.host_id and a2.created_at > s.starts_at
    ) as came_back
  from streaks s
  where s.empty
    and s.starts_at < now() - make_interval(days => :observation_days)
)
select
  empty_streak                                    as consecutive_empties,
  count(*)                                        as n,
  count(*) filter (where not came_back)           as churned,
  round(count(*) filter (where not came_back)::numeric / nullif(count(*), 0), 3) as churn_rate,
  round(0.18 * power(1.6, empty_streak - 1), 3)   as model_assumes
  from at_risk
 group by empty_streak
 order by empty_streak;


-- -----------------------------------------------------------------------------
-- 3. Sensitivity to the window
-- -----------------------------------------------------------------------------
-- If the headline moves a lot between 21 and 45 days, the number is measuring
-- the window rather than the behaviour, and none of it should be used.

with windows as (select * from (values (14), (21), (30), (45), (60)) as w(days)),
first_posts as (
  select distinct on (a.host_id)
    a.host_id, a.starts_at as first_starts_at,
    coalesce(a.confirmed_joiners, 0) as first_joiners
  from public.activities a
  order by a.host_id, a.created_at
)
select
  w.days                                                   as window_days,
  count(*)                                                 as n_empty_first_posts,
  count(*) filter (
    where not exists (
      select 1 from public.activities a2
       where a2.host_id = f.host_id and a2.created_at > f.first_starts_at
    )
  )                                                        as churned,
  round(
    count(*) filter (
      where not exists (
        select 1 from public.activities a2
         where a2.host_id = f.host_id and a2.created_at > f.first_starts_at
      )
    )::numeric / nullif(count(*), 0), 3)                   as churn_rate
  from windows w
  join first_posts f
    on f.first_joiners = 0
   and f.first_starts_at < now() - make_interval(days => w.days)
 group by w.days
 order by w.days;


-- -----------------------------------------------------------------------------
-- 4. How much data would settle it
-- -----------------------------------------------------------------------------
-- n needed for a 95% interval narrow enough to exclude 0.05 when the truth is
-- 0.18 — i.e. to tell "the sim is roughly right" from "the sim invented a
-- number 3.6x too large".
--
--   n ~= (1.96 / half_width)^2 * p * (1 - p)
--
-- and reports where the current denominator sits against it.

with first_posts as (
  select distinct on (a.host_id)
    a.host_id, a.starts_at as first_starts_at,
    coalesce(a.confirmed_joiners, 0) as first_joiners
  from public.activities a
  order by a.host_id, a.created_at
),
have as (
  select count(*) as n
    from first_posts
   where first_joiners = 0
     and first_starts_at < now() - interval '30 days'
)
select
  h.n                                                   as empty_first_posts_today,
  ceil(power(1.96 / 0.065, 2) * 0.18 * 0.82)::int       as n_needed_to_exclude_0_05,
  ceil(power(1.96 / 0.040, 2) * 0.18 * 0.82)::int       as n_needed_to_pin_within_4pts,
  case
    when h.n >= ceil(power(1.96 / 0.065, 2) * 0.18 * 0.82)
      then 'ENOUGH — read query 1 as a measurement'
    else 'NOT ENOUGH — query 1 is a direction, not a magnitude'
  end                                                   as verdict
  from have h;


-- =============================================================================
-- WHAT TO DO WITH THE ANSWER
--
-- Whatever comes back, it does NOT retroactively validate or invalidate the
-- Gini finding, which does not depend on the churn model at all: Gini is
-- computed from the impression and joiner distribution the ranker produces, and
-- would read 0.842 if churn were zero.
--
-- It bears on exactly one thing: how much to trust the size of ablation C's
-- margin, and therefore how far to move `demandWeight`. Nothing else in
-- DIAGNOSTICS.md is downstream of it.
-- =============================================================================
