/**
 * The explanation layer.
 *
 * These tests are about honesty, not ranking. A wrong reason line is worse than
 * a generic one: it tells the user the system does not know them, and it does
 * it in a way they can catch.
 */

import { describe, expect, it } from 'vitest';
import { candidateReasons, selectReason } from '../src/ranking/core/explain.js';
import { computeFeatures } from '../src/ranking/core/features.js';
import { computeInterestState } from '../src/ranking/core/interest.js';
import { CONSTANTS } from '../src/ranking/core/constants.js';
import {
  DAY,
  T0,
  coldStartViewer,
  makeCandidate,
  makeEvent,
  makeHost,
  makeViewer,
  spreadEvents,
} from './fixtures/index.js';

function reasonFor(
  viewer = makeViewer(),
  candidate = makeCandidate({ activityId: 'x1' }),
  events = spreadEvents('coffee', 'tandem_completed', 4, 20, 'c'),
) {
  const state = computeInterestState(events, T0, viewer.userId);
  const features = computeFeatures(viewer, candidate, state, T0);
  return {
    selected: selectReason(viewer, candidate, features, state),
    all: candidateReasons(viewer, candidate, features, state),
    state,
    features,
  };
}

describe('only provable claims', () => {
  it('does not claim a shared ideal saturday unless the host said it too', () => {
    // Viewer said coffee_and_a_book -> coffee. Host said nothing.
    const { all } = reasonFor(
      makeViewer(),
      makeCandidate({
        activityId: 'x1',
        category: 'coffee',
        host: makeHost({ hostId: 'h', idealSaturday: [] }),
      }),
    );
    expect(all.some((r) => r.kind === 'ideal_saturday')).toBe(false);
  });

  it('claims it when both sides actually said it', () => {
    const { all } = reasonFor(
      makeViewer(),
      makeCandidate({
        activityId: 'x1',
        category: 'coffee',
        metrics: ['coffee'],
        host: makeHost({ hostId: 'h', idealSaturday: ['coffee'] }),
      }),
    );
    const reason = all.find((r) => r.kind === 'ideal_saturday');
    expect(reason).toBeDefined();
    expect(reason!.text).toBe('you both put coffee in your ideal saturday.');
  });

  it('does not claim "you keep saying yes" off a single event', () => {
    const { all } = reasonFor(
      makeViewer(),
      makeCandidate({ activityId: 'x1', category: 'coffee' }),
      [makeEvent({ metric: 'coffee', source: 'join_requested', createdAt: T0 })],
    );
    expect(all.some((r) => r.kind === 'behavioral_affinity')).toBe(false);
  });

  it('does claim it once a pattern exists', () => {
    const { all } = reasonFor(
      makeViewer(),
      makeCandidate({ activityId: 'x1', category: 'coffee' }),
      spreadEvents('coffee', 'tandem_completed', 4, 20, 'c'),
    );
    const reason = all.find((r) => r.kind === 'behavioral_affinity');
    expect(reason).toBeDefined();
    expect(reason!.text).toBe('you keep saying yes to coffee.');
  });

  it('never claims a shared rhythm from the thin-data default', () => {
    // Neither side has any bucket history — rhythmOverlap is 0.5 by default,
    // which must not be reported as an observation.
    const viewer = makeViewer({ activeBuckets: [] });
    const { all, features } = reasonFor(
      viewer,
      makeCandidate({
        activityId: 'x1',
        host: makeHost({ hostId: 'h', activeBuckets: [] }),
      }),
    );
    expect(features.rhythmOverlap).toBe(CONSTANTS.features.thinDataDefault);
    expect(all.some((r) => r.kind === 'rhythm')).toBe(false);
  });

  it('surfaces an explicit statement the user made', () => {
    const { all } = reasonFor(
      makeViewer(),
      makeCandidate({ activityId: 'x1', category: 'hiking', metrics: ['hiking'] }),
      [makeEvent({ metric: 'hiking', source: 'explicit_statement', createdAt: T0 - DAY })],
    );
    const reason = all.find((r) => r.kind === 'explicit_interest');
    expect(reason).toBeDefined();
    expect(reason!.text).toBe("you told us you're into hiking.");
  });
});

describe('selection', () => {
  it('falls back to the canned category line when nothing clears the bar', () => {
    // A cold-start viewer looking at a far-away one-off in a category they
    // never mentioned, hosted by someone with no shared answers: nothing here
    // is defensible, so nothing specific gets said.
    const { selected } = reasonFor(
      coldStartViewer(),
      makeCandidate({
        activityId: 'x1',
        category: 'concerts',
        metrics: ['concerts'],
        shape: 'one_off',
        distanceMiles: 40,
        host: makeHost({ hostId: 'h', idealSaturday: [], activeBuckets: [] }),
      }),
      [],
    );
    expect(selected.kind).toBe('category_fallback');
    expect(selected.text).toBe('concerts, nearby.');
  });

  it('will not say "you\'re both here for X" unless the host said X too', () => {
    const viewer = makeViewer({ tandemIntent: 'routine' });
    const base = {
      activityId: 'x1',
      category: 'coffee',
      metrics: ['coffee'],
      shape: 'routine' as const,
      distanceMiles: 1,
    };

    const oneSided = reasonFor(viewer, makeCandidate({
      ...base, host: makeHost({ hostId: 'h' }),
    })).all.find((r) => r.kind === 'intent_match');
    expect(oneSided!.text).toBe('routine — which is what you said you came for.');
    expect(oneSided!.vars['mutual']).toBe('false');

    const mutual = reasonFor(viewer, makeCandidate({
      ...base, host: makeHost({ hostId: 'h', tandemIntent: 'routine' }),
    })).all.find((r) => r.kind === 'intent_match');
    expect(mutual!.text).toBe("you're both here for routine.");
  });

  it('prefers a checkable claim over a stronger but generic one', () => {
    // Proximity would score higher, but a shared onboarding answer is something
    // the user can verify, so it wins on priority.
    const { selected } = reasonFor(
      makeViewer(),
      makeCandidate({
        activityId: 'x1',
        category: 'coffee',
        metrics: ['coffee'],
        distanceMiles: 0.2,
        host: makeHost({ hostId: 'h', idealSaturday: ['coffee'] }),
      }),
    );
    expect(selected.kind).toBe('ideal_saturday');
  });

  it('renders short distances as walkable rather than as a number', () => {
    const { all } = reasonFor(
      makeViewer(),
      makeCandidate({ activityId: 'x1', distanceMiles: 0.3 }),
    );
    const proximityReason = all.find((r) => r.kind === 'proximity');
    expect(proximityReason!.text).toBe('a few minutes away. basically no excuse.');
  });

  it('carries no score into the reason text', () => {
    const { selected } = reasonFor();
    // No stray floats: the only digits allowed are in a distance.
    const digits = selected.text.match(/\d+(\.\d+)?/g) ?? [];
    for (const d of digits) {
      expect(selected.text).toContain(`${d} miles away`);
    }
  });
});
