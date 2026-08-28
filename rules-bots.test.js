/**
 * The optional round-of-one scoring rule, claimable cross-device records,
 * bot unpredictability, and bot chat.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { scoreRound } from './engine.js';
import { Game, TIMERS } from './game.js';
import { RoomManager } from './rooms.js';
import { createStore, accountKey, deviceKey } from './store.js';
import { PERSONAS, replyTo, personaFor } from './personas.js';

// ------------------------------------------------ the big round of one

test('the round-of-one bonus pays 21 only for a hit bid of exactly 1', () => {
  // Off: normal scoring throughout.
  assert.equal(scoreRound(1, 1), 11);
  assert.equal(scoreRound(0, 0), 10);

  // On: only bid 1, taken 1.
  assert.equal(scoreRound(1, 1, { blindBonus: true }), 21);
  assert.equal(scoreRound(0, 0, { blindBonus: true }), 10, 'bidding nought is not brave');
  assert.equal(scoreRound(1, 0, { blindBonus: true }), 0, 'missing still pays nothing');
  assert.equal(scoreRound(0, 1, { blindBonus: true }), 1, 'an unwanted trick is still worth one');
  // A bid of 2 cannot occur on a one-card round, but the guard should hold.
  assert.equal(scoreRound(2, 2, { blindBonus: true }), 12);
});

test('the bonus applies on the blind round and nowhere else', () => {
  Object.assign(TIMERS, { bidding: 0, bidReveal: 0, autoPlay: 0, playing: 0, trickEnd: 0, roundEnd: 0, botDelay: 0 });

  function run(blindBonus) {
    const game = new Game();
    for (let i = 0; i < 5; i++) game.addPlayer({ id: `p${i}`, name: `P${i}`, token: 't' });
    game.players.forEach((p) => { p.isBot = true; });
    game.options = { blindBonus };
    const seen = [];
    game.onEvent = (e) => {
      if (e.kind === 'roundEnd') {
        seen.push({ cards: game.round.cardsPerHand, results: e.results.map((r) => ({ ...r })) });
      }
    };
    game.start({ schedule: [2, 1, 2] });
    let guard = 0;
    while (game.status !== 'finished' && guard++ < 400000) game.tick();
    return seen;
  }

  for (const rounds of [run(true), run(false)]) {
    assert.equal(rounds.length, 3);
    for (const round of rounds) {
      for (const res of round.results) {
        const bonusPossible = round.cards === 1 && res.bid === 1 && res.tricksWon === 1;
        if (!bonusPossible) {
          assert.notEqual(res.gained, 21,
            `21 was awarded on a ${round.cards}-card round with bid ${res.bid}`);
        }
      }
    }
  }

  // With the rule on, a hit bid of one on the blind round must pay 21.
  const on = run(true);
  const blind = on.find((r) => r.cards === 1);
  for (const res of blind.results) {
    if (res.bid === 1 && res.tricksWon === 1) assert.equal(res.gained, 21);
  }
  // With it off, the same situation pays 11.
  const off = run(false).find((r) => r.cards === 1);
  for (const res of off.results) {
    if (res.bid === 1 && res.tricksWon === 1) assert.equal(res.gained, 11);
  }
});

test('rules are host-only and frozen once the game starts', () => {
  const manager = new RoomManager(null);
  const room = manager.create({ isPrivate: true });
  room.game.addPlayer({ id: 'h', name: 'Host', token: 't', statsKey: 'dev:x' });
  room.game.addPlayer({ id: 'g', name: 'Guest', token: 't', statsKey: 'dev:y' });
  room.hostId = 'h';

  assert.throws(() => room.setRule('g', 'blindBonus', true), /Only the host/);
  assert.throws(() => room.setRule('h', 'notARule', true), /Unknown rule/);

  room.setRule('h', 'blindBonus', true);
  assert.equal(room.options.blindBonus, true);

  room.setTableSize('h', 5);
  room.startGame('h');
  assert.equal(room.game.options.blindBonus, true, 'the rule must reach the game');
  assert.throws(() => room.setRule('h', 'blindBonus', false), /before the game starts/);
});

// ------------------------------------------------ cross-device records

test('a claimed name carries a record between devices; a wrong PIN does not', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbridge-acct-'));
  delete process.env.DATABASE_URL;
  const store = await createStore({ dir });

  const first = await store.claim('ben', '4242');
  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  assert.equal(first.key, accountKey('ben'));

  // Same name and PIN from a completely different browser resolves to the
  // same record — that is the whole point.
  const elsewhere = await store.claim('ben', '4242');
  assert.equal(elsewhere.ok, true);
  assert.equal(elsewhere.created, false);
  assert.equal(elsewhere.key, first.key);

  const impostor = await store.claim('ben', '9999');
  assert.equal(impostor.ok, false, 'a wrong PIN must not hand over the record');
  assert.match(impostor.reason, /PIN/);

  // Games recorded from two different "devices" land on one account.
  await store.recordGame([{ key: first.key, name: 'Ben', score: 100, won: true, rounds: 9 }]);
  await store.recordGame([{ key: elsewhere.key, name: 'Ben', score: 60, won: false, rounds: 9 }]);
  const me = await store.player(first.key);
  assert.equal(me.games, 2, 'the two devices should share one record');
  assert.equal(me.totalScore, 160);

  // An unclaimed browser stays separate.
  await store.recordGame([{ key: deviceKey('someone-elses-browser'), name: 'Ben', score: 500, won: true, rounds: 9 }]);
  assert.equal((await store.player(first.key)).games, 2, 'device records must not merge into an account');

  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('PINs are never stored in the clear', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbridge-acct-'));
  const store = await createStore({ dir });
  await store.claim('secretive', '13579');
  await store.close();
  const raw = fs.readFileSync(path.join(dir, 'standings.json'), 'utf8');
  assert.ok(!raw.includes('13579'), 'the PIN was written to disk in plain text');
  assert.ok(raw.includes('secretive'), 'the handle should be there');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------ bot behaviour

test('bots do not all lead the same card from the same hand', () => {
  const game = new Game();
  for (let i = 0; i < 5; i++) game.addPlayer({ id: `p${i}`, name: `P${i}`, token: 't' });
  game.players.forEach((p) => { p.isBot = true; });
  game.start({ schedule: [5] });

  const bot = game.players[0];
  bot.persona = personaFor('Felix');           // a bot with real temper
  bot.bid = 3;
  bot.tricksWon = 0;

  // Freeze one hand containing the ace of trump and re-ask 200 times.
  const trump = game.round.trumpSuit || 'S';
  game.round.trumpSuit = trump;
  const hand = [
    { rank: 14, suit: trump, id: `14${trump}` },
    { rank: 9, suit: trump, id: `9${trump}` },
    { rank: 14, suit: trump === 'H' ? 'S' : 'H', id: `14${trump === 'H' ? 'S' : 'H'}` },
    { rank: 7, suit: trump === 'D' ? 'C' : 'D', id: `7${trump === 'D' ? 'C' : 'D'}` },
    { rank: 3, suit: trump === 'D' ? 'C' : 'D', id: `3${trump === 'D' ? 'C' : 'D'}` },
  ];
  game.round.trick = [];

  const picks = {};
  for (let i = 0; i < 200; i++) {
    bot.hand = hand.slice();
    const c = game.botCard(bot);
    picks[c.id] = (picks[c.id] || 0) + 1;
  }
  const distinct = Object.keys(picks).length;
  assert.ok(distinct >= 3,
    `a bot led only ${distinct} different card(s) in 200 tries: ${JSON.stringify(picks)}`);

  const aceOfTrump = picks[`14${trump}`] || 0;
  assert.ok(aceOfTrump < 180,
    `the ace of trump was led ${aceOfTrump}/200 times — still far too predictable`);
});

test('a calm bot and a wild bot do not play alike', () => {
  const game = new Game();
  for (let i = 0; i < 5; i++) game.addPlayer({ id: `p${i}`, name: `P${i}`, token: 't' });
  game.players.forEach((p) => { p.isBot = true; });
  game.start({ schedule: [4] });
  game.round.trick = [];

  const hand = () => [
    { rank: 14, suit: 'S', id: '14S' }, { rank: 10, suit: 'S', id: '10S' },
    { rank: 6, suit: 'H', id: '6H' }, { rank: 2, suit: 'C', id: '2C' },
  ];
  const spread = (persona) => {
    const bot = game.players[0];
    bot.persona = persona;
    bot.bid = 2; bot.tricksWon = 0;
    const picks = new Set();
    for (let i = 0; i < 150; i++) { bot.hand = hand(); picks.add(game.botCard(bot).id); }
    return picks.size;
  };

  const calm = spread({ nerve: 0, temper: 0.02, showman: 0.5 });
  const wild = spread({ nerve: 0, temper: 0.9, showman: 0.5 });
  assert.equal(calm, 1, 'a bot with no temper should play the book every time');
  assert.ok(wild > calm, `temper should widen the choice: calm ${calm}, wild ${wild}`);
});

test('bots still obey the rules however random they get', () => {
  Object.assign(TIMERS, { bidding: 0, bidReveal: 0, autoPlay: 0, playing: 0, trickEnd: 0, roundEnd: 0, botDelay: 0 });
  for (let run = 0; run < 4; run++) {
    const game = new Game();
    for (let i = 0; i < 6; i++) game.addPlayer({ id: `p${i}`, name: `P${i}`, token: 't' });
    game.players.forEach((p, i) => {
      p.isBot = true;
      p.persona = { ...PERSONAS[i % PERSONAS.length] };
    });

    const violations = [];
    const orig = game.playCard.bind(game);
    game.playCard = (id, cardId) => {
      const p = game.byId(id);
      const led = game.ledSuit();
      const before = p.hand.slice();
      orig(id, cardId);
      const played = before.find((c) => c.id === cardId);
      if (led && played.suit !== led && before.some((c) => c.suit === led)) {
        violations.push({ cardId, led });
      }
    };

    game.start();
    let guard = 0;
    while (game.status !== 'finished' && guard++ < 400000) game.tick();
    assert.deepEqual(violations, [], 'a bot broke follow-suit');
    assert.equal(game.status, 'finished');
  }
});

test('every bot bids inside the legal range', () => {
  Object.assign(TIMERS, { bidding: 0, bidReveal: 0, autoPlay: 0, playing: 0, trickEnd: 0, roundEnd: 0, botDelay: 0 });
  const game = new Game();
  for (let i = 0; i < 7; i++) game.addPlayer({ id: `p${i}`, name: `P${i}`, token: 't' });
  game.players.forEach((p, i) => { p.isBot = true; p.persona = { ...PERSONAS[i] }; });
  const bad = [];
  game.onEvent = (e) => {
    if (e.kind === 'bidsRevealed') {
      for (const p of game.players) {
        if (!Number.isInteger(p.bid) || p.bid < 0 || p.bid > game.round.cardsPerHand) {
          bad.push({ name: p.name, bid: p.bid, max: game.round.cardsPerHand });
        }
      }
    }
  };
  game.start();
  let guard = 0;
  while (game.status !== 'finished' && guard++ < 400000) game.tick();
  assert.deepEqual(bad, [], 'a bot bid outside the legal range');
});

// ----------------------------------------------------------- bot chat

test('every persona has a full set of lines', () => {
  assert.equal(PERSONAS.length, 9, 'one persona per bot seat');
  for (const p of PERSONAS) {
    for (const pool of ['seated', 'reply', 'start', 'won', 'lost']) {
      assert.ok(Array.isArray(p.lines[pool]) && p.lines[pool].length,
        `${p.name} has no ${pool} lines`);
      for (const line of p.lines[pool]) {
        assert.equal(typeof line, 'string');
        assert.ok(line.length > 0 && line.length <= 200, `${p.name}: line too long`);
      }
    }
    assert.ok(typeof p.nerve === 'number' && typeof p.temper === 'number');
    assert.ok(p.temper >= 0 && p.temper <= 1);
  }
});

test('replyTo always produces something to say', () => {
  for (const p of PERSONAS) {
    for (const msg of ['hey', 'good luck', 'ready?', 'what a hand', '', 'GO GO GO']) {
      const out = replyTo(p, msg);
      assert.equal(typeof out, 'string');
      assert.ok(out.length > 0, `${p.name} had nothing to say to "${msg}"`);
    }
  }
});

test('bots answer a person in the lobby, on a delay, and only when chat is on', async () => {
  const manager = new RoomManager(null);
  const room = manager.create({ isPrivate: true });
  room.game.addPlayer({ id: 'h', name: 'Ben', token: 't', statsKey: 'dev:x' });
  room.hostId = 'h';
  room.setTableSize('h', 5);          // four bots
  room.botQueue = [];                 // ignore their greetings for this test

  let said = 0;
  for (let i = 0; i < 40; i++) {
    room.botQueue = [];
    room.postChat('h', 'hello everyone');
    if (room.botQueue.length) said++;
    // Nothing should be delivered instantly — bots "type".
    for (const q of room.botQueue) assert.ok(q.at > Date.now(), 'a bot replied with no delay');
  }
  assert.ok(said > 10, `bots answered only ${said} of 40 messages`);

  // Draining the queue turns them into real chat messages.
  room.postChat('h', 'anyone there');
  room.botQueue.forEach((q) => { q.at = Date.now() - 1; });
  const before = room.chat.length;
  room.tickChat();
  assert.ok(room.chat.length > before, 'tickChat delivered nothing');
  const last = room.chat[room.chat.length - 1];
  assert.equal(last.bot, true);
  assert.ok(last.text.length > 0);

  // Switched off, they say nothing at all.
  room.setRule('h', 'botChat', false);
  room.botQueue = [];
  for (let i = 0; i < 20; i++) room.postChat('h', 'hello?');
  assert.equal(room.botQueue.length, 0, 'bots chatted with chat turned off');
});

test('bots never reply to each other, only to people', () => {
  const manager = new RoomManager(null);
  const room = manager.create({ isPrivate: true });
  room.game.addPlayer({ id: 'h', name: 'Ben', token: 't', statsKey: 'dev:x' });
  room.hostId = 'h';
  room.setTableSize('h', 5);
  room.botQueue = [];

  const bot = room.game.players.find((p) => p.fill);
  for (let i = 0; i < 30; i++) room.postChat(bot.id, 'beep');
  assert.equal(room.botQueue.length, 0, 'bots must not talk themselves into a loop');
});
