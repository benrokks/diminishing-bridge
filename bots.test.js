/**
 * Bot seating: a table needs five seats, but not five people.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RoomManager } from './rooms.js';
import { TIMERS } from './game.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function seatRoom(humans = 2) {
  const manager = new RoomManager(null);
  const room = manager.create({ isPrivate: true });
  const ids = [];
  for (let i = 0; i < humans; i++) {
    const id = `human-${i}`;
    room.game.addPlayer({ id, name: `H${i}`, token: `t${i}`, deviceId: `dev-${i}-aaaaaaaa` });
    ids.push(id);
  }
  room.hostId = ids[0];
  return { manager, room, ids };
}

test('two people cannot start alone, but can once bots fill the table', () => {
  const { room, ids } = seatRoom(2);
  assert.equal(room.canStart, false, 'two people should not be a legal table');
  assert.throws(() => room.game.start(), /needs 5 seats/);

  room.setTableSize(ids[0], 5);
  assert.equal(room.playerCount, 5);
  assert.equal(room.humanCount, 2);
  assert.equal(room.botCount, 3);
  assert.equal(room.canStart, true);

  room.game.start();
  assert.equal(room.game.status, 'playing');
  assert.deepEqual(room.game.schedule[0], 10, 'five seats deal ten cards in round one');
});

test('only the host can seat or remove bots', () => {
  const { room, ids } = seatRoom(2);
  assert.throws(() => room.addBot(ids[1]), /Only the host/);
  assert.throws(() => room.setTableSize(ids[1], 6), /Only the host/);
  assert.throws(() => room.removeBot(ids[1]), /Only the host/);
  room.addBot(ids[0]);
  assert.equal(room.botCount, 1);
});

test('table size is clamped to the legal range and to the people present', () => {
  const { room, ids } = seatRoom(6);
  assert.throws(() => room.setTableSize(ids[0], 4), /between 5 and 10/);
  assert.throws(() => room.setTableSize(ids[0], 11), /between 5 and 10/);
  assert.throws(() => room.setTableSize(ids[0], 5), /6 people are already seated/);

  room.setTableSize(ids[0], 9);
  assert.equal(room.playerCount, 9);
  assert.equal(room.botCount, 3);

  // Shrinking removes bots, never people.
  room.setTableSize(ids[0], 7);
  assert.equal(room.playerCount, 7);
  assert.equal(room.humanCount, 6);
  assert.equal(room.botCount, 1);
});

test('bots never take a name a real player is using', () => {
  const manager = new RoomManager(null);
  const room = manager.create({ isPrivate: true });
  room.game.addPlayer({ id: 'h0', name: 'Ada', token: 't', deviceId: 'dev-0-aaaaaaaa' });
  room.game.addPlayer({ id: 'h1', name: 'Bruno', token: 't', deviceId: 'dev-1-aaaaaaaa' });
  room.hostId = 'h0';
  room.setTableSize('h0', 6);

  const names = room.game.players.map((p) => p.name);
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, names.length,
    `duplicate names at the table: ${names.join(', ')}`);
  assert.ok(names.includes('Ada') && names.includes('Bruno'));
});

test('a table holding only bots counts as abandoned', () => {
  const { room, ids } = seatRoom(1);
  room.setTableSize(ids[0], 5);
  assert.equal(room.humanCount, 1);
  room.game.setConnected(ids[0], false);
  assert.equal(room.humanCount, 0, 'bots must not keep a dead table alive');
});

test('an arriving human takes a bot seat rather than being turned away', () => {
  const { room, ids } = seatRoom(2);
  room.setTableSize(ids[0], 10);
  assert.equal(room.playerCount, 10);
  assert.equal(room.isFull, true);
  assert.equal(room.joinable, true, 'a bot-padded table should still accept people');

  assert.equal(room.game.dropOneBot(), true);
  room.game.addPlayer({ id: 'late', name: 'Late', token: 't', deviceId: 'dev-late-aaaa' });
  assert.equal(room.playerCount, 10);
  assert.equal(room.humanCount, 3);
  assert.equal(room.botCount, 7);
  assert.deepEqual(room.game.players.map((p) => p.seat), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('bots are excluded from the standings', () => {
  Object.assign(TIMERS, { bidding: 0, bidReveal: 0, playing: 0, trickEnd: 0, roundEnd: 0, botDelay: 0 });
  const { room, ids } = seatRoom(2);
  room.setTableSize(ids[0], 5);
  room.game.start();
  let guard = 0;
  while (room.game.status !== 'finished' && guard++ < 400000) room.game.tick();

  const rows = room.game.gameSummary();
  assert.equal(rows.length, 2, 'only the two real players should be recorded');
  assert.deepEqual(rows.map((r) => r.deviceId).sort(),
    ['dev-0-aaaaaaaa', 'dev-1-aaaaaaaa']);
  // The game itself still ran a full five-handed ladder.
  assert.equal(room.game.schedule.length, 19);
  for (const p of room.game.players) assert.equal(p.roundScores.length, 19);
});

test('a rematch keeps the bots seated as bots', () => {
  Object.assign(TIMERS, { bidding: 0, bidReveal: 0, playing: 0, trickEnd: 0, roundEnd: 0, botDelay: 0 });
  const { room, ids } = seatRoom(2);
  room.setTableSize(ids[0], 5);
  room.game.start();
  let guard = 0;
  while (room.game.status !== 'finished' && guard++ < 400000) room.game.tick();

  room.rematch(ids[0]);
  assert.equal(room.playerCount, 5);
  assert.equal(room.botCount, 3);
  for (const p of room.game.players) {
    assert.equal(p.isBot, !!p.fill, 'fill bots must stay bots, humans must not');
    assert.equal(p.score, 0);
  }
});

// ------------------------------------------------------------ over the wire

const PORT = 38400 + Math.floor(Math.random() * 300);

function startServer() {
  const child = spawn(process.execPath, [path.join(here, 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DBRIDGE_BID_MS: '400', DBRIDGE_REVEAL_MS: '20', DBRIDGE_PLAY_MS: '400',
      DBRIDGE_TRICK_MS: '20', DBRIDGE_ROUND_MS: '40', DBRIDGE_BOT_MS: '10',
      DBRIDGE_TICK_MS: '8',
      DBRIDGE_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'dbridge-bots-')),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 10000);
    child.stdout.on('data', (d) => {
      if (d.toString().includes('listening')) { clearTimeout(t); resolve(child); }
    });
    child.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  });
}

class Sock {
  constructor() {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    this.state = null; this.room = null; this.code = null; this.errors = [];
    this.ready = new Promise((r) => this.ws.on('open', r));
    this.ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === 'joined') this.code = m.code;
      if (m.t === 'error') this.errors.push(m.msg);
      if (m.t === 'state') { this.state = m.game; this.room = m.room; }
    });
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('two real players fill a table with bots and play a whole game', async (t) => {
  const server = await startServer();
  t.after(() => server.kill());

  const ben = new Sock();
  const dana = new Sock();
  await Promise.all([ben.ready, dana.ready]);

  ben.send({ t: 'createRoom', name: 'Ben', private: true, deviceId: 'ben-device-aaaa' });
  await wait(300);
  dana.send({ t: 'joinRoom', code: ben.code, name: 'Dana', deviceId: 'dana-device-aaa' });
  await wait(300);

  assert.equal(ben.state.players.length, 2);
  assert.equal(ben.room.canStart, false, 'two people alone should not be startable');

  // Dana cannot seat bots; Ben can.
  dana.send({ t: 'addBot' });
  await wait(200);
  assert.ok(dana.errors.some((e) => /host/i.test(e)));

  ben.send({ t: 'tableSize', size: 5 });
  await wait(300);
  assert.equal(ben.room.canStart, true, 'a bot-filled table should be startable');
  assert.equal(ben.room.humans, 2);
  assert.equal(ben.room.bots, 3);
  assert.equal(dana.state.players.length, 5, 'the other player sees the bots too');
  assert.equal(dana.state.players.filter((p) => p.fill).length, 3);

  ben.send({ t: 'start' });
  const done = await new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (ben.state && ben.state.status === 'finished') { clearInterval(iv); resolve(true); }
      else if (Date.now() - t0 > 150000) { clearInterval(iv); resolve(false); }
    }, 200);
  });
  assert.ok(done, 'the bot-filled game did not finish');
  assert.deepEqual(ben.errors, []);

  // Only the two humans are recorded.
  await wait(700);
  const board = await (await fetch(`http://127.0.0.1:${PORT}/api/leaderboard`)).json();
  const names = board.map((r) => r.name).sort();
  assert.deepEqual(names, ['Ben', 'Dana'], `bots leaked into the standings: ${names.join(', ')}`);

  ben.close(); dana.close();
  await wait(200);
});

test('a bot-padded public table still accepts a late arrival', async (t) => {
  const server = await startServer();
  t.after(() => server.kill());

  const host = new Sock();
  const late = new Sock();
  await Promise.all([host.ready, late.ready]);

  host.send({ t: 'createRoom', name: 'Host', private: false, deviceId: 'host-device-aaa' });
  await wait(300);
  host.send({ t: 'tableSize', size: 10 });
  await wait(300);
  assert.equal(host.room.bots, 9, 'table should be padded to ten seats');

  late.send({ t: 'joinRoom', code: host.code, name: 'Late', deviceId: 'late-device-aaa' });
  await wait(400);

  assert.deepEqual(late.errors, [], 'a human should never be turned away for a bot');
  assert.equal(host.room.humans, 2);
  assert.equal(host.state.players.length, 10, 'the table stays at ten seats');
  assert.equal(host.room.bots, 8, 'a bot gave up its seat');

  host.close(); late.close();
  await wait(200);
});
