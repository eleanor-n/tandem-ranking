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
