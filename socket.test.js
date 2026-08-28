/**
 * End-to-end over real WebSockets: boots the actual server, connects ten
 * independent clients, and plays a complete game through the wire protocol.
 * This is the test that proves a player's device never receives another
 * player's cards.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 34567 + Math.floor(Math.random() * 500);

function startServer() {
  // DBRIDGE_DATA_DIR below asks for an isolated standings store; a stray
  // DATABASE_URL in the shell would quietly override it with a shared one.
  const env = { ...process.env };
  delete env.DATABASE_URL;
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: {
      ...env,
      PORT: String(PORT),
      DBRIDGE_BID_MS: '8000', DBRIDGE_REVEAL_MS: '20', DBRIDGE_AUTOPLAY_MS: '20',
      DBRIDGE_PLAY_MS: '8000',
      DBRIDGE_TRICK_MS: '30',
      DBRIDGE_ROUND_MS: '60',
      DBRIDGE_BOT_MS: '600000', // bots never take over; these are all "real" players
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 8000);
    child.stdout.on('data', (d) => {
      if (d.toString().includes('listening')) { clearTimeout(t); resolve(child); }
    });
    child.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
    child.on('exit', (code) => { clearTimeout(t); reject(new Error('server exited ' + code)); });
  });
}

class Client {
  constructor(name) {
    this.name = name;
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    this.state = null;
    this.room = null;
    this.id = null;
    this.code = null;
    this.errors = [];
    this.leaks = [];
    this.sawBlindRound = false;
    this.sentThisTurn = new Set();
    this.ready = new Promise((res) => { this._res = res; });

    this.ws.on('open', () => this._res());
    this.ws.on('message', (raw) => this.onMessage(JSON.parse(raw.toString())));
  }

  send(m) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); }

  onMessage(m) {
    if (m.t === 'error') { this.errors.push(m.msg); return; }
    if (m.t === 'joined') { this.id = m.playerId; this.code = m.code; return; }
    if (m.t !== 'state') return;

    this.room = m.room;
    this.state = m.game;
    this.audit();
    this.act();
  }

  /** Nothing the server sends me may reveal another player's cards. */
  audit() {
    const s = this.state;
    if (!s || !s.round) return;
    const blind = s.round.blind;
    if (blind) this.sawBlindRound = true;

    for (const p of s.players) {
      if (p.id === this.id) continue;
      if (!blind && p.visibleHand !== null) {
        this.leaks.push(`saw ${p.name}'s hand in a normal round`);
      }
      if (blind && (!Array.isArray(p.visibleHand) || p.visibleHand.length > 1)) {
        this.leaks.push(`blind round: bad visibleHand for ${p.name}`);
      }
      if (!s.round.bidsRevealed && p.bid !== null) {
        this.leaks.push(`saw ${p.name}'s bid before the reveal`);
      }
    }
    if (blind && s.yourHand !== null) this.leaks.push('saw my own card during the blind round');
    if (!blind && s.yourHand === null && s.status === 'playing') {
      this.leaks.push('did not receive my own hand');
    }
    // The raw payload must not contain a hand array for anyone else.
    for (const p of s.players) {
      if (p.id !== this.id && p.hand !== undefined) this.leaks.push('raw hand field present');
    }
  }

  act() {
    const s = this.state;
    if (!s || s.status !== 'playing' || !s.round) return;
    const r = s.round;

    if (r.phase === 'bidding' && s.yourBid === null) {
      const key = `bid-${s.roundIndex}`;
      if (this.sentThisTurn.has(key)) return;
      this.sentThisTurn.add(key);
      this.send({ t: 'bid', n: Math.floor(Math.random() * (r.maxBid + 1)) });
      return;
    }

    if (r.phase === 'playing' && s.you && r.currentSeat === s.you.seat) {
      const key = `play-${s.roundIndex}-${r.trickNumber}-${r.trick.length}`;
      if (this.sentThisTurn.has(key)) return;
      this.sentThisTurn.add(key);
      const legal = s.legal || [];
      if (!legal.length) return;
      this.send({ t: 'play', card: legal[Math.floor(Math.random() * legal.length)] });
    }
  }

  close() { try { this.ws.close(); } catch { /* already gone */ } }
}

test('ten clients play a full game over websockets with no information leaks', async (t) => {
  const server = await startServer();
  t.after(() => server.kill());

  const clients = [];
  for (let i = 0; i < 10; i++) clients.push(new Client(`P${i + 1}`));
  await Promise.all(clients.map((c) => c.ready));

  clients[0].send({ t: 'createRoom', name: clients[0].name, private: false });
  await new Promise((r) => setTimeout(r, 300));
  const code = clients[0].code;
  assert.ok(code, 'host never received a room code');

  for (let i = 1; i < 10; i++) {
    clients[i].send({ t: 'joinRoom', code, name: clients[i].name });
    await new Promise((r) => setTimeout(r, 60));
  }
  await new Promise((r) => setTimeout(r, 300));

  assert.equal(clients[0].state.players.length, 10, 'not everyone got seated');
  assert.equal(clients[0].room.canStart, true);

  clients[0].send({ t: 'start' });

  // Wait for the game to finish.
  const finished = await new Promise((resolve) => {
    const started = Date.now();
    const iv = setInterval(() => {
      if (clients.every((c) => c.state && c.state.status === 'finished')) {
        clearInterval(iv); resolve(true);
      } else if (Date.now() - started > 90000) {
        clearInterval(iv); resolve(false);
      }
    }, 100);
  });

  assert.ok(finished, 'game did not finish within 90s');

  for (const c of clients) {
    assert.deepEqual(c.leaks, [], `${c.name} leaks: ${c.leaks.slice(0, 3).join(' | ')}`);
    assert.deepEqual(c.errors, [], `${c.name} errors: ${c.errors.slice(0, 3).join(' | ')}`);
    assert.ok(c.sawBlindRound, `${c.name} never played the blind single-card round`);
  }

  // Everyone must agree on the final table.
  const canonical = clients[0].state.players
    .slice().sort((a, b) => a.seat - b.seat).map((p) => `${p.name}:${p.score}`).join(',');
  for (const c of clients) {
    const mine = c.state.players.slice().sort((a, b) => a.seat - b.seat)
      .map((p) => `${p.name}:${p.score}`).join(',');
    assert.equal(mine, canonical, `${c.name} disagrees on the final scores`);
  }

  // A 10-player game is the 5,4,3,2,1,2,3,4,5 ladder.
  assert.deepEqual(clients[0].state.schedule, [5, 4, 3, 2, 1, 2, 3, 4, 5]);
  assert.equal(clients[0].state.roundIndex, 8);

  clients.forEach((c) => c.close());
  await new Promise((r) => setTimeout(r, 200));
});

test('the public lobby lists open tables and hides private ones', async (t) => {
  const server = await startServer();
  t.after(() => server.kill());

  const host = new Client('Host');
  const secret = new Client('Secret');
  const browser = new Client('Browser');
  await Promise.all([host.ready, secret.ready, browser.ready]);

  host.send({ t: 'createRoom', name: 'Host', private: false });
  secret.send({ t: 'createRoom', name: 'Secret', private: true });
  await new Promise((r) => setTimeout(r, 300));

  const rooms = await new Promise((resolve) => {
    browser.ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === 'rooms') resolve(m.rooms);
    });
    browser.send({ t: 'watchLobby' });
  });

  const codes = rooms.map((r) => r.code);
  assert.ok(codes.includes(host.code), 'public table missing from the lobby');
  assert.ok(!codes.includes(secret.code), 'private table was listed publicly');

  // A private table is still reachable with its code.
  browser.send({ t: 'joinRoom', code: secret.code, name: 'Browser' });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(browser.code, secret.code, 'could not join the private table by code');
  assert.deepEqual(browser.errors, []);

  [host, secret, browser].forEach((c) => c.close());
  await new Promise((r) => setTimeout(r, 200));
});

test('a table cannot start below five players and rejects joins once full', async (t) => {
  const server = await startServer();
  t.after(() => server.kill());

  const cs = [];
  for (let i = 0; i < 11; i++) cs.push(new Client(`Q${i}`));
  await Promise.all(cs.map((c) => c.ready));

  cs[0].send({ t: 'createRoom', name: 'Q0', private: true });
  await new Promise((r) => setTimeout(r, 250));
  const code = cs[0].code;

  cs[0].send({ t: 'start' });
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(cs[0].errors.some((e) => /needs 5 seats/.test(e)), 'one-player start was allowed');

  for (let i = 1; i < 11; i++) {
    cs[i].send({ t: 'joinRoom', code, name: `Q${i}` });
    await new Promise((r) => setTimeout(r, 60));
  }
  await new Promise((r) => setTimeout(r, 300));

  assert.equal(cs[0].state.players.length, 10, 'table exceeded ten players');
  assert.ok(cs[10].errors.some((e) => /full/.test(e)), 'eleventh player was not turned away');

  // Non-host cannot start.
  cs[3].send({ t: 'start' });
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(cs[3].errors.some((e) => /host/.test(e)), 'a non-host started the game');

  cs.forEach((c) => c.close());
  await new Promise((r) => setTimeout(r, 200));
});
