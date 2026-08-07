-- =============================================================================
-- CHURN AFTER AN EMPTY POST
--
-- Paste into the Supabase SQL editor and run. Read-only: no migration, no code
-- path, nothing written. Safe to run whenever.
--
-- -----------------------------------------------------------------------------
-- THE QUESTION
--
-- How much more likely is a host to stop posting after a post that got zero
-- joiners, compared with one that got at least one?
--
-- -----------------------------------------------------------------------------
-- WHY ANYONE SHOULD CARE
--
-- The ranker's demand-balancing layer boosts posts that are nearly empty and
-- happening soon. The entire justification for that layer is that an empty post
-- costs you a host. `scripts/population.ts` puts that cost at 18% — a number
-- that was WRITTEN DOWN, not measured, and the simulator's recommendation to
-- raise `demandWeight` is close to a restatement of it.
--
-- This query replaces the invented number with a measured one.
--
-- -----------------------------------------------------------------------------
-- DEFINITIONS — what each word means here, precisely
--
--   EMPTY POST     an `activities` row whose start time has passed and whose
--                  `confirmed_joiners` is 0.
--
--   FILLED POST    the same, with `confirmed_joiners >= 1`.
--
--   CHURNED        after post P, the host created NO `activities` row with a
--                  `created_at` later than P's start time. "They saw how it
--                  went and never posted again."
--
--   CENSORING      posts that started within the last :censor_days are EXCLUDED
--                  entirely. A host whose post went empty five days ago has not
--                  had time to post again, and counting them as churned would
--                  badly overstate the effect. This is the single most important
--                  line in the file.
--
-- -----------------------------------------------------------------------------
-- READ THE COUNTS, NOT THE RATES
--
-- There are ~63 activities in this database. After restricting to posts old
-- enough to judge, the group sizes will be in the low tens. At n=25 a 95%
-- interval is roughly +/-0.16 wide.
--
-- THE INTERVALS WILL PROBABLY OVERLAP, AND THAT OVERLAP IS THE FINDING. It
-- means "not yet measured", not "no difference". Every rate below is reported
-- next to its raw numerator and denominator so it is obvious how thin the
-- evidence is. No p-value is computed, deliberately: a p-value on n=25 invites
-- exactly the confident reading the numbers cannot support.
-- =============================================================================


-- The censoring window, in days. Change it here and nowhere else.
--
-- 14 is the shortest defensible value. Hosts post roughly every 5-6 days when
-- they are active, so 14 days is about two-and-a-half expected posts of
-- patience. If the headline moves a lot between 14 and 45 (query 3), the number
-- is measuring the window rather than the behaviour and none of it should be
-- used.
\set censor_days 14


-- -----------------------------------------------------------------------------
-- 1. THE HEADLINE
-- -----------------------------------------------------------------------------
-- Three rows: empty, filled, and the difference between them.

with judged as (
  -- Every post old enough to have an outcome we can trust.
  select
    a.id,
    a.host_id,
    a.starts_at,
    coalesce(a.confirmed_joiners, 0) = 0 as was_empty,
    not exists (
      select 1
        from public.activities later
       where later.host_id = a.host_id
         and later.created_at > a.starts_at
    ) as churned
  from public.activities a
  where a.starts_at < now() - make_interval(days => :censor_days)
),
grouped as (
  select
    was_empty,
    count(*)                            as hosts,
    count(*) filter (where churned)     as churned
  from judged
  group by was_empty
),
-- Wilson score interval at 95%. Used rather than the textbook normal interval
-- because at these counts the normal one produces bounds outside [0, 1] and is
-- simply wrong; Wilson stays honest down to single digits.
wilson as (
  select
    was_empty,
    hosts,
    churned,
    (churned::numeric / nullif(hosts, 0))                                as p,
    ((churned::numeric / hosts) + 1.96^2 / (2 * hosts)
      - 1.96 * sqrt(((churned::numeric / hosts) * (1 - churned::numeric / hosts)
                     + 1.96^2 / (4 * hosts)) / hosts)
    ) / (1 + 1.96^2 / hosts)                                             as lo,
    ((churned::numeric / hosts) + 1.96^2 / (2 * hosts)
      + 1.96 * sqrt(((churned::numeric / hosts) * (1 - churned::numeric / hosts)
                     + 1.96^2 / (4 * hosts)) / hosts)
    ) / (1 + 1.96^2 / hosts)                                             as hi
  from grouped
  where hosts > 0
)
select
  case when was_empty then '1. after an EMPTY post' else '2. after a FILLED post' end as cohort,
  hosts                                    as n_posts,
  churned                                  as n_churned,
  round(p, 3)                              as churn_rate,
  round(lo, 3)                             as ci_low,
  round(hi, 3)                             as ci_high,
  churned || ' of ' || hosts               as raw
  from wilson

union all

-- The difference, which is the actual quantity of interest. Its interval is the
-- independent-samples normal interval on the difference of two proportions —
-- adequate here because the CONCLUSION is almost always going to be "this
-- interval is far too wide to act on", and a wider-but-simpler interval cannot
-- make that conclusion wrong.
select
  '3. DIFFERENCE (empty - filled)'         as cohort,
  (select sum(hosts) from wilson)          as n_posts,
  null                                     as n_churned,
  round(
    (select p from wilson where was_empty) -
    (select p from wilson where not was_empty), 3)   as churn_rate,
  round(
    ((select p from wilson where was_empty) -
     (select p from wilson where not was_empty))
    - 1.96 * sqrt(
        coalesce((select p*(1-p)/hosts from wilson where was_empty), 0) +
        coalesce((select p*(1-p)/hosts from wilson where not was_empty), 0)
      ), 3)                                          as ci_low,
  round(
    ((select p from wilson where was_empty) -
     (select p from wilson where not was_empty))
    + 1.96 * sqrt(
        coalesce((select p*(1-p)/hosts from wilson where was_empty), 0) +
        coalesce((select p*(1-p)/hosts from wilson where not was_empty), 0)
      ), 3)                                          as ci_high,
  'see rows 1 and 2'                                 as raw;


-- -----------------------------------------------------------------------------
-- 2. HOW MUCH DATA IS THERE, REALLY
-- -----------------------------------------------------------------------------
-- Run this first if row 1 looks surprising. It is very easy to compute a
-- confident-looking rate over four posts.

select
  count(*)                                                        as activities_total,
  count(*) filter (where starts_at < now())                       as started,
  count(*) filter (where starts_at < now() - make_interval(days => :censor_days))
                                                                  as judgeable,
  count(*) filter (where starts_at < now() - make_interval(days => :censor_days)
                     and coalesce(confirmed_joiners, 0) = 0)      as judgeable_empty,
  count(distinct host_id)                                         as distinct_hosts
  from public.activities;


-- -----------------------------------------------------------------------------
-- 3. IS THE ANSWER AN ARTIFACT OF THE WINDOW?
-- -----------------------------------------------------------------------------
-- The empty-post churn rate at five different censoring windows. It should drift
-- DOWNWARD as the window widens (more time to come back). A sharp jump, or no
-- movement at all, means something is wrong with the definition rather than
-- interesting about hosts.

with windows as (select * from (values (7), (14), (21), (30), (45)) as w(days))
select
  w.days                                                          as censor_days,
  count(a.*)                                                      as n_empty_posts,
  count(a.*) filter (
    where not exists (
      select 1 from public.activities later
       where later.host_id = a.host_id and later.created_at > a.starts_at
    )
  )                                                               as n_churned,
  round(
    count(a.*) filter (
      where not exists (
        select 1 from public.activities later
         where later.host_id = a.host_id and later.created_at > a.starts_at
      )
    )::numeric / nullif(count(a.*), 0), 3)                        as churn_rate
  from windows w
  left join public.activities a
    on a.starts_at < now() - make_interval(days => w.days)
   and coalesce(a.confirmed_joiners, 0) = 0
 group by w.days
 order by w.days;


-- =============================================================================
-- HOW TO READ ROW 3 — the only part that decides anything
--
-- Look at `ci_low` and `ci_high` on the DIFFERENCE row. Three cases, and the
-- action is different in each.
--
--
-- CASE A — the interval EXCLUDES 0.18, and sits BELOW it
--   e.g. difference 0.06, interval [0.01, 0.11]
--
--   Empty posts cost fewer hosts than the simulator assumes. The demand layer
--   is doing real work but less of it than modelled, and the simulator's
--   recommendation to raise `demandWeight` was mostly an echo of its own input.
--   ACTION: leave `demandWeight` at 0.10. Note it in FUNNEL.md §7.
--
--
-- CASE B — the interval EXCLUDES 0.18, and sits ABOVE it
--   e.g. difference 0.31, interval [0.22, 0.40]
--
--   Empty posts are MORE costly than modelled. The demand layer is
--   under-weighted and the simulator was being conservative.
--   ACTION: raising `demandWeight` is now supported by data rather than by a
--   guess. Raise it in one step, not to 0.5, and re-run this query after.
--
--
-- CASE C — the interval CONTAINS 0.18   <-- the likely answer today
--   e.g. difference 0.15, interval [-0.09, 0.39]
--
--   Not measured. The data is consistent with 0.18 and also consistent with
--   almost every other value anyone would propose, which is not agreement.
--   ACTION: `demandWeight` stays at 0.10. Re-run this query at ~100 judgeable
--   posts (query 2 tells you where you are). Change nothing until then.
--
--
-- CASE C-ZERO — the interval CONTAINS 0.18 *and* contains 0
--   e.g. difference 0.10, interval [-0.14, 0.34]
--
--   Worth calling out separately, because it is the case with a real product
--   consequence. The data cannot rule out that empty posts do not drive host
--   churn AT ALL. If that held up at larger n, the entire demand-balancing
--   layer would be solving a problem that does not exist — and the sooner that
--   is known the better, because it is currently the single largest
--   viewer-independent effect in the shipped ordering.
--   ACTION: same as Case C — change nothing, re-run at ~100 posts. But flag it,
--   because it is the one outcome that would remove a feature rather than
--   retune one.
--
--
-- WHAT NEVER FOLLOWS FROM THIS QUERY
--   * A p-value. Not computed, on purpose.
--   * A change to any scoring constant other than `demandWeight`.
--   * Anything at all, if `judgeable` in query 2 is under ~30.
-- =============================================================================
