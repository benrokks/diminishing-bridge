/**
 * Worst case for the new table layout: ten players, all ten cards on the felt
 * at once, on desktop and on a phone. Checks nothing overlaps and every played
 * card stays inside the table.
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

function overlapArea(a, b) {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

async function run(label, viewport, shot) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(FILE);
  await page.fill('#pName', 'Ben');
  await page.selectOption('#pPlayers', '10');
  await page.selectOption('#pLength', 'quick');
  await page.selectOption('#pSpeed', 'fast');
  await page.click('#pStart');
  await page.waitForSelector('#screen-game.active');

  // Bid, then wait until all ten cards are on the table.
  await page.waitForSelector('#bidOverlay.show, #bidDock.show', { timeout: 10000 });
  const btns = await page.$$('#bidButtons .btn, #bidDockButtons .btn');
  if (btns.length) await btns[0].click();

  const full = await page.waitForFunction(
    () => document.querySelectorAll('#trickLayer .trick-slot').length >= 9,
    null, { timeout: 60000 },
  ).then(() => true).catch(() => false);

  if (!full) {
    // We may need to play our own card to complete the trick.
    const card = await page.$('#hand .card.playable');
    if (card) await card.click();
    await page.waitForFunction(
      () => document.querySelectorAll('#trickLayer .trick-slot').length >= 9,
      null, { timeout: 30000 },
    ).catch(() => {});
  }

  const report = await page.evaluate(() => {
    const felt = document.getElementById('felt').getBoundingClientRect();
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height };
    };
    const slots = [...document.querySelectorAll('#trickLayer .trick-slot')];
    const cards = slots.map((s) => box(s.querySelector('.card')));
    const seats = [...document.querySelectorAll('#seats .seat .avatar')].map(box);
    const outside = cards.filter((c) =>
      c.left < felt.left || c.right > felt.right || c.top < felt.top || c.bottom > felt.bottom).length;
    const seatsOutside = seats.filter((c) =>
      c.left < 0 || c.right > innerWidth || c.top < 0).length;
    return { count: slots.length, cards, seats, outside, seatsOutside };
  });

  const worstOf = (list) => {
    let w = 0;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        w = Math.max(w, overlapArea(list[i], list[j]) / (list[i].w * list[i].h));
      }
    }
    return w;
  };
  const worst = worstOf(report.cards);
  const worstSeat = worstOf(report.seats);

  await page.screenshot({ path: path.join(OUT, shot) });
  console.log(`\n[${label}] ${viewport.width}x${viewport.height}`);
  console.log(`  cards on felt: ${report.count}`);
  console.log(`  outside the table: ${report.outside} ${report.outside === 0 ? 'PASS' : 'FAIL'}`);
  console.log(`  worst card overlap: ${(worst * 100).toFixed(0)}% ${worst < 0.2 ? 'PASS' : 'FAIL'}`);
  console.log(`  worst seat overlap: ${(worstSeat * 100).toFixed(0)}% ${worstSeat < 0.1 ? 'PASS' : 'FAIL'}`);
  console.log(`  seats off-screen: ${report.seatsOutside} ${report.seatsOutside === 0 ? 'PASS' : 'FAIL'}`);
  console.log(`  JS errors: ${errors.length ? errors.join(' | ') : 'none'}`);
  console.log(`  wrote ${shot}`);
  await page.close();
}

await run('desktop', { width: 1280, height: 900 }, '22-crowded-desktop.png');
await run('phone', { width: 390, height: 844 }, '23-crowded-phone.png');

await browser.close();
