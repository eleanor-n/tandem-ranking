# SCHEMA

The reconciliation record. **This file wins over the v1.5 and v1.6 migrations
wherever they disagree**, because those were written against a schema that was
not available and guessed wrong in three places.

Everything below marked ✅ is a stated fact about the live database. Everything
marked ❓ is an assumption this build still makes and could not verify from the
repo alone — each one has a `SELECT` in the PRECHECK block of
`supabase/migrations/20260802100000_ranking_v1_7_instrumentation.sql`. **Run the
PRECHECK first.** If any ❓ comes back different, fix it there before applying
anything, and update this file.

---

## 1. The correction that invalidates the most code: `activities` ≠ `tandems`

| | `activities` | `tandems` |
|---|---|---|
| what it is | the **posts** | the realised **pairings** |
| rows | 63 | 23 with `status = 'completed'` |
| shape | one row per post | strictly pairwise: `user_a_id` / `user_b_id` |
| capacity | `max_participants` — joiners wanted, **excluding the host**; 59 of 63 are `1` | n/a |

**The completion signal is `tandems.status` becoming `'completed'`.**

Not `activities.status` — that is the v1.6 guess and it is wrong. Not
`tandem_completions` — 2 rows against 23 completed tandems, so it is not a
reliable signal and this build does not read or write it.

### What that broke

`supabase/migrations/20260731120000_ranking_v1_5.sql` §6 attaches
`trg_graph_edges_on_completion` to `activities` and reads
`public.activity_participants`. **That table does not exist.** The migration's
`DO` block checks `to_regclass('public.activity_participants') is not null`
before attaching, so if v1.5 was applied the trigger was silently never created
and `graph_edges` has been empty since day one. Either way the design was wrong.

The v1.7 migration drops the trigger and the function unconditionally and
replaces them with a derived aggregate (§4 below).

---

## 2. Table-by-table

| Table | Status | This build's action |
|---|---|---|
| `activities` | ✅ exists; `max_participants` = joiners excluding host | Read `max_participants` as `targetJoiners`. **Drop `activities.target_joiners`**, which v1.6 added redundantly. Keep `confirmed_joiners`. |
| `tandems` | ✅ exists, strictly pairwise, `status` is the completion signal | Add `tandem_group_id uuid null` (§3). Source of truth for `graph_edges`. |
| `activity_participants` | ✅ **does not exist** | Drop the v1.5 trigger + function that reference it. |
| `tandem_completions` | ✅ exists; one row per participant; `user_id_1`/`user_id_2` are dead legacy, zero rows populated; **2 rows total** | Not a completion signal. Not migrated. Not read. Left alone. |
| `tandem_feedback` | ✅ already per-pair: `tandem_id`, `rater_id`, `rated_id`, `response`. Zero rows | **No migration.** The check-in writes it as-is. `rated_id` is the per-pair subject. |
| `join_requests` | ✅ has `activity_id`, `status` | Source for the `confirmed_joiners` trigger. |
| `ranking_events` | ✅ has `score_snapshot` jsonb, `deck_position`, `host_id`; **16 rows**; no `session_id` | **The impression table.** Add `session_id text`. Keep the 16 rows; make `score_snapshot` nullable. |
| `feed_impressions` | ✅ has `session_id`, `score_breakdown`, `score`, `position_in_feed`, `is_featured`, `is_serendipity`; **zero rows** | **Deprecated.** Table comment + an architectural test that fails if any source file names it. |
| `graph_edges` | created by v1.5, empty | Becomes a derived aggregate. See §4. |
| `interest_events`, `user_interest_state` | created by v1.5 | Unchanged. |

### Why `ranking_events` won the duplicate-impression-table question

Two tables with overlapping jobs is how a training set ends up split across
schemas — half the labels in one place, half in another, and no way to join them
after the fact. `ranking_events` wins on two counts that `feed_impressions`
cannot answer: it has `host_id` (so the supply side of the funnel is
reconstructable) and it has data.

The 16 existing rows are **not** migrated. They predate the current snapshot
shape, so rewriting them would be inventing history; leaving them with a null
`score_snapshot` is honest and costs nothing.

---

## 3. Group tandems

`tandems` is strictly pairwise and stays the primitive. When group tandems
arrive they are **a clique of pairwise rows sharing a group identifier** — a
3-person tandem is 3 rows (`A-B`, `A-C`, `B-C`), not 1.

Everything downstream is already pair-keyed and needs no change under that
model: `graph_edges` is pairwise, `tandem_feedback` is `(rater_id, rated_id)`,
exhaustion counts `completedTogether` per viewer/host pair.

This build adds `tandems.tandem_group_id uuid null` so the pattern is available,
and nothing else. No group support is implemented.

---

## 4. `graph_edges` is a derived aggregate, not a triggered table

`tandems` is already an edge list: pairwise, with a completion status. Keeping a
second copy in sync by trigger buys nothing and adds a failure mode — v1.6's
trigger silently never fired, and if it had half-fired the table would have been
wrong in a way nothing would detect.

So: `public.rebuild_graph_edges()` recomputes `graph_edges` from scratch over
`tandems WHERE status = 'completed'`. A broken or missed refresh loses nothing,
because the source of truth is `tandems` and the aggregate is reproducible at
any time.

Consumption stays stubbed at zero — `graphAffinity()` returns 0 and the `graph`
retrieval source returns `[]`, both with their final signatures.

---

## 5. Assumptions this build still makes (❓ — verify with PRECHECK)

| # | Assumption | Why it matters | If wrong |
|---|---|---|---|
| S1 | `tandems` has an `activity_id` linking a pairing to the post it came from | The check-in needs the activity's **category** to mirror into `interest_events`, and the activity's **end time** to know when to ask | Check-in still writes `tandem_feedback`; the `interest_events` mirror and the timing trigger both degrade to no-ops rather than guessing |
| S2 | `join_requests.status = 'accepted'` is the terminal accepted state | `confirmed_joiners` counts it | Count is wrong in one direction; the trigger recounts absolutely, so fixing the literal and re-running the backfill repairs it |
| S3 | `activities` has an end time (`ends_at`) | "next app open after the activity's end time" | Falls back to `starts_at + CONSTANTS.checkin.assumedDurationHours`. Marked UNMEASURED |
| S4 | `tandem_feedback.response` accepts a boolean-ish yes/no | The check-in answer is binary | The writer sends whatever `CONSTANTS.checkin.responseValues` says; one edit |
| S5 | The v1.5 and v1.6 migrations were actually applied | v1.7 is additive on top of them | Every v1.7 statement is independently guarded with `IF NOT EXISTS`, so v1.7 applies cleanly either way |
| S6 | `activities` has `impression_count`, or it does not and the adapter reads 0 | The impression floor | Degrades to "no post is ever starved", which is inert, not wrong |
| S7 | `tandems` has `created_at` | `rebuild_graph_edges()` uses it for `first_seen` / `last_seen` | The rebuild fails loudly at the first run. Substitute whatever timestamp column P3 reveals — the edge weights do not depend on it |
| S8 | `graph_edges.user_a` / `user_b` accept whatever `tandems.user_a_id` contains | The v1.5 table declares FKs to `profiles(id)` | A completed tandem referencing a deleted profile would fail the rebuild. Drop the FK or filter the select |

---

## 6. Naming conflict, surfaced rather than resolved silently

The v1.7 build prompt says to mirror check-ins into `interest_events` as
**`checkin_positive` / `checkin_negative`**. This repo has used
**`checkin_yes` / `checkin_no`** since v1.5, and those slugs are load-bearing in
three places: the `ranking_events.event_type` check constraint, the
`INTEREST_SOURCES` weight/half-life table (1.2 @ 120d and 0.8 @ 90d — the
highest-weighted signal in the model), and `scripts/backfill-interest-events.ts`.

Writing the prompt's slugs would produce rows whose `source` matches no entry in
`INTEREST_SOURCES`, so they would fold in at **zero weight**: the single most
predictive signal in the system, silently contributing nothing.

**Resolution:** this build keeps `checkin_yes` / `checkin_no` on the wire, and
routes every write through `CONSTANTS.checkin.interestSource`, which is a
two-entry map. If the framework document really does specify the other names,
renaming is one edit there plus a widened check constraint — and the weights
come with it.

---

## 7. Reconciling `confirmed_joiners` against reality

The trigger recounts rather than increments, so it converges rather than
drifting. To verify at any time:

```sql
-- Should return zero rows. Any row is a drift and re-running the backfill
-- statement in the v1.6 migration fixes it.
select a.id,
       a.confirmed_joiners as denormalised,
       count(jr.*) filter (where jr.status = 'accepted') as actual
  from public.activities a
  left join public.join_requests jr on jr.activity_id = a.id
 group by a.id, a.confirmed_joiners
having a.confirmed_joiners is distinct from
       count(jr.*) filter (where jr.status = 'accepted');
```
