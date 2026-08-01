/**
 * Deterministic randomness and hashing.
 *
 * No dependencies, no Node `crypto`, no `Math.random`. This runs on Hermes
 * (Expo) and in a browser and in Node with identical output, which is the whole
 * point: given the same inputs and the same seed, a deck is byte-identical.
 */

import { CONSTANTS } from './constants.js';

/**
 * FNV-1a, 32-bit. Used to turn strings into seeds and to fingerprint an event
 * set. Not cryptographic — it does not need to be; it needs to be stable across
 * JS engines, which it is.
 */
export function fnv1a(input: string): number {
  let hash: number = CONSTANTS.random.fnvOffset;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // Multiply by the FNV prime in 32-bit space without overflowing to float.
    hash = Math.imul(hash, CONSTANTS.random.fnvPrime);
  }
  return hash >>> 0;
}

/** Hex form of fnv1a, for storing as a fingerprint. */
export function fnv1aHex(input: string): string {
  return fnv1a(input).toString(16).padStart(8, '0');
}

/**
 * Order-independent fingerprint of a set of ids. XOR-folds each id's hash so
 * that the same events in a different order produce the same hash — otherwise
 * a cache would look stale every time the backend changed its sort order.
 */
export function hashIdSet(ids: readonly string[]): string {
  let acc = 0;
  let count = 0;
  for (const id of ids) {
    acc = (acc ^ fnv1a(id)) >>> 0;
    count++;
  }
  // Mix the count in so that {a} and {a, a} are distinguishable.
  return `${(acc >>> 0).toString(16).padStart(8, '0')}:${count}`;
}

/** A seeded pseudo-random generator: successive calls return floats in [0, 1). */
export type Rng = () => number;

/**
 * mulberry32. 32 bits of state, good enough statistically for slate shuffling,
 * and short enough to audit at a glance.
 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The session seed. Derived from userId + sessionId so that two users in the
 * same session, or the same user in two sessions, explore differently — but a
 * re-render inside one session does not reshuffle the deck under the user's
 * thumb.
 */
export function seedFor(userId: string, sessionId: string): number {
  return fnv1a(`${userId}::${sessionId}`);
}

/** Fisher-Yates using the supplied Rng. Returns a new array; does not mutate. */
export function seededShuffle<T>(items: readonly T[], rng: Rng): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i] as T;
    const b = out[j] as T;
    out[i] = b;
    out[j] = a;
  }
  return out;
}
