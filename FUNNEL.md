# FUNNEL

The v1.8 repair of the defect v1.7 §D3 measured, and what the measurement says
about it.

**Headline, up front: the repair works in shape and fails at its shipped
setting — and it fails harder than the Gini bar alone conveys.**

At ρ = 0.5 the host-attention Gini is 0.821, above the ~0.75 bar set for "the
repair failed and the terms should be dropped rather than repaired". Worse:
**`ranker_repaired` still loses to `random` on host retention at every N ≥ 150**,
which was the v1.7 §D3 guard condition. At N=600 it is the *worst of the five
arms* on the primary metric, below `random`.

The dose–response says why, and points at a configuration that is neither "drop
it" nor "keep it as shipped". At ρ = 0 the same ranker beats `random`
comfortably (0.922 vs 0.865 at N=300). **The entire residual failure is
attributable to the host term surviving as a main effect.** Details in §4.

Nothing here has been tuned. Every number came from `RankOptions.paramsOverride`
and every constant is where it was before the diagnostics ran.

---

## 1. The defect, stated so the fix follows from it

A ranker in a two-sided marketplace does two jobs:

| | |
|---|---|
| **relevance** | which of these is best *for this viewer* — per-viewer |
| **allocation** | who gets seen at all, across all viewers — population-level |

A product of per-viewer scores can only do the first. Any factor in that product
whose value does not depend on the viewer performs allocation **as an invisible
side effect** — every client independently sorts the same items upward, because
every client was handed the same preference order.

`P_accept`, `P_complete` and `repeatableContext` were viewer-independent. The
consequence, measured: Gini 0.931, losing to `random` on host retention, and
**deck relevance *lower* than with the terms removed** (0.094 vs 0.128). That
last part is what settles it. It was never a fairness-versus-relevance trade;
the terms were displacing wanted cards *and* concentrating attention at once.

### Where it came from

The funnel is borrowed from dating-app ranking, where `P_accept` is genuinely
two-sided: does *this* person accept *you*. In Tandem it collapsed to
`hostReliability` — one global scalar per host — while keeping the architecture
that two-sidedness had justified. What was left is a popularity multiplier
wearing a two-sided model's clothes.

So the repair is not deletion. It is restoring the viewer-dependence that made
the term valid, and reclassifying what genuinely cannot be made viewer-dependent.

---

## 2. The score, before and after

**Before (v1.7):**

```
S = P_join(viewer)
  × P_accept          = hostReliability(host) × (verified ? 1.05 : 1)
  × P_complete        = 0.7·completionPrior(host) + 0.3·freshness(post)
  × R_repeat          = 1 + 0.25·repeatableContext(category) + 0.25·rhythmOverlap(pair)
  × exposureBoost
  × demandMultiplier
```

Three of the five factors are viewer-independent quality terms.

**After (v1.8):**

```
S = P_join(viewer)
  × P_accept          = hostRank^ρ × (1 + pickiness · viewerDeviation(viewer, host))
                        where pickiness = 1 − hostRank
  × R_repeat          = 1 + w·rank(repeatableContext)^δ + 0.25·rhythmOverlap(pair)
  × exposureBoost
  × demandMultiplier

ordered by:  (P_complete ≥ completionFloor) DESC, S DESC, activityId ASC
```

`P_complete` left the product entirely and became an ordering key.

---

## 3. The classification table

| term | class | how it reaches the deck |
|---|---|---|
| `categoryAffinity` | per-viewer | summed in P_join |
| `intentMatch` | per-viewer | summed in P_join |
| `proximity` | per-viewer | summed in P_join |
| `timeFit` | per-viewer | summed in P_join |
| `socialContext` | pairwise | summed in P_join |
| `rhythmOverlap` | pairwise | multiplier, via `R_repeat` |
| `graphAffinity` | pairwise | stub, weight 0 |
| `acceptLikelihood` | **pairwise** *(was global-quality)* | multiplier |
| `hostReliability` | global-quality | **only inside** `acceptLikelihood` |
| `completionPrior` | global-quality | **gate** |
| `freshness` | global-quality | **gate** |
| `repeatableContext` | global-quality | logged only |
| `repeatableContextRank` | global-quality | **dampened multiplicand** (provisional) |
| `exposureBoost` | global-allocation | multiplier — allowed |
| `demandMultiplier` | global-allocation | multiplier — allowed |

### Why four classes and not three

`exposureBoost` and the demand terms are viewer-independent too, and they are
fine. They *are* the allocation job, done on purpose, by terms whose entire
content is population state. Banning them would ban the only machinery that
pushes back on concentration.

So the rule is **no global *quality* multipliers**. A global term ranking items
by how good they are is the defect; one ranking them by how under-served they
are is the corrective. Opposites.

### Enforcement

`score.ts` declares `MULTIPLICATIVE_LEAVES` — the *leaf* terms in the product,
not the composites, because a composite hides what it is made of and hiding is
how `completionPrior` became a global quality multiplier without anyone choosing
that. `assertNoGlobalQualityMultipliers` runs at module load and the count is
now zero, so the guard is **armed**: a future edit that multiplies in a quality
score crashes on import.

Four declared routes to the deck, each stating its own justification:

| list | admits | why it is safe |
|---|---|---|
| `PJOIN_SUMMANDS` | per-viewer, pairwise | a weighted **sum** of per-viewer terms is per-viewer |
| `MULTIPLICATIVE_LEAVES` | per-viewer, pairwise, global-**allocation** | no consensus, or consensus that spreads |
| `GATE_TERMS` | global-quality | a **sort key** cannot compound |
| `DAMPENED_MULTIPLICANDS` | global-quality, rank-normalised, exponent < 1 | **provisional — see §5** |

---

## 4. ρ — the measurement that decides whether §1.2 is the right repair

`P_accept = hostRank^ρ × (1 + pickiness · viewerDeviation)`.

ρ = 0 flattens the host term entirely; ρ = 1 is the raw rank. N=300, six seeds,
via `--rho`:

| ρ | host retention | repeat rate | tandems/user | zero-joiner | hosts alive | **Gini** | deck relevance |
|---:|---:|---:|---:|---:|---:|---:|---:|
| **0.00** | **0.922** | 0.409 | 13.98 | **16.7%** | **46.4%** | **0.511** | **0.117** |
| 0.25 | 0.881 | 0.452 | 14.91 | 24.0% | 30.7% | 0.719 | 0.111 |
| **0.50** *(shipped)* | 0.848 | 0.474 | 15.04 | 32.9% | 19.3% | **0.821** | 0.104 |
| 0.75 | 0.823 | 0.493 | 14.39 | 39.4% | 13.1% | 0.874 | 0.097 |
| 1.00 | 0.814 | 0.475 | 13.42 | 43.9% | 11.1% | 0.892 | 0.091 |

**Monotone on five metrics simultaneously**, every one favouring ρ = 0. Repeat
rate is the lone dissenter, peaking at ρ = 0.75 — the same split v1.7 §D3 found,
where the funnel bought repeat rate and paid for it in concentration.

### The verdict, against the stated criterion

> *"If Gini stays above ~0.75, the repair failed and the terms should be dropped
> rather than repaired."*

At the shipped ρ = 0.5, **Gini is 0.821. By that criterion the repair failed.**

> **v1.9, 24 seeds, N=600:** 0.840 ±0.001 — confirmed, and not marginal. After
> the abort (ρ = 0) the same arm measures **0.464 ±0.002**, a 92.9× separation
> on matched seeds. Host retention goes 0.843 → 0.939 (12.4×), zero-joiner posts
> 33.3% → 12.9%, surviving hosts 16.6% → 52.8%, and deck relevance *rises*
> 0.114 → 0.128. Five of the seven arms are byte-identical across the two runs,
> which is what makes that a measurement. See DIAGNOSTICS.md §F4.
>
> The abort worked. What it bought, precisely: the arm now clears `random`
> decisively (11.9×) where it previously lost to it, and clears the 0.75 Gini
> ceiling — but it is **statistically tied with `proximity_only` on retention**
> (0.92×) while beating it on Gini by 13.7×. Against the taste-blind baseline
> the ranker currently buys no measurable retention and a materially better
> distribution. That is a narrower claim than "the ranker works", and it is the
> one the data supports.

### But it fails informatively, and "drop it" is not what the data says

ρ = 0 does **not** delete `hostReliability`. It removes it as a **main effect**
while `pickiness = 1 − hostRank` retains it as an **interaction**. The
configuration the data points at is:

> A host's accept rate determines **how much your record matters to them**, and
> never makes their card better or worse on its own.

Which is exactly what §3's classification predicts. A main effect of a
host-only quantity is global-quality. An interaction between a host-only
quantity and a viewer-dependent one is pairwise.

> ### ⚠️ v1.9 CORRECTION — the paragraph above is half wrong
>
> The interaction does **not** fully survive at ρ = 0, and I did not check
> before writing that it did. `tests/accept.test.ts` caught it when the abort
> was executed and the assertions failed.
>
> ```
> P_accept = clamp01( rank^ρ × (1 + pickiness × deviation) )
> ```
>
> At ρ = 0 the first factor is exactly **1** — the ceiling. So any *positive*
> viewer deviation multiplies 1 by something greater than 1 and is clipped
> straight back to 1 by `clamp01`. Measured:
>
> | | raw | after clamp |
> |---|---:|---:|
> | ρ=0, category-matching viewer | 1.180 | **1.000** |
> | ρ=0, neutral viewer | 1.000 | **1.000** |
> | ρ=0.25, category-matching | 0.664 | 0.664 |
> | ρ=0.25, neutral | 0.562 | 0.562 |
>
> So ρ = 0 keeps the interaction **only on the downside**. It can penalise a
> poor record; it cannot reward a good one, and every above-neutral viewer is
> indistinguishable from every other for every host. The classification's
> prediction is *directionally* vindicated — the main effect was the harmful
> part — but the claim that the pairwise half "survives at ρ = 0" is false as
> stated, and it was the more flattering of the two readings.
>
> **Left at 0 regardless**, because 0 is the value the sweep *measured*: the
> clipping was inside the arm that scored 0.922 retention. Removing the clip
> would be a new functional form with no measurement behind it, introduced
> under an abort. Whether the un-clipped form beats this one is **UNMEASURED**
> and is §8's first item.
>
> ### ⚠️ v1.9.1 — sharper again. It is not "clipped on the upside", it is a no-op.
>
> The column audit (`scripts/deadcolumns.ts`, DIAGNOSTICS §G0.4) logged every
> feature over 3 seeds × 300 users × 60 days and found `acceptLikelihood`
> **identically 1.0 on every single impression.** Not mostly, not above
> neutral — every one.
>
> So under the shipped constants P_accept is not a damped term or a
> downside-only term. It is a **multiplication by 1**: it contributes nothing
> to the ordering and logs a column of 1s into the training set. Each pass has
> made this finding worse — the term "survives at ρ=0" (wrong), then "works
> only downward" (v1.9, right but weaker than the truth), now "does not work at
> all in this population".
>
> **Still not deleted**, and the reason is the one that matters: it is constant
> because every viewer deviation in the *simulated* population is non-negative,
> not because the algebra forces it. `clamp01(1 × (1 + pickiness × deviation))`
> is genuinely below 1 for a below-average-reputation viewer, and production
> will have those. Deleting on this evidence would be deleting a live term on a
> simulator artifact — §D4, §E5 and §F1 are three recorded instances of exactly
> that error, and the fact that deletion would have been the convenient outcome
> here is the reason to refuse it.
>
> What this *does* settle: it raises §8's first item from "worth measuring" to
> the single highest-value experiment on the list, because the term is
> currently contributing nothing at all.

**Acted on as of v1.9.** `hostAcceptDamping` is now `0`. This is not tuning: it
is the pre-committed response to a pre-registered criterion that fired at
0.842 ±0.002 against a 0.75 threshold. The distinction that matters — and the
discipline only survives if it is stated — is that a parameter moved because a
*rule agreed in advance* said to move it, not because moving it improved a
number. `repeatableContextWeight` is `0` on the same basis: §1.4 pre-committed
to running it both ways, §3.4 ran it, and nothing separated.

What is still **not** acted on is `demandWeight`, which has no pre-registration
behind it and is the parameter most contaminated by the population model. See
§7.

---

## 5. `repeatableContext` — kept vs dropped

N=300, six seeds, via `--repeatable-context`:

| weight | retention | retention after empty | repeat rate | tandems/user | zero-joiner | hosts alive | Gini | relevance |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 0.25 *(kept)* | 0.848 | 0.763 | 0.474 | 15.04 | 32.9% | 19.3% | 0.821 | 0.104 |
| 0.00 *(dropped)* | 0.855 | 0.763 | 0.471 | 14.77 | 32.2% | 19.3% | 0.817 | 0.104 |

**Indistinguishable on every metric.** Retention differs by 0.007, Gini by
0.004, relevance not at all.

The term buys nothing measurable and costs a `global_quality` entry in the
classification — which is not free, because `DAMPENED_MULTIPLICANDS` is the one
route to the deck whose safety argument is "less of a bad thing" rather than
"not a bad thing".

**Recommendation: drop it.** `repeatableContextWeight: 0`, which empties
`DAMPENED_MULTIPLICANDS` and removes the provisional category entirely.

Worth naming what is being given up. `repeatableContext` is the most
product-shaping constant in the system — it is what makes a Tuesday study
session outrank a Saturday concert, and the strategic bet that habit beats
excitement for friendship formation. That bet may well be right. What this says
is only that **as a dampened global multiplier it does not express the bet**:
three distinct values across fourteen categories, rank-normalised and raised to
0.5, moves nothing. If the bet is worth making it should be made somewhere that
can carry it — `CATEGORY_REPEATABILITY` feeding retrieval, or the interest
model's source weights — not as a rounding error on a multiplier.

**Not acted on**, same reason as §4.

---

## 6. The relevance question §1.5 asked

> *"The repaired funnel should recover most of the relevance gain that removing
> the global terms produced (0.094 → 0.128) without the Gini blowup."*

| configuration | Gini | deck relevance | retention | beats `random`? |
|---|---:|---:|---:|---|
| v1.7 funnel, unrepaired *(from §D3, N=300)* | 0.884 | 0.094 | 0.824 | ❌ |
| **v1.8 repaired, ρ = 0.5** | **0.821** | **0.104** | **0.848** | ❌ |
| v1.8 repaired, ρ = 0 | 0.511 | 0.117 | 0.922 | ✅ |
| no funnel at all *(ablation, N=300)* | 0.475 | 0.127 | 0.933 | ✅ |
| `random` *(the floor)* | 0.643 | 0.056 | 0.865 | — |

At the shipped setting the repair recovers **29% of the relevance gain** (0.094
→ 0.104 of a possible 0.094 → 0.128) and **19% of the Gini reduction** (0.884 →
0.821 of a possible 0.884 → 0.484). That is not "most", and it is the arithmetic
behind the §4 verdict.

At ρ = 0 it recovers **68% of the relevance** and **93% of the Gini**, which is
close enough to the no-funnel ablation to say that what remains of the funnel at
that setting is nearly free.

The `beats random?` column is the one that matters most. Crossing from ❌ to ✅
happens between ρ = 0.5 and ρ = 0, and nothing else about the configuration
changes across that boundary — same features, same weights, same gate, same
pickiness interaction. **The host term surviving as a main effect is the whole
of the remaining failure.**

---

## 7. How much to believe this

Standing caveat, restated because it has not stopped applying:

> The simulator was authored alongside the ranker it evaluates, so results
> **favouring** the ranker are weak evidence and results **against** it are
> strong evidence.

Everything decisive above is against the ranker: the repair underperforming its
own criterion, the dose–response favouring the flattest possible host term, and
`repeatableContext` measuring as inert. Those are the strong-evidence direction.

The one result that would favour the ranker — repeat rate peaking at ρ = 0.75 —
is the weak-evidence direction and is also a single metric moving against five
others. It is reported, and it is not the basis for anything.

### ⚠️ v1.9 — the strongest caveat is the one about `demandWeight`

Every table above reports a simulator number. Two of them are load-bearing in a
way the rest are not, and the difference is worth being precise about.

The Gini and dose–response results are **structural**: they follow from the
arithmetic of a per-viewer product containing a viewer-independent factor, and
they would come out the same under a wide range of population assumptions.
Concentration is manufactured by the score, not by the model of how people
respond to it.

The **magnitude** of ablation C's win is not structural. It is close to a
mechanical restatement of one authored constant:

```
population.ts:  churnPerEmptyPost   0.18     ← invented
                churnCompounding    1.6      ← invented
```

`demandWeight` boosts under-filled posts. The benefit of doing so is the churn
it averts. The churn it averts is `churnPerEmptyPost`. Sweeping `demandWeight`
against this population model is therefore close to asking the model to restate
its own assumption back as a finding, and "5× the shipped weight is best" should
be read in exactly that light.

What *is* robust is the **direction**: demand balancing helped in every
configuration tested, across funnel-on and funnel-off arms. That is a much
weaker claim and it rests on much less.

`sql/churn_per_empty_post.sql` measures the constant. Until it returns
something, `demandWeight` should move modestly if at all, and 0.5 is a
hypothesis rather than a setting.

One caveat specific to v1.8: **the pre-repair funnel is not reachable through
`paramsOverride`.** §1.3 removed `P_complete` from the product structurally and
§1.2 rewrote `P_accept`'s shape, so no parameter setting reconstructs v1.7's
arithmetic. The comparison in §6 against the unrepaired funnel is made against
numbers recorded in `DIAGNOSTICS.md` §D3 — same frozen population model, same
seeds, and (at regime 1) the same parameter values the §2 collapse now uses.
Directly comparable, but from a different run, and that is a claim doing real
work rather than an aside.

---

## 8. What would settle it properly

The whole of the above is simulation. The instrumentation shipped in v1.7 exists
precisely so that these questions stop needing a simulator:

0. **Re-run ρ against an un-clipped `P_accept`.** *(v1.9, new, and first because
   it is cheap and it is a known defect rather than an open question.)* At ρ = 0
   the term pins at the ceiling and the upside interaction is clipped away — see
   the correction in §4. The dose–response therefore compared "ρ = 0.5 with a
   working two-sided term" against "ρ = 0 with a one-sided one", and attributed
   the whole difference to ρ. Give the deviation factor headroom below 1 — e.g.
   normalise by `1 + pickiness × deviationCeiling` so the maximum is attainable
   rather than clipped — and re-run. If ρ = 0 still wins, the finding is clean.
   If it does not, the abort was right about the main effect and wrong about the
   magnitude, and that is worth knowing before any of this reaches a fit.
1. **Measure `churnPerEmptyPost`.** `sql/churn_per_empty_post.sql`. It
   is the single load-bearing assumption behind every demand-balancing number
   here, it is currently invented, and it is measurable *today* on live data —
   noisily, but empirically. Read the Wilson interval, not the point estimate.
2. **Fit `P_accept` from real labels.** `ranking_events` records every feature at
   impression time plus the `accept`/`decline` outcome. One logistic regression
   answers whether `hostReliability` predicts acceptance at all once viewer
   reputation and category familiarity are in the model — which is the question
   ρ is a proxy for.
3. **Watch the production Gini.** `supabase/analysis/concentration.sql`, leading
   with the zero-impression host count. The simulator's absolute values do not
   transfer; the *ordering* of the configurations should.
4. **Then set ρ.** From the fit, not from this table.

> **Sequencing note.** Items 2–4 need `ranking_events` to fill up, and the
> instrumentation must not start filling it until the `loadCandidates` spatial
> bug is fixed and deployed (PERF.md §1, fixed in v1.9). Impressions logged from
> a candidate set selected by *time* rather than *distance* carry no marker
> distinguishing them from correct ones, so they would contaminate the training
> data at the source — and the whole point of instrumentation-first is that this
> data is the thing worth waiting a quarter for.
