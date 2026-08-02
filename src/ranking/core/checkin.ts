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
 * answered, oldest first, one at a time — is a function of data and a clock
 * reading. Putting it here rather than in the adapter means it is testable
 * without a database and cannot acquire a hidden dependency on one.
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
  Epoch,
  GivenFeedback,
  PendingCheckIn,
  TandemRecord,
  UserId,
} from './types.js';

const MS_PER_HOUR = 3_600_000;

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
 * What this user owes, in the order to ask it.
 *
 * Oldest first: a check-in decays in usefulness — someone asked about last
 * Tuesday gives a better answer than someone asked about six weeks ago — and
 * asking the stalest one first is what stops a backlog quietly becoming
 * permanent.
 *
 * Filtered on three things and nothing else:
 *   1. the tandem completed (`tandems.status`, not `activities.status`)
 *   2. it ended at least `minElapsedHours` ago
 *   3. this rater has not already answered for this counterpart
 *
 * A SKIP LEAVES NO ROW, so a skipped check-in reappears here next time. That is
 * deliberate and it is the reason skip is not stored as a negative: a person
 * who did not answer is not a person who said no, and conflating the two
 * teaches people that answering honestly has consequences.
 */
export function pendingCheckIns(
  userId: UserId,
  tandems: readonly TandemRecord[],
  given: readonly GivenFeedback[],
  now: Epoch,
): PendingCheckIn[] {
  const answered = new Set(given.map((g) => `${g.tandemId}|${g.ratedId}`));

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
    if (answered.has(`${tandem.tandemId}|${ratedId}`)) continue;

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

  return out.sort((a, b) => a.endedAt - b.endedAt || a.tandemId.localeCompare(b.tandemId));
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
