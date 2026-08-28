/**
 * Tests for chat, persistent standings, and the rematch flow.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Game, TIMERS } from './game.js';
import { createStore } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- store

test('the file store accumulates career stats and ranks players', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbridge-store-'));
  delete process.env.DATABASE_URL;

  const store = await createStore({ dir });
  assert.equal(store.kind, 'file');

  await store.recordGame([
    { key: 'dev-a', name: 'Ben', score: 120, won: true, rounds: 9, exactBids: 6, busts: 2, tricks: 14 },
    { key: 'dev-b', name: 'Dana', score: 90, won: false, rounds: 9, exactBids: 3, busts: 4, tricks: 11 },
  ]);
  await store.recordGame([
    { key: 'dev-a', name: 'Ben', score: 80, won: false, rounds: 9, exactBids: 3, busts: 3, tricks: 9 },
    { key: 'dev-b', name: 'Dana', score: 140, won: true, rounds: 9, exactBids: 7, busts: 1, tricks: 16 },
  ]);
  await store.recordGame([
    { key: 'dev-b', name: 'Dana', score: 200, won: true, rounds: 9, exactBids: 8, busts: 0, tricks: 18 },
  ]);

  const a = await store.player('dev-a');
  assert.equal(a.games, 2);
  assert.equal(a.wins, 1);
  assert.equal(a.totalScore, 200);
  assert.equal(a.avgScore, 100);
  assert.equal(a.bestScore, 120);
  assert.equal(a.tricks, 23);
  assert.equal(a.exactBids, 9);
  assert.equal(a.rounds, 18);
  assert.equal(a.accuracy, 0.5);

  const board = await store.leaderboard(10);
  assert.equal(board[0].key, 'dev-b', 'more wins should rank first');
  assert.equal(board[0].wins, 2);
  assert.equal(board[1].key, 'dev-a');
  assert.equal(a.rank, 2);
  assert.equal(a.of, 2);

  // Unknown device is simply absent, not an error.
  assert.equal(await store.player('nobody'), null);

  await store.close();

  // A fresh store reads the same numbers back off disk.
  const reopened = await createStore({ dir });
  const again = await reopened.player('dev-a');
  assert.equal(again.games, 2);
  assert.equal(again.bestScore, 120);
  await reopened.close();

  fs.rmSync(dir, { recursive: true, force: true });
});

test('players without a device id are skipped rather than recorded as one blob', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbridge-store-'));
  const store = await createStore({ dir });
  await store.recordGame([
    { key: null, name: 'Ghost', score: 50, won: true, rounds: 9 },
    { key: '', name: 'Ghost2', score: 40, won: false, rounds: 9 },
  ]);
  assert.deepEqual(await store.leaderboard(10), []);
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ----------------------------------------------------------- game stats

test('per-game counters track exact bids, busts and tricks', () => {
  Object.assign(TIMERS, { bidding: 0, bidReveal: 0, autoPlay: 0, playing: 0, trickEnd: 0, roundEnd: 0, botDelay: 0 });
  const game = new Game();
  for (let i = 0; i < 10; i++) {
    game.addPlayer({ id: `p${i}`, name: `P${i}`, token: `t${i}`, statsKey: `dev:d${i}` });
  }
  game.players.forEach((p) => { p.isBot = true; });
  game.start();
  let guard = 0;
  while (game.status !== 'finished' && guard++ < 400000) game.tick();

  const rows = game.gameSummary();
  assert.equal(rows.length, 10);
  const totalRounds = game.schedule.length;
  for (const row of rows) {
    assert.equal(row.rounds, totalRounds);
    // Every round is either hit, over, or under.
    const p = game.players.find((x) => x.statsKey === row.key);
    const overs = totalRounds - p.exactBids - p.busts;
    assert.ok(overs >= 0, 'round outcomes do not add up');
    assert.equal(row.exactBids + row.busts + overs, totalRounds);
    assert.ok(row.score >= 0);
  }
  // Tricks across all players equal the total tricks in the game.
  const totalTricks = rows.reduce((s, r) => s + r.tricks, 0);
  const expected = game.schedule.reduce((s, n) => s + n, 0);
  assert.equal(totalTricks, expected);

  // Exactly one winner flag per top score (ties may flag several).
  assert.ok(rows.some((r) => r.won));
});

test('rematch keeps everyone seated and wipes the scores', () => {
  Object.assign(TIMERS, { bidding: 0, bidReveal: 0, autoPlay: 0, playing: 0, trickEnd: 0, roundEnd: 0, botDelay: 0 });
  const game = new Game();
  for (let i = 0; i < 5; i++) {
    game.addPlayer({ id: `p${i}`, name: `P${i}`, token: `t${i}`, statsKey: `dev:d${i}` });
  }
  game.players.forEach((p) => { p.isBot = true; });
  game.start();
  let guard = 0;
  while (game.status !== 'finished' && guard++ < 400000) game.tick();
  assert.ok(game.players.some((p) => p.score > 0));

  game.reset();
  assert.equal(game.status, 'lobby');
  assert.equal(game.players.length, 5);
  assert.equal(game.roundIndex, -1);
  assert.equal(game.round, null);
  assert.equal(game.prevActiveTrump, null, 'trump chain must not leak across games');
  for (const p of game.players) {
    assert.equal(p.score, 0);
    assert.equal(p.roundScores.length, 0);
    assert.equal(p.exactBids, 0);
    assert.equal(p.busts, 0);
    assert.equal(p.tricks, 0);
    assert.equal(p.isBot, false, 'bot flags should clear for a new game');
  }
  // And it can play again cleanly.
  game.players.forEach((p) => { p.isBot = true; });
  game.start();
  guard = 0;
  while (game.status !== 'finished' && guard++ < 400000) game.tick();
  assert.equal(game.status, 'finished');
});

test('rematch drops players who disconnected and renumbers the seats', () => {
  const game = new Game();
  for (let i = 0; i < 6; i++) {
    game.addPlayer({ id: `p${i}`, name: `P${i}`, token: `t${i}`, statsKey: `dev:d${i}` });
  }
  game.players.forEach((p) => { p.isBot = true; });
  game.start();
  let guard = 0;
  while (game.status !== 'finished' && guard++ < 400000) game.tick();

  game.byId('p2').connected = false;
  game.byId('p4').connected = false;
  game.reset();

  assert.equal(game.players.length, 4);
  assert.deepEqual(game.players.map((p) => p.id), ['p0', 'p1', 'p3', 'p5']);
  assert.deepEqual(game.players.map((p) => p.seat), [0, 1, 2, 3]);
});

// ---------------------------------------------------------------- chat

const PORT = 35800 + Math.floor(Math.random() * 400);

function startServer(extraEnv = {}) {
  // DBRIDGE_DATA_DIR below asks for an isolated standings store; a stray
  // DATABASE_URL in the shell would quietly override it with a shared one.
  const env = { ...process.env };
  delete env.DATABASE_URL;
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: {
      ...env,
      PORT: String(PORT),
      DBRIDGE_BID_MS: '8000', DBRIDGE_REVEAL_MS: '20', DBRIDGE_AUTOPLAY_MS: '20', DBRIDGE_PLAY_MS: '8000',
      DBRIDGE_TRICK_MS: '20', DBRIDGE_ROUND_MS: '40', DBRIDGE_BOT_MS: '10', DBRIDGE_TICK_MS: '8',
      DBRIDGE_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'dbridge-srv-')),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 8000);
    child.stdout.on('data', (d) => {
      if (d.toString().includes('listening')) { clearTimeout(t); resolve(child); }
    });
    child.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  });
}

class Sock {
  constructor() {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    this.chat = [];
    this.history = null;
    this.errors = [];
    this.code = null;
    this.id = null;
    this.state = null;
    this.board = null;
    this.ready = new Promise((r) => this.ws.on('open', r));
    this.ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === 'chat') this.chat.push(m.msg);
      if (m.t === 'chatHistory') this.history = m.msgs;
      if (m.t === 'error') this.errors.push(m.msg);
      if (m.t === 'joined') { this.code = m.code; this.id = m.playerId; }
      if (m.t === 'state') this.state = m.game;
      if (m.t === 'leaderboard') this.board = m;
    });
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('chat reaches every seat at the table, unfiltered, with history on join', async (t) => {
  const server = await startServer();
  t.after(() => server.kill());

  const a = new Sock();
  const b = new Sock();
  await Promise.all([a.ready, b.ready]);

  a.send({ t: 'createRoom', name: 'Ben', private: true, deviceId: 'dev-ben-11111111-2222' });
  await wait(250);
  b.send({ t: 'joinRoom', code: a.code, name: 'Dana', deviceId: 'dev-dana-11111111-2222' });
  await wait(250);

  // Text is passed through completely untouched — no word filter, no link
  // stripping, punctuation and casing preserved exactly.
  const raw = 'what the hell was that bid?? http://example.com  <b>WOW</b> 100% 😤';
  a.send({ t: 'chat', text: raw });
  await wait(200);

  const got = b.chat.find((m) => !m.system);
  assert.ok(got, 'chat never arrived');
  assert.equal(got.text, raw, 'message was altered in transit');
  assert.equal(got.from, 'Ben');
  assert.equal(a.chat.find((m) => !m.system).text, raw, 'sender did not see their own message');

  // Over-long messages are truncated, not dropped — a size cap, not a filter.
  a.send({ t: 'chat', text: 'x'.repeat(1000) });
  await wait(200);
  const long = b.chat.filter((m) => !m.system).pop();
  assert.equal(long.text.length, 400);

  // Whitespace-only messages are ignored.
  const before = b.chat.length;
  a.send({ t: 'chat', text: '    ' });
  await wait(200);
  assert.equal(b.chat.length, before, 'empty message was broadcast');

  // A late joiner receives the backlog.
  const c = new Sock();
  await c.ready;
  c.send({ t: 'joinRoom', code: a.code, name: 'Ravi', deviceId: 'dev-ravi-11111111-2222' });
  await wait(300);
  assert.ok(Array.isArray(c.history), 'no history sent');
  assert.ok(c.history.some((m) => m.text === raw), 'backlog missing the earlier message');

  // You cannot chat into a table you are not sitting at.
  const outsider = new Sock();
  await outsider.ready;
  outsider.send({ t: 'chat', text: 'hello' });
  await wait(200);
  assert.ok(outsider.errors.some((e) => /not at a table/i.test(e)));

  [a, b, c, outsider].forEach((s) => s.close());
  await wait(150);
});

test('a finished game is written to the standings and a rematch starts clean', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbridge-e2e-'));
  const server = await startServer({ DBRIDGE_DATA_DIR: dataDir });
  t.after(() => server.kill());

  const socks = [];
  for (let i = 0; i < 5; i++) socks.push(new Sock());
  await Promise.all(socks.map((s) => s.ready));

  socks[0].send({ t: 'createRoom', name: 'Ben', private: true, deviceId: 'device-0-aaaaaaaa-bbbb' });
  await wait(250);
  const code = socks[0].code;
  for (let i = 1; i < 5; i++) {
    socks[i].send({ t: 'joinRoom', code, name: `P${i}`, deviceId: `device-${i}-aaaaaaaa-bbbb` });
    await wait(80);
  }
  await wait(250);

  socks[0].send({ t: 'start' });

  // Nobody acts, so the bots take over and drive the game to the end.
  const done = await new Promise((resolve) => {
    const started = Date.now();
    const iv = setInterval(() => {
      if (socks.every((s) => s.state && s.state.status === 'finished')) { clearInterval(iv); resolve(true); }
      else if (Date.now() - started > 120000) { clearInterval(iv); resolve(false); }
    }, 150);
  });
  assert.ok(done, 'game did not finish');
  await wait(600);

  socks[0].send({ t: 'leaderboard', deviceId: 'device-0-aaaaaaaa-bbbb' });
  await wait(400);
  assert.ok(socks[0].board, 'no leaderboard response');
  assert.equal(socks[0].board.rows.length, 5, 'not every seat was recorded');
  assert.ok(socks[0].board.mine, 'my own record is missing');
  assert.equal(socks[0].board.mine.games, 1);
  assert.equal(socks[0].board.rows.reduce((s, r) => s + r.wins, 0) >= 1, true);

  // A device id is the only credential behind a career record, so it must
  // never be sent to anyone — otherwise a player could claim another's stats.
  const raw = JSON.stringify(socks[0].board);
  for (let i = 0; i < 5; i++) {
    assert.ok(!raw.includes(`device-${i}-aaaaaaaa-bbbb`),
      `leaderboard payload leaked device-${i}`);
  }
  assert.equal(socks[0].board.rows.filter((r) => r.isMe).length, 1,
    'exactly one row should be flagged as mine');

  // A non-host cannot force a rematch.
  socks[2].send({ t: 'rematch' });
  await wait(250);
  assert.ok(socks[2].errors.some((e) => /host/i.test(e)), 'non-host triggered a rematch');

  // The host can, and everyone lands back in the lobby with zeroed scores.
  socks[0].send({ t: 'rematch' });
  await wait(400);
  for (const s of socks) {
    assert.equal(s.state.status, 'lobby', 'did not return to the lobby');
    assert.ok(s.state.players.every((p) => p.score === 0), 'scores were not reset');
    assert.equal(s.state.players.length, 5, 'lost a player in the rematch');
  }

  // Second game records a second entry rather than overwriting the first.
  socks[0].send({ t: 'start' });
  const done2 = await new Promise((resolve) => {
    const started = Date.now();
    const iv = setInterval(() => {
      if (socks.every((s) => s.state && s.state.status === 'finished')) { clearInterval(iv); resolve(true); }
      else if (Date.now() - started > 120000) { clearInterval(iv); resolve(false); }
    }, 150);
  });
  assert.ok(done2, 'second game did not finish');
  await wait(700);

  socks[0].send({ t: 'leaderboard', deviceId: 'device-0-aaaaaaaa-bbbb' });
  await wait(400);
  assert.equal(socks[0].board.mine.games, 2, 'the rematch was not recorded as a separate game');

  socks.forEach((s) => s.close());
  await wait(150);
  fs.rmSync(dataDir, { recursive: true, force: true });
});
