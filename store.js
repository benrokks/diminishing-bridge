/**
 * store.js — persistent career standings.
 *
 * Two interchangeable backends behind one interface:
 *   - Postgres, used automatically when DATABASE_URL is set (truly permanent)
 *   - a JSON file, used otherwise (zero setup, works immediately)
 *
 * The file backend is deliberately not SQLite: node:sqlite still needs an
 * experimental flag on Node 22 and better-sqlite3 needs a native build step,
 * neither of which is worth it for a table this small. A debounced JSON file
 * behaves identically through this interface.
 *
 * Note that on ephemeral hosts (Render's free tier included) the JSON file is
 * wiped on redeploy. Set DATABASE_URL to make standings survive.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

// Resolved per call, not at import time, so the location stays configurable
// (and so tests can point each store at its own directory).
const resolveDir = (dir) => dir || process.env.DBRIDGE_DATA_DIR || path.join(process.cwd(), 'data');

const blankRow = (deviceId, name) => ({
  deviceId,
  name,
  games: 0,
  wins: 0,
  rounds: 0,
  totalScore: 0,
  bestScore: 0,
  exactBids: 0,
  busts: 0,
  tricks: 0,
  updatedAt: Date.now(),
});

function applyResult(row, r) {
  row.name = r.name || row.name;
  row.games += 1;
  if (r.won) row.wins += 1;
  row.rounds += r.rounds || 0;
  row.totalScore += r.score || 0;
  row.bestScore = Math.max(row.bestScore, r.score || 0);
  row.exactBids += r.exactBids || 0;
  row.busts += r.busts || 0;
  row.tricks += r.tricks || 0;
  row.updatedAt = Date.now();
  return row;
}

function decorate(row) {
  return {
    ...row,
    winRate: row.games ? row.wins / row.games : 0,
    avgScore: row.games ? row.totalScore / row.games : 0,
    accuracy: row.rounds ? row.exactBids / row.rounds : 0,
  };
}

/** Rank by wins, then average score, then games played. */
function rank(rows) {
  return rows
    .map(decorate)
    .sort((a, b) => b.wins - a.wins || b.avgScore - a.avgScore || b.games - a.games);
}

// ------------------------------------------------------------------ file

function createFileStore(dir) {
  const DATA_DIR = resolveDir(dir);
  const FILE = path.join(DATA_DIR, 'standings.json');

  let data = { players: {} };
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(FILE)) data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (err) {
    console.error('standings: could not read existing file, starting fresh —', err.message);
  }
  if (!data.players) data.players = {};

  let pending = null;
  let writing = false;

  async function flush() {
    if (writing) return;
    writing = true;
    pending = null;
    const tmp = FILE + '.tmp';
    try {
      await fsp.mkdir(DATA_DIR, { recursive: true });
      await fsp.writeFile(tmp, JSON.stringify(data), 'utf8');
      await fsp.rename(tmp, FILE); // atomic, so a crash mid-write cannot corrupt it
    } catch (err) {
      console.error('standings: write failed —', err.message);
    } finally {
      writing = false;
    }
  }

  function schedule() {
    if (pending) return;
    pending = setTimeout(flush, 1500);
    if (pending.unref) pending.unref();
  }

  return {
    kind: 'file',
    file: FILE,
    async recordGame(results) {
      for (const r of results) {
        if (!r.deviceId) continue;
        const row = data.players[r.deviceId] || blankRow(r.deviceId, r.name);
        data.players[r.deviceId] = applyResult(row, r);
      }
      schedule();
    },
    async leaderboard(limit = 25) {
      return rank(Object.values(data.players)).slice(0, limit);
    },
    async player(deviceId) {
      const row = data.players[deviceId];
      if (!row) return null;
      const all = rank(Object.values(data.players));
      const idx = all.findIndex((x) => x.deviceId === deviceId);
      return { ...decorate(row), rank: idx + 1, of: all.length };
    },
    async close() { await flush(); },
  };
}

// -------------------------------------------------------------- postgres

/**
 * Decide the SSL setting for a connection string.
 * Hosted Postgres (Neon, Supabase, Render) requires TLS; a Postgres you run
 * yourself usually has it switched off. Guessing from the hostname is
 * unreliable, so honour an explicit sslmode when given, guess otherwise, and
 * let the caller retry the other way if the server disagrees.
 */
function sslFor(url, force) {
  if (force === 'off') return false;
  if (force === 'on') return { rejectUnauthorized: false };
  if (/[?&]sslmode=disable/i.test(url)) return false;
  if (/[?&]sslmode=(require|prefer|verify-ca|verify-full)/i.test(url)) {
    return { rejectUnauthorized: false };
  }
  const local = /@(localhost|127\.0\.0\.1|\[::1\]|::1|host\.docker\.internal)[:/]/i.test(url);
  return local ? false : { rejectUnauthorized: false };
}

async function connectPool(pg, url, force) {
  const pool = new pg.Pool({
    connectionString: url,
    ssl: sslFor(url, force),
    max: 5,
    connectionTimeoutMillis: 10000,
  });
  // Fail fast here rather than on the first game that tries to save.
  const probe = await pool.connect();
  probe.release();
  return pool;
}

async function createPgStore() {
  const { default: pg } = await import('pg');
  const url = process.env.DATABASE_URL;

  let pool;
  try {
    pool = await connectPool(pg, url);
  } catch (err) {
    // The two ways the SSL guess can be wrong, each with a distinctive error.
    const noSsl = /does not support SSL/i.test(err.message);
    const needsSsl = /SSL.*required|no encryption/i.test(err.message);
    if (!noSsl && !needsSsl) throw err;
    console.log(`standings: retrying Postgres with SSL ${noSsl ? 'off' : 'on'}`);
    pool = await connectPool(pg, url, noSsl ? 'off' : 'on');
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_stats (
      device_id   TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      games       INTEGER NOT NULL DEFAULT 0,
      wins        INTEGER NOT NULL DEFAULT 0,
      rounds      INTEGER NOT NULL DEFAULT 0,
      total_score INTEGER NOT NULL DEFAULT 0,
      best_score  INTEGER NOT NULL DEFAULT 0,
      exact_bids  INTEGER NOT NULL DEFAULT 0,
      busts       INTEGER NOT NULL DEFAULT 0,
      tricks      INTEGER NOT NULL DEFAULT 0,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const fromRow = (r) => ({
    deviceId: r.device_id,
    name: r.name,
    games: r.games,
    wins: r.wins,
    rounds: r.rounds,
    totalScore: r.total_score,
    bestScore: r.best_score,
    exactBids: r.exact_bids,
    busts: r.busts,
    tricks: r.tricks,
    updatedAt: new Date(r.updated_at).getTime(),
  });

  return {
    kind: 'postgres',
    async recordGame(results) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const r of results) {
          if (!r.deviceId) continue;
          await client.query(
            `INSERT INTO player_stats
               (device_id, name, games, wins, rounds, total_score, best_score, exact_bids, busts, tricks, updated_at)
             VALUES ($1,$2,1,$3,$4,$5,$5,$6,$7,$8, now())
             ON CONFLICT (device_id) DO UPDATE SET
               name        = EXCLUDED.name,
               games       = player_stats.games + 1,
               wins        = player_stats.wins + EXCLUDED.wins,
               rounds      = player_stats.rounds + EXCLUDED.rounds,
               total_score = player_stats.total_score + EXCLUDED.total_score,
               best_score  = GREATEST(player_stats.best_score, EXCLUDED.best_score),
               exact_bids  = player_stats.exact_bids + EXCLUDED.exact_bids,
               busts       = player_stats.busts + EXCLUDED.busts,
               tricks      = player_stats.tricks + EXCLUDED.tricks,
               updated_at  = now()`,
            [r.deviceId, r.name, r.won ? 1 : 0, r.rounds || 0, r.score || 0,
              r.exactBids || 0, r.busts || 0, r.tricks || 0],
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('standings: recordGame failed —', err.message);
      } finally {
        client.release();
      }
    },
    async leaderboard(limit = 25) {
      const { rows } = await pool.query('SELECT * FROM player_stats WHERE games > 0');
      return rank(rows.map(fromRow)).slice(0, limit);
    },
    async player(deviceId) {
      const { rows } = await pool.query('SELECT * FROM player_stats WHERE games > 0');
      const all = rank(rows.map(fromRow));
      const idx = all.findIndex((x) => x.deviceId === deviceId);
      if (idx === -1) return null;
      return { ...all[idx], rank: idx + 1, of: all.length };
    },
    async close() { await pool.end(); },
  };
}

// ------------------------------------------------------------------ init

export async function createStore({ dir } = {}) {
  if (process.env.DATABASE_URL) {
    try {
      const store = await createPgStore();
      console.log('standings: using Postgres');
      return store;
    } catch (err) {
      console.error('standings: Postgres unavailable, falling back to file —', err.message);
    }
  }
  const store = createFileStore(dir);
  console.log('standings: using JSON file at', store.file);
  return store;
}
