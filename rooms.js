/**
 * rooms.js — room lifecycle, matchmaking list, naming rules, rate limiting.
 */

import { randomUUID } from 'node:crypto';
import { Game } from './game.js';
import { MIN_PLAYERS, MAX_PLAYERS } from './engine.js';
import { PERSONA_NAMES, personaFor, replyTo, oneOf } from './personas.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 confusion
const ROOM_IDLE_MS = 10 * 60 * 1000;   // empty rooms are swept after this

// Bot seats take the names of the cast in personas.js, so a padded table does
// not read as "Bot1, Bot2, Bot3" and each seat plays and talks in character.
const BOT_NAMES = PERSONA_NAMES;

// How often every live table is advanced. This is the granularity of every
// server-driven transition (bot moves, trick pauses, round rollover), so it
// also bounds how fast a bot can play. Env-overridable like the other clocks.
const TICK_MS = (() => {
  const v = Number(process.env.DBRIDGE_TICK_MS);
  return Number.isFinite(v) && v >= 5 ? v : 400;
})();

// Deliberately small and blunt. Public rooms with no login need *a* filter;
// this is not a content-moderation system.
const BLOCKED = [
  'fuck', 'shit', 'cunt', 'nigg', 'faggot', 'rape', 'nazi', 'hitler',
  'bitch', 'whore', 'retard', 'kike', 'spic', 'chink', 'tranny',
];

export function sanitizeName(raw) {
  let name = String(raw || '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 14);
  if (!name) name = 'Player';
  const flat = name.toLowerCase().replace(/[^a-z]/g, '');
  if (BLOCKED.some((w) => flat.includes(w))) name = 'Player';
  return name;
}

// Chat is unfiltered by design. The only limits here are structural: a size
// cap so one message cannot exhaust memory or bandwidth for the whole table,
// and a history cap. Rendering escapes HTML on the client, which prevents a
// player from injecting script into everyone else's browser — that is an
// XSS defence, not a content rule.
const CHAT_MAX_LEN = 400;
const CHAT_HISTORY = 80;

export class Room {
  constructor(manager, { isPrivate }) {
    this.manager = manager;
    this.code = manager.freshCode();
    this.isPrivate = !!isPrivate;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.hostId = null;
    this.sockets = new Map(); // playerId -> ws
    this.chat = [];
    this.chatSeq = 0;
    this.gamesPlayed = 0;
    this.recorded = false;
    /** Host-set table rules and preferences, applied when the game starts. */
    this.options = { blindBonus: false, botChat: true };
    this.botQueue = [];   // [{ at, playerId, text }] — bots type, they don't teleport
    this.game = new Game({
      onChange: () => this.broadcast(),
      onEvent: (e) => this.onGameEvent(e),
    });
  }

  startGame(byPlayerId) {
    this.requireHost(byPlayerId);
    // Rules are frozen into the game as it starts, so nothing can change mid-hand.
    this.game.options = { blindBonus: !!this.options.blindBonus };
    this.game.start();
    if (this.options.blindBonus) {
      this.pushSystemChat('Table rule ON: on the single-card round, bid 1 and take it for 21 points.');
    }
    if (this.options.botChat) {
      for (const p of this.game.players) {
        if (!p.fill) continue;
        if (Math.random() < 0.5) {
          this.queueBotLine(p, oneOf(personaFor(p.voice || p.name).lines.start),
            600 + Math.random() * 3000);
        }
      }
    }
  }

  onGameEvent(e) {
    if (e.kind === 'gameOver' && !this.recorded) {
      this.recorded = true;
      this.gamesPlayed += 1;
      const rows = this.game.gameSummary();
      if (rows.length && this.manager.store) {
        Promise.resolve(this.manager.store.recordGame(rows))
          .then(() => this.pushSystemChat(
            `Game ${this.gamesPlayed} recorded to the all-time standings.`))
          .catch((err) => console.error('standings: record failed —', err.message));
      }
    }
    if (e.kind === 'roundEnd' && this.options.botChat && Array.isArray(e.results)) {
      for (const res of e.results) {
        const p = this.game.bySeat(res.seat);
        if (!p || !p.fill || Math.random() > 0.3) continue;
        const lines = personaFor(p.voice || p.name).lines;
        this.queueBotLine(p, oneOf(res.gained >= 10 ? lines.won : lines.lost),
          800 + Math.random() * 3200);
      }
    }
    this.broadcastEvent(e);
  }

  // ------------------------------------------------------------------ chat

  postChat(playerId, text) {
    const p = this.game.byId(playerId);
    if (!p) throw new Error('You are not at this table');
    const body = String(text == null ? '' : text).slice(0, CHAT_MAX_LEN);
    if (!body.trim()) return;
    const msg = {
      id: ++this.chatSeq,
      from: p.name,
      playerId: p.id,
      seat: p.seat,
      text: body,
      system: false,
      t: Date.now(),
    };
    this.chat.push(msg);
    if (this.chat.length > CHAT_HISTORY) this.chat.shift();
    this.lastActivity = Date.now();
    for (const [, ws] of this.sockets) this.send(ws, { t: 'chat', msg });
    if (!p.fill) this.botsRespondTo(body, p.id);
  }

  /**
   * Bots reply on a delay so the lobby reads like people talking rather than
   * a wall of instant output. Queued here, drained by tickChat().
   */
  queueBotLine(player, text, delay) {
    if (!text || !this.options.botChat) return;
    this.botQueue.push({
      at: Date.now() + Math.max(200, delay || 1200),
      playerId: player.id,
      text,
    });
  }

  /** A person said something: let one or two bots answer, in character. */
  botsRespondTo(text, fromPlayerId) {
    if (!this.options.botChat) return;
    const bots = this.game.players.filter((p) => p.fill && p.id !== fromPlayerId);
    if (!bots.length) return;
    // Not everyone chimes in every time, or it becomes noise.
    const shuffled = bots.slice().sort(() => Math.random() - 0.5);
    const howMany = Math.random() < 0.45 ? 1 : (Math.random() < 0.75 ? 2 : 0);
    for (let i = 0; i < howMany && i < shuffled.length; i++) {
      const bot = shuffled[i];
      this.queueBotLine(bot, replyTo(personaFor(bot.voice || bot.name), text),
        900 + Math.random() * 2600 + i * 1400);
    }
  }

  /** Say a line from every bot that has one due. Called on the room tick. */
  tickChat() {
    if (!this.botQueue.length) return;
    const now = Date.now();
    const due = this.botQueue.filter((q) => q.at <= now);
    if (!due.length) return;
    this.botQueue = this.botQueue.filter((q) => q.at > now);
    for (const q of due) {
      const p = this.game.byId(q.playerId);
      if (!p || !p.fill) continue;   // the bot was removed while it was "typing"
      const msg = {
        id: ++this.chatSeq,
        from: p.name,
        playerId: p.id,
        seat: p.seat,
        text: q.text,
        system: false,
        bot: true,
        t: now,
      };
      this.chat.push(msg);
      if (this.chat.length > CHAT_HISTORY) this.chat.shift();
      for (const [, ws] of this.sockets) this.send(ws, { t: 'chat', msg });
    }
  }

  pushSystemChat(text) {
    const msg = { id: ++this.chatSeq, from: null, text, system: true, t: Date.now() };
    this.chat.push(msg);
    if (this.chat.length > CHAT_HISTORY) this.chat.shift();
    for (const [, ws] of this.sockets) this.send(ws, { t: 'chat', msg });
  }

  // --------------------------------------------------------------- rematch

  rematch(playerId) {
    if (this.game.status !== 'finished') throw new Error('The game is still going');
    if (this.hostId !== playerId) throw new Error('Only the host can start a rematch');
    this.recorded = false;
    this.game.reset();
    if (!this.game.byId(this.hostId)) this.hostId = this.game.players[0]?.id || null;
    this.pushSystemChat('New game — everyone keeps their seat.');
    this.broadcast();
  }

  get playerCount() { return this.game.players.length; }
  get humanCount() { return this.game.humanCount; }
  get botCount() { return this.game.botCount; }
  get canStart() { return this.playerCount >= MIN_PLAYERS && this.game.status === 'lobby'; }
  get isFull() { return this.playerCount >= MAX_PLAYERS; }
  /** A table padded to full with bots is still joinable — a human bumps a bot. */
  get joinable() {
    return this.game.status === 'lobby' && (!this.isFull || this.botCount > 0);
  }

  // ------------------------------------------------------------------- bots

  requireHost(playerId) {
    if (this.hostId !== playerId) throw new Error('Only the host can change the table');
  }

  /** The next unused bot name, so a bot never shadows a real player's name. */
  botName() {
    const taken = new Set(this.game.players.map((p) => p.name.toLowerCase()));
    for (const n of BOT_NAMES) if (!taken.has(n.toLowerCase())) return n;
    return `Bot ${this.game.players.length + 1}`;
  }

  seatBot() {
    const name = this.botName();
    const persona = personaFor(name);
    const p = this.game.addPlayer({
      id: randomUUID(),
      name,
      token: null,
      deviceId: null, // bots never reach the standings
      fill: true,
    });
    // Card-play tilt: nerve, temper, showman. See personas.js.
    p.persona = { nerve: persona.nerve, temper: persona.temper, showman: persona.showman };
    p.voice = name;
    if (this.options.botChat) {
      this.queueBotLine(p, oneOf(persona.lines.seated), 700 + Math.random() * 2200);
    }
  }

  addBot(byPlayerId) {
    this.requireHost(byPlayerId);
    if (this.game.status !== 'lobby') throw new Error('The game has already started');
    if (this.isFull) throw new Error(`A table tops out at ${MAX_PLAYERS} seats`);
    this.seatBot();
    this.lastActivity = Date.now();
  }

  removeBot(byPlayerId, botId) {
    this.requireHost(byPlayerId);
    if (this.game.status !== 'lobby') throw new Error('The game has already started');
    if (botId) {
      const p = this.game.byId(botId);
      if (!p || !p.fill) throw new Error('That seat is not a bot');
      this.game.removePlayer(botId);
    } else if (!this.game.dropOneBot()) {
      throw new Error('There are no bots to remove');
    }
    this.lastActivity = Date.now();
  }

  /** Host toggles for optional table rules and bot chatter. */
  setRule(byPlayerId, rule, on) {
    this.requireHost(byPlayerId);
    if (this.game.status !== 'lobby') throw new Error('Rules are set before the game starts');
    if (!Object.prototype.hasOwnProperty.call(this.options, rule)) {
      throw new Error('Unknown rule');
    }
    this.options[rule] = !!on;
    if (rule === 'botChat' && !on) this.botQueue = [];
    this.lastActivity = Date.now();
  }

  /** Pad the table out to `size` seats with bots, or trim bots back down to it. */
  setTableSize(byPlayerId, size) {
    this.requireHost(byPlayerId);
    if (this.game.status !== 'lobby') throw new Error('The game has already started');
    const n = Number(size);
    if (!Number.isInteger(n) || n < MIN_PLAYERS || n > MAX_PLAYERS) {
      throw new Error(`A table must have between ${MIN_PLAYERS} and ${MAX_PLAYERS} seats`);
    }
    if (n < this.humanCount) {
      throw new Error(`${this.humanCount} people are already seated`);
    }
    let guard = 0;
    while (this.playerCount < n && guard++ <= MAX_PLAYERS) this.seatBot();
    while (this.playerCount > n && this.botCount > 0 && guard++ <= 40) this.game.dropOneBot();
    this.lastActivity = Date.now();
  }

  summary() {
    return {
      code: this.code,
      players: this.playerCount,
      max: MAX_PLAYERS,
      min: MIN_PLAYERS,
      status: this.game.status,
      joinable: this.joinable,
      humans: this.humanCount,
      bots: this.botCount,
      names: this.game.players.filter((p) => !p.fill).map((p) => p.name),
      createdAt: this.createdAt,
    };
  }

  attach(playerId, ws) {
    this.sockets.set(playerId, ws);
    this.game.setConnected(playerId, true);
    this.lastActivity = Date.now();
    this.send(ws, { t: 'chatHistory', msgs: this.chat });
  }

  detach(playerId) {
    this.sockets.delete(playerId);
    if (this.game.status === 'lobby') {
      this.game.removePlayer(playerId);
      if (this.hostId === playerId) {
        this.hostId = this.game.players[0]?.id || null;
      }
    } else {
      this.game.setConnected(playerId, false);
    }
    this.lastActivity = Date.now();
    this.broadcast();
  }

  send(ws, msg) {
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify(msg)); } catch { /* socket died mid-send */ }
    }
  }

  broadcast() {
    for (const [pid, ws] of this.sockets) {
      this.send(ws, {
        t: 'state',
        room: {
          code: this.code,
          isPrivate: this.isPrivate,
          hostId: this.hostId,
          canStart: this.canStart,
          gamesPlayed: this.gamesPlayed,
          humans: this.humanCount,
          bots: this.botCount,
          minPlayers: MIN_PLAYERS,
          maxPlayers: MAX_PLAYERS,
          options: { ...this.options },
        },
        game: this.game.viewFor(pid),
      });
    }
  }

  broadcastEvent(e) {
    for (const [, ws] of this.sockets) this.send(ws, { t: 'event', ...e });
  }

  get isDead() {
    // Grace period so a freshly created room isn't swept before anyone connects.
    if (Date.now() - this.createdAt < 60000) return false;
    const noSockets = this.sockets.size === 0;
    const idleFor = Date.now() - this.lastActivity;
    // A game with no humans left is just bots playing bots.
    const abandoned = this.game.status === 'playing' && this.game.humanCount === 0;
    return abandoned || (noSockets && (this.game.status === 'lobby' || idleFor > ROOM_IDLE_MS));
  }
}

export class RoomManager {
  constructor(store = null) {
    this.store = store;         // persistent career standings
    this.rooms = new Map();     // code -> Room
    this.rateLimit = new Map(); // ip -> [timestamps]
    this.timer = setInterval(() => this.tickAll(), TICK_MS);
    this.sweeper = setInterval(() => this.sweep(), 30000);
    // Unreferenced so these clocks never hold the process open by themselves.
    // The HTTP server keeps a live deployment running; a script or test that
    // only builds a RoomManager can still exit.
    this.timer.unref?.();
    this.sweeper.unref?.();
  }

  /** Stop the clocks. Only needed if you tear a manager down by hand. */
  stop() {
    clearInterval(this.timer);
    clearInterval(this.sweeper);
  }

  freshCode() {
    for (let attempt = 0; attempt < 500; attempt++) {
      let code = '';
      for (let i = 0; i < 4; i++) {
        code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
    return randomUUID().slice(0, 6).toUpperCase();
  }

  /** Max 6 room creations per IP per minute. */
  allowCreate(ip) {
    const now = Date.now();
    const hits = (this.rateLimit.get(ip) || []).filter((t) => now - t < 60000);
    if (hits.length >= 6) return false;
    hits.push(now);
    this.rateLimit.set(ip, hits);
    return true;
  }

  create({ isPrivate, ip }) {
    if (this.rooms.size > 400) throw new Error('Server is at capacity, try again shortly');
    if (ip && !this.allowCreate(ip)) throw new Error('Slow down — too many rooms created');
    const room = new Room(this, { isPrivate });
    this.rooms.set(room.code, room);
    return room;
  }

  get(code) { return this.rooms.get(String(code || '').toUpperCase().trim()); }

  publicList() {
    return [...this.rooms.values()]
      .filter((r) => !r.isPrivate && r.game.status === 'lobby')
      .sort((a, b) => b.playerCount - a.playerCount || a.createdAt - b.createdAt)
      .slice(0, 40)
      .map((r) => r.summary());
  }

  /** Quick Play: biggest joinable public room, else a new one. */
  quickPlay(ip) {
    const open = [...this.rooms.values()]
      .filter((r) => !r.isPrivate && r.joinable)
      .sort((a, b) => b.playerCount - a.playerCount);
    return open[0] || this.create({ isPrivate: false, ip });
  }

  tickAll() {
    for (const room of this.rooms.values()) {
      try { room.game.tick(); room.tickChat(); }
      catch (err) { console.error('tick error', room.code, err); }
    }
  }

  sweep() {
    for (const [code, room] of this.rooms) {
      if (room.isDead) this.rooms.delete(code);
    }
    const now = Date.now();
    for (const [ip, hits] of this.rateLimit) {
      const live = hits.filter((t) => now - t < 60000);
      if (live.length) this.rateLimit.set(ip, live); else this.rateLimit.delete(ip);
    }
  }
}
