import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeDeck, shuffle, maxHandSize, buildSchedule, resolveTrump,
  legalPlays, isLegalPlay, trickWinner, scoreRound, parseCard, sortHand,
} from './engine.js';

const C = (id) => parseCard(id);

test('deck is 52 unique cards, no jokers', () => {
  const deck = makeDeck();
  assert.equal(deck.length, 52);
  assert.equal(new Set(deck.map((c) => c.id)).size, 52);
  assert.equal(deck.filter((c) => c.suit === 'S').length, 13);
  assert.ok(deck.every((c) => c.rank >= 2 && c.rank <= 14));
});

test('shuffle preserves the exact multiset of cards', () => {
  const deck = makeDeck();
  const s = shuffle(deck);
  assert.equal(s.length, 52);
  assert.deepEqual(s.map((c) => c.id).sort(), deck.map((c) => c.id).sort());
});

test('opening hand sizes match the specified table exactly', () => {
  // Ben's hardcoded table
  assert.equal(maxHandSize(5), 10);
  assert.equal(maxHandSize(6), 8);
  assert.equal(maxHandSize(7), 7);
  assert.equal(maxHandSize(8), 6);
  assert.equal(maxHandSize(9), 5);
  assert.equal(maxHandSize(10), 5);
});

test('opening hand always leaves at least one card to flip for trump', () => {
  for (let n = 5; n <= 10; n++) {
    const dealt = maxHandSize(n) * n;
    assert.ok(dealt + 1 <= 52, `${n} players: ${dealt} dealt + trump exceeds deck`);
    // and it is maximal: one more card each would not fit
    assert.ok((maxHandSize(n) + 1) * n + 1 > 52, `${n} players: could have dealt more`);
  }
});

test('round ladder descends to 1 then ascends back to the opening size', () => {
  assert.deepEqual(buildSchedule(10), [5, 4, 3, 2, 1, 2, 3, 4, 5]);
  assert.deepEqual(buildSchedule(9), [5, 4, 3, 2, 1, 2, 3, 4, 5]);
  assert.deepEqual(buildSchedule(8), [6, 5, 4, 3, 2, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(buildSchedule(7), [7, 6, 5, 4, 3, 2, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(buildSchedule(6), [8, 7, 6, 5, 4, 3, 2, 1, 2, 3, 4, 5, 6, 7, 8]);
  const five = buildSchedule(5);
  assert.equal(five.length, 19);
  assert.equal(five[0], 10);
  assert.equal(five[five.length - 1], 10);
  assert.equal(Math.min(...five), 1);
  // exactly one single-card round
  assert.equal(five.filter((n) => n === 1).length, 1);
});

test('trump: a fresh suit becomes trump', () => {
  assert.equal(resolveTrump('H', null), 'H');
  assert.equal(resolveTrump('H', 'S'), 'H');
});

test('trump: repeating the active trump suit makes the round no-trump', () => {
  assert.equal(resolveTrump('H', 'H'), null);
});

test('trump: a no-trump round resets the chain, so the same suit can return', () => {
  // Round 3 flips Hearts -> Hearts is trump
  let active = resolveTrump('H', null);
  assert.equal(active, 'H');
  // Round 4 flips Hearts again -> no trump
  active = resolveTrump('H', active);
  assert.equal(active, null);
  // Round 5 flips Hearts a third time -> Hearts IS trump again (Ben's ruling)
  active = resolveTrump('H', active);
  assert.equal(active, 'H');
  // Round 6 flips Hearts a fourth time -> no trump again. Alternates.
  active = resolveTrump('H', active);
  assert.equal(active, null);
});

test('must follow the led suit when holding it', () => {
  const hand = [C('14S'), C('2H'), C('9H'), C('13D')];
  const legal = legalPlays(hand, 'H').map((c) => c.id);
  assert.deepEqual(legal.sort(), ['2H', '9H']);
  assert.ok(!isLegalPlay(hand, 'H', C('14S')));
  assert.ok(isLegalPlay(hand, 'H', C('2H')));
});

test('void in the led suit frees you to play anything', () => {
  const hand = [C('14S'), C('13D'), C('7C')];
  assert.equal(legalPlays(hand, 'H').length, 3);
  assert.ok(isLegalPlay(hand, 'H', C('14S')));
});

test('leading allows any card', () => {
  const hand = [C('14S'), C('2H')];
  assert.equal(legalPlays(hand, null).length, 2);
});

test('highest card of the led suit wins when no trump is played', () => {
  const plays = [
    { seat: 0, card: C('9H') },
    { seat: 1, card: C('14H') },
    { seat: 2, card: C('2H') },
    { seat: 3, card: C('14S') }, // off-suit ace, meaningless
    { seat: 4, card: C('13C') }, // off-suit, meaningless
  ];
  assert.equal(trickWinner(plays, 'D').seat, 1);
});

test('the 2 of trump beats the ace of the led suit', () => {
  const plays = [
    { seat: 0, card: C('14H') }, // ace of led suit
    { seat: 1, card: C('2S') },  // lowest trump
    { seat: 2, card: C('13H') },
  ];
  assert.equal(trickWinner(plays, 'S').seat, 1);
});

test('highest trump wins when several players trump in', () => {
  const plays = [
    { seat: 0, card: C('14H') },
    { seat: 1, card: C('2S') },
    { seat: 2, card: C('7S') },
    { seat: 3, card: C('3S') },
  ];
  assert.equal(trickWinner(plays, 'S').seat, 2);
});

test('when the led suit is itself trump, plain high-card ordering applies', () => {
  const plays = [
    { seat: 0, card: C('9S') },
    { seat: 1, card: C('14S') },
    { seat: 2, card: C('14H') }, // off-suit ace cannot win
  ];
  assert.equal(trickWinner(plays, 'S').seat, 1);
});

test('off-suit non-trump cards can never win a trick', () => {
  const plays = [
    { seat: 0, card: C('2H') },  // led, lowest possible
    { seat: 1, card: C('14S') },
    { seat: 2, card: C('14D') },
    { seat: 3, card: C('14C') },
  ];
  assert.equal(trickWinner(plays, null).seat, 0);
});

test('no-trump rounds ignore trump entirely', () => {
  const plays = [
    { seat: 0, card: C('9H') },
    { seat: 1, card: C('2S') },
    { seat: 2, card: C('10H') },
  ];
  assert.equal(trickWinner(plays, null).seat, 2);
});

test('scoring: exact bid pays 10 plus the bid', () => {
  assert.equal(scoreRound(2, 2), 12);
  assert.equal(scoreRound(0, 0), 10);
  assert.equal(scoreRound(5, 5), 15);
});

test('scoring: overtricks pay one per trick taken', () => {
  assert.equal(scoreRound(2, 3), 3);
  assert.equal(scoreRound(0, 4), 4);
});

test('scoring: falling short pays nothing', () => {
  assert.equal(scoreRound(2, 1), 0);
  assert.equal(scoreRound(3, 0), 0);
});

test('sortHand groups trump first, then by rank descending', () => {
  const hand = [C('2H'), C('14S'), C('13H'), C('5C')];
  const sorted = sortHand(hand, 'H').map((c) => c.id);
  assert.deepEqual(sorted.slice(0, 2), ['13H', '2H']);
});

test('a full round deals cleanly with no duplicate cards across hands', () => {
  for (let n = 5; n <= 10; n++) {
    for (const size of buildSchedule(n)) {
      const deck = shuffle(makeDeck());
      const hands = [];
      let i = 0;
      for (let p = 0; p < n; p++) hands.push(deck.slice(i, (i += size)));
      const trumpCard = deck[i];
      assert.ok(trumpCard, `${n}p size ${size}: ran out of cards before the trump flip`);
      const all = hands.flat().map((c) => c.id).concat(trumpCard.id);
      assert.equal(new Set(all).size, all.length, 'duplicate card dealt');
      assert.ok(hands.every((h) => h.length === size), 'unequal hands');
    }
  }
});
