/**
 * Backfill `interest_events` from data that already exists.
 *
 * Without this, everyone who joined the beta before v1.5 ships wakes up on
 * launch day with an empty interest vector and a proximity-only deck — the
 * users who have given you the most data get the worst experience. That is the
 * wrong way round.
 *
 * What it derives:
 *   post_created      one per authored activity,  at its original created_at
 *   join_requested    one per join request,       at its original created_at
 *   join_accepted     one per accepted request,   at its original created_at
 *   tandem_completed  one per completion,         at the completion time
 *   onboarding        ideal_saturday + tandem_intent, at account creation time
 *
 * Every row is tagged `source_meta = 'backfill'` so it can be excluded once
 * organic data accumulates:
 *
 *   delete from interest_events where source_meta = 'backfill';
 *
 * Idempotent: existing backfill rows are read first and matching rows are
 * skipped, so running it twice is a no-op. Run with --dry-run first.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx scripts/backfill-interest-events.ts --dry-run
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx scripts/backfill-interest-events.ts --apply
 *
 * This script talks to PostgREST directly with fetch. It deliberately does not
 * import @supabase/supabase-js so the package keeps zero runtime dependencies.
 */

import {
  IDEAL_SATURDAY_METRICS,
  TANDEM_INTENT_SHAPE,
} from '../src/ranking/core/constants.js';
import type { InterestSource, MetricSlug } from '../src/ranking/core/types.js';

const BACKFILL_TAG = 'backfill';

interface DerivedEvent {
  user_id: string;
  metric: MetricSlug;
  source: InterestSource;
  polarity: 1 | -1;
  weight: number;
  source_meta: string;
  activity_id: string | null;
  created_at: string;
}

/** Dedup key. Two runs deriving the same fact must produce the same key. */
function keyOf(e: DerivedEvent): string {
  return [e.user_id, e.metric, e.source, e.activity_id ?? '-', e.created_at].join('|');
}

// ---------------------------------------------------------------------------
// PostgREST access
// ---------------------------------------------------------------------------

interface Config {
  url: string;
  key: string;
  apply: boolean;
}

function readConfig(): Config {
  const url = process.env['SUPABASE_URL'];
  const key = process.env['SUPABASE_SERVICE_ROLE_KEY'];
  const apply = process.argv.includes('--apply');
  const dryRun = process.argv.includes('--dry-run');

  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  }
  if (apply === dryRun) {
    throw new Error('Pass exactly one of --dry-run or --apply');
  }
  return { url: url.replace(/\/+$/, ''), key, apply };
}

async function get(cfg: Config, path: string): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${cfg.url}/rest/v1/${path}`, {
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` },
  });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as Record<string, unknown>[];
}

async function insert(cfg: Config, table: string, rows: unknown[]): Promise<void> {
  if (rows.length === 0) return;
  const res = await fetch(`${cfg.url}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: cfg.key,
      Authorization: `Bearer ${cfg.key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`POST ${table} -> ${res.status} ${await res.text()}`);
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Category -> the metrics it implies. Mirrors the adapter's default. */
function metricsForCategory(category: string): MetricSlug[] {
  return category ? [category] : [];
}

function deriveFromActivities(activities: Record<string, unknown>[]): DerivedEvent[] {
  const out: DerivedEvent[] = [];
  for (const a of activities) {
    const host = str(a['host_id']);
    const created = str(a['created_at']);
    if (!host || !created) continue;
    for (const metric of metricsForCategory(str(a['category']))) {
      out.push({
        user_id: host,
        metric,
        source: 'post_created',
        polarity: 1,
        weight: 1,
        source_meta: BACKFILL_TAG,
        activity_id: str(a['id']) || null,
        created_at: created,
      });
    }
  }
  return out;
}

function deriveFromJoinRequests(
  requests: Record<string, unknown>[],
  categoryByActivity: Map<string, string>,
): DerivedEvent[] {
  const out: DerivedEvent[] = [];
  for (const r of requests) {
    const user = str(r['user_id']);
    const activityId = str(r['activity_id']);
    const created = str(r['created_at']);
    const category = categoryByActivity.get(activityId) ?? '';
    if (!user || !created || !category) continue;

    for (const metric of metricsForCategory(category)) {
      out.push({
        user_id: user, metric,
        source: 'join_requested',
        polarity: 1, weight: 1,
        source_meta: BACKFILL_TAG,
        activity_id: activityId || null,
        created_at: created,
      });

      // An accepted request is separate, stronger evidence than the ask.
      if (str(r['status']) === 'accepted') {
        out.push({
          user_id: user, metric,
          source: 'join_accepted',
          polarity: 1, weight: 1,
          source_meta: BACKFILL_TAG,
          activity_id: activityId || null,
          created_at: created,
        });
      }
    }
  }
  return out;
}

/**
 * Completions. Both sides get credit: the host chose the activity and the
 * attendee showed up for it.
 */
function deriveFromCompletions(
  completed: Record<string, unknown>[],
  participantsByActivity: Map<string, string[]>,
): DerivedEvent[] {
  const out: DerivedEvent[] = [];
  for (const a of completed) {
    const activityId = str(a['id']);
    const at = str(a['completed_at']) || str(a['starts_at']) || str(a['created_at']);
    const category = str(a['category']);
    if (!activityId || !at || !category) continue;

    const users = new Set<string>([
      str(a['host_id']),
      ...(participantsByActivity.get(activityId) ?? []),
    ]);
    users.delete('');

    for (const user of users) {
      for (const metric of metricsForCategory(category)) {
        out.push({
          user_id: user, metric,
          source: 'tandem_completed',
          polarity: 1, weight: 1,
          source_meta: BACKFILL_TAG,
          activity_id: activityId,
          created_at: at,
        });
      }
    }
  }
  return out;
}

/**
 * Onboarding answers, mapped through the same static tables the live ranker
 * uses, stamped at account creation. Not "now" — dating them today would make
 * every beta user look like they signed up this morning and hand them a novelty
 * bonus they have not earned.
 */
function deriveFromOnboarding(profiles: Record<string, unknown>[]): DerivedEvent[] {
  const out: DerivedEvent[] = [];
  for (const p of profiles) {
    const user = str(p['id']);
    const created = str(p['created_at']);
    if (!user || !created) continue;

    const ideal = p['ideal_saturday'];
    const answers = Array.isArray(ideal) ? ideal.map(String)
      : typeof ideal === 'string' ? [ideal] : [];

    for (const answer of answers) {
      for (const metric of IDEAL_SATURDAY_METRICS[answer] ?? []) {
        out.push({
          user_id: user, metric,
          source: 'onboarding',
          polarity: 1, weight: 1,
          source_meta: BACKFILL_TAG,
          activity_id: null,
          created_at: created,
        });
      }
    }

    // tandem_intent describes a shape, not a category. Recorded under a
    // namespaced pseudo-metric so it never collides with a real category slug.
    const intent = str(p['tandem_intent']);
    const shape = TANDEM_INTENT_SHAPE[intent];
    if (shape) {
      out.push({
        user_id: user,
        metric: `intent:${shape}`,
        source: 'onboarding',
        polarity: 1, weight: 1,
        source_meta: BACKFILL_TAG,
        activity_id: null,
        created_at: created,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cfg = readConfig();

  console.log(cfg.apply ? '=== APPLY ===' : '=== DRY RUN (nothing will be written) ===');

  const [profiles, activities, joinRequests, existing, participants] = await Promise.all([
    get(cfg, 'profiles?select=id,created_at,ideal_saturday,tandem_intent'),
    get(cfg, 'activities?select=id,host_id,category,status,created_at,starts_at,completed_at'),
    get(cfg, 'join_requests?select=activity_id,user_id,status,created_at'),
    get(cfg, `interest_events?select=user_id,metric,source,activity_id,created_at&source_meta=eq.${BACKFILL_TAG}`),
    get(cfg, 'activity_participants?select=activity_id,user_id,status').catch(() => []),
  ]);

  const categoryByActivity = new Map<string, string>();
  for (const a of activities) categoryByActivity.set(str(a['id']), str(a['category']));

  const participantsByActivity = new Map<string, string[]>();
  for (const p of participants) {
    if (str(p['status']) && str(p['status']) !== 'accepted') continue;
    const k = str(p['activity_id']);
    const list = participantsByActivity.get(k) ?? [];
    list.push(str(p['user_id']));
    participantsByActivity.set(k, list);
  }

  const completed = activities.filter((a) => str(a['status']) === 'completed');

  const derived: DerivedEvent[] = [
    ...deriveFromOnboarding(profiles),
    ...deriveFromActivities(activities),
    ...deriveFromJoinRequests(joinRequests, categoryByActivity),
    ...deriveFromCompletions(completed, participantsByActivity),
  ];

  // Idempotency: skip anything already written by a previous run.
  const seen = new Set(
    existing.map((r) => [
      str(r['user_id']), str(r['metric']), str(r['source']),
      str(r['activity_id']) || '-', str(r['created_at']),
    ].join('|')),
  );

  const fresh: DerivedEvent[] = [];
  const withinRun = new Set<string>();
  for (const e of derived) {
    const k = keyOf(e);
    if (seen.has(k) || withinRun.has(k)) continue;
    withinRun.add(k);
    fresh.push(e);
  }

  // Report per user, per source. This is the output you actually read.
  const byUser = new Map<string, Map<string, number>>();
  for (const e of fresh) {
    const m = byUser.get(e.user_id) ?? new Map<string, number>();
    m.set(e.source, (m.get(e.source) ?? 0) + 1);
    byUser.set(e.user_id, m);
  }

  console.log(`\nderived ${derived.length}, already present ${derived.length - fresh.length}, new ${fresh.length}`);
  console.log(`users affected: ${byUser.size}\n`);

  for (const [user, sources] of [...byUser].sort((a, b) => a[0].localeCompare(b[0]))) {
    const parts = [...sources].sort().map(([s, n]) => `${s}=${n}`).join(' ');
    console.log(`  ${user}  ${parts}`);
  }

  const usersWithNothing = profiles
    .map((p) => str(p['id']))
    .filter((id) => id && !byUser.has(id) && ![...seen].some((k) => k.startsWith(`${id}|`)));
  if (usersWithNothing.length > 0) {
    console.log(`\n⚠️  ${usersWithNothing.length} users derive zero events (they will cold-start):`);
    for (const u of usersWithNothing) console.log(`  ${u}`);
  }

  if (!cfg.apply) {
    console.log('\ndry run — nothing written. re-run with --apply.');
    return;
  }

  // Chunked so a large beta does not hit the PostgREST body limit.
  const CHUNK = 500;
  for (let i = 0; i < fresh.length; i += CHUNK) {
    await insert(cfg, 'interest_events', fresh.slice(i, i + CHUNK));
    console.log(`  wrote ${Math.min(i + CHUNK, fresh.length)}/${fresh.length}`);
  }
  console.log('\ndone.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
