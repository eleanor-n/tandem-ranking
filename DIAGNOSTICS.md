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

**The worry was justified for one of the two.** Ablation C is the best
configuration measured anywhere in this build; ablation D confirmed a known
relationship and changed nothing. One for two is exactly the hit rate that makes
dropping work for time a bad trade.

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

### Ablation D — half funnel

The second dropped ablation. N=600, six seeds, alongside the two endpoints
already measured:

| funnelExponent | retention | repeat | zero-joiner | hosts alive | Gini | relevance |
|---:|---:|---:|---:|---:|---:|---:|
| 1.0 *(`ranker_repaired`)* | 0.838 | 0.440 | 33.5% | 15.9% | 0.842 | 0.114 |
| **0.5 *(ablation D)*** | **0.878** | 0.412 | 22.6% | 29.5% | 0.727 | 0.126 |
| 0.0 *(`ranker_no_funnel`)* | 0.946 | 0.367 | 9.8% | 58.7% | 0.429 | 0.141 |

**This one genuinely did not matter.** It is monotone between the endpoints on
every metric and reproduces the N=300 dose–response from v1.7 §D3 at a second
population size, which is worth having and changes nothing.

One detail it does add: at half strength the funnel **clears the `random`
floor** (0.878 against 0.860) where at full strength it does not (0.838). The
guard failure is not a cliff — it is the same monotone relationship crossing a
threshold, which is consistent with everything else here and inconsistent with
there being a bug.

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

---
---

# v1.9 — Separation

Everything above this line reports point estimates. This section is about
whether any of them were distinguishable, and it is written because the answer
turned out to be *mostly, but not everywhere, and not where I claimed*.

---

## F0 — The methodology failure that prompted this pass

v1.7 §D4 named three different proximity optima at three densities, all inside
the seed-to-seed spread. The response was a 2 SE gate, `OPTIMUM UNIDENTIFIABLE`,
and a comment in `sweep.ts` explaining why a maximum is not a finding.

That gate was then wired to `retentionAfterEmpty` and `repeatRate` — and the
primary metric changed to **`hostRetention`** in the same build. `hostRetention`
had no standard error computed anywhere in `sweep.ts`. Every headline table from
§D1 onward ranked arms by it.

The v1.8 comparison table ordered four arms across a 0.040 span — adjacent gaps
of 0.013, 0.011 and 0.016 — with no error bars, two passes after the harness had
demonstrated that a 0.051 spread could invert a verdict.

Three things were wrong, and only the first is interesting:

1. **The gate was pointed at the wrong metric.** Building the safeguard and then
   not applying it to the number the conclusions rest on is worse than not
   building it, because the file now *reads* as if noise had been handled.
2. **The "loses to random" alarm was a bare `<` on two point estimates.** It
   printed `shipped loses to random at N=20 (0.833 vs 0.833)` — two numbers that
   render identically at the precision they were reported in. An alarm that
   fires on a float difference of ~1e-16 trains the reader to skim past it.
3. **The CSV was written at 3 decimal places** and `podium.ts` then compared a
   0.0219 gap against a 0.0215 bar — deciding separation in a digit the file did
   not carry. It disagreed with the in-memory podium on exactly that pair. Fixed
   by writing 6dp; noted because it is the same error one level down, and I
   introduced it while fixing the original.

`separates()` is two-sample — `sqrt(sa² + sb²)` — not a gap measured against one
arm's SE. Paired seeds would be tighter, since every arm runs the same population
from the same seed and the seed effect could be differenced out. The unpaired
test is used deliberately: a separation claim should not rest on the more
generous of two available tests.

---

## F1 — The clipping defect, found by executing the abort

§1.5 pre-registered: *if Gini stays above ~0.75, drop the terms rather than
repair them.* Gini came in at **0.842 ±0.002**. The abort fired, and setting
`hostAcceptDamping` to 0 broke three tests in `tests/accept.test.ts`.

They were right and my explanation of ρ=0 was wrong.

```
P_accept = clamp01( rank^ρ × (1 + pickiness × deviation) )
```

At ρ=0 the first factor is exactly **1** — the ceiling — so any *positive*
viewer deviation is clipped straight back to 1.

| ρ | viewer | raw | after clamp |
|---|---|---:|---:|
| 0 | category-matching | 1.180 | **1.000** |
| 0 | neutral | 1.000 | **1.000** |
| 0.25 | category-matching | 0.664 | 0.664 |
| 0.25 | neutral | 0.562 | 0.562 |

So ρ=0 keeps the pairwise interaction **only on the downside**: it penalises a
poor record and cannot reward a good one. FUNNEL.md §4 claimed the interaction
"survives at ρ = 0". It half survives, and I wrote that sentence before checking
— again the more flattering of two available readings, which is the third time
this failure mode appears in this file (§D4, §E5, here).

**Left at 0 anyway, deliberately.** ρ=0 is the value the sweep *measured*; the
clipping was inside the arm that scored 0.922. Changing the functional form to
remove the clip would introduce a new design, with no measurement behind it,
under an abort. The un-clipped form is FUNNEL.md §8 item 0 and is **UNMEASURED**.

The classification is directionally vindicated — the *main effect* was the
harmful part — but this is weaker evidence for the taxonomy than §E3 made it
look.

---

## F2 — Two shell mistakes that silently changed an experiment

Recorded in full because neither was catchable by the type system, the tests, or
reading the command back, and because the safeguard that caught one of them was
added earlier in this same pass and fired on its first real run.

**The provenance printout.** `sweep.ts` now prints, on every run:

```
  effective funnel config:
    rho                      0.5 (pinned)
    repeatableContextWeight  0.25 (pinned)
    demandWeight             0.1 (from constants)
    funnelExponent           1 (from constants)
```

It was added after noticing that a long sweep had been launched *before* the
§1.5 abort edited `constants.ts`, so the ablation invocations — which start an
hour into the run — would have inherited different values from the main arms,
producing a comparison table across two configurations with nothing in the
output saying so. That run was killed and relaunched.

**Mistake 1: zsh does not word-split unquoted expansions.**

```zsh
V18="--rho 0.5 --repeatable-context 0.25"
npm run sweep -- --sizes 600 --seeds $S $V18 --csv ...
```

In bash this expands to four arguments. In zsh it is **one**, and every flag
inside it is silently ignored. The relaunched 25-seed run therefore did not pin
anything — it ran at whatever `constants.ts` said, which by then was ρ=0, the
*post*-abort configuration.

The printout said `0 (from constants)` where the command clearly asked for 0.5.
Without it, the post-abort numbers would have been written up as the pre-abort
table, and the write-up would have been internally consistent: `ranker_repaired`
at 0.938 with a Gini of 0.464 is a perfectly plausible-looking row. It is simply
a different experiment.

`parseArgs` now throws on any `--flag` containing a space, and the error names
the zsh behaviour rather than just rejecting the input.

**Mistake 2: `seq -s, 1 24` emits a trailing comma.**

`Number('')` is `0`, not `NaN`, so `.filter(Number.isFinite)` passed the empty
field through and the run used **25** seeds including a seed 0. Harmless to the
result — seed 0 is a valid seed — but it means two tables that both said "24
seeds" were computed over different seed sets. `nums()` now throws.

**The general lesson, which is the reason this is in a diagnostics file at all:**
every one of the errors in §F0 and §F2 is an instance of the same thing — an
experiment quietly becoming a different experiment while its label stays the
same. A gate pointed at the wrong metric, a CSV rounded below the precision of
the comparison, a flag that never parsed, a seed list one element longer than it
claimed. None produce an error. All produce a number that looks fine.

The countermeasure is not more care. It is making the artifact state what it
actually did: error bars on the metric being ranked, the effective configuration
in the run header, and a parser that refuses input it cannot faithfully
represent.

---

## F3 — The v1.8 comparison table, with the error bars it should have had

N=600, **24 seeds**, ρ=0.5 and `repeatableContextWeight`=0.25 pinned on the
command line so the table reproduces the v1.8 configuration regardless of what
`constants.ts` now says. This is the table §E1 reported without error bars.

| rank | arm | host retention | verdict vs next |
|---:|---|---:|---|
| 1 | ablation C (demand ×5, funnel off) | **0.972 ±0.001** | 3.11× SEPARATES |
| 2 | shipped | 0.959 ±0.002 | 2.12× SEPARATES |
| 3 | ranker_no_funnel | 0.947 ±0.002 | 2.16× SEPARATES |
| 4 | proximity_only | 0.933 ±0.002 | 7.08× SEPARATES |
| 5 | ablation D (half funnel) | 0.882 ±0.003 | 2.79× SEPARATES |
| 6 | random | 0.860 ±0.003 | 1.97× SEPARATES |
| 7 | ranker_repaired | 0.843 ±0.003 | — |

**Every adjacent pair separates.** The ordering is fully identified, and
ablation C's win is real rather than a draw dressed as a ranking.

Host Gini separates at every pair too, by much larger margins — 2.07× at the
narrowest, 26.91× at the widest:

| arm | host Gini |
|---|---:|
| ablation C | **0.365 ±0.002** |
| shipped | 0.414 ±0.002 |
| ranker_no_funnel | 0.427 ±0.002 |
| proximity_only | 0.538 ±0.002 |
| random | 0.644 ±0.002 |
| ablation D | 0.725 ±0.002 |
| ranker_repaired | **0.840 ±0.001** |

**Gini is the metric that discriminates in this simulator; host retention is
not.** That is not a new discovery — `sweep.ts` has said so in a comment since
v1.7 ("plain host retention saturates … every arm scores 0.8–0.9 and the metric
separates nothing") — but it is worth restating next to a table where the
retention margins are 2× the noise and the Gini margins are 9× to 27×. The
primary metric is the one that barely resolves.

### The pair that changed its verdict between 6 seeds and 24

This is the whole reason the pass was run, so it gets its own row:

| | random | ranker_repaired | gap | 2 SE bar | verdict |
|---|---:|---:|---:|---:|---|
| 6 seeds | 0.860 ±0.004 | 0.838 ±0.010 | 0.0217 | 0.0221 | **TIE** (0.98×) |
| 24 seeds | 0.860 ±0.003 | 0.843 ±0.003 | 0.0166 | 0.0084 | **SEPARATES** (1.97×) |

Note the shape of it: the *gap* got smaller — 0.0217 to 0.0166 — and the pair
separated anyway, because the *bar* fell faster. At six seeds
`ranker_repaired`'s own SE was ±0.010, three times its 24-seed value, and it
alone accounted for most of the bar.

So the v1.8 claim that the repaired ranker loses to `random` is **correct**, and
was **not demonstrated** by the evidence offered for it. Both halves matter. An
interim report from this pass stated at six seeds that the claim was unsupported;
that was right about the evidence available then and is superseded now. The
honest summary is that v1.8 reached a true conclusion by a method that could not
have distinguished it from a false one.

---

## F4 — Did the abort work? Matched seeds, pre versus post

The §1.5 abort set ρ to 0 and `repeatableContextWeight` to 0. §F3 is the
configuration before it. This is the same seeds, same population, same
everything, after it.

**The control first.** Five of the seven arms do not have ρ anywhere in their
path — `shipped` is shelved, `ranker_no_funnel` and ablation C have
`funnelExponent 0`, and `proximity_only` and `random` are not ranked at all.
All five are **byte-identical** across the two runs, on all five metrics. Only
the two arms that should have moved, moved. That is what makes the rest of this
section a measurement rather than a comparison of two runs.

| arm | retention | Gini | zero-joiner | hosts alive | relevance |
|---|---|---|---|---|---|
| ablation C | 0.972 = | 0.365 = | 3.1% = | 72.8% = | 0.136 = |
| shipped | 0.959 = | 0.414 = | 9.0% = | 58.9% = | 0.161 = |
| ranker_no_funnel | 0.947 = | 0.427 = | 9.7% = | 58.9% = | 0.143 = |
| **ablation D** | 0.882 → **0.944** | 0.725 → **0.448** | 22.2% → **11.5%** | 29.3% → **55.3%** | 0.127 → **0.135** |
| **ranker_repaired** | 0.843 → **0.939** | 0.840 → **0.464** | 33.3% → **12.9%** | 16.6% → **52.8%** | 0.114 → **0.128** |
| proximity_only | 0.933 = | 0.538 = | 19.8% = | 40.8% = | 0.173 = |
| random | 0.860 = | 0.644 = | 42.9% = | 22.4% = | 0.056 = |

For `ranker_repaired`, paired across the same seeds:

| | gap | 2 SE bar | |
|---|---:|---:|---|
| retention | 0.096 | 0.0077 | **12.4× SEPARATES** |
| Gini | 0.376 | 0.0040 | **92.9× SEPARATES** |

**Every metric improved, including deck relevance** (0.114 → 0.128). That is the
same signature as v1.7 §D3 and it is the part worth insisting on: removing the
viewer-independent term is not a fairness-for-relevance trade. The deck got
*more* relevant when the global consensus factor came out of it, because a
factor that is identical for every viewer cannot be carrying per-viewer signal —
it can only be displacing it.

### Where the arm now sits

| comparison | retention | Gini |
|---|---|---|
| vs `random` | 0.939 vs 0.860, **11.9× SEPARATES** | 0.464 vs 0.644, **29.8× SEPARATES** |
| vs `proximity_only` | 0.939 vs 0.933, **0.92× TIE** | 0.464 vs 0.538, **13.7× SEPARATES** |

So the repaired-and-aborted ranker:

* **clears the `random` floor decisively**, which it did not do before (§F3);
* **clears the pre-registered 0.75 Gini ceiling** at 0.464, which was the whole
  point of the abort;
* is **statistically indistinguishable from `proximity_only` on host
  retention** — a 4-way tie with `ranker_no_funnel` and ablation D — while
  beating it on Gini by 13.7×.

That last line is the honest summary of what the ranker currently earns. Against
the taste-blind baseline it buys **no measurable retention** and a **materially
better distribution**. Whether a fairness gain with no retention gain justifies
the complexity is a product decision and not one this file can make — but it is
a much narrower claim than "the ranker works", and it is the claim the data
supports.

### What this does not settle

`ranker_repaired` at ρ=0 still contains the clipping defect of §F1: the upside
of the pairwise interaction is clamped away, so this arm is "no host main
effect, downside-only viewer interaction". It is entirely possible that an
un-clipped form does better than both rows above. That remains **UNMEASURED**
and is FUNNEL.md §8 item 0.

Ablation C remains the best configuration in the build at 0.972 / 0.365, and it
does not depend on ρ at all — its funnel is off. Its margin over `shipped` is
3.11× on retention and 9.34× on Gini. The reason it is still not being adopted
has nothing to do with separation and everything to do with `churnPerEmptyPost`;
see FUNNEL.md §7.

---

## G0 — The simplification audit: an outside replication, and what it eliminated

Prompted by an independent test from outside this project reporting that
**nearest-first still beats the full ranker everywhere, and tuning only closes
part of the gap.** That is the strongest evidence class this repo has: the
simulator was authored alongside the ranker it evaluates, so a result AGAINST
the ranker from someone who did not write either is worth more than anything
generated in here.

It replicated. It also turned out to be a statement about the metric.

### G0.1 — The complexity ladder, 12 seeds, gated

```bash
npx tsx scripts/sweep.ts --sizes 40,150,600 --seeds 1,2,3,4,5,6,7,8,9,10,11,12
```

N=600, the only size where host retention separates at all:

| arm | host retention | repeat rate | zero-joiner | hosts alive | Gini |
|---|---:|---:|---:|---:|---:|
| shipped | **0.958** ±0.002 | 0.518 | 9.2% | 58.9% | **0.414** |
| ranker_no_funnel | 0.948 ±0.003 | 0.372 | 9.8% | 58.9% | 0.428 |
| ranker_repaired | 0.940 ±0.003 | 0.382 | 12.9% | 52.9% | 0.463 |
| proximity_only | 0.935 ±0.003 | **0.657** | 20.0% | 41.3% | 0.535 |
| random | 0.862 ±0.003 | 0.053 | 43.0% | 22.6% | 0.645 |

**Both claims are true at once, and they are about different metrics.**

On **repeat rate** nearest-first wins everywhere, by 72% at N=600 — the outside
result, reproduced. On **host retention** it comes fourth.

The mechanism is legible in `proximity_only`'s own row rather than inferred:
it produces the MOST tandems per user (21.3) and the HIGHEST repeat rate while
leaving TWICE as many posts with nobody (20.0% vs 9.2%) and keeping a third
fewer hosts alive (41.3% vs 58.9%). Repeat rate is a ratio and can be won by
shrinking its denominator; `proximity_only` shrinks the pool by construction,
which `sweep.ts` has warned about since v1.7 and which this is the first direct
measurement of. Host retention is a count and cannot be won that way.

So: nearest-first makes the people it serves tandem more, and serves fewer
people.

### G0.2 — Simplification helps, with an interior optimum already occupied

Reading the ladder as a complexity ladder (N=600):

```
ranker_repaired    0.940 / Gini 0.463    full ranker
ranker_no_funnel   0.948 / Gini 0.428    - the funnel        -> better
shipped            0.958 / Gini 0.414    - the interest model -> BEST
proximity_only     0.935 / Gini 0.535    - demand + penalties -> worse
```

Non-monotone. Removal helps up to `shipped` and reverses hard past it. What is
not earning its place is the interest model and the funnel; what IS earning its
place is the demand layer and the session penalties — precisely the machinery
`proximity_only` discards. **The optimum is the configuration already shipping**,
which is a confirmation and not a change.

**Caveat that governs everything above:** at N=40 host retention is a 5-way tie
and at N=150 a 4-way tie, both `NOT IDENTIFIED`. The beta is ~40 users. At that
size this experiment supports nothing about retention and Gini is the only
metric that discriminates.

### G0.3 — Distance is not overweighted. If anything it is UNDER-weighted.

```bash
npx tsx scripts/sweep.ts --proximity-sweep --sizes 150,600 --seeds 1,2,3,4,5,6
```

**This section originally said "flat, no optimum". That was written off the
first two-thirds of the sweep output and it was wrong.** Recorded rather than
silently corrected, because reading a partial sweep and calling it flat is the
same class of error as §D4's three-seed optimum — the difference is only that
this one was caught before it reached a decision.

The gated verdict on the full range:

```
N=150: optimum w_proximity 0.70 (0.867, 0.071 above median, noise +/-0.026)
N=600: optimum w_proximity 0.65 (0.845, 0.042 above median, noise +/-0.015)
       repeat rate rises at 14/14 steps at N=600 (0.332 -> 0.516)
```

Both optima clear the 2 SE gate. Both are roughly **3× the shipped 0.20**, and
repeat rate is still rising at 0.80, the top of the swept range — the same
open-ended result §D4 got.

So the direction of the error, if there is one, is that proximity is **too
low**, not too high. That is also the direction the externally supplied
constants file moved it (0.20 → 0.50/0.55), which makes that file's author
right about the sign even though the file itself is unusable for other reasons.

**Three things stop this from being a conclusion.**

1. **It is the wrong metric.** `--proximity-sweep` reports
   `retentionAfterEmpty` and `repeatRate`. It has never reported host
   retention, which is the primary metric — the §F0 gap, still open, and it is
   load-bearing here rather than cosmetic. §G0.5 runs the primary metric
   directly.
2. **Repeat rate is the metric nearest-first wins by construction** (§G0.1), so
   "more proximity raises repeat rate" is close to a restatement of that, not
   independent support.
3. **§D4 found different optima from the same seeds.** At six seeds it named
   0.10 at N=150 and 0.30 at N=600; this run names 0.70 and 0.65. The runs are
   not comparable — §D4 predates the ρ and `repeatableContext` aborts — but an
   "optimum" that relocates by 0.6 when two unrelated constants change is not
   behaving like an optimum.

Independently of all of it: **in what ships, `w_proximity` does nothing at all.**
`RANKER_ENABLED` is false, so `pJoin` is collapsed to a delta on proximity and
the deck is proximity × demand × session penalties. This sweep is a finding
about the shelved ranker and a note for whoever turns it on — not a live
mis-weighting.

### G0.4 — What the elimination actually eliminated

The obvious simplification is to delete the shelved ranker. **It was not done,
and the reason is architectural rather than cautious.** `shipping.ts` computes
and logs the full shelved feature set on every impression specifically so the
question stays answerable; `score_snapshot` IS the training set. Deleting the
ranker deletes the training set, and the ladder's support for deleting it exists
only at N=600 — a size the beta will not see.

So the elimination criterion was narrowed to one that cannot be wrong:
**which logged columns are constant?** A constant column carries zero
information, cannot enter a fit, and cannot become informative with more rows,
so deleting one is lossless by measurement rather than by argument.

```bash
npx tsx scripts/deadcolumns.ts --users 300 --days 60 --seeds 1,2,3
```

Six of 23 logged columns are constant across every impression:

| column | value | kind |
|---|---:|---|
| `features.acceptLikelihood` | 1.0 | constant **in this population**, not structurally |
| `funnel.pAccept` | 1.0 | same term, downstream |
| `features.graphAffinity` | 0.0 | declared stub, weight 0.0 |
| `funnel.exhaustion` | 0.0 | parked, explicit reactivation trigger |
| `funnel.exposureBoost` | 1.0 | inert in the simulator; mechanism unverified |
| `funnel.overflow` | 0.0 | inert in the simulator; mechanism unverified |

**None of the six was deleted, and the triage is the finding.**

`acceptLikelihood` is the interesting one. Under the §1.5 abort (ρ = 0) the
formula collapses to `clamp01(1 × (1 + pickiness × viewerDeviation))`, and it
measured **identically 1.0 across 3 seeds × 300 users × 60 days**. §F1 recorded
that the term clips; this shows that under the shipped constants it does not
merely clip, it is a no-op multiplier. That is the fourth and sharpest version of
that finding.

But it is constant *because every viewer deviation in this population is
non-negative*, not because the algebra forces it. A below-average-reputation
viewer in production yields `P_accept < 1`. **Deleting it would be deleting on a
simulator artifact** — the exact error recorded three times already in §D4, §E5
and §F1, and the fact that the deletion would have been convenient is the reason
to be strictest about it.

`exhaustion` and `graphAffinity` are parked with documented triggers, not dead.
`exposureBoost` and `overflow` are zero in a simulator whose join model is a
model; zero there is not zero in production.

**Net: the lossless simplification available here is empty, and that is the
result.** The ladder says the shipped ordering is already the optimum, and the
column audit says nothing can be removed from the logging without either losing
training data or trusting the simulator further than it has earned. The
simplification is not pending — it already happened, at v1.8, and this pass is
the confirmation.

### G0.5 — The primary metric, and the result that inverts the premise

§G0.3's optima were measured on `retentionAfterEmpty`. This runs the same
question on **host retention**, matched seeds, through the separation gate:

```bash
npx tsx scripts/sweep.ts --arms ranker_repaired,shipped --sizes 150,600 \
  --seeds 1,2,3,4,5,6,7,8,9,10,11,12 --proximity-weight 0.20 --csv w020.csv
npx tsx scripts/sweep.ts --arms ranker_repaired --sizes 150,600 \
  --seeds 1,2,3,4,5,6,7,8,9,10,11,12 --proximity-weight 0.65 --csv w065.csv
npx tsx scripts/podium.ts w020=w020.csv w065=w065.csv
```

`shipped` ignores `--proximity-weight` and came back bit-identical across both
invocations and the §G0.1 ladder (0.958 ±0.002, Gini 0.414 ±0.003), which is
what makes the cross-run comparison legitimate rather than convenient.

**N=600, host retention:**

```
 1  ranker_repaired @ w=0.65    0.968 ±0.003
 2  shipped                     0.958 ±0.002     gap 0.011, bar 0.007, 1.49x  SEPARATES
 3  ranker_repaired @ w=0.20    0.933 ±0.003     gap 0.024, bar 0.007, 3.32x  SEPARATES
```

Gini follows: 0.398 / 0.414 / 0.474. Zero-joiner posts 7.6% / 9.2% / 14.2%.
Hosts alive 63.8% / 58.9% / 50.9%.

**This inverts the premise of the whole exercise.** The finding that has governed
this repo since v1.5 — the ranker loses to simple proximity ordering — is
reproduced exactly at `w = 0.20` (3.32×, decisive). Raise the single weight to
0.65 and the same ranker, unchanged in every other respect, **beats the shipped
configuration on both primary metrics.** The 28-point retention swing and the
76-point Gini swing come from one constant.

So "the ranker is worse than nearest-first" may never have been a fact about the
ranker. It looks like a fact about `w_proximity = 0.20`.

### G0.6 — Why this is NOT being acted on

Every reason below was written down before this result existed. None was
invented to explain it away, which is the only thing that makes them worth
anything now.

1. **It favours the ranker, and the standing rule discounts exactly that.** The
   simulator was authored alongside the ranker it is now vindicating. Every
   negative result in this file got believed *because* it was against interest;
   a positive one does not get to skip the discount that bought the negatives
   their credibility. §G0.1's outside replication is worth more than this
   precisely because nobody here wrote it.
2. **Setting it would be tuning a constant to improve a metric.** The prohibition
   is not general fastidiousness — `collapsed.pJoin.proximity` carries a comment
   refusing this exact move for this exact parameter, on the grounds that the
   primary metric did not distinguish the candidates. It distinguishes them now,
   which changes the evidence and not the rule.
3. **The optimum is not stable.** §D4 named 0.10 (N=150) and 0.30 (N=600) from
   these same seeds pre-abort; §G0.3 names 0.70 and 0.65 post-abort. A maximum
   that relocates by 0.6 when two unrelated constants move is not a maximum, and
   §D4 is on record as having already been fooled once by a maximum over noisy
   points.
4. **It does not separate at beta scale.** At N=150 `ranker_repaired @ 0.65` and
   `shipped` are a TIE (0.30×). The beta is ~40 users, where §G0.1 could not
   separate five arms from each other at all. Nothing here licenses a change to
   what launches.
5. **`RANKER_ENABLED` is false, so `w_proximity` orders nothing that ships.**
   Acting on this would mean un-shelving the ranker on simulator evidence — the
   decision the instrumentation exists to make with real data instead.

**What it does change:** the shelved ranker can no longer be described as
"measured worse than proximity ordering". The honest statement is that it is
measured worse *at its current proximity weight*, and materially better at a
higher one, in a simulator that cannot be trusted to favour it. That belongs in
the handoff as the first hypothesis to test against live `ranking_events` data —
where `score_snapshot` already logs every feature needed to fit it, which is what
the shelving architecture was for.

It also partly vindicates the externally supplied constants file: raising
proximity to 0.50/0.55 was the right direction. It "only closed part of the gap"
because it stopped short of the range where the effect lands, and kept the funnel
(§G0.1: `ranker_no_funnel` beats `ranker_repaired` at the default weight).

### G0.7 — The external writeup, read properly, and the confound it exposes

The writeup behind §G0 arrived after §G0.6 was written. It is dated Aug 8 2026,
titled *tandem-ranking weight tuning*, and reports variants A–D against
`proximity_only`.

**Its third caveat is the most valuable single observation in this entire file,
and it invalidates a result of mine.**

> *the sim's hidden join model is affinity × distance only, which hands
> proximity_only a home-field advantage worth an unknown share of the residual.*

Verified in `scripts/population.ts`:

```js
const relevance      = affinity * distanceFactor;        // joinDecision()
const distanceFactor = Math.exp(-miles / 3);             // MODEL.distanceTauMiles
```

and the ranker's own feature, `features.ts`:

```js
proximity = Math.exp(-miles / 4);                        // proximityDecayMiles
```

`exp(-m/4) === exp(-m/3)^0.75`. **The ranker's proximity feature is a monotone
power transform of a multiplicative term inside the simulator's join
probability.** Distance is not something the simulator measures the ranker
against; it is half of how the simulator decides a join happened.

#### What this does to §G0.5

§G0.5 reported that `ranker_repaired @ w=0.65` beats `shipped` on host retention
at N=600, separated at 1.49×, and called it an inversion of the repo's governing
premise. **That reading does not survive this.**

Raising `w_proximity` moves the ranker's score toward a monotone transform of a
factor in the sim's own join function. More joins follow, then fewer empty posts,
then higher host retention. The causal chain runs through the generative model
rather than through anything about ranking, and the effect size is inflated by an
unknown amount.

**The honest verdict: this harness cannot answer the proximity-weight question at
all.** A proximity sweep here measures how closely the ranker approximates the
simulator's join function. That retroactively applies to §D4 and §G0.3 as much as
to §G0.5 — the entire proximity-sweep line of work is measuring the harness.

What survives, because it runs the other way: `proximity_only` still places
FOURTH on host retention (§G0.1) *despite* holding the home-field advantage. An
arm that is handed the answer key and still loses the primary metric is a
stronger result than it looked, not a weaker one. The allocation failure —
20% zero-joiner posts, 41.3% of hosts alive — is large enough to overcome a
built-in advantage.

§G0.6 listed five reasons not to act on §G0.5. This is a sixth, it is
disqualifying rather than cautionary, and it was supplied by the person whose
result §G0.5 appeared to vindicate.

#### What their table actually measured

| their setup | consequence |
|---|---|
| metric is **repeat rate** | the metric `proximity_only` wins by construction (§G0.1). Their whole table is on the ratio that can be won by shrinking the denominator; host retention is not reported |
| **3 seeds** | §D4 is on record that this harness returns confident wrong answers at three seeds — seed spread at *fixed* `w` reached 0.051 against an across-`w` range of 0.108. §G0 used 12 |
| arms `full_ranker_fixed`, `regime_adaptive` | **both deleted in v1.8 §2**, because collapsing the density pairs made them the same configuration. They are running a pre-v1.8 checkout, which also explains why the accompanying constants file is a pre-v1.8 fork |

So the headline "-24%/-34% baseline, -15%/-21% tuned" is a repeat-rate gap, at
three seeds, on a superseded build. All three independently soften it, and §G0.1
shows the sign flips on the primary metric.

#### What they got right, and it is a lot

1. **The home-field caveat above.** Nobody in this repo had stated it, it is
   correct, and it disqualifies a finding this repo had just produced in its own
   favour.
2. **"Do not paste them into production as truth; use them as the shadow-mode
   starting point and let `ranking_events` data refit them."** Exactly the
   architecture already built — `score_snapshot` exists for precisely this.
3. **"`fresh_host = 0` and `exploreEpsilon = 0` are correct in a world with no
   host churn payoff and should NOT be shipped as-is... Ship them small, not
   zero."** Correct, and the current repo already agrees: `quotas.fresh_host` is
   `0.10` and `exploreEpsilon` is `0.15`. Their variant B/D zeroed both; the
   caveat corrects their own file.
4. **Their finding #3** — that pinning the regime beat the adaptive column under
   a proximity-heavy configuration — is a rediscovery of v1.8 §2, which collapsed
   the density pairs for this reason. Already actioned; their build predates it.

The one thing to send back: the gap they measured is real but it is a repeat-rate
gap, and repeat rate is the metric the pool-shrinking algorithm wins by
definition. The same ladder on host retention puts `proximity_only` fourth.
