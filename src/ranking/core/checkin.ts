/**
 * The post-tandem check-in — v1.7 §2.2. Scheduling logic only.
 *
 * "Would you tandem with them again?" is the single most predictive signal in
 * the whole system and the ONLY route the ranker has to pairwise
 * compatibility. Everything §3 says about exhaustion is gated on it, which is
 * why exhaustion ships switched off: without check-in data `repeatAffinity` is
 * 0.5 for every pairing, so exhaustion damps good repeats and bad ones
 * identically — actively working against the metric it exists to serve.
 *
 * This file decides WHO to ask and WHEN. It does not decide what to say: copy
 * and UI belong to Eleanor, and nothing here renders anything.
 *
 * ---------------------------------------------------------------------------
 * Why this is pure
 *
 * The whole scheduling rule — ended, plus two hours, minus anything already
 * answered or currently skipped, dropped after a week, most recent first, one at
 * a time — is a function of data and a clock reading. Putting it here rather
 * than in the adapter means it is testable without a database and cannot acquire
 * a hidden dependency on one. The skip escalation (`nextSkipRetry`) lives here
 * for the same reason: it is policy, not I/O.
 *
 * ---------------------------------------------------------------------------
 * Pairwise, and staying that way
 *
 * `tandems` is strictly pairwise, so a check-in has exactly one counterpart.
 * There is no "rate everyone" screen and no fan-out. When group tandems arrive
 * as a clique of pairwise rows (SCHEMA.md §3), this function needs no change:
 * it will simply return three pending check-ins for a three-person group, which
 * `maxPromptsPerAppOpen` then meters out one per open.
 */

import { CONSTANTS } from './constants.js';
import type {
  CheckInSkip,
  Epoch,
  GivenFeedback,
  PendingCheckIn,
  TandemRecord,
  UserId,
} from './types.js';

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/** The status that means a tandem actually happened. See SCHEMA.md §1. */
export const COMPLETED_STATUS = 'completed';

/**
 * When a tandem became askable.
 *
 * `endedAt` when the activity link gives us one; otherwise the tandem's own
 * creation time plus the assumed duration. The fallback exists because
 * `activities` may have no end column at all ([S3] in SCHEMA.md) — being wrong
 * here delays or advances a prompt and cannot corrupt an answer.
 */
export function askableFrom(tandem: TandemRecord): Epoch {
  const ended = tandem.endedAt
    ?? tandem.createdAt + CONSTANTS.checkin.assumedDurationHours * MS_PER_HOUR;
  return ended + CONSTANTS.checkin.minElapsedHours * MS_PER_HOUR;
}

/**
 * When a tandem stops being askable (v1.9.1 §2).
 *
 * Measured from the activity's END, not from when it became askable, so the
 * window means "how long ago did this happen" — which is the thing recall
 * actually decays with. `minElapsedHours` therefore eats into the window rather
 * than extending it, which is correct: those two hours are part of the elapsed
 * time whether we asked or not.
 */
export function askableUntil(tandem: TandemRecord): Epoch {
  const ended = tandem.endedAt
    ?? tandem.createdAt + CONSTANTS.checkin.assumedDurationHours * MS_PER_HOUR;
  return ended + CONSTANTS.checkin.eligibilityWindowDays * MS_PER_DAY;
}

/**
 * What a skip should set `retry_after` to (v1.9.1 §3).
 *
 * First skip -> a timestamp `skipRetryDays` out. Second -> `null`, meaning
 * never again.
 *
 * Pure and separate from the write so the escalation is testable without a
 * database and cannot be re-decided by an adapter. `existing` is the row
 * already in `checkin_skips` for this (tandem, rater), if any.
 *
 * Note the failure direction if `existing` could not be read: the caller passes
 * `undefined`, this returns a fresh retry, and the prompt comes back once more.
 * An extra prompt is an annoyance; a label silently lost is permanent. The
 * degradation goes the recoverable way by construction.
 */
export function nextSkipRetry(existing: CheckInSkip | undefined, now: Epoch): Epoch | null {
  if (existing) return null;
  return now + CONSTANTS.checkin.skipRetryDays * MS_PER_DAY;
}

/**
 * Is this skip currently suppressing its check-in?
 *
 * `null` retry -> yes, permanently. A retry in the future -> yes, for now. A
 * retry in the past -> no, ask again.
 */
export function skipSuppresses(skip: CheckInSkip, now: Epoch): boolean {
  if (skip.retryAfter === null) return true;
  return skip.retryAfter > now;
}

/**
 * What this user owes, in the order to ask it.
 *
 * MOST RECENT FIRST (v1.9 §3), within a fixed eligibility window (v1.9.1 §2).
 *
 * The ordering reverses v1.7, which asked oldest-first on the reasoning that a
 * backlog left alone quietly becomes permanent. That reasoning was about the
 * QUEUE. Most-recent-first is about the ANSWER: a check-in decays in
 * usefulness, and someone asked about last Tuesday gives a better answer than
 * someone asked about six weeks ago.
 *
 * v1.9 recorded a real cost for that choice — with `maxPromptsPerAppOpen = 1`,
 * a very old check-in could be starved indefinitely by fresher arrivals.
 * **That cost no longer exists**, because pending check-ins no longer live
 * forever: past `eligibilityWindowDays` they are dropped, not queued. The
 * tradeoff between the two orderings was entirely a consequence of the
 * unbounded queue, and bounding the queue dissolves it rather than settling it.
 *
 * Dropping them is the intended behaviour, not a loss. Recall on a
 * three-week-old tandem is poor, so those labels would be noise — and noise is
 * worse than absence in the highest-weighted signal in the model, because
 * nothing downstream can tell a guessed answer from a remembered one.
 *
 * Filtered on five things and nothing else:
 *   1. the tandem completed (`tandems.status`, not `activities.status`)
 *   2. it ended at least `minElapsedHours` ago
 *   3. it ended at most `eligibilityWindowDays` ago (v1.9.1 §2)
 *   4. this rater has not already answered for this counterpart
 *   5. no live skip is suppressing it (v1.9.1 §3)
 *
 * ---------------------------------------------------------------------------
 * ON SKIPS — soft, not hard
 *
 * Three versions, worth keeping straight:
 *   v1.7   stored nothing; a skipped prompt returned next session.
 *   v1.9   stored the skip and never asked again.
 *   v1.9.1 stores the skip with a `retryAfter`: one more ask after
 *          `skipRetryDays`, then never.
 *
 * v1.9's hard suppression was specified in error. Labels are the scarcest
 * resource in this system and one dismissal is ambiguous — a mis-tap, a bad
 * moment, someone mid-something-else — so spending a label permanently on it is
 * the wrong price. Two dismissals is an answer, and asking past that reads as
 * the app not listening. Hence the asymmetry.
 *
 * The retry is still subject to the window above, so a skip late in the window
 * simply expires and never returns. With 5 < 7 that is the common case, and it
 * is fine: the window is the outer bound and the retry only ever operates
 * inside it.
 *
 * What has NOT changed across any of the three, and must not: **a skip is not a
 * negative.** It writes no `interest_events` row, carries no polarity, and
 * lives in its own table with no `rated_id` (see the v1.9 migration header). A
 * person who did not answer is not a person who said no, and conflating the two
 * teaches people that answering honestly has consequences — which costs the
 * signal permanently, not just for that row.
 */
export function pendingCheckIns(
  userId: UserId,
  tandems: readonly TandemRecord[],
  given: readonly GivenFeedback[],
  now: Epoch,
  skipped: readonly CheckInSkip[] = [],
): PendingCheckIn[] {
  const answered = new Set(given.map((g) => `${g.tandemId}|${g.ratedId}`));
  // Filtered by rater, not trusted to arrive pre-filtered. Both directions of a
  // tandem share a `tandemId`, so skipping on the rater alone would let one
  // person's dismissal suppress their counterpart's prompt — silently, and in
  // the direction that loses an answer.
  const suppressed = new Set(
    skipped
      .filter((s) => s.raterId === userId && skipSuppresses(s, now))
      .map((s) => s.tandemId),
  );

  const out: PendingCheckIn[] = [];

  for (const tandem of tandems) {
    if (tandem.status !== COMPLETED_STATUS) continue;

    const isA = tandem.userAId === userId;
    const isB = tandem.userBId === userId;
    if (!isA && !isB) continue;

    // Exactly one counterpart, because tandems are pairwise.
    const ratedId = isA ? tandem.userBId : tandem.userAId;
    if (ratedId === userId) continue;                 // malformed row; skip it

    if (askableFrom(tandem) > now) continue;
    if (askableUntil(tandem) < now) continue;         // expired — v1.9.1 §2
    if (answered.has(`${tandem.tandemId}|${ratedId}`)) continue;
    if (suppressed.has(tandem.tandemId)) continue;

    const endedAt = tandem.endedAt
      ?? tandem.createdAt + CONSTANTS.checkin.assumedDurationHours * MS_PER_HOUR;

    out.push({
      tandemId: tandem.tandemId,
      raterId: userId,
      ratedId,
      ...(tandem.activityId ? { activityId: tandem.activityId } : {}),
      ...(tandem.category ? { category: tandem.category } : {}),
      endedAt,
    });
  }

  // Most recent first. Tie broken on id so the order is total and stable —
  // two tandems that ended in the same millisecond must not swap between calls,
  // or `maxPromptsPerAppOpen = 1` would surface a different one each open.
  return out.sort((a, b) => b.endedAt - a.endedAt || a.tandemId.localeCompare(b.tandemId));
}

/**
 * How many to actually surface on this app open.
 *
 * One. A queue of five on launch is an interrogation, and the second answer is
 * already worse than the first.
 */
export function checkInsToPrompt(pending: readonly PendingCheckIn[]): PendingCheckIn[] {
  return pending.slice(0, CONSTANTS.checkin.maxPromptsPerAppOpen);
}
