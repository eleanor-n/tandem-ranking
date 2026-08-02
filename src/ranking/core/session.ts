/**
 * What this session has already shown — v1.7 §3.2.
 *
 * Discover shows ONE CARD AT A TIME. A user "keeps tandeming" until they close
 * the app, and the pool does not reset between cards. That single fact
 * invalidates every reserved-slot rule this repo had:
 *
 *   "at most 2 of a category per deck of 8" never binds when a session shows
 *   three cards, and stops meaning anything at all when it shows forty.
 *
 * A quota is a statement about a fixed-size window. There is no fixed-size
 * window. So diversity becomes a decaying multiplier over what this session has
 * already put in front of the person:
 *
 *   S_final x= categoryPenalty ^ shownThisSession(category)
 *   S_final x= hostPenalty     ^ shownThisSession(host)
 *
 * Three properties that the caps did not have:
 *
 *   * it degrades gracefully at ANY session length — one card, eight, or
 *     ninety, with no cliff and no cap that silently stops applying
 *   * it costs no reserved slot, so nothing is displaced and no relaxation
 *     ladder is needed. The deck can never come out short because a constraint
 *     could not be met, since a penalised card is still a card
 *   * it is monotone: the fourth coffee is worse than the third, rather than
 *     forbidden where the third was free
 *
 * The counters are plain records rather than Maps so the whole thing serialises
 * — a session survives a re-render, and in a React Native app that matters more
 * than the constant factor.
 */

import type { CategorySlug, SlateCard, UserId } from './types.js';

/** Per-session counters. Immutable; every update returns a new object. */
export interface SessionShown {
  byCategory: Readonly<Record<CategorySlug, number>>;
  byHost: Readonly<Record<UserId, number>>;
}

/** A session that has shown nothing. Also the correct value for a cold start. */
export const EMPTY_SESSION: SessionShown = Object.freeze({
  byCategory: Object.freeze({}),
  byHost: Object.freeze({}),
});

/**
 * Fold a deck's worth of cards into the counters.
 *
 * Called after a deck is handed out, on the assumption that a returned card is
 * a shown card. That over-counts slightly when someone closes the app halfway
 * through — which biases toward MORE diversity next session, the harmless
 * direction. Tracking true impressions instead would mean the ranker could not
 * produce a deck without waiting for the UI to confirm the previous one, and
 * that is a worse trade than a small over-count.
 */
export function noteShown(
  shown: SessionShown,
  cards: readonly Pick<SlateCard, 'category' | 'hostId'>[],
): SessionShown {
  if (cards.length === 0) return shown;

  const byCategory: Record<CategorySlug, number> = { ...shown.byCategory };
  const byHost: Record<UserId, number> = { ...shown.byHost };

  for (const card of cards) {
    byCategory[card.category] = (byCategory[card.category] ?? 0) + 1;
    byHost[card.hostId] = (byHost[card.hostId] ?? 0) + 1;
  }

  return { byCategory, byHost };
}

/** How many of this category the session has shown. */
export function categoryCount(shown: SessionShown, category: CategorySlug): number {
  return shown.byCategory[category] ?? 0;
}

/** How many cards from this host the session has shown. */
export function hostCount(shown: SessionShown, hostId: UserId): number {
  return shown.byHost[hostId] ?? 0;
}

/**
 * The multiplier for a card, given what the session has already shown.
 *
 *   penalty^n, with n the count so far. n = 0 gives exactly 1, so an unseen
 *   category or host is never touched.
 *
 * A penalty of exactly 1 disables the term (village scale approaches this,
 * because there is barely anything to diversify INTO). A penalty of 0 would be
 * a hard cap in disguise and is rejected at load time in constants.ts — the
 * score orders and never filters, and a card multiplied to zero is
 * indistinguishable from an ineligible one.
 */
export function sessionPenalty(
  shown: SessionShown,
  card: Pick<SlateCard, 'category' | 'hostId'>,
  categoryPenalty: number,
  hostPenalty: number,
): number {
  return (
    Math.pow(categoryPenalty, categoryCount(shown, card.category)) *
    Math.pow(hostPenalty, hostCount(shown, card.hostId))
  );
}
