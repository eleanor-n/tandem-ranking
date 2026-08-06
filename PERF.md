# PERF

Backend performance audit — v1.8 §5. Written read-only; **§1, §2 and §4 were
subsequently fixed in v1.9** on the reasoning below. The rest stands as audit.

> ### v1.9 status
>
> | # | item | then | now |
> |---|---|---|---|
> | 1 | Spatial filtering | 🟥 correctness bug | ✅ fixed — `viewerBounds`, `SPATIAL_FILTER_UNBOUNDED` alarm, `activities_geo_idx` |
> | 2 | `seenHostIds` unbounded | 🟥 | ✅ fixed — 90-day window, 5,000-row cap, covering index |
> | 4 | Missing indexes | 🟧 | ✅ fixed — `20260807090000_ranking_v1_9_indexes.sql`, 7 indexes |
> | 3, 5 | Interest cache, `ranking_events` growth | 🟧 | ⬜ open, still convenient-to-fix |
> | 6–11 | | 🟩 | 🟩 unchanged, still fine |
>
> **Why §1 jumped the queue.** It was the only item in this audit that is a
> *correctness* bug rather than a speed one, and it interacts with the
> instrumentation plan: impressions logged from a candidate set selected by time
> rather than distance carry no marker distinguishing them, so the first weeks of
> `ranking_events` — the data the whole instrumentation-first strategy is waiting
> a quarter to collect — would have been contaminated at the source. Logging a
> broken candidate set is worse than logging nothing.
>
> **Also fixed, and not in the original audit:** the adapter had no tests. The
> structural `SupabaseLike` type checks the shape of the query *builder* and
> cannot check the shape of the *query*, which is precisely where §1 lived —
> typechecks clean, runs fast, returns the wrong rows. `tests/adapter.test.ts`
> now asserts queries rather than results.

Baseline is the live database as recorded in [`SCHEMA.md`](SCHEMA.md): **63
activities, ~40 users, 16 `ranking_events` rows.** Projections are to **5,000
activities / 5,000 users**, roughly 80× on both axes.

Each item is marked:

| | |
|---|---|
| 🟥 | breaks before 5,000. Fix before it hurts |
| 🟧 | degrades noticeably. Fix when convenient |
| 🟩 | **fine now and fine at 5,000.** Do not touch it |

A review that flags everything is useless, so the 🟩s are load-bearing: they are
the parts nobody needs to think about again.

---

## Summary

| # | item | verdict |
|---|---|---|
| 1 | Spatial filtering | 🟥 **this is the ceiling, and it is a correctness bug before it is a speed one** |
| 2 | `seenHostIds` in `loadViewer` | 🟥 unbounded per-user scan, grows forever |
| 3 | Interest state on the deck path | 🟧 the cache exists and is never read |
| 4 | Missing indexes | 🟧 four, one of which is on a trigger's hot path |
| 5 | `ranking_events` growth | 🟧 ~11 GB/year at 5,000 MAU. Decide now |
| 6 | `.find()` in scoring | 🟩 none. The harness bug did not exist here |
| 7 | `confirmed_joiners` trigger | 🟩 recount is correct; needs one index (§4) |
| 8 | Impression buffer | 🟩 correct as built |
| 9 | `getPendingCheckIns` | 🟩 no N+1 |
| 10 | `rebuildGraphEdges()` | 🟩 free until ~1M completed tandems |
| 11 | RLS on insert-heavy tables | 🟩 cheap by construction |

---

## 1. 🟥 Spatial filtering — the ceiling

**Current.** There are no feed views and no RPCs. `loadCandidates` in
`adapter/supabase.ts` issues:

```sql
select * from activities
 where starts_at >= now() - interval '30 days'
 order by starts_at asc
 limit 500;
```

Distance is then computed **client-side**, by an injected `distanceMiles(row)`,
over whatever came back.

**Cost now.** 63 rows. Nothing. Payload under 50 KB.

**Cost at 5,000 activities.** The `limit(500)` still returns 500 rows — but this
is not primarily a speed problem.

> **The `limit` is ordered by `starts_at`, not by distance. At 5,000 activities
> it returns the 500 SOONEST posts globally, and the ranker — whose shipped
> algorithm is proximity-first — then sorts a set that was never filtered by
> proximity.**

A user in Brooklyn with 200 posts inside their radius can receive a page of 500
that contains almost none of them, because 500 sooner-starting posts existed
elsewhere. The deck is not slow; it is wrong, and it degrades silently as the
map fills in. This is the single most important finding in this audit.

Payload at 500 rows of `select *` is roughly **200–400 KB** uncompressed, per
deck fetch, on mobile. Discover fetches repeatedly within a session.

**Fix, in order.**

1. **Bounding box + btree, first.** One migration, no extension:
   ```sql
   create index if not exists activities_geo_idx on public.activities (lat, lng);
   ```
   and add `.gte('lat', …).lte('lat', …).gte('lng', …).lte('lng', …)` to
   `loadCandidates`, with the box computed from the viewer's radius. Postgres
   uses the index for the `lat` range and filters `lng`. This removes the
   correctness bug, which is the urgent half.
2. **Stop `select *`.** Project only the columns the adapter's `COLUMNS` map
   actually reads. That is most of the payload win and costs one line.
3. **GiST later, not now.** `earthdistance`'s `ll_to_earth` + a GiST index, or
   PostGIS, is the right end state — a bounding box stops being selective in a
   dense metro where everyone is inside the box. But it is a second migration
   and an extension dependency, and the box fixes the correctness problem today.

The ordering matters: this is the ceiling on everything else, because a
proximity-first algorithm reading a non-proximity-filtered page cannot be
rescued by any amount of scoring work downstream.

---

## 2. 🟥 `seenHostIds` — an unbounded scan that grows forever

**Current.** `loadViewer` derives fresh-host detection like this:

```sql
select host_id from ranking_events
 where user_id = $1 and event_type = 'impression';
```

No time bound. No limit.

**Cost now.** 16 rows in the whole table.

**Cost at 5,000 MAU.** This returns **every impression the user has ever had**.
A moderately active user seeing 30 cards a day accumulates ~11,000 rows a year;
the query returns all of them, over the wire, to build a `Set` of maybe 200
distinct host ids. It grows monotonically and never plateaus — the one shape of
query that is fine in every test and eventually fine in no production.

**Fix.** Bound it and dedupe server-side:

```sql
select distinct host_id from ranking_events
 where user_id = $1 and event_type = 'impression'
   and created_at >= now() - interval '90 days';
```

90 days because `neverShownToViewer` is a fairness signal, not a memory: a host
the viewer has not seen in three months is functionally fresh to them. Needs the
index in §4.

---

## 3. 🟧 Interest state is recomputed on every deck fetch, and the cache is never read

**Current.** `getDeck` does:

```ts
const [viewer, events] = await Promise.all([
  port.loadViewer(userId),
  port.loadInterestEvents(userId),   // limit 2000
]);
return rank({ viewer, candidates, interestEvents: events, … });
```

and `rank()` calls `computeInterestState(input.interestEvents, …)` internally.

**`user_interest_state` is written by `getInterestState` and
`rebuildInterestState`, and read by neither of the paths that produce a deck.**
The cache is effectively dead code on the hot path. `loadState` — which *does*
check `isCacheFresh` — is only reached through `getInterestState`.

**Cost now.** A few hundred events. Sub-millisecond.

**Cost at 5,000 users.** `computeInterestState` is O(all events for the user),
and the fetch is capped at 2,000 rows. A two-year-old heavy user hits that cap:
2,000 rows over the wire plus a full fold, **per deck fetch**, and Discover
fetches repeatedly within a session.

This is once per fetch, not once per card, so it is a 🟧 rather than a 🟥. But
the fix is nearly free because the machinery already exists.

**Fix.** Route `getDeck` through `loadState`, and pass the resulting
`InterestState` into `rank()` rather than the raw event log. That needs one new
optional field on `RankInput` (`interestState?`), with the existing
`interestEvents` path kept for the simulator, which has no cache and wants the
fold every time.

Worth noting *why* this happened: `rank()` takes an event log because it is
pure and has no I/O, and the cache lives in the adapter. The seam is in the
right place; the adapter simply never used it.

---

## 4. 🟧 Missing indexes

Four, of which one is on a trigger's hot path.

| index | needed by | status |
|---|---|---|
| `join_requests (activity_id, status)` | `tg_activities_recount_joiners`, which `COUNT(*)`s on **every** join_requests insert/update/delete | ❌ **missing** |
| `tandems (user_a_id)` and `tandems (user_b_id)` | `loadCompletedTandems`, two queries per check-in poll | ❌ missing |
| `activities (starts_at)` | `loadCandidates` filter + order. Only a *partial* index exists (`where confirmed_joiners = 0`), which does not serve the general query | ❌ missing |
| `tandem_feedback (rater_id)` | `loadGivenFeedback`, once per app open | ❌ missing |
| `interest_events (user_id, created_at desc)` | `loadInterestEvents` | ✅ v1.5 |
| `ranking_events (user_id, created_at desc)` | `countRecentImpressions` | ✅ v1.5 |
| `ranking_events (user_id, session_id, created_at)` | session funnel analysis | ✅ v1.7 |
| `ranking_events (activity_id, event_type)` | per-post funnel | ✅ v1.5 |

The `join_requests` one is the sharpest: without it, every accept/decline scans
the table to recount one activity's joiners. At 63 activities that is free; at
5,000 activities with ~15,000 join requests it is a sequential scan on the write
path of the most common user action in the app.

Also add `ranking_events (user_id, event_type, created_at desc)` if §2's fix
lands, so the bounded `seenHostIds` query is index-only.

---

## 5. 🟧 `ranking_events` growth — decide before it hurts

**Shape.** One row per card shown, plus one per `expand` / `im_in` / `accept` /
`decline` / `complete` / check-in. Each impression carries a `score_snapshot`
JSONB of ~12 features + 4 funnel factors + 4 scalars.

**Row size.** The snapshot serialises to roughly **600–900 bytes** of JSONB;
with the row's own columns and TOAST overhead, call it **~1 KB per impression**.

**Projection at 5,000 MAU**, assuming 30 cards/day/active user and 40% daily
active:

| | per day | per year |
|---|---:|---:|
| impressions | ~60,000 | ~22 M |
| all events | ~75,000 | ~27 M |
| table size | ~75 MB | **~11 GB** |

That is not a crisis — Postgres is fine with 27 M rows and an 11 GB table — but
it is the point past which nobody wants to make this decision under pressure.

**Recommendation.**

1. **Retention: keep `score_snapshot` for 90 days, keep the rows forever.** The
   snapshot's only consumer is offline model fitting, which wants recent data;
   the funnel counts are what you want a two-year history of, and they are the
   cheap part. A nightly `update … set score_snapshot = null where created_at <
   now() - interval '90 days'` drops ~90% of the volume and loses nothing anyone
   will ask for.
2. **Partition by month on `created_at`** when the table passes ~10 M rows.
   Retention then becomes `drop partition` rather than a mass `UPDATE` that
   rewrites the heap and bloats it.
3. **Do not cold-store the snapshot column separately.** A side table keyed by
   event id doubles the write path — two inserts per card instead of one — to
   save space that partitioning saves for free. The batching in
   `adapter/instrumentation.ts` is built around one insert per flush and this
   would undo it.

Decide (1) now; it is a cron entry. (2) is a migration when the number says so.

---

## 6. 🟩 `.find()` in the scoring path — none

The v1.7 harness bug (`world.posts.find()` per card, quadratic in run length)
was a property of `scripts/sweep.ts`, not of the module it grades. The
production path is clean:

- `scoreCandidates` is one `.map()` over the pool with a `ScoringContext` built
  **once** before it. Rank-normalisation is O(n log n) once, not per card.
- `slate.ts`'s greedy selection is O(deckSize × pool) = 8 × 24 ≈ 200 operations.
- `retrieval.ts` uses a `Set` for dedup.
- The `.includes()` calls in `features.ts` are over `viewer.trustedByHostIds`
  and `viewer.postedCategories` — single-digit arrays, per candidate.

Ranking 500 candidates is on the order of a millisecond. **Fine at 5,000 and
fine at 50,000**, because the pool is bounded by the fetch, not by the table.

---

## 7. 🟩 `confirmed_joiners` trigger — the design is right

Recount rather than increment, which was the correct call and should not be
revisited: an incrementing trigger drifts the first time a row is updated twice,
deleted, or backfilled, and a drifted demand signal is worse than none because
it silently boosts posts that are full.

`COUNT(*)` over one activity's join requests is a handful of rows —
`max_participants` is 1 for 59 of 63 posts, so the real cardinality here is
single digits and will stay single digits.

**Incremental `+1/-1` is not worth it.** It trades a guaranteed-correct O(few)
count for a drift-prone O(1) one. Give it the index in §4 and leave it alone.

---

## 8. 🟩 The impression buffer — correct as built

Verified against `adapter/instrumentation.ts`:

- **Crash persistence is not a synchronous write per event.** `persistSoon()`
  sets a debounce (1 s) and returns; concurrent calls coalesce behind a
  `persistTimer !== null` guard. One storage write per second at most,
  regardless of swipe rate.
- **`record()` is synchronous, returns `void`, and cannot throw.** Every error
  path funnels through `fail()`, which wraps `config.onError` in its own
  `try/catch` so that even a throwing error handler cannot escape.
- **A flush failure degrades silently.** `flush()` catches, re-queues at the
  front for `maxFlushRetries` attempts, then drops the batch and counts it in
  `health().dropped`. Nothing propagates to a render.
- **Bounded.** `maxRetainedEvents` (500) evicts oldest-first.

No change recommended.

---

## 9. 🟩 `getPendingCheckIns` — no N+1

`loadCompletedTandems` issues **three** queries regardless of how many tandems
come back: one for `user_a_id`, one for `user_b_id`, and one batched
`.in(id, activityIds)` for the linked activities. Plus one for
`loadGivenFeedback`. Four total, constant in N.

The two-query split on `tandems` is deliberate — an `or()` across two columns
would work, but the separate reads let the activity join degrade independently
when `tandems.activity_id` turns out not to exist ([S1] in SCHEMA.md).

Needs the `tandems` indexes from §4; then it is constant-time and small.

---

## 10. 🟩 `rebuildGraphEdges()` — free until ~1M completed tandems

Full recompute: `delete from graph_edges` then one grouped `insert … select`
over `tandems where status = 'completed'`. Single transaction.

At 23 completed tandems it is instantaneous. The aggregation is a hash group-by
over a sequential scan, so it stays roughly linear:

| completed tandems | approximate runtime |
|---:|---|
| 23 | < 1 ms |
| 100,000 | ~1 s |
| 1,000,000 | ~10–20 s |

**It stops being free at around 1 M completed tandems**, which at these
conversion rates is far beyond 5,000 users. Before then, `delete` + `insert`
also bloats the table; `truncate` would avoid that but takes an ACCESS EXCLUSIVE
lock, which is the wrong trade while the table is unread.

Revisit when either (a) completed tandems pass ~500 K, or (b) graph consumption
actually ships and the table becomes read-hot. Until then the recompute is the
right design precisely because it cannot silently drift — which is what the v1.5
trigger did.

---

## 11. 🟩 RLS on the insert-heavy tables

- `interest_events` — insert policy is `auth.uid() = user_id`. One comparison
  against a session variable, no subquery, no join. Negligible per row, and the
  writes are already batched.
- `graph_edges` — RLS enabled with **zero policies**, so it is deny-all for
  clients and written by a `security definer` function. No per-row cost on any
  client path.
- `user_interest_state` — `for all` with `auth.uid() = user_id`. Same shape.
- `ranking_events` — the batch insert is the highest-volume write in the system,
  and its policy (from the pre-existing v1 migration) is the one to confirm
  during the §5 follow-up. **If it contains a subquery rather than a direct
  `auth.uid()` comparison, that subquery runs once per row in the batch** — 20
  rows per flush, so still small, but it is the only RLS policy here with any
  potential to matter.

No change recommended, with that one item to verify.

---

## What this audit did not cover

- **Query plans against real data.** Everything above is derived from reading
  the source and the migrations. No `EXPLAIN ANALYZE` was run, because the
  database was not reachable from here. Every projection is an estimate from
  row-size and complexity reasoning, and §1 and §5 in particular should be
  confirmed with `EXPLAIN (ANALYZE, BUFFERS)` before anyone acts on the numbers.
- **The v1 migration**, which created `ranking_events` and whatever policies and
  indexes came with it. §4 and §11 list what *this module* needs; a column or
  policy from before v1.5 could change both.
- **Client-side rendering cost.** Out of scope, but note that §1's 200–400 KB
  payload lands on a phone and gets parsed there.
