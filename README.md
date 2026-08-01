# tandem-ranking

Ranking and interest-modelling layer for **Tandem** — a social app where people
post local activities that others nearby can join. Platonic companionship, not
dating. The north star is **repeat-tandem rate**, not joins and not session time.

Framework-agnostic pure-TypeScript core, a pluggable data port, a Supabase
reference adapter, a migration, a backfill script, and an offline simulator.

**Zero runtime dependencies.**

```bash
npm install
npm test          # 48 tests
npm run typecheck
npm run sim -- --users 40 --days 120 --seed 1 --verbose
```

---

## Status

Implements steps **1, 2, 3, 5** of the v1.5 framework:

| | |
|---|---|
| ✅ | Schema migration + instrumentation (`expand` events, retrieval `source` tags) |
| ✅ | Interest state model — event log, per-source decay, saturation, novelty prior |
| ✅ | Retrieval stage + slate assembly |
| ✅ | Explicit interest statements |
| ⬜ | Graph consumption — **written, never read.** `graph_edges` accumulates from day one; `graphAffinity()` returns `0`, the `graph` retrieval source returns `[]`. Both are stubs with their final signatures. |
| ⬜ | `revealed`/`desired` split, intent gap (§1.5) — `expand` events are emitted and stored at weight `0` |
| ⬜ | Transition detection (§1.6) — needs 120 days of history |
| ⬜ | Learned weights — v2, offline, from `ranking_events` |
| ⬜ | Server-side ranking — everything is client-side, and stays that way until the pool is too big to fetch whole |

> ⚠️ **The v2 framework document was not available when this was built.** Only
> `tandem-matching-algorithm-v1.md` was. Everything the build prompt specified
> directly is built to spec; everything only v2 would have contained was
> reconstructed, and every reconstruction is a numbered claim in
> **[`INFERENCES.md`](INFERENCES.md)**. Read that first, and diff it against the
> real document.

---

## Layout

```
src/ranking/core/       pure TS — no React, no Expo, no Supabase, no clock
src/ranking/adapter/    all I/O; supabase.ts is the only Supabase-aware file
supabase/migrations/    one idempotent migration, with a ROLLBACK block
scripts/                backfill (dry-run first) + offline simulator
tests/                  hand-built fixtures, no random generation
```

Module docs, including how to change a weight, add a retrieval source, and turn
the graph on: **[`src/ranking/README.md`](src/ranking/README.md)**.

---

## Design constraints, and how they are enforced

Each of these is a test, not a comment. A comment saying "do not import React
here" survives exactly one distracted afternoon.

| Constraint | Enforced by |
|---|---|
| `core/` imports nothing outside `core/` | `purity.test.ts` scans every import |
| No clock, no `Math.random`, no platform globals in `core/` | `purity.test.ts` pattern scan |
| No magic numbers outside `constants.ts` | `purity.test.ts` numeric-literal scan |
| `pJoin` and `pComplete` weights sum to 1 | thrown at module load |
| Same seed → byte-identical deck | `rank.test.ts`, ten runs |
| Scoring throwing → proximity deck, never empty | `fallback.test.ts` |
| No numeric score reachable from a UI type | `rank.test.ts` serialises and greps |
| Reason lines claim only what the data proves | `explain.test.ts` |
| Nothing imports `@supabase/supabase-js` | `purity.test.ts` |

The Supabase client is typed **structurally** rather than imported, which is why
the dependency list is empty and why the same code runs on Hermes in an Expo
build and in Node in a test.

---

## The model, briefly

```
S = P_join × P_accept × P_complete × R_repeat
```

Four factors instead of one number, because each is separately learnable in v2:
export `ranking_events`, fit one logistic regression per funnel stage offline,
paste the coefficients back into `CONSTANTS.score`. The architecture does not
change; the numbers get better.

Interest is a fold over an append-only event log:

```
decay        per-source half-life          §1.2
saturation   sat(x) = x/(x+k)              §1.3
novelty      recency × under-exploration   §1.4
```

`user_interest_state` is a **cache**, never a source of truth. It is fully
rebuildable from `interest_events` alone, and a test asserts cache and rebuild
agree exactly.

**The score orders. It never filters.** Time pills filter; the score sorts what
survives. An empty deck is a bug.

---

## Testing without the parent app

The app this plugs into was not available, so verification is layered:

1. **Unit + property tests** (`npm test`) over hand-built fixtures. Half-life
   exactness, saturation curvature, novelty ordering, determinism, cache/rebuild
   agreement, slate constraints, cold start, fallback.
2. **Architectural tests** (`purity.test.ts`) that enforce the constraints above
   by scanning source, so they cannot rot.
3. **Offline simulation** (`npm run sim`) against a synthetic population with
   *hidden* preferences the ranker never sees, benchmarked against `proximity`,
   `popularity` and `random` baselines on the same seed.
4. **Shadow mode**, once wired: rank client-side, log impressions with the
   feature snapshot, render the existing order. Costs one write per card and
   gives you the v2 training set before you have changed anything a user sees.

The simulator found a result worth taking seriously before shipping: **pure
nearest-first currently beats the full ranker on repeat rate**, by 7–14% across
seeds. The analysis — including what the simulator does not model, and the fact
that I changed its user model after seeing a result I did not like — is in
[`INFERENCES.md` §D](INFERENCES.md).

---

## Before applying the migration

Two things in the completion trigger are guesses, marked `[CONFIG]` in the SQL:

- participants live in `public.activity_participants(activity_id, user_id, status)`
- completion is `activities.status` transitioning to `'completed'`

Adapter column names are in one `COLUMNS` object at the top of
`src/ranking/adapter/supabase.ts`. Reconcile both against the real schema, then:

```bash
# always dry-run first — prints per-user counts and writes nothing
SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… npx tsx scripts/backfill-interest-events.ts --dry-run
```

Backfilled rows are tagged `source_meta = 'backfill'` so they can be dropped once
organic data accumulates.

---

## Stack notes

Built for **Expo (React Native) + Supabase**. The core is deliberately unaware of
both.

- **AWS Rekognition** — the `verified` flag is an identity signal (face check),
  not a taste signal. It gets a capped ×1.1 host boost and ×1.05 viewer boost,
  deliberately small: making verification a large ranking lever turns identity
  into a growth funnel.
- **Twilio** — not a ranking input, but it is the natural delivery channel for
  the post-tandem check-in, and that check-in produces `checkin_yes` / `checkin_no`
  — the highest-weighted signal in the entire model. Whatever delivers it is on
  the critical path for ranking quality.

---

## Permanent anti-patterns

No engagement-bait objective — success is the user leaving the app to meet
someone. No scarcity mechanics. No visible scores or compatibility percentages;
numbers turn people into inventory. No message-content or contact-graph signals,
ever.

MIT.
