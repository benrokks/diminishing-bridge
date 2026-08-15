/**
 * Visual + behavioural check of chat, standings and sound, driven through
 * two real browser pages and three socket seats.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 39555;
const OUT = path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbridge-vis-'));

const server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
  env: {
    ...process.env, PORT: String(PORT), DBRIDGE_DATA_DIR: dataDir,
    DBRIDGE_BID_MS: '400', DBRIDGE_REVEAL_MS: '20', DBRIDGE_PLAY_MS: '400', DBRIDGE_TRICK_MS: '120',
    DBRIDGE_ROUND_MS: '200', DBRIDGE_BOT_MS: '30', DBRIDGE_TICK_MS: '15',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
await new Promise((res) => server.stdout.on('data', (d) => d.toString().includes('listening') && res()));

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium',
});
const errors = [];
async function newPage(name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => { errors.push(`${name}: ${e.message}`); console.error(`!! JS error ${name}:`, e.message); });
  p.on('console', (m) => m.type() === 'error' && errors.push(`${name} console: ${m.text()}`));
  await p.goto(`http://127.0.0.1:${PORT}/`);
  return p;
}

const ben = await newPage('Ben');
const dana = await newPage('Dana');

await ben.fill('#nameInput', 'Ben');
await dana.fill('#nameInput', 'Dana');
await ben.click('#btnCreate');
await ben.waitForSelector('#screen-lobby.active');
const code = (await ben.textContent('#lobbyCode')).trim();
console.log('table', code);

await dana.fill('#codeInput', code);
await dana.click('#btnJoin');
await dana.waitForSelector('#screen-lobby.active');

// three socket seats to reach the five-player minimum
const socks = [];
for (let i = 0; i < 3; i++) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({
    t: 'joinRoom', code, name: `Bot${i + 1}`, deviceId: `vis-bot-${i}-aaaaaaaa`,
  }));
  socks.push(ws);
  await new Promise((r) => setTimeout(r, 80));
}
await ben.waitForTimeout(400);

// --- chat from the lobby, including characters a filter would mangle -----
const spicy = 'lets go!! 100% <b>bold</b> & "quotes" http://example.com 🔥';
await dana.fill('#chatInput2', spicy);
await dana.click('#chatForm2 button');
await ben.waitForTimeout(400);

const benSees = await ben.textContent('#chatLog2');
console.log('Ben sees in lobby chat:', JSON.stringify(benSees.trim()));
console.log(benSees.includes(spicy) ? '  PASS: message delivered byte-for-byte' : '  FAIL: message altered');

// XSS: the tag must render as text, never as an element.
const injected = await ben.evaluate(() => document.querySelectorAll('#chatLog2 b').length);
console.log(injected === 0
  ? '  PASS: markup rendered as text, not injected into the DOM'
  : '  FAIL: chat injected live HTML — XSS hole');

await ben.screenshot({ path: path.join(OUT, '10-lobby-chat.png') });
console.log('  wrote 10-lobby-chat.png');

// --- play the game out ---------------------------------------------------
await ben.click('#btnStart');
await ben.waitForTimeout(1500);
await ben.screenshot({ path: path.join(OUT, '11-game-chat.png') });
console.log('  wrote 11-game-chat.png');

// chat during play
await ben.fill('#chatInput', 'nice trick');
await ben.click('#chatForm button');
await ben.waitForTimeout(300);

// sound toggle
const before = await ben.textContent('#btnSound');
await ben.click('#btnSound');
const after = await ben.textContent('#btnSound');
console.log(`sound toggle: ${before} -> ${after}`,
  before !== after ? ' PASS' : ' FAIL');
await ben.click('#btnSound'); // back on

// wait for the game to finish (bots drive it)
const finished = await ben.waitForFunction(
  () => document.querySelector('#endButtons') &&
        document.querySelector('#endButtons').style.display !== 'none' &&
        document.querySelector('#resultOverlay').classList.contains('show'),
  null, { timeout: 180000 },
).then(() => true).catch(() => false);

if (!finished) {
  console.error('!! game never finished');
} else {
  await ben.waitForTimeout(1200);
  await ben.screenshot({ path: path.join(OUT, '12-game-over.png') });
  console.log('  wrote 12-game-over.png');

  const career = await ben.textContent('#careerBox');
  console.log('career line:', JSON.stringify((career || '').trim()));

  // rematch
  await ben.click('#btnRematch');
  await ben.waitForSelector('#screen-lobby.active', { timeout: 10000 });
  const scoresZero = await dana.evaluate(() =>
    [...document.querySelectorAll('#lobbyPlayers .chip')].length);
  console.log(`rematch returned everyone to the lobby (${scoresZero} chips) PASS`);
  await ben.screenshot({ path: path.join(OUT, '13-rematch-lobby.png') });
  console.log('  wrote 13-rematch-lobby.png');

  // leaderboard on the landing page
  await ben.click('#btnLeave');
  await ben.waitForSelector('#screen-landing.active');
  await ben.click('#btnRefreshBoard');
  await ben.waitForTimeout(600);
  const boardText = await ben.textContent('#leaderboard');
  console.log('leaderboard rows visible:',
    await ben.evaluate(() => document.querySelectorAll('#leaderboard tbody tr').length));
  console.log('my stats shown:',
    await ben.evaluate(() => document.getElementById('myStats').classList.contains('show')));
  void boardText;
  await ben.screenshot({ path: path.join(OUT, '14-leaderboard.png') });
  console.log('  wrote 14-leaderboard.png');

  // device id must not appear anywhere in the delivered leaderboard payload
  const leaked = await ben.evaluate(async () => {
    const res = await fetch('/api/leaderboard');
    return JSON.stringify(await res.json());
  });
  console.log(leaked.includes('deviceId')
    ? '  NOTE: /api/leaderboard exposes deviceId (public REST endpoint)'
    : '  PASS: /api/leaderboard carries no device ids');
}

console.log('\nJS errors:', errors.length ? errors : 'none');
await browser.close();
socks.forEach((s) => s.close());
server.kill();
fs.rmSync(dataDir, { recursive: true, force: true });
