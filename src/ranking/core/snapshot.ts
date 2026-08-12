/**
 * The `score_snapshot` contract — v1.9 §2.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS FOR
 *
 * `ranking_events.score_snapshot` is the training set for every future version
 * of this ranker. Not a debug log — the training set. A feature that is not
 * written here on the day an impression happens is a column that is permanently
 * missing from that row, and no amount of later work recovers it.
 *
 * That asymmetry is the whole design:
 *
 *   forgetting to log a feature   -> permanent, unrecoverable
 *   logging one nobody ever uses  -> a few bytes
 *
 * So everything computed gets written, including features the shelved ranker
 * produces that have no effect on the shipped ordering.
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE
 *
 *   { v, computed, app }
 *
 *   computed  everything THIS MODULE calculates. Always fully populated.
 *   app       everything only the parent app knows. Every key always present,
 *             `null` until Eleanor populates it.
 *
 * The split exists because the two halves have different failure modes. A
 * missing `computed` key is this module's bug. A missing `app` key is an
 * integration that has not happened yet — expected, fine, and not an error.
 *
 * ---------------------------------------------------------------------------
 * NULL VERSUS ABSENT — read this before adding a key
 *
 *   key present, value null   the field was KNOWN ABOUT and unavailable here
 *   key absent                the row PREDATES the field
 *
 * These mean different things when fitting a model, and the difference is not
 * recoverable after the fact if the distinction is not maintained on the way in.
 *
 * A null tells you the row is a genuine missing observation: you can impute it,
 * or drop the row, or model the missingness. An absent key tells you the row is
 * from an older regime, and the honest thing is usually to exclude it from any
 * fit involving that feature.
 *
 * Collapse the two and you get the worst outcome available: a model trained on
 * rows where "false" and "we were not recording this yet" are the same value.
 *
 * Which is why `app` keys are written as explicit nulls rather than omitted,
 * and why `v` increments whenever a key is ADDED to either object.
 */

import type { FeatureVector, FunnelScore } from './types.js';

// ---------------------------------------------------------------------------
// CHANGELOG
// ---------------------------------------------------------------------------

/**
 * Every snapshot version, and what it added. Append only.
 *
 * | v | shipped | change |
 * |---|---|---|
 * | 1 | v1.7 | Initial. Flat: `{ v, features, funnel, regime, rankerEnabled, algo }`. |
 * | 2 | v1.9 | Restructured to `{ v, computed, app }`. `computed` holds v1's five fields unchanged; `app` is new and starts fully null. |
 *
 * WHY v2 AND NOT v1, given that v1.9 §2 specifies `"v": 1`.
 *
 * v1 is already defined, already written by `rank.ts`, and has a different
 * shape. Reusing the number for a second, incompatible layout is precisely the
 * thing the version field exists to prevent — a reader that sees `v: 1` and
 * applies v1 rules to a v2 object gets `features === undefined` and no error.
 *
 * The counter-argument is that `ranking_events` holds 16 rows with a NULL
 * `score_snapshot` (SCHEMA.md §2), so possibly nothing was ever written in the
 * v1 shape and the number is free. That cannot be verified from the repo, and
 * the cost of being wrong is asymmetric: bumping when we did not need to costs
 * one integer, while not bumping when we did need to silently corrupts the
 * training set at its root.
 *
 * PRECHECK query, if the number matters to anyone:
 *
 *   select score_snapshot->>'v' as v, count(*)
 *     from public.ranking_events
 *    where score_snapshot is not null
 *    group by 1;
 *
 * If that returns no rows, v1 was never written and this could safely have been
 * 1. Flagged rather than assumed.
 */
export const SNAPSHOT_VERSION = 2;

// ---------------------------------------------------------------------------
// The `app` half
// ---------------------------------------------------------------------------

/** Where the viewer was when they saw the card. */
export type SnapshotEntryPoint =
  | 'discover'
  | 'notification'
  | 'deep_link'
  | 'unknown';

/**
 * Context only the parent app has. Every field nullable, every field always
 * written.
 *
 * PARTIAL POPULATION IS EXPECTED. Fill in what is cheap, leave the rest null,
 * and add more later — that is what the nulls are for. There is no failure mode
 * here other than never starting.
 */
export interface SnapshotApp {
  /**
   * Whether the viewer passed the Rekognition face check.
   *
   * The module already uses this in scoring when the profile row carries it,
   * but the profile read can fail or the column can be stale, so the app's
   * value is the authoritative one for training purposes.
   */
  viewer_verified: boolean | null;

  /**
   * Whether the viewer's profile is filled in.
   *
   * A proxy for intent. Someone who completed onboarding and wrote a bio is a
   * different population from someone who bounced halfway, and every engagement
   * metric differs between them.
   */
  viewer_profile_complete: boolean | null;

  /** Same check for the host of the card being shown. */
  host_verified: boolean | null;

  /**
   * How the viewer arrived at this card.
   *
   * A card seen from a push notification is not the same card as one seen
   * mid-scroll: the viewer has already been selected for by tapping, and the
   * join rate is not comparable. Without this, notification traffic silently
   * inflates the measured quality of whatever it happened to surface.
   */
  entry_point: SnapshotEntryPoint | null;

  /**
   * The filter pills active when the deck was built.
   *
   * THE HIGHEST-VALUE KEY IN THIS TABLE. The module cannot see the pills, and
   * they determine the candidate set — so without this, a fit cannot tell
   * "the ranker did not show it" from "the user filtered it out". Those have
   * opposite implications for every ranking decision, and no amount of
   * downstream cleverness separates them after the fact.
   *
   * Empty array means "no filters active". `null` means "the app did not tell
   * us". They are not the same and must not be collapsed.
   */
  active_filters: string[] | null;

  /**
   * The app build the impression came from.
   *
   * Cheap insurance. When a release turns out to have had a broken Discover
   * tab, this is what lets that period be excluded from a fit instead of
   * poisoning it — and that decision is always made retrospectively, which is
   * exactly why the field has to be there in advance.
   */
  app_version: string | null;

  /**
   * Whether the viewer has push enabled.
   *
   * Confounds every engagement signal in the dataset: push-enabled users return
   * more often for reasons that have nothing to do with what the ranker chose.
   */
  push_enabled: boolean | null;
}

/**
 * The reserved keys, as a typed object.
 *
 * Exported so the parent app gets autocomplete and a COMPILE ERROR on a typo,
 * rather than a silently misspelled key that produces a column of nulls nobody
 * notices for a month.
 *
 * The values are the documented types, as strings, so this doubles as the
 * reference table without anyone opening this file.
 */
export const SNAPSHOT_APP_KEYS = {
  viewer_verified: 'boolean | null',
  viewer_profile_complete: 'boolean | null',
  host_verified: 'boolean | null',
  entry_point: "'discover' | 'notification' | 'deep_link' | 'unknown' | null",
  active_filters: 'string[] | null',
  app_version: 'string | null',
  push_enabled: 'boolean | null',
} as const satisfies Record<keyof SnapshotApp, string>;

/** Every reserved key, for iteration. */
export const SNAPSHOT_APP_KEY_LIST = Object.keys(SNAPSHOT_APP_KEYS) as Array<keyof SnapshotApp>;

/**
 * A fully-null `app` object.
 *
 * This is what gets written when the app supplies nothing, and it is why an
 * un-integrated row is still a well-formed row: every key is present, so a
 * later reader can tell "unavailable" from "did not exist yet" on day one.
 */
export function emptySnapshotApp(): SnapshotApp {
  return {
    viewer_verified: null,
    viewer_profile_complete: null,
    host_verified: null,
    entry_point: null,
    active_filters: null,
    app_version: null,
    push_enabled: null,
  };
}

/**
 * Merge whatever the app supplied over the all-null default.
 *
 * Unknown keys are DROPPED rather than passed through. A typo'd key that
 * silently rides along would look like data in the warehouse and be worthless,
 * and `validateSnapshotApp` reports it so it gets fixed.
 */
export function buildSnapshotApp(partial?: Partial<SnapshotApp> | null): SnapshotApp {
  const out = emptySnapshotApp();
  if (!partial) return out;
  const sink = out as unknown as Record<string, unknown>;
  for (const key of SNAPSHOT_APP_KEY_LIST) {
    const value = partial[key];
    if (value !== undefined) sink[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The `computed` half
// ---------------------------------------------------------------------------

/**
 * Everything this module calculates for one card.
 *
 * Resolved parameters are deliberately NOT here: they are a pure function of
 * (`algo`, `regime`), so writing all ~16 onto every impression would duplicate
 * onto thousands of rows something reconstructable from a git tag.
 */
export interface SnapshotComputed {
  /** Every feature, whether or not the shipped ordering used it. */
  features: FeatureVector;
  /** The decomposed funnel, including factors currently gated off. */
  funnel: FunnelScore;
  /** Density scalar in force, 0 village to 1 city. */
  regime: number;
  /** False when the ranker was shelved and the deck was proximity-ordered. */
  rankerEnabled: boolean;
  /** Identifies the parameter table in force, so `regime` resolves later. */
  algo: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Check that a written `app` object has every reserved key.
 *
 * PURE, and returns problems rather than logging them: `core/` has no logger by
 * design and `purity.test.ts` enforces it. The adapter does the warning, once
 * per session, and never throws — a malformed snapshot is a data-quality
 * problem, and taking down someone's Discover tab over one is not a trade
 * anybody would choose.
 */
export function validateSnapshotApp(app: unknown): string[] {
  const problems: string[] = [];

  if (typeof app !== 'object' || app === null) {
    return ['snapshot.app is not an object'];
  }

  const record = app as Record<string, unknown>;

  for (const key of SNAPSHOT_APP_KEY_LIST) {
    if (!(key in record)) {
      problems.push(
        `snapshot.app is missing "${key}" — write it as null rather than ` +
        'omitting it, or a later reader cannot tell "unavailable" from ' +
        '"predates the field"',
      );
    }
  }

  for (const key of Object.keys(record)) {
    if (!(key in SNAPSHOT_APP_KEYS)) {
      problems.push(
        `snapshot.app has unexpected key "${key}" — likely a typo. Import ` +
        'SNAPSHOT_APP_KEYS and index off it to get a compile error instead.',
      );
    }
  }

  return problems;
}
