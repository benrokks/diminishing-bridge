/**
 * Exercises the Postgres standings backend against a real database.
 *
 * Skipped automatically unless TEST_DATABASE_URL is set, so `npm test` still
 * works on a machine with no Postgres. To run it:
 *   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from './store.js';

const URL = process.env.TEST_DATABASE_URL;
const opts = { skip: URL ? false : 'set TEST_DATABASE_URL to run the Postgres tests' };

async function freshStore() {
  process.env.DATABASE_URL = URL;
  const store = await createStore();
  assert.equal(store.kind, 'postgres', 'did not connect to Postgres');
  return store;
}

test('the Postgres backend creates its table and records a game', opts, async () => {
  const store = await freshStore();
  const tag = `pg-${Date.now()}`;

  await store.recordGame([
    { deviceId: `${tag}-a`, name: 'Ben', score: 120, won: true, rounds: 9, exactBids: 6, busts: 2, tricks: 14 },
    { deviceId: `${tag}-b`, name: 'Dana', score: 90, won: false, rounds: 9, exactBids: 3, busts: 4, tricks: 11 },
  ]);

  const a = await store.player(`${tag}-a`);
  assert.ok(a, 'player row missing after recordGame');
  assert.equal(a.games, 1);
  assert.equal(a.wins, 1);
  assert.equal(a.bestScore, 120);
  assert.equal(a.tricks, 14);
  await store.close();
  delete process.env.DATABASE_URL;
});

test('Postgres accumulates across games exactly like the file backend', opts, async () => {
  const store = await freshStore();
  const tag = `pg-acc-${Date.now()}`;

  await store.recordGame([
    { deviceId: `${tag}-a`, name: 'Ben', score: 120, won: true, rounds: 9, exactBids: 6, busts: 2, tricks: 14 },
  ]);
  await store.recordGame([
    { deviceId: `${tag}-a`, name: 'Ben Renamed', score: 80, won: false, rounds: 9, exactBids: 3, busts: 3, tricks: 9 },
  ]);

  const a = await store.player(`${tag}-a`);
  assert.equal(a.games, 2);
  assert.equal(a.wins, 1);
  assert.equal(a.totalScore, 200);
  assert.equal(a.avgScore, 100);
  assert.equal(a.bestScore, 120, 'bestScore must be the max, not the latest');
  assert.equal(a.rounds, 18);
  assert.equal(a.exactBids, 9);
  assert.equal(a.tricks, 23);
  assert.equal(a.accuracy, 0.5);
  assert.equal(a.name, 'Ben Renamed', 'display name should follow the latest game');

  await store.close();
  delete process.env.DATABASE_URL;
});

test('a lower score in a later game does not lower bestScore', opts, async () => {
  const store = await freshStore();
  const tag = `pg-best-${Date.now()}`;
  await store.recordGame([{ deviceId: `${tag}-a`, name: 'X', score: 200, won: true, rounds: 9 }]);
  await store.recordGame([{ deviceId: `${tag}-a`, name: 'X', score: 10, won: false, rounds: 9 }]);
  const a = await store.player(`${tag}-a`);
  assert.equal(a.bestScore, 200);
  await store.close();
  delete process.env.DATABASE_URL;
});

test('players with no device id are skipped without failing the transaction', opts, async () => {
  const store = await freshStore();
  const tag = `pg-skip-${Date.now()}`;
  await store.recordGame([
    { deviceId: null, name: 'Ghost', score: 50, won: true, rounds: 9 },
    { deviceId: `${tag}-real`, name: 'Real', score: 60, won: false, rounds: 9 },
  ]);
  const real = await store.player(`${tag}-real`);
  assert.ok(real, 'the valid player was lost when an invalid one was in the batch');
  assert.equal(real.games, 1);
  await store.close();
  delete process.env.DATABASE_URL;
});

test('the leaderboard ranks by wins then average score', opts, async () => {
  const store = await freshStore();
  const tag = `pg-rank-${Date.now()}`;
  await store.recordGame([{ deviceId: `${tag}-lo`, name: 'Lo', score: 50, won: false, rounds: 9 }]);
  await store.recordGame([{ deviceId: `${tag}-hi`, name: 'Hi', score: 300, won: true, rounds: 9 }]);

  // Rank via player(), which scans the whole table. leaderboard() only returns
  // the top N, and this database accumulates rows across runs — so asking
  // "are both in the top 100?" would be a flaky, history-dependent question.
  const hi = await store.player(`${tag}-hi`);
  const lo = await store.player(`${tag}-lo`);
  assert.ok(hi && lo, 'both players should have a record');
  assert.ok(hi.rank < lo.rank, 'the winner should outrank the loser');
  assert.ok(hi.rank >= 1 && hi.rank <= hi.of);

  // The leaderboard itself is capped and ordered.
  const board = await store.leaderboard(5);
  assert.ok(board.length <= 5, 'leaderboard ignored its limit');
  for (let i = 1; i < board.length; i++) {
    assert.ok(board[i - 1].wins >= board[i].wins, 'leaderboard is not sorted by wins');
  }
  await store.close();
  delete process.env.DATABASE_URL;
});

/**
 * The deployment configuration end to end: boot the real server with
 * DATABASE_URL set, play a full game through websockets, and confirm the
 * result lands in Postgres and comes back on the leaderboard.
 */
test('a full game played against a live server persists to Postgres', opts, async (t) => {
  const { spawn } = await import('node:child_process');
  const { WebSocket } = await import('ws');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const PORT = 36900 + Math.floor(Math.random() * 300);

  const server = spawn(process.execPath, [path.join(here, 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_URL: URL,
      DBRIDGE_BID_MS: '200', DBRIDGE_REVEAL_MS: '20', DBRIDGE_PLAY_MS: '200', DBRIDGE_TRICK_MS: '20',
      DBRIDGE_ROUND_MS: '40', DBRIDGE_BOT_MS: '10', DBRIDGE_TICK_MS: '8',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => server.kill());

  let usingPg = false;
  const booted = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 15000);
    server.stdout.on('data', (d) => {
      const s = d.toString();
      if (s.includes('using Postgres')) usingPg = true;
      if (s.includes('listening')) { clearTimeout(timer); resolve(); }
    });
    server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  });
  await booted;
  assert.ok(usingPg, 'server did not pick up DATABASE_URL');

  const tag = `e2e-${Date.now()}`;
  const socks = [];
  for (let i = 0; i < 5; i++) {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const s = { ws, state: null, code: null, board: null };
    await new Promise((r) => ws.on('open', r));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === 'joined') s.code = m.code;
      if (m.t === 'state') s.state = m.game;
      if (m.t === 'leaderboard') s.board = m;
    });
    socks.push(s);
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const send = (s, m) => s.ws.send(JSON.stringify(m));

  send(socks[0], { t: 'createRoom', name: 'Ben', private: true, deviceId: `${tag}-0` });
  await wait(300);
  const code = socks[0].code;
  for (let i = 1; i < 5; i++) {
    send(socks[i], { t: 'joinRoom', code, name: `P${i}`, deviceId: `${tag}-${i}` });
    await wait(70);
  }
  await wait(250);
  send(socks[0], { t: 'start' });

  const done = await new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (socks.every((s) => s.state && s.state.status === 'finished')) { clearInterval(iv); resolve(true); }
      else if (Date.now() - t0 > 120000) { clearInterval(iv); resolve(false); }
    }, 150);
  });
  assert.ok(done, 'game did not finish');
  await wait(800);

  send(socks[0], { t: 'leaderboard', deviceId: `${tag}-0` });
  await wait(600);
  assert.ok(socks[0].board, 'no leaderboard came back');
  assert.ok(socks[0].board.mine, 'my Postgres-backed record is missing');
  assert.equal(socks[0].board.mine.games, 1);

  // Confirm it is genuinely in the database, not a cache.
  process.env.DATABASE_URL = URL;
  const store = await createStore();
  assert.equal(store.kind, 'postgres');
  const row = await store.player(`${tag}-0`);
  assert.ok(row, 'the game was never written to Postgres');
  assert.equal(row.games, 1);
  assert.ok(row.rounds === 19, `expected a 19-round five-player game, got ${row.rounds}`);
  await store.close();
  delete process.env.DATABASE_URL;

  socks.forEach((s) => s.ws.close());
  await wait(200);
});

test('an unreachable DATABASE_URL falls back to the file store instead of crashing', async () => {
  process.env.DATABASE_URL = 'postgresql://nobody:nope@127.0.0.1:1/nothing';
  const store = await createStore({ dir: '/tmp/dbridge-fallback-test' });
  assert.equal(store.kind, 'file', 'a dead database should degrade to the file backend, not take the server down');
  await store.close();
  delete process.env.DATABASE_URL;
});
