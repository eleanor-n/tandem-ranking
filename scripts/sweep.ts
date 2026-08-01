/**
 * The density sweep — v1.6 §4.
 *
 * Runs four arms against the frozen population model in scripts/population.ts
 * across a range of population sizes, holding posts-per-user and metro area
 * fixed so that coverage rises with N as it would in reality.
 *
 *   npm run sweep
 *   npm run sweep -- --sizes 20,40,80 --seeds 1,2 --days 120
 *   npm run sweep -- --csv results.csv --md results.md
 *
 * ---------------------------------------------------------------------------
 * How to read the output, and how much to believe it
 *
 * The population model was authored alongside the ranker it grades, so the two
 * have correlated blind spots. A result that FAVOURS regime_adaptive is weak
 * evidence — it may only mean the two models agree with each other. A result
 * AGAINST it is strong evidence, because it survived that correlation.
 *
 * The expected shape, stated in advance:
 *   - at N=40, regime_adaptive should approximately MATCH proximity_only. It is
 *     nearly the same algorithm there. A large win at N=40 indicates a bug or a
 *     leak of hidden state, not a good ranker.
 *   - at N>=300, regime_adaptive should beat full_ranker_fixed decisively.
 *   - if regime_adaptive loses to proximity_only at N=40 by more than ~3%, the
 *     village parameters are still too clever. Report it; do not tune until it
 *     passes.
 */

import { rank } from '../src/ranking/core/rank.js';
import { computeRegime } from '../src/ranking/core/regime.js';
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
  type World,
} from './population.js';
import type { Candidate } from '../src/ranking/core/types.js';

// ---------------------------------------------------------------------------
// Arms
// ---------------------------------------------------------------------------

type Arm = 'regime_adaptive' | 'full_ranker_fixed' | 'proximity_only' | 'random';

const ARMS: Arm[] = ['regime_adaptive', 'full_ranker_fixed', 'proximity_only', 'random'];

const ARM_NOTES: Record<Arm, string> = {
  regime_adaptive: 'this build — density-continuous parameters',
  full_ranker_fixed: 'v1.5 constants, regime pinned to 1 (no adaptation)',
  proximity_only: 'nearest first, taste-blind — the v1.5 giant-killer',
  random: 'the floor',
};

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
}

function parseArgs(): Options {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | null => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? (argv[i + 1] as string) : null;
  };
  const nums = (raw: string | null, fallback: number[]): number[] =>
    raw ? raw.split(',').map((x) => Number(x.trim())).filter(Number.isFinite) : fallback;

  return {
    sizes: nums(flag('--sizes'), [20, 40, 80, 150, 300, 600, 1200, 2500]),
    seeds: nums(flag('--seeds'), [1, 2, 3]),
    days: Number(flag('--days') ?? 120),
    deckSize: Number(flag('--deck') ?? CONSTANTS.slate.deckSize),
    csvPath: flag('--csv'),
    mdPath: flag('--md'),
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

  /** completions / distinct users. */
  tandemsPerUser: number;
  /** repeats / completions. The north star. */
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
      // The sim always has at least the current week once impressions exist.
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

function runOne(arm: Arm, users: number, seed: number, opts: Options): Result {
  const rng = seededRng(`${arm}:${users}`, seed);
  // Population is built from a seed that does NOT include the arm, so every arm
  // faces an identical world.
  const people = buildPopulation(users, seededRng('population', seed * 1000 + users));
  const byId = new Map(people.map((p) => [p.id, p]));
  const world = emptyWorld();

  // Onboarding answers become interest events at signup, as the backfill would.
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

  for (let day = 0; day < opts.days; day++) {
    const now = START + day * DAY;

    // Weekly impression counters reset, feeding the coverage estimate.
    if (day % 7 === 0) world.weeklyImpressions.clear();

    for (const person of people) {
      if (postsToday(person, rng)) createPost(world, person, now, rng);
    }

    for (const person of people) {
      if (rng() > person.engagement * MODEL_SESSION_RATE) continue;

      const pool = candidatesFor(world, person, byId, now);
      if (pool.length === 0) continue;

      let deck: Candidate[];

      if (arm === 'regime_adaptive' || arm === 'full_ranker_fixed') {
        const regime = arm === 'full_ranker_fixed'
          ? 1                                   // v1.5 constants, no adaptation
          : regimeFor(world, person.id, pool.length);

        if (arm === 'regime_adaptive') {
          regimeSamples.push(regime);
          coverageSamples.push(
            pool.length / (world.weeklyImpressions.get(person.id)
              || CONSTANTS.regime.defaultCardsViewedPerWeek),
          );
        }

        const result = rank({
          viewer: viewerFor(world, person),
          candidates: pool,
          interestEvents: world.interestEvents.get(person.id) ?? [],
          sessionId: `d${day}`,
          now,
          regime,
        }, { deckSize: opts.deckSize });

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
        const post = world.posts.find((p) => p.id === card.activityId);
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

  return {
    arm, users, seed,
    impressions, joins, completions, repeats,
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
    tandemsPerUser: avg((r) => r.tandemsPerUser),
    repeatRate: avg((r) => r.repeatRate),
    zeroJoinerRate: avg((r) => r.zeroJoinerRate),
    survivingHosts: avg((r) => r.survivingHosts),
    survivingHostFraction: avg((r) => r.survivingHostFraction),
    hostGini: avg((r) => r.hostGini),
    deckRelevance: avg((r) => r.deckRelevance),
    meanCoverage: avg((r) => r.meanCoverage),
    meanRegime: avg((r) => r.meanRegime),
  };
}

const n3 = (x: number) => x.toFixed(3);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function markdownTable(rows: Aggregate[]): string {
  const out: string[] = [];
  out.push('| N | coverage | regime | arm | repeat rate | tandems/user | zero-joiner posts | surviving hosts | host Gini | deck relevance |');
  out.push('|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|');

  const sizes = [...new Set(rows.map((r) => r.users))].sort((a, b) => a - b);
  for (const size of sizes) {
    const group = rows.filter((r) => r.users === size);
    const adaptive = group.find((r) => r.arm === 'regime_adaptive');
    for (const row of group) {
      const isAdaptive = row.arm === 'regime_adaptive';
      out.push([
        '',
        `| ${isAdaptive ? size : ''}`,
        `| ${isAdaptive ? n3(adaptive?.meanCoverage ?? 0) : ''}`,
        `| ${isAdaptive ? n3(adaptive?.meanRegime ?? 0) : ''}`,
        `| ${isAdaptive ? `**${row.arm}**` : row.arm}`,
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
    'users', 'arm', 'seeds', 'coverage', 'regime', 'repeat_rate', 'tandems_per_user',
    'zero_joiner_rate', 'surviving_host_fraction', 'host_gini', 'deck_relevance',
    'impressions', 'joins', 'completions', 'repeats',
  ].join(',');

  const lines = rows.map((r) => [
    r.users, r.arm, r.seeds,
    n3(r.meanCoverage), n3(r.meanRegime), n3(r.repeatRate), n3(r.tandemsPerUser),
    n3(r.zeroJoinerRate), n3(r.survivingHostFraction), n3(r.hostGini), n3(r.deckRelevance),
    Math.round(r.impressions), Math.round(r.joins),
    Math.round(r.completions), Math.round(r.repeats),
  ].join(','));

  return [header, ...lines].join('\n');
}

/**
 * The coverage at which regime_adaptive overtakes proximity_only on the north
 * star, found by linear interpolation between the bracketing population sizes.
 * Reported as the number that actually matters operationally: it says at what
 * density the adaptation starts paying for itself.
 */
function crossover(rows: Aggregate[]): { users: number; coverage: number } | null {
  const sizes = [...new Set(rows.map((r) => r.users))].sort((a, b) => a - b);
  let previous: { size: number; delta: number; coverage: number } | null = null;

  for (const size of sizes) {
    const a = rows.find((r) => r.users === size && r.arm === 'regime_adaptive');
    const p = rows.find((r) => r.users === size && r.arm === 'proximity_only');
    if (!a || !p) continue;

    const delta = a.repeatRate - p.repeatRate;
    if (previous && previous.delta < 0 && delta >= 0) {
      const t = -previous.delta / (delta - previous.delta);
      return {
        users: Math.round(previous.size + t * (size - previous.size)),
        coverage: previous.coverage + t * (a.meanCoverage - previous.coverage),
      };
    }
    previous = { size, delta, coverage: a.meanCoverage };
  }
  return null;
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs();

  console.log('tandem-ranking density sweep');
  console.log(`  sizes ${opts.sizes.join(', ')}`);
  console.log(`  seeds ${opts.seeds.join(', ')}, ${opts.days} days, deck ${opts.deckSize}`);
  console.log('');
  for (const arm of ARMS) console.log(`  ${arm.padEnd(19)} ${ARM_NOTES[arm]}`);
  console.log('');

  const aggregates: Aggregate[] = [];

  for (const users of opts.sizes) {
    for (const arm of ARMS) {
      const runs = opts.seeds.map((seed) => runOne(arm, users, seed, opts));
      aggregates.push(aggregate(runs));
    }
    const a = aggregates.find((x) => x.users === users && x.arm === 'regime_adaptive');
    const p = aggregates.find((x) => x.users === users && x.arm === 'proximity_only');
    const delta = a && p && p.repeatRate > 0
      ? ((a.repeatRate / p.repeatRate - 1) * 100).toFixed(0)
      : '—';
    console.log(
      `  N=${String(users).padStart(4)}  coverage ${n3(a?.meanCoverage ?? 0).padStart(6)}` +
      `  regime ${n3(a?.meanRegime ?? 0)}  adaptive vs proximity ${delta}%`,
    );
  }

  const table = markdownTable(aggregates);
  console.log(`\n${table}\n`);

  const cross = crossover(aggregates);
  if (cross) {
    console.log(`crossover: regime_adaptive overtakes proximity_only at N≈${cross.users} (coverage ≈ ${n3(cross.coverage)})`);
  } else {
    const smallest = aggregates.find((r) => r.arm === 'regime_adaptive');
    const smallestP = aggregates.find((r) => r.arm === 'proximity_only');
    const ahead = smallest && smallestP && smallest.repeatRate >= smallestP.repeatRate;
    console.log(ahead
      ? 'crossover: none — regime_adaptive is ahead at every size tested.'
      : 'crossover: none — regime_adaptive never overtakes proximity_only in this range.');
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
