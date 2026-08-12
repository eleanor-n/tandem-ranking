/**
 * WHICH LOGGED COLUMNS CARRY NO INFORMATION.
 *
 * `ranking_events.score_snapshot` is the training set for every future version
 * of this ranker, and the architecture deliberately computes and logs the whole
 * shelved feature set on every impression so that the question "was the ranker
 * right?" stays answerable. That is the right call, and it is why the ranker is
 * shelved rather than deleted.
 *
 * It also means the usual simplification move — delete the thing that is not
 * ordering anything — would delete the training set. So this script asks a
 * narrower and safer question instead:
 *
 *   WHICH LOGGED COLUMNS ARE CONSTANT?
 *
 * A column with one distinct value across every impression carries zero
 * information. It cannot enter any fit, it cannot be a control, and no amount of
 * additional data changes that — a constant stays constant. Deleting one costs
 * nothing that can ever be recovered, which is precisely what CANNOT be said of
 * deleting a live feature.
 *
 * That makes this an elimination criterion with a measurement behind it rather
 * than a judgement call. Everything it flags is safe by construction; everything
 * it does not flag is carrying signal and stays.
 *
 * Read-only. Runs the frozen population model, ranks real decks, and reports.
 *
 *   npx tsx scripts/deadcolumns.ts [--users 300] [--days 60] [--seeds 1,2,3]
 */

import { rank } from '../src/ranking/core/rank.js';
import { computeRegime } from '../src/ranking/core/regime.js';
import { CONSTANTS } from '../src/ranking/core/constants.js';
import {
  DAY,
  START,
  buildPopulation,
  candidatesFor,
  createPost,
  emptyWorld,
  postsToday,
  viewerFor,
  type Person,
  type Post,
} from './population.js';

// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parse(argv: string[]) {
  const flag = (name: string): string | null => {
    const i = argv.indexOf(name);
    if (i === -1) return null;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) {
      throw new Error(`${name} needs a value`);
    }
    // The zsh word-splitting trap that silently cost a whole sweep run once
    // already: an unquoted "$VAR" holding "--a 1 --b 2" arrives as ONE argv
    // entry, and every flag in it is ignored without a word of complaint.
    if (v.includes(' ')) throw new Error(`${name} got a value containing a space: ${v}`);
    return v;
  };
  return {
    users: Number(flag('--users') ?? 300),
    days: Number(flag('--days') ?? 60),
    seeds: (flag('--seeds') ?? '1,2,3').split(',').map((s) => {
      const n = Number(s.trim());
      if (!Number.isFinite(n)) throw new Error(`bad seed: ${s}`);
      return n;
    }),
  };
}

// ---------------------------------------------------------------------------

interface Column {
  /** Every distinct value seen, capped so a continuous column cannot blow memory. */
  distinct: Set<number>;
  min: number;
  max: number;
  n: number;
}

function newColumn(): Column {
  return { distinct: new Set(), min: Infinity, max: -Infinity, n: 0 };
}

function observe(col: Column, v: number): void {
  col.n += 1;
  if (v < col.min) col.min = v;
  if (v > col.max) col.max = v;
  if (col.distinct.size < 64) col.distinct.add(Number(v.toFixed(6)));
}

// ---------------------------------------------------------------------------

function main(): void {
  const opts = parse(process.argv.slice(2));
  const columns = new Map<string, Column>();
  let impressions = 0;

  console.log('DEAD COLUMN ANALYSIS — which logged snapshot fields are constant');
  console.log(`  users ${opts.users}, days ${opts.days}, seeds ${opts.seeds.join(', ')}`);
  console.log(`  RANKER_ENABLED is false; features are computed and logged anyway,`);
  console.log(`  which is exactly the property being audited here.`);
  console.log('');

  for (const seed of opts.seeds) {
    const rng = mulberry32(seed);
    const people = buildPopulation(opts.users, rng);
    const world = emptyWorld();
    const byId = new Map<string, Person>(people.map((p) => [p.id, p]));
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
        if (rng() > person.engagement * 0.5) continue;
        const pool = candidatesFor(world, person, byId, now);
        if (pool.length === 0) continue;

        const regime = computeRegime({
          eligiblePostsPerWeek: pool.length,
          cardsViewedPerWeek: world.weeklyImpressions.get(person.id)
            || CONSTANTS.regime.defaultCardsViewedPerWeek,
          weeksOfHistory: 4,
        }, null).regime;

        const result = rank({
          viewer: viewerFor(world, person),
          candidates: pool,
          interestEvents: world.interestEvents.get(person.id) ?? [],
          sessionId: `d${day}`,
          now,
          regime,
        });

        for (const snap of result.snapshots) {
          impressions += 1;
          for (const [k, v] of Object.entries(snap.computed.features)) {
            if (typeof v !== 'number') continue;
            const key = `features.${k}`;
            if (!columns.has(key)) columns.set(key, newColumn());
            observe(columns.get(key) as Column, v);
          }
          for (const [k, v] of Object.entries(snap.computed.funnel)) {
            if (typeof v !== 'number') continue;
            const key = `funnel.${k}`;
            if (!columns.has(key)) columns.set(key, newColumn());
            observe(columns.get(key) as Column, v);
          }
          if (typeof snap.computed.regime === 'number') {
            if (!columns.has('regime')) columns.set('regime', newColumn());
            observe(columns.get('regime') as Column, snap.computed.regime);
          }
        }

        world.weeklyImpressions.set(
          person.id,
          (world.weeklyImpressions.get(person.id) ?? 0) + result.slate.cards.length,
        );
      }
    }
  }

  const rows = [...columns.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const dead: string[] = [];

  console.log(`  ${impressions.toLocaleString()} impressions logged`);
  console.log('');
  console.log('| column | distinct | min | max | verdict |');
  console.log('|---|---:|---:|---:|---|');

  for (const [name, col] of rows) {
    const isDead = col.distinct.size <= 1;
    if (isDead) dead.push(name);
    console.log(
      `| ${name} | ${col.distinct.size >= 64 ? '64+' : col.distinct.size} | `
      + `${col.min.toFixed(4)} | ${col.max.toFixed(4)} | `
      + `${isDead ? '**DEAD — one value, zero information**' : 'carries signal'} |`,
    );
  }

  console.log('');
  if (dead.length === 0) {
    console.log('VERDICT: no dead columns. Every logged field varies across impressions,');
    console.log('so nothing here can be deleted without losing training data.');
  } else {
    console.log(`VERDICT: ${dead.length} dead column(s) — constant across every impression:`);
    for (const d of dead) console.log(`  - ${d}`);
    console.log('');
    console.log('These carry zero information by measurement, not by argument. A constant');
    console.log('column cannot enter a fit and cannot become informative with more rows.');
    console.log('Deleting them is the only lossless simplification available here.');
  }
}

main();
