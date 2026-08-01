/**
 * THE POPULATION MODEL.
 *
 * Committed before any arm was run. That is a methodology requirement, not a
 * formality: the v1.5 report disclosed that the simulator's user model had been
 * amended after seeing a result I disliked, and the gap halved. Disclosing that
 * was right; doing it silently would not have been. Freezing the model first is
 * the fix.
 *
 * If anything here changes after results exist, BOTH sets of numbers go in
 * INFERENCES.md with the reason.
 *
 * ---------------------------------------------------------------------------
 * What this file is
 *
 * A synthetic world with hidden state the ranker never sees. Every arm receives
 * exactly the same world, the same seed, and the same candidate pool, and
 * differs only in which cards it chooses to show. The hidden state decides what
 * happens next.
 *
 * The separation matters. A simulator authored alongside the ranker it grades
 * has correlated blind spots: both were written by the same process, with the
 * same assumptions about what makes a good match. A result that FAVOURS the
 * ranker is therefore weak evidence — it may only mean the two models agree
 * with each other. A result AGAINST the ranker is strong evidence, because it
 * survived that correlation.
 *
 * ---------------------------------------------------------------------------
 * The three dynamics v1.5 was missing, and why each one matters
 *
 *   HOST CHURN. A host whose post gets nobody has an elevated chance of never
 *   posting again. This is the mechanism the entire village objective exists to
 *   prevent, and v1.5's simulator could not see it: hosts there posted forever
 *   regardless of outcome, so the fresh-host slot and the impression floor were
 *   pure cost with zero modelled benefit. That alone could explain why pure
 *   proximity looked so strong.
 *
 *   EXHAUSTION. Join probability decays with repeat exposure to an already-met
 *   host, modulated by a hidden compatibility the ranker never sees. Without it
 *   nothing ever punished showing the same eight neighbours forever — which is
 *   exactly what proximity-only does.
 *
 *   SUPPLY RESPONSE. A good completed tandem makes you more likely to post.
 *   This is what closes the flywheel: rankers that produce good experiences get
 *   more supply to rank, and that compounding is invisible in a fixed-supply
 *   simulation.
 */

import { fnv1a, mulberry32 } from '../src/ranking/core/random.js';
import {
  CATEGORY_REPEATABILITY,
  IDEAL_SATURDAY_METRICS,
} from '../src/ranking/core/constants.js';
import type {
  ActivityShape,
  Candidate,
  Epoch,
  InterestEvent,
  TimeBucket,
  Viewer,
} from '../src/ranking/core/types.js';

export const CATEGORIES = Object.keys(CATEGORY_REPEATABILITY);
export const ONBOARDING_ANSWERS = Object.keys(IDEAL_SATURDAY_METRICS);
export const BUCKETS: TimeBucket[] = [
  'early_morning', 'morning', 'midday', 'afternoon', 'evening', 'night',
];
export const SHAPES: ActivityShape[] = ['routine', 'one_off', 'deeper_conversation'];

export const DAY = 86_400_000;
export const START: Epoch = Date.UTC(2026, 0, 1);

// ---------------------------------------------------------------------------
// Model parameters
//
// These are properties of the SIMULATED WORLD, not of the ranker. None of them
// is tuned against a result; each is set to the most defensible value I could
// argue for in advance, and they are collected here so that any later change is
// a visible diff rather than a scattered edit.
// ---------------------------------------------------------------------------

export const MODEL = {
  /** Metro area side, in miles. HELD FIXED as N grows — see note below. */
  citySideMiles: 10,

  /**
   * Why area is fixed rather than users-per-area: the sweep needs coverage to
   * rise with N, which is how an app actually grows — the same metro gets
   * denser. Holding users-per-area fixed would grow the map instead, leaving
   * each viewer's local pool constant and coverage flat, which would make the
   * sweep measure nothing.
   */

  /** Probability per day that a given user posts. HELD FIXED across the sweep. */
  postRatePerDay: 0.18,

  /** Probability per day that a given user opens the app, scaled by engagement. */
  sessionRateScale: 1.0,

  /** Distance decay in the hidden join model. Steeper than the ranker's, on purpose. */
  distanceTauMiles: 3,

  /** Deck position penalty: 1 / (1 + rate * position). */
  positionPenalty: 0.25,

  /** Overall scaling on join probability, so join rates land in a plausible band. */
  joinScale: 0.6,

  // --- bond (carried over from v1.5, disclosed there) ----------------------
  /**
   * How much one enjoyed tandem with a person raises the odds of saying yes to
   * them again. Added in v1.5 AFTER seeing a result, and disclosed as such.
   * Unchanged here.
   */
  bondStrength: 1.5,

  // --- exhaustion (NEW in v1.6) --------------------------------------------
  /**
   * Hidden fatigue with an already-met host:
   *   factor = exp(-rate * meetings * (1 - hiddenCompatibility))
   * A perfectly compatible pair never tires; an incompatible one tires fast.
   * The ranker cannot see hiddenCompatibility and must infer it from check-ins.
   */
  exhaustionRate: 0.5,

  // --- host churn (NEW in v1.6) --------------------------------------------
  /** Chance of quitting for good after a post that got nobody. */
  churnPerEmptyPost: 0.18,
  /** Chance of quitting after a post that filled. Non-zero: life happens. */
  churnPerFilledPost: 0.01,
  /**
   * Consecutive empty posts compound. The third disappointment hurts more than
   * the first, which is the shape every marketplace operator describes.
   */
  churnCompounding: 1.6,

  // --- supply response (NEW in v1.6) ---------------------------------------
  /** Multiplier on post rate per recent enjoyed tandem, capped. */
  supplyResponsePerGoodTandem: 0.25,
  supplyResponseCap: 2.0,

  /** Host accept and completion behaviour. */
  leadDaysMin: 1,
  leadDaysMax: 7,
} as const;

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export interface Person {
  id: string;
  /** HIDDEN: how much they actually like each category, in [0, 1]. */
  trueAffinity: Map<string, number>;
  /** HIDDEN: location. */
  lat: number;
  lng: number;
  /** HIDDEN: how often they open the app. */
  engagement: number;
  /** HIDDEN: how likely they are to accept a request as host. */
  agreeableness: number;
  /** HIDDEN: how likely a planned tandem actually happens. */
  reliability: number;
  /** HIDDEN: personality vector, for pairwise compatibility. */
  traits: number[];

  /** VISIBLE: onboarding answers — all the ranker gets on day one. */
  idealSaturday: string[];
  tandemIntent: ActivityShape;
  friendWho: string;
  verified: boolean;
  activeBuckets: TimeBucket[];

  // --- mutable supply state ------------------------------------------------
  /** Has this person given up on hosting? */
  active: boolean;
  /** Consecutive posts that got nobody. */
  consecutiveEmptyPosts: number;
  /** Recent enjoyed tandems, driving supply response. */
  goodTandems: number;
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)] as T;
}

export function buildPopulation(n: number, rng: () => number): Person[] {
  const people: Person[] = [];

  for (let i = 0; i < n; i++) {
    const trueAffinity = new Map<string, number>();
    const favourites = new Set<string>();
    const favouriteCount = 2 + Math.floor(rng() * 2);
    while (favourites.size < favouriteCount) favourites.add(pick(rng, CATEGORIES));
    for (const category of CATEGORIES) {
      trueAffinity.set(category, favourites.has(category) ? 0.6 + rng() * 0.4 : rng() * 0.2);
    }

    // Onboarding answers are a NOISY view of the hidden truth. If they were
    // perfect the cold-start problem would not exist and the sweep would be
    // measuring nothing.
    const answers: string[] = [];
    for (const answer of ONBOARDING_ANSWERS) {
      const metrics = IDEAL_SATURDAY_METRICS[answer] ?? [];
      const fit = Math.max(...metrics.map((m) => trueAffinity.get(m) ?? 0), 0);
      if (rng() < fit * 0.7) answers.push(answer);
    }
    if (answers.length === 0) answers.push(pick(rng, ONBOARDING_ANSWERS));

    const buckets: TimeBucket[] = [pick(rng, BUCKETS)];
    if (rng() < 0.4) buckets.push(pick(rng, BUCKETS));

    const side = MODEL.citySideMiles;
    people.push({
      id: `u${String(i).padStart(4, '0')}`,
      trueAffinity,
      // Fixed metro area. Degrees are converted to miles in milesBetween().
      lat: 40 + (rng() * side) / 69,
      lng: -74 + (rng() * side) / 53,
      engagement: 0.2 + rng() * 0.7,
      agreeableness: 0.5 + rng() * 0.5,
      reliability: 0.6 + rng() * 0.4,
      traits: [rng(), rng(), rng()],
      idealSaturday: answers.slice(0, 2),
      tandemIntent: pick(rng, SHAPES),
      friendWho: pick(rng, ['do_the_thing', 'talk_it_through', 'low_key_regular', 'someone_new']),
      verified: rng() < 0.5,
      activeBuckets: buckets,
      active: true,
      consecutiveEmptyPosts: 0,
      goodTandems: 0,
    });
  }

  return people;
}

export function milesBetween(a: Person, b: Person): number {
  const dLat = (a.lat - b.lat) * 69;
  const dLng = (a.lng - b.lng) * 53;
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

/**
 * HIDDEN pairwise compatibility, in [0, 1]. Cosine-ish similarity over the
 * trait vectors.
 *
 * The ranker has no access to this and no feature that approximates it. Its
 * only route to it is the post-tandem check-in — which is exactly the claim
 * §3 makes about repeatAffinity, so this is the term that tests whether that
 * claim is true.
 */
export function hiddenCompatibility(a: Person, b: Person): number {
  let dot = 0;
  for (let i = 0; i < a.traits.length; i++) {
    dot += 1 - Math.abs((a.traits[i] as number) - (b.traits[i] as number));
  }
  return dot / a.traits.length;
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

export interface Post {
  id: string;
  hostId: string;
  category: string;
  shape: ActivityShape;
  startsAt: Epoch;
  postedAt: Epoch;
  timeBucket: TimeBucket;
  impressions: number;
  joiners: string[];
  /** Set once the post's start time passes and its outcome is settled. */
  settled: boolean;
}

export interface World {
  posts: Post[];
  interestEvents: Map<string, InterestEvent[]>;
  hostStats: Map<string, { accepts: number; requests: number; completed: number; hosted: number }>;
  shownHosts: Map<string, Set<string>>;
  /** completedTogether, keyed "viewer|host" (directional, as the ranker sees it). */
  metCount: Map<string, number>;
  /** Check-in answers, keyed "viewer|host": running mean in [0, 1]. */
  checkins: Map<string, { yes: number; total: number }>;
  /** HIDDEN bond, keyed "viewer|host". */
  bonds: Map<string, number>;
  /** Undirected completed-pair counts, for the repeat metric. */
  pairs: Map<string, number>;
  /** Weekly impression counts per user, for the coverage estimate. */
  weeklyImpressions: Map<string, number>;
  /** Persisted regime state per user, so EWMA and hysteresis are exercised. */
  regimeState: Map<string, { coverageEwma: number | null; lastRegime: number | null }>;
  eventSeq: number;
  postSeq: number;
}

export function emptyWorld(): World {
  return {
    posts: [],
    interestEvents: new Map(),
    hostStats: new Map(),
    shownHosts: new Map(),
    metCount: new Map(),
    checkins: new Map(),
    bonds: new Map(),
    pairs: new Map(),
    weeklyImpressions: new Map(),
    regimeState: new Map(),
    eventSeq: 0,
    postSeq: 0,
  };
}

export const dirKey = (viewer: string, host: string): string => `${viewer}|${host}`;
export const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

export function statsFor(world: World, hostId: string) {
  let s = world.hostStats.get(hostId);
  if (!s) {
    s = { accepts: 0, requests: 0, completed: 0, hosted: 0 };
    world.hostStats.set(hostId, s);
  }
  return s;
}

export function addEvent(
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
    userId, metric, source, polarity, weight: 1, createdAt: at,
  });
  world.interestEvents.set(userId, list);
}

// ---------------------------------------------------------------------------
// Supply
// ---------------------------------------------------------------------------

/**
 * Does this person post today?
 *
 * Base rate is HELD FIXED across the sweep, so coverage rises purely with N and
 * the sweep measures density rather than a supply change. Supply response
 * modulates it around that base.
 */
export function postsToday(person: Person, rng: () => number): boolean {
  if (!person.active) return false;
  const responseMultiplier = Math.min(
    MODEL.supplyResponseCap,
    1 + MODEL.supplyResponsePerGoodTandem * person.goodTandems,
  );
  return rng() < MODEL.postRatePerDay * person.engagement * responseMultiplier;
}

export function createPost(
  world: World,
  person: Person,
  now: Epoch,
  rng: () => number,
): Post {
  // People post what they actually like — weighted draw over hidden affinity.
  const weights = CATEGORIES.map((c) => person.trueAffinity.get(c) ?? 0);
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = rng() * total;
  let category = CATEGORIES[0] as string;
  for (let i = 0; i < CATEGORIES.length; i++) {
    roll -= weights[i] as number;
    if (roll <= 0) { category = CATEGORIES[i] as string; break; }
  }

  world.postSeq += 1;
  const leadDays = MODEL.leadDaysMin
    + Math.floor(rng() * (MODEL.leadDaysMax - MODEL.leadDaysMin));

  const post: Post = {
    id: `p${String(world.postSeq).padStart(6, '0')}`,
    hostId: person.id,
    category,
    shape: person.tandemIntent,
    startsAt: now + leadDays * DAY,
    postedAt: now,
    timeBucket: pick(rng, person.activeBuckets),
    impressions: 0,
    joiners: [],
    settled: false,
  };

  world.posts.push(post);
  statsFor(world, person.id).hosted += 1;
  addEvent(world, person.id, category, 'post_created', now);
  return post;
}

/**
 * Settle posts whose start time has passed, and apply host churn.
 *
 * This is the dynamic the whole village objective exists to serve. A host whose
 * post got nobody is meaningfully likely to stop, and consecutive empty posts
 * compound — the third disappointment hurts more than the first.
 */
export function settleAndChurn(
  world: World,
  people: Map<string, Person>,
  now: Epoch,
  rng: () => number,
): { settled: number; empty: number; churned: number } {
  let settled = 0;
  let empty = 0;
  let churned = 0;

  for (const post of world.posts) {
    if (post.settled || post.startsAt > now) continue;
    post.settled = true;
    settled += 1;

    const host = people.get(post.hostId);
    if (!host) continue;

    if (post.joiners.length === 0) {
      empty += 1;
      host.consecutiveEmptyPosts += 1;
      const risk = Math.min(
        1,
        MODEL.churnPerEmptyPost *
          Math.pow(MODEL.churnCompounding, host.consecutiveEmptyPosts - 1),
      );
      if (host.active && rng() < risk) {
        host.active = false;
        churned += 1;
      }
    } else {
      host.consecutiveEmptyPosts = 0;
      if (host.active && rng() < MODEL.churnPerFilledPost) {
        host.active = false;
        churned += 1;
      }
    }
  }

  return { settled, empty, churned };
}

// ---------------------------------------------------------------------------
// The hidden user model
// ---------------------------------------------------------------------------

/**
 * Would this person tap "i'm in"?
 *
 * The second, independent judgement. It knows nothing about the score, and uses
 * hidden state the ranker cannot access:
 *
 *   affinity     hidden category preference (onboarding answers only hint at it)
 *   distance     steeper decay than the ranker's, on purpose
 *   position     deck position matters a lot in a sequential one-card deck
 *   bond         you had a good time with this person -> you say yes again
 *   exhaustion   you have met them a lot and you are not that compatible
 *
 * `relevance` is returned separately because it is the quality-of-deck metric,
 * and it must NOT include bond or exhaustion — those are properties of the
 * pairing history, not of whether this was a good card to show.
 */
export function joinDecision(
  viewer: Person,
  host: Person,
  world: World,
  category: string,
  distanceMiles: number,
  deckPosition: number,
): { probability: number; relevance: number } {
  const affinity = viewer.trueAffinity.get(category) ?? 0;
  const distanceFactor = Math.exp(-distanceMiles / MODEL.distanceTauMiles);
  const positionFactor = 1 / (1 + deckPosition * MODEL.positionPenalty);

  const relevance = affinity * distanceFactor;

  const bond = world.bonds.get(dirKey(viewer.id, host.id)) ?? 0;
  const bondFactor = 1 + MODEL.bondStrength * bond;

  const met = world.metCount.get(dirKey(viewer.id, host.id)) ?? 0;
  const compatibility = hiddenCompatibility(viewer, host);
  const exhaustionFactor = Math.exp(
    -MODEL.exhaustionRate * met * (1 - compatibility),
  );

  const probability = Math.min(
    1,
    relevance * bondFactor * exhaustionFactor,
  ) * positionFactor * MODEL.joinScale;

  return { probability, relevance };
}

/**
 * Resolve a join all the way through the funnel: host accept, completion,
 * check-in, bond, and the supply response that follows.
 */
export function resolveJoin(
  viewer: Person,
  host: Person,
  world: World,
  post: Post,
  rng: () => number,
  now: Epoch,
): { accepted: boolean; completed: boolean; repeat: boolean; enjoyed: boolean } {
  statsFor(world, host.id).requests += 1;
  addEvent(world, viewer.id, post.category, 'join_requested', now);

  if (rng() > host.agreeableness) {
    return { accepted: false, completed: false, repeat: false, enjoyed: false };
  }

  statsFor(world, host.id).accepts += 1;
  addEvent(world, viewer.id, post.category, 'join_accepted', now);
  post.joiners.push(viewer.id);

  if (rng() > host.reliability * viewer.reliability) {
    return { accepted: true, completed: false, repeat: false, enjoyed: false };
  }

  statsFor(world, host.id).completed += 1;
  addEvent(world, viewer.id, post.category, 'tandem_completed', post.startsAt);
  addEvent(world, host.id, post.category, 'tandem_completed', post.startsAt);

  for (const [a, b] of [[viewer.id, host.id], [host.id, viewer.id]] as const) {
    world.metCount.set(dirKey(a, b), (world.metCount.get(dirKey(a, b)) ?? 0) + 1);
  }

  const key = pairKey(viewer.id, host.id);
  const previous = world.pairs.get(key) ?? 0;
  world.pairs.set(key, previous + 1);

  // Enjoyment depends on BOTH the activity and the person. A great activity
  // with someone you do not click with is not a repeat.
  const compatibility = hiddenCompatibility(viewer, host);
  const affinity = viewer.trueAffinity.get(post.category) ?? 0;
  const enjoyed = rng() < affinity * 0.5 + compatibility * 0.5;

  for (const [a, b] of [[viewer.id, host.id], [host.id, viewer.id]] as const) {
    const k = dirKey(a, b);
    const record = world.checkins.get(k) ?? { yes: 0, total: 0 };
    record.total += 1;
    if (enjoyed) record.yes += 1;
    world.checkins.set(k, record);

    if (enjoyed) world.bonds.set(k, (world.bonds.get(k) ?? 0) + 1);
  }

  addEvent(
    world, viewer.id, post.category,
    enjoyed ? 'checkin_yes' : 'checkin_no',
    post.startsAt + DAY,
    enjoyed ? 1 : -1,
  );

  if (enjoyed) {
    viewer.goodTandems += 1;
    host.goodTandems += 1;
  }

  return { accepted: true, completed: true, repeat: previous > 0, enjoyed };
}

// ---------------------------------------------------------------------------
// Building ranker input
// ---------------------------------------------------------------------------

export function viewerFor(world: World, person: Person): Viewer {
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

export function candidatesFor(
  world: World,
  viewer: Person,
  people: Map<string, Person>,
  now: Epoch,
): Candidate[] {
  const seen = world.shownHosts.get(viewer.id) ?? new Set<string>();

  return world.posts
    .filter((p) => !p.settled && p.hostId !== viewer.id && p.startsAt > now)
    .map((post): Candidate => {
      const host = people.get(post.hostId) as Person;
      const s = statsFor(world, post.hostId);
      const k = dirKey(viewer.id, post.hostId);
      const checkin = world.checkins.get(k);

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

        // v1.6 demand inputs.
        confirmedJoiners: post.joiners.length,
        targetJoiners: 1,
        completedTogether: world.metCount.get(k) ?? 0,
        // The ONLY route the ranker has to hidden compatibility.
        ...(checkin && checkin.total > 0
          ? { repeatAffinity: checkin.yes / checkin.total }
          : {}),

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

export function seededRng(label: string, seed: number) {
  return mulberry32(fnv1a(`${label}:${seed}`));
}
