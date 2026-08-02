/**
 * Rebuild `graph_edges` from `tandems`.
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx scripts/rebuild-graph-edges.ts
 *   ... --dry-run     count the edges that WOULD be written, change nothing
 *
 * ---------------------------------------------------------------------------
 * Why this is a script and not a trigger
 *
 * `tandems` is already an edge list: pairwise, with a completion status.
 * `graph_edges` is a convenience aggregate over it and nothing more. Keeping an
 * aggregate in sync by trigger buys nothing when the source is queryable, and
 * it adds a failure mode that is silent by construction — which is exactly what
 * happened in v1.5, whose trigger targeted `public.activity_participants` (a
 * table that does not exist), never attached, and left `graph_edges` empty for
 * months with nothing to notice it.
 *
 * Recomputing has no such mode. A missed run loses nothing. A wrong run is
 * fixed by running it again. Run it from cron, after a backfill, or by hand;
 * correctness does not depend on when.
 *
 * Consumption is still stubbed at zero (`graphAffinity()` returns 0, the
 * `graph` retrieval source returns `[]`). This exists so that the history is
 * there — and reproducible — on the day it is not.
 */

const DRY_RUN = process.argv.includes('--dry-run');

const url = process.env['SUPABASE_URL'];
const key = process.env['SUPABASE_SERVICE_ROLE_KEY'];

if (!url || !key) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  console.error('The service role is needed: graph_edges has RLS on and no policies.');
  process.exit(1);
}

/**
 * Called over PostgREST rather than through a Supabase client, because this
 * package has zero runtime dependencies and a maintenance script is not a good
 * reason to acquire one.
 */
async function rpc(fn: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const response = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: key as string,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!response.ok) {
    throw new Error(`${fn}: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function countEdges(): Promise<number> {
  // The same aggregation rebuild_graph_edges() performs, read-only. If this
  // number and the function's return value ever disagree, the function is wrong.
  const response = await fetch(
    `${url}/rest/v1/tandems?select=user_a_id,user_b_id&status=eq.completed`,
    { headers: { apikey: key as string, Authorization: `Bearer ${key}` } },
  );
  if (!response.ok) throw new Error(`tandems: ${response.status} ${await response.text()}`);

  const rows = await response.json() as { user_a_id: string; user_b_id: string }[];
  const pairs = new Set<string>();
  for (const row of rows) {
    if (!row.user_a_id || !row.user_b_id || row.user_a_id === row.user_b_id) continue;
    pairs.add([row.user_a_id, row.user_b_id].sort().join('|'));
  }
  return pairs.size;
}

async function main(): Promise<void> {
  const expected = await countEdges();
  console.log(`completed tandems resolve to ${expected} distinct pairs`);

  if (DRY_RUN) {
    console.log('dry run — nothing written');
    return;
  }

  const written = await rpc('rebuild_graph_edges');
  console.log(`graph_edges rebuilt: ${String(written)} edges`);

  if (Number(written) !== expected) {
    console.warn(
      `WARNING: function wrote ${String(written)} edges, independent count said ${expected}. ` +
      'One of the two is wrong — check the status filter in rebuild_graph_edges().',
    );
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
