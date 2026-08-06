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

**Observed:** `regime_adaptive` repeat rate, exhaustion off (shipped) against
exhaustion restored to the v1.6 rates:

| N | exhaustion **off** | exhaustion **on** | delta |
|---:|---:|---:|---:|
| 40 | 0.578 | 0.548 | −0.030 |
| 80 | 0.519 | 0.464 | −0.055 |
| 150 | 0.466 | 0.427 | −0.039 |
| 300 | 0.460 | 0.428 | −0.032 |
| 600 | 0.464 | 0.417 | −0.047 |

**Held: directionally yes, but the magnitude does not carry the claim.**

The predicted mechanism is real and visible. Exhaustion costs repeat rate at
every size, and it costs more at high density than at low (−0.030 at N=40 versus
−0.047 at N=600), which is exactly what "accumulates with completions, and
completions grow with N" predicts.

But it explains almost none of what it was invoked for. v1.6's decline was
0.562 at N=40 down to 0.419 at N=600, a drop of 0.131. Turning exhaustion off
changes that decline to 0.578 → 0.464, a drop of 0.114. **Exhaustion accounts
for roughly 13% of the decline.** The other 87% is something else — and §D3
finds it.

The shipped arm tells the same story more sharply: with exhaustion re-enabled
its repeat rate at N=600 falls from 0.518 to 0.448, while host retention barely
moves (0.960 to 0.953). So disabling exhaustion was clearly right on repeat rate
and approximately free on the primary metric, which is the best case for a
change made on principle rather than on evidence.

*This confirms rather than contradicts v1.6.* §F8 called `repeatAffinity` being
inert "the single most important thing to fix", and predicted exhaustion was
damping good repeats along with bad ones. It was. It just was not the main
event.

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

`full_ranker_fixed` loses too, by about the same amount. `shipped` and
`proximity_only` beat `random` comfortably at every size.

### The investigation

**Not a coding bug.** The first thing to rule out was the arm being misconfigured
— it is woken from the shelf through `paramsOverride`, which is new. It is not:
re-running `regime_adaptive` at `funnelExponent = 1` reproduces the main sweep's
row byte for byte (0.824 / 0.768 / 0.460 / 12.814 / 39.2% / 18.9% / 0.884 /
0.094). The arm is doing exactly what the v1.6 ranker did.

It is also not failing to generate joins. At N=600 it produces 13.97
tandems/user against `random`'s 5.16, and its deck relevance is 0.096 against
0.055. It is **better than random at picking cards and worse than random at
keeping hosts.**

That narrows it to distribution, and the Gini says so loudly: 0.931 for
`regime_adaptive` against 0.645 for `random` and 0.398 for `shipped`. The
ranker's attention is concentrated on a handful of hosts, everyone else's posts
get nobody (52.9% zero-joiner against `random`'s 42.9%), and they churn.

**Two candidate mechanisms, tested separately.**

*Could demand balancing have absorbed it?* §2 exists for exactly this failure,
and at city scale `demandWeight` resolves to 0.10. Forcing it to 0.50 — the
village value, five times the shipped one, at maximum density:

| N=600, three seeds | retention | zero-joiner | hosts alive | Gini |
|---|---:|---:|---:|---:|
| `regime_adaptive` | 0.783 | 51.2% | 12.2% | 0.931 |
| + demand at 5x | 0.809 | 41.2% | 15.6% | 0.899 |
| `random` | 0.858 | 42.9% | 22.7% | 0.645 |

Five times the demand weight closes about a third of the gap to `random` and
still loses to it. **Demand balancing cannot absorb this.**

*Is it the funnel?* `P_accept`, `P_complete` and `R_repeat` are the only terms in
the score that are **viewer-independent**. `proximity` differs per viewer — my
nearest posts are not yours — but a host's accept rate and completion rate are
the same number for everyone. Put a global quality term into a greedy per-viewer
ranker and every client independently ranks the same hosts up. That is a
rich-get-richer loop, and it is structural rather than a mistake in the code.

Sweeping `funnelExponent` from 1 (full v1.5 funnel) to 0 (P_join alone), at
N=300, three seeds:

| funnelExponent | retention | repeat rate | tandems/user | zero-joiner | hosts alive | Gini | deck relevance |
|---:|---:|---:|---:|---:|---:|---:|---:|
| **1.00** | 0.824 | 0.460 | 12.81 | 39.2% | 18.9% | 0.884 | 0.094 |
| 0.75 | 0.820 | 0.462 | 14.04 | 33.2% | 21.9% | 0.850 | 0.101 |
| 0.50 | 0.868 | 0.438 | 15.43 | 24.2% | 30.8% | 0.756 | 0.112 |
| 0.25 | 0.894 | 0.430 | 15.99 | 16.9% | 41.9% | 0.624 | 0.121 |
| **0.00** | **0.928** | 0.408 | 15.35 | **12.9%** | **50.7%** | **0.484** | **0.128** |

**Monotone on five metrics simultaneously.** Zero-joiner rate, surviving hosts,
Gini and deck relevance move in one direction across every step; retention
follows after the first. At N=600 the endpoints are starker still: retention
0.783 → 0.948, zero-joiner 51.2% → 9.4%, hosts alive 12.2% → 57.1%, Gini
0.931 → 0.430.

**Verdict: a design failure, not a bug — and the largest single finding in this
build.**

The instruction was that losing to `random` indicates a bug. It does not here,
and the reason it does not is worth stating precisely: the ranker is not
malfunctioning, it is doing what a greedy per-viewer ranker with a global
quality term must do. `random` beats it on host retention because `random`
cannot concentrate. That is not `random` being good; it is concentration being
expensive enough to outweigh being 2.7x better at picking cards.

Three things follow.

1. **Deck relevance goes UP as the funnel comes off** (0.094 → 0.128). The funnel
   is not trading relevance for fairness. It is *displacing cards the hidden
   model wants* and concentrating attention while doing it. v1.6 §G3 measured
   the same displacement (26%) and attributed it to "diversity caps, explore,
   the fresh-host slot and the funnel decomposition" collectively. It is the
   funnel.
2. **Repeat rate moves the other way** (0.460 → 0.408), which is the one thing
   the funnel buys. `R_repeat` is explicitly a bet on recurrence and it wins
   that bet. Under v1.6's metric the funnel looked defensible; under host
   retention it is the most expensive thing in the system. The metric change
   is doing real work here, not cosmetic work.
3. This is **strong evidence** by the standing caveat: it is against the ranker,
   it is monotone across five ablation steps and two population sizes, and the
   mechanism is independently visible in the Gini rather than being inferred
   from the outcome alone.

**Not acted on.** `funnelExponent` remains 1 in `constants.ts` and reaches 0
only through the ship gate. Turning the funnel off permanently is a decision to
surface, not to take inside a diagnostic — and it should be taken against real
`ranking_events` data, which is what this build exists to produce.

---

## D4 — Expanded proximity sweep (§4.4)

**Predicted:** v1.6 declared `w_proximity` as `{village 0.40, city 0.20}` on the
theory that selection matters more when there is more to select from, then
measured the opposite at every density it could see. If one fixed value is
near-optimal everywhere, the scaled pair is complexity with no payoff and should
collapse to a scalar.

**Command:**

```bash
npm run sweep -- --proximity-sweep --seeds 1,2,3,4,5,6
```

### First, a correction to the harness

The first run of this sweep, at three seeds, confidently reported three
different optima at three densities (0.40, 0.10, 0.30) and concluded **"NO
SINGLE VALUE WORKS: the optimum genuinely moves with density, so the scaled pair
is earning its complexity."**

That conclusion was wrong, and it was wrong in the most dangerous available way:
it validated the existing design. Checking the noise floor before believing it —
the same `w`, run against three *different* seed triples at N=150:

| w | seeds 1-3 | seeds 4-6 | seeds 7-9 | spread |
|---:|---:|---:|---:|---:|
| 0.20 | 0.735 | 0.734 | 0.730 | 0.005 |
| 0.40 | 0.710 | 0.754 | 0.735 | 0.044 |
| 0.60 | 0.798 | 0.747 | 0.783 | 0.051 |

The seed-to-seed spread at *fixed* `w` reaches 0.051. The entire across-`w`
range was 0.108. **The optima were noise draws.** A maximum over fifteen noisy
points is not an optimum, and a sweep that reports one as a finding is worse
than a sweep that reports nothing.

`Aggregate` now carries the standard error across seeds, and the verdict is
gated: an optimum must clear the median by two standard errors or the harness
prints `OPTIMUM UNIDENTIFIABLE` and says how many more seeds it would take. The
numbers below are six seeds, through the gated verdict.

### Observed

Full table in [`proximity-sweep.md`](proximity-sweep.md); the two columns that matter:

| w_proximity | N=40 ret | N=150 ret | N=600 ret | N=40 repeat | N=150 repeat | N=600 repeat |
|---:|---:|---:|---:|---:|---:|---:|
| 0.10 | 0.771 | 0.782 | 0.746 | 0.485 | 0.421 | 0.427 |
| 0.20 | 0.840 | 0.735 | 0.756 | 0.519 | 0.444 | 0.452 |
| 0.30 | 0.762 | 0.755 | 0.768 | 0.519 | 0.449 | 0.455 |
| 0.40 | 0.847 | 0.732 | 0.740 | 0.489 | 0.448 | 0.486 |
| 0.50 | 0.769 | 0.777 | 0.745 | 0.535 | 0.481 | 0.494 |
| 0.60 | 0.787 | 0.772 | 0.756 | 0.531 | 0.494 | 0.523 |
| 0.70 | 0.818 | 0.722 | 0.752 | 0.521 | 0.520 | 0.536 |
| 0.80 | 0.821 | 0.742 | 0.741 | 0.541 | 0.526 | 0.536 |

Gated verdict:

```
N=40:  OPTIMUM UNIDENTIFIABLE on retention. Best w=0.40 at 0.847, only 0.048
       above the median against a seed noise of +/-0.038.
N=150: optimum w_proximity 0.10 (0.782, 0.040 above median, noise +/-0.020)
N=600: optimum w_proximity 0.30 (0.768, 0.016 above median, noise +/-0.007)

repeat rate rises at  9/14 steps at N=40   (0.485 -> 0.541)
                      9/14 steps at N=150  (0.421 -> 0.526)
                     12/14 steps at N=600  (0.427 -> 0.536)
```

**Held: no — and the scaled pair should collapse.**

Three findings, in order of confidence.

**1. On the primary metric, `w_proximity` barely matters.** Retention is flat in
`w` to within noise across the whole 0.10–0.80 range at all three densities. The
two "optima" that clear the two-standard-error bar do so by 0.040 and 0.016 and
point in opposite directions. This is consistent with §D3: what determines host
retention is the funnel's concentration, not how much of P_join goes to
proximity. The lever v1.6 §G6 ranked first is not the lever.

**2. On repeat rate the signal is clean, monotone, and unfinished.** It rises
across the sweep at every density and is *still rising at 0.80*, the top of the
range. There is no interior optimum in [0.10, 0.80]. "More proximity is better
on repeat rate" — the v1.6 finding — reproduces, and extends further than that
sweep looked.

**3. The scaled pair's direction is contradicted, so the pair should collapse to
a scalar.** v1.6 declares `{village 0.40, city 0.20}` — *less* proximity at high
density, on the theory that selection matters more when there is more to select
from. But the repeat-rate gain from raising proximity is **largest at N=600**
(+0.109 from 0.10 to 0.80) and smallest at N=40 (+0.056). The city column should
be higher than the village one, not half of it.

And since retention is flat in `w` while repeat rate wants `w` maximal at every
density, **there is no density at which a lower proximity weight wins.** A
two-column table whose columns both want to move the same way, to the same
place, is not modelling a real interaction. It should be one number.

**Not acted on.** `pJoin.proximity` is untouched. Collapsing a scaled pair is a
structural change to the v1.6 architecture, and the evidence for where to set
the resulting scalar runs off the edge of the swept range — which means the next
experiment is a wider sweep, not an edit. Both are decisions to surface.

---

## C — Collapsed scaled pairs (v1.8 §2)

Twelve `{village, city}` pairs were declared across v1.6. **Exactly one was ever
swept** — proximity, in §D4 — and that sweep found the primary metric flat in
it, with the repeat-rate gain *largest* at N=600, which is the opposite of what
its pair asserts. The other eleven were asserted and never tested.

§D4 also showed this harness can produce a confident three-seed verdict that is
backwards, and that the backwards verdict was the one **validating the existing
design**. Eleven untested pairs is eleven chances to be confidently wrong in the
comfortable direction.

All twelve are collapsed to the **city** value. Shelved, not deleted: coverage,
EWMA, hysteresis, `resolve()` and the `Scaled<T>` type are intact and still
tested; `resolveParams` is now an identity, asserted by a test that walks the
whole continuum and requires byte-identical output.

| parameter | village | city | collapsed to |
|---|---:|---:|---:|
| `pJoin.interestAffinity` | 0.10 | 0.30 | **0.30** |
| `pJoin.proximity` | 0.40 | 0.20 | **0.20** ⚠️ |
| `pJoin.timeFit` | 0.20 | 0.12 | **0.12** |
| `pJoin.intentMatch` | 0.10 | 0.15 | **0.15** |
| `pJoin.socialContext` | 0.05 | 0.08 | **0.08** |
| `pJoin.graphAffinity` | 0.0 | 0.0 | **0.0** (stub) |
| `exploreEpsilon` | 0.0 | 0.15 | **0.15** |
| `quotas.affinity` | 0.30 | 0.57 | **0.57** |
| `quotas.proximity` | 0.70 | 0.28 | **0.28** |
| `quotas.fresh_host` | 0.0 | 0.10 | **0.10** |
| `quotas.random` | 0.0 | 0.05 | **0.05** |
| `categoryPenalty` | 0.95 | 0.80 | **0.80** (UNMEASURED) |
| `hostPenalty` | 0.85 | 0.60 | **0.60** (UNMEASURED) |
| `demandWeight` | 0.50 | 0.10 | **0.10** |
| `overflowPenalty` | 0.6 | 0.2 | **0.2** |
| `exhaustionRate` | 0.0 | 0.0 | **0.0** (disabled, v1.7 §3.1) |
| `noveltyBoost` | 1.0 | 2.5 | **2.5** |

### ⚠️ The one value with swept evidence, and why it still took the city column

`pJoin.proximity` is the only collapsed parameter with a measurement behind it,
and the measurement is awkward.

On **host retention**, the primary metric, §D4 found it flat within noise across
0.10–0.80 at all three densities; the gated verdict returned
`OPTIMUM UNIDENTIFIABLE` at N=40 and margins of 0.040 and 0.016 at N=150 and
N=600. **The sweep identified no value**, so "unless a swept result says
otherwise" is not satisfied and the city default applies.

On **repeat rate** it rises monotonically and is still rising at 0.80, the top
of the swept range, with the largest gain at N=600.

Taking 0.20 is the **non-tuning** choice. The primary metric does not
distinguish the candidates, and picking the repeat-rate direction would be
tuning a constant to improve a metric — which this build is explicitly not
doing. Recording the tension here is the alternative to resolving it silently.

The pending experiment is a sweep **wider than 0.80**, not an edit. Note also
that nothing user-visible depends on this: the ranker is shelved, and the
shipped deck is proximity-ordered regardless of what P_join's weights say.

### Reactivation condition

A swept pair that beats its collapsed constant at **6+ seeds and 2 standard
errors** — the bar §D4 had to invent when its own first answer turned out to be
noise. Not a plausible argument. A measurement.

Two side effects worth noting:

- **The continuity test is now vacuous** and was replaced by a stronger one:
  `resolveParams` must return byte-identical output at every regime, including
  NaN and out-of-range input.
- **`paramsFingerprint` is now constant**, because `noveltyBoost` no longer
  moves with density. The mechanism (INFERENCES §F6) is retained rather than
  deleted — it costs one string per cache write, and it is exactly what is
  needed again the day a pair earns reactivation.

---

# v1.8 — Funnel repair

Same rules. Every configuration through `paramsOverride`, nothing tuned, and the
standing caveat unchanged: **results favouring the ranker are weak evidence,
results against it are strong.** Everything decisive below is against it.

## E1 — All arms, all N, six seeds (§3.2)

```bash
npm run sweep -- --seeds 1,2,3,4,5,6 --md sweep-v18.md --csv sweep-v18.csv
```

Host retention, the primary metric:

| N | shipped | ranker_repaired | ranker_no_funnel | proximity_only | random |
|---:|---:|---:|---:|---:|---:|
| 20 | 0.833 | 0.825 | 0.800 | **0.875** | 0.833 |
| 40 | 0.883 | 0.858 | 0.892 | **0.900** | 0.854 |
| 80 | 0.910 | 0.871 | 0.894 | **0.927** | 0.871 |
| 150 | **0.930** | 0.856 | 0.920 | 0.909 | 0.868 |
| 300 | **0.944** | 0.848 | 0.933 | 0.925 | 0.865 |
| 600 | **0.957** | 0.838 | 0.946 | 0.930 | 0.860 |

Host-attention Gini, the mechanism:

| N | shipped | ranker_repaired | ranker_no_funnel | proximity_only | random |
|---:|---:|---:|---:|---:|---:|
| 150 | **0.508** | 0.789 | 0.521 | 0.568 | 0.644 |
| 300 | **0.470** | 0.821 | 0.475 | 0.541 | 0.643 |
| 600 | **0.409** | 0.842 | 0.429 | 0.532 | 0.649 |

**`ranker_repaired` is the worst arm on the primary metric at N ≥ 150, and at
N=600 it is the worst of all five — below `random`.**

Three things follow.

1. **The repair did not clear the §D3 guard.** It reduced Gini from 0.884 to
   0.821 at N=300, which is a real improvement, and it is nowhere near enough.
2. **`ranker_no_funnel` is now within a whisker of `shipped`** (0.946 vs 0.957
   retention at N=600; Gini 0.429 vs 0.409). Removing the funnel entirely gets
   almost all of the shipped configuration's benefit.
3. **`shipped` is the best arm on retention at every N ≥ 150** and on every
   liquidity metric at every size — 9.4% zero-joiner posts at N=600 against
   `proximity_only`'s 20.2% and `ranker_repaired`'s 33.5%. The v1.7 conclusion
   holds under the v1.8 code.

`proximity_only` still wins repeat rate everywhere (0.655 at N=600), which
also holds from v1.7 and remains a property of a pool-shrinking algorithm
scoring well on a ratio.

## E2 — The `random` guard, again (§4.3 rule)

The sweep fired `BUG SUSPECTED` four times. Investigated before reporting
anything else, as the standing rule requires.

**Not a new bug. The same design failure, incompletely repaired**, and the ρ
sweep quantifies exactly how much of it is left.

The v1.7 §D3 mechanism was: viewer-independent quality terms in a per-viewer
product create global consensus, attention concentrates, hosts churn. §1.2
reduced the magnitude of that consensus (rank-normalisation, damping) and added
a genuinely pairwise interaction (pickiness), but `hostRank^0.5` is still a
substantial **main effect** — and a dampened global consensus is still a global
consensus.

The decisive evidence that this is the whole explanation:

| configuration | retention (N=300) | Gini | vs `random` (0.865) |
|---|---:|---:|---|
| ρ = 0.5 *(shipped repair)* | 0.848 | 0.821 | ❌ loses |
| ρ = 0 *(host main effect removed)* | 0.922 | 0.511 | ✅ wins by 0.057 |

Nothing else differs across that boundary — same features, same weights, same
gate, same pickiness interaction. **The host term surviving as a main effect is
the entirety of the residual failure.**

Also worth noting: `ranker_no_funnel` loses to `random` at N=20 (0.800 vs
0.833). That one *is* noise — coverage is 0.515, the pool is ~10 posts against a
deck of 8, so every arm shows nearly everything and the arms are not
distinguishable at that size. It does not reproduce at any larger N.

## E3 — ρ dose–response (§3.3)

Full table and analysis in [`FUNNEL.md`](FUNNEL.md) §4. Monotone on five metrics
at N=300, six seeds, every one favouring ρ = 0; repeat rate the lone dissenter,
peaking at ρ = 0.75.

## E4 — `repeatableContext`, kept vs dropped (§3.4)

| weight | retention | repeat rate | zero-joiner | Gini | relevance |
|---|---:|---:|---:|---:|---:|
| 0.25 *(kept)* | 0.848 | 0.474 | 32.9% | 0.821 | 0.104 |
| 0.00 *(dropped)* | 0.855 | 0.471 | 32.2% | 0.817 | 0.104 |

Indistinguishable. **Recommendation: drop it**, which empties
`DAMPENED_MULTIPLICANDS` and removes the one route to the deck whose safety
argument is "less of a bad thing" rather than "not a bad thing".
[`FUNNEL.md`](FUNNEL.md) §5 records what is being given up.

## E5 — The two dropped ablations (§3.1)

v1.7 abandoned two ablations for time. The reason mattered and was stated at the
time: the harness scan was quadratic in run length, an arm that completes more
tandems creates more posts through supply response, so **the best-performing
configurations were the slowest to measure** — a harness whose cost correlates
with the result selects which results get collected.

**The worry was justified. One of the two dropped ablations is the best
configuration measured anywhere in this build.**

N=600, six seeds, `ranker_repaired` with the stated overrides:

| configuration | retention | repeat | tandems/u | zero-joiner | hosts alive | Gini | relevance |
|---|---:|---:|---:|---:|---:|---:|---:|
| `ranker_repaired` baseline | 0.838 | 0.440 | 15.96 | 33.5% | 15.9% | 0.842 | 0.114 |
| **C: demand ×5 + funnel off** | **0.970** | 0.316 | 14.60 | **3.2%** | **72.9%** | **0.364** | 0.135 |
| `shipped`, for comparison | 0.957 | 0.515 | 17.81 | 9.4% | 59.5% | 0.409 | 0.161 |

Ablation C beats every arm in E1 on retention, zero-joiner rate, surviving hosts
and Gini — 3.2% of posts got nobody, against `shipped`'s 9.4% and
`proximity_only`'s 20.2%.

### The finding, which contradicts v1.7 §D3

v1.7 measured demand balancing at 5× and concluded it "cannot absorb this": it
closed about a third of the gap to `random` and still lost. **That measurement
was taken with the funnel intact.** Repeated with the funnel off, the same 5×
demand weight produces the best liquidity numbers in the entire build.

So the two interact, and the direction is worth stating plainly:

> Demand balancing is nearly useless while a global-consensus term is fighting
> it, and highly effective once that term is removed.

Which makes sense mechanically. Demand balancing is a `global_allocation` term
trying to spread attention; `hostRank^ρ` is a `global_quality` term concentrating
it. They are the same kind of object pointed in opposite directions, and the
concentrating one was winning. v1.7's "demand balancing cannot fix this" was
true and is not the same claim as "demand balancing does not work".

It costs repeat rate (0.316 against `shipped`'s 0.515) and some deck relevance
(0.135 vs 0.161), which is the trade this configuration is making — fewer,
better-spread joins.

### A note on how this was almost missed twice

I pre-wrote the conclusion of this section as "it did not turn out to matter"
before the numbers landed, and had to correct it. That is the same failure mode
as §D4's three-seed verdict: a comfortable conclusion, written down before the
evidence, that happened to validate the existing decision. Recorded because the
correction is more informative than the result.

**Not acted on.** `demandWeight` remains 0.10.

---

## What this build did NOT do

Did not tune. `constants.ts` contains the same numbers it did before the
diagnostics ran, with three exceptions, all of which are documented behaviour
changes rather than tuning and all of which were committed **before** any
diagnostic was run:

- `exhaustionRate` to zero (§3.1), on the stated principle that a term gated on
  data that does not exist should not be live
- `maxPerCategory` / `maxPerHost` replaced by `categoryPenalty` / `hostPenalty`
  (§3.2), which is a specification fix
- `funnelExponent` added, defaulting to 1 — the ship gate moves it, the
  diagnostics move it, nothing tuned it

Every diagnostic configuration went through `RankOptions.paramsOverride`, so
none of them touched a constant.

### One harness change, disclosed

`scripts/sweep.ts` replaced a linear `world.posts.find()` per card with a
`Map` lookup. Purely a performance fix — `population.ts`, the frozen model, is
untouched, and `regime_adaptive` at N=300 reproduces its pre-change row byte for
byte (0.824 / 0.768 / 0.460 / 12.814 / 39.2% / 18.9% / 0.884 / 0.094).

It is disclosed because it mattered: the scan was quadratic in run length, and
it bit hardest exactly where the interesting configurations lived — an arm that
completes more tandems triggers more supply response, creates more posts, and
makes every subsequent lookup slower. **The best-performing ablations were the
slowest to run**, which is a bad property for a diagnostic harness and had
already caused two ablations to be abandoned for time before it was fixed.
