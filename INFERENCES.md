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
