# DIAGNOSTICS

Four hypotheses, stated before the runs, tested against the frozen population
model in `scripts/population.ts`. Each section says **what was predicted**,
**what was observed**, and **whether it held** — including where the answer
contradicts the v1.6 conclusion and where it confirms it.

Nothing here was tuned to improve a result. Every configuration was applied
through `RankOptions.paramsOverride`, which exists precisely so that a
diagnostic's setup is visible in `scripts/sweep.ts` instead of in a
`constants.ts` edit that was reverted before the commit. Reproduce any row with
the command printed above it.

---

## The standing caveat, restated

> The simulator was authored alongside the ranker it evaluates, so results
> favouring the ranker are **weak** evidence and results against it are
> **strong** evidence.

That has not changed and does not get to be forgotten because the primary metric
did. The strongest result below (§D3) is against the ranker, which is why it is
reported as a finding rather than as a hypothesis needing more work.

## The metric change, and why it is not a softening

v1.6 steered by repeat-tandem rate, `repeats / completions`. That is a **ratio**,
and a ratio can be won by shrinking its denominator: show the same eight people
to each other forever and every completion is a repeat, the metric reads 1.0,
and the product is dead.

`proximity_only` shrinks the pool **by construction**. It shows a user their
nearest neighbours and only their nearest neighbours, for as long as they use
the app. So a metric that rewards pool-shrinking will keep reporting that the
pool-shrinking algorithm is best — a property of the metric, not a finding about
the algorithm.

Host retention is a count, so it cannot be won by doing less.

Repeat rate is still reported in every table below. Where the two metrics
disagree, both numbers are given and the disagreement is the finding.

### Two retention numbers, and why

| metric | definition |
|---|---|
| **host retention** | of hosts whose *first* post has settled, the fraction who posted again afterwards |
| **retention after empty** | the same question, conditioned on that first post getting **nobody** |

The headline number saturates in this simulator — the frozen model posts at
0.18/day, so a second post happens almost automatically before churn can bite,
and every arm lands between 0.78 and 0.96. That is reported rather than hidden,
but it is not much of a measurement.

The conditional cut is where the signal is, and it is also the exact event the
entire village objective exists to prevent: a host posts, gets nobody, and never
comes back.

---

## D1 — Host retention (§4.1)

**Predicted:** `proximity_only`'s v1.6 win is at least partly an artefact of a
pool-shrinking metric. Under host retention the gap should narrow or reverse.

**Command:**

```bash
npm run sweep -- --sizes 20,40,80,150,300,600 --seeds 1,2,3 --md sweep-results.md
```

**Observed:** see [`sweep-results.md`](sweep-results.md) for the full table. The
headline comparison, host retention, three seeds:

| N | shipped (v1.7) | regime_adaptive | full_ranker_fixed | proximity_only | random |
|---:|---:|---:|---:|---:|---:|
| 20 | 0.865 | 0.883 | 0.800 | 0.883 | 0.800 |
| 40 | 0.900 | 0.858 | 0.883 | 0.908 | 0.858 |
| 80 | 0.912 | 0.863 | 0.845 | 0.925 | 0.879 |
| 150 | **0.933** | 0.842 | 0.837 | 0.909 | 0.862 |
| 300 | **0.964** | 0.824 | 0.820 | 0.920 | 0.860 |
| 600 | **0.960** | 0.783 | 0.797 | 0.927 | 0.858 |

And the same runs on repeat rate, v1.6's metric:

| N | shipped | regime_adaptive | proximity_only |
|---:|---:|---:|---:|
| 150 | 0.550 | 0.466 | **0.648** |
| 300 | 0.561 | 0.460 | **0.647** |
| 600 | 0.518 | 0.464 | **0.651** |

**Held: partly, and the partial answer is the interesting one.**

*Confirming v1.6:* `proximity_only` still beats every ranked arm on repeat rate
at every size, by roughly the same 24–40% margin. Changing the metric did not
make that go away, and it should not have — that finding was about the ranker,
and it stands.

*Contradicting v1.6:* the metric change reverses the *ranking of the arms*. The
shipped v1.7 configuration — proximity, demand balancing and session penalties,
with the ranker shelved — beats `proximity_only` on host retention at every size
from 150 up, and the margin grows with density (+2.6% at N=150, +4.8% at N=300,
+3.6% at N=600). It also wins on every liquidity metric by a wide margin at
N=600: zero-joiner posts 8.8% against 20.4%, surviving hosts 59.7% against
42.5%, host Gini 0.414 against 0.525.

So both are true at once. `proximity_only` produces more repeat tandems among
fewer people; the shipped configuration keeps more hosts alive and fills more
posts. Under the beta's stated objective the second is what matters, and it is
the arm that ships.

*What did not change:* `regime_adaptive` and `full_ranker_fixed` lose to
everything, on both metrics, at every size above 80 — including to `random`.
That triggered the §4.3 guard, and §D3 is the investigation.

---

## D2 — Exhaustion (§4.2)

**Predicted:** exhaustion accumulates with completions, completions grow with N,
so the term mechanically suppresses the measured metric as density rises — which
would explain v1.6's decline from 0.562 at N=40 to 0.419 at N=600.

**Command:**

```bash
npm run sweep -- --exhaustion on     # v1.6 rates, via paramsOverride
```

_Results below._

---

## D3 — All four arms, and the `random` guard (§4.3)

**Predicted:** `random` is the floor. The instruction was explicit: if
`regime_adaptive` loses to `random`, that is a bug rather than a design failure,
and it gets investigated before anything else is reported.

**Observed:** it loses.

| N | regime_adaptive | random | verdict |
|---:|---:|---:|---|
| 150 | 0.842 | 0.862 | loses |
| 300 | 0.824 | 0.860 | loses |
| 600 | 0.783 | 0.858 | loses |

_Investigation below._

---

## D4 — Expanded proximity sweep (§4.4)

**Predicted:** v1.6 declared `w_proximity` as `{village 0.40, city 0.20}` on the
theory that selection matters more when there is more to select from, then
measured the opposite at every density it could see. If one fixed value is
near-optimal everywhere, the scaled pair is complexity with no payoff and should
collapse to a scalar.

**Command:**

```bash
npm run sweep -- --proximity-sweep
```

_Results below._
