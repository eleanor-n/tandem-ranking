/**
 * Merge sweep CSVs and print the podium with separation testing.
 *
 * WHY THIS EXISTS
 *
 * The sweep prints a podium for the arms inside ONE invocation. The ablations
 * are separate invocations — different flags, same seeds — so the headline
 * comparison in DIAGNOSTICS.md is assembled across runs. That assembly used to
 * happen in prose, by eye, which is exactly how four arms spanning 0.040 came to
 * be reported as a ranking without anyone computing whether 0.011 was a gap or
 * a draw.
 *
 * Usage:
 *   npm run podium -- label=path.csv label=path.csv ...
 *   npm run podium -- --metric host_gini --lower shipped=a.csv ablation_c=b.csv
 *
 * Requires the `se_*` columns, i.e. a CSV written by sweep.ts at v1.9 or later.
 */

import { readFileSync } from 'node:fs';

interface Row {
  label: string;
  users: number;
  seeds: number;
  value: number;
  se: number;
}

const METRIC_TO_SE: Record<string, string> = {
  host_retention: 'se_hostRetention',
  retention_after_empty: 'se_retentionAfterEmpty',
  repeat_rate: 'se_repeatRate',
  zero_joiner_rate: 'se_zeroJoinerRate',
  surviving_host_fraction: 'se_survivingHostFraction',
  host_gini: 'se_hostGini',
  deck_relevance: 'se_deckRelevance',
  tandems_per_user: 'se_tandemsPerUser',
};

function parse(path: string, label: string, metric: string): Row[] {
  const text = readFileSync(path, 'utf8').trim();
  const [header, ...lines] = text.split('\n');
  const cols = (header as string).split(',');

  const seCol = METRIC_TO_SE[metric];
  if (!seCol) throw new Error(`unknown metric ${metric}`);
  const vi = cols.indexOf(metric);
  const si = cols.indexOf(seCol);
  const ui = cols.indexOf('users');
  const ni = cols.indexOf('seeds');
  const ai = cols.indexOf('arm');
  if (vi < 0) throw new Error(`${path}: no column ${metric}`);
  if (si < 0) {
    throw new Error(
      `${path}: no column ${seCol}. This CSV predates v1.9 and has no error ` +
      'bars — re-run the sweep rather than comparing point estimates.',
    );
  }

  return lines.map((line) => {
    const f = line.split(',');
    // Multi-arm CSVs keep their own arm names; single-arm ablation runs are
    // named by the caller, since "ranker_repaired" is true but useless there.
    const arm = f[ai] as string;
    return {
      label: lines.length > 1 ? `${label}:${arm}` : label,
      users: Number(f[ui]),
      seeds: Number(f[ni]),
      value: Number(f[vi]),
      se: Number(f[si]),
    };
  });
}

/** Two-sample, unpaired. See sweep.ts `separates` for why not paired. */
function separates(a: Row, b: Row, bar = 2): boolean {
  const gap = Math.abs(a.value - b.value);
  const noise = Math.sqrt(a.se ** 2 + b.se ** 2);
  if (noise === 0) return gap > 0;
  return gap > bar * noise;
}

function main(): void {
  const argv = process.argv.slice(2);
  let metric = 'host_retention';
  let higherIsBetter = true;
  const specs: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--metric') { metric = argv[++i] as string; continue; }
    if (a === '--lower') { higherIsBetter = false; continue; }
    specs.push(a);
  }

  if (specs.length === 0) {
    console.error('usage: npm run podium -- [--metric M] [--lower] label=file.csv ...');
    process.exit(1);
  }

  const rows: Row[] = [];
  for (const spec of specs) {
    const eq = spec.indexOf('=');
    if (eq < 0) throw new Error(`expected label=path, got ${spec}`);
    rows.push(...parse(spec.slice(eq + 1), spec.slice(0, eq), metric));
  }

  const sizes = [...new Set(rows.map((r) => r.users))].sort((a, b) => a - b);

  for (const users of sizes) {
    const group = rows.filter((r) => r.users === users);
    const sorted = group.slice().sort((a, b) =>
      higherIsBetter ? b.value - a.value : a.value - b.value);
    const seeds = Math.min(...group.map((r) => r.seeds));

    console.log(`\n${metric} @ N=${users}, ${seeds} seeds ` +
      `(${higherIsBetter ? 'higher' : 'lower'} is better)`);
    console.log('  2 SE bar, two-sample, adjacent pairs\n');

    const blocks: Row[][] = [];
    let block: Row[] = [];
    for (const row of sorted) {
      const prev = block[block.length - 1];
      if (prev && separates(prev, row)) { blocks.push(block); block = []; }
      block.push(row);
    }
    if (block.length > 0) blocks.push(block);

    let place = 1;
    for (const b of blocks) {
      const tied = b.length > 1;
      for (const row of b) {
        console.log(
          `  ${tied ? `=${place}` : ` ${place}`}  ${row.label.padEnd(30)} ` +
          `${row.value.toFixed(3)} ±${row.se.toFixed(3)}`,
        );
      }
      if (tied) console.log(`       ^ ${b.length}-way tie: adjacent gaps inside 2 SE`);
      place += b.length;
    }

    // Adjacent margins, so a marginal separation is visible AS marginal rather
    // than being flattened into a yes.
    console.log('\n  adjacent gaps:');
    for (let i = 0; i + 1 < sorted.length; i++) {
      const a = sorted[i] as Row;
      const b = sorted[i + 1] as Row;
      const gap = Math.abs(a.value - b.value);
      const bar = 2 * Math.sqrt(a.se ** 2 + b.se ** 2);
      const ratio = bar > 0 ? gap / bar : Infinity;
      const mark = gap > bar ? (ratio < 1.25 ? 'SEPARATES (marginal)' : 'SEPARATES') : 'TIE';
      console.log(
        `    ${a.label} > ${b.label}: gap ${gap.toFixed(3)}, ` +
        `bar ${bar.toFixed(3)}, ${ratio.toFixed(2)}x  ${mark}`,
      );
    }

    const top = blocks[0] as Row[];
    console.log('');
    if (top.length === 1) {
      console.log(`  VERDICT: ${top[0]?.label} is best, separated from the field.`);
    } else if (top.length === sorted.length) {
      console.log('  VERDICT: NOT IDENTIFIED. No arm separates from any other.');
    } else {
      console.log(`  VERDICT: NOT IDENTIFIED at the top — ` +
        `${top.map((r) => r.label).join(', ')} tied for first.`);
    }
  }
}

main();
