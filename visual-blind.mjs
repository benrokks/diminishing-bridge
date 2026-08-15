/**
 * Screenshots the blind single-card round, which is the hardest state to reach
 * by hand. One real browser page plus nine socket clients; the server's bot
 * takeover drives play forward until the one-card round arrives.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 39412;
const OUT = path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });

const server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
  env: {
    ...process.env, PORT: String(PORT),
    DBRIDGE_BID_MS: '250', DBRIDGE_REVEAL_MS: '20', DBRIDGE_PLAY_MS: '250',
    DBRIDGE_TRICK_MS: '150', DBRIDGE_ROUND_MS: '250', DBRIDGE_BOT_MS: '40',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
await new Promise((res) => server.stdout.on('data', (d) => d.toString().includes('listening') && res()));

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium',
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.error('!! JS error:', e.message));
page.on('console', (m) => m.type() === 'error' && console.error('!! console:', m.text()));

await page.goto(`http://127.0.0.1:${PORT}/`);
await page.fill('#nameInput', 'Ben');
await page.click('#btnCreate');
await page.waitForSelector('#screen-lobby.active');
const code = (await page.textContent('#lobbyCode')).trim();
console.log('table', code);

// Nine passive sockets. They join and then do nothing; the server bots them.
const bots = [];
for (let i = 0; i < 9; i++) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ t: 'joinRoom', code, name: `Bot${i + 1}` }));
  bots.push(ws);
  await new Promise((r) => setTimeout(r, 60));
}
await page.waitForTimeout(400);
await page.click('#btnStart');
console.log('started; waiting for the one-card round…');

// Poll the DOM for the blind round.
const reached = await page.waitForFunction(() => {
  const lbl = document.getElementById('handLabel');
  return lbl && lbl.textContent.includes('hidden from you');
}, null, { timeout: 120000 }).then(() => true).catch(() => false);

if (!reached) {
  console.error('!! never reached the blind round');
} else {
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, '09-blind-round.png') });
  console.log('  wrote 09-blind-round.png');

  const audit = await page.evaluate(() => {
    const seats = [...document.querySelectorAll('#seats .seat')];
    const faceUpOnSeats = document.querySelectorAll('#seats .card:not(.back)').length;
    const myBack = document.querySelectorAll('#hand .card.back').length;
    const myFaceUp = document.querySelectorAll('#hand .card:not(.back)').length;
    return { seatCount: seats.length, faceUpOnSeats, myBack, myFaceUp };
  });
  console.log('blind-round DOM audit:', audit);
  console.log(audit.faceUpOnSeats === 9 && audit.myBack === 1 && audit.myFaceUp === 0
    ? '  PASS: nine opponents face up, my own card face down'
    : '  FAIL: blind round rendering is wrong');
}

await browser.close();
bots.forEach((b) => b.close());
server.kill();
