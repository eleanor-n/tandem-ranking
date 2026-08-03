# INFERENCES

**`tandem-matching-v2-framework.md` was not available when this was built.**

The only spec I had was `tandem-matching-algorithm-v1.md` (9pp), whose section
numbering does not match the v2 references in the build prompt — v1 has §5
exposure rules, §7 instrumentation, §10 open calls; the prompt cites §1.1–1.7,
§3.1, §3.3, §4, §5. The v1 document's "Siddhant Ideas" section (rank metrics by
mention frequency → coefficients → compare between people; contact graph; three
degrees of separation) is clearly the seed of the v2 interest model, but it is a
sketch, not a spec.

So: everything the prompt specified directly was built to spec. Everything only
v2 would have contained was **reconstructed**, and every reconstruction is a
numbered claim below. Diff this against the real document.

Numbers taken directly from v1 are marked `[v1]` in `constants.ts` and are not
listed here.

---

## A. Structural inferences — the shape of the model

### A1. The interest vector is keyed by metric slug, and metrics ⊇ categories

The prompt's `recordExplicitStatement(userId, metric, polarity)` takes a
"resolved metric slug", and §1.2 is described as a *source* table rather than a
*category* table — so "metric" is a broader taxonomy than the activity category.
I made `MetricSlug` a free string, gave `Candidate` a `metrics: MetricSlug[]`
that defaults to `[category]`, and namespaced non-category metrics (`intent:routine`).

**Risk if wrong:** low. If v2 defines a closed metric enum, tighten the type and
the mapping tables; nothing else changes.

### A2. `interest` and `salience` are separate quantities

This is the largest structural invention, and it came from a conflict between two
stated requirements:

- §1.3 saturation must make the 40th event nearly worthless, and
- the novelty test requires 2 events from 5 days ago to **outrank** 40 events
  spread over 200 days.

Those cannot both hold for a single scalar without the novelty term dominating
saturation so hard that `interest` stops meaning "how much evidence is there".
So there are two:

```
interest = clamp(sat(pos) − negScale·sat(neg), 0, 1)   pure evidence strength
novelty  = recency × underExploration                  exploration bonus
salience = interest × (1 + noveltyBoost × novelty)      what actually orders
```

`categoryAffinity` and retrieval read `salience`. The explanation layer reads
`interest`, so "you keep saying yes to coffee" is never said on the strength of
a novelty bonus.

**Risk if wrong:** medium. If v2 defines one scalar, collapse `salience` into
`interest` and re-derive `noveltyBoost` — but then one of the two stated tests
has to give, and that is a conversation, not a refactor.

### A3. The novelty term is `recency × underExploration`

v2 says "novelty prior" and nothing more that I have. I made it
`exp(−meanAge/τ) × k/(n+k)` — an optimism-under-uncertainty bonus in the UCB
sense, large exactly when there is a fresh hint and not enough data to trust it.

The alternative reading — novelty as pure recency — fails the stated test: 40
events spread over 200 days include ~3 in the last two weeks, which is *more*
recent activity than 2 events from 5 days ago. Only the under-exploration factor
produces the specified ordering.

### A4. Retrieval sources and quotas

Not specified beyond "source quotas". I chose `affinity 4 / proximity 2 /
fresh_host 1 / random 1 / graph 0` per deck of 8, with unfilled quota
redistributed to `[affinity, proximity, random]`.

Reasoning: `fresh_host` and `random` get one slot each because v1 §5 mandates
both a new-host slot and explore, and at 40 users the doc explicitly says explore
should arguably be *more* aggressive. `proximity` gets a taste-blind 2 because
it is the cold-start path and the escape hatch from a badly-fitted vector.

### A5. `expand` events are stored with weight 0

The prompt says "emit the events; don't consume them". Rather than special-case
them, `expand` is an ordinary row in the source table with `weight: 0.0` and a
comment saying to raise it to ~0.15 when data exists. Zero-magnitude events are
dropped before the fold entirely, so they cannot inflate `eventCount` and
suppress the novelty bonus for a signal the model is not using.

### A6. Slate constraints beyond the two stated

The prompt states ≤2 same-category per 8 and ≥1 `fresh_host` in the top 3. I
added `maxPerHost: 1` (a deck showing one host three times reads as broken) and
a **relaxation ladder**: constraints are given up one at a time, in
`CONSTANTS.slate.relaxationOrder`, rather than all at once.

The ladder is load-bearing. The naive version (put the skipped cards back) gives
up every cap simultaneously, so a pool short on *hosts* also loses its *category*
limit and the deck comes back as six coffees. This was caught by the stated
"≤2 same-category" test failing on a twelve-post, seven-host fixture.

### A7. Explicit statements are uniquely keyed on `(user, metric)`

§1.7 says "structured and reversible… listable and deletable". I added a partial
unique index so re-stating overwrites rather than stacks — otherwise tapping
"I'm into this" twice doubles your own weight.

---

## B. Constants I chose a value for

| Constant | Value | Why this number |
|---|---|---|
| `saturationK` | **2.0** | Evidence needed to reach interest 0.5. Derived from the stated test: the 40th event must move interest <1% of what the 1st did. That requires `k(1+k)/((40+k)(39+k)) < 0.01`, i.e. **k < 3.5**. Within that ceiling I took the low end, because at 40 users nobody has many events and a high `k` leaves everyone at interest ≈ 0. At k=2 the ratio is 0.35%. **Raise it** as the population's event counts grow. |
| `noveltyBoost` | **2.5** | The anti-homophily dial. Derived, not guessed: making 2 events at 5 days beat 40 events over 200 days requires β > ~2.0 given k=2. I took 2.5 for margin. **This is the number I trust least** — it is set by a single stated example, and it is the difference between a feed that explores and one that collapses onto one category. First thing to A/B. |
| `noveltyRecencyTauDays` | **30** | Novelty half-fades in ~21 days. Matches the v1 behavioural half-life of 30 days, so "recent" means the same thing in both halves of the model. |
| `negativeEvidenceScale` | **0.7** | How hard a `checkin_no` pushes back. Below 1 deliberately: one bad tandem is usually about the *person*, not the *activity*, and letting a single no bury a category is how you teach people not to answer the check-in honestly. |
| `sources.checkin_yes` | **w 1.2 / hl 120d** | v1 §7 calls this "the single most predictive signal for the entire system". So it is the only source above weight 1.0 and has the longest behavioural half-life. |
| `sources.tandem_completed` | **w 1.0 / hl 90d** | You actually went. The reference point the others are scaled against. |
| `sources.explicit_statement` | **w 1.0 / hl 180d** | Weight fixed at 1.0 by spec. Half-life chosen long so a stated interest is not silently overruled by a month of not doing it. |
| `sources.post_created` | **w 0.8 / hl 60d** | **Deliberately above `join_requested`.** Authoring costs more than tapping — you did the work of proposing it. This is also the closest thing v1.5 has to the `desired` side of the §1.5 split, which is why it survives the split being deferred. |
| `sources.join_accepted` | **w 0.7 / hl 60d** | Committed, not yet proof you showed up. |
| `sources.onboarding` | **w 0.6 / hl 365d** | The cold-start backbone. Long half-life so a new user is not stranded; moderate weight so three tap answers cannot outvote real behaviour once it exists. |
| `sources.join_requested` | **w 0.5 / hl 45d** | Intent without consummation, and cheap to emit, so it fades fast. |
| `sources.checkin_no` | **w 0.8 / hl 90d** | Lighter than `checkin_yes`. See `negativeEvidenceScale`. |
| `sources.expand` | **w 0.0 / hl 21d** | Zero by instruction. See A5. |
| `cacheMaxAgeMinutes` | **60** | A cached interest state goes stale on wall-clock alone, because decay is time-dependent. An hour is short enough that decay drift is invisible and long enough that a normal session recomputes once. |
| `retrieval.overFetchFactor` | **3** | Retrieve 24 for a deck of 8, so slate repair has spares. Free at beta scale. |
| `retrieval.affinityMetricDepth` | **5** | How many top metrics affinity retrieval considers. Deeper starts pulling in noise from a thin vector. |
| `slate.deckSize` | **8** | Taken from the prompt's own test ("a deck of 8"). |
| `slate.maxPerHost` | **1** | See A6. |
| `explain.minStrength` | **0.15** | Below this a card shows the canned category line. **Err upward.** A wrong reason line is worse than a generic one — it tells the user the system does not know them, in a way they can catch. |
| `explain.priority` | see file | Ordered by how *checkable* the claim is, not how strong. A shared onboarding answer at strength 0.6 beats a proximity line at 0.9, because the user typed the first one themselves. |
| `features.thinDataDefault` | **0.5** | v1 says every behavioural feature defaults to 0.5. Applied uniformly. |
| `ADJACENT_BUCKET_CREDIT` | **0.5** | Partial credit for a neighbouring time bucket. "Usually a morning person" should not hard-reject a midday thing. |
| `verifiedViewerBoost` | **1.05** | v1 gives hosts ×1.1 but is silent on viewers. Deliberately smaller: verification is an AWS Rekognition face check, and making it a large ranking lever turns identity into a growth funnel. |

---

## C. Copy changes I made on purpose

**`intent_match` no longer claims mutuality it cannot prove.** The v1 template is
`"you're both here for {intent}."` — but the feature compares the viewer's stated
intent against the **post's shape**, which is not the host having said anything.
A test caught this. There are now two variants, and the mutual one requires
`host.tandemIntent` to actually match:

```
mutual:     "you're both here for routine."
one-sided:  "routine — which is what you said you came for."
```

The same rule is applied to `ideal_saturday` (requires the host's answers) and
`rhythm` (requires real bucket history on both sides, never the 0.5 default).

---

## D. The simulator found something. It is not good news.

`npm run sim` builds a synthetic population with hidden preferences and runs the
ranker against `proximity`, `popularity` and `random` baselines.

```
seed 1/2/3, 40 users, 120 days — repeat rate vs baseline
  ✅ vs popularity   +52% / +59% / +54%
  ✅ vs random       +77% / +57% / +50%
  ⚠️  vs proximity   −14% / −13% /  −7%
```

**Pure nearest-first beats the full ranker on the north star, consistently.**
I could not tune it away: moving `proximity` from 0.20 → 0.35, or relaxing
`maxPerHost` 1 → 3, moved it by ~1 point each.

Two things are going on, and only one of them is the ranker's fault.

**The metric rewards concentration.** `repeats / completions` goes up when the
same people keep meeting. Proximity-only shows you your eight nearest neighbours
forever, so re-collision is guaranteed. The ranker deliberately spends ~2 of 8
slots on fresh hosts and explore. An earlier version of the simulator had no
*bond* term at all — no "you had a good time with someone so you say yes to them
next time" — and on that version proximity won by 25%. Adding the mechanic the
product is actually premised on cut the gap in half. **I changed the simulator
after seeing a result I did not like; that is worth knowing when you read these
numbers.** Both figures are above.

**The simulator does not model supply churn.** Hosts never stop posting. So the
fresh-host slot and the impression floor — the two rules whose entire purpose is
keeping hosts from giving up — have *zero* payoff in-sim and pure cost. v1 §5 is
explicit that this is what kills the flywheel, and the simulator cannot see it.
This is the single biggest reason not to act on the proximity result yet.

**What I would do before believing either side:** add host churn (a host with
<N impressions over M days stops posting) and re-run. If the ranker still loses,
the fairness rules are too expensive at 40 users and should scale with
population size. If it wins, the current numbers were an artefact.

**What I would not do:** ship proximity-only. It has no answer for the day the
pool gets big enough that the eight nearest posts are all wrong.

---

## E. Schema assumptions in the migration

The real schema was not available. The migration is defensive — `IF NOT EXISTS`
throughout, `DO` blocks that `RAISE NOTICE` and skip rather than fail — but two
things in the completion trigger are **guesses**, marked `[CONFIG]` in the file:

- participants live in `public.activity_participants(activity_id, user_id, status)`
- completion is `activities.status` transitioning to `'completed'`

Adapter column names are in one `COLUMNS` object at the top of
`adapter/supabase.ts`. Reconcile both before applying to anything real.


---
---

# v1.6 — Scale adaptation

Added by the v1.6 build. Same rule as above: the framework document was still
unavailable, so anything only it would have contained is a numbered claim here.

## F. New inferences

### F1. The hysteresis band applies to the regime scalar, not to coverage

§1.2 says the regime "may only move if the smoothed value crosses the current
regime value by more than 0.15". `0.15` is dimensionless, which fits the regime
scalar (bounded [0, 1]) and does not fit coverage (unbounded above — 0.15 of a
coverage of 8 means something different from 0.15 of a coverage of 1.5). I
implemented it on the scalar.

**Consequence worth knowing:** hysteresis leaves a permanent dead zone. The
emitted regime can sit up to one band away from what the smoothed coverage
implies, indefinitely. That is inherent to hysteresis, not a defect, and it is
bounded — accepted moves snap to the candidate rather than stepping by the band,
so the error never accumulates. Asserted in `regime.test.ts`.

### F2. `graphAffinity`'s city weight is declared as 0.0, not 0.15

§1.5 gives `w_graphAffinity` as 0.0 → 0.15 and then says "keep at 0 this build".
Declaring 0.15 and relying on the feature returning zero would be wrong, not
merely inert: the weight survives renormalisation, so P_join would max out at
0.85 for every user at city scale. Both ends are 0.0, with a comment saying to
set city to 0.15 **in the same commit that implements the feature**.

### F3. Retrieval quotas became fractions, and the affinity/proximity split is invented

v1.5 quotas were integers `{affinity 4, proximity 2, fresh_host 1, random 1}`.
They cannot interpolate continuously as integers, so they are now fractions of
the deck. §1.5 pins `fresh_host` and `random` at both ends; the remaining mass
had to be split. Village leans proximity (0.70/0.30) to match its P_join
weighting; city keeps v1.5's 2:1 affinity:proximity ratio (0.57/0.28).
**[GUESS]**

### F4. §4.1's "geographic density fixed" is implemented as geographic AREA fixed

Holding users-per-area fixed would grow the map with N, leaving each viewer's
local pool constant and coverage flat — which would make the sweep measure
nothing, contradicting the stated purpose ("so coverage rises with N as it would
in reality"). I hold the metro area fixed at 10x10 miles and let N densify it,
which is how an app actually grows inside a city.

### F5. `maxPerCategory` / `maxPerHost` are rounded, not floored

They are counts; a cap of 2.4 cards is not a thing. Rounding rather than
flooring so the midpoint of {8, 2} lands at 5 instead of collapsing early toward
the city value. This is the one legitimate discontinuity in the system, and the
continuity test exempts exactly these two parameters and no others.

### F6. The interest cache now carries a parameter fingerprint

Not in the spec, but forced by it. The interest vector depends on
`noveltyBoost`, which now moves with density, so a vector computed under one
regime is *wrong* under another rather than merely stale. Without the
fingerprint a user crossing the hysteresis band would keep serving an interest
vector built with the old novelty weighting until some unrelated event happened
to invalidate it.

### F7. `confirmedJoiners` is denormalised onto `activities`

Per the answer to the blocking question in §2.2. A trigger on `join_requests`
**recounts** rather than increments — an incrementing trigger drifts the first
time a row is updated twice, deleted, or backfilled, and a drifted demand signal
is worse than none because it silently boosts posts that are actually full.

`undefined` is treated as UNKNOWN, not as zero, throughout. If unknown read as
zero, every post whose joiner count failed to load would be boosted as if it
were desperately empty.

### F8. `repeatAffinity` is currently inert — a known temporary weakness

§3 gates exhaustion on `repeatAffinity`, sourced from the post-tandem check-in.
**Check-in data does not exist yet.** So in production today every pairing
returns the neutral 0.5 and exhaustion acts as a *uniform damper on all repeats*
— including the good ones, which are the north star.

This is a gap waiting on data, not a design choice, and it is the single most
important thing to fix once check-ins ship. Until then, exhaustion is actively
working against the metric the system is optimised for. The simulator models
this faithfully: it has a hidden pairwise compatibility whose only route to the
ranker is the check-in.

---

## G. The density sweep. The result is negative.

Four arms, frozen population model (committed at `b42810c`, before any arm ran),
six population sizes, three seeds, 120 simulated days. Full numbers in
`sweep-results.md` and `sweep-results.csv`.

```
N     coverage  regime   arm                 repeat  tandems/u  zero-joiner  hosts alive  Gini  relevance
20      0.51     0.00    regime_adaptive     0.479     3.40        50.2%       28.3%     0.622   0.053
                         proximity_only      0.526     4.07        53.4%       21.7%     0.574   0.057
40      0.69     0.00    regime_adaptive     0.562     9.05        32.7%       25.8%     0.712   0.065
                         proximity_only      0.561     9.59        34.0%       21.7%     0.638   0.073
80      1.33     0.10    regime_adaptive     0.444     8.71        30.3%       25.0%     0.734   0.071
                         proximity_only      0.583    12.71        29.1%       29.2%     0.593   0.096
150     2.38     0.38    regime_adaptive     0.425    11.10        30.4%       24.4%     0.793   0.084
                         proximity_only      0.648    17.79        22.6%       36.7%     0.565   0.129
300     3.85     0.65    regime_adaptive     0.424    12.75        40.6%       19.8%     0.876   0.093
                         proximity_only      0.647    20.08        20.5%       39.3%     0.548   0.153
600     6.40     0.86    regime_adaptive     0.419    13.24        51.4%       11.6%     0.930   0.098
                         proximity_only      0.651    20.90        20.4%       42.5%     0.525   0.173
```

### G1. What matched the prediction

**At N=40, `regime_adaptive` and `proximity_only` are within 0.2% on repeat
rate** (0.562 vs 0.561). That is the stated success criterion for village scale
— they are nearly the same algorithm there, and they behave like it. The
crossover finder puts the sign change at N≈39.

`regime_adaptive` also beats `full_ranker_fixed` on every liquidity metric at
every size: fewer zero-joiner posts (30.3% vs 36.9% at N=80; 40.6% vs 42.7% at
N=300), more surviving hosts, lower Gini. The §2 demand machinery does what it
claims relative to the unadapted ranker.

### G2. What did not

**`proximity_only` beats `regime_adaptive` by 24–36% on the north star at every
size from 80 upward, and the gap does not close as density rises.** It also wins
on tandems per user (20.9 vs 13.2 at N=600), zero-joiner rate (20.4% vs 51.4%),
surviving hosts (42.5% vs 11.6%) and Gini.

That last group is the damaging part. Those are the *village objective's own
metrics*. The entire justification for demand balancing, the fresh-host slot and
the impression floor is that they protect liquidity and keep hosts from
churning. In this simulation a ranker with none of that machinery protects both
better, because it generates so many more joins that more posts fill and fewer
hosts give up. **At these densities relevance IS liquidity**, and the fairness
machinery redistributes a smaller pie.

The second stated expectation — that `regime_adaptive` beats
`full_ranker_fixed` decisively at N≥300 — is only half met. It wins on liquidity
but not on repeat rate (0.424 vs 0.464 at N=300; 0.419 vs 0.415 at N=600, i.e.
a tie). The adaptation is not yet earning its complexity on the north star.

### G3. Decomposing the loss

I ran one diagnostic to find out *where* the gap comes from: the full ranker,
with all its slate/demand/exhaustion machinery, but with P_join forced to pure
proximity weights. At N=300, two seeds:

| arm | repeat rate | deck relevance |
|---|---:|---:|
| `regime_adaptive`, normal weights | 0.420 | 0.092 |
| `regime_adaptive`, P_join = pure proximity | 0.522 | 0.112 |
| `proximity_only` | 0.650 | 0.152 |

So the gap splits roughly **40% weights, 60% machinery**.

- **The weight half is substantially a simulator artefact.** The hidden join
  model uses only `affinity x distance` (times bond and exhaustion). `timeFit`,
  `intentMatch` and `socialContext` have *literally zero* predictive power in
  this world, and they carry ~35% of P_join. Any ranker that uses them is
  structurally penalised here. In reality they presumably matter; the simulator
  cannot say.
- **The machinery half is not.** Even with identical scoring weights, the ranker
  shows cards the hidden model wants 26% less. Diversity caps, the explore
  epsilon, the fresh-host slot and the funnel decomposition itself
  (`P_accept x P_complete x R_repeat`, which `proximity_only` ignores entirely)
  all displace nearer cards. That cost is real and it is not compensated in this
  model.

### G4. How much to believe this

**Weight it as strong evidence.** The v1.5 report noted that a simulator
authored alongside its ranker has correlated blind spots, so results favouring
the ranker are weak and results against it are strong. This result is against
the ranker, from a model that was frozen and committed before any arm ran, and
it reproduces across three seeds and six population sizes with a stable
magnitude.

The one genuine caveat cuts *toward* the ranker and is quantified above: the
simulator's user model is strictly simpler than the ranker's feature set, so
three of eleven features are guaranteed-negative in this world. That accounts
for about 40% of the gap and no more.

### G5. What I did not do

I did not tune. The spec said that if `regime_adaptive` loses to
`proximity_only` at N=40 by more than ~3%, report it rather than tuning until it
passes — it did not lose at N=40, it lost badly everywhere above it, and the
same instruction applies with more force. The village parameters are not the
problem; the parameters at moderate-to-high density are.

### G6. What I would do next, in order

1. **Raise the proximity weight across the whole continuum**, not just at
   village. The city column gives proximity 0.20 on the theory that selection
   matters more when there is more to select from. This sweep says the opposite
   at every density it can see. A city column nearer 0.35–0.40 is the single
   highest-value experiment.
2. **Price the machinery.** Run each of `maxPerHost`, `exploreEpsilon`,
   `fresh_host` quota and the demand terms individually against
   `proximity_only`, at N=300, and keep only the ones that pay for themselves.
   My prior after G3 is that the fresh-host slot and explore are net-negative at
   every density in this model, and that demand balancing is roughly neutral.
3. **Make the simulator reward timeFit and socialContext**, so the weight half
   of the gap becomes measurable rather than assumed. This changes the frozen
   model, so both sets of numbers get published — but it should be done as a
   *pre-registered* change with the expected direction stated first, not after
   seeing a result.
4. **Ship check-ins.** Until `repeatAffinity` is real, exhaustion damps good
   repeats and bad ones equally (F8), and repeat rate is the north star.

---
---

# v1.7 — Instrumentation first

The framework document was still unavailable. Same rule: anything only it would
have contained is a numbered claim here. Schema facts moved to
[`SCHEMA.md`](SCHEMA.md), which is the authoritative reconciliation record and
overrides the v1.5/v1.6 migrations wherever they disagree.

## H. New inferences and decisions

### H1. The check-in interest source keeps its v1.5 slugs

The build prompt says to mirror check-ins into `interest_events` as
`checkin_positive` / `checkin_negative`. This repo has used `checkin_yes` /
`checkin_no` since v1.5, and those slugs key three things: the
`ranking_events.event_type` check constraint, `INTEREST_SOURCES` (weight 1.2 at
a 120-day half-life, the highest and longest in the table), and the backfill
script.

Rows written under the prompt's names would match no `INTEREST_SOURCES` entry
and therefore fold in at **zero weight** — the single most predictive signal in
the system, silently contributing nothing. That failure is invisible: the rows
exist, the counts look right, and the interest vector just never moves.

Kept the existing slugs, routed every write through
`CONSTANTS.checkin.interestSource`, and put a test on the mapping. Renaming is
one edit plus a widened check constraint, and the weights come with it.
**Surfaced rather than resolved silently** — SCHEMA.md §6.

### H2. The ship gate is a parameter override, not a branch

`RANKER_ENABLED = false` could have been `if (!enabled) return proximityDeck()`.
It is not, because a second code path rots: the shipped one gets the fixes, the
shelved one quietly stops working, and the day someone flips the flag they find
the ranker has been broken for four months. It is also the same mode switch that
v1.6 §1 spent an entire architecture avoiding, reintroduced one level up.

`applyShipGate()` collapses P_join to a proximity delta, quotas to proximity,
`exploreEpsilon` to 0 and a new `funnelExponent` to 0. All four are values the
existing code already handles. The shelved ranker is the live pipeline with
different numbers, and the v1.5/v1.6 tests still run against it every commit by
passing back the ungated parameters.

`funnelExponent` is a number rather than a boolean deliberately: intermediate
values are meaningful (0.5 is a half-strength funnel, and §D3 uses exactly
that), the continuity test covers it like every other parameter, and nothing
downstream has to branch.

### H3. `paramsOverride` exists so that diagnostics leave a diff

v1.6's decomposition diagnostic was run by editing `constants.ts`, running,
and reverting — a procedure that leaves no trace and is therefore
indistinguishable from tuning. `RankOptions.paramsOverride` replaces it. Every
number in `DIAGNOSTICS.md` was produced through it, so every diagnostic's
configuration is visible in `scripts/sweep.ts` rather than in a reverted edit.

A test asserts nothing under `adapter/` sets it. In application code it would be
a constant.

### H4. Host retention is defined as "posted again after the first post settled"

The prompt says "did a user post a second tandem unprompted". Implemented as:
of the hosts whose **first** post has settled inside the run — i.e. who have
seen how it went — the fraction who created another post after that settlement.

Keyed on the first post rather than on a raw post count because the raw count
saturates: at the frozen model's 0.18 posts/day over 120 days almost everyone
posts twice eventually, so "posted at least twice" separates nothing.

It still saturates somewhat (every arm scores 0.78–0.96), which is reported
rather than hidden, and is why `retentionAfterEmpty` — the same question
conditioned on the first post getting **nobody** — is reported alongside it.
That conditional is the exact event the entire village objective exists to
prevent, and it is where the signal is.

Computed entirely in `scripts/sweep.ts` from `world.posts`. The frozen
population model was **not modified** to add it.

### H5. The impression floor stays on while the ranker is shelved

§3.3 names the shipping order as "proximity x demand x session penalties",
which read strictly would exclude the v1 §5 impression floor. It is kept on
anyway: its entire purpose is stopping a good post dying from a cold first hour,
which is host retention, which is now the primary metric. Judged in rather than
out, and flagged here because it is a departure from the literal instruction.

### H6. `graph_edges` is a derived aggregate, and `tandem_completions` is ignored

`tandems` is already a pairwise edge list with a completion status, so
`graph_edges` is a convenience aggregate over it and nothing more. Maintaining
it by trigger bought nothing and added the failure mode that actually occurred.
`rebuild_graph_edges()` recomputes it; a missed run loses nothing.

`tandem_completions` has 2 rows against 23 completed tandems and its
`user_id_1` / `user_id_2` columns are dead legacy with zero rows populated. It
is not read, not written, and not migrated.

### H7. Session penalties are UNMEASURED and were not tuned

`categoryPenalty` and `hostPenalty` are marked `UNMEASURED` in `constants.ts`.
Nobody knows the median session length: `feed_impressions` is empty, and "3
cards" is derived from looking at the UI rather than from measuring anyone. They
were not tuned against the simulator either — the sim drives one deck per person
per day, so a session is one deck there and the penalties barely engage. Setting
them from that would launder a guess into a measurement.
