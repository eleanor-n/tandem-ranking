# tandem-ranking

The ranking and interest-modelling layer for Tandem's Discover deck.

Everything under `core/` is pure TypeScript: no React, no React Native, no Expo,
no Supabase, no browser or native globals, no clock. Time is always an injected
parameter. That is not stylistic — it is what makes the module testable, what
lets the offline simulator drive 120 simulated days in 300ms, and what protects
it from a stack decision it does not need an opinion about.

```
core/
  constants.ts   every tunable, one exported object, nothing magic elsewhere
  types.ts       InterestEvent, Candidate, ScoredCandidate, Slate, the data port
  random.ts      mulberry32 + FNV-1a. No dependency, no Math.random
  interest.ts    event log -> interest vector          §1.1–1.4, §1.7
  features.ts    proximity, timeFit, hostReliability…  the feature dictionary
  score.ts       P_join x P_accept x P_complete x R_repeat
  retrieval.ts   source quotas, candidate assembly     §3.1
  slate.ts       session penalties, fairness, explore  §3.3
  session.ts     what this session has already shown   v1.7 §3.2
  checkin.ts     who to ask, and when                  v1.7 §2.2
  shipping.ts    THE ship gate. One flag, one reader   v1.7 §3.3
  explain.ts     reason-line selection                 §5
  rank.ts        the orchestrator — the only public entry point into core/

adapter/
  supabase.ts        the ONLY file that knows Supabase exists
  instrumentation.ts the buffered impression writer    v1.7 §2.1
  index.ts           the public API the app calls
```

> **Read [`../../SCHEMA.md`](../../SCHEMA.md) before touching the adapter or a
> migration.** It records what the live database actually contains and overrides
> the v1.5 and v1.6 migrations wherever they disagree — which is in three
> places, one of which silently disabled a trigger for months.

## Using it

```ts
import { createRankingClient, createSupabaseRankingPort } from './src/ranking/adapter';
import * as Crypto from 'expo-crypto';

const ranking = createRankingClient({
  port: createSupabaseRankingPort(supabase, {
    distanceMiles: (row) => haversineMiles(userLocation, row),
    newId: () => Crypto.randomUUID(),
  }),
  now: () => Date.now(),
  onError: (where, e) => Sentry.captureException(e, { tags: { where } }),
});

const { slate } = await ranking.getDeck(userId, sessionId);
// slate.cards -> render. There is no score on them, by construction.
```

Wire the lifecycle once, at startup and on foreground/background:

```ts
await ranking.instrumentation.restore();           // recover a killed buffer
ranking.instrumentation.startSession();            // on every app foreground
// ...
await ranking.instrumentation.appBackgrounded();   // on background
```

Then, as the user moves through the deck:

```ts
ranking.instrumentation.recordDeck(userId, result);          // one row per card
ranking.instrumentation.record({ userId, eventType: 'expand', activityId });
ranking.instrumentation.record({ userId, eventType: 'im_in', activityId, deckPosition });
```

Note what these are **not**: they are not `await`ed and they do not return
promises. Discover shows one card at a time, so a promise on this path becomes a
network round-trip per swipe. `record()` is synchronous, cannot throw, and
buffers; batches leave on a timer, on backgrounding, and at 20 events. A failed
log is invisible to the user by design.

`recordDeck` carries `result.snapshots`, which is the **entire feature set** —
including every feature the shipped ordering ignores. That is the point of the
v1.7 build: features cost microseconds, unlogged history is unrecoverable, and
"does `timeFit` predict anything" must not be a question whose answer starts with
"run it for three months first".

Once per app open, ask what the user owes:

```ts
const [pending] = await ranking.getPendingCheckIns(userId);
if (pending) {
  // Eleanor's copy and UI. This layer only knows who and when.
  await ranking.submitCheckIn({ ...pending, positive: answer });
}
```

There is no `skipCheckIn`. A skip writes nothing and comes back next time — a
person who did not answer is not a person who said no.

## The data port

The app is not required to use Supabase. `RankingDataPort` in `core/types.ts` is
the whole contract; `adapter/supabase.ts` is one implementation of it. A REST
backend, an in-memory fake for tests, or a local-first store are equally valid —
implement the interface and pass it to `createRankingClient`.

The Supabase adapter takes the client **structurally**: it never imports
`@supabase/supabase-js`, so this package has zero runtime dependencies and does
not pin a client version against the host app's. Column names are collected in
one `COLUMNS` object at the top of the file; reconcile them with the real schema
before shipping.

## What is on, and what is off (v1.7)

**The ranker is shelved, not deleted.** `RANKER_ENABLED` in `core/shipping.ts`
is `false`. What ships is:

```
deck order = proximity  x  demand balancing  x  within-session penalties
```

Everything else stays in the repo, stays tested, and keeps computing on every
deck — its full feature set goes into `ranking_events.score_snapshot` on every
impression. It just does not order anything.

| | what | reactivate by |
|---|---|---|
| ✅ | proximity ordering | — |
| ✅ | demand balancing (urgency, overflow) | — |
| ✅ | within-session category/host penalties | — |
| ✅ | impression floor | — |
| ✅ | **impression logging, full feature set** | — |
| ✅ | check-in data path | — |
| ⬜ | interest weights in P_join | `RANKER_ENABLED = true` |
| ⬜ | explore epsilon, fresh-host quota, affinity retrieval | `RANKER_ENABLED = true` |
| ⬜ | funnel factors (P_accept x P_complete x R_repeat) | `RANKER_ENABLED = true`, but read `DIAGNOSTICS.md` §D3 first — they are the most damaging thing measured in this build |
| ⬜ | exhaustion (§3) | check-in data exists in `tandem_feedback` |
| ⬜ | graph consumption | implement `graphAffinity`, then see below |
| ⬜ | intent gap (§1.5), transition detection (§1.6), learned weights | out of scope |

### Why the gate is a parameter override and not an `if`

The obvious implementation is a branch at the top of `rank()`:

```ts
if (!RANKER_ENABLED) return proximityDeck(input)   // DON'T
```

That is a second code path, and second code paths rot. The shipped one gets the
bug fixes, the shelved one quietly stops working, and the day someone flips the
flag they discover the ranker broke four months ago. It is also the same mode
switch that the v1.6 density architecture spent its whole design avoiding,
reintroduced one level up.

So `applyShipGate()` transforms the resolved parameters instead: P_join
collapses to a proximity delta, quotas collapse to proximity, `exploreEpsilon`
goes to 0, and `funnelExponent` goes to 0 so `P_accept^0 = 1`. One pipeline, one
set of modules, one order of operations — the shelved ranker is the live path
with different numbers, which is the only kind of dormant code that still works
when you wake it up.

The old ranker tests still run against it every commit, by handing back the
ungated parameters:

```ts
rank(input, { paramsOverride: resolveParams(regime) })   // wake the ranker up
```

Two architectural tests hold the line: only `rank.ts` may read the flag, and no
scoring module may import `shipping.ts`.

## Instrumentation (v1.7 §2.1)

`ranking_events` is **the** impression table. `feed_impressions` is deprecated
(zero rows, a `DEPRECATED` table comment, and a test that fails if any source
file names it) — two tables with overlapping jobs is how a training set ends up
split across schemas with no way to join it afterwards.

Every card shown writes one row: `user_id`, `activity_id`, `host_id`,
`event_type`, `deck_position`, `session_id`, `source`, `score_snapshot`. Also
logged: `expand`, `im_in`, `accept`, `decline`, `complete`, `checkin_yes`,
`checkin_no`.

`score_snapshot` carries `{ v, features, funnel, regime, rankerEnabled, algo }`.
Resolved parameters are deliberately **not** stored per row: they are a pure
function of `(algo, regime)`, so writing them would duplicate onto thousands of
impressions something already reconstructable from a git tag.

`session_id` is client-generated, one per app foreground period. There is no
server-side session concept and this build does not add one — a session is "the
stretch of cards someone looked at in one sitting", which only the client can
observe.

The writer's three rules, in priority order:

1. **Never surface an error.** A failed log is invisible. `onError` is for a
   developer console and nothing else reads it.
2. **Never block a render.** Everything except `flush()` is synchronous.
3. **Lose events rather than grow without bound.** At 500 buffered events the
   oldest are dropped and counted; a batch that fails three times is abandoned,
   because retrying a poison batch forever is how a logging layer becomes an
   outage. `instrumentation.health()` reports both.

Crash persistence is opt-in via an injected `storage` (AsyncStorage satisfies
the interface as-is) and coalesced on a debounce, so it does not put a storage
write back on the swipe path.

## Within-session penalties (v1.7 §3.2)

```
S_final x= categoryPenalty ^ shownThisSession(category)
S_final x= hostPenalty     ^ shownThisSession(host)
```

These replaced `maxPerCategory` and `maxPerHost`, which were **mis-specified,
not mistuned**. Every slot rule in v1.6 was a fraction of a deck of 8 — but
Discover shows one card at a time, the user keeps tandeming until they close the
app, and the pool does not reset. "At most 2 coffees per 8" never binds in a
three-card session and means nothing at all in a forty-card one. It is a quota
over a window that does not exist.

Three properties a quota could not have:

- it degrades gracefully at **any** session length, with no cliff
- it costs no reserved slot, so nothing is displaced
- it is monotone: the fourth coffee is worse than the third rather than
  forbidden where the third was free

And one thing it deleted: **the relaxation ladder**. That machinery existed
because a hard cap could make the deck come out short. A penalised card is still
a card, so the failure mode stopped existing rather than being handled.
"Constraints reorder, they never shorten" now holds structurally.

The counters live in the ranking client, keyed by `sessionId` and evicted
oldest-first, so callers do not have to thread them. Call `resetSession(id)` on
foreground if you reuse session ids.

⚠️ **Both constants are `UNMEASURED` and must not be tuned yet.** Nobody knows
the median session length. `feed_impressions` is empty and "3 cards" is derived
from looking at the UI, not from measuring anyone. Tuning against that guess
would launder the guess into a measurement. Set them from real `ranking_events`
data after the beta — which is what this whole build is for.

## The check-in (v1.7 §2.2)

Data path only. Copy and UI belong elsewhere; nothing here renders anything, the
answer is never shown to the rated user, and it never becomes a score.

- **when** — the activity ended, plus `minElapsedHours` (2). Asking on the walk
  home gets an answer about the last five minutes.
- **who** — exactly one counterpart, because `tandems` is strictly pairwise.
- **how many** — one per app open. Five on launch is an interrogation, and the
  second answer is already worse than the first.
- **order** — oldest first. A check-in decays in usefulness, and asking the
  stalest one first is what stops a backlog quietly becoming permanent.
- **skip** — writes nothing, so it returns next time. A person who did not
  answer is not a person who said no; storing a skip as a negative teaches
  people that the honest answer has consequences, after which the signal is
  worthless.

Writes `tandem_feedback` (already per-pair — no migration needed) and mirrors
into `interest_events`, where `checkin_yes` carries weight 1.2 at a 120-day
half-life, the highest and longest in the table. See **SCHEMA.md §6** for the
`checkin_yes` vs `checkin_positive` naming conflict and why the existing slugs
were kept.

## Density adaptation (v1.6)

The ranker's objective changes with density, and it does so **continuously**.
There is one algorithm; there is no mode switch, no flag, and no
`if (regime === 'village')` anywhere. Village behaviour is the mathematical
limit of city behaviour as `regime -> 0`.

```
coverage(u) = eligiblePostsPerWeek(u) / cardsViewedPerWeek(u)
            -> 4-week EWMA -> hysteresis band -> regime in [0, 1]
            -> resolveParams(regime) -> plain numbers
```

Why not user count: it stops being a proxy the moment users are non-uniformly
distributed. A dense urban cluster reaches city conditions at 200 total users
while a rural user is still enumerating their whole pool at 2,000. **Two users
of the same app can be in different regimes on the same day**, and that is
correct.

### Reading it

```ts
const debug = await ranking.getRegimeDebug(userId);
// { coverage, coverageEwma, regime, regimeUnsmoothed, held,
//   eligiblePostsPerWeek, cardsViewedPerWeek, weeksOfHistory, params }
```

`held: true` means hysteresis suppressed a move — that is the answer to "why is
the regime stuck". Note that hysteresis leaves a permanent dead zone of up to
one band; that is inherent to it, and bounded.

**Never surface any of this.** The regime is an implementation detail of how
hard the ranker is trying, and telling a user they are in "village mode" invites
them to reason about an internal that will change.

### Forcing a regime for local testing

`rank()` takes an optional `regime`, so a test or a script pins it directly:

```ts
rank({ ...input, regime: 0 })    // fully village
rank({ ...input, regime: 1 })    // fully city, == v1.5 constants
rank({ ...input, regime: 0.4 })  // anywhere in between
```

Omit it and `rank()` derives a one-shot reading from the candidate pool size,
which is what a first-ever session does. The adapter supplies the smoothed,
persisted value in production.

### Adding a new scaled parameter

1. Declare it as a `{ village, city }` pair in `CONSTANTS.scaled`, with a comment
   saying what each end means — not just what the number does.
2. Add it to `ResolvedParams` in **`core/types.ts`**, not in `regime.ts`. This is
   deliberate: scoring modules need the shape but must not import the regime
   module, or one of them will eventually reach past the resolved values for the
   scalar itself.
3. Resolve it in `resolveParams()`.
4. Thread it as a plain number to whatever consumes it.

Four architectural tests enforce the boundary. `score.ts`, `slate.ts`,
`explain.ts`, `retrieval.ts`, `features.ts` and `demand.ts` may not import
`regime.ts`, may not mention the words *regime*, *village*, *city* or *coverage*
outside comments, and only `rank.ts` may call `resolveParams`. A fixed value for
anything the spec says must scale also fails the build.

### What scales, and why

| parameter | village | city | why |
|---|---:|---:|---|
| `pJoin.interestAffinity` | 0.10 | 0.30 | few events ⇒ high variance ⇒ mostly noise |
| `pJoin.proximity` | 0.40 | 0.20 | the simulator's v1.5 finding, made structural |
| `pJoin.timeFit` | 0.20 | 0.12 | |
| `pJoin.intentMatch` | 0.10 | 0.15 | |
| `pJoin.socialContext` | 0.05 | 0.08 | |
| `pJoin.graphAffinity` | 0.0 | 0.0 | stub — intended city value 0.15, see below |
| `exploreEpsilon` | 0.0 | 0.15 | exposure is already guaranteed by pool exhaustion |
| `quotas.random` | 0.0 | 0.05 | |
| `quotas.fresh_host` | 0.0 | 0.10 | becomes ordering, not a slot — see §2.3 |
| `categoryPenalty` | 0.95 | 0.80 | ⚠️ UNMEASURED. v1.7 §3.2 — replaced `maxPerCategory` |
| `hostPenalty` | 0.85 | 0.60 | ⚠️ UNMEASURED. replaced `maxPerHost` |
| `demandWeight` | 0.50 | 0.10 | filling posts IS the objective at village scale |
| `overflowPenalty` | 0.6 | 0.2 | a wasted slot is expensive when there are few |
| `exhaustionRate` | **0.0** | **0.0** | ⚠️ DISABLED in v1.7 — see below |
| `noveltyBoost` | 1.0 | 2.5 | novelty is unmeasurable on three events |

Every one of these is now **continuous**. v1.6's `maxPerCategory` / `maxPerHost`
were integer counts that stepped by 1 and were the one legitimate discontinuity
in the system; replacing them with multiplicative penalties emptied the
continuity test's exemption list.

P_join weights are renormalised to sum 1 **after** interpolation, at every point
on the continuum, asserted at load and in tests. The declared columns do not
each sum to 1 — that keeps the table readable as relative importances rather
than pre-divided fractions.

`graphAffinity` is 0.0 at *both* ends on purpose. A non-zero weight on a feature
that always returns 0 survives renormalisation and would systematically depress
P_join for everyone. Set the city end to 0.15 in the same commit that implements
the feature, not before.

### Demand balancing and exhaustion

```
S_final = S x (1 + demandWeight x urgency)
            x (1 - overflowPenalty x overflow)
            x (1 - exhaustion x (1 - repeatAffinity))
```

`urgency = (1 - min(fillRatio, 1)) x timePressure`. An empty post happening
tomorrow is maximally urgent; a full one is zero. `fillRatio` reads
`confirmed_joiners`, which the v1.6 migration denormalises onto `activities` via
a recounting trigger — so it rides the bulk query the deck already runs and
never becomes a per-card fetch.

**Unknown is not zero.** A missing joiner count contributes no urgency at all,
so a post whose data failed to load cannot be boosted as if it were empty.

Exhaustion is *gated* by `repeatAffinity`, not merely offset by it: a host you
have enthusiastically said yes to twice has `repeatAffinity ≈ 1`, so the
suppression vanishes entirely. It has to — becoming a habit with someone is the
whole point.

⚠️ **Exhaustion is DISABLED in v1.7** — `exhaustionRate` is 0 at both ends.
`repeatAffinity` needs check-in data and `tandem_feedback` has zero rows, so it
returns 0.5 for every pairing and the term damps good repeats and bad repeats
identically. Repeat-tandem rate is the long-run north star; a uniform damper on
the thing you are optimising for is worse than no damper.

**Reactivation condition, stated in one place:** check-in data exists in
`tandem_feedback`. When it does, copy `CONSTANTS.scaled.exhaustionRateWhenReactivated`
(the v1.6 tuned values, parked rather than deleted) back over `exhaustionRate`
and re-run the sweep. The code and all 19 demand tests stay live in the
meantime, running at the reactivation rates, so it still works on the day you
flip it.

### Where transition detection will interact

Not built (§1.6 is out of scope). When it lands: a user in a `transitioning`
state should get **city-like exploration even at village density**, because the
point of the village parameters is that the pool is enumerable, and the point of
transition detection is that the user's own preferences are moving — the second
overrides the first. Expect it to enter as a floor on `regime`, not as a branch.

## How to change a weight

Every number lives in `CONSTANTS` in `core/constants.ts`, with a comment saying
what it does and what raising it would do. Change it there; there is nowhere
else to change it. `tests/purity.test.ts` fails the build if a numeric literal
that isn't an index or a unit conversion appears anywhere else in `core/`.

Two invariants are asserted at module load: `CONSTANTS.score.pJoin` and
`CONSTANTS.score.pComplete` must each sum to 1. If you take weight from one
feature you have to give it to another.

After changing anything, run the simulator (see below) before and after. A
weight change that improves nothing measurable is a weight change you should
not ship.

## How to add a retrieval source

1. Add the name to `RetrievalSource` in `core/types.ts`.
2. Add a quota to `CONSTANTS.retrieval.quotas`. Quotas are relative, not
   absolute — they are normalised and scaled by deck size.
3. Write the source function in `core/retrieval.ts` and add it to the `raw`
   object in `retrieve()`. Add it to `SOURCE_ORDER`; earlier sources win ties
   during dedup.
4. Decide whether it belongs in `CONSTANTS.retrieval.backfillOrder` — the
   sources that absorb slots when another source under-fills.

A source that returns `[]` costs nothing: its quota is silently redistributed.
That is exactly how the `graph` source is currently shipping.

## How to turn the graph on later

The graph is written but never read in v1.5. Three things are already in place:

- the `graph_edges` table, now a **derived aggregate** over
  `tandems WHERE status = 'completed'`, rebuilt from scratch by
  `rebuild_graph_edges()` / `npm run graph:rebuild`. Canonical ordering
  `user_a < user_b`, weight = shared completed tandems;
- `graphAffinity()` in `core/features.ts`, with its final signature, returning `0`;
- the `graph` retrieval source in `core/retrieval.ts`, returning `[]`.

To switch it on:

1. Implement `graphAffinity` — shortest path from viewer to host over
   `graph_edges`, capped at three degrees, mapped through a decay. Three degrees
   because friends-of-friends have a decent chance of knowing each other, and
   past that the shared-interest prior washes out.
2. Give it a weight in `CONSTANTS.score.pJoin.graphAffinity` **taken out of**
   `categoryAffinity` and `proximity`. Do not add it on top: the load-time
   assertion will fail, and rightly — P_join stops being a probability.
3. Implement the `graph` retrieval source and give it a real quota.
4. Decide whether the app needs the degree exposed for a reason line
   ("you've both tandemed with Maya"). That copy is a privacy decision, not a
   ranking one — it reveals a third party's participation to someone who was
   not there.

The history can never be missing, because `graph_edges` is recomputable from
`tandems` at any time. That is a strictly better position than v1.5's, where a
trigger targeting a table that does not exist silently never fired and the
table sat empty for months with nothing to notice.

## Guarantees the tests enforce

| Guarantee | Test |
|---|---|
| An event at one half-life contributes half its strength | `interest.test.ts` |
| The 40th event of a metric moves interest <1% of what the 1st did | `interest.test.ts` |
| A thin fresh interest outranks a thick stale one | `interest.test.ts` |
| Cache and rebuild-from-log agree exactly | `interest.test.ts` |
| Same seed, same deck, ten runs | `rank.test.ts` |
| Scoring throwing yields a proximity-ordered, non-empty deck | `fallback.test.ts` |
| ≤2 same-category cards per deck of 8 | `rank.test.ts` |
| ≥1 fresh_host in the top 3 | `rank.test.ts` |
| Zero events + zero completions yields a sane, full deck | `rank.test.ts` |
| No numeric score is reachable from the UI-facing type | `rank.test.ts` |
| `core/` imports nothing and touches no clock | `purity.test.ts` |
| No magic numbers outside `constants.ts` | `purity.test.ts` |
| Reason lines never claim more than the data proves | `explain.test.ts` |

```
npm test
npm run typecheck
```

## The simulator

```
npm run sim -- --users 40 --days 120 --seed 1 --verbose
```

Builds a synthetic population with **hidden** true preferences, runs simulated
days, and lets each synthetic person respond to the decks the ranker produces.
The ranker never sees the hidden preferences — only the events the behaviour
generates. It runs `proximity`, `popularity` and `random` baselines on the same
population and seed, so results are comparative.

Read `scripts/simulate.ts` before trusting a number from it. Its user model is a
guess, and where the guess is wrong the metric is wrong — see the note in
`INFERENCES.md` about what the simulator does not model.

## Things that are deliberately not here

- **Graph consumption.** Written, never read. See above.
- **`revealed`/`desired` split and intent gap (§1.5).** `expand` events are
  emitted and stored; `CONSTANTS.interest.sources.expand.weight` is `0`. Raise it
  to ~0.15 once a few weeks of expand data exist.
- **Transition detection (§1.6).** Needs 120 days of history.
- **Learned weights, regression, embeddings.** v2, offline, from
  `ranking_events`. Paste the coefficients back into `CONSTANTS.score`; the
  architecture does not change.
- **Server-side ranking / Supabase RPCs.** Everything runs client-side. At beta
  scale this is instant. The move happens when the pool is too big to fetch
  whole, which is far away.
- **Any UI.** The module exports an interface and touches no components.
- **Message content and contact-graph signals.** Permanently. Not a v1.5
  simplification.
