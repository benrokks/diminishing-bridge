/**
 * rooms.js — room lifecycle, matchmaking list, naming rules, rate limiting.
 */

import { randomUUID } from 'node:crypto';
import { Game } from './game.js';
import { MIN_PLAYERS, MAX_PLAYERS } from './engine.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 confusion
const ROOM_IDLE_MS = 10 * 60 * 1000;   // empty rooms are swept after this

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
    this.game = new Game({
      onChange: () => this.broadcast(),
      onEvent: (e) => this.onGameEvent(e),
    });
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
  get canStart() { return this.playerCount >= MIN_PLAYERS && this.game.status === 'lobby'; }
  get isFull() { return this.playerCount >= MAX_PLAYERS; }
  get joinable() { return this.game.status === 'lobby' && !this.isFull; }

  summary() {
    return {
      code: this.code,
      players: this.playerCount,
      max: MAX_PLAYERS,
      min: MIN_PLAYERS,
      status: this.game.status,
      joinable: this.joinable,
      names: this.game.players.map((p) => p.name),
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
      try { room.game.tick(); } catch (err) { console.error('tick error', room.code, err); }
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
