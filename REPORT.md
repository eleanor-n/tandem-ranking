# Simplification audit — report

**Scope.** Triggered by an independent test from outside this project reporting
that *nearest-first still beats the full ranker everywhere, and tuning only
closes part of the gap.* The brief was to simplify the algorithm by
process-of-elimination removal.

**Outcome in one line.** The outside result replicated, then turned out to be a
statement about the metric; the safe removal set measured empty; and a result of
mine that appeared to invert the repo's governing premise was disqualified — by a
caveat in the outside writeup itself.

**Nothing was changed in the shipping configuration.** No scoring constant moved,
no module was deleted, `RANKER_ENABLED` is still `false`. 257 tests, typecheck
clean.

Full working: `DIAGNOSTICS.md` §G0.

---

## 1. The outside finding replicated — and it is about the metric

Five-arm ladder, 12 seeds, gated at 2 SE. N=600:

| arm | host retention | host Gini | repeat rate | zero-joiner | hosts alive |
|---|---:|---:|---:|---:|---:|
| shipped | **0.958** ±0.002 | **0.414** | 0.518 | 9.2% | 58.9% |
| ranker_no_funnel | 0.948 ±0.003 | 0.428 | 0.372 | 9.8% | 58.9% |
| ranker_repaired | 0.940 ±0.003 | 0.463 | 0.382 | 12.9% | 52.9% |
| proximity_only | 0.935 ±0.003 | 0.535 | **0.657** | 20.0% | 41.3% |
| random | 0.862 ±0.003 | 0.645 | 0.053 | 43.0% | 22.6% |

Host Gini is the second column rather than the last because it is the most
robust separation in the build — see §1.2.

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

### 1.1 How much of the retention column is signal

Host retention at N=600 runs from **0.862** at the `random` floor to **0.958**
at the ceiling. The floor is **90.0% of the ceiling**, and the entire five-arm
ladder occupies the remaining **0.096**.

Shuffling the deck at random retains nine hosts out of ten that the best
configuration retains. Every ranking decision in this repo is argued inside the
last tenth of the scale, and the four non-random arms inside 0.023 of it. This
does not make the differences unreal — they are gated at 2 SE and some of them
clear it — but a reader who sees `0.958` next to `0.935` without the floor has
no way to size them. The sweep now prints the floor, the ceiling and each arm's
rescaled position under every metric that carries a standard error.

### 1.2 Where the arms actually separate: attention distribution

The retention column is compressed. The **Gini** column is not:

| | shipped | proximity_only | span |
|---|---:|---:|---:|
| host retention | 0.958 | 0.935 | 0.023 |
| host Gini | 0.414 | 0.535 | 0.121 |

On host retention `shipped` beats `proximity_only` by 0.023 against a floor
0.096 wide. On Gini it beats it by 0.121 — five times the gap, on a metric where
`random` is worst and the ordering is not in dispute. Attention distribution is
where the shipped configuration's advantage is largest and least ambiguous, and
it is the one place `proximity_only` fails outright rather than arguably: it
concentrates joiners on a few hosts, which is the mechanism behind its 20.0%
zero-joiner rate and its 41.3% surviving hosts.

This is a change of emphasis, not of result. The number was already in the
build; it was in column nine.

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

**That verdict is seed-count dependent**: `shipped` separates from
`ranker_no_funnel` at 12 seeds, but the same data read at the first 4 seeds is a
declared four-way tie, so this is a claim about 12 seeds rather than about the
ladder — run `npm run sweep -- --seed-curve` to print the verdict at k = 4, 8
and all.

## 3. Is distance overweighted? The simulator cannot say — see §4

Two corrections live in this section, and the second cancels the first.

I initially reported the proximity sweep as flat. That was read off the first
two-thirds of the output and it was wrong; corrected in place in
`DIAGNOSTICS.md` §G0.3 rather than quietly, because "read a partial sweep, called
it flat" is the same error class as §D4's three-seed optimum.

The full range identifies optima at **w = 0.70 (N=150)** and **0.65 (N=600)**,
both clearing 2 SE — roughly **3× the shipped 0.20** — with repeat rate still
rising at 0.80, the top of the swept range. So the sign appeared to point the
opposite way from the question: proximity looked *under*-weighted.

**Then §4 disqualified the measurement entirely.** Distance sits inside the
simulator's join model, so every proximity sweep in this harness — §D4's, this
one, and §4's — is measuring how closely the ranker approximates the sim's own
join function. The answer to "is distance overweighted" is **not obtainable
here**, in either direction.

## 4. A result that appeared to invert the premise — and why it does not

§3 measured a secondary metric. Run on **host retention**, matched seeds, through
the gate:

```
N=600, host retention
 1  ranker_repaired @ w=0.65    0.968 ±0.003
 2  shipped                     0.958 ±0.002    1.49×  SEPARATES
 3  ranker_repaired @ w=0.20    0.933 ±0.003    3.32×  SEPARATES
```

Read alone, that inverts everything: the governing finding since v1.5 reproduces
decisively at `w = 0.20`, and changing that one weight makes the same ranker beat
the shipped configuration on both primary metrics.

**It does not survive the outside writeup's own third caveat**, which arrived
after this was measured:

> *the sim's hidden join model is affinity × distance only, which hands
> `proximity_only` a home-field advantage worth an unknown share of the residual.*

Verified. `scripts/population.ts` computes join probability from
`relevance = affinity × exp(−miles/3)`, and the ranker's proximity feature is
`exp(−miles/4)` — which is `exp(−miles/3)^0.75`. **The ranker's proximity feature
is a monotone transform of a multiplicative term inside the simulator's own join
probability.**

So raising `w_proximity` moves the ranker toward the sim's generative model. More
joins follow, then fewer empty posts, then higher retention — a chain that runs
through the data-generating process, not through anything about ranking.

**This harness cannot answer the proximity-weight question at all.** That applies
equally to §D4, to §3 above, and to this section. The whole proximity-sweep line
of work is measuring the harness.

**What survives, running the other way:** `proximity_only` places *fourth* on
host retention **while holding the home-field advantage**. An arm handed the
answer key that still loses the primary metric is a stronger result than it
looked — its allocation failure (20% zero-joiner, 41.3% of hosts alive) is large
enough to overcome a built-in edge.

## 5. Why nothing was changed

Reasons 1–5 predate the result. Reason 6 came from the outside writeup and is
disqualifying rather than cautionary.

1. **It favours the ranker, and the standing rule discounts exactly that.** The
   simulator was authored alongside the ranker it now vindicates. The negative
   results were believed *because* they were against interest; a positive one
   does not get to skip the toll that bought them their credibility.
2. **Setting it would be tuning a constant to improve a metric** — and
   `collapsed.pJoin.proximity` already carries a comment refusing this exact move
   for this exact parameter.
3. **The optimum is not stable.** §D4 named 0.10 / 0.30 from these same seeds
   pre-abort; this run names 0.70 / 0.65 post-abort.
4. **It does not separate at beta scale.** At N=150 it is a TIE (0.30×). At N=40
   the ladder could not separate five arms at all. The beta is ~40 users.
5. **`RANKER_ENABLED` is false**, so `w_proximity` orders nothing that ships.
6. **The measurement is confounded by the simulator's join model** (§4). This one
   is not a reason to be careful; it is a reason the number means something other
   than what it appears to.

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

Its direction on proximity cannot be judged from the simulator (§4), and their
own writeup is the reason — the home-field caveat is theirs, and it disqualifies
the evidence that would otherwise have supported their change. Their writeup also
says exactly the right thing about this: *"use them as the shadow-mode starting
point and let `ranking_events` data refit them."* That is the correct disposition
and it is what the logging architecture was built for.

Three things about their method are worth sending back, none of which makes the
work less useful:

- The metric is **repeat rate** — the one `proximity_only` wins by construction
  (§1). Host retention is not reported, and it reverses the ranking.
- **Three seeds.** §D4 is on record that this harness returns confident wrong
  answers at three; the seed spread at *fixed* `w` reached 0.051 against an
  across-`w` range of 0.108. §1–§4 used twelve.
- The arms `full_ranker_fixed` and `regime_adaptive` were **deleted in v1.8 §2**
  — collapsing the density pairs made them the same configuration. Their finding
  #3 (pinning the regime beats adapting it) is a rediscovery of that collapse,
  already actioned.

Their caveat that `fresh_host = 0` and `exploreEpsilon = 0` should not ship is
correct, and the current repo already agrees: `quotas.fresh_host` is `0.10` and
`exploreEpsilon` is `0.15`.

## 8. What to do next, in order

1. **Ship as-is.** Nothing in this audit licenses a change to the launch config.
2. **Turn on logging.** `score_snapshot` already carries every feature needed to
   test §4 against real behaviour.
3. **First hypothesis to test on live data:** is `w_proximity` too low? Still the
   highest-value open question, ahead of `demandWeight` — but it can now only be
   settled against real `ranking_events`, never against this simulator (§4).
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
| `DIAGNOSTICS.md` §G0.7 | the external writeup read in full; the join-model confound |
| `REPORT.md` | this file |

No source file under `src/` was modified. No constant moved.
