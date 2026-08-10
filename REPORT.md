# Simplification audit — report

**Scope.** Triggered by an independent test from outside this project reporting
that *nearest-first still beats the full ranker everywhere, and tuning only
closes part of the gap.* The brief was to simplify the algorithm by
process-of-elimination removal.

**Outcome in one line.** The outside result replicated, then turned out to be a
statement about the metric; the safe removal set measured empty; and the exercise
surfaced a result that inverts the premise the repo has run on since v1.5.

**Nothing was changed in the shipping configuration.** No scoring constant moved,
no module was deleted, `RANKER_ENABLED` is still `false`. 257 tests, typecheck
clean.

Full working: `DIAGNOSTICS.md` §G0.

---

## 1. The outside finding replicated — and it is about the metric

Five-arm ladder, 12 seeds, gated at 2 SE. N=600:

| arm | host retention | repeat rate | zero-joiner | hosts alive | Gini |
|---|---:|---:|---:|---:|---:|
| shipped | **0.958** ±0.002 | 0.518 | 9.2% | 58.9% | **0.414** |
| ranker_no_funnel | 0.948 ±0.003 | 0.372 | 9.8% | 58.9% | 0.428 |
| ranker_repaired | 0.940 ±0.003 | 0.382 | 12.9% | 52.9% | 0.463 |
| proximity_only | 0.935 ±0.003 | **0.657** | 20.0% | 41.3% | 0.535 |
| random | 0.862 ±0.003 | 0.053 | 43.0% | 22.6% | 0.645 |

On **repeat rate**, nearest-first wins everywhere by 72% — the outside result,
reproduced. On **host retention** it comes fourth.

Repeat rate is a ratio and can be won by shrinking its denominator.
`proximity_only` shrinks the pool by construction, and the mechanism is visible
in its own row rather than inferred: it produces the *most* tandems per user
(21.3) and the *highest* repeat rate while leaving **twice as many posts with
nobody** (20.0% vs 9.2%) and keeping **a third fewer hosts alive** (41.3% vs
58.9%).

Nearest-first makes the people it serves tandem more, and serves fewer people.
Both parties were measuring correctly; they were measuring different things.

## 2. Does simplification help? Yes — and the optimum is already occupied

Reading the ladder as a complexity ladder (N=600):

```
ranker_repaired    0.940 / Gini 0.463    full ranker
ranker_no_funnel   0.948 / Gini 0.428    − the funnel          → better
shipped            0.958 / Gini 0.414    − the interest model  → BEST
proximity_only     0.935 / Gini 0.535    − demand + penalties  → worse
```

Non-monotone. Removal helps up to `shipped` and reverses hard past it. The
demand layer and the session penalties are earning their place; the funnel and
the interest model are not. **The optimum is the configuration already
shipping** — a confirmation, not a change.

## 3. Is distance overweighted? No — the opposite, and I got this wrong once

I initially reported the proximity sweep as flat. That was read off the first
two-thirds of the output and it was wrong; it is corrected in place in
`DIAGNOSTICS.md` §G0.3 rather than quietly fixed, because "read a partial sweep,
called it flat" is the same error class as §D4's three-seed optimum.

The full range identifies optima at **w = 0.70 (N=150)** and **0.65 (N=600)**,
both clearing 2 SE — roughly **3× the shipped 0.20** — with repeat rate still
rising at 0.80, the top of the swept range.

## 4. The result that inverts the premise

§G0.3 measured a secondary metric. Run on **host retention**, matched seeds,
through the gate:

```
N=600, host retention
 1  ranker_repaired @ w=0.65    0.968 ±0.003
 2  shipped                     0.958 ±0.002    1.49×  SEPARATES
 3  ranker_repaired @ w=0.20    0.933 ±0.003    3.32×  SEPARATES
```

Gini 0.398 / 0.414 / 0.474. Zero-joiner 7.6% / 9.2% / 14.2%.

The governing finding of this repo — the ranker loses to simple proximity
ordering — reproduces decisively at `w = 0.20` (3.32×). Change that one weight to
0.65 and the same ranker, otherwise untouched, **beats the shipped configuration
on both primary metrics.**

"The ranker is worse than nearest-first" may never have been a fact about the
ranker. It looks like a fact about `w_proximity = 0.20`.

## 5. Why nothing was changed

Every reason predates the result. None was invented to explain it away.

1. **It favours the ranker, and the standing rule discounts exactly that.** The
   simulator was authored alongside the ranker it now vindicates. The negative
   results were believed *because* they were against interest; a positive one
   does not get to skip the discount that bought them their credibility.
2. **Setting it would be tuning a constant to improve a metric** — and
   `collapsed.pJoin.proximity` already carries a comment refusing this exact move
   for this exact parameter.
3. **The optimum is not stable.** §D4 named 0.10 / 0.30 from these same seeds
   pre-abort; this run names 0.70 / 0.65 post-abort. A maximum that relocates by
   0.6 when two unrelated constants move is not a maximum.
4. **It does not separate at beta scale.** At N=150 it is a TIE (0.30×). At N=40
   the ladder could not separate five arms from each other at all. The beta is
   ~40 users.
5. **`RANKER_ENABLED` is false**, so `w_proximity` orders nothing that ships.
   Acting would mean un-shelving the ranker on simulator evidence — the decision
   the instrumentation exists to make with real data instead.

## 6. Why the ranker was not deleted

The obvious removal is the shelved ranker itself. It would have been wrong.

`shipping.ts` computes and logs the full shelved feature set on **every
impression** specifically so the question stays answerable —
`ranking_events.score_snapshot` *is* the training set. Deleting the ranker
deletes the training set, and §4 is the concrete demonstration of why that would
have been expensive: the answer changed with one weight, and the data needed to
find that out live in the columns the deletion would have removed.

So the criterion was narrowed to one that cannot be wrong: **which logged
columns are constant?** A constant column carries zero information, cannot enter
a fit, and cannot become informative with more rows, so removing one is lossless
by measurement rather than by argument. New tool, `scripts/deadcolumns.ts`.

Six of 23 columns are constant across 3 seeds × 300 users × 60 days. **None were
deleted, and the triage is the finding:**

| column | value | why it stays |
|---|---:|---|
| `features.acceptLikelihood` | 1.0 | constant in *this population*, not structurally |
| `funnel.pAccept` | 1.0 | same term, downstream |
| `features.graphAffinity` | 0.0 | declared stub, final signature, weight 0.0 |
| `funnel.exhaustion` | 0.0 | parked with an explicit reactivation trigger |
| `funnel.exposureBoost` | 1.0 | inert in the simulator; mechanism unverified |
| `funnel.overflow` | 0.0 | inert in the simulator; mechanism unverified |

`acceptLikelihood` is the interesting one. Under the ρ = 0 abort it measured
**identically 1.0 on every impression** — not damped, not downside-only, a
multiply-by-1 contributing nothing and logging a column of 1s. That is the
fourth and sharpest version of the §F1 finding (`FUNNEL.md` §4 updated).

It is still not deleted, because it is constant only where every viewer deviation
is non-negative — true of the simulated population, not of production, where a
below-average-reputation viewer yields `P_accept < 1`. Deleting it would be
removing a live term on a simulator artifact, which this repo has recorded doing
three times (§D4, §E5, §F1). That the deletion would have been convenient is the
reason to refuse it.

**The lossless simplification set is empty, and that is the result.**

## 7. On the externally supplied constants file

The *finding* was valuable and is recorded. The *file* was not applied, and could
not be: it is a pre-v1.8 fork of `constants.ts` that would delete the entire
`checkin` block (all of v1.9), the `shipping` gate, and the `instrumentation`
block, revert the v1.8 §2 density collapse, and undo both pre-registered aborts
(`repeatableContext` 0 → 0.25; `hostAcceptDamping` removed entirely). It would
not compile, and the parts that would are the aborts coming back.

Its direction on proximity was right (§4). It closed only part of the gap because
it stopped at 0.55 — short of where the effect lands — and kept the funnel, which
the ladder shows is a net negative at the default weight.

## 8. What to do next, in order

1. **Ship as-is.** Nothing in this audit licenses a change to the launch config.
2. **Turn on logging.** `score_snapshot` already carries every feature needed to
   test §4 against real behaviour.
3. **First hypothesis to test on live data:** is `w_proximity` too low? This is
   now the highest-value open question, ahead of `demandWeight`.
4. **Second:** the un-clipped `P_accept` form (`FUNNEL.md` §8), raised in priority
   by §6 — the term currently contributes nothing at all.
5. **Do not re-run the simulator to settle either.** Both questions are now at the
   limit of what a self-authored model can honestly answer.

## 9. Changed in this pass

| file | change |
|---|---|
| `scripts/deadcolumns.ts` | **new** — constant-column audit over the logged snapshot |
| `DIAGNOSTICS.md` | **new §G0** — ladder, proximity sweep, primary-metric result, triage |
| `FUNNEL.md` §4 | v1.9.1 note: `P_accept` is a no-op, not a damped term |
| `REPORT.md` | this file |

No source file under `src/` was modified. No constant moved.
