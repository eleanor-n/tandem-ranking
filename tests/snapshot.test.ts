/**
 * The `score_snapshot` contract.
 *
 * These are forward-compatibility tests. They are not checking that the code
 * works today — they are checking that a row written today is still readable by
 * a model fitted in a year, which is the only property that matters for a
 * training set and the only one that cannot be fixed retroactively.
 */

import { describe, expect, it } from 'vitest';
import {
  SNAPSHOT_APP_KEYS,
  SNAPSHOT_APP_KEY_LIST,
  SNAPSHOT_VERSION,
  buildSnapshotApp,
  emptySnapshotApp,
  validateSnapshotApp,
} from '../src/ranking/core/snapshot.js';
import { rank } from '../src/ranking/core/rank.js';
import { T0, makeViewer, standardPool } from './fixtures/index.js';

function deck(snapshotApp?: Parameters<typeof rank>[0]['snapshotApp']) {
  return rank({
    viewer: makeViewer(),
    candidates: standardPool(),
    interestEvents: [],
    sessionId: 's1',
    now: T0,
    ...(snapshotApp ? { snapshotApp } : {}),
  });
}

describe('shape', () => {
  it('is { v, computed, app } and nothing else at the top level', () => {
    const snap = deck().snapshots[0]!;
    expect(Object.keys(snap).sort()).toEqual(['app', 'computed', 'v']);
  });

  it('computed carries every feature, including ones the shipped order ignores', () => {
    const { computed } = deck().snapshots[0]!;

    // The shelved ranker's features are computed and logged even though
    // RANKER_ENABLED is false. A feature skipped because it is currently unused
    // is a column permanently missing from every row written today.
    for (const f of [
      'categoryAffinity', 'intentMatch', 'proximity', 'timeFit', 'socialContext',
      'hostReliability', 'acceptLikelihood', 'completionPrior',
      'repeatableContext', 'rhythmOverlap', 'freshness', 'graphAffinity',
    ] as const) {
      expect(typeof computed.features[f], f).toBe('number');
    }
    for (const factor of ['pJoin', 'pAccept', 'pComplete', 'rRepeat'] as const) {
      expect(typeof computed.funnel[factor], factor).toBe('number');
    }
    expect(computed.rankerEnabled).toBe(false);
    expect(typeof computed.algo).toBe('string');
    expect(typeof computed.regime).toBe('number');
  });
});

describe('null versus absent — the whole point of the versioning', () => {
  it('writes every app key as null when the app supplies nothing', () => {
    // NOT an empty object. A reader must be able to tell "we knew about
    // entry_point and did not have it" from "this row predates entry_point",
    // and after the fact that distinction is unrecoverable.
    const { app } = deck().snapshots[0]!;
    for (const key of SNAPSHOT_APP_KEY_LIST) {
      expect(key in app, `${key} must be present`).toBe(true);
      expect(app[key], `${key} must be null, not undefined`).toBeNull();
    }
  });

  it('never omits a key the app only partially populated', () => {
    const { app } = deck({ entry_point: 'notification', push_enabled: true }).snapshots[0]!;
    expect(app.entry_point).toBe('notification');
    expect(app.push_enabled).toBe(true);
    // The rest are still present, still null.
    expect(app.active_filters).toBeNull();
    expect('app_version' in app).toBe(true);
  });

  it('distinguishes an empty filter list from an unknown one', () => {
    // `[]` means "no filters were active". `null` means "the app did not say".
    // Collapsing them would make it impossible to tell a user who filtered
    // nothing from a build that never sent the field.
    expect(deck({ active_filters: [] }).snapshots[0]!.app.active_filters).toEqual([]);
    expect(deck().snapshots[0]!.app.active_filters).toBeNull();
  });

  it('drops unknown keys rather than passing them through', () => {
    const app = buildSnapshotApp({ notAKey: true } as never);
    expect('notAKey' in app).toBe(false);
    expect(Object.keys(app).sort()).toEqual([...SNAPSHOT_APP_KEY_LIST].sort());
  });
});

describe('version', () => {
  it('is not 1 — v1 was a different shape', () => {
    // v1 was flat: { v, features, funnel, regime, rankerEnabled, algo }.
    // Reusing the number for an incompatible layout is exactly what the field
    // exists to prevent: a reader applying v1 rules to a v2 object gets
    // `features === undefined` and no error.
    expect(SNAPSHOT_VERSION).toBeGreaterThan(1);
    expect(deck().snapshots[0]!.v).toBe(SNAPSHOT_VERSION);
  });
});

describe('SNAPSHOT_APP_KEYS', () => {
  it('lists exactly the keys of a written app object', () => {
    // If these ever drift, the typed key export stops being the thing that
    // turns a typo into a compile error, which is its only job.
    expect(Object.keys(SNAPSHOT_APP_KEYS).sort())
      .toEqual(Object.keys(emptySnapshotApp()).sort());
  });

  it('names active_filters, without which the candidate set is unknowable', () => {
    // Called out on its own because it is the highest-value key here: the
    // module cannot see the filter pills, and they determine what was eligible
    // to be shown. Without it a fit cannot separate "the ranker did not surface
    // it" from "the user filtered it out" — opposite implications, and not
    // recoverable downstream.
    expect(SNAPSHOT_APP_KEYS).toHaveProperty('active_filters');
  });
});

describe('validation', () => {
  it('passes a well-formed app object', () => {
    expect(validateSnapshotApp(emptySnapshotApp())).toEqual([]);
    expect(validateSnapshotApp(deck().snapshots[0]!.app)).toEqual([]);
  });

  it('reports a missing key and says to write null instead', () => {
    const partial = { ...emptySnapshotApp() } as Record<string, unknown>;
    delete partial['entry_point'];
    const problems = validateSnapshotApp(partial);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('entry_point');
    expect(problems[0]).toContain('null');
  });

  it('reports a typo rather than accepting it silently', () => {
    const typo = { ...emptySnapshotApp(), active_filter: [] };
    const problems = validateSnapshotApp(typo);
    expect(problems.some((p) => p.includes('active_filter'))).toBe(true);
  });

  it('never throws, whatever it is handed', () => {
    for (const junk of [null, undefined, 42, 'string', []]) {
      expect(() => validateSnapshotApp(junk)).not.toThrow();
    }
    expect(validateSnapshotApp(null)).toHaveLength(1);
  });
});
