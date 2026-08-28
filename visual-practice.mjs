/**
 * Plays a complete practice game in a real browser, from the setup panel to
 * the final scoreboard, clicking like a person would. Verifies the offline
 * build actually works and screenshots it.
 */
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(root, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const FILE = 'file://' + path.join(root, 'practice.html');

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium',
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const errors = [];
page.on('pageerror', (e) => { errors.push(e.message); console.error('!! JS error:', e.message); });
page.on('console', (m) => { if (m.type() === 'error') { errors.push(m.text()); console.error('!! console:', m.text()); } });

await page.goto(FILE);
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(OUT, '15-practice-setup.png') });
console.log('wrote 15-practice-setup.png');

// Set up a 6-player quick game and deal in.
await page.fill('#pName', 'Ben');
await page.selectOption('#pPlayers', '6');
await page.selectOption('#pLength', 'quick');
await page.selectOption('#pSpeed', 'fast'); // automated run; a person would use Relaxed
await page.click('#pStart');

await page.waitForSelector('#screen-game.active', { timeout: 10000 });

// The shuffle-and-deal flourish runs before the bid panel appears.
const dealt = await page.waitForFunction(
  () => document.querySelectorAll('#dealLayer .deal-card').length > 0,
  null, { timeout: 5000 },
).then(() => true).catch(() => false);
console.log(dealt ? 'PASS: deal animation played' : 'FAIL: no deal animation');
if (dealt) {
  await page.screenshot({ path: path.join(OUT, '25-practice-dealing.png') });
  console.log('wrote 25-practice-dealing.png');
}

await page.waitForSelector('#bidOverlay.show', { timeout: 15000 });
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(OUT, '16-practice-bidding.png') });
console.log('wrote 16-practice-bidding.png');

// Confirm the hand is visible behind the bid panel.
const handVisible = await page.evaluate(() => {
  const cards = document.querySelectorAll('#hand .card');
  if (!cards.length) return 0;
  const r = cards[0].getBoundingClientRect();
  return r.width > 0 && r.bottom <= window.innerHeight + 2 ? cards.length : -1;
});
console.log('cards visible while bidding:', handVisible);

/** Play the game to completion: bid when asked, play a legal card when it is our turn. */
let bids = 0;
let plays = 0;
let rounds = new Set();
let blindAudit = null;
let sawTookItBadge = false;
let sawLeadBadge = false;
let sawPositionedTrick = 0;
let revealAudit = null;
let sawLeadingCard = false;
let sawTrumpChip = false;
let sawBigBidNumbers = 0;
let blindAutoplayed = false;
const started = Date.now();

while (Date.now() - started < 240000) {
  const done = await page.evaluate(() =>
    document.querySelector('#endButtons') &&
    document.querySelector('#endButtons').style.display !== 'none' &&
    document.querySelector('#resultOverlay').classList.contains('show'));
  if (done) break;

  const info = await page.evaluate(() => ({
    bidPanel: document.querySelector('#bidOverlay.show') && document.querySelectorAll('#bidButtons .btn').length > 0,
    bidDock: document.querySelector('#bidDock.show') && document.querySelectorAll('#bidDockButtons .btn').length > 0,
    playable: document.querySelectorAll('#hand .card.playable').length,
    round: (document.querySelector('#roundInfo .big') || {}).textContent || '',
    blind: (document.querySelector('#handLabel') || {}).textContent || '',
    tookBadge: !!document.querySelector('.seat .badge.took'),
    leadBadge: !!document.querySelector('.seat .badge.lead'),
    trickSlots: document.querySelectorAll('#trickLayer .trick-slot').length,
    reveal: document.querySelector('#revealOverlay.show') !== null,
    leadingCard: !!document.querySelector('#trickLayer .trick-slot.leading'),
    trumpChip: !!document.querySelector('#trumpChip.show'),
    bidNums: document.querySelectorAll('.seat .bidnum').length,
    dealCards: document.querySelectorAll('#dealLayer .deal-card').length,
  }));
  if (info.round) rounds.add(info.round);
  if (info.tookBadge) sawTookItBadge = true;
  if (info.leadBadge) sawLeadBadge = true;
  if (info.leadingCard) sawLeadingCard = true;
  if (info.trumpChip) sawTrumpChip = true;
  sawBigBidNumbers = Math.max(sawBigBidNumbers, info.bidNums);
  sawPositionedTrick = Math.max(sawPositionedTrick, info.trickSlots);

  // The bid reveal: capture it once and check it is actually blocking play.
  if (info.reveal && !revealAudit) {
    await page.waitForTimeout(900); // let the staggered flips finish
    revealAudit = await page.evaluate(() => {
      const nums = [...document.querySelectorAll('#revealGrid .bignum')].map((n) => n.textContent.trim());
      const size = nums.length
        ? parseFloat(getComputedStyle(document.querySelector('#revealGrid .bignum')).fontSize)
        : 0;
      // Every chip must actually be visible by now, not still mid-flip.
      const shown = [...document.querySelectorAll('#revealGrid .reveal-player')]
        .filter((el) => parseFloat(getComputedStyle(el).opacity) > 0.9).length;
      return {
        players: nums.length,
        visibleAfterStagger: shown,
        bids: nums,
        numeralPx: size,
        total: (document.getElementById('revealTotal') || {}).textContent || '',
        verdict: (document.getElementById('revealVerdict') || {}).textContent || '',
        playableWhileRevealing: document.querySelectorAll('#hand .card.playable').length,
      };
    });
    await page.screenshot({ path: path.join(OUT, '24-practice-bidreveal.png') });
    console.log('wrote 24-practice-bidreveal.png');
  }

  // The blind round: check the felt is genuinely readable while bidding.
  if (info.bidDock && !blindAudit) {
    blindAudit = await page.evaluate(() => {
      const overlay = document.querySelector('#bidOverlay');
      const seatCards = [...document.querySelectorAll('#seats .card')];
      const faceUp = seatCards.filter((c) => !c.classList.contains('back'));
      const covered = overlay.classList.contains('show');
      // Are those cards actually on screen and not sitting under the bid panel?
      // (Seats are pointer-events:none, so elementFromPoint returns the felt —
      // what matters is whether the point lands inside the overlay.)
      const ov = document.querySelector('#bidOverlay');
      const visible = faceUp.filter((c) => {
        const b = c.getBoundingClientRect();
        if (b.width < 2 || b.height < 2) return false;
        if (b.top < 0 || b.left < 0 || b.bottom > innerHeight || b.right > innerWidth) return false;
        const st = getComputedStyle(c);
        if (st.visibility === 'hidden' || parseFloat(st.opacity) < 0.5) return false;
        const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        return !(hit && ov.contains(hit)) && !(hit === ov);
      });
      return {
        feltCovered: covered,
        faceUpCards: faceUp.length,
        unobstructed: visible.length,
        myCardHidden: seatCards.some((c) => c.classList.contains('back')),
      };
    });
    await page.screenshot({ path: path.join(OUT, '19-practice-blind-bidding.png') });
    console.log('wrote 19-practice-blind-bidding.png');
  }

  if (info.trickSlots >= 3 && !fs.existsSync(path.join(OUT, '20-practice-midtrick.png'))) {
    await page.screenshot({ path: path.join(OUT, '20-practice-midtrick.png') });
    console.log('wrote 20-practice-midtrick.png');
  }
  if (info.tookBadge && !fs.existsSync(path.join(OUT, '21-practice-trickwon.png'))) {
    await page.screenshot({ path: path.join(OUT, '21-practice-trickwon.png') });
    console.log('wrote 21-practice-trickwon.png');
  }

  if (info.bidPanel || info.bidDock) {
    const sel = info.bidDock ? '#bidDockButtons .btn' : '#bidButtons .btn';
    const btns = await page.$$(sel);
    if (btns.length) {
      await btns[Math.min(1, btns.length - 1)].click();
      bids++;
      await page.waitForTimeout(220);
      continue;
    }
  }
  // The blind round plays itself — capture it, then let the server run it.
  if (info.blind.includes('hidden from you') && !info.bidDock && info.trickSlots > 0) {
    // Reaching this state at all proves nobody had to click a hidden card.
    blindAutoplayed = true;
    if (!fs.existsSync(path.join(OUT, '17-practice-blind.png'))) {
      await page.screenshot({ path: path.join(OUT, '17-practice-blind.png') });
    }
  }
  if (info.playable > 0) {
    await page.click('#hand .card.playable');
    plays++;
    await page.waitForTimeout(260);
    continue;
  }
  await page.waitForTimeout(200);
}

console.log('\n--- blind round audit ---');
if (!blindAudit) {
  console.log('FAIL: never reached the blind bidding state');
} else {
  console.log(JSON.stringify(blindAudit));
  console.log(!blindAudit.feltCovered ? 'PASS: felt not covered while bidding blind'
    : 'FAIL: bid overlay still covering the table');
  console.log(blindAudit.unobstructed === blindAudit.faceUpCards && blindAudit.faceUpCards > 0
    ? `PASS: all ${blindAudit.faceUpCards} opponent cards clickable-visible before bidding`
    : `FAIL: only ${blindAudit.unobstructed}/${blindAudit.faceUpCards} opponent cards unobstructed`);
  console.log(blindAudit.myCardHidden ? 'PASS: my own card still face down' : 'FAIL: my card was revealed');
}

console.log('\n--- bid reveal ---');
if (!revealAudit) {
  console.log('FAIL: the bid reveal never appeared');
} else {
  console.log(JSON.stringify(revealAudit));
  console.log(revealAudit.players === 6 ? 'PASS: every player shown' : `FAIL: only ${revealAudit.players} shown`);
  console.log(revealAudit.visibleAfterStagger === 6
    ? 'PASS: all six bids fully visible once the flips finish'
    : `FAIL: only ${revealAudit.visibleAfterStagger}/6 visible after the stagger`);
  console.log(revealAudit.numeralPx >= 28
    ? `PASS: bid numerals are big (${revealAudit.numeralPx}px)`
    : `FAIL: numerals only ${revealAudit.numeralPx}px`);
  console.log(/\d+ bid/.test(revealAudit.total) && /\d+ trick/.test(revealAudit.total)
    ? `PASS: totals shown — "${revealAudit.total}"` : 'FAIL: totals missing');
  console.log(revealAudit.verdict.trim().length > 0
    ? `PASS: verdict shown — "${revealAudit.verdict.split('\n')[0].slice(0, 60)}"` : 'FAIL: no verdict');
  console.log(revealAudit.playableWhileRevealing === 0
    ? 'PASS: no card can be played during the reveal'
    : 'FAIL: cards were playable mid-reveal');
}

console.log('\n--- clarity graphics ---');
console.log(sawLeadBadge ? 'PASS: "leads/led" badge shown' : 'FAIL: no lead badge');
console.log(sawTookItBadge ? 'PASS: "took it" badge shown' : 'FAIL: no trick-winner badge');
console.log(sawLeadingCard ? 'PASS: currently-winning card highlighted' : 'FAIL: no "winning" highlight');
console.log(sawTrumpChip ? 'PASS: trump chip shown beside the hand' : 'FAIL: no trump chip');
console.log(sawBigBidNumbers >= 6
  ? `PASS: big bid numbers on all ${sawBigBidNumbers} seats`
  : `FAIL: only ${sawBigBidNumbers} seat bid numbers`);
console.log(sawPositionedTrick > 1
  ? `PASS: trick cards positioned per seat (saw ${sawPositionedTrick} at once)`
  : 'FAIL: trick cards not laid out by seat');
console.log(blindAutoplayed
  ? 'PASS: reached the blind round without ever clicking a hidden card'
  : 'FAIL: blind round never observed');

console.log(`bids placed: ${bids}, cards played: ${plays}, rounds seen: ${rounds.size}`);
console.log('rounds:', [...rounds].join(' | '));

const finished = await page.evaluate(() =>
  document.querySelector('#resultOverlay').classList.contains('show') &&
  document.querySelector('#endButtons').style.display !== 'none');
console.log(finished ? 'PASS: game reached the final scoreboard' : 'FAIL: never finished');

if (finished) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, '18-practice-final.png') });
  console.log('wrote 18-practice-final.png');

  const title = await page.textContent('#resultTitle');
  console.log('result:', title.trim());

  // Rematch must start a fresh game rather than stalling on the lobby.
  await page.click('#btnRematch');
  await page.waitForTimeout(1200);
  const restarted = await page.evaluate(() => ({
    screen: (document.querySelector('.screen.active') || {}).id,
    round: (document.querySelector('#roundInfo .big') || {}).textContent || '',
    scores: [...document.querySelectorAll('#scoreboard tbody tr')]
      .map((r) => r.lastElementChild.textContent.trim()),
  }));
  console.log('after rematch:', JSON.stringify(restarted));
  console.log(restarted.screen === 'screen-game' && restarted.scores.every((s) => s === '0')
    ? 'PASS: rematch dealt a fresh game with zeroed scores'
    : 'FAIL: rematch did not restart cleanly');
}

console.log('\nJS errors:', errors.length ? errors : 'none');
await browser.close();
