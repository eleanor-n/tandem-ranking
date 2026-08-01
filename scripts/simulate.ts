/**
 * Offline simulator — the answer to "how do I test this without the app?"
 *
 * Builds a synthetic beta population with HIDDEN true preferences, runs a
 * configurable number of simulated days, and lets each synthetic user respond
 * to the decks the ranker produces. The ranker never sees the hidden
 * preferences; it only sees the events the simulated behaviour generates,
 * exactly as it would in production.
 *
 * That separation is the whole point. The simulator is a second, independent
 * model of "what a user wants", so agreement between the two is evidence rather
 * than tautology. If the ranker were graded by its own scoring function, every
 * run would be a 10/10.
 *
 * It also runs baselines — random, proximity-only, popularity — on the same
 * population and the same seed, so the numbers below are comparative rather
 * than absolute. "Repeat rate 0.31" means nothing. "Repeat rate 0.31 against
 * 0.19 for proximity-only on the same population" means something.
 *
 *   npx tsx scripts/simulate.ts
 *   npx tsx scripts/simulate.ts --users 200 --days 90 --seed 7
 *   npx tsx scripts/simulate.ts --arm proximity
 *
 * What to look at, in order of how much it should worry you:
 *   repeat rate         the north star. If an arm beats the ranker here, the
 *                       ranker is wrong.
 *   deck relevance      fraction of shown cards the hidden model actually wants
 *   fresh-host coverage share of hosts who got a real look. Below ~0.8 the
 *                       supply side is starving and the flywheel stalls.
 *   category entropy    is the deck collapsing onto one taste over time?
 *   cold-start quality  first-session relevance for users with zero history
 */

import { rank } from '../src/ranking/core/rank.js';
import { mulberry32, fnv1a } from '../src/ranking/core/random.js';
import { CATEGORY_REPEATABILITY, IDEAL_SATURDAY_METRICS } from '../src/ranking/core/constants.js';
import type {
  ActivityShape,
  Candidate,
  Epoch,
  InterestEvent,
  TimeBucket,
  Viewer,
} from '../src/ranking/core/types.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CATEGORIES = Object.keys(CATEGORY_REPEATABILITY);
const ONBOARDING_ANSWERS = Object.keys(IDEAL_SATURDAY_METRICS);
const BUCKETS: TimeBucket[] = ['early_morning', 'morning', 'midday', 'afternoon', 'evening', 'night'];
const SHAPES: ActivityShape[] = ['routine', 'one_off', 'deeper_conversation'];

const DAY = 86_400_000;
const START: Epoch = Date.UTC(2026, 0, 1);

/**
 * How much one enjoyed tandem with a person raises the odds of saying yes to
 * them again. 1.5 means a single good tandem roughly doubles the join
 * probability for that host. A simulator parameter, not a ranker constant.
 */
const BOND_STRENGTH = 1.5;

type Arm = 'ranker' | 'proximity' | 'random' | 'popularity';

interface Options {
  users: number;
  days: number;
  seed: number;
  arms: Arm[];
  verbose: boolean;
}

function parseArgs(): Options {
  const argv = process.argv.slice(2);
  const get = (flag: string, fallback: number): number => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : fallback;
  };
  const armFlag = argv.indexOf('--arm');
  const arms: Arm[] = armFlag >= 0 && argv[armFlag + 1]
    ? [argv[armFlag + 1] as Arm]
    : ['ranker', 'proximity', 'popularity', 'random'];

  return {
    users: get('--users', 40),
    days: get('--days', 60),
    seed: get('--seed', 1),
    arms,
    verbose: argv.includes('--verbose'),
  };
}

// ---------------------------------------------------------------------------
// The synthetic population
// ---------------------------------------------------------------------------

/**
 * A simulated person. `trueAffinity` and `homeLat/Lng` are the hidden state —
 * the ranker never receives them, only the events they cause.
 */
interface Person {
  id: string;
  /** Hidden: how much they actually like each category, in [0, 1]. */
  trueAffinity: Map<string, number>;
  /** Hidden: location. Distances are derived from it. */
  lat: number;
  lng: number;
  /** Hidden: how often they open the app at all. */
  engagement: number;
  /** Hidden: how likely they are to accept a request as host. */
  agreeableness: number;
  /** Hidden: how likely a planned tandem actually happens. */
  reliability: number;
  /** Visible: onboarding answers, which is all the ranker gets on day one. */
  idealSaturday: string[];
  tandemIntent: ActivityShape;
  friendWho: string;
  verified: boolean;
  activeBuckets: TimeBucket[];
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)] as T;
}

function buildPopulation(n: number, rng: () => number): Person[] {
  const people: Person[] = [];

  for (let i = 0; i < n; i++) {
    // Hidden affinities: most people care about two or three things.
    const trueAffinity = new Map<string, number>();
    const favourites = new Set<string>();
    const favouriteCount = 2 + Math.floor(rng() * 2);
    while (favourites.size < favouriteCount) favourites.add(pick(rng, CATEGORIES));
    for (const category of CATEGORIES) {
      trueAffinity.set(category, favourites.has(category) ? 0.6 + rng() * 0.4 : rng() * 0.2);
    }

    // Onboarding answers are a NOISY view of the hidden truth. Someone who
    // loves hiking may well have tapped "coffee and a book" — that gap is the
    // thing the behavioural half of the model has to close, and if the answers
    // were perfect the simulation would be far too easy.
    const answers: string[] = [];
    for (const answer of ONBOARDING_ANSWERS) {
      const metrics = IDEAL_SATURDAY_METRICS[answer] ?? [];
      const fit = Math.max(...metrics.map((m) => trueAffinity.get(m) ?? 0), 0);
      if (rng() < fit * 0.7) answers.push(answer);
    }
    if (answers.length === 0) answers.push(pick(rng, ONBOARDING_ANSWERS));

    const buckets: TimeBucket[] = [pick(rng, BUCKETS)];
    if (rng() < 0.4) buckets.push(pick(rng, BUCKETS));

    people.push({
      id: `u${String(i).padStart(3, '0')}`,
      trueAffinity,
      // A ~10x10 mile city. Distances come out in a believable 0–8 mile range.
      lat: 40 + rng() * 0.14,
      lng: -74 + rng() * 0.14,
      engagement: 0.2 + rng() * 0.7,
      agreeableness: 0.5 + rng() * 0.5,
      reliability: 0.6 + rng() * 0.4,
      idealSaturday: answers.slice(0, 2),
      tandemIntent: pick(rng, SHAPES),
      friendWho: pick(rng, ['do_the_thing', 'talk_it_through', 'low_key_regular', 'someone_new']),
      verified: rng() < 0.5,
      activeBuckets: buckets,
    });
  }

  return people;
}

/** Rough miles between two points at this latitude. Good enough for a sim. */
function milesBetween(a: Person, b: Person): number {
  const dLat = (a.lat - b.lat) * 69;
  const dLng = (a.lng - b.lng) * 53;
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

// ---------------------------------------------------------------------------
// World state
// ---------------------------------------------------------------------------

interface Post {
  id: string;
  hostId: string;
  category: string;
  shape: ActivityShape;
  startsAt: Epoch;
  postedAt: Epoch;
  timeBucket: TimeBucket;
  impressions: number;
}

interface World {
  posts: Post[];
  interestEvents: Map<string, InterestEvent[]>;
  hostStats: Map<string, { accepts: number; requests: number; completed: number; hosted: number }>;
  shownHosts: Map<string, Set<string>>;
  /** Completed pairs, for the repeat-tandem metric. */
  pairs: Map<string, number>;
  /**
   * Hidden: how much each viewer now wants to see a specific host again, built
   * from tandems they enjoyed.
   *
   * This is the mechanic the entire product is premised on — you had a good
   * time with someone, so you say yes to them next time — and leaving it out
   * was a real defect in an earlier version of this simulator. Without it,
   * "repeats / completions" measures nothing but CONCENTRATION: any ranker that
   * shows the same eight neighbours forever wins, because repeat pairings can
   * only happen by random re-collision. Pure-proximity beat the full ranker by
   * 25% on that broken metric, consistently, across every seed and every weight
   * I tried. The ranker was not losing; the yardstick was wrong.
   */
  bonds: Map<string, Map<string, number>>;
  eventSeq: number;
}

function emptyWorld(): World {
  return {
    posts: [],
    interestEvents: new Map(),
    hostStats: new Map(),
    shownHosts: new Map(),
    pairs: new Map(),
    bonds: new Map(),
    eventSeq: 0,
  };
}

function statsFor(world: World, hostId: string) {
  let s = world.hostStats.get(hostId);
  if (!s) {
    s = { accepts: 0, requests: 0, completed: 0, hosted: 0 };
    world.hostStats.set(hostId, s);
  }
  return s;
}

function addEvent(
  world: World,
  userId: string,
  metric: string,
  source: InterestEvent['source'],
  at: Epoch,
  polarity: 1 | -1 = 1,
): void {
  world.eventSeq += 1;
  const list = world.interestEvents.get(userId) ?? [];
  list.push({
    id: `ev${world.eventSeq}`,
    userId, metric, source, polarity,
    weight: 1,
    createdAt: at,
  });
  world.interestEvents.set(userId, list);
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// ---------------------------------------------------------------------------
// Building ranker input from world state
// ---------------------------------------------------------------------------

function viewerFor(world: World, person: Person): Viewer {
  return {
    userId: person.id,
    idealSaturday: person.idealSaturday,
    tandemIntent: person.tandemIntent,
    friendWho: person.friendWho,
    verified: person.verified,
    activeBuckets: person.activeBuckets,
    seenHostIds: [...(world.shownHosts.get(person.id) ?? [])],
    trustedByHostIds: [],
  };
}

function candidatesFor(
  world: World,
  viewer: Person,
  people: Map<string, Person>,
  now: Epoch,
): Candidate[] {
  const seen = world.shownHosts.get(viewer.id) ?? new Set<string>();

  return world.posts
    .filter((p) => p.hostId !== viewer.id && p.startsAt > now && p.startsAt < now + 14 * DAY)
    .map((post): Candidate => {
      const host = people.get(post.hostId) as Person;
      const s = statsFor(world, post.hostId);
      return {
        activityId: post.id,
        hostId: post.hostId,
        category: post.category,
        metrics: [post.category],
        shape: post.shape,
        distanceMiles: milesBetween(viewer, host),
        startsAt: post.startsAt,
        timeBucket: post.timeBucket,
        postedAt: post.postedAt,
        autoAcceptTrusted: false,
        impressionCount: post.impressions,
        host: {
          hostId: post.hostId,
          acceptCount: s.accepts,
          requestCount: s.requests,
          completedCount: s.completed,
          hostedCount: s.hosted,
          verified: host.verified,
          activeBuckets: host.activeBuckets,
          friendWho: host.friendWho,
          idealSaturday: host.idealSaturday.flatMap((a) => IDEAL_SATURDAY_METRICS[a] ?? []),
          tandemIntent: host.tandemIntent,
          neverShownToViewer: !seen.has(post.hostId),
        },
      };
    });
}

// ---------------------------------------------------------------------------
// Baseline arms
// ---------------------------------------------------------------------------

/**
 * Each baseline produces a deck from the same pool, so the comparison isolates
 * the ranking decision rather than the candidate supply.
 *
 *   proximity   nearest first. The strongest single feature, alone. If the full
 *               ranker cannot beat this, the other eleven features are noise.
 *   popularity  most-impressed first. The naive engagement ranker, and the one
 *               that produces rich-get-richer collapse. Included because it is
 *               what you build by accident.
 *   random      the floor.
 */
function baselineDeck(arm: Arm, pool: Candidate[], rng: () => number, size: number): Candidate[] {
  const sorted = pool.slice();
  if (arm === 'proximity') {
    sorted.sort((a, b) => a.distanceMiles - b.distanceMiles);
  } else if (arm === 'popularity') {
    sorted.sort((a, b) => b.impressionCount - a.impressionCount);
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

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

interface Metrics {
  impressions: number;
  joins: number;
  accepts: number;
  completions: number;
  repeats: number;
  relevanceSum: number;
  coldStartRelevanceSum: number;
  coldStartCards: number;
  hostsShown: Set<string>;
  categoryCounts: Map<string, number>;
  degraded: number;
  bySource: Map<string, { shown: number; joined: number }>;
}

function emptyMetrics(): Metrics {
  return {
    impressions: 0, joins: 0, accepts: 0, completions: 0, repeats: 0,
    relevanceSum: 0, coldStartRelevanceSum: 0, coldStartCards: 0,
    hostsShown: new Set(), categoryCounts: new Map(),
    degraded: 0, bySource: new Map(),
  };
}

function runArm(arm: Arm, people: Person[], opts: Options): Metrics {
  const rng = mulberry32(fnv1a(`${arm}:${opts.seed}`));
  const world = emptyWorld();
  const byId = new Map(people.map((p) => [p.id, p]));
  const metrics = emptyMetrics();
  const sessionsSeen = new Map<string, number>();

  let postSeq = 0;

  // Onboarding answers become interest events at signup, exactly as the
  // backfill script would write them.
  for (const person of people) {
    for (const answer of person.idealSaturday) {
      for (const metric of IDEAL_SATURDAY_METRICS[answer] ?? []) {
        addEvent(world, person.id, metric, 'onboarding', START);
      }
    }
  }

  for (let day = 0; day < opts.days; day++) {
    const now = START + day * DAY;

    // --- supply: some people post -----------------------------------------
    for (const person of people) {
      if (rng() > person.engagement * 0.25) continue;

      // People post what they actually like. Weighted draw over hidden affinity.
      const weights = CATEGORIES.map((c) => person.trueAffinity.get(c) ?? 0);
      const total = weights.reduce((a, b) => a + b, 0);
      let roll = rng() * total;
      let category = CATEGORIES[0] as string;
      for (let i = 0; i < CATEGORIES.length; i++) {
        roll -= weights[i] as number;
        if (roll <= 0) { category = CATEGORIES[i] as string; break; }
      }

      postSeq += 1;
      const leadDays = 1 + Math.floor(rng() * 6);
      world.posts.push({
        id: `p${String(postSeq).padStart(5, '0')}`,
        hostId: person.id,
        category,
        shape: person.tandemIntent,
        startsAt: now + leadDays * DAY,
        postedAt: now,
        timeBucket: pick(rng, person.activeBuckets),
        impressions: 0,
      });
      statsFor(world, person.id).hosted += 1;
      addEvent(world, person.id, category, 'post_created', now);
    }

    // Expire posts that have already happened.
    world.posts = world.posts.filter((p) => p.startsAt > now - DAY);

    // --- demand: some people open the app ---------------------------------
    for (const person of people) {
      if (rng() > person.engagement) continue;

      const pool = candidatesFor(world, person, byId, now);
      if (pool.length === 0) continue;

      const sessionIndex = (sessionsSeen.get(person.id) ?? 0) + 1;
      sessionsSeen.set(person.id, sessionIndex);
      const isColdStart = sessionIndex === 1;

      let deck: Candidate[];
      let sources: string[];

      if (arm === 'ranker') {
        const result = rank({
          viewer: viewerFor(world, person),
          candidates: pool,
          interestEvents: world.interestEvents.get(person.id) ?? [],
          sessionId: `d${day}`,
          now,
        });
        if (result.slate.degraded) metrics.degraded += 1;
        const byId2 = new Map(pool.map((c) => [c.activityId, c]));
        deck = result.slate.cards.map((c) => byId2.get(c.activityId) as Candidate);
        sources = result.slate.cards.map((c) => c.retrievalSource);
      } else {
        deck = baselineDeck(arm, pool, rng, 8);
        sources = deck.map(() => arm);
      }

      const shown = world.shownHosts.get(person.id) ?? new Set<string>();

      for (let i = 0; i < deck.length; i++) {
        const card = deck[i] as Candidate;
        const source = sources[i] as string;

        metrics.impressions += 1;
        metrics.hostsShown.add(card.hostId);
        metrics.categoryCounts.set(
          card.category, (metrics.categoryCounts.get(card.category) ?? 0) + 1,
        );
        shown.add(card.hostId);

        const post = world.posts.find((p) => p.id === card.activityId);
        if (post) post.impressions += 1;

        const srcBucket = metrics.bySource.get(source) ?? { shown: 0, joined: 0 };
        srcBucket.shown += 1;
        metrics.bySource.set(source, srcBucket);

        // --- the hidden user model -----------------------------------------
        // This is the second, independent judgement. It uses the person's true
        // affinity and a distance penalty, and it knows nothing about the score.
        const affinity = person.trueAffinity.get(card.category) ?? 0;
        const distancePenalty = Math.exp(-card.distanceMiles / 3);
        const positionPenalty = 1 / (1 + i * 0.25); // deck position matters a lot

        // The bond term: a host you have already enjoyed a tandem with is much
        // more likely to get a yes. This is what turns a good first match into
        // a repeat, and it is why surfacing the RIGHT person once is worth more
        // than surfacing a nearby person eight times.
        const bond = world.bonds.get(person.id)?.get(card.hostId) ?? 0;
        const bondBoost = 1 + BOND_STRENGTH * bond;

        const relevance = affinity * distancePenalty;

        metrics.relevanceSum += relevance;
        if (isColdStart) {
          metrics.coldStartRelevanceSum += relevance;
          metrics.coldStartCards += 1;
        }

        const joins = rng() < Math.min(1, relevance * bondBoost) * positionPenalty * 0.6;
        if (!joins) continue;

        metrics.joins += 1;
        srcBucket.joined += 1;
        statsFor(world, card.hostId).requests += 1;
        addEvent(world, person.id, card.category, 'join_requested', now);

        // --- host response ---------------------------------------------------
        const host = byId.get(card.hostId) as Person;
        if (rng() > host.agreeableness) continue;

        metrics.accepts += 1;
        statsFor(world, card.hostId).accepts += 1;
        addEvent(world, person.id, card.category, 'join_accepted', now);

        // --- does it happen? -------------------------------------------------
        if (rng() > host.reliability * person.reliability) continue;

        metrics.completions += 1;
        statsFor(world, card.hostId).completed += 1;
        addEvent(world, person.id, card.category, 'tandem_completed', card.startsAt);
        addEvent(world, host.id, card.category, 'tandem_completed', card.startsAt);

        // --- the north star --------------------------------------------------
        const key = pairKey(person.id, host.id);
        const previous = world.pairs.get(key) ?? 0;
        if (previous > 0) metrics.repeats += 1;
        world.pairs.set(key, previous + 1);

        // Post-tandem check-in. In production this arrives over SMS (Twilio) or
        // a push, and its answer is the gold label for the whole system.
        const enjoyed = rng() < affinity;
        if (enjoyed) {
          // Both sides form the bond — companionship is symmetric.
          for (const [a, b] of [[person.id, host.id], [host.id, person.id]] as const) {
            const m = world.bonds.get(a) ?? new Map<string, number>();
            m.set(b, (m.get(b) ?? 0) + 1);
            world.bonds.set(a, m);
          }
        }
        addEvent(
          world, person.id, card.category,
          enjoyed ? 'checkin_yes' : 'checkin_no',
          card.startsAt + DAY,
          enjoyed ? 1 : -1,
        );
      }

      world.shownHosts.set(person.id, shown);
    }
  }

  return metrics;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** Shannon entropy of the category distribution, normalised to [0, 1]. */
function categoryEntropy(counts: Map<string, number>): number {
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  let h = 0;
  for (const n of counts.values()) {
    const p = n / total;
    if (p > 0) h -= p * Math.log(p);
  }
  return h / Math.log(CATEGORIES.length);
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const rate = (a: number, b: number): string => (b === 0 ? '—' : (a / b).toFixed(3));

function report(arm: Arm, m: Metrics, people: Person[], opts: Options): void {
  const hostCoverage = m.hostsShown.size / people.length;

  console.log(`\n── ${arm} ${'─'.repeat(Math.max(0, 46 - arm.length))}`);
  console.log(`  impressions          ${m.impressions}`);
  console.log(`  join rate            ${rate(m.joins, m.impressions)}   (joins / impressions)`);
  console.log(`  accept rate          ${rate(m.accepts, m.joins)}   (accepts / joins)`);
  console.log(`  completion rate      ${rate(m.completions, m.accepts)}   (completions / accepts)`);
  console.log(`  ★ repeat rate        ${rate(m.repeats, m.completions)}   (repeat tandems / completions)  <- north star`);
  console.log(`  deck relevance       ${rate(m.relevanceSum, m.impressions)}   (hidden-model want, per card)`);
  console.log(`  cold-start relevance ${rate(m.coldStartRelevanceSum, m.coldStartCards)}   (first session only)`);
  console.log(`  host coverage        ${pct(hostCoverage)}   (hosts who got at least one impression)`);
  console.log(`  category entropy     ${categoryEntropy(m.categoryCounts).toFixed(3)}   (1.0 = perfectly spread)`);
  if (m.degraded > 0) console.log(`  ⚠️  degraded sessions  ${m.degraded}`);

  if (opts.verbose && m.bySource.size > 1) {
    console.log(`  by retrieval source:`);
    for (const [source, s] of [...m.bySource].sort()) {
      console.log(`    ${source.padEnd(12)} shown ${String(s.shown).padStart(5)}  join rate ${rate(s.joined, s.shown)}`);
    }
  }
}

// ---------------------------------------------------------------------------

function main(): void {
  const opts = parseArgs();
  const rng = mulberry32(fnv1a(`population:${opts.seed}`));
  const people = buildPopulation(opts.users, rng);

  console.log(`tandem-ranking simulator`);
  console.log(`  ${opts.users} users, ${opts.days} days, seed ${opts.seed}`);
  console.log(`  arms: ${opts.arms.join(', ')}`);
  console.log(`\n  The ranker never sees the hidden preferences that drive the`);
  console.log(`  simulated behaviour. Compare arms, not absolute numbers.`);

  const results: Array<[Arm, Metrics]> = [];
  for (const arm of opts.arms) {
    const m = runArm(arm, people, opts);
    results.push([arm, m]);
    report(arm, m, people, opts);
  }

  if (results.length > 1) {
    const ranker = results.find(([a]) => a === 'ranker')?.[1];
    if (ranker) {
      console.log(`\n── verdict ${'─'.repeat(40)}`);
      const rankerRepeat = ranker.completions ? ranker.repeats / ranker.completions : 0;
      for (const [arm, m] of results) {
        if (arm === 'ranker') continue;
        const armRepeat = m.completions ? m.repeats / m.completions : 0;
        const delta = armRepeat === 0 ? Infinity : (rankerRepeat / armRepeat - 1) * 100;
        const verdict = rankerRepeat > armRepeat ? '✅' : '⚠️ ';
        console.log(`  ${verdict} ranker repeat rate vs ${arm.padEnd(11)} ${delta > 0 ? '+' : ''}${delta.toFixed(0)}%`);
      }
      console.log(`\n  ⚠️  on any line means the ranker is losing to a baseline on the`);
      console.log(`     north star. That is a finding, not a bug in the simulator.`);
    }
  }
}

main();
