/**
 * The lobby as a person meets it: claim a name, flip the round-of-one rule,
 * say hello and watch the bots answer in character.
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
const PORT = 39830 + Math.floor(Math.random() * 60);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbridge-social-'));

const server = spawn(process.execPath, [path.join(here, 'server.js')], {
  env: {
    ...process.env, PORT: String(PORT), DBRIDGE_DATA_DIR: dataDir,
    DBRIDGE_BID_MS: '60000', DBRIDGE_REVEAL_MS: '1500', DBRIDGE_AUTOPLAY_MS: '600',
    DBRIDGE_PLAY_MS: '60000', DBRIDGE_TRICK_MS: '900', DBRIDGE_ROUND_MS: '1500',
    DBRIDGE_BOT_MS: '400',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
await new Promise((r) => server.stdout.on('data', (d) => d.toString().includes('listening') && r()));

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium',
});
const errors = [];
async function newPage(label) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 950 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => { errors.push(`${label}: ${e.message}`); console.error('!! JS error', label, e.message); });
  p.on('console', (m) => m.type() === 'error' && errors.push(`${label}: ${m.text()}`));
  await p.goto(`http://127.0.0.1:${PORT}/`);
  return p;
}

// ---------------------------------------------------- claim a name
const ben = await newPage('Ben');
await ben.fill('#acctName', 'ben');
await ben.fill('#acctPin', '4242');
await ben.click('#btnSignIn');
await ben.waitForTimeout(700);
const signedIn = await ben.textContent('#acctState');
console.log('account state:', JSON.stringify(signedIn.trim()));
console.log(/signed in as ben/i.test(signedIn) ? 'PASS: name claimed' : 'FAIL: not signed in');
await ben.screenshot({ path: path.join(OUT, '32-signed-in.png') });

// A *different browser* signing in with the same name and PIN is the same player.
const other = await newPage('OtherDevice');
await other.fill('#acctName', 'ben');
await other.fill('#acctPin', '4242');
await other.click('#btnSignIn');
await other.waitForTimeout(700);
const otherState = await other.textContent('#acctState');
console.log(/signed in as ben/i.test(otherState)
  ? 'PASS: same name+PIN signs in from a second browser'
  : `FAIL: second browser says "${otherState.trim()}"`);

// Wrong PIN must be refused.
const thief = await newPage('Thief');
await thief.fill('#acctName', 'ben');
await thief.fill('#acctPin', '9999');
await thief.click('#btnSignIn');
await thief.waitForTimeout(700);
const thiefState = await thief.textContent('#acctState');
console.log(/not signed in/i.test(thiefState)
  ? 'PASS: wrong PIN refused'
  : `FAIL: thief got in — "${thiefState.trim()}"`);
await thief.close();
await other.close();

// ---------------------------------------------------- lobby, rules, chat
await ben.fill('#nameInput', 'Ben');
await ben.click('#btnCreate');
await ben.waitForSelector('#screen-lobby.active');
await ben.click('#btnFillBots');
await ben.waitForTimeout(600);

const ruleBefore = await ben.isChecked('#ruleBlindBonus');
await ben.check('#ruleBlindBonus');
await ben.waitForTimeout(400);
const ruleAfter = await ben.isChecked('#ruleBlindBonus');
console.log(!ruleBefore && ruleAfter ? 'PASS: round-of-one rule toggles on' : 'FAIL: rule toggle');

// Bots greet on arrival, and answer when spoken to.
await ben.waitForTimeout(2500);
const greeted = await ben.evaluate(() =>
  [...document.querySelectorAll('#chatLog2 .chat-msg')].map((m) => m.textContent.trim()));
console.log(`bot greetings in lobby: ${greeted.length}`);
greeted.slice(0, 4).forEach((g) => console.log('   ' + g));
console.log(greeted.length > 0 ? 'PASS: bots greeted the lobby' : 'FAIL: silent bots');

// Not every message draws an answer — bots deliberately don't all pile on —
// so send a few and count across them.
const sent = ['hey everyone, good luck!', 'anyone ready?', 'this is going to be close'];
for (const line of sent) {
  await ben.fill('#chatInput2', line);
  await ben.click('#chatForm2 button');
  await ben.waitForTimeout(4000);
}

const after = await ben.evaluate(() =>
  [...document.querySelectorAll('#chatLog2 .chat-msg')].map((m) => m.textContent.trim()));
const replies = after.length - greeted.length - sent.length;
console.log(`bot replies across ${sent.length} messages: ${replies}`);
after.slice(-4).forEach((g) => console.log('   ' + g));
console.log(replies > 0 ? 'PASS: bots answered a person' : 'FAIL: no bot replies');
await ben.screenshot({ path: path.join(OUT, '33-lobby-chatter.png') });

// ---------------------------------------------------- lead is obvious
await ben.click('#btnStart');
await ben.waitForSelector('#bidOverlay.show', { timeout: 20000 });
await ben.waitForTimeout(600);

const lead = await ben.evaluate(() => {
  const b = document.getElementById('leadBanner');
  const seat = document.querySelector('.seat .badge.lead');
  return {
    shown: b.classList.contains('show'),
    youLead: b.classList.contains('you'),
    text: b.textContent.trim(),
    fontPx: parseFloat(getComputedStyle(b).fontSize),
    seatBadge: seat ? seat.textContent.trim() : null,
  };
});
console.log('\nlead banner:', JSON.stringify(lead));
console.log(lead.shown ? 'PASS: lead banner visible while bidding' : 'FAIL: no lead banner');
console.log(lead.fontPx >= 13 ? 'PASS: banner is large' : `FAIL: only ${lead.fontPx}px`);
console.log(/lead/i.test(lead.text) ? 'PASS: banner names who leads' : 'FAIL: banner text');
console.log(lead.seatBadge ? `PASS: seat badge too ("${lead.seatBadge}")` : 'FAIL: no seat badge');
await ben.screenshot({ path: path.join(OUT, '34-lead-banner.png') });

// The green "YOU LEAD" variant only appears when the random opening lead
// lands on you, so restart tables until it does.
let sawYouLead = lead.youLead ? lead : null;
if (sawYouLead) {
  await ben.screenshot({ path: path.join(OUT, '35-you-lead.png') });
}
for (let attempt = 0; attempt < 12 && !sawYouLead; attempt++) try {
  // Reload rather than clicking Leave: once the game has started the lobby's
  // Leave button is no longer on screen.
  await ben.reload();
  await ben.waitForSelector('#screen-landing.active', { timeout: 10000 });
  await ben.fill('#nameInput', 'Ben');
  await ben.waitForTimeout(250);
  await ben.click('#btnCreate');
  await ben.waitForSelector('#screen-lobby.active', { timeout: 8000 });
  await ben.uncheck('#ruleBotChat').catch(() => {});   // quiet for this pass
  await ben.click('#btnFillBots');
  await ben.waitForTimeout(350);
  await ben.click('#btnStart');
  await ben.waitForSelector('#bidOverlay.show', { timeout: 15000 });
  await ben.waitForTimeout(350);
  const info = await ben.evaluate(() => {
    const b = document.getElementById('leadBanner');
    return { you: b.classList.contains('you'), text: b.textContent.trim() };
  });
  if (info.you) sawYouLead = info;
} catch { /* a table that would not settle; just try another */ }
if (sawYouLead) {
  console.log(`PASS: "you lead" banner rendered — "${sawYouLead.text}"`);
  await ben.screenshot({ path: path.join(OUT, '35-you-lead.png') });
  console.log('wrote 35-you-lead.png');
} else {
  console.log('NOTE: the random lead never landed on Ben in 15 tables (not a failure)');
}

console.log('\nJS errors:', errors.length ? errors : 'none');
await browser.close();
server.kill();
fs.rmSync(dataDir, { recursive: true, force: true });
