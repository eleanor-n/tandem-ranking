# INTEGRATION

Everything needed to wire `tandem-ranking` into the app. You should not need to
read the framework document, `DIAGNOSTICS.md`, or `FUNNEL.md` to do any of this.

---

## 1. What this module does

It orders the Discover deck by distance, boosts posts that are nearly empty and
happening soon, and avoids repeating a category or a host within a session.

It also records what it showed you and why, and schedules the post-tandem
check-in ("would you tandem with them again?").

That is all it does. It renders nothing, owns no state you can see, and has zero
runtime dependencies.

---

## 2. What it deliberately does not do

There is a full ranking model in here — interest affinity, time fit, host
reliability, a graph term, a four-stage funnel — and it is switched off.

Simpler ordering measured better. At every population size tested, plain
proximity ordering matched or beat the full ranker on host retention, and the
ranker's quality terms concentrated attention so heavily that a majority of
hosts got nobody. The ranker is built, tested, computing on every deck, and
logged on every impression, behind `RANKER_ENABLED = false`. It stays that way
until real data says otherwise — which is what the instrumentation is for.

Nothing about this is provisional or half-finished. Shipping the simpler thing
is the decision.

---

## 3. Install

### 3.1 Migrations, in order

Run the `PRECHECK` block at the top of the v1.7 migration **first**, and read
`SCHEMA.md` before applying anything. Two earlier migrations were written
against a schema that was not available and guessed wrong in three places.

| file | what it does | safe to run during App Store review? |
|---|---|---|
| `20260802100000_ranking_v1_7_instrumentation.sql` | impression logging, `session_id`, `graph_edges` rebuild | yes — invisible |
| `20260807090000_ranking_v1_9_indexes.sql` | 7 indexes, `CONCURRENTLY` | yes — invisible |
| `20260808090000_ranking_v1_9_checkin_skips.sql` | `checkin_skips` table + `retry_after`, check-in idempotency index, three RLS policies | yes — invisible |

The two v1.9 files are additive and idempotent: no column is dropped, retyped,
or rewritten. Both carry `VERIFY` and `ROLLBACK` blocks at the bottom.

> **`CONCURRENTLY` cannot run inside a transaction.** If your migration runner
> wraps files in `BEGIN`/`COMMIT`, either strip the keyword — fine at current
> table sizes — or paste that file into the SQL editor by hand.

### 3.2 Wiring

> **Import paths.** `package.json` declares `main` and no `exports` map, so the
> only guaranteed entry point is the package root (`src/ranking/adapter/index.ts`).
> If you vendor the folder rather than installing it, import by relative path.
> The paths below are what the repo actually resolves today.

```ts
import { createRankingClient } from './ranking/adapter/index.js';
import { createSupabaseRankingPort } from './ranking/adapter/supabase.js';

const port = createSupabaseRankingPort(supabase, {
  distanceMiles: (row) => haversineMiles(myLocation, row),
  newId: () => Crypto.randomUUID(),

  // REQUIRED IN PRACTICE. See §3.3.
  viewerBounds: () => boxAround(myLocation, radiusMiles),
}, (where, err) => console.warn('[ranking]', where, err));

const ranking = createRankingClient({ port, now: () => Date.now() });

await ranking.instrumentation.restore();          // once, at startup
const sessionId = ranking.instrumentation.startSession();   // every foreground
```

Then per deck fetch. **`sessionId` is a positional argument, not an option** —
the client uses it to remember what this session already showed, which is what
makes within-session diversity work without you threading counters back:

```ts
const result = await ranking.getDeck(userId, sessionId, {
  snapshotApp: {                 // §4 — pass what you have, omit the rest
    entry_point: 'discover',
    active_filters: activeFilterPills,
    app_version: Constants.expoConfig.version,
  },
});

// result.slate.cards -> render. There is no score on them, by construction.
ranking.instrumentation.recordDeck(userId, result);
```

And on background:

```ts
await ranking.instrumentation.appBackgrounded();
```

### 3.3 `viewerBounds` — do not skip this

Without it, the candidate query pages the **500 soonest-starting activities
globally** and then sorts them by distance. While the whole activity table fits
in one page that is exactly correct. Once it does not, someone in Brooklyn can
get a deck containing almost nothing near them, and there is no error, no slow
query, and no way to see it from the client.

Supply a lat/lng box in degrees and the filter moves into the `WHERE` clause.
If you do not, the module raises `SPATIAL_FILTER_UNBOUNDED` through `onError`
at the exact moment it starts mattering — a full page came back and nothing
bounded it spatially. **Treat that warning as a bug, not a notice.**

### 3.4 Config flags

| flag | where | value | meaning |
|---|---|---|---|
| `RANKER_ENABLED` | `core/shipping.ts` | `false` | the ranking model. Leave off. |
| `exhaustionRate` | `core/constants.ts` | `0` | disabled until check-in data exists |
| `demandWeight` | `core/constants.ts` | `0.10` | the empty-post boost. See §7. |
| `eligibilityWindowDays` | `core/constants.ts` | `7` | how long a check-in stays askable. `UNMEASURED`. See §5. |
| `skipRetryDays` | `core/constants.ts` | `5` | how long a first skip snoozes for. `UNMEASURED`. See §5. |

---

## 4. The `app` snapshot keys

`ranking_events.score_snapshot` is the training set for every future version of
this. It has two halves:

```json
{ "v": 2, "computed": { ... }, "app": { ... } }
```

`computed` is filled in by this module. `app` is yours. **Partial population is
expected** — fill what is cheap, leave the rest, add more later.

| key | type | why it matters |
|---|---|---|
| `active_filters` | `string[] \| null` | **the highest-value key here.** The module cannot see the filter pills, and they determine the candidate set. Without this, nothing can tell "the ranker did not show it" from "the user filtered it out" |
| `entry_point` | `'discover' \| 'notification' \| 'deep_link' \| 'unknown' \| null` | a card seen from a push is not the same card — the viewer already self-selected by tapping |
| `viewer_verified` | `boolean \| null` | used in scoring; the module may not have it |
| `viewer_profile_complete` | `boolean \| null` | proxy for intent |
| `host_verified` | `boolean \| null` | |
| `app_version` | `string \| null` | lets a buggy build be segmented out after the fact |
| `push_enabled` | `boolean \| null` | confounds every engagement signal |

Import `SNAPSHOT_APP_KEYS` and build the object off it — a typo then becomes a
compile error rather than a column of nulls discovered in a month.

> ### Null is not the same as absent
>
> This is the one thing in this file worth being pedantic about.
>
> - **key present, value `null`** — we knew about the field and did not have it
> - **key absent** — the row predates the field
>
> They mean different things when fitting a model, and after the fact the
> difference is unrecoverable. The module always writes every key, so an
> un-integrated row is still a well-formed row. `v` increments whenever a key is
> added; the changelog is at the top of `core/snapshot.ts`.
>
> Concretely: `active_filters: []` means "no filters were on".
> `active_filters: null` means "the app did not tell us". Do not collapse them.

In development, a malformed `app` object logs one warning per session through
`onError`. It never throws and never blocks a render.

---

## 5. The check-in contract

Three functions. The data layer is complete; the UI, the copy, where it appears
in the flow, and the skip affordance are yours.

```ts
const pending = await ranking.getPendingCheckIns(userId);
// already metered to one per app open; ask what comes back

await ranking.recordCheckIn({
  tandemId: p.tandemId,
  raterId: userId,
  ratedId: p.ratedId,
  response: true,          // "would you tandem with them again?"
  category: p.category,    // pass these through from the pending record —
  activityId: p.activityId // without `category` the interest mirror is skipped
});

await ranking.skipCheckIn(p.tandemId, userId);
```

`recordCheckIn` is idempotent: a double-tap or a retry after a timeout that
actually succeeded writes one row.

### Two things your UI can assume, and one it cannot

**1. The queue is bounded. A check-in expires after 7 days.**

Past `eligibilityWindowDays`, a tandem stops being askable and `getPendingCheckIns`
stops returning it. There is no backlog and there is no "you have 12 pending
check-ins" state to design for — the most you will ever be handed is one.

This is deliberate, not a cleanup. Recall on a three-week-old coffee is poor, so
those answers would be noise, and noise is worse than absence in this particular
signal because nothing downstream can tell a guessed answer from a remembered
one. **Do not build a catch-up screen**, and do not treat an expiring check-in as
something to chase with a push notification — it expires because the answer would
not have been worth having.

Practical consequence: a person who does not open the app for a week owes
nothing when they come back. That is the intended behaviour.

**2. A skip is soft. The first one is a snooze, the second is final.**

| skip | what happens |
|---|---|
| first | asked once more, ~5 days later — if that still falls inside the 7-day window |
| second | never asked again |

So `skipCheckIn` may be called twice for the same tandem, and the second call is
not a bug or a double-submit — it is the escalation. The client handles this
itself; you call the same function both times and pass nothing extra.

The asymmetry is the point. One dismissal is ambiguous: a mis-tap, a bad moment,
someone mid-something-else. Two is an answer. `tandem_feedback` is the only
source of pairwise data anywhere in this system, so spending a label permanently
on a single ambiguous tap is the wrong price — and continuing to ask past two
reads as the app not listening.

Because `skipRetryDays` (5) is less than `eligibilityWindowDays` (7), a retry
only has room when the skip happened early in the window. A skip late in the
window simply expires and never returns. That is fine and needs no handling.

**What you cannot assume: that a skipped prompt is gone for good.** If your UI
caches "already dismissed" locally and suppresses the prompt on that basis, the
retry never surfaces and the soft skip silently becomes the hard one it replaced.
Let `getPendingCheckIns` decide.

### Ordering

Check-ins are surfaced **most recent first**, because an answer about last
Tuesday is worth more than an answer about six weeks ago. With the 7-day window
in place, nothing can be starved by fresher arrivals — the earlier tradeoff
between queue fairness and answer quality no longer exists.

### The four constraints

These are constraints, not suggestions. Each one exists because breaking it
costs the signal permanently rather than just degrading it.

1. **Never shown to the rated user.** Not in a profile, not aggregated, not
   "3 people would tandem with you again". The moment it is visible, people
   answer strategically and the data is worth nothing.
2. **Never rendered as a number or a score.** Same reason, one step removed. It
   is not a rating system and must not look like the beginning of one.
3. **At most one prompt per app open.** `getPendingCheckIns` already enforces
   this. A queue of five on launch is an interrogation, and the second answer is
   already worse than the first.
4. **Skippable without penalty.** A skip must be as easy as an answer. A person
   who did not answer is not a person who said no — `skipCheckIn` writes no
   feedback row, no interest event, and no polarity anywhere. It goes to its own
   table, which has no `rated_id` column to put a judgement in even by mistake.

### If `tandems.activity_id` does not exist

`SCHEMA.md` flags this as unverified (assumption S1). If it is missing, the
check-in still writes its `tandem_feedback` row; only the category mirror into
`interest_events` is skipped, and a warning names the missing column once.

**The feedback row is the important half.** A missing mirror costs one interest
event. A missing feedback row costs the answer.

---

## 6. What to watch in the first month

In priority order. The first one is not a tie.

| # | number | where | what it means |
|---|---|---|---|
| 1 | **`tandem_feedback` row count > 0** | `select count(*) from tandem_feedback` | **the single most important number.** Every future version of the ranker depends on pairwise compatibility data, and this is the only source of it. If it is still zero after a month, the check-in is not reaching people and that is the thing to fix — ahead of anything else in this document. |
| 2 | `ranking_events` accruing | `select count(*), max(created_at) from ranking_events` | instrumentation is alive. If it stalls, `restore()`/`startSession()` are probably not wired |
| 3 | zero-joiner percentage | `sql/` and `supabase/analysis/concentration.sql` | the share of settled posts nobody joined. This is the metric the whole demand layer exists to move, and the one that predicts host churn |
| 4 | skip rate | `checkin_skips` vs `tandem_feedback` | a high skip rate means the prompt is badly timed or badly worded. Not a failure — a signal about the prompt |
| 5 | `SPATIAL_FILTER_UNBOUNDED` in logs | `onError` | see §3.3. Should never appear |

`supabase/analysis/concentration.sql` computes host-attention concentration.
**Lead with the zero-impression host count, not the Gini** — a host whose post
got no impressions did not have a bad week, they had an invisible one, and that
is the number that predicts them never posting again.

---

## 7. What to re-run, and when

| trigger | do this | why |
|---|---|---|
| **~100 judgeable posts** | `sql/churn_per_empty_post.sql` | measures `churnPerEmptyPost`, currently an invented `0.18`. It is the only thing that can justify moving `demandWeight`. It reports both arms at 14 **and** 30 days: if those two disagree, the estimate is measuring the censoring window rather than host behaviour and nothing moves (case D, which gates the rest) |
| **~500 activities** or **~200 users** | `PERF.md` §3 and §5 | the two deferred performance items start to bite around there |
| `ranking_events` past ~1M rows | `PERF.md` §5 | decide on retention before it is 11 GB |
| any change to `demandWeight` | the churn query again | check the assumption still holds |

`sql/README.md` says what each query is for and what could change as a result.

---

## 8. Known deferrals

Named plainly so none of them is a surprise later.

**Performance — two items left open** (`PERF.md`)

- §3 interest state is recomputed on every deck fetch and the cache is never
  read. Wasted work, not wrong.
- §5 `ranking_events` grows ~11 GB/year at 5,000 MAU with no retention policy.
  Fine now; decide before it hurts.

Everything else in that audit is marked 🟩 — fine now and fine at 5,000 — and is
explicitly not worth thinking about again.

**A known defect in the shelved ranker** (`FUNNEL.md` §4)

`P_accept` clips at its ceiling under the current setting, so the viewer-side
half of the term works downward and not upward. It affects nothing that ships,
because the ranker is off. It is the first thing to fix if it is ever turned on.

**Unmeasured constants**

Marked `UNMEASURED` in `constants.ts`. All are timing or shape parameters that
nobody can set correctly without real users:

- `assumedDurationHours` (2) — how long an activity lasts when `activities` has
  no end time. Only affects *when* a check-in is asked
- `minElapsedHours` (2) — how long after an activity to ask
- `eligibilityWindowDays` (7) — where recall falls off enough that the answer
  stops being worth having. Needs answer-latency data to fit properly
- `skipRetryDays` (5) — how long a first skip snoozes. A guess at "long enough
  that it does not feel like nagging"
- `flushIntervalMs` (10s) / `flushAtEvents` (20) — impression batching. Nobody
  knows the real swipe rate yet
- session penalty constants — chosen without knowing median session length

**The retention decision** — see §7. `ranking_events` has no retention policy
because choosing one requires knowing the query patterns, and there are none yet.

**Not built, on purpose**: graph consumption (`graphAffinity()` returns 0),
intent gap, transition detection (needs 120 days of history), learned weights,
and server-side ranking. All are stubs with their final signatures.
