/**
 * game.js — authoritative game state machine for one table.
 *
 * The server owns every card. Clients are only ever sent the information
 * their seat is entitled to see, so a player cannot learn another player's
 * hand or bid by inspecting network traffic or editing their page.
 */

import {
  makeDeck, shuffle, buildSchedule, resolveTrump, legalPlays, maxHandSize,
  trickWinner, scoreRound, sortHand, MIN_PLAYERS, MAX_PLAYERS, SUIT_NAMES, cardName,
} from './engine.js';

// Phase clocks (ms). Mutable so tests can run a full game instantly, and
// env-overridable so a deploy can tune pacing without a code change.
const envMs = (key, fallback) => {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};
export const TIMERS = {
  bidding: envMs('DBRIDGE_BID_MS', 30000),
  bidReveal: envMs('DBRIDGE_REVEAL_MS', 5000), // everyone reads the bids before a card is played
  playing: envMs('DBRIDGE_PLAY_MS', 20000),
  trickEnd: envMs('DBRIDGE_TRICK_MS', 3200),  // pause so everyone sees who took the trick
  roundEnd: envMs('DBRIDGE_ROUND_MS', 7000),  // pause on the scoreboard between rounds
  botDelay: envMs('DBRIDGE_BOT_MS', 900),     // bots "think" briefly so play is readable
};

// Consecutive missed decisions before a seat is handed to the bot
const MISSES_BEFORE_BOT = 2;

export class Game {
  constructor({ onChange, onEvent } = {}) {
    this.onChange = onChange || (() => {});
    this.onEvent = onEvent || (() => {});

    this.status = 'lobby'; // lobby | playing | finished
    this.players = [];     // seat order == array order
    this.schedule = [];
    this.roundIndex = -1;
    this.round = null;
    this.prevActiveTrump = null;
    this.startingLeadSeat = 0;
    this.log = [];
  }

  // ---------------------------------------------------------------- players

  /**
   * @param fill true for a bot seat deliberately added to pad a small table out
   *        to a legal size. Deliberately distinct from `isBot`, which also gets
   *        set when a real player times out and may still reclaim their seat.
   */
  addPlayer({ id, name, token, deviceId, fill = false }) {
    if (this.status !== 'lobby') throw new Error('Game already in progress');
    if (this.players.length >= MAX_PLAYERS) throw new Error('Table is full');
    const player = {
      id, name, token, deviceId: deviceId || null,
      fill,
      seat: this.players.length,
      connected: true,
      isBot: fill,
      misses: 0,
      score: 0,
      hand: [],
      order: [],      // client-chosen card order
      bid: null,
      tricksWon: 0,
      roundScores: [],
      // career counters for this game, handed to the standings store at the end
      exactBids: 0,
      busts: 0,
      tricks: 0,
    };
    this.players.push(player);
    this.changed();
    return player;
  }

  removePlayer(id) {
    const idx = this.players.findIndex((p) => p.id === id);
    if (idx === -1) return;
    if (this.status === 'lobby') {
      this.players.splice(idx, 1);
      this.players.forEach((p, i) => { p.seat = i; });
    } else {
      // Mid-game we keep the seat so scoring stays intact; the bot plays it.
      this.players[idx].connected = false;
      this.players[idx].isBot = true;
    }
    this.changed();
  }

  setConnected(id, connected) {
    const p = this.byId(id);
    if (!p) return;
    p.connected = connected;
    if (!connected && this.status === 'playing') p.isBot = true;
    this.changed();
  }

  /** A returning player may reclaim a seat the bot took over. */
  reclaim(id) {
    const p = this.byId(id);
    if (!p) return;
    p.isBot = false;
    p.misses = 0;
    this.changed();
  }

  byId(id) { return this.players.find((p) => p.id === id); }
  bySeat(seat) { return this.players.find((p) => p.seat === seat); }

  /**
   * Real people still attached. Fill bots are excluded on purpose: a table
   * holding nothing but bots is abandoned and must be swept, not kept alive
   * forever playing itself.
   */
  get humanCount() {
    return this.players.filter((p) => p.connected && !p.fill).length;
  }

  get botCount() {
    return this.players.filter((p) => p.fill).length;
  }

  /** Drop one fill bot, oldest seat last, to make room for an arriving human. */
  dropOneBot() {
    for (let i = this.players.length - 1; i >= 0; i--) {
      if (this.players[i].fill) {
        this.players.splice(i, 1);
        this.players.forEach((p, n) => { p.seat = n; });
        this.changed();
        return true;
      }
    }
    return false;
  }

  // ------------------------------------------------------------------ start

  /**
   * @param opts.schedule optional explicit round ladder, used by practice mode
   *        to run a short game. Every entry must be a legal hand size.
   */
  start({ schedule } = {}) {
    if (this.status !== 'lobby') throw new Error('Already started');
    if (this.players.length < MIN_PLAYERS) {
      throw new Error(
        `A table needs ${MIN_PLAYERS} seats — add ${MIN_PLAYERS - this.players.length} more bot(s) or players`);
    }
    const max = maxHandSize(this.players.length);
    if (schedule) {
      if (!Array.isArray(schedule) || !schedule.length) {
        throw new Error('Schedule must be a non-empty array');
      }
      if (!schedule.every((n) => Number.isInteger(n) && n >= 1 && n <= max)) {
        throw new Error(`Every round must deal between 1 and ${max} cards`);
      }
    }
    this.status = 'playing';
    this.schedule = schedule ? schedule.slice() : buildSchedule(this.players.length);
    this.roundIndex = -1;
    this.prevActiveTrump = null;
    // Round 1's leader is random; it rotates clockwise each round after that.
    this.startingLeadSeat = Math.floor(Math.random() * this.players.length);
    this.nextRound();
  }

  nextRound() {
    this.roundIndex += 1;
    if (this.roundIndex >= this.schedule.length) return this.finish();

    const n = this.players.length;
    const cardsPerHand = this.schedule[this.roundIndex];
    const deck = shuffle(makeDeck());

    let i = 0;
    for (const p of this.players) {
      p.hand = deck.slice(i, i + cardsPerHand);
      i += cardsPerHand;
      p.hand = sortHand(p.hand, null);
      p.order = p.hand.map((c) => c.id);
      p.bid = null;
      p.tricksWon = 0;
    }

    const trumpCard = deck[i];
    const trumpSuit = resolveTrump(trumpCard.suit, this.prevActiveTrump);
    this.prevActiveTrump = trumpSuit; // null on a no-trump round, resetting the chain

    const leadSeat = (this.startingLeadSeat + this.roundIndex) % n;

    this.round = {
      cardsPerHand,
      tricksTotal: cardsPerHand,
      trumpCard,
      trumpSuit,
      noTrump: trumpSuit === null,
      blind: cardsPerHand === 1, // the one-card round: you see everyone but yourself
      phase: 'bidding',
      bidsRevealed: false,
      leadSeat,
      currentSeat: leadSeat,
      trickNumber: 1,
      trick: [],
      lastTrick: null,
      deadline: Date.now() + TIMERS.bidding,
      turnStartedAt: Date.now(),
    };

    this.pushLog(
      `Round ${this.roundIndex + 1} — ${cardsPerHand} card${cardsPerHand === 1 ? '' : 's'} each. ` +
      `Turned up ${cardName(trumpCard)}: ` +
      (trumpSuit
        ? `${SUIT_NAMES[trumpSuit]} is trump.`
        : `${SUIT_NAMES[trumpCard.suit]} repeated, so this round is NO TRUMP.`)
    );
    this.onEvent({ kind: 'roundStart', roundIndex: this.roundIndex });
    this.changed();
  }

  finish() {
    this.status = 'finished';
    this.round = null;
    // nextRound() overshoots by one to detect the end; clamp so the reported
    // index always points at a real round.
    this.roundIndex = this.schedule.length - 1;
    const best = Math.max(...this.players.map((p) => p.score));
    const winners = this.players.filter((p) => p.score === best).map((p) => p.name);
    this.pushLog(
      winners.length === 1
        ? `${winners[0]} wins with ${best} points.`
        : `Tie at ${best} points: ${winners.join(', ')}.`
    );
    this.onEvent({ kind: 'gameOver', winners, score: best });
    this.changed();
  }

  /** Per-player rows for the standings store. Called once, when a game ends. */
  gameSummary() {
    const best = Math.max(...this.players.map((p) => p.score));
    return this.players
      .filter((p) => p.deviceId)
      .map((p) => ({
        deviceId: p.deviceId,
        name: p.name,
        score: p.score,
        won: p.score === best,
        rounds: p.roundScores.length,
        exactBids: p.exactBids,
        busts: p.busts,
        tricks: p.tricks,
      }));
  }

  /**
   * Rematch: keep everyone seated, wipe the scores, go back to the lobby.
   * Players who left during the last game are dropped and seats re-numbered.
   */
  reset() {
    this.players = this.players.filter((p) => p.connected);
    this.players.forEach((p, i) => {
      p.seat = i;
      p.score = 0;
      p.hand = [];
      p.order = [];
      p.bid = null;
      p.tricksWon = 0;
      p.roundScores = [];
      p.exactBids = 0;
      p.busts = 0;
      p.tricks = 0;
      p.misses = 0;
      // Humans get their seat back; fill bots stay bots for the next game.
      p.isBot = !!p.fill;
    });
    this.status = 'lobby';
    this.round = null;
    this.schedule = [];
    this.roundIndex = -1;
    this.prevActiveTrump = null;
    this.log = [];
    this.changed();
  }

  // ----------------------------------------------------------------- bidding

  submitBid(playerId, n) {
    const r = this.round;
    if (!r || r.phase !== 'bidding') throw new Error('Not bidding right now');
    const p = this.byId(playerId);
    if (!p) throw new Error('Not at this table');
    if (p.bid !== null) throw new Error('You already bid');
    if (!Number.isInteger(n) || n < 0 || n > r.cardsPerHand) {
      throw new Error(`Bid must be between 0 and ${r.cardsPerHand}`);
    }
    p.bid = n;
    p.misses = 0;
    this.checkBiddingComplete();
    this.changed();
  }

  checkBiddingComplete() {
    const r = this.round;
    if (!r || r.phase !== 'bidding') return;
    if (this.players.some((p) => p.bid === null)) return;
    // All bids are in. They flip over together in their own phase — no card
    // may be played until everyone has had a moment to read the table.
    r.bidsRevealed = true;
    r.phase = 'bidReveal';
    r.deadline = Date.now() + TIMERS.bidReveal;
    const total = this.players.reduce((s, p) => s + p.bid, 0);
    this.pushLog(
      'Bids: ' + this.players.map((p) => `${p.name} ${p.bid}`).join(', ') +
      ` (${total} bid / ${r.tricksTotal} available)`
    );
    this.onEvent({ kind: 'bidsRevealed', total, tricks: r.tricksTotal });
  }

  /** Leaves the reveal and actually starts the first trick. */
  startPlay() {
    const r = this.round;
    if (!r || r.phase !== 'bidReveal') return;
    r.phase = 'playing';
    r.currentSeat = r.leadSeat;
    r.deadline = Date.now() + TIMERS.playing;
    r.turnStartedAt = Date.now();
    this.changed();
  }

  // ----------------------------------------------------------------- playing

  ledSuit() {
    const r = this.round;
    return r && r.trick.length ? r.trick[0].card.suit : null;
  }

  playCard(playerId, cardIdStr) {
    const r = this.round;
    if (!r || r.phase !== 'playing') throw new Error('Not your move right now');
    const p = this.byId(playerId);
    if (!p) throw new Error('Not at this table');
    if (p.seat !== r.currentSeat) throw new Error('Wait for your turn');

    const card = p.hand.find((c) => c.id === cardIdStr);
    if (!card) throw new Error('You do not hold that card');

    const led = this.ledSuit();
    const legal = legalPlays(p.hand, led);
    if (!legal.some((c) => c.id === card.id)) {
      throw new Error(`You must follow suit (${led})`);
    }

    p.hand = p.hand.filter((c) => c.id !== card.id);
    p.order = p.order.filter((id) => id !== card.id);
    p.misses = 0;
    r.trick.push({ seat: p.seat, card, name: p.name });

    if (r.trick.length === this.players.length) {
      this.completeTrick();
    } else {
      r.currentSeat = (r.currentSeat + 1) % this.players.length;
      r.deadline = Date.now() + TIMERS.playing;
      r.turnStartedAt = Date.now();
    }
    this.changed();
  }

  completeTrick() {
    const r = this.round;
    const winner = trickWinner(r.trick, r.trumpSuit);
    const wp = this.bySeat(winner.seat);
    wp.tricksWon += 1;
    r.winnerSeat = winner.seat;
    r.phase = 'trickEnd';
    r.deadline = Date.now() + TIMERS.trickEnd;
    this.pushLog(`${wp.name} takes trick ${r.trickNumber} with ${cardName(winner.card)}.`);
    this.onEvent({ kind: 'trickWon', seat: winner.seat, card: winner.card });
  }

  resolveTrickEnd() {
    const r = this.round;
    r.lastTrick = { plays: r.trick, winnerSeat: r.winnerSeat };
    r.trick = [];
    r.winnerSeat = undefined;

    if (r.trickNumber >= r.tricksTotal) return this.endRound();

    // Winner of the trick leads the next one.
    r.trickNumber += 1;
    r.leadSeat = r.lastTrick.winnerSeat;
    r.currentSeat = r.lastTrick.winnerSeat;
    r.phase = 'playing';
    r.deadline = Date.now() + TIMERS.playing;
    r.turnStartedAt = Date.now();
    this.changed();
  }

  endRound() {
    const r = this.round;
    r.phase = 'roundEnd';
    r.deadline = Date.now() + TIMERS.roundEnd;
    r.results = this.players.map((p) => {
      const gained = scoreRound(p.bid, p.tricksWon);
      p.score += gained;
      p.roundScores.push(gained);
      p.tricks += p.tricksWon;
      if (p.tricksWon === p.bid) p.exactBids += 1;
      else if (p.tricksWon < p.bid) p.busts += 1;
      return { seat: p.seat, name: p.name, bid: p.bid, tricksWon: p.tricksWon, gained, total: p.score };
    });
    this.pushLog(
      'Round scored: ' +
      r.results.map((x) => `${x.name} bid ${x.bid}, took ${x.tricksWon} (+${x.gained})`).join('; ')
    );
    this.onEvent({ kind: 'roundEnd', results: r.results });
    this.changed();
  }

  // -------------------------------------------------------------- hand order

  setOrder(playerId, order) {
    const p = this.byId(playerId);
    if (!p) return;
    const held = new Set(p.hand.map((c) => c.id));
    const clean = order.filter((id) => held.has(id));
    for (const id of held) if (!clean.includes(id)) clean.push(id);
    p.order = clean;
    // No broadcast: this is a private, cosmetic preference.
  }

  // ------------------------------------------------------------------- clock

  /** Called on a short interval by the room manager. */
  tick() {
    const r = this.round;
    if (this.status !== 'playing' || !r) return;
    const now = Date.now();

    if (r.phase === 'bidReveal' && now >= r.deadline) return this.startPlay();
    if (r.phase === 'trickEnd' && now >= r.deadline) return this.resolveTrickEnd();
    if (r.phase === 'roundEnd' && now >= r.deadline) return this.nextRound();

    if (r.phase === 'bidding') {
      let acted = false;
      for (const p of this.players) {
        if (p.bid !== null) continue;
        const botReady = p.isBot && now >= r.turnStartedAt + TIMERS.botDelay;
        const timedOut = now >= r.deadline;
        if (botReady || timedOut) {
          if (timedOut && !p.isBot) this.registerMiss(p);
          p.bid = this.botBid(p);
          acted = true;
        }
      }
      if (acted) { this.checkBiddingComplete(); this.changed(); }
      return;
    }

    if (r.phase === 'playing') {
      const p = this.bySeat(r.currentSeat);
      if (!p) return;
      const botReady = p.isBot && now >= r.turnStartedAt + TIMERS.botDelay;
      const timedOut = now >= r.deadline;
      if (botReady || timedOut) {
        if (timedOut && !p.isBot) this.registerMiss(p);
        const card = this.botCard(p);
        if (card) {
          try { this.playCard(p.id, card.id); } catch { /* race with a real play */ }
        }
      }
    }
  }

  registerMiss(p) {
    p.misses += 1;
    if (p.misses >= MISSES_BEFORE_BOT && !p.isBot) {
      p.isBot = true;
      this.pushLog(`${p.name} timed out — the bot is playing that seat. They can take it back anytime.`);
    }
  }

  // --------------------------------------------------------------------- bot

  botBid(p) {
    const r = this.round;
    let expect = 0;
    for (const c of p.hand) {
      const isTrump = r.trumpSuit && c.suit === r.trumpSuit;
      if (isTrump) expect += c.rank >= 12 ? 0.9 : c.rank >= 9 ? 0.55 : 0.25;
      else if (c.rank === 14) expect += 0.85;
      else if (c.rank === 13) expect += 0.5;
      else if (c.rank === 12) expect += 0.25;
    }
    return Math.max(0, Math.min(r.cardsPerHand, Math.round(expect)));
  }

  botCard(p) {
    const r = this.round;
    if (!p.hand.length) return null;
    const led = this.ledSuit();
    const legal = legalPlays(p.hand, led);
    if (legal.length === 1) return legal[0];

    const need = p.bid - p.tricksWon;
    const wantsTricks = need > 0;

    if (!led) {
      // Leading: push a high card when chasing tricks, otherwise dump low.
      const sorted = legal.slice().sort((a, b) => b.rank - a.rank);
      return wantsTricks ? sorted[0] : sorted[sorted.length - 1];
    }

    const current = trickWinner(r.trick, r.trumpSuit);
    const beats = (c) => {
      const test = r.trick.concat([{ seat: p.seat, card: c }]);
      return trickWinner(test, r.trumpSuit).seat === p.seat;
    };
    const winning = legal.filter(beats).sort((a, b) => a.rank - b.rank);
    const losing = legal.filter((c) => !beats(c)).sort((a, b) => a.rank - b.rank);

    if (wantsTricks && winning.length) return winning[0];       // win as cheaply as possible
    if (!wantsTricks && losing.length) return losing[losing.length - 1]; // dump the biggest safe card
    return (losing[0] || winning[0] || legal[0]);
  }

  // ------------------------------------------------------------------- views

  pushLog(text) {
    this.log.push({ t: Date.now(), text });
    if (this.log.length > 60) this.log.shift();
  }

  orderedHand(p) {
    const map = new Map(p.hand.map((c) => [c.id, c]));
    const out = [];
    for (const id of p.order) if (map.has(id)) { out.push(map.get(id)); map.delete(id); }
    for (const c of map.values()) out.push(c);
    return out;
  }

  /**
   * Build the slice of state one player is allowed to see.
   * Hands, and un-revealed bids, never leave the server for other seats.
   */
  viewFor(playerId) {
    const me = this.byId(playerId);
    const r = this.round;

    const players = this.players.map((p) => {
      const isMe = p.id === playerId;
      let visibleHand = null;
      if (r && r.blind && !isMe) {
        // The one-card round: everyone else's card is face up, yours is not.
        visibleHand = this.orderedHand(p).map((c) => c.id);
      }
      return {
        id: p.id,
        seat: p.seat,
        name: p.name,
        connected: p.connected,
        isBot: p.isBot,
        fill: !!p.fill,
        score: p.score,
        tricksWon: p.tricksWon,
        handCount: p.hand.length,
        hasBid: p.bid !== null,
        bid: r && r.bidsRevealed ? p.bid : (isMe ? p.bid : null),
        roundScores: p.roundScores,
        visibleHand,
      };
    });

    let yourHand = null;
    let legal = null;
    if (me && r) {
      if (r.blind) {
        // You cannot see your own card this round.
        yourHand = null;
      } else {
        yourHand = this.orderedHand(me).map((c) => c.id);
      }
      if (r.phase === 'playing' && r.currentSeat === me.seat) {
        legal = legalPlays(me.hand, this.ledSuit()).map((c) => c.id);
      }
    }

    return {
      status: this.status,
      you: me ? { id: me.id, seat: me.seat, name: me.name, isBot: me.isBot } : null,
      players,
      roundIndex: this.roundIndex,
      totalRounds: this.schedule.length,
      schedule: this.schedule,
      round: r ? {
        cardsPerHand: r.cardsPerHand,
        tricksTotal: r.tricksTotal,
        trickNumber: r.trickNumber,
        trumpCard: r.trumpCard.id,
        trumpSuit: r.trumpSuit,
        noTrump: r.noTrump,
        blind: r.blind,
        phase: r.phase,
        bidsRevealed: r.bidsRevealed,
        leadSeat: r.leadSeat,
        currentSeat: r.currentSeat,
        ledSuit: this.ledSuit(),
        trick: r.trick.map((x) => ({ seat: x.seat, card: x.card.id, name: x.name })),
        winnerSeat: r.winnerSeat,
        // Who would take the trick if it stopped right now. Computed here so
        // the client never has to re-implement the ranking rules.
        leadingSeat: r.trick.length ? trickWinner(r.trick, r.trumpSuit).seat : null,
        lastTrick: r.lastTrick ? {
          winnerSeat: r.lastTrick.winnerSeat,
          plays: r.lastTrick.plays.map((x) => ({ seat: x.seat, card: x.card.id, name: x.name })),
        } : null,
        results: r.results || null,
        deadline: r.deadline,
        maxBid: r.cardsPerHand,
        totalBid: r.bidsRevealed ? this.players.reduce((s, p) => s + (p.bid || 0), 0) : null,
      } : null,
      yourHand,
      yourBid: me ? me.bid : null,
      legal,
      log: this.log.slice(-12),
    };
  }

  changed() { this.onChange(); }
}
