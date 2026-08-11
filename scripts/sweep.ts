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

import { appendFileSync, writeFileSync } from 'node:fs';
import { getHeapStatistics } from 'node:v8';

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
  | 'ranker_repaired'
  | 'ranker_no_funnel'
  | 'proximity_only'
  | 'random';

const ARMS: Arm[] = [
  'shipped', 'ranker_repaired', 'ranker_no_funnel', 'proximity_only', 'random',
];

const ARM_NOTES: Record<Arm, string> = {
  shipped: 'v1.8 as it ships — proximity x demand x session penalties, ranker shelved',
  ranker_repaired: 'the SHELVED ranker with the v1.8 funnel repair (§1.2-1.4)',
  ranker_no_funnel: 'the D3 ablation: funnelExponent 0, funnel factors removed entirely',
  proximity_only: 'nearest first, taste-blind — the v1.5 giant-killer',
  random: 'the floor. If anything loses to this it is a bug, not a design failure',
};

/**
 * WHY `regime_adaptive` AND `full_ranker_fixed` ARE GONE.
 *
 * v1.8 §2 collapsed the density pairs, so `resolveParams` ignores the regime and
 * those two arms became the same configuration as each other. Keeping both would
 * have reported one number twice and implied a comparison that no longer exists.
 *
 * WHAT CANNOT BE MEASURED HERE, stated rather than glossed: the PRE-REPAIR
 * funnel is not reachable through `paramsOverride`. §1.3 removed P_complete from
 * the product structurally and §1.2 rewrote P_accept's shape, so no parameter
 * setting reconstructs v1.7's arithmetic. The comparison against it is made
 * against the numbers recorded in DIAGNOSTICS.md §D3, which came from the same
 * frozen population model, the same seeds, and (at regime 1) the same
 * parameter values the collapse now uses — so they are directly comparable.
 * That is a claim worth stating explicitly because it is doing real work.
 */

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
    ...(opts.rho !== null ? { hostAcceptDamping: opts.rho } : {}),
    ...(opts.repeatableContextWeight !== null
      ? { repeatableContextWeight: opts.repeatableContextWeight } : {}),
  };

  if (arm === 'shipped') {
    // Shipped configuration, plus whatever the counterfactual flags ask for.
    return tweaks;
  }

  const base = resolveParams(regime);
  return {
    ...base,
    // The D3 ablation arm: funnel factors raised to the identity.
    ...(arm === 'ranker_no_funnel' ? { funnelExponent: 0 } : {}),
    ...tweaks,
    ...(opts.proximityWeight !== null
      ? { pJoin: pJoinWithProximity(base, opts.proximityWeight) }
      : {}),
  };
}

/** §4.2: the v1.6 exhaustion rate, for the counterfactual arm only. */
function reactivatedExhaustion(_regime: number): number {
  return CONSTANTS.collapsed.exhaustionRateWhenReactivated;
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
  /**
   * Where the PER-SEED rows are streamed, one line per (arm, seed, size) as it
   * completes. Defaults to `<csvPath>.rows.csv` when `--csv` is given.
   *
   * This is a SEPARATE artifact from `--csv`, and deliberately so. `--csv` holds
   * aggregates — one row per (size, arm), averaged over seeds, with the `se_*`
   * columns `podium.ts` reads. An aggregate cannot be written before its last
   * seed finishes, so it cannot be the thing that survives a kill. The rows file
   * can: it is the raw material the aggregate is computed from, so a killed run
   * loses no simulation, and the aggregate for any completed cell can be
   * recomputed from it.
   */
  rowsPath: string | null;
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
  /** §3.3. rho — the host-term damping exponent inside P_accept. */
  rho: number | null;
  /** §3.4. 0 drops the dampened repeatable-context term entirely. */
  repeatableContextWeight: number | null;
  /** Restrict to a subset of arms. An ablation rarely needs all five. */
  arms: Arm[];
}

function parseArgs(): Options {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | null => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? (argv[i + 1] as string) : null;
  };
  // `Number('')` is 0, not NaN, so `.filter(Number.isFinite)` lets an empty
  // field through as a silent zero. `seq -s, 1 24` emits a trailing comma; that
  // turned a 24-seed run into a 25-seed run with an extra seed 0 and said
  // nothing. Throw instead — a malformed list is a typo, and continuing with a
  // quietly different experiment is the worst available response to a typo.
  const nums = (raw: string | null, fallback: number[]): number[] => {
    if (raw === null) return fallback;
    return raw.split(',').map((x) => {
      const t = x.trim();
      const n = Number(t);
      if (t === '' || !Number.isFinite(n)) {
        throw new Error(`bad numeric list ${JSON.stringify(raw)}: field ${JSON.stringify(x)}`);
      }
      return n;
    });
  };

  // A flag whose value is itself a flag means the value was swallowed — almost
  // always an unquoted shell variable that did not word-split. zsh does not
  // split unquoted expansions, so `$OPTS` arrives as ONE argv entry and every
  // flag inside it is silently ignored. That is how a 25-seed run intended to
  // pin rho=0.5 ran at whatever constants.ts happened to say.
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith('--') && a.includes(' ')) {
      throw new Error(
        `argument ${JSON.stringify(a)} contains a space — it was passed as one ` +
        'argument instead of several. In zsh, unquoted "$VAR" does not ' +
        'word-split; use an array (opts=(--rho 0.5); cmd "${opts[@]}") or write ' +
        'the flags out inline.',
      );
    }
  }

  const weight = flag('--proximity-weight');
  const csvPath = flag('--csv');
  const rowsPath = flag('--rows')
    ?? (csvPath === null ? null : `${csvPath.replace(/\.csv$/, '')}.rows.csv`);

  return {
    sizes: nums(flag('--sizes'), [20, 40, 80, 150, 300, 600]),
    seeds: nums(flag('--seeds'), [1, 2, 3]),
    days: Number(flag('--days') ?? 120),
    deckSize: Number(flag('--deck') ?? CONSTANTS.slate.deckSize),
    csvPath,
    mdPath: flag('--md'),
    rowsPath,
    exhaustionOn: flag('--exhaustion') === 'on',
    proximityWeight: weight === null ? null : Number(weight),
    proximitySweep: argv.includes('--proximity-sweep'),
    funnelExponent: flag('--funnel-exponent') === null
      ? null : Number(flag('--funnel-exponent')),
    demandWeight: flag('--demand-weight') === null
      ? null : Number(flag('--demand-weight')),
    rho: flag('--rho') === null ? null : Number(flag('--rho')),
    repeatableContextWeight: flag('--repeatable-context') === null
      ? null : Number(flag('--repeatable-context')),
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

/** The per-seed row columns, in order. Both the header and the row derive from this. */
const ROW_FIELDS = [
  'impressions', 'joins', 'completions', 'repeats',
  'hostRetention', 'retentionDenominator', 'retentionAfterEmpty', 'emptyFirstPostHosts',
  'tandemsPerUser', 'repeatRate', 'zeroJoinerRate',
  'survivingHosts', 'survivingHostFraction', 'hostGini', 'deckRelevance',
  'meanCoverage', 'meanRegime',
] as const satisfies readonly (keyof Result)[];

/**
 * Streams one CSV line per completed (arm, seed, size).
 *
 * WHY SYNCHRONOUS, UNBUFFERED APPENDS.
 *
 * A 12-seed N=600 sweep is an hour of simulation. It used to hold every result
 * in memory and write once at the end, so the run had a single point at which
 * it became durable, and a process that died before reaching it — memory
 * exhaustion, a stray Ctrl-C, a laptop lid — destroyed every completed cell with
 * it. That is not a performance problem, it is a data-loss problem: the
 * expensive thing is the simulation, and it was the only thing not being saved.
 *
 * `appendFileSync` returns after the write syscall, so a row that this function
 * has returned from is on disk and survives SIGKILL. Buffering it through a
 * stream would put the last rows back in the process's memory, which is the
 * exact thing being defended against.
 */
class RowSink {
  private readonly path: string;
  private started = false;
  private written = 0;

  constructor(path: string) {
    this.path = path;
  }

  append(r: Result): void {
    const n6 = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(6));
    if (!this.started) {
      writeFileSync(this.path, `${['users', 'arm', 'seed', ...ROW_FIELDS].join(',')}\n`);
      this.started = true;
    }
    appendFileSync(
      this.path,
      `${[r.users, r.arm, r.seed, ...ROW_FIELDS.map((f) => n6(r[f]))].join(',')}\n`,
    );
    this.written += 1;
  }

  get count(): number {
    return this.written;
  }
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

const RANKED_ARMS = new Set<Arm>(['shipped', 'ranker_repaired', 'ranker_no_funnel']);

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

  /**
   * Running sums, not sample arrays.
   *
   * These used to be two `number[]` pushed once per person per session-day. At
   * N=600 over 120 days that is up to 72,000 boxed doubles per array, per run,
   * retained for the whole run purely so `mean()` could be called on them at the
   * end. Only the mean is ever read, and a mean needs a sum and a count.
   *
   * Arithmetically identical — same addends, same order, same divisor.
   */
  let coverageSum = 0;
  let coverageN = 0;
  let regimeSum = 0;
  let regimeN = 0;

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
        // Still driven through the real coverage pipeline so the reported
        // coverage/regime columns remain meaningful, even though §2 collapsed
        // the pairs and nothing downstream reads the scalar any more.
        const regime = regimeFor(world, person.id, pool.length);

        if (arm === 'shipped') {
          regimeSum += regime;
          regimeN += 1;
          coverageSum += pool.length / (world.weeklyImpressions.get(person.id)
            || CONSTANTS.regime.defaultCardsViewedPerWeek);
          coverageN += 1;
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
    meanCoverage: coverageN > 0 ? coverageSum / coverageN : 0,
    meanRegime: regimeN > 0 ? regimeSum / regimeN : 0,
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

/**
 * The metrics that get a standard error. Everything a conclusion is ever drawn
 * from belongs in here.
 *
 * v1.9 NOTE — this list used to be two entries long, and `hostRetention` was
 * not one of them. The §4.4 proximity sweep had already demonstrated the failure
 * (three densities, three "optima", all inside the seed-to-seed spread), the
 * 2 SE gate was built in response, and then the gate was wired to
 * `retentionAfterEmpty` while every headline table in DIAGNOSTICS.md ranked arms
 * by `hostRetention` — a metric with no error bar computed anywhere in the file.
 *
 * The comparison table in the v1.8 report ordered four arms across a 0.040 span
 * on exactly that basis. Hence: every metric, or the gate is decorative.
 */
const SE_METRICS = [
  'hostRetention',
  'retentionAfterEmpty',
  'repeatRate',
  'zeroJoinerRate',
  'survivingHostFraction',
  'hostGini',
  'deckRelevance',
  'tandemsPerUser',
] as const;

type SeMetric = (typeof SE_METRICS)[number];

interface Aggregate extends Omit<Result, 'seed'> {
  seeds: number;
  /** Standard error of the mean across seeds, per headline metric. */
  se: Record<SeMetric, number>;
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
    se: Object.fromEntries(
      SE_METRICS.map((m) => [m, stderr(results.map((r) => r[m]))]),
    ) as Record<SeMetric, number>,
  };
}

/**
 * Is `a` above `b` by more than the noise?
 *
 * Two-sample: the SE of a difference of independent means is the root of the
 * sum of squares, not either one alone. Comparing a gap against a single arm's
 * SE understates the bar by up to a factor of root two, which over a 0.011 gap
 * is the whole question.
 *
 * Paired seeds would be tighter — every arm runs the same population from the
 * same seed, so the seed effect is common and could be differenced out. This is
 * deliberately the unpaired, more conservative test: the paired version would
 * need the per-seed vectors carried through aggregation, and a separation claim
 * should not rest on the more generous of two available tests.
 */
function separates(a: Aggregate, b: Aggregate, metric: SeMetric, bar = 2): boolean {
  const gap = Math.abs(a[metric] - b[metric]);
  const noise = Math.sqrt(a.se[metric] ** 2 + b.se[metric] ** 2);
  if (noise === 0) return gap > 0;
  return gap > bar * noise;
}

const n3 = (x: number) => x.toFixed(3);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
/** `0.970 ±0.004`. The bar a gap has to clear is 2x this, and two-sample. */
const pm = (x: number, se: number) => `${x.toFixed(3)} ±${se.toFixed(3)}`;
const pmPct = (x: number, se: number) =>
  `${(x * 100).toFixed(1)}% ±${(se * 100).toFixed(1)}`;

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
        `| **${pm(row.hostRetention, row.se.hostRetention)}**`,
        `| ${pm(row.retentionAfterEmpty, row.se.retentionAfterEmpty)}`,
        `| ${pm(row.repeatRate, row.se.repeatRate)}`,
        `| ${n3(row.tandemsPerUser)}`,
        `| ${pmPct(row.zeroJoinerRate, row.se.zeroJoinerRate)}`,
        `| ${pct(row.survivingHostFraction)}`,
        `| ${pm(row.hostGini, row.se.hostGini)}`,
        `| ${pm(row.deckRelevance, row.se.deckRelevance)} |`,
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
    ...SE_METRICS.map((m) => `se_${m}`),
  ].join(',');

  // SIX decimals, not three.
  //
  // The CSV is a data artifact that other tools do arithmetic on; the markdown
  // table is the display artifact. Rounding the data to display precision meant
  // `podium.ts` — comparing a 0.022 gap against a 0.0215 bar — was deciding
  // separation in a digit the file did not carry, and disagreed with the sweep's
  // own in-memory podium on that pair. Same defect as the one this whole pass is
  // about: a comparison reported at a precision that cannot support it.
  const n6 = (x: number) => x.toFixed(6);

  const lines = rows.map((r) => [
    r.users, r.arm, r.seeds,
    n3(r.meanCoverage), n3(r.meanRegime),
    n6(r.hostRetention), Math.round(r.retentionDenominator),
    n6(r.retentionAfterEmpty), Math.round(r.emptyFirstPostHosts),
    n6(r.repeatRate), n6(r.tandemsPerUser),
    n6(r.zeroJoinerRate), n6(r.survivingHostFraction), n6(r.hostGini), n6(r.deckRelevance),
    Math.round(r.impressions), Math.round(r.joins),
    Math.round(r.completions), Math.round(r.repeats),
    ...SE_METRICS.map((m) => n6(r.se[m])),
  ].join(','));

  return [header, ...lines].join('\n');
}

// ---------------------------------------------------------------------------
// The podium
// ---------------------------------------------------------------------------

/**
 * Rank the arms on a metric and say WHICH ADJACENT PAIRS ARE ACTUALLY ORDERED.
 *
 * A sorted list of point estimates always looks like a ranking. This prints the
 * ranking with the separations marked, so that "best" is a claim with a test
 * behind it rather than a consequence of sorting.
 *
 * Adjacent-pair testing is the right granularity: if A does not separate from B
 * and B does not separate from C, the podium's top is a three-way tie regardless
 * of whether A separates from C.
 */
function podium(rows: Aggregate[], metric: SeMetric, higherIsBetter = true): string[] {
  const out: string[] = [];
  const sorted = rows.slice().sort((a, b) =>
    higherIsBetter ? b[metric] - a[metric] : a[metric] - b[metric]);

  out.push(`  ${metric} @ N=${sorted[0]?.users}, ${sorted[0]?.seeds} seeds ` +
    `(${higherIsBetter ? 'higher' : 'lower'} is better)`);

  // Walk down the order, breaking it into blocks of mutually-unseparated arms.
  const blocks: Aggregate[][] = [];
  let block: Aggregate[] = [];
  for (const row of sorted) {
    const prev = block[block.length - 1];
    if (prev && separates(prev, row, metric)) {
      blocks.push(block);
      block = [];
    }
    block.push(row);
  }
  if (block.length > 0) blocks.push(block);

  let place = 1;
  for (const b of blocks) {
    const tied = b.length > 1;
    for (const row of b) {
      out.push(
        `    ${tied ? `=${place}` : ` ${place}`}  ${row.arm.padEnd(18)} ` +
        `${pm(row[metric], row.se[metric])}`,
      );
    }
    if (tied) {
      out.push(`         ^ ${b.length}-way tie: no adjacent gap clears 2 SE`);
    }
    place += b.length;
  }

  const top = blocks[0] as Aggregate[];
  out.push('');
  if (top.length === 1) {
    out.push(`    VERDICT: ${top[0]?.arm} is best, separated from the field.`);
  } else if (top.length === sorted.length) {
    out.push('    VERDICT: NOT IDENTIFIED. No arm separates from any other on ' +
      'this metric. Nothing about the ordering is supported.');
  } else {
    out.push(`    VERDICT: NOT IDENTIFIED at the top. ` +
      `${top.map((r) => r.arm).join(', ')} are tied for first; ` +
      `the winner is not determined by this data.`);
  }
  return out;
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
  console.log('  arm: ranker_repaired (the shelved ranker, woken via paramsOverride)');
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
        runOne('ranker_repaired', users, seed, { ...opts, proximityWeight: w }));
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
    const noise = mean(cells.map((c) => c.agg.se.retentionAfterEmpty));
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
    writeFileSync(opts.mdPath, `${table.join('\n')}\n`);
    console.log(`wrote ${opts.mdPath}`);
  }
}

// ---------------------------------------------------------------------------
// Running one cell without losing it
// ---------------------------------------------------------------------------

/**
 * Fraction of the V8 heap limit past which the next run is not attempted.
 *
 * 0.85 rather than something nearer 1.0 because the check happens BETWEEN runs
 * and a run allocates as it goes: the useful question is not "is the heap full
 * now" but "is there room for another one of these", and a sweep cell that has
 * just used 15% of the heap will use about that much again.
 */
const HEAP_ABORT_FRACTION = 0.85;

const mb = (bytes: number) => `${Math.round(bytes / 1048576)} MB`;

/**
 * Run one (arm, seed, size) cell, stream it, and refuse to die quietly.
 *
 * THE FAILURE THIS REPLACES. At 12 seeds x N=600 the process stopped, printed
 * nothing, and left no file. There was no error, no exit code worth reading, and
 * no partial output — an hour of simulation produced the same artifact as never
 * having run it, and nothing on the terminal said which cell it had reached.
 *
 * Three defences, in the order they fire:
 *
 *   1. A BREADCRUMB to stderr before the cell starts. A V8 heap abort is a
 *      SIGABRT from inside the allocator — it cannot be caught, no handler runs,
 *      and no `finally` executes. The only thing that survives it is what was
 *      already written. So the cell about to run is announced before it runs,
 *      and a hard abort leaves its identity as the last line on the terminal.
 *   2. A CATCH around the run, reporting arm/seed/size and exiting nonzero.
 *      Catches RangeError from an oversized allocation and anything thrown by
 *      the model.
 *   3. A HEAP CHECK after the run. This is the one that actually converts the
 *      silent death into a message: rather than letting the next cell walk into
 *      the allocator and abort, it notices there is no room left for another one
 *      and exits first, while a `console.error` still works.
 *
 * The streamed row is written before any of that matters, so every cell that
 * finished is on disk regardless of how the process ends.
 */
function runSafely(
  arm: Arm, users: number, seed: number, opts: Options, sink: RowSink | null,
): Result {
  const heap = getHeapStatistics();
  process.stderr.write(
    `    [run] arm=${arm} N=${users} seed=${seed} ` +
    `heap=${mb(heap.used_heap_size)}/${mb(heap.heap_size_limit)}\n`,
  );

  let result: Result;
  try {
    result = runOne(arm, users, seed, opts);
  } catch (error) {
    console.error(
      `\nSWEEP FAILED at arm=${arm} N=${users} seed=${seed}\n` +
      `  ${error instanceof Error ? error.stack : String(error)}\n` +
      (sink
        ? `  ${sink.count} completed row(s) are on disk at ${opts.rowsPath} and are not lost.\n`
        : '  No --csv/--rows was given, so nothing was streamed. Pass one for long runs.\n'),
    );
    process.exit(1);
  }

  sink?.append(result);

  const after = getHeapStatistics();
  if (after.used_heap_size > HEAP_ABORT_FRACTION * after.heap_size_limit) {
    console.error(
      `\nSWEEP STOPPING: out of heap after arm=${arm} N=${users} seed=${seed}\n` +
      `  used ${mb(after.used_heap_size)} of a ${mb(after.heap_size_limit)} limit ` +
      `(over the ${HEAP_ABORT_FRACTION} abort fraction).\n` +
      `  The next cell would very likely abort inside the allocator, which prints ` +
      'nothing at all. Stopping here so this message exists.\n' +
      (sink
        ? `  ${sink.count} completed row(s) are on disk at ${opts.rowsPath}.\n`
        : '  Nothing was streamed — pass --csv or --rows so a stop like this keeps its work.\n') +
      '  Re-run with a bigger heap, e.g.\n' +
      `    NODE_OPTIONS=--max-old-space-size=8192 npm run sweep -- --sizes ${users} ...\n` +
      '  or split the seed list across invocations and merge with `npm run podium`.\n',
    );
    process.exit(1);
  }

  return result;
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

  // EFFECTIVE CONFIG, always printed.
  //
  // A flag left unset silently inherits constants.ts. That is fine until
  // constants.ts changes underneath a long run — which happened during the v1.9
  // pass: a 24-seed sweep was launched, `hostAcceptDamping` was edited an hour
  // later as part of the §1.5 abort, and the ablation invocations that had not
  // started yet would have picked up the new value and been quietly compared
  // against arms measured at the old one. Nothing in the output would have said
  // so. Now it does.
  const eff = (v: number | null, fallback: number) =>
    v === null ? `${fallback} (from constants)` : `${v} (pinned)`;
  console.log('');
  console.log('  effective funnel config:');
  console.log(`    rho                      ${eff(opts.rho, CONSTANTS.features.acceptance.hostAcceptDamping)}`);
  console.log(`    repeatableContextWeight  ${eff(opts.repeatableContextWeight, CONSTANTS.score.rRepeat.repeatableContext)}`);
  console.log(`    demandWeight             ${eff(opts.demandWeight, CONSTANTS.collapsed.demandWeight)}`);
  console.log(`    funnelExponent           ${eff(opts.funnelExponent, CONSTANTS.shipping.funnelExponent)}`);
  console.log('');
  for (const arm of opts.arms) console.log(`  ${arm.padEnd(19)} ${ARM_NOTES[arm]}`);
  console.log('');

  const sink = opts.rowsPath === null ? null : new RowSink(opts.rowsPath);
  if (sink) {
    console.log(`  streaming per-seed rows to ${opts.rowsPath} as each one finishes`);
    console.log('');
  }

  const aggregates: Aggregate[] = [];

  for (const users of opts.sizes) {
    for (const arm of opts.arms) {
      const runs: Result[] = [];
      for (const seed of opts.seeds) {
        runs.push(runSafely(arm, users, seed, opts, sink));
      }
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

  // The podium, per size, on the primary metric and on the fairness metric.
  console.log('=== SEPARATION (2 SE, two-sample, adjacent pairs) ===');
  for (const users of opts.sizes) {
    const group = aggregates.filter((x) => x.users === users);
    if (group.length < 2) continue;
    for (const line of podium(group, 'hostRetention')) console.log(line);
    console.log('');
    for (const line of podium(group, 'hostGini', false)) console.log(line);
    console.log('');
  }

  // §4.3: losing to random is a BUG, not a design failure. Say so loudly.
  //
  // GATED as of v1.9. This check used to be a bare `<` on two point estimates,
  // which is how it came to print
  //     "shipped loses to random at N=20 (0.833 vs 0.833)"
  // — two numbers that render identically, separated by a float comparison, in
  // the same output that the comparison table was built from. An alarm that
  // fires on a gap of 1e-16 trains you to skim past it, which is worse than not
  // having it.
  for (const users of opts.sizes) {
    const random = aggregates.find((x) => x.users === users && x.arm === 'random');
    if (!random) continue;
    for (const arm of ['shipped', 'ranker_repaired', 'ranker_no_funnel'] as Arm[]) {
      const row = aggregates.find((x) => x.users === users && x.arm === arm);
      if (!row || row.hostRetention >= random.hostRetention) continue;
      if (separates(row, random, 'hostRetention')) {
        console.log(
          `!! BUG SUSPECTED: ${arm} loses to random on host retention at N=${users} ` +
          `(${pm(row.hostRetention, row.se.hostRetention)} vs ` +
          `${pm(random.hostRetention, random.se.hostRetention)}, clears 2 SE). ` +
          'Investigate before reporting anything else.',
        );
      } else {
        console.log(
          `   (below random but inside noise: ${arm} at N=${users}, ` +
          `${pm(row.hostRetention, row.se.hostRetention)} vs ` +
          `${pm(random.hostRetention, random.se.hostRetention)} — not a finding either way)`,
        );
      }
    }
  }

  if (opts.csvPath) {
    writeFileSync(opts.csvPath, `${csv(aggregates)}\n`);
    console.log(`wrote ${opts.csvPath}`);
  }
  if (opts.mdPath) {
    writeFileSync(opts.mdPath, `${table}\n`);
    console.log(`wrote ${opts.mdPath}`);
  }
  if (sink) console.log(`wrote ${opts.rowsPath} (${sink.count} per-seed rows)`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
