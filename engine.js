/**
 * engine.js — pure game rules. No I/O, no state mutation of rooms.
 * Everything here is deterministic and unit-tested in test/engine.test.js
 */

export const SUITS = ['S', 'H', 'D', 'C'];
export const SUIT_NAMES = { S: 'Spades', H: 'Hearts', D: 'Diamonds', C: 'Clubs' };
export const SUIT_SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };
export const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
export const RANK_LABEL = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

export const MIN_PLAYERS = 5;
export const MAX_PLAYERS = 10;

export function rankLabel(rank) {
  return RANK_LABEL[rank] || String(rank);
}

export function cardId(rank, suit) {
  return `${rank}${suit}`;
}

export function parseCard(id) {
  const suit = id.slice(-1);
  const rank = parseInt(id.slice(0, -1), 10);
  return { rank, suit, id };
}

export function cardName(card) {
  return `${rankLabel(card.rank)}${SUIT_SYMBOL[card.suit]}`;
}

/** Standard 52-card deck. No jokers, no duplicates. */
export function makeDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit, id: cardId(rank, suit) });
    }
  }
  return deck;
}

/** Fisher-Yates. rnd is injectable so tests can be deterministic. */
export function shuffle(cards, rnd = Math.random) {
  const a = cards.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Opening hand size = floor(51 / players).
 * 51 rather than 52 because exactly one card must remain undealt to be
 * flipped as the trump card.
 *   5p -> 10, 6p -> 8, 7p -> 7, 8p -> 6, 9p -> 5, 10p -> 5
 */
export function maxHandSize(numPlayers) {
  return Math.floor(51 / numPlayers);
}

/**
 * The round ladder: descend from max to 1, then ascend back to max.
 * e.g. 10 players -> [5,4,3,2,1,2,3,4,5]
 */
export function buildSchedule(numPlayers) {
  const max = maxHandSize(numPlayers);
  const out = [];
  for (let n = max; n >= 1; n--) out.push(n);
  for (let n = 2; n <= max; n++) out.push(n);
  return out;
}

/**
 * Trump for a round.
 * If the freshly flipped suit equals the previous round's ACTIVE trump suit,
 * this round is no-trump. A no-trump round clears the active trump, so the
 * same suit may immediately become trump again on the following round.
 * A repeated suit therefore alternates: Hearts, none, Hearts, none...
 *
 * @param flippedSuit suit of the card turned up this round
 * @param prevActiveTrump the previous round's active trump suit, or null
 * @returns the active trump suit for this round, or null for no-trump
 */
export function resolveTrump(flippedSuit, prevActiveTrump) {
  if (prevActiveTrump && flippedSuit === prevActiveTrump) return null;
  return flippedSuit;
}

/**
 * Which cards a player may legally play.
 * Must follow the led suit if holding any card of it; otherwise anything.
 * Leading (ledSuit null) allows anything.
 */
export function legalPlays(hand, ledSuit) {
  if (!ledSuit) return hand.slice();
  const following = hand.filter((c) => c.suit === ledSuit);
  return following.length > 0 ? following : hand.slice();
}

export function isLegalPlay(hand, ledSuit, card) {
  return legalPlays(hand, ledSuit).some((c) => c.id === card.id);
}

/**
 * Ordering value of a card within a trick.
 * Trump outranks everything (so the 2 of trump beats the ace of the led suit),
 * led suit outranks off-suit, off-suit can never win.
 * When the led suit IS trump the first branch covers every relevant card, so
 * the ordering stays consistent.
 */
export function trickRank(card, ledSuit, trumpSuit) {
  if (trumpSuit && card.suit === trumpSuit) return 200 + card.rank;
  if (card.suit === ledSuit) return 100 + card.rank;
  return card.rank;
}

/**
 * Winner of a completed (or partial) trick.
 * @param plays [{ seat, card }] in play order; plays[0] establishes the led suit
 * @returns the winning entry
 */
export function trickWinner(plays, trumpSuit) {
  if (!plays.length) return null;
  const ledSuit = plays[0].card.suit;
  let best = plays[0];
  let bestVal = trickRank(best.card, ledSuit, trumpSuit);
  for (let i = 1; i < plays.length; i++) {
    const val = trickRank(plays[i].card, ledSuit, trumpSuit);
    if (val > bestVal) {
      best = plays[i];
      bestVal = val;
    }
  }
  return best;
}

/**
 * Round scoring.
 *   exactly on bid  -> 10 + bid
 *   over  the bid   -> 1 point per trick taken
 *   under the bid   -> 0
 */
export function scoreRound(bid, tricksWon) {
  if (tricksWon === bid) return 10 + bid;
  if (tricksWon > bid) return tricksWon;
  return 0;
}

/** Sort helper used for the client's "auto-sort" buttons and bot logic. */
export function sortHand(hand, trumpSuit) {
  const suitOrder = (s) => {
    if (trumpSuit && s === trumpSuit) return -1;
    return SUITS.indexOf(s);
  };
  return hand.slice().sort((a, b) => {
    const d = suitOrder(a.suit) - suitOrder(b.suit);
    if (d !== 0) return d;
    return b.rank - a.rank;
  });
}
