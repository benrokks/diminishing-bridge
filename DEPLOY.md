# Deploying Diminishing Bridge

Click-by-click, from the zip file to a public URL you can text to nine people.

Facts about free tiers below were verified in **August 2026**. Hosting
companies change their plans; if a screen doesn't match, trust the screen.

Total time: about 15 minutes. Cost: nothing.

---

## What you need

- A **GitHub** account — free, at <https://github.com/signup>
- A **Render** account — free, at <https://render.com>, and you can sign in
  with GitHub so it's one login
- Optionally a **Neon** account for permanent standings (Step 5)

No credit card for any of it.

---

## Step 1 — Unzip the project

Unzip `diminishing-bridge.zip`. Open the folder. **Every file sits loose — there
are no folders inside.** That is on purpose: the GitHub website flattens folders
when you drag them, so this project has none to flatten.

You should see about 25 files, including `package.json`, `render.yaml`,
`server.js`, and `index.html`.

If unzipping produced a folder inside another folder of the same name, go in
until you can see `package.json` sitting right there.

---

## Step 2 — Put the files on GitHub

Render deploys from a GitHub repository, so the files have to live there first.
This is all in the browser — nothing to install.

1. Go to <https://github.com/new>.
2. **Repository name:** `diminishing-bridge`
3. Leave **Add a README file** unchecked. Public or private both work.
4. Click **Create repository**.
5. On the next page, click the **uploading an existing file** link.
   (If you don't see it, use **Add file** → **Upload files**.)
6. Open your unzipped folder, **select every file** — `Ctrl`+`A` on Windows,
   `Cmd`+`A` on a Mac — and drag the whole selection into the browser window.
7. Wait until every file finishes uploading, then click **Commit changes**.

That's it. There are no folders to get wrong.

### Check before you move on

Reload the repository page. You should see `package.json`, `render.yaml`,
`server.js`, `index.html`, `app.js`, and `style.css` in the list. If
`render.yaml` is there, Render will find it.

If some files did not make it, just repeat steps 5–7 with the missing ones —
uploading again adds to the repo, it does not replace it.

### The twelve files that actually matter

If anything goes wrong, these are the ones the live site needs. The rest are
tests and documentation and can be missing without breaking the deploy:

```
package.json   package-lock.json   render.yaml
server.js      engine.js           game.js
rooms.js       store.js
index.html     app.js              style.css      practice.html
```

---

## Step 3 — Deploy on Render

1. Go to <https://dashboard.render.com> and sign in (**Sign in with GitHub** is
   easiest — it authorises repo access at the same time).
2. Click **New** in the top right, then **Blueprint**.
3. Find `diminishing-bridge` in the repository list and click **Connect**.
   - Don't see it? Click **Configure account** / **Configure GitHub App** and
     grant Render access to that repo, then come back.
4. Give the blueprint a name — `diminishing-bridge` is fine — and leave the
   branch as `main`.
5. Render reads `render.yaml` and shows you what it will create: one free web
   service. Click **Deploy Blueprint**.
6. Watch the log. It runs `npm install` then `npm start`. When you see
   **Live**, you're done. Two to four minutes is normal for the first build.

Your URL appears at the top of the service page, something like:

```
https://diminishing-bridge.onrender.com
```

Open it. You should see the landing page. Share that link with anyone.

---

## Step 4 — Test it properly

The game needs five players, so test it like one:

1. Open your URL, type a name, click **Create table**, and note the 4-letter
   code.
2. Open **four more windows** — use private/incognito windows, or a phone on
   mobile data, so each gets its own identity. A normal second tab in the same
   browser will work too.
3. Join with the code in each, then click **Start game** in the first window.

If the first person to visit after a quiet spell waits about a minute for the
page, that's the free tier waking up, not a bug. See Step 6.

---

## Step 5 — Permanent standings (recommended)

**Skip this and the all-time leaderboard will keep resetting.** Render's free
instances have no permanent disk and get destroyed every time the service
sleeps, which is after 15 idle minutes. The standings file goes with them.

Fifteen minutes of idle happens constantly, so in practice: no database, no
standings. Everything else — gameplay, chat, sound, in-game scores — works
completely fine without this.

Use **Neon**, whose free Postgres is permanent and needs no card. Render's own
free Postgres expires 30 days after you create it, so don't use that one.

1. Sign up at <https://neon.com>.
2. Create a project. Any name, any region — pick one near your players.
3. On the project dashboard find **Connection string** and copy it. It looks
   like:
   ```
   postgresql://user:password@ep-something-123456.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```
4. Back in Render, open your web service → **Environment** in the left sidebar.
5. Click **Add Environment Variable**:
   - **Key:** `DATABASE_URL`
   - **Value:** the connection string you copied
6. Click **Save Changes**. Render redeploys automatically.
7. In the deploy log you should see `standings: using Postgres`. If you instead
   see `standings: using JSON file`, the connection string is wrong — check for
   a missing character at either end.

The `player_stats` table is created automatically on first boot. Nothing to run.

---

## Step 6 — Optional: stop it falling asleep

Free instances spin down after 15 minutes without traffic and take about a
minute to wake. For a game people arrange in advance this is usually fine — one
person eats the wait.

If it bothers you, the honest options are:

- **Upgrade the Render instance** to the cheapest paid tier. No sleeping.
- **Ping it on a schedule.** A free service like UptimeRobot hitting
  `https://your-app.onrender.com/healthz` every 10 minutes keeps it warm.
  Note that Render allows 750 free instance-hours per workspace per month and a
  month is about 730 hours, so one always-awake service just fits — but a
  second service would push you over.

---

## Other hosts

### Railway

1. Push to GitHub as in Step 2.
2. <https://railway.app> → **New Project** → **Deploy from GitHub repo**.
3. Railway detects Node and sets `PORT` itself. Nothing to configure.
4. Add `DATABASE_URL` under **Variables** if you want standings, or use
   Railway's own Postgres plugin.

### Fly.io

```bash
fly launch --no-deploy     # accept the detected Dockerfile
fly deploy
fly secrets set DATABASE_URL="postgresql://..."
```

### Anything else

Any host that runs Node 18+ and allows WebSocket upgrades. The app serves HTTP
and WebSocket on one port and reads `PORT` from the environment.

---

## Updating the game later

Every commit to `main` redeploys automatically. From the browser: open the file
on github.com, click the pencil icon, edit, **Commit changes**. To replace a
file wholesale, upload it again with the same name — it overwrites.

With a terminal, if you ever want one:

```bash
git add . && git commit -m "what changed" && git push
```

---

## If some files are missing

Symptom: Render says **"Blueprint file render.yaml not found on main branch"**,
or the build fails with "Cannot find module".

Because this project is flat, there is no folder structure to repair — a file
is either in the repo or it isn't. Open the repository page and compare against
the twelve-file list in Step 2.

To add whatever is missing: **Add file** → **Upload files**, drag the missing
files in, **Commit changes**. Uploading again adds to the repository; it never
wipes what is already there. Then click **Retry** on the Render Blueprint, or
**Manual Deploy** → **Deploy latest commit** on the service page.

You never need to delete the repository.

---

## Troubleshooting

**"Blueprint file render.yaml not found on main branch."** `render.yaml` is not
in the repository. Open the repo page and look for it by name. If the files
landed inside a subfolder instead of at the top level, either re-upload them at
the top level or set **Blueprint Path** on the Render screen to
`thatfolder/render.yaml`.

**Build fails with a Node version error.** In Render: service → **Settings** →
**Environment** → add `NODE_VERSION` = `20`.

**Build fails with "Cannot find module".** A file did not upload. The error
names the missing one — upload it and redeploy. Check against the twelve-file
list in Step 2.

**The page loads but is unstyled, or the table never appears.** `style.css` or
`app.js` is missing from the repo. Upload and redeploy.

**Page loads but says it can't connect / players never appear.** The browser
console will show a failed WebSocket. Confirm you're on `https://` — the client
picks `wss://` automatically from that, and a plain `http://` URL on a host that
forces TLS will fail.

**"No table with that code."** Codes are case-insensitive but the table must
still exist. Empty tables are swept after 10 minutes, and if the service went to
sleep in between, every table is gone — sleeping wipes all in-memory state.
Create a fresh one.

**Everyone gets kicked to bots.** Players have 30 seconds to bid and 20 to play,
and the seat goes to a bot after two misses. Slow it down with `DBRIDGE_BID_MS`
and `DBRIDGE_PLAY_MS` in Render's Environment tab (milliseconds).

**Standings keep resetting.** No `DATABASE_URL`. See Step 5.

**Service is suspended at the end of the month.** You've used the 750 free
instance-hours. It comes back next month, or upgrade.
