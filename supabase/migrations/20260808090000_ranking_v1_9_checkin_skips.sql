-- =============================================================================
-- v1.9 — check-in skips, and check-in idempotency
--
-- Additive and idempotent. One new table, one unique index on an existing
-- table. No column dropped, no data rewritten, no trigger changed.
--
-- -----------------------------------------------------------------------------
-- WHY A SEPARATE TABLE AND NOT A `response` VALUE ON `tandem_feedback`
--
-- A skip could have been stored as a third `response` value. It is not, for one
-- specific reason: **`tandem_feedback` row count is the headline health metric
-- for the beta** — see INTEGRATION.md §6, where it is named as the single most
-- important number to watch in the first month.
--
-- If a skip wrote a `tandem_feedback` row, that number would count people who
-- declined to answer as people who answered. The one metric that tells you
-- whether the check-in loop works at all would be inflated by exactly the
-- population it needs to exclude, and nobody would notice, because the number
-- would look healthy.
--
-- A second reason, smaller but real: `tandem_feedback.response`'s type could not
-- be verified from the repo (SCHEMA.md §5, assumption S4) and may carry a CHECK
-- constraint. Adding a sentinel value to a column whose constraint is unknown is
-- how a migration fails at 2am on someone else's database.
--
-- -----------------------------------------------------------------------------
-- WHAT A SKIP MEANS, AND WHAT IT DOES NOT
--
-- A skip means "do not ask me this one again". It is NOT a negative answer, and
-- nothing in this schema lets it become one:
--
--   * it lives in its own table, so no query for feedback can pick it up by
--     accident;
--   * it has no `rated_id`, because there is no judgement about a person here;
--   * it has no polarity column, so there is nothing to misread as a rating;
--   * `recordCheckInSkip` writes no `interest_events` row, so it contributes
--     zero to the interest model.
--
-- A person who did not answer is not a person who said no. Conflating the two
-- teaches people that answering honestly has consequences, which costs you the
-- signal permanently.
--
-- NOTE that this REVERSES the v1.7 behaviour, where a skip wrote nothing at all
-- and the prompt returned next session. v1.9 §3 specifies that a skip is
-- remembered. Both are defensible; the v1.7 rationale is preserved in
-- `core/checkin.ts` next to the code that now implements the other one.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. The skips table
-- -----------------------------------------------------------------------------

create table if not exists public.checkin_skips (
  tandem_id   uuid        not null,
  rater_id    uuid        not null,
  created_at  timestamptz not null default now(),
  primary key (tandem_id, rater_id)
);

comment on table public.checkin_skips is
  'One row per (tandem, rater) the user declined to answer. NOT a negative '
  'rating: no rated_id, no polarity, never mirrored into interest_events, and '
  'never counted in tandem_feedback. See v1.9 migration header.';

-- The primary key IS the idempotency guarantee: skipping twice is one row.

-- Lookup path is "everything this user skipped", which the PK's leading column
-- does not serve.
create index if not exists checkin_skips_rater_idx
  on public.checkin_skips (rater_id);


-- -----------------------------------------------------------------------------
-- 2. Row-level security
-- -----------------------------------------------------------------------------
-- Matches the posture of the other user-owned tables: a person may write and
-- read their own skips and nobody else's. There is nothing sensitive in a skip,
-- but "nothing sensitive" is not a reason to leave a table world-readable.

alter table public.checkin_skips enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'checkin_skips'
       and policyname = 'checkin_skips_own_insert'
  ) then
    create policy checkin_skips_own_insert on public.checkin_skips
      for insert to authenticated
      with check (auth.uid() = rater_id);
  end if;

  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'checkin_skips'
       and policyname = 'checkin_skips_own_select'
  ) then
    create policy checkin_skips_own_select on public.checkin_skips
      for select to authenticated
      using (auth.uid() = rater_id);
  end if;
end $$;


-- -----------------------------------------------------------------------------
-- 3. Check-in idempotency
-- -----------------------------------------------------------------------------
-- v1.9 §3: "a double-submit must not write two rows."
--
-- Enforced in the database rather than only in the client, because the client
-- cannot enforce it: a double-tap, a retry after a timeout that actually
-- succeeded, and two devices all produce two inserts that no amount of local
-- state prevents.
--
-- The key is (tandem_id, rater_id) — one answer per rater per tandem. `rated_id`
-- is NOT in the key: `tandems` is strictly pairwise (SCHEMA.md §1), so a rater
-- has exactly one counterpart per tandem, and including it would let a
-- malformed second row through under a different `rated_id`.
--
-- GUARD: this will FAIL if duplicate rows already exist. `tandem_feedback` had
-- zero rows at the time of writing (SCHEMA.md §2), so this should be clean.
-- If it is not, the query to find the duplicates is at the bottom of this file.

create unique index if not exists tandem_feedback_one_per_rater_idx
  on public.tandem_feedback (tandem_id, rater_id);


-- =============================================================================
-- VERIFY
-- =============================================================================
--
-- select
--   name,
--   case when to_regclass('public.' || name) is null then 'MISSING' else 'present' end
-- from unnest(array[
--   'checkin_skips',
--   'checkin_skips_rater_idx',
--   'tandem_feedback_one_per_rater_idx'
-- ]) as name;
--
-- If §3 failed, these are the duplicates blocking it:
--
-- select tandem_id, rater_id, count(*)
--   from public.tandem_feedback
--  group by tandem_id, rater_id
-- having count(*) > 1;
--
-- =============================================================================
-- ROLLBACK
--
-- drop index concurrently if exists public.tandem_feedback_one_per_rater_idx;
-- drop table if exists public.checkin_skips;
--
-- Dropping the table loses the record of who skipped what, which means those
-- check-ins become askable again. That is a degradation, not data loss — the
-- feedback rows themselves are untouched.
-- =============================================================================
