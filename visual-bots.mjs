/**
 * Two real browsers, no other people: fill the table with bots from the lobby
 * UI and start a game. This is the exact situation Ben hit on the live site.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const PORT = 39777;

const server = spawn(process.execPath, [path.join(here, 'server.js')], {
  env: {
    ...process.env, PORT: String(PORT),
    DBRIDGE_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'dbridge-vb-')),
    DBRIDGE_BID_MS: '60000', DBRIDGE_REVEAL_MS: '2000', DBRIDGE_AUTOPLAY_MS: '20', DBRIDGE_PLAY_MS: '60000',
    DBRIDGE_TRICK_MS: '1200', DBRIDGE_ROUND_MS: '2000', DBRIDGE_BOT_MS: '500',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
await new Promise((r) => server.stdout.on('data', (d) => d.toString().includes('listening') && r()));

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium',
});
const errors = [];
async function page(name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => { errors.push(`${name}: ${e.message}`); console.error('!! JS error', name, e.message); });
  p.on('console', (m) => m.type() === 'error' && errors.push(`${name}: ${m.text()}`));
  await p.goto(`http://127.0.0.1:${PORT}/`);
  return p;
}

const ben = await page('Ben');
const dana = await page('Dana');

await ben.fill('#nameInput', 'Ben');
await ben.click('#btnCreate');
await ben.waitForSelector('#screen-lobby.active');
const code = (await ben.textContent('#lobbyCode')).trim();
console.log('table', code);

await dana.fill('#nameInput', 'Dana');
await dana.fill('#codeInput', code);
await dana.click('#btnJoin');
await dana.waitForSelector('#screen-lobby.active');
await ben.waitForTimeout(400);

// --- the situation Ben hit: two people, start disabled -------------------
const before = await ben.evaluate(() => ({
  startDisabled: document.getElementById('btnStart').disabled,
  startLabel: document.getElementById('btnStart').textContent.trim(),
  status: document.getElementById('lobbyStatus').textContent.trim(),
  botControlsVisible: document.getElementById('botControls').classList.contains('show'),
  sizeButtons: [...document.querySelectorAll('#sizePicker button')].map((b) => b.textContent),
}));
console.log('\n[two people, before bots]');
console.log(JSON.stringify(before, null, 1));
console.log(before.startDisabled ? 'PASS: start correctly blocked at two people' : 'FAIL');
console.log(before.botControlsVisible ? 'PASS: host sees the table-size controls' : 'FAIL: no bot controls');
console.log(before.startLabel.includes('Need 3 more') ? 'PASS: button says why' : `FAIL: label is "${before.startLabel}"`);
await ben.screenshot({ path: path.join(OUT, '26-lobby-two-people.png') });

// The non-host must not get the controls.
const danaSees = await dana.evaluate(() => ({
  botControlsVisible: document.getElementById('botControls').classList.contains('show'),
  startLabel: document.getElementById('btnStart').textContent.trim(),
}));
console.log(!danaSees.botControlsVisible ? 'PASS: non-host has no table controls' : 'FAIL: guest can seat bots');
console.log(/waiting for the host/i.test(danaSees.startLabel) ? 'PASS: guest told to wait' : `FAIL: "${danaSees.startLabel}"`);

// --- fill with bots -------------------------------------------------------
await ben.click('#btnFillBots');
await ben.waitForTimeout(500);

const after = await ben.evaluate(() => ({
  startDisabled: document.getElementById('btnStart').disabled,
  startLabel: document.getElementById('btnStart').textContent.trim(),
  status: document.getElementById('lobbyStatus').textContent.trim(),
  chips: [...document.querySelectorAll('#lobbyPlayers .chip')].map((c) => c.textContent.trim()),
  bots: document.querySelectorAll('#lobbyPlayers .chip.bot').length,
  kickButtons: document.querySelectorAll('#lobbyPlayers .chip .kick').length,
  preview: document.getElementById('lobbyPreview').textContent.trim(),
}));
console.log('\n[after filling with bots]');
console.log(JSON.stringify(after, null, 1));
console.log(!after.startDisabled ? 'PASS: start now enabled' : 'FAIL: still cannot start');
console.log(after.bots === 3 ? 'PASS: three bots seated' : `FAIL: ${after.bots} bots`);
console.log(after.kickButtons === 3 ? 'PASS: each bot removable' : `FAIL: ${after.kickButtons} kick buttons`);
await ben.screenshot({ path: path.join(OUT, '27-lobby-filled.png') });

// Dana sees them too.
const danaAfter = await dana.evaluate(() =>
  ({ chips: document.querySelectorAll('#lobbyPlayers .chip').length,
     kicks: document.querySelectorAll('#lobbyPlayers .chip .kick').length }));
console.log(danaAfter.chips === 5 ? 'PASS: guest sees all five seats' : `FAIL: guest sees ${danaAfter.chips}`);
console.log(danaAfter.kicks === 0 ? 'PASS: guest cannot remove bots' : 'FAIL: guest has kick buttons');

// --- pick a bigger table, then come back ---------------------------------
await ben.click('#sizePicker button:nth-child(4)'); // 8 seats
await ben.waitForTimeout(450);
const eight = await ben.evaluate(() => document.querySelectorAll('#lobbyPlayers .chip').length);
console.log(eight === 8 ? 'PASS: resized to eight seats' : `FAIL: ${eight} seats`);
await ben.screenshot({ path: path.join(OUT, '28-lobby-eight.png') });

await ben.click('#sizePicker button:nth-child(1)'); // back to 5
await ben.waitForTimeout(450);
const five = await ben.evaluate(() => document.querySelectorAll('#lobbyPlayers .chip').length);
console.log(five === 5 ? 'PASS: shrank back to five' : `FAIL: ${five} seats`);

// --- actually play --------------------------------------------------------
await ben.click('#btnStart');
const started = await ben.waitForSelector('#screen-game.active', { timeout: 15000 })
  .then(() => true).catch(() => false);
console.log(started ? 'PASS: the game started' : 'FAIL: never reached the table');

if (started) {
  await ben.waitForSelector('#bidOverlay.show', { timeout: 15000 });
  await ben.waitForTimeout(400);
  await ben.screenshot({ path: path.join(OUT, '29-game-with-bots.png') });

  // Both humans bid, bots bid themselves, and the reveal should appear.
  await ben.click('#bidButtons .btn:nth-child(2)');
  await dana.waitForSelector('#bidOverlay.show', { timeout: 15000 });
  await dana.click('#bidButtons .btn:nth-child(2)');

  const reveal = await ben.waitForSelector('#revealOverlay.show', { timeout: 20000 })
    .then(() => true).catch(() => false);
  console.log(reveal ? 'PASS: bid reveal fired with a mixed human/bot table' : 'FAIL: no reveal');
  if (reveal) {
    await ben.waitForTimeout(900);
    await ben.screenshot({ path: path.join(OUT, '30-reveal-with-bots.png') });
  }

  // Play a full trick. Whoever is on turn is either a bot (plays itself) or one
  // of our two pages (we click). Waiting alone would flake on who leads.
  let played = 0;
  const deadline = Date.now() + 60000;
  while (played < 5 && Date.now() < deadline) {
    let clicked = false;
    for (const p of [ben, dana]) {
      const card = await p.$('#hand .card.playable');
      if (card) { await card.click(); played++; clicked = true; await p.waitForTimeout(300); break; }
    }
    if (!clicked) await ben.waitForTimeout(300);
    const slots = await ben.evaluate(() => document.querySelectorAll('#trickLayer .trick-slot').length);
    if (slots >= 5) break;
  }
  const slots = await ben.evaluate(() => document.querySelectorAll('#trickLayer .trick-slot').length);
  console.log(slots > 0
    ? `PASS: cards are being played (${slots} on the table, ${played} by the humans)`
    : 'FAIL: table stalled');
  await ben.screenshot({ path: path.join(OUT, '31-play-with-bots.png') });
}

console.log('\nJS errors:', errors.length ? errors : 'none');
await browser.close();
server.kill();
