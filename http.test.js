/**
 * Everything in this project sits in one flat directory, so the server source
 * is a sibling of the browser files. Static serving is therefore an explicit
 * allowlist, not a directory. This test is what keeps that honest: it boots
 * the real server and proves the browser can fetch the page and nothing else.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 37200 + Math.floor(Math.random() * 400);
const base = `http://127.0.0.1:${PORT}`;

let server;

test.before(async () => {
  server = spawn(process.execPath, [path.join(here, 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: 'production',
      DBRIDGE_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'dbridge-http-')),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 10000);
    server.stdout.on('data', (d) => {
      if (d.toString().includes('listening')) { clearTimeout(t); resolve(); }
    });
    server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  });
});

test.after(() => { if (server) server.kill(); });

test('the pages a player needs are served', async () => {
  for (const p of ['/', '/index.html', '/app.js', '/style.css', '/practice.html', '/healthz']) {
    const res = await fetch(base + p);
    assert.equal(res.status, 200, `${p} should be reachable`);
  }
  const home = await (await fetch(base + '/')).text();
  assert.match(home, /Diminishing Bridge/, 'the landing page did not render');

  const practice = await (await fetch(base + '/practice.html')).text();
  assert.match(practice, /Practice against bots/, 'practice mode is missing from the deploy');
});

test('server source and config are NOT reachable over the web', async () => {
  const mustNotServe = [
    '/server.js', '/game.js', '/engine.js', '/rooms.js', '/store.js',
    '/build-practice.mjs', '/game.test.js', '/http.test.js',
    '/package.json', '/package-lock.json', '/render.yaml', '/Dockerfile',
    '/README.md', '/DEPLOY.md', '/.gitignore', '/.env',
  ];
  for (const p of mustNotServe) {
    const res = await fetch(base + p);
    assert.notEqual(res.status, 200, `${p} MUST NOT be downloadable`);
  }
});

test('path traversal cannot escape the allowlist', async () => {
  const attempts = [
    '/../package.json',
    '/..%2Fpackage.json',
    '/%2e%2e/server.js',
    '/app.js/../game.js',
    '/./game.js',
    '/data/standings.json',
    '/node_modules/express/package.json',
  ];
  for (const p of attempts) {
    const res = await fetch(base + p).catch(() => ({ status: 0 }));
    assert.notEqual(res.status, 200, `${p} MUST NOT be downloadable`);
  }
});

test('the leaderboard endpoint answers and leaks no device ids', async () => {
  const res = await fetch(base + '/api/leaderboard');
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(!body.includes('deviceId'), 'device ids must never be public');
  assert.doesNotThrow(() => JSON.parse(body), 'leaderboard must be valid JSON');
});

test('a websocket table can be created against the deployed server', async () => {
  const { WebSocket } = await import('ws');
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const code = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no response from the socket')), 8000);
    ws.on('open', () => ws.send(JSON.stringify({
      t: 'createRoom', name: 'Smoke', private: true, deviceId: 'smoke-abcdefgh',
    })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === 'joined') { clearTimeout(t); resolve(m.code); }
    });
    ws.on('error', reject);
  });
  assert.match(code, /^[A-Z0-9]{4}$/, 'expected a four-character table code');
  ws.close();
});

/**
 * A free host with no disk keeps standings only until it next sleeps. The
 * server has to say which of the two it is doing, because from the outside the
 * difference is invisible right up until a fortnight of records disappears.
 */
test('the health check reports how standings are stored', async () => {
  const res = await fetch(base + '/healthz');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(['file', 'postgres'].includes(body.standings), `unknown backend ${body.standings}`);
  assert.equal(body.durable, body.standings === 'postgres',
    'durable must mean exactly "a database is attached"');
});

test('with no DATABASE_URL the server admits standings are not durable', async () => {
  const env = { ...process.env, PORT: String(PORT + 1), NODE_ENV: 'production',
    DBRIDGE_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'dbridge-nodb-')) };
  delete env.DATABASE_URL;
  const child = spawn(process.execPath, [path.join(here, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('server did not start')), 10000);
      child.stdout.on('data', (d) => d.toString().includes('listening') && (clearTimeout(t), resolve()));
    });
    const body = await (await fetch(`http://127.0.0.1:${PORT + 1}/healthz`)).json();
    assert.deepEqual(body, { ok: true, standings: 'file', durable: false });

    // The browser learns the same thing on connect, so it can warn the player.
    const { WebSocket } = await import('ws');
    const ws = new WebSocket(`ws://127.0.0.1:${PORT + 1}/ws`);
    const hello = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no hello')), 8000);
      ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.t === 'hello') { clearTimeout(t); resolve(m); }
      });
      ws.on('error', reject);
    });
    assert.deepEqual(hello.standings, { backend: 'file', durable: false });
    ws.close();
  } finally { child.kill(); }
});
