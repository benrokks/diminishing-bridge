/**
 * Does the landing page tell the truth about whether standings survive?
 * Boots the same server twice — once with no database, once with one — and
 * looks at what a player would actually read.
 *
 * With a database: node visual-standings.mjs
 *   (set TEST_DATABASE_URL to exercise the durable half; without it that half
 *    is skipped rather than faked)
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

function boot(port, extraEnv) {
  const env = { ...process.env, PORT: String(port),
    DBRIDGE_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'dbridge-store-')) };
  delete env.DATABASE_URL;
  Object.assign(env, extraEnv);
  const child = spawn(process.execPath, [path.join(here, 'server.js')],
    { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  return new Promise((resolve) => {
    child.stdout.on('data', (d) => d.toString().includes('listening') && resolve(child));
  });
}

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium',
});

async function inspect(port, label, shot) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 1100 } });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForTimeout(900);
  const read = await page.evaluate(() => {
    const el = document.getElementById('storageState');
    return { text: el.textContent.trim(), cls: el.className };
  });
  const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  console.log(`\n--- ${label}`);
  console.log('  /healthz:', JSON.stringify(health));
  console.log('  banner  :', read.text);
  console.log('  class   :', read.cls);
  await page.locator('#storageState').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, shot) });
  await ctx.close();
  return { read, health };
}

// ------------------------------------------------------- no database at all
const plain = await boot(39910, {});
const a = await inspect(39910, 'no DATABASE_URL', '36-standings-fragile.png');
console.log(a.health.durable === false && /reset/i.test(a.read.text) && /fragile/.test(a.read.cls)
  ? 'PASS: warns that standings reset' : 'FAIL: the warning did not appear');
plain.kill();

// ------------------------------------------------------------ with Postgres
const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.log('\nSKIP: set TEST_DATABASE_URL to check the durable half');
} else {
  const pg = await boot(39911, { DATABASE_URL: url });
  const b = await inspect(39911, 'DATABASE_URL set', '37-standings-durable.png');
  console.log(b.health.durable === true && /survive/i.test(b.read.text) && /durable/.test(b.read.cls)
    ? 'PASS: confirms standings are kept' : 'FAIL: the confirmation did not appear');
  pg.kill();
}

await browser.close();
