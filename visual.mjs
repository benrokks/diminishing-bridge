/**
 * Visual verification: drive five real browser pages through a live game and
 * screenshot the states that matter. Not part of `npm test` — run manually
 * with `node test/visual.mjs`.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 39311;
const OUT = path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });

const server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
  env: {
    ...process.env, PORT: String(PORT),
    DBRIDGE_BID_MS: '600000', DBRIDGE_PLAY_MS: '600000',
    DBRIDGE_TRICK_MS: '2000', DBRIDGE_ROUND_MS: '600000', DBRIDGE_BOT_MS: '600000',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
await new Promise((res) => server.stdout.on('data', (d) => d.toString().includes('listening') && res()));

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium',
});
const pages = [];
const NAMES = ['Ben', 'Marcus', 'Dana', 'Ravi', 'Ines'];

for (const name of NAMES) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`!! JS error on ${name}:`, e.message));
  page.on('console', (m) => m.type() === 'error' && console.error(`!! console on ${name}:`, m.text()));
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.fill('#nameInput', name);
  pages.push({ name, page });
}

const shot = async (p, file) => {
  await p.screenshot({ path: path.join(OUT, file) });
  console.log('  wrote', file);
};

// --- landing -----------------------------------------------------------
await shot(pages[0].page, '01-landing.png');

// --- create + join -----------------------------------------------------
await pages[0].page.click('#btnCreate');
await pages[0].page.waitForSelector('#screen-lobby.active');
const code = (await pages[0].page.textContent('#lobbyCode')).trim();
console.log('table code:', code);

for (let i = 1; i < pages.length; i++) {
  await pages[i].page.fill('#codeInput', code);
  await pages[i].page.click('#btnJoin');
  await pages[i].page.waitForSelector('#screen-lobby.active');
}
await pages[0].page.waitForTimeout(400);
await shot(pages[0].page, '02-lobby.png');

// --- start + bidding ---------------------------------------------------
await pages[0].page.click('#btnStart');
await pages[0].page.waitForSelector('#bidOverlay.show');
await pages[0].page.waitForTimeout(500);
await shot(pages[0].page, '03-bidding-sealed.png');

// Confirm nobody's bid number is on anyone else's page before the reveal.
await pages[1].page.click('#bidButtons .btn:nth-child(3)'); // bid 2
await pages[0].page.waitForTimeout(400);
const leakCheck = await pages[0].page.evaluate(() => {
  const rows = [...document.querySelectorAll('#scoreboard tbody tr')];
  return rows.map((r) => [...r.children].map((c) => c.textContent.trim()));
});
console.log('scoreboard during sealed bidding (bid column must be • or –):');
console.log(leakCheck.map((r) => '   ' + r.join(' | ')).join('\n'));

for (let i = 0; i < pages.length; i++) {
  if (i === 1) continue;
  await pages[i].page.click('#bidButtons .btn:nth-child(2)'); // bid 1
  await pages[i].page.waitForTimeout(120);
}
await pages[0].page.waitForTimeout(700);
await shot(pages[0].page, '04-bids-revealed.png');

// --- play a full trick -------------------------------------------------
async function whoseTurn() {
  for (const { name, page } of pages) {
    const mine = await page.evaluate(() => {
      const s = window.__state;
      return false;
    }).catch(() => false);
    void mine; void name;
  }
  return null;
}
void whoseTurn;

// Click the first playable card on whichever page has one, five times.
for (let step = 0; step < 5; step++) {
  let played = false;
  for (const { name, page } of pages) {
    const card = await page.$('#hand .card.playable');
    if (card) {
      await card.click();
      console.log(`  ${name} played`);
      played = true;
      await page.waitForTimeout(350);
      break;
    }
  }
  if (!played) { console.error('!! nobody had a playable card at step', step); break; }
  if (step === 2) await shot(pages[0].page, '05-mid-trick.png');
}
await pages[0].page.waitForTimeout(600);
await shot(pages[0].page, '06-trick-complete.png');
await shot(pages[2].page, '07-other-player-view.png');

// --- verify no hand leakage in the live DOM ----------------------------
const domAudit = await pages[0].page.evaluate(() => {
  const seatCards = document.querySelectorAll('#seats .card:not(.back)').length;
  const handCards = document.querySelectorAll('#hand .card').length;
  return { seatCards, handCards };
});
console.log('DOM audit (seats should show 0 face-up cards outside the blind round):', domAudit);

// --- mobile viewport ---------------------------------------------------
const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const mpage = await mctx.newPage();
await mpage.goto(`http://127.0.0.1:${PORT}/`);
await shot(mpage, '08-mobile-landing.png');

await browser.close();
server.kill();
console.log('\ndone — screenshots in', OUT);
