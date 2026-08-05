/**
 * The density sweep — v1.6 §4, re-pointed at the v1.7 metric.
 *
 *   npm run sweep
 *   npm run sweep -- --sizes 20,40,80 --seeds 1,2 --days 120
 *   npm run sweep -- --csv results.csv --md results.md
 *   npm run sweep -- --exhaustion on            # §4.2 counterfactual
 *   npm run sweep -- --proximity-sweep          # §4.4
 *
 * ---------------------------------------------------------------------------
 * THE PRIMARY METRIC CHANGED. Read this before reading any number below.
 *
 * v1.6 reported repeat-tandem rate, which is `repeats / completions` — a RATIO.
 * A ratio can be won by shrinking the denominator. Show the same eight people
 * to each other forever and every completion is a repeat; the metric reads 1.0
 * and the product is dead.
 *
 * `proximity_only` shrinks the pool by construction. It shows you your nearest
 * neighbours, and only them, for as long as you use the app. So a metric that
 * rewards pool-shrinking will keep reporting that the pool-shrinking algorithm
 * is best, and that is a property of the metric rather than a finding about the
 * algorithm. With 23 completed tandems in production, repeat rate is also
 * unmeasurable in practice.
 *
 * So the primary metric is now HOST RETENTION: did a host, having watched their
 * first post play out, post again. It is a count rather than a ratio, so it
 * cannot be won by doing less. Repeat rate is still reported, still the long-run
 * goal, and no longer the thing being steered by.
 *
 * ---------------------------------------------------------------------------
 * How much to believe any of it
 *
 * The population model was authored alongside the ranker it grades, so the two
 * have correlated blind spots. A result that FAVOURS the ranker is weak
 * evidence — it may only mean the two models agree with each other. A result
 * AGAINST it is strong evidence, because it survived that correlation.
 *
 * That standing caveat has not changed and does not get to be forgotten because
 * the metric did.
 */

import { rank } from '../src/ranking/core/rank.js';
import { computeRegime, resolveParams } from '../src/ranking/core/regime.js';
import { CONSTANTS, IDEAL_SATURDAY_METRICS } from '../src/ranking/core/constants.js';
import {
  DAY,
  START,
  addEvent,
  buildPopulation,
  candidatesFor,
  createPost,
  emptyWorld,
  joinDecision,
  postsToday,
  resolveJoin,
  seededRng,
  settleAndChurn,
  viewerFor,
  type Person,
  type Post,
  type World,
} from './population.js';
import type { Candidate, ResolvedParams } from '../src/ranking/core/types.js';

// ---------------------------------------------------------------------------
// Arms
// ---------------------------------------------------------------------------

type Arm =
  | 'shipped'
  | 'regime_adaptive'
  | 'full_ranker_fixed'
  | 'proximity_only'
  | 'random';

const ARMS: Arm[] = [
  'shipped', 'regime_adaptive', 'full_ranker_fixed', 'proximity_only', 'random',
];

const ARM_NOTES: Record<Arm, string> = {
  shipped: 'v1.7 as it ships — proximity x demand x session penalties, ranker shelved',
  regime_adaptive: 'the SHELVED ranker, density-continuous parameters (v1.6)',
  full_ranker_fixed: 'v1.5 constants, regime pinned to 1 (no adaptation)',
  proximity_only: 'nearest first, taste-blind — the v1.5 giant-killer',
  random: 'the floor. If anything loses to this it is a bug, not a design failure',
};

/**
 * Every arm except `shipped` has to WAKE THE RANKER UP.
 *
 * RANKER_ENABLED is false, so `rank()` ships proximity ordering by default. The
 * ranker arms restore the ungated parameters through the diagnostics-only
 * override, which is also how they stay honest: the configuration of every
 * number in DIAGNOSTICS.md is visible right here rather than in a constants
 * edit that was reverted before the commit.
 */
function armParams(arm: Arm, regime: number, opts: Options): Partial<ResolvedParams> | null {
  if (arm === 'proximity_only' || arm === 'random') return null;   // not ranked at all

  const tweaks = {
    ...(opts.exhaustionOn ? { exhaustionRate: reactivatedExhaustion(regime) } : {}),
    ...(opts.funnelExponent !== null ? { funnelExponent: opts.funnelExponent } : {}),
    ...(opts.demandWeight !== null ? { demandWeight: opts.demandWeight } : {}),
  };

  if (arm === 'shipped') {
    // Shipped configuration, plus whatever the counterfactual flags ask for.
    return tweaks;
  }

  const base = resolveParams(arm === 'full_ranker_fixed' ? 1 : regime);
  return {
    ...base,
    ...tweaks,
    ...(opts.proximityWeight !== null
      ? { pJoin: pJoinWithProximity(base, opts.proximityWeight) }
      : {}),
  };
}

/** §4.2: the v1.6 exhaustion rates, for the counterfactual arm only. */
function reactivatedExhaustion(regime: number): number {
  const r = CONSTANTS.scaled.exhaustionRateWhenReactivated;
  const t = Math.max(0, Math.min(1, regime));
  return r.village + (r.city - r.village) * t;
}

/**
 * §4.4: replace the proximity weight at BOTH ends of the scaled pair and
 * renormalise, leaving every other weight at its declared relative value.
 *
 * Renormalising rather than rescaling the others individually keeps this a
 * one-dimensional sweep: the only thing that changes is how much of P_join
 * proximity gets, which is the question being asked.
 */
function pJoinWithProximity(base: ResolvedParams, weight: number): ResolvedParams['pJoin'] {
  const others = { ...base.pJoin, proximity: 0 };
  const otherSum = Object.values(others).reduce((a, b) => a + b, 0);
  const remaining = Math.max(0, 1 - weight);
  const scale = otherSum > 0 ? remaining / otherSum : 0;

  return {
    interestAffinity: others.interestAffinity * scale,
    proximity: weight,
    timeFit: others.timeFit * scale,
    intentMatch: others.intentMatch * scale,
    socialContext: others.socialContext * scale,
    graphAffinity: others.graphAffinity * scale,
  };
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

interface Options {
  sizes: number[];
  seeds: number[];
  days: number;
  deckSize: number;
  csvPath: string | null;
  mdPath: string | null;
  /** §4.2. Re-enables exhaustion at the v1.6 rates. */
  exhaustionOn: boolean;
  /** §4.4. Overrides w_proximity at both ends of the pair. */
  proximityWeight: number | null;
  proximitySweep: boolean;
  /**
   * §4.3 investigation knobs. Both are ablations of the ranker arms, used to
   * find out WHY regime_adaptive loses to random rather than asserting a
   * mechanism and moving on.
   */
  funnelExponent: number | null;
  demandWeight: number | null;
  /** Restrict to a subset of arms. An ablation rarely needs all five. */
  arms: Arm[];
}

function parseArgs(): Options {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | null => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? (argv[i + 1] as string) : null;
  };
  const nums = (raw: string | null, fallback: number[]): number[] =>
    raw ? raw.split(',').map((x) => Number(x.trim())).filter(Number.isFinite) : fallback;

  const weight = flag('--proximity-weight');

  return {
    sizes: nums(flag('--sizes'), [20, 40, 80, 150, 300, 600]),
    seeds: nums(flag('--seeds'), [1, 2, 3]),
    days: Number(flag('--days') ?? 120),
    deckSize: Number(flag('--deck') ?? CONSTANTS.slate.deckSize),
    csvPath: flag('--csv'),
    mdPath: flag('--md'),
    exhaustionOn: flag('--exhaustion') === 'on',
    proximityWeight: weight === null ? null : Number(weight),
    proximitySweep: argv.includes('--proximity-sweep'),
    funnelExponent: flag('--funnel-exponent') === null
      ? null : Number(flag('--funnel-exponent')),
    demandWeight: flag('--demand-weight') === null
      ? null : Number(flag('--demand-weight')),
    arms: (() => {
      const raw = flag('--arms');
      if (!raw) return ARMS;
      const wanted = new Set(raw.split(',').map((x) => x.trim()));
      const picked = ARMS.filter((a) => wanted.has(a));
      return picked.length > 0 ? picked : ARMS;
    })(),
  };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

interface Result {
  arm: Arm;
  users: number;
  seed: number;

  impressions: number;
  joins: number;
  completions: number;
  repeats: number;

  /**
   * THE PRIMARY METRIC (v1.7).
   *
   * Of the hosts whose first post has settled — i.e. who have seen how it went —
   * the fraction who posted again afterwards.
   *
   * A count, not a ratio, so unlike repeat rate it cannot be won by shrinking
   * the pool. It is also the closest thing the simulator has to the beta's
   * actual question: did a person come back and post a second tandem
   * unprompted.
   */
  hostRetention: number;
  /** Hosts eligible for the above, i.e. whose first post settled in the run. */
  retentionDenominator: number;

  /**
   * The DISCRIMINATING cut of the same question: of the hosts whose first post
   * got NOBODY, how many posted again anyway.
   *
   * Plain host retention saturates in this simulator — at 0.18 posts/day a
   * second post is nearly automatic before churn can bite, so every arm scores
   * 0.8-0.9 and the metric separates nothing. That is worth knowing and is
   * reported, but it is not a measurement.
   *
   * Conditioning on the bad outcome is where the signal is, and it is also the
   * exact event the entire village objective exists to prevent: a host posts,
   * gets nobody, and never comes back.
   */
  retentionAfterEmpty: number;
  emptyFirstPostHosts: number;

  /** completions / distinct users. */
  tandemsPerUser: number;
  /** repeats / completions. Secondary as of v1.7 — see the header. */
  repeatRate: number;
  /** Fraction of settled posts that got nobody. The liquidity metric. */
  zeroJoinerRate: number;
  /** Hosts still willing to post at the end of the run. */
  survivingHosts: number;
  survivingHostFraction: number;
  /** Gini over per-host joiner counts. 0 = perfectly even, 1 = winner-take-all. */
  hostGini: number;
  /** Mean hidden relevance of a shown card. Deck quality. */
  deckRelevance: number;
  /** Mean coverage across users at the end — where on the continuum this landed. */
  meanCoverage: number;
  meanRegime: number;
}

/**
 * Gini over host joiner counts.
 *
 * The distributional check the averages hide: a marketplace where three hosts
 * get everything and forty get nothing can post a perfectly healthy mean.
 */
function gini(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const n = sorted.length;
  const total = sorted.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  let weighted = 0;
  for (let i = 0; i < n; i++) weighted += (i + 1) * (sorted[i] as number);
  return (2 * weighted) / (n * total) - (n + 1) / n;
}

/**
 * Host retention — v1.7's primary metric.
 *
 * "Did they post again after watching their first one play out."
 *
 * A host is ELIGIBLE once their first post has settled inside the run window;
 * before that they have not yet been given the information that retention is a
 * response to. They are RETAINED if any later post was created after that
 * settlement.
 *
 * Deliberately keyed on the first post rather than on total post count: at 0.18
 * posts per day over 120 days almost everyone posts twice eventually, so a raw
 * "posted at least twice" saturates and measures nothing. What discriminates is
 * whether the outcome of the first one killed them.
 */
function hostRetention(posts: readonly Post[]): {
  rate: number;
  eligible: number;
  afterEmpty: number;
  afterEmptyN: number;
} {
  const byHost = new Map<string, Post[]>();
  for (const post of posts) {
    const list = byHost.get(post.hostId) ?? [];
    list.push(post);
    byHost.set(post.hostId, list);
  }

  let eligible = 0;
  let retained = 0;
  let afterEmptyN = 0;
  let afterEmptyRetained = 0;

  for (const [, list] of byHost) {
    list.sort((a, b) => a.postedAt - b.postedAt);
    const first = list[0] as Post;
    if (!first.settled) continue;              // outcome not yet known to them

    const cameBack = list.some((p) => p.postedAt > first.startsAt);
    eligible += 1;
    if (cameBack) retained += 1;

    if (first.joiners.length === 0) {
      afterEmptyN += 1;
      if (cameBack) afterEmptyRetained += 1;
    }
  }

  return {
    rate: eligible > 0 ? retained / eligible : 0,
    eligible,
    afterEmpty: afterEmptyN > 0 ? afterEmptyRetained / afterEmptyN : 0,
    afterEmptyN,
  };
}

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

function baselineDeck(
  arm: Arm,
  pool: Candidate[],
  rng: () => number,
  size: number,
): Candidate[] {
  const sorted = pool.slice();
  if (arm === 'proximity_only') {
    sorted.sort((a, b) => a.distanceMiles - b.distanceMiles
      || a.activityId.localeCompare(b.activityId));
  } else {
    for (let i = sorted.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = sorted[i] as Candidate;
      sorted[i] = sorted[j] as Candidate;
      sorted[j] = t;
    }
  }
  return sorted.slice(0, size);
}

/**
 * The per-user coverage estimate, driven through the real regime pipeline —
 * EWMA and hysteresis included — rather than recomputed fresh each session.
 * Running the smoothing is the point: an unsmoothed regime would flip weekly
 * and the sweep would be measuring the wrong algorithm.
 */
function regimeFor(world: World, userId: string, poolSize: number): number {
  const stored = world.regimeState.get(userId) ?? { coverageEwma: null, lastRegime: null };
  const viewedThisWeek = world.weeklyImpressions.get(userId) ?? 0;

  const reading = computeRegime(
    {
      eligiblePostsPerWeek: poolSize,
      cardsViewedPerWeek: viewedThisWeek > 0 ? viewedThisWeek : null,
      weeksOfHistory: viewedThisWeek > 0 ? CONSTANTS.regime.minWeeksOfHistory : 0,
    },
    { ...stored, updatedAt: null },
  );

  world.regimeState.set(userId, {
    coverageEwma: reading.coverageEwma,
    lastRegime: reading.regime,
  });

  return reading.regime;
}

const RANKED_ARMS = new Set<Arm>(['shipped', 'regime_adaptive', 'full_ranker_fixed']);

function runOne(arm: Arm, users: number, seed: number, opts: Options): Result {
  const rng = seededRng(`${arm}:${users}`, seed);
  // Population is built from a seed that does NOT include the arm, so every arm
  // faces an identical world.
  const people = buildPopulation(users, seededRng('population', seed * 1000 + users));
  const byId = new Map(people.map((p) => [p.id, p]));
  const world = emptyWorld();

  for (const person of people) {
    for (const answer of person.idealSaturday) {
      for (const metric of IDEAL_SATURDAY_METRICS[answer] ?? []) {
        addEvent(world, person.id, metric, 'onboarding', START);
      }
    }
  }

  let impressions = 0;
  let joins = 0;
  let completions = 0;
  let repeats = 0;
  let relevanceSum = 0;
  let settledPosts = 0;
  let emptyPosts = 0;

  const joinersPerHost = new Map<string, number>();
  const coverageSamples: number[] = [];
  const regimeSamples: number[] = [];

  /**
   * Post lookup by id.
   *
   * This used to be `world.posts.find(...)` per card, which is a linear scan
   * over every post ever created. It is quadratic in the run length and it bites
   * exactly where the interesting configurations live: an arm that completes
   * more tandems triggers more supply response, which creates more posts, which
   * makes every subsequent lookup slower. The ablations that produced the best
   * results were the slowest to run, which is a bad property for a diagnostic
   * harness to have.
   *
   * Purely a harness change. `population.ts` — the FROZEN model — is untouched,
   * and the arm reproduces its previous numbers exactly (asserted by re-running
   * regime_adaptive at funnelExponent 1 and matching the main sweep row).
   */
  const postById = new Map<string, Post>();

  for (let day = 0; day < opts.days; day++) {
    const now = START + day * DAY;

    if (day % 7 === 0) world.weeklyImpressions.clear();

    for (const person of people) {
      if (postsToday(person, rng)) {
        const post = createPost(world, person, now, rng);
        postById.set(post.id, post);
      }
    }

    for (const person of people) {
      if (rng() > person.engagement * MODEL_SESSION_RATE) continue;

      const pool = candidatesFor(world, person, byId, now);
      if (pool.length === 0) continue;

      let deck: Candidate[];

      if (RANKED_ARMS.has(arm)) {
        const regime = arm === 'full_ranker_fixed'
          ? 1
          : regimeFor(world, person.id, pool.length);

        if (arm === 'shipped') {
          regimeSamples.push(regime);
          coverageSamples.push(
            pool.length / (world.weeklyImpressions.get(person.id)
              || CONSTANTS.regime.defaultCardsViewedPerWeek),
          );
        }

        const override = armParams(arm, regime, opts);

        // NOTE ON sessionShown: the simulator drives one deck per person per
        // day, so a session is one deck and the penalties operate within it.
        // Real Discover sessions are longer and the penalties will bite harder
        // there — which the sim cannot see, and which is the exact number this
        // build's instrumentation exists to measure.
        const result = rank({
          viewer: viewerFor(world, person),
          candidates: pool,
          interestEvents: world.interestEvents.get(person.id) ?? [],
          sessionId: `d${day}`,
          now,
          regime,
        }, {
          deckSize: opts.deckSize,
          ...(override && Object.keys(override).length > 0
            ? { paramsOverride: override }
            : {}),
        });

        const index = new Map(pool.map((c) => [c.activityId, c]));
        deck = result.slate.cards.map((c) => index.get(c.activityId) as Candidate);
      } else {
        deck = baselineDeck(arm, pool, rng, opts.deckSize);
      }

      const shown = world.shownHosts.get(person.id) ?? new Set<string>();
      world.weeklyImpressions.set(
        person.id, (world.weeklyImpressions.get(person.id) ?? 0) + deck.length,
      );

      for (let i = 0; i < deck.length; i++) {
        const card = deck[i] as Candidate;
        const host = byId.get(card.hostId) as Person;
        const post = postById.get(card.activityId);
        if (!post || post.settled) continue;

        impressions += 1;
        post.impressions += 1;
        shown.add(card.hostId);

        const decision = joinDecision(
          person, host, world, card.category, card.distanceMiles, i,
        );
        relevanceSum += decision.relevance;

        if (rng() >= decision.probability) continue;

        joins += 1;
        const outcome = resolveJoin(person, host, world, post, rng, now);
        if (!outcome.completed) continue;

        completions += 1;
        if (outcome.repeat) repeats += 1;
        joinersPerHost.set(host.id, (joinersPerHost.get(host.id) ?? 0) + 1);
      }

      world.shownHosts.set(person.id, shown);
    }

    const churn = settleAndChurn(world, byId, now, rng);
    settledPosts += churn.settled;
    emptyPosts += churn.empty;
  }

  const survivingHosts = people.filter((p) => p.active).length;
  const hostCounts = people.map((p) => joinersPerHost.get(p.id) ?? 0);
  const retention = hostRetention(world.posts);

  return {
    arm, users, seed,
    impressions, joins, completions, repeats,
    hostRetention: retention.rate,
    retentionDenominator: retention.eligible,
    retentionAfterEmpty: retention.afterEmpty,
    emptyFirstPostHosts: retention.afterEmptyN,
    tandemsPerUser: completions / users,
    repeatRate: completions > 0 ? repeats / completions : 0,
    zeroJoinerRate: settledPosts > 0 ? emptyPosts / settledPosts : 0,
    survivingHosts,
    survivingHostFraction: survivingHosts / users,
    hostGini: gini(hostCounts),
    deckRelevance: impressions > 0 ? relevanceSum / impressions : 0,
    meanCoverage: mean(coverageSamples),
    meanRegime: mean(regimeSamples),
  };
}

/** Session rate scale, kept alongside the sweep rather than in the frozen model. */
const MODEL_SESSION_RATE = 1.0;

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// ---------------------------------------------------------------------------
// Aggregation and reporting
// ---------------------------------------------------------------------------

interface Aggregate extends Omit<Result, 'seed'> {
  seeds: number;
  /**
   * Standard error of the mean across seeds, for the two headline metrics.
   *
   * Without this a sweep will happily report an "optimum" that is the largest
   * of fifteen noise draws. The §4.4 proximity sweep did exactly that on its
   * first run — it named three different optima at three densities, all of them
   * inside the seed-to-seed spread, and announced that the scaled pair was
   * therefore justified. It is not enough to compute a maximum; you have to know
   * whether the maximum means anything.
   */
  retentionAfterEmptySe: number;
  repeatRateSe: number;
}

/** Standard error of the mean. Returns 0 for fewer than two samples. */
function stderr(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance = xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance / xs.length);
}

function aggregate(results: Result[]): Aggregate {
  const first = results[0] as Result;
  const avg = (pick: (r: Result) => number) => mean(results.map(pick));
  return {
    arm: first.arm,
    users: first.users,
    seeds: results.length,
    impressions: avg((r) => r.impressions),
    joins: avg((r) => r.joins),
    completions: avg((r) => r.completions),
    repeats: avg((r) => r.repeats),
    hostRetention: avg((r) => r.hostRetention),
    retentionDenominator: avg((r) => r.retentionDenominator),
    retentionAfterEmpty: avg((r) => r.retentionAfterEmpty),
    emptyFirstPostHosts: avg((r) => r.emptyFirstPostHosts),
    tandemsPerUser: avg((r) => r.tandemsPerUser),
    repeatRate: avg((r) => r.repeatRate),
    zeroJoinerRate: avg((r) => r.zeroJoinerRate),
    survivingHosts: avg((r) => r.survivingHosts),
    survivingHostFraction: avg((r) => r.survivingHostFraction),
    hostGini: avg((r) => r.hostGini),
    deckRelevance: avg((r) => r.deckRelevance),
    meanCoverage: avg((r) => r.meanCoverage),
    meanRegime: avg((r) => r.meanRegime),
    retentionAfterEmptySe: stderr(results.map((r) => r.retentionAfterEmpty)),
    repeatRateSe: stderr(results.map((r) => r.repeatRate)),
  };
}

const n3 = (x: number) => x.toFixed(3);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function markdownTable(rows: Aggregate[]): string {
  const out: string[] = [];
  out.push('| N | coverage | regime | arm | **host retention** | retention after empty | repeat rate | tandems/user | zero-joiner posts | surviving hosts | host Gini | deck relevance |');
  out.push('|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|');

  const sizes = [...new Set(rows.map((r) => r.users))].sort((a, b) => a - b);
  for (const size of sizes) {
    const group = rows.filter((r) => r.users === size);
    const anchor = group.find((r) => r.arm === 'shipped');
    for (const row of group) {
      const isFirst = row === group[0];
      out.push([
        '',
        `| ${isFirst ? size : ''}`,
        `| ${isFirst ? n3(anchor?.meanCoverage ?? 0) : ''}`,
        `| ${isFirst ? n3(anchor?.meanRegime ?? 0) : ''}`,
        `| ${row.arm === 'shipped' ? `**${row.arm}**` : row.arm}`,
        `| **${n3(row.hostRetention)}**`,
        `| ${n3(row.retentionAfterEmpty)}`,
        `| ${n3(row.repeatRate)}`,
        `| ${n3(row.tandemsPerUser)}`,
        `| ${pct(row.zeroJoinerRate)}`,
        `| ${pct(row.survivingHostFraction)}`,
        `| ${n3(row.hostGini)}`,
        `| ${n3(row.deckRelevance)} |`,
      ].join('').trim());
    }
  }
  return out.join('\n');
}

function csv(rows: Aggregate[]): string {
  const header = [
    'users', 'arm', 'seeds', 'coverage', 'regime',
    'host_retention', 'retention_n', 'retention_after_empty', 'empty_first_post_hosts',
    'repeat_rate', 'tandems_per_user',
    'zero_joiner_rate', 'surviving_host_fraction', 'host_gini', 'deck_relevance',
    'impressions', 'joins', 'completions', 'repeats',
  ].join(',');

  const lines = rows.map((r) => [
    r.users, r.arm, r.seeds,
    n3(r.meanCoverage), n3(r.meanRegime),
    n3(r.hostRetention), Math.round(r.retentionDenominator),
    n3(r.retentionAfterEmpty), Math.round(r.emptyFirstPostHosts),
    n3(r.repeatRate), n3(r.tandemsPerUser),
    n3(r.zeroJoinerRate), n3(r.survivingHostFraction), n3(r.hostGini), n3(r.deckRelevance),
    Math.round(r.impressions), Math.round(r.joins),
    Math.round(r.completions), Math.round(r.repeats),
  ].join(','));

  return [header, ...lines].join('\n');
}

// ---------------------------------------------------------------------------
// §4.4 — the expanded proximity sweep
// ---------------------------------------------------------------------------

/**
 * Sweep w_proximity at both ends of the scaled pair.
 *
 * The question this answers is whether the scaled pair for proximity is
 * EARNING ITS COMPLEXITY. v1.6 declared 0.40 at village and 0.20 at city on the
 * theory that selection matters more when there is more to select from, and
 * then measured the opposite at every density it could see. If one fixed value
 * is near-optimal everywhere, the pair is complexity with no payoff and should
 * collapse to a scalar.
 *
 * Runs the ranker (regime_adaptive), not the shipped config — a proximity
 * weight is a P_join weight, and P_join is a delta on proximity while the
 * ranker is shelved, so there would be nothing to sweep.
 */
async function proximitySweep(opts: Options): Promise<void> {
  const weights: number[] = [];
  for (let w = 0.10; w <= 0.8001; w += 0.05) weights.push(Number(w.toFixed(2)));

  const sizes = opts.sizes.length === 6 ? [40, 150, 600] : opts.sizes;

  console.log('§4.4 expanded proximity sweep');
  console.log(`  w_proximity ${weights[0]} .. ${weights[weights.length - 1]} step 0.05`);
  console.log(`  sizes ${sizes.join(', ')}, seeds ${opts.seeds.join(', ')}, ${opts.days} days`);
  console.log('  arm: regime_adaptive (the shelved ranker, woken via paramsOverride)');
  console.log('');

  const table: string[] = [];
  table.push(`| w_proximity | ${sizes.map((n) => `N=${n} retention-after-empty`).join(' | ')} | ${sizes.map((n) => `N=${n} repeat`).join(' | ')} |`);
  table.push(`|---:|${sizes.map(() => '---:').join('|')}|${sizes.map(() => '---:').join('|')}|`);

  const grid = new Map<string, Aggregate>();

  for (const w of weights) {
    const cells: string[] = [];
    const repeatCells: string[] = [];
    for (const users of sizes) {
      const runs = opts.seeds.map((seed) =>
        runOne('regime_adaptive', users, seed, { ...opts, proximityWeight: w }));
      const agg = aggregate(runs);
      grid.set(`${w}|${users}`, agg);
      cells.push(n3(agg.retentionAfterEmpty));
      repeatCells.push(n3(agg.repeatRate));
    }
    table.push(`| ${w.toFixed(2)} | ${cells.join(' | ')} | ${repeatCells.join(' | ')} |`);
    console.log(`  w=${w.toFixed(2)}  retention-after-empty ${cells.join('  ')}`);
  }

  console.log(`\n${table.join('\n')}\n`);

  // -------------------------------------------------------------------------
  // The verdict, gated on the noise floor.
  //
  // A maximum over fifteen noisy draws is not an optimum. Before naming one,
  // check that the spread across w is large relative to the seed-to-seed spread
  // at fixed w — and if it is not, say the optimum is UNIDENTIFIABLE rather than
  // reporting the largest noise draw as a finding.
  // -------------------------------------------------------------------------
  const NOISE_MULTIPLE = 2;   // best must clear the median by 2 standard errors

  console.log('');
  for (const users of sizes) {
    const cells = weights
      .map((w) => ({ w, agg: grid.get(`${w}|${users}`) }))
      .filter((x): x is { w: number; agg: Aggregate } => x.agg !== undefined);
    if (cells.length === 0) continue;

    const values = cells.map((c) => c.agg.retentionAfterEmpty).sort((a, b) => a - b);
    const median = values[Math.floor(values.length / 2)] as number;
    const best = cells.reduce((a, b) =>
      b.agg.retentionAfterEmpty > a.agg.retentionAfterEmpty ? b : a);
    const noise = mean(cells.map((c) => c.agg.retentionAfterEmptySe));
    const margin = best.agg.retentionAfterEmpty - median;

    if (margin > NOISE_MULTIPLE * noise) {
      console.log(
        `N=${users}: optimum w_proximity ${best.w.toFixed(2)} ` +
        `(${n3(best.agg.retentionAfterEmpty)}, ${n3(margin)} above median, ` +
        `noise +/-${n3(noise)})`,
      );
    } else {
      console.log(
        `N=${users}: OPTIMUM UNIDENTIFIABLE on retention. Best is w=${best.w.toFixed(2)} ` +
        `at ${n3(best.agg.retentionAfterEmpty)}, only ${n3(margin)} above the median ` +
        `against a seed noise of +/-${n3(noise)}. More seeds, or a different metric.`,
      );
    }

    // Monotonicity on repeat rate is checkable even when point estimates are
    // noisy: fifteen points trending one way is not fifteen coin flips.
    const repeats = cells.map((c) => c.agg.repeatRate);
    const rises = repeats.slice(1).filter((v, i) => v > (repeats[i] as number)).length;
    console.log(
      `           repeat rate rises at ${rises}/${repeats.length - 1} steps ` +
      `(${n3(repeats[0] as number)} at w=${weights[0]?.toFixed(2)} -> ` +
      `${n3(repeats[repeats.length - 1] as number)} at w=${weights[weights.length - 1]?.toFixed(2)})`,
    );
  }

  if (opts.mdPath) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(opts.mdPath, `${table.join('\n')}\n`);
    console.log(`wrote ${opts.mdPath}`);
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs();

  if (opts.proximitySweep) {
    await proximitySweep(opts);
    return;
  }

  console.log('tandem-ranking density sweep');
  console.log(`  sizes ${opts.sizes.join(', ')}`);
  console.log(`  seeds ${opts.seeds.join(', ')}, ${opts.days} days, deck ${opts.deckSize}`);
  console.log(`  PRIMARY METRIC: host retention (repeat rate is secondary — see the header)`);
  if (opts.exhaustionOn) console.log('  §4.2 COUNTERFACTUAL: exhaustion re-enabled at v1.6 rates');
  if (opts.proximityWeight !== null) console.log(`  w_proximity forced to ${opts.proximityWeight}`);
  console.log('');
  for (const arm of opts.arms) console.log(`  ${arm.padEnd(19)} ${ARM_NOTES[arm]}`);
  console.log('');

  const aggregates: Aggregate[] = [];

  for (const users of opts.sizes) {
    for (const arm of opts.arms) {
      const runs = opts.seeds.map((seed) => runOne(arm, users, seed, opts));
      aggregates.push(aggregate(runs));
    }
    const at = (arm: Arm) => aggregates.find((x) => x.users === users && x.arm === arm);
    const shipped = at('shipped');
    const random = at('random');
    console.log(
      `  N=${String(users).padStart(4)}  coverage ${n3(shipped?.meanCoverage ?? 0).padStart(6)}` +
      `  regime ${n3(shipped?.meanRegime ?? 0)}` +
      `  shipped retention ${n3(shipped?.hostRetention ?? 0)}` +
      `  vs random ${n3(random?.hostRetention ?? 0)}`,
    );
  }

  const table = markdownTable(aggregates);
  console.log(`\n${table}\n`);

  // §4.3: losing to random is a BUG, not a design failure. Say so loudly.
  for (const users of opts.sizes) {
    const random = aggregates.find((x) => x.users === users && x.arm === 'random');
    if (!random) continue;
    for (const arm of ['shipped', 'regime_adaptive', 'full_ranker_fixed'] as Arm[]) {
      const row = aggregates.find((x) => x.users === users && x.arm === arm);
      if (row && row.hostRetention < random.hostRetention) {
        console.log(
          `!! BUG SUSPECTED: ${arm} loses to random on host retention at N=${users} ` +
          `(${n3(row.hostRetention)} vs ${n3(random.hostRetention)}). ` +
          'Investigate before reporting anything else.',
        );
      }
    }
  }

  if (opts.csvPath || opts.mdPath) {
    const { writeFileSync } = await import('node:fs');
    if (opts.csvPath) {
      writeFileSync(opts.csvPath, `${csv(aggregates)}\n`);
      console.log(`wrote ${opts.csvPath}`);
    }
    if (opts.mdPath) {
      writeFileSync(opts.mdPath, `${table}\n`);
      console.log(`wrote ${opts.mdPath}`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
