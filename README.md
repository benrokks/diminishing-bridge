# Diminishing Bridge

A real-time, multi-device bidding trick-taking card game for **5 to 10 players**.
Players join from any browser with a 4-character table code. The server owns
every card and validates every move, so nobody can cheat by editing their page.

---

## Running it locally

```bash
npm install
npm start
```

Open <http://localhost:3000>. To test with several players on one machine, open
five browser windows (use private/incognito windows so each gets its own name).

```bash
npm test          # engine unit tests + full-game simulations + websocket end-to-end
```

### Practice mode (no server, no network)

```bash
npm run build:practice     # writes public/practice.html
```

Open that file directly in a browser — double-click it, no server needed — and
you play a full game against bots. It is a *build*, not a rewrite: the script
inlines `server/engine.js` and `server/game.js` verbatim and swaps only the
transport, so the rules, the scoring and the bots are the same code the server
runs. Rebuild it after changing anything in `server/` or `public/`.

It also ships as part of the site, so a deployed instance has it at
`/practice.html` — useful for letting someone learn the game before you need
five people in a room.

### Tests

The six Postgres tests skip unless you point them at a database. To include
them:

```bash
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres npm test
```

---

## Deploying to a free host

**See [DEPLOY.md](DEPLOY.md) for the full click-by-click walkthrough.** The
short version:

### Render (easiest)

1. Push this folder to a GitHub repo.
2. Go to <https://render.com> → **New** → **Blueprint** → connect the repo.
   `render.yaml` configures everything.
3. Click **Deploy Blueprint**. You get a public URL like
   `https://diminishing-bridge.onrender.com`.

WebSockets work on Render's free tier with no extra configuration.

> **Free-tier facts, verified August 2026:**
> - The service spins down after 15 minutes with no traffic, and takes
>   **about a minute** to wake. First visitor back waits; everyone after is
>   instant.
> - 750 free instance-hours per workspace per month.
> - **No persistent disk.** This matters: the JSON standings file lives on
>   ephemeral container storage, so it is wiped every time the service sleeps
>   or redeploys. If you want standings to survive at all on the free tier,
>   set `DATABASE_URL` — see below.
> - Render's *own* free Postgres **expires 30 days after creation**, so it is
>   not a long-term answer. Use Neon instead.

### Railway

1. Push to GitHub.
2. <https://railway.app> → **New Project** → **Deploy from GitHub repo**.
3. Railway detects Node automatically and sets `PORT`. No config needed.

### Fly.io

```bash
fly launch --no-deploy     # accept the detected Dockerfile
fly deploy
```

### Anywhere else

Any host that runs Node 18+ and allows WebSocket upgrades works. The app serves
HTTP and WebSocket on the same port and reads `PORT` from the environment.

---

## The rules as implemented

**Deck.** One standard 52-card deck. No jokers, no duplicates.

**Players.** Minimum 5, maximum 10. The table will not start outside that range.

**Hand sizes.** Round 1 deals `floor(51 / players)` cards each:

| Players | 5  | 6 | 7 | 8 | 9 | 10 |
|---------|----|---|---|---|---|----|
| Cards   | 10 | 8 | 7 | 6 | 5 | 5  |

51 rather than 52 because exactly one card must survive undealt to be flipped
as the trump card.

**The ladder.** Hands shrink by one card each round down to a single card, then
grow back to the opening size, which is the final round. Ten players:
`5 4 3 2 1 2 3 4 5` (9 rounds). Five players: `10 … 1 … 10` (19 rounds, roughly
109 tricks — a long sitting, by design).

**Trump.** After the deal, the top undealt card is turned up and stays visible
all round. Its suit is trump.

**Repeated trump.** If the flipped suit equals the previous round's *active*
trump, the round is played with no trump. Because a no-trump round clears the
active trump, the same suit can immediately be trump again next round — a
repeated suit alternates: Hearts, none, Hearts, none.

**Bidding.** Sealed and simultaneous. Everyone picks 0 through their hand size;
no bid is transmitted to any other player until all bids are in, then they
reveal together. Total bids may exceed or fall short of the tricks available.

**The reveal.** Once the last bid lands, the round pauses in its own phase.
Every bid flips over at once as a large number, with the running total set
against the tricks actually available and a verdict — over, under, or dead
even. No card can be played until it is done; the server rejects any attempt.
The bid then stays parked next to each player's name for the rest of the round.

Who leads the round is announced *before* bidding, not after — it matters most
on the blind round, where it may be all you know.

**Play.** The round's first leader is random in round 1 and rotates one seat
clockwise each round after that. Within a round, the winner of a trick leads
the next one.

**Following suit.** You must play the led suit if you hold it. Only when void
may you play anything else.

**Winning a trick.** Ranked: any trump (ace high down to 2), then the led suit
(ace high down to 2), then everything else, which cannot win. The 2 of trump
beats the ace of the led suit. When the led suit is itself trump, plain
high-card order applies.

**Scoring.**

| Result | Points |
|--------|--------|
| Took exactly your bid | `10 + bid` |
| Took more than you bid | `1 per trick taken` |
| Took fewer than you bid | `0` |

Scores accumulate across rounds and are always visible in the sidebar. Most
points at the end wins; equal top scores are reported as a tie.

**The blind round.** On the single-card round, you cannot see your own card,
but every other player's card is face up on the table. This is the only round
where that happens.

**Sorting.** You can drag cards in your hand into any order, or use the
sort-by-suit and sort-by-rank buttons. Order is private and cosmetic.

---

## Reading the table

The felt is built so a fast game stays followable without reading text:

- **Played cards sit beside the player who played them**, numbered in play
  order. The lead card's number is blue.
- **The card currently on pace to take the trick wears a green ring and a
  "winning" tag.** The server computes this with the same ranking function that
  settles the trick, so it is never a client-side guess — useful for deciding
  whether it is worth attacking. It turns gold when the trick is settled.
- **Badges above each seat**: `leads first` before play, `leads`/`led`,
  `your turn`, and `took it`.
- **A large bid number** next to every name once bids are open, outlined green
  while they are on their bid and red once they have gone over.
- **Trick dots** under each seat — one per bid trick, filling gold as they are
  taken, red for overtricks.
- **Trump is shown twice**: in the sidebar, and as a chip right beside your
  hand where you are actually looking when choosing a card.
- **A shuffle-and-deal flourish** opens each round; the bid controls wait for
  it to finish.
- **A "last trick" panel** replays the previous trick with the winner marked.

---

## Chat, standings and sound

### Table chat

Free text, unfiltered. No word list, no link blocking, no mute. Messages are
delivered to every seat exactly as typed, and a player joining late gets the
backlog.

Two limits exist and neither is a content rule:

- **HTML escaping on render.** Without it, any player could type a `<script>`
  tag and run code in every other player's browser — which on this site means
  reading their hand. This is an XSS defence. The text itself is never altered;
  `<b>bold</b>` arrives and displays as the literal characters `<b>bold</b>`.
- **400-character cap and an 80-message history.** A single unbounded message
  would let one player exhaust memory and bandwidth for the whole table.

Chat is available in the lobby and during play, so a table can talk between
games. There is no lobby-wide public chat.

> Note: nicknames still pass through a small blocklist, left over from before
> chat was unfiltered. Delete `BLOCKED` in `server/rooms.js` if you want names
> unfiltered too.

### Persistent standings

Career records survive across games and sessions. Tracked per player: games,
wins, total and average score, best game, tricks taken, and how often they hit
their bid exactly. Shown on the landing page, on the end-of-game screen, and
ranked by wins, then average score.

**Identity.** Your browser stores a private random id and stats attach to that,
not to your nickname — so typing someone else's name does not get you their
record. That id is treated as a credential: it is never sent to other players,
never included in the leaderboard payload, and never exposed by
`/api/leaderboard`. Clearing site data starts a fresh record.

**Storage.** Two interchangeable backends, chosen automatically:

| Condition | Backend | Durability |
|-----------|---------|------------|
| `DATABASE_URL` is set | Postgres | permanent |
| otherwise | JSON file in `data/` | lost when the host's disk resets |

Nothing to configure to get started — it works out of the box with the file
backend, which is fine locally.

**On Render's free tier the file backend is effectively useless.** Free
instances have no persistent disk and are destroyed every time the service
spins down (15 minutes idle), so standings would reset several times a day. To
make them real, point `DATABASE_URL` at a free Postgres database. The table is
created automatically on first boot; there is no migration step.

Which free Postgres, as of August 2026:

| Provider | Free? | Catch |
|----------|-------|-------|
| **Neon** — recommended | permanent, no card | 0.5 GB storage, scales to zero when idle |
| Supabase | permanent | pauses after 7 days of inactivity; 2 projects max |
| Render Postgres | **no** | expires 30 days after creation, then $6/mo |

The local backend is a JSON file rather than SQLite deliberately: `node:sqlite`
still needs an experimental flag on Node 22 and `better-sqlite3` needs a native
build, neither of which is worth it at this size. Writes are debounced and
atomic, so a crash mid-write cannot corrupt the file.

### Sound

Every cue is synthesised with WebAudio, so there are no audio files to host and
nothing extra to download. Distinct cues for: your turn (the one you must not
miss), bidding opens, all bids revealed, a card hitting the table, you taking a
trick, someone else taking it, round scored, game over, and incoming chat.

The speaker button in the sidebar mutes and unmutes, and the choice is
remembered. Browsers block audio until the page has been interacted with, so
the audio context is created on your first click or keypress.

### Play again

When a game ends the host gets a **Play again** button that keeps everyone
seated and resets the scores to zero. Players who dropped out are removed and
seats renumbered. Each completed game is recorded to the standings separately.

---

## Design notes

### Nobody can see anyone else's cards

`Game.viewFor(playerId)` builds a separate payload per player. Another player's
hand is simply not in the bytes sent to your browser — the only exception is
the blind round, where the rules require it. `test/socket.test.js` connects ten
real WebSocket clients and audits every frame each one receives for the entire
game, asserting no hand and no un-revealed bid ever leaks.

### Sealed bidding

Bids are held server-side with `bidsRevealed: false` until the last player
commits. Before then other players see only a "has bid" flag, never a number.

### Idle players

Public tables mean strangers who wander off. Each decision has a clock (30s to
bid, 20s to play). On expiry the server acts for you — bid 0, or play the
lowest legal card. After two misses the seat is handed to a bot so one absent
player cannot freeze nine others. If you come back, the seat is yours again as
soon as you act.

### Abuse guards

Names are length-capped and run through a blocklist; control characters and
bidi-override tricks are stripped. Room creation is rate-limited per IP, each
socket has a token-bucket message limit, empty rooms are swept, and games with
no humans left are discarded.

---

## Layout

**Everything is in one flat directory, deliberately.** Uploading folders
through the GitHub website silently flattens them in some browsers, which
breaks a nested project and produces a baffling "render.yaml not found" error.
Flat means selecting every file and dragging once always yields a working
deploy. It costs some tidiness and buys a deployment path that cannot go wrong.

```
server.js      HTTP + WebSocket entry point, and the static allowlist
engine.js      pure rules — deck, ladder, trump chain, legality, ranking, scoring
game.js        authoritative state machine for one table, plus the bot
rooms.js       room lifecycle, chat, lobby list, naming, rate limits
store.js       career standings — Postgres or JSON file, same interface

index.html     landing, lobby, and table markup
style.css      dark theme, oval felt, responsive down to phones
app.js         renders server state, sends intents; decides nothing itself
practice.html  generated — the whole game offline against bots

build-practice.mjs   bundles the real engine into that standalone page

engine.test.js       rule-level unit tests
game.test.js         full games for every player count, auditing every trick
socket.test.js       ten real clients over websockets, leak auditing
features.test.js     chat, standings storage, rematch
http.test.js         proves only browser files are web-reachable
postgres.test.js     the Postgres backend against a real database (opt-in)
visual*.mjs          Playwright browser checks (run manually)
```

### The one hazard of a flat layout, and how it is handled

Server source sits beside the browser files, so serving the directory
statically would hand anyone `game.js`, `store.js`, or `package.json` over the
web. Instead `server.js` defines an explicit `CLIENT_FILES` allowlist and routes
only those. `http.test.js` boots the real server and asserts that the four
browser files are reachable, that sixteen server and config files are not, and
that path traversal (`/../package.json`, `/%2e%2e/server.js`, and similar)
cannot escape it. If you add a browser file, add it to that map or it will 404.

## Tuning

Set these environment variables (milliseconds) to change pacing without
touching code:

| Variable | Default | Meaning |
|----------|---------|---------|
| `DBRIDGE_BID_MS`    | 30000 | bidding clock |
| `DBRIDGE_REVEAL_MS` | 5000  | how long the bid reveal holds before play starts |
| `DBRIDGE_PLAY_MS`  | 20000 | per-card clock |
| `DBRIDGE_TRICK_MS` | 2600  | pause showing who took the trick |
| `DBRIDGE_ROUND_MS` | 7000  | pause on the round scoreboard |
| `DBRIDGE_BOT_MS`   | 900   | bot "thinking" delay |
| `DBRIDGE_TICK_MS`  | 400   | how often tables advance; bounds bot speed |

And for standings:

| Variable | Default | Meaning |
|----------|---------|---------|
| `DATABASE_URL` | unset | Postgres connection string. Set it and standings become permanent. |
| `DBRIDGE_DATA_DIR`  | `./data` | where the JSON fallback file lives |
