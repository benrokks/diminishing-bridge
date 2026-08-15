/**
 * server.js — HTTP + WebSocket entry point.
 *
 * One port serves both the browser client and the game socket, which is what
 * free hosts (Render, Railway, Fly) expect.
 *
 * Everything in this project lives in one flat directory on purpose: uploading
 * folders through the GitHub website silently flattens them on some browsers,
 * which breaks a nested layout. Flat means a plain drag of every file always
 * produces a working deploy.
 *
 * Because server source sits beside the browser files, static serving is an
 * explicit allowlist rather than express.static on the directory — otherwise
 * anyone could fetch game.js, store.js, or package.json over the web.
 */

import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RoomManager, sanitizeName } from './rooms.js';
import { MIN_PLAYERS, MAX_PLAYERS } from './engine.js';
import { createStore } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.set('trust proxy', 1);

/**
 * The only files the browser may ever fetch. Anything not on this list — the
 * game engine, the standings store, package.json — is simply not routed, so
 * it cannot leak no matter what else ends up in this folder.
 */
const CLIENT_FILES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/app.js': 'app.js',
  '/style.css': 'style.css',
  '/practice.html': 'practice.html',
};

for (const [route, file] of Object.entries(CLIENT_FILES)) {
  app.get(route, (_req, res) => {
    res.sendFile(path.join(__dirname, file), {
      maxAge: route === '/' || route === '/index.html' ? 0 : '1h',
    }, (err) => {
      if (err && !res.headersSent) res.status(404).type('text').send('Not found');
    });
  });
}

app.get('/healthz', (_req, res) => res.type('text').send('ok'));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

const store = await createStore();
const manager = new RoomManager(store);

app.get('/api/leaderboard', async (_req, res) => {
  try {
    const rows = await store.leaderboard(25);
    // Same rule as the websocket path: device ids are credentials, never public.
    res.json(rows.map(({ deviceId, ...pub }) => pub));
  } catch { res.status(500).json([]); }
});

// Every socket that is sitting on the landing page and wants lobby updates
const lobbyWatchers = new Set();

function send(ws, msg) {
  if (ws.readyState === 1) {
    try { ws.send(JSON.stringify(msg)); } catch { /* closed */ }
  }
}

function fail(ws, msg) { send(ws, { t: 'error', msg }); }

function pushLobby() {
  const list = manager.publicList();
  for (const ws of lobbyWatchers) send(ws, { t: 'rooms', rooms: list });
}
setInterval(pushLobby, 3000);

function leaveCurrentRoom(ws) {
  if (!ws.roomCode) return;
  const room = manager.get(ws.roomCode);
  if (room && ws.playerId) room.detach(ws.playerId);
  ws.roomCode = null;
  ws.playerId = null;
}

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress || 'unknown';
  ws.token = randomUUID();
  ws.roomCode = null;
  ws.playerId = null;
  // Token bucket: burst of 20, refilling 12/sec. Tolerates fast legitimate
  // clicking (reorder then play) while still stopping a flood.
  ws.tokens = 20;
  ws.lastRefill = Date.now();

  ws.on('pong', () => { ws.isAlive = true; });

  send(ws, { t: 'hello', limits: { min: MIN_PLAYERS, max: MAX_PLAYERS } });

  ws.on('message', (raw) => {
    const now = Date.now();
    ws.tokens = Math.min(20, ws.tokens + ((now - ws.lastRefill) / 1000) * 12);
    ws.lastRefill = now;
    if (ws.tokens < 1) return fail(ws, 'Slow down');
    ws.tokens -= 1;

    let m;
    try { m = JSON.parse(raw.toString()); } catch { return fail(ws, 'Bad message'); }
    if (!m || typeof m.t !== 'string') return;

    try {
      handle(ws, m);
    } catch (err) {
      fail(ws, err.message || 'Something went wrong');
    }
  });

  ws.on('close', () => {
    lobbyWatchers.delete(ws);
    leaveCurrentRoom(ws);
  });
  ws.on('error', () => { /* ignore; close will follow */ });
});

/** A stable per-browser id. Not a login — it just keeps career stats attached
 *  to the right device no matter what nickname someone types. */
function cleanDeviceId(raw) {
  const s = String(raw || '').trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(s) ? s : null;
}

function joinRoom(ws, room, name, deviceId) {
  if (room.game.status !== 'lobby') throw new Error('That game has already started');
  if (room.isFull) throw new Error('That table is full');
  leaveCurrentRoom(ws);
  const playerId = randomUUID();
  ws.deviceId = cleanDeviceId(deviceId) || ws.deviceId || null;
  room.game.addPlayer({
    id: playerId,
    name: sanitizeName(name),
    token: ws.token,
    deviceId: ws.deviceId,
  });
  if (!room.hostId) room.hostId = playerId;
  ws.roomCode = room.code;
  ws.playerId = playerId;
  lobbyWatchers.delete(ws);
  room.attach(playerId, ws);
  send(ws, { t: 'joined', code: room.code, playerId });
  room.broadcast();
  pushLobby();
}

function handle(ws, m) {
  switch (m.t) {
    case 'watchLobby': {
      lobbyWatchers.add(ws);
      send(ws, { t: 'rooms', rooms: manager.publicList() });
      return;
    }

    case 'createRoom': {
      const room = manager.create({ isPrivate: !!m.private, ip: ws.ip });
      joinRoom(ws, room, m.name, m.deviceId);
      return;
    }

    case 'joinRoom': {
      const room = manager.get(m.code);
      if (!room) throw new Error('No table with that code');
      joinRoom(ws, room, m.name, m.deviceId);
      return;
    }

    case 'quickPlay': {
      const room = manager.quickPlay(ws.ip);
      joinRoom(ws, room, m.name, m.deviceId);
      return;
    }

    case 'leaderboard': {
      const device = cleanDeviceId(m.deviceId);
      Promise.all([store.leaderboard(25), device ? store.player(device) : null])
        .then(([rows, mine]) => send(ws, {
          t: 'leaderboard',
          // A device id is the ONLY thing that identifies a player's record,
          // and it is client-supplied, so it must never be broadcast — anyone
          // who learned yours could claim your standings. Strip it and mark
          // the viewer's own row with a flag instead.
          rows: rows.map((r) => ({ ...r, deviceId: undefined, isMe: !!device && r.deviceId === device })),
          mine: mine ? { ...mine, deviceId: undefined } : null,
        }))
        .catch(() => send(ws, { t: 'leaderboard', rows: [], mine: null }));
      return;
    }

    case 'leaveRoom': {
      leaveCurrentRoom(ws);
      send(ws, { t: 'left' });
      lobbyWatchers.add(ws);
      send(ws, { t: 'rooms', rooms: manager.publicList() });
      pushLobby();
      return;
    }

    default: {
      // Everything below requires being seated at a table.
      const room = manager.get(ws.roomCode);
      if (!room || !ws.playerId) throw new Error('You are not at a table');

      switch (m.t) {
        case 'start':
          if (room.hostId !== ws.playerId) throw new Error('Only the host can start');
          room.game.start();
          pushLobby();
          return;

        case 'bid':
          room.game.submitBid(ws.playerId, Number(m.n));
          return;

        case 'play':
          room.game.playCard(ws.playerId, String(m.card));
          return;

        case 'reorder':
          if (Array.isArray(m.order)) room.game.setOrder(ws.playerId, m.order.map(String));
          return;

        case 'reclaim':
          room.game.reclaim(ws.playerId);
          return;

        case 'chat':
          room.postChat(ws.playerId, m.text);
          return;

        case 'rematch':
          room.rematch(ws.playerId);
          pushLobby();
          return;

        case 'ping':
          send(ws, { t: 'pong' });
          return;

        default:
          return;
      }
    }
  }
}

// Drop sockets that stop responding, so seats free up and rooms can be swept.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`Card table listening on http://localhost:${PORT}`);
});
