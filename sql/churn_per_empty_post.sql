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
--   CENSORING      posts that started within the last N days are EXCLUDED
--                  entirely. A host whose post went empty five days ago has not
--                  had time to post again, and counting them as churned would
--                  badly overstate the effect. This is the single most important
--                  line in the file — and because N is a judgement call, every
--                  query below reports more than one value of it rather than
--                  picking one.
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


-- -----------------------------------------------------------------------------
-- THE CENSORING WINDOW IS REPORTED, NOT CHOSEN
--
-- v1.9 pinned one window and reported one number. That hid the thing most worth
-- knowing at this sample size: how much the answer depends on the window.
--
-- Query 1 therefore reports BOTH ARMS AT BOTH 14 AND 30 DAYS, side by side.
-- 14 is the shortest defensible value — hosts post roughly every 5-6 days when
-- active, so it is about two-and-a-half expected posts of patience. 30 is long
-- enough that a host who was ever coming back has.
--
-- If the point estimate moves materially between the two, the number is
-- measuring the WINDOW rather than the BEHAVIOUR, and it is not stable enough to
-- move `demandWeight` — which stays at 0.10 until the sample grows. See "HOW TO
-- READ THIS" at the bottom, case D.
--
-- NOTE: no psql backslash commands and no `:variables` anywhere in this file.
-- The Supabase SQL editor is not psql and silently does not support them. To
-- change the windows, edit the `values` list in each query.
-- -----------------------------------------------------------------------------


-- -----------------------------------------------------------------------------
-- 1. THE HEADLINE, AT BOTH WINDOWS
-- -----------------------------------------------------------------------------
-- Five rows per window: empty, filled, and the difference between them.

with windows as (
  select * from (values (14), (30)) as w(days)
),
judged as (
  -- Every post old enough to have an outcome we can trust, at each window. A
  -- post appears once per window it qualifies for, so the 14-day rows are a
  -- superset of the 30-day rows and the two are NOT independent samples. That is
  -- fine for a sensitivity check and would not be fine for a test of difference
  -- between windows — which is why none is computed.
  select
    w.days,
    a.id,
    a.host_id,
    coalesce(a.confirmed_joiners, 0) = 0 as was_empty,
    not exists (
      select 1
        from public.activities later
       where later.host_id = a.host_id
         and later.created_at > a.starts_at
    ) as churned
  from windows w
  join public.activities a
    on a.starts_at < now() - make_interval(days => w.days)
),
grouped as (
  select
    days,
    was_empty,
    count(*)                            as posts,
    count(*) filter (where churned)     as churned
  from judged
  group by days, was_empty
),
-- Wilson score interval at 95%. Used rather than the textbook normal interval
-- because at these counts the normal one produces bounds outside [0, 1] and is
-- simply wrong; Wilson stays honest down to single digits.
wilson as (
  select
    days,
    was_empty,
    posts,
    churned,
    (churned::numeric / nullif(posts, 0))                                as p,
    ((churned::numeric / posts) + 1.96^2 / (2 * posts)
      - 1.96 * sqrt(((churned::numeric / posts) * (1 - churned::numeric / posts)
                     + 1.96^2 / (4 * posts)) / posts)
    ) / (1 + 1.96^2 / posts)                                             as lo,
    ((churned::numeric / posts) + 1.96^2 / (2 * posts)
      + 1.96 * sqrt(((churned::numeric / posts) * (1 - churned::numeric / posts)
                     + 1.96^2 / (4 * posts)) / posts)
    ) / (1 + 1.96^2 / posts)                                             as hi
  from grouped
  where posts > 0
),
diffs as (
  -- The difference, which is the actual quantity of interest. Its interval is
  -- the independent-samples normal interval on the difference of two
  -- proportions — adequate here because the CONCLUSION is almost always going to
  -- be "this interval is far too wide to act on", and a wider-but-simpler
  -- interval cannot make that conclusion wrong.
  select
    w.days,
    e.p - f.p                                                          as d,
    (e.p - f.p) - 1.96 * sqrt(coalesce(e.p * (1 - e.p) / e.posts, 0)
                            + coalesce(f.p * (1 - f.p) / f.posts, 0))   as lo,
    (e.p - f.p) + 1.96 * sqrt(coalesce(e.p * (1 - e.p) / e.posts, 0)
                            + coalesce(f.p * (1 - f.p) / f.posts, 0))   as hi,
    coalesce(e.posts, 0) + coalesce(f.posts, 0)                         as posts
  from windows w
  left join wilson e on e.days = w.days and e.was_empty
  left join wilson f on f.days = w.days and not f.was_empty
)
select
  days                                     as censor_days,
  case when was_empty then '1. after an EMPTY post' else '2. after a FILLED post' end as cohort,
  posts                                    as n_posts,
  churned                                  as n_churned,
  round(p, 3)                              as rate,
  round(lo, 3)                             as ci_low,
  round(hi, 3)                             as ci_high,
  churned || ' of ' || posts               as raw
  from wilson

union all

select
  days                                     as censor_days,
  '3. DIFFERENCE (empty - filled)'         as cohort,
  posts                                    as n_posts,
  null                                     as n_churned,
  round(d, 3)                              as rate,
  round(lo, 3)                             as ci_low,
  round(hi, 3)                             as ci_high,
  'see rows 1 and 2'                       as raw
  from diffs

 order by censor_days, cohort;


-- -----------------------------------------------------------------------------
-- 2. HOW MUCH DATA IS THERE, REALLY
-- -----------------------------------------------------------------------------
-- Run this first if query 1 looks surprising. It is very easy to compute a
-- confident-looking rate over four posts.
--
-- `judgeable` is the number that decides whether ANY of this is actionable. If
-- it is under ~30 at both windows, nothing below follows from the data.

with windows as (select * from (values (14), (30)) as w(days))
select
  w.days                                                          as censor_days,
  (select count(*) from public.activities)                        as activities_total,
  (select count(*) from public.activities where starts_at < now()) as started,
  count(a.*)                                                      as judgeable,
  count(a.*) filter (where coalesce(a.confirmed_joiners, 0) = 0)   as judgeable_empty,
  count(distinct a.host_id)                                       as judgeable_hosts
  from windows w
  left join public.activities a
    on a.starts_at < now() - make_interval(days => w.days)
 group by w.days
 order by w.days;


-- -----------------------------------------------------------------------------
-- 3. IS THE ANSWER AN ARTIFACT OF THE WINDOW?
-- -----------------------------------------------------------------------------
-- The empty-post churn rate at five censoring windows: query 1's 14-vs-30
-- comparison extended far enough to see the SHAPE of the drift rather than just
-- its sign.
--
-- It should drift DOWNWARD as the window widens (more time to come back). A
-- sharp jump, or no movement at all, means something is wrong with the
-- definition rather than interesting about hosts.
--
-- Empty arm only, deliberately: this is a diagnostic on the definition, not an
-- estimate of the effect. Query 1 is where both arms are compared.

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
-- HOW TO READ THIS — the only part that decides anything
--
-- Look at `ci_low` and `ci_high` on the DIFFERENCE rows. Four cases, and the
-- action is different in each.
--
-- CHECK CASE D FIRST. It is a gate on the other three: if the estimate is not
-- stable across the two windows, A/B/C are being read off a number that does
-- not exist yet, and the interval they are read from is not the real one.
--
--
-- CASE D — the two windows DISAGREE                    <-- check this first
--   e.g. difference 0.31 at 14 days, 0.09 at 30 days
--
--   The estimate is measuring the CENSORING WINDOW, not host behaviour. Some
--   downward drift is expected and fine — a wider window gives hosts more time
--   to come back, so the 30-day rate should be a little lower. What matters is
--   whether the two are close enough that the choice of window does not change
--   the decision.
--
--   Concretely: if the 14-day and 30-day differences fall in different cases
--   below, or if one point estimate sits outside the other's interval, the
--   number is not stable enough to move a constant.
--
--   ACTION: `demandWeight` stays at 0.10. Do not pick the window that gives the
--   more interesting answer — that is the whole failure mode this comparison
--   exists to prevent. Re-run at ~100 judgeable posts and check D again before
--   reading anything else.
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
--   REQUIRES CASE D TO PASS. This is the only case that moves a constant, so it
--   is the only one where window instability actually costs anything — and it is
--   also the one whose conclusion is most flattering to the existing model,
--   which is exactly when to be strictest about the gate.
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
--   * Anything at all, if the two windows disagree (case D).
--   * A comparison BETWEEN the windows treated as evidence. The 14-day and
--     30-day sets overlap almost entirely — the same posts, judged twice — so
--     they are not two samples and their difference is not an effect.
-- =============================================================================
