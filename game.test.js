/**
 * Full-game simulation. Every player is a bot, the clock is zeroed, and the
 * game plays itself from the deal to the final score while we assert every
 * rule Ben specified holds on every single trick of every single round.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, TIMERS } from './game.js';
import { buildSchedule, resolveTrump, trickWinner, scoreRound, legalPlays } from './engine.js';

Object.assign(TIMERS, { bidding: 0, bidReveal: 0, playing: 0, trickEnd: 0, roundEnd: 0, botDelay: 0 });

function playFullGame(numPlayers) {
  const game = new Game();
  for (let i = 0; i < numPlayers; i++) {
    game.addPlayer({ id: `p${i}`, name: `P${i}`, token: `t${i}` });
  }
  game.players.forEach((p) => { p.isBot = true; });

  const observed = {
    rounds: [],
    followSuitViolations: [],
    trickWinnerMismatches: [],
    duplicateDeals: [],
    unequalHands: [],
    trumpCardLeaked: [],
    handLeaks: [],
    scoreErrors: [],
  };

  // Instrument playCard so we can verify legality against the hand as it was
  // *before* the card left it.
  const origPlay = game.playCard.bind(game);
  game.playCard = (playerId, cardId) => {
    const p = game.byId(playerId);
    const r = game.round;
    const handBefore = p.hand.slice();
    const led = game.ledSuit();
    const trickBefore = r.trick.slice();

    origPlay(playerId, cardId);

    const played = handBefore.find((c) => c.id === cardId);
    if (led && played.suit !== led && handBefore.some((c) => c.suit === led)) {
      observed.followSuitViolations.push({ playerId, cardId, led, handBefore: handBefore.map((c) => c.id) });
    }
    if (!legalPlays(handBefore, led).some((c) => c.id === cardId)) {
      observed.followSuitViolations.push({ playerId, cardId, led, reason: 'not in legal set' });
    }
    // When that play completed a trick, recheck the winner independently.
    const full = trickBefore.concat([{ seat: p.seat, card: played }]);
    if (full.length === numPlayers) {
      const expected = trickWinner(full, r.trumpSuit);
      if (r.winnerSeat !== expected.seat) {
        observed.trickWinnerMismatches.push({ got: r.winnerSeat, want: expected.seat, trick: full.map((x) => x.card.id) });
      }
    }
  };

  let lastRoundIndex = -1;
  let prevActive = null;
  game.onChange = () => {
    const r = game.round;
    if (!r) return;

    if (game.roundIndex !== lastRoundIndex) {
      lastRoundIndex = game.roundIndex;

      // deal integrity
      const all = game.players.flatMap((p) => p.hand.map((c) => c.id));
      const withTrump = all.concat(r.trumpCard.id);
      if (new Set(withTrump).size !== withTrump.length) observed.duplicateDeals.push(game.roundIndex);
      if (!game.players.every((p) => p.hand.length === r.cardsPerHand)) observed.unequalHands.push(game.roundIndex);
      if (all.includes(r.trumpCard.id)) observed.trumpCardLeaked.push(game.roundIndex);

      // trump chain
      const expectedTrump = resolveTrump(r.trumpCard.suit, prevActive);
      if (r.trumpSuit !== expectedTrump) {
        observed.scoreErrors.push({ kind: 'trump', round: game.roundIndex, got: r.trumpSuit, want: expectedTrump });
      }
      prevActive = r.trumpSuit;

      observed.rounds.push({
        index: game.roundIndex,
        cards: r.cardsPerHand,
        flipped: r.trumpCard.suit,
        trump: r.trumpSuit,
        blind: r.blind,
      });

      // information hiding: nobody may see another live hand outside the blind round
      for (const viewer of game.players) {
        const v = game.viewFor(viewer.id);
        for (const other of v.players) {
          if (other.id === viewer.id) continue;
          if (!r.blind && other.visibleHand !== null) {
            observed.handLeaks.push({ round: game.roundIndex, viewer: viewer.id, leaked: other.id });
          }
          if (r.blind && (!other.visibleHand || other.visibleHand.length !== 1)) {
            observed.handLeaks.push({ round: game.roundIndex, kind: 'blind-missing', viewer: viewer.id, other: other.id });
          }
        }
        if (r.blind && v.yourHand !== null) {
          observed.handLeaks.push({ round: game.roundIndex, kind: 'saw-own-blind-card', viewer: viewer.id });
        }
      }
    }

    if (r.phase === 'roundEnd' && r.results && !r._checked) {
      r._checked = true;
      const totalTricks = game.players.reduce((s, p) => s + p.tricksWon, 0);
      if (totalTricks !== r.tricksTotal) {
        observed.scoreErrors.push({ kind: 'trickCount', round: game.roundIndex, got: totalTricks, want: r.tricksTotal });
      }
      for (const res of r.results) {
        const want = scoreRound(res.bid, res.tricksWon);
        if (res.gained !== want) {
          observed.scoreErrors.push({ kind: 'score', round: game.roundIndex, res, want });
        }
      }
    }
  };

  game.start();
  let guard = 0;
  while (game.status !== 'finished') {
    game.tick();
    if (++guard > 400000) throw new Error('game did not terminate');
  }
  return { game, observed };
}

for (const n of [5, 6, 7, 8, 9, 10]) {
  test(`${n}-player game plays to completion with every rule holding`, () => {
    const { game, observed } = playFullGame(n);

    assert.equal(observed.followSuitViolations.length, 0,
      'follow-suit violated: ' + JSON.stringify(observed.followSuitViolations.slice(0, 3)));
    assert.equal(observed.trickWinnerMismatches.length, 0,
      'wrong trick winner: ' + JSON.stringify(observed.trickWinnerMismatches.slice(0, 3)));
    assert.equal(observed.duplicateDeals.length, 0, 'duplicate cards dealt');
    assert.equal(observed.unequalHands.length, 0, 'players got different hand sizes');
    assert.equal(observed.trumpCardLeaked.length, 0, 'the flipped trump card was also dealt to a player');
    assert.equal(observed.handLeaks.length, 0,
      'information leak: ' + JSON.stringify(observed.handLeaks.slice(0, 3)));
    assert.equal(observed.scoreErrors.length, 0,
      'scoring/trump error: ' + JSON.stringify(observed.scoreErrors.slice(0, 3)));

    // The ladder was followed exactly.
    assert.deepEqual(observed.rounds.map((r) => r.cards), buildSchedule(n));
    // Exactly one blind round, and it is the single-card one.
    const blind = observed.rounds.filter((r) => r.blind);
    assert.equal(blind.length, 1);
    assert.equal(blind[0].cards, 1);

    // Total points awarded are internally consistent.
    for (const p of game.players) {
      assert.equal(p.roundScores.length, buildSchedule(n).length);
      assert.equal(p.score, p.roundScores.reduce((a, b) => a + b, 0));
      assert.ok(p.hand.length === 0, 'cards left in hand at the end');
    }
    assert.equal(game.status, 'finished');
  });
}

test('start() accepts an explicit short ladder (used by practice mode)', () => {
  Object.assign(TIMERS, { bidding: 0, bidReveal: 0, playing: 0, trickEnd: 0, roundEnd: 0, botDelay: 0 });
  const game = new Game();
  for (let i = 0; i < 6; i++) game.addPlayer({ id: `p${i}`, name: `P${i}`, token: `t${i}` });
  game.players.forEach((p) => { p.isBot = true; });

  const short = [3, 2, 1, 2, 3];
  const dealt = [];
  let last = -1;
  game.onChange = () => {
    if (game.round && game.roundIndex !== last) { last = game.roundIndex; dealt.push(game.round.cardsPerHand); }
  };
  game.start({ schedule: short });
  let guard = 0;
  while (game.status !== 'finished' && guard++ < 400000) game.tick();

  assert.deepEqual(dealt, short, 'the explicit ladder was not followed');
  assert.equal(game.status, 'finished');
  for (const p of game.players) assert.equal(p.roundScores.length, short.length);
});

test('start() rejects a ladder that deals more cards than the deck allows', () => {
  const game = new Game();
  for (let i = 0; i < 10; i++) game.addPlayer({ id: `p${i}`, name: `P${i}`, token: `t${i}` });
  // 10 players can be dealt at most 5 each.
  assert.throws(() => game.start({ schedule: [6] }), /between 1 and 5/);
  assert.throws(() => game.start({ schedule: [0] }), /between 1 and 5/);
  assert.throws(() => game.start({ schedule: [2.5] }), /between 1 and 5/);
  assert.throws(() => game.start({ schedule: [] }), /non-empty/);
  // A valid one still works.
  game.start({ schedule: [2, 1, 2] });
  assert.deepEqual(game.schedule, [2, 1, 2]);
});

test('omitting the schedule still builds the standard full ladder', () => {
  const game = new Game();
  for (let i = 0; i < 7; i++) game.addPlayer({ id: `p${i}`, name: `P${i}`, token: `t${i}` });
  game.start();
  assert.deepEqual(game.schedule, [7, 6, 5, 4, 3, 2, 1, 2, 3, 4, 5, 6, 7]);
});

test('a repeated trump suit produces a no-trump round, and the chain then resets', () => {
  // Drive resolveTrump the way the game does, over a long forced sequence.
  const flips = ['H', 'H', 'H', 'H', 'S', 'S', 'D', 'H', 'H'];
  const active = [];
  let prev = null;
  for (const f of flips) {
    prev = resolveTrump(f, prev);
    active.push(prev);
  }
  assert.deepEqual(active, ['H', null, 'H', null, 'S', null, 'D', 'H', null]);
});

test('a player cannot play out of turn or play a card they do not hold', () => {
  Object.assign(TIMERS, { bidding: 999999, bidReveal: 0, playing: 999999, trickEnd: 999999, roundEnd: 999999, botDelay: 999999 });
  const game = new Game();
  for (let i = 0; i < 5; i++) game.addPlayer({ id: `p${i}`, name: `P${i}`, token: `t${i}` });
  game.start();

  // Cannot play during bidding.
  assert.throws(() => game.playCard('p0', game.players[0].hand[0].id), /Not your move/);

  for (const p of game.players) game.submitBid(p.id, 0);

  // Bids now flip in their own phase, and no card may be played during it.
  assert.equal(game.round.phase, 'bidReveal');
  assert.throws(() => game.playCard('p0', game.players[0].hand[0].id), /Not your move/);
  game.tick(); // reveal window is zero in this test, so this starts play
  assert.equal(game.round.phase, 'playing');

  const leader = game.bySeat(game.round.leadSeat);
  const other = game.players.find((p) => p.seat !== game.round.leadSeat);

  assert.throws(() => game.playCard(other.id, other.hand[0].id), /Wait for your turn/);
  assert.throws(() => game.playCard(leader.id, 'ZZ'), /do not hold/);
  assert.throws(() => game.submitBid(leader.id, 1), /Not bidding/);

  // A legal lead works.
  game.playCard(leader.id, leader.hand[0].id);
  assert.equal(game.round.trick.length, 1);

  Object.assign(TIMERS, { bidding: 0, bidReveal: 0, playing: 0, trickEnd: 0, roundEnd: 0, botDelay: 0 });
});

test('bids stay sealed until every player has bid', () => {
  Object.assign(TIMERS, { bidding: 999999, bidReveal: 0, playing: 999999, trickEnd: 999999, roundEnd: 999999, botDelay: 999999 });
  const game = new Game();
  for (let i = 0; i < 5; i++) game.addPlayer({ id: `p${i}`, name: `P${i}`, token: `t${i}` });
  game.start();

  game.submitBid('p0', 3);
  game.submitBid('p1', 1);

  const view = game.viewFor('p2');
  const p0 = view.players.find((p) => p.id === 'p0');
  assert.equal(p0.bid, null, 'another player\'s bid was exposed before the reveal');
  assert.equal(p0.hasBid, true, 'should still show that they have bid');
  assert.equal(view.round.bidsRevealed, false);
  assert.equal(view.round.totalBid, null);

  // Your own bid is always visible to you.
  assert.equal(game.viewFor('p0').yourBid, 3);

  game.submitBid('p2', 0);
  game.submitBid('p3', 2);
  assert.equal(game.viewFor('p2').players.find((p) => p.id === 'p0').bid, null);
  game.submitBid('p4', 1);

  const after = game.viewFor('p2');
  assert.equal(after.round.bidsRevealed, true);
  assert.equal(after.players.find((p) => p.id === 'p0').bid, 3);
  assert.equal(after.round.totalBid, 7);

  Object.assign(TIMERS, { bidding: 0, bidReveal: 0, playing: 0, trickEnd: 0, roundEnd: 0, botDelay: 0 });
});

test('bids outside 0..handSize are rejected', () => {
  Object.assign(TIMERS, { bidding: 999999, bidReveal: 0, playing: 999999, trickEnd: 999999, roundEnd: 999999, botDelay: 999999 });
  const game = new Game();
  for (let i = 0; i < 10; i++) game.addPlayer({ id: `p${i}`, name: `P${i}`, token: `t${i}` });
  game.start();
  assert.equal(game.round.cardsPerHand, 5);
  assert.throws(() => game.submitBid('p0', 6), /between 0 and 5/);
  assert.throws(() => game.submitBid('p0', -1), /between 0 and 5/);
  game.submitBid('p0', 5);
  assert.throws(() => game.submitBid('p0', 2), /already bid/);
  Object.assign(TIMERS, { bidding: 0, bidReveal: 0, playing: 0, trickEnd: 0, roundEnd: 0, botDelay: 0 });
});

test('the table refuses to start outside the 5-10 player range', () => {
  const small = new Game();
  for (let i = 0; i < 4; i++) small.addPlayer({ id: `p${i}`, name: `P${i}`, token: `t${i}` });
  assert.throws(() => small.start(), /at least 5/);

  const big = new Game();
  for (let i = 0; i < 10; i++) big.addPlayer({ id: `p${i}`, name: `P${i}`, token: `t${i}` });
  assert.throws(() => big.addPlayer({ id: 'p10', name: 'P10', token: 't10' }), /full/);
});

test('the bids get their own reveal phase before any card is played', () => {
  Object.assign(TIMERS, { bidding: 999999, bidReveal: 999999, playing: 999999, trickEnd: 999999, roundEnd: 999999, botDelay: 999999 });
  const game = new Game();
  for (let i = 0; i < 5; i++) game.addPlayer({ id: `p${i}`, name: `P${i}`, token: `t${i}` });
  game.start();

  const bids = [2, 0, 1, 3, 0];
  game.players.forEach((p, i) => game.submitBid(p.id, bids[i]));

  const r = game.round;
  assert.equal(r.phase, 'bidReveal', 'should pause on the reveal, not jump into play');
  assert.equal(r.bidsRevealed, true);

  // Everyone can now see every bid, and the totals are published.
  const view = game.viewFor('p2');
  assert.deepEqual(view.players.map((p) => p.bid), bids);
  assert.equal(view.round.totalBid, 6);
  assert.equal(view.round.tricksTotal, 10);

  // The table is frozen: no card may be played mid-reveal.
  const leader = game.bySeat(r.leadSeat);
  assert.throws(() => game.playCard(leader.id, leader.hand[0].id), /Not your move/);

  // It does not end early...
  game.tick();
  assert.equal(game.round.phase, 'bidReveal');

  // ...but it does end.
  game.round.deadline = Date.now() - 1;
  game.tick();
  assert.equal(game.round.phase, 'playing');
  assert.equal(game.round.currentSeat, game.round.leadSeat, 'the announced leader actually leads');

  Object.assign(TIMERS, { bidding: 0, bidReveal: 0, playing: 0, trickEnd: 0, roundEnd: 0, botDelay: 0 });
});

test('the round lead is known and published before bidding starts', () => {
  Object.assign(TIMERS, { bidding: 999999, bidReveal: 999999, playing: 999999, trickEnd: 999999, roundEnd: 999999, botDelay: 999999 });
  const game = new Game();
  for (let i = 0; i < 5; i++) game.addPlayer({ id: `p${i}`, name: `P${i}`, token: `t${i}` });
  game.start();

  const view = game.viewFor('p0');
  assert.equal(view.round.phase, 'bidding');
  assert.ok(Number.isInteger(view.round.leadSeat), 'leadSeat must be set while bidding');
  assert.ok(view.round.leadSeat >= 0 && view.round.leadSeat < 5);

  // And it is the seat that actually leads once play begins.
  const announced = view.round.leadSeat;
  for (const p of game.players) game.submitBid(p.id, 0);
  game.round.deadline = Date.now() - 1;
  game.tick();
  assert.equal(game.round.currentSeat, announced);

  Object.assign(TIMERS, { bidding: 0, bidReveal: 0, playing: 0, trickEnd: 0, roundEnd: 0, botDelay: 0 });
});

test('leadingSeat tracks who would take the trick as it is being played', () => {
  Object.assign(TIMERS, { bidding: 999999, bidReveal: 0, playing: 999999, trickEnd: 999999, roundEnd: 999999, botDelay: 999999 });
  const game = new Game();
  for (let i = 0; i < 5; i++) game.addPlayer({ id: `p${i}`, name: `P${i}`, token: `t${i}` });
  game.start();
  for (const p of game.players) game.submitBid(p.id, 0);
  game.tick();

  // No card played yet, so nobody is winning.
  assert.equal(game.viewFor('p0').round.leadingSeat, null);

  const r = game.round;
  const played = [];
  for (let i = 0; i < 5; i++) {
    const p = game.bySeat(r.currentSeat);
    const legal = legalPlays(p.hand, game.ledSuit());
    const card = legal[0];
    game.playCard(p.id, card.id);
    played.push({ seat: p.seat, card });

    if (game.round.trick.length) {
      // Mid-trick: must match an independent calculation.
      const expected = trickWinner(played, r.trumpSuit).seat;
      assert.equal(game.viewFor('p0').round.leadingSeat, expected,
        `after ${played.length} card(s) the wrong seat was shown as winning`);
    }
  }
  // Trick complete: the settled winner matches the last leader shown.
  assert.equal(game.round.winnerSeat, trickWinner(played, r.trumpSuit).seat);

  Object.assign(TIMERS, { bidding: 0, bidReveal: 0, playing: 0, trickEnd: 0, roundEnd: 0, botDelay: 0 });
});

test('the trick winner leads the next trick', () => {
  Object.assign(TIMERS, { bidding: 0, bidReveal: 0, playing: 999999, trickEnd: 0, roundEnd: 999999, botDelay: 999999 });
  const game = new Game();
  for (let i = 0; i < 5; i++) game.addPlayer({ id: `p${i}`, name: `P${i}`, token: `t${i}` });
  game.start();
  for (const p of game.players) game.submitBid(p.id, 0);
  game.tick(); // clear the (zero-length) bid reveal

  const r = game.round;
  for (let i = 0; i < 5; i++) {
    const p = game.bySeat(r.currentSeat);
    const legal = legalPlays(p.hand, game.ledSuit());
    game.playCard(p.id, legal[0].id);
  }
  const winnerSeat = game.round.winnerSeat;
  game.resolveTrickEnd();
  assert.equal(game.round.leadSeat, winnerSeat);
  assert.equal(game.round.currentSeat, winnerSeat);
  Object.assign(TIMERS, { bidding: 0, bidReveal: 0, playing: 0, trickEnd: 0, roundEnd: 0, botDelay: 0 });
});

test('the round lead rotates one seat clockwise each round', () => {
  const game = new Game();
  for (let i = 0; i < 5; i++) game.addPlayer({ id: `p${i}`, name: `P${i}`, token: `t${i}` });
  game.players.forEach((p) => { p.isBot = true; });
  const leads = [];
  let last = -1;
  game.onChange = () => {
    if (game.round && game.roundIndex !== last) {
      last = game.roundIndex;
      leads.push(game.round.leadSeat);
    }
  };
  game.start();
  let guard = 0;
  while (game.status !== 'finished' && guard++ < 400000) game.tick();
  for (let i = 1; i < leads.length; i++) {
    assert.equal(leads[i], (leads[i - 1] + 1) % 5, `round ${i} lead did not rotate clockwise`);
  }
});
