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
  slate.ts       diversity, fairness, explore          §3.3
  explain.ts     reason-line selection                 §5
  rank.ts        the orchestrator — the only public entry point into core/

adapter/
  supabase.ts    the ONLY file that knows Supabase exists
  index.ts       the public API the app calls
```

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

Then, as the user moves through the deck:

```ts
await ranking.logImpression({ userId, activityId, hostId, deckPosition, source, features });
await ranking.logEvent({ userId, eventType: 'expand', activityId });
await ranking.logEvent({ userId, eventType: 'im_in', activityId, deckPosition });
```

`impression` should carry `features` — that snapshot is the training data for
v2. Every impression stores the feature vector, and the downstream events become
the labels. Skip it and v2 has nothing to learn from.

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
| `maxPerCategory` | 8 | 2 | you cannot diversify a pool that is not diverse |
| `maxPerHost` | 3 | 1 | |
| `demandWeight` | 0.50 | 0.10 | filling posts IS the objective at village scale |
| `overflowPenalty` | 0.6 | 0.2 | a wasted slot is expensive when there are few |
| `exhaustionRate` | 0.35 | 0.15 | running out of new faces is the village failure mode |
| `noveltyBoost` | 1.0 | 2.5 | novelty is unmeasurable on three events |

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
whole point. ⚠️ `repeatAffinity` needs check-in data that does not exist yet, so
it is currently 0.5 for every pairing and exhaustion is a uniform damper on all
repeats, good ones included. That is the highest-priority gap in this build.

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

- the `graph_edges` table, populated from day one by an `AFTER UPDATE` trigger on
  tandem completion, canonical ordering `user_a < user_b`, weight incremented per
  shared completion;
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

The migration and the trigger are already accumulating history, so the day you
turn it on there is something to turn it on to.

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
