# tandem-ranking

Ranking and interest-modelling layer for **Tandem** — a social app where people
post local activities that others nearby can join. Platonic companionship, not
dating.

**Primary metric for the beta: host retention** — did someone post a second
tandem unprompted. Repeat-tandem rate remains the long-run goal and stays
instrumented, but it is a *ratio*, so it can be won by shrinking the pool, and
with 23 completed tandems it is unmeasurable anyway. See
[`DIAGNOSTICS.md`](DIAGNOSTICS.md).

**The ranker is deliberately shelved.** What ships is proximity ordering plus
demand balancing plus within-session diversity penalties. Everything else stays
in the repo, tested, computing on every deck, and logged on every impression —
switched off behind one flag. This build exists to produce the data that would
justify turning it back on.

Framework-agnostic pure-TypeScript core, a pluggable data port, a Supabase
reference adapter, a migration, a backfill script, and an offline simulator.

**Zero runtime dependencies.**

```bash
npm install
npm test          # 153 tests
npm run typecheck
npm run sim -- --users 40 --days 120 --seed 1 --verbose
npm run sweep -- --sizes 20,40,80,150,300,600 --seeds 1,2,3
npm run sweep -- --proximity-sweep        # the §4.4 weight sweep
npm run graph:rebuild -- --dry-run        # recompute graph_edges from tandems
```

**Before applying anything to a real database, read
[`SCHEMA.md`](SCHEMA.md)** and run the `PRECHECK` block at the top of
`supabase/migrations/20260802100000_ranking_v1_7_instrumentation.sql`. The v1.5
and v1.6 migrations were written against a schema that was not available and
guessed wrong in three places; SCHEMA.md overrides both.

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

**v1.6 — scale adaptation:**

| | |
|---|---|
| ✅ | Per-user density estimate from coverage, EWMA-smoothed with a hysteresis band |
| ✅ | Every scale-dependent parameter is a `{village, city}` pair on a continuous scalar — one algorithm, no mode switch, enforced by four architectural tests |
| ✅ | Demand balancing (§2) — urgency, overflow, and the §2.3 claim that fairness rules become free at village scale, verified by test |
| ✅ | Exhaustion (§3), gated by `repeatAffinity` |
| ✅ | Density sweep across 20–600 users × 3 seeds, with host churn, exhaustion and supply response in the population model |
| ⚠️ | **The sweep result is negative.** `proximity_only` beats the adaptive ranker by 24–36% on repeat rate at every size ≥80, and on liquidity too. See [`INFERENCES.md` §G](INFERENCES.md). |

**v1.7 — instrumentation first:**

| | |
|---|---|
| ✅ | Schema reconciled against the live database, with a `PRECHECK` block of SELECTs per assumption — [`SCHEMA.md`](SCHEMA.md) |
| ✅ | Impression logging: every card, **every feature including the shelved ranker's**, buffered and batched, never awaited from a render |
| ✅ | Check-in data path — `tandem_feedback` per pair, mirrored into `interest_events`, skip writes nothing |
| ✅ | Within-session penalties replace the slot quotas, which were mis-*specified* rather than mistuned |
| ✅ | Exhaustion disabled with its reactivation condition named |
| ✅ | `graph_edges` becomes a derived aggregate over `tandems` — no trigger to go silently wrong |
| ✅ | The ranker shelved behind one flag, as a parameter override rather than a branch |
| ⚠️ | **The funnel factors are the most damaging thing measured in this build.** Removing `P_accept x P_complete x R_repeat` takes host retention at N=600 from 0.783 to 0.948 and host Gini from 0.931 to 0.430. See [`DIAGNOSTICS.md`](DIAGNOSTICS.md) §D3. |

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
scripts/                backfill (dry-run first), simulator, density sweep
                        population.ts is the FROZEN model the sweep grades against
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
| No scoring module imports or mentions the regime | `purity.test.ts`, 4 checks |
| No parameter jumps anywhere on the density continuum, **no exemptions** | `regime.test.ts` |
| P_join renormalises to 1 at every regime | `regime.test.ts` + load-time assert |
| Nothing references the deprecated `feed_impressions` table | `purity.test.ts` |
| Only `rank.ts` reads the ranker flag; no scoring module imports it | `purity.test.ts` |
| The diagnostics parameter override is never used by application code | `purity.test.ts` |
| A session penalty can never reach 0 (a cap in disguise) | load-time assert + `regime.test.ts` |

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
4. **Shadow mode**, which as of v1.7 is no longer hypothetical — it is what
   ships. The full feature set is computed and logged on every impression while
   only proximity, demand and the session penalties order the deck. That is the
   v2 training set accumulating before anything a user sees has changed.

The simulator found a result worth taking seriously before shipping: **pure
nearest-first currently beats the full ranker on repeat rate**, by 7–14% across
seeds. The analysis — including what the simulator does not model, and the fact
that I changed its user model after seeing a result I did not like — is in
[`INFERENCES.md` §D](INFERENCES.md).

---

## Before applying the migration

Both of the v1.5 guesses named here were **wrong**, and both are corrected in
v1.7:

- `public.activity_participants` **does not exist**. The v1.5 completion trigger
  targeted it, its `to_regclass` guard skipped attachment, and `graph_edges` was
  empty for months with nothing to notice.
- completion is `tandems.status`, not `activities.status`.

Read [`SCHEMA.md`](SCHEMA.md), run the `PRECHECK` block at the top of the v1.7
migration, and only then apply. Six assumptions remain unverifiable from the
repo alone and are tabulated in SCHEMA.md §5.

Adapter column names are in one `COLUMNS` object at the top of
`src/ranking/adapter/supabase.ts`. Then:

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
