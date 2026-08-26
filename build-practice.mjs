/**
 * Builds public/practice.html — a single self-contained file that plays the
 * game against bots with no server and no network.
 *
 * The point of building it rather than hand-writing it is fidelity: the rules
 * and the state machine are the *same source files* the server runs
 * (engine.js and game.js), and the UI is the same markup, CSS
 * and client script. Only the transport is swapped: instead of a WebSocket to
 * a Node process, the client talks to a Game instance living in the page.
 *
 * Run: node tools/build-practice.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

/** Turn an ES module into plain script source: drop imports, unwrap exports. */
function demodule(src) {
  return src
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*['"][^'"]+['"];?/g, '')
    .replace(/^export\s+/gm, '');
}

const engine = demodule(read('engine.js'));
const game = demodule(read('game.js'));
const css = read('style.css');
const appJs = read('app.js');
const indexHtml = read('index.html');

// Reuse the real markup: take everything between <body> and </body>.
const bodyMatch = indexHtml.match(/<body>([\s\S]*)<\/body>/);
if (!bodyMatch) throw new Error('could not find <body> in index.html');
let body = bodyMatch[1].replace(/<script src="\/app\.js"><\/script>/, '');

// Swap the online-only landing controls for a practice setup panel.
const practicePanel = `
    <div class="panel" id="practicePanel">
      <div class="panel-head">
        <h2>Practice against bots</h2>
        <span class="hint">nothing leaves this page</span>
      </div>
      <label class="field">
        <span>Your name</span>
        <input id="pName" maxlength="14" placeholder="Ben" />
      </label>
      <label class="field">
        <span>Players at the table (you plus bots)</span>
        <select id="pPlayers">
          <option value="5">5 players — 10 cards to start</option>
          <option value="6">6 players — 8 cards to start</option>
          <option value="7">7 players — 7 cards to start</option>
          <option value="8">8 players — 6 cards to start</option>
          <option value="9">9 players — 5 cards to start</option>
          <option value="10" selected>10 players — 5 cards to start</option>
        </select>
      </label>
      <label class="field">
        <span>Length</span>
        <select id="pLength">
          <option value="quick" selected>Quick test — 3·2·1·2·3, five rounds</option>
          <option value="full">Full ladder — the real thing</option>
        </select>
      </label>
      <label class="field">
        <span>Table speed — how fast the bots play</span>
        <select id="pSpeed">
          <option value="slow" selected>Relaxed — easy to follow</option>
          <option value="normal">Normal — matches a real table</option>
          <option value="fast">Fast — for testing</option>
        </select>
      </label>
      <label class="checkline">
        <input type="checkbox" id="pRelaxed" checked />
        <span>Give me longer to decide (90s to bid, 60s to play) — untick for the real 30s/20s</span>
      </label>
      <div class="btn-row">
        <button id="pStart" class="btn primary">Deal me in</button>
      </div>
      <p class="hint" style="margin-top:12px">
        The bots follow suit, chase their bids and duck when they are already
        over. They are competent, not brilliant.
      </p>
    </div>`;

/**
 * The online-only panels are HIDDEN, not deleted. The client looks every one
 * of its controls up by id at startup, so removing the markup would throw and
 * take the whole script down. Tag them and let CSS do the work.
 */
function hidePanel(anchor) {
  const before = body;
  body = body.replace(anchor, (match) => match.replace('<div class="panel">', '<div class="panel online-only">'));
  if (body === before) throw new Error('build: could not tag panel for anchor ' + anchor);
}

hidePanel(/<div class="panel">\s*<label class="field">\s*<span>Your name<\/span>/);
hidePanel(/<div class="panel">\s*<div class="panel-head">\s*<h2>Open tables<\/h2>/);
hidePanel(/<div class="panel">\s*<div class="panel-head">\s*<h2>All-time standings<\/h2>/);

// Insert the practice panel directly under the title.
const headerEnd = body.indexOf('</header>');
if (headerEnd === -1) throw new Error('build: no </header> in the landing markup');
body = body.slice(0, headerEnd + 9) + '\n' + practicePanel + body.slice(headerEnd + 9);

// The lobby screen stays in the DOM (same reason) but is never shown, because
// practice jumps straight from setup into a running game.

const practiceShim = `
/* ------------------------------------------------------------------ *
 * Practice transport: the same Game class the server runs, driven in  *
 * this page, exposing the identical message protocol to the client.   *
 * ------------------------------------------------------------------ */
(function () {
  'use strict';

  var listener = null;
  var room = null;

  function emit(msg) { if (listener) setTimeout(function () { listener(msg); }, 0); }

  var BOT_NAMES = ['Ada', 'Bruno', 'Cleo', 'Dmitri', 'Esme', 'Felix',
                   'Greta', 'Hugo', 'Iris'];

  function LocalRoom(opts) {
    var self = this;
    this.code = 'SOLO';
    this.youId = 'you';
    this.game = new Game({
      onChange: function () { self.broadcast(); },
      onEvent: function (e) { emit(Object.assign({ t: 'event' }, e)); },
    });

    this.game.addPlayer({ id: 'you', name: opts.name || 'You', token: 'you', deviceId: null });
    for (var i = 1; i < opts.players; i++) {
      this.game.addPlayer({
        id: 'bot' + i, name: BOT_NAMES[i - 1] || ('Bot' + i),
        token: 'bot' + i, deviceId: null,
      });
      this.game.players[i].isBot = true;
    }

    this.timer = setInterval(function () {
      try { self.game.tick(); } catch (err) { console.error(err); }
    }, 250);
  }

  LocalRoom.prototype.broadcast = function () {
    emit({
      t: 'state',
      room: { code: this.code, isPrivate: true, hostId: this.youId, canStart: true, gamesPlayed: 0 },
      game: this.game.viewFor(this.youId),
    });
  };

  LocalRoom.prototype.handle = function (m) {
    var g = this.game;
    switch (m.t) {
      case 'bid':     g.submitBid(this.youId, Number(m.n)); break;
      case 'play':    g.playCard(this.youId, String(m.card)); break;
      case 'reorder': if (Array.isArray(m.order)) g.setOrder(this.youId, m.order.map(String)); break;
      case 'rematch': {
        // Suppress the broadcast from reset() so the client never flashes the
        // lobby screen between one game ending and the next beginning.
        var notify = g.onChange;
        g.onChange = function () {};
        g.reset();
        g.players.forEach(function (p, i) { if (i > 0) p.isBot = true; });
        g.onChange = notify;
        g.start(this.opts && this.opts.schedule ? { schedule: this.opts.schedule } : undefined);
        break;
      }
      default: break;
    }
  };

  window.__PRACTICE__ = {
    connect: function (onMessage) {
      listener = onMessage;
      emit({ t: 'hello', limits: { min: 5, max: 10 } });
      return {
        readyState: 1,
        send: function (raw) {
          var m;
          try { m = JSON.parse(raw); } catch (e) { return; }
          if (m.t === 'practiceStart') return window.__PRACTICE__.begin(m);
          if (m.t === 'leaveRoom') { location.reload(); return; }
          if (!room) return;
          try { room.handle(m); } catch (err) { emit({ t: 'error', msg: err.message }); }
        },
      };
    },

    begin: function (m) {
      if (room) { clearInterval(room.timer); }
      // Relaxed clocks by default so a first playthrough is not a race.
      TIMERS.bidding = m.relaxed ? 90000 : 30000;
      TIMERS.playing = m.relaxed ? 60000 : 20000;
      // Table speed governs how long each bot pauses and how long the winning
      // trick stays on screen before it is swept away.
      var SPEEDS = {
        slow:   { botDelay: 1500, trickEnd: 4200, roundEnd: 9000, bidReveal: 7000, autoPlay: 1500 },
        normal: { botDelay: 900,  trickEnd: 3200, roundEnd: 7000, bidReveal: 5000, autoPlay: 1100 },
        fast:   { botDelay: 350,  trickEnd: 1300, roundEnd: 3000, bidReveal: 1200, autoPlay: 400 },
      };
      var sp = SPEEDS[m.speed] || SPEEDS.slow;
      TIMERS.botDelay = sp.botDelay;
      TIMERS.trickEnd = sp.trickEnd;
      TIMERS.roundEnd = sp.roundEnd;
      TIMERS.bidReveal = sp.bidReveal;
      TIMERS.autoPlay = sp.autoPlay;

      room = new LocalRoom({ name: m.name, players: m.players });
      // Same handshake the real server sends, so the client knows who it is.
      emit({ t: 'joined', code: room.code, playerId: room.youId });
      var schedule = m.quick ? quickSchedule(m.players) : null;
      room.opts = { schedule: schedule };
      room.game.start(schedule ? { schedule: schedule } : undefined);
    },
  };

  /** A short ladder that still exercises the blind round and the trump chain. */
  function quickSchedule(players) {
    var max = maxHandSize(players);
    var top = Math.min(3, max);
    var out = [];
    for (var n = top; n >= 1; n--) out.push(n);
    for (var m2 = 2; m2 <= top; m2++) out.push(m2);
    return out;
  }
})();
`;

const bootstrap = `
/* Wire the practice setup panel. */
(function () {
  var send = null;
  var realConnect = window.__PRACTICE__.connect;
  window.__PRACTICE__.connect = function (onMessage) {
    var t = realConnect(onMessage);
    send = function (m) { t.send(JSON.stringify(m)); };
    return t;
  };
  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('pStart');
    var nameEl = document.getElementById('pName');
    try { nameEl.value = localStorage.getItem('db_name') || ''; } catch (e) { /* ignore */ }
    btn.addEventListener('click', function () {
      var name = (nameEl.value || 'You').trim().slice(0, 14) || 'You';
      try { localStorage.setItem('db_name', name); } catch (e) { /* ignore */ }
      send({
        t: 'practiceStart',
        name: name,
        players: parseInt(document.getElementById('pPlayers').value, 10),
        quick: document.getElementById('pLength').value === 'quick',
        relaxed: document.getElementById('pRelaxed').checked,
        speed: document.getElementById('pSpeed').value,
      });
    });
  });
})();
`;

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Diminishing Bridge — practice</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>&#127183;</text></svg>" />
<style>
${css}
/* practice-only tweaks */
#practicePanel select {
  width: 100%;
  cursor: pointer;
  color: var(--text);
  background: var(--bg-input);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 11px 13px;
  font: inherit;
  text-align: left;
  letter-spacing: normal;
  text-transform: none;
}
#practicePanel select:focus { outline: none; border-color: var(--accent); }
#practicePanel select option { color: var(--text); background: #11161d; }
.practice-badge {
  display: inline-block; font-size: 10px; letter-spacing: .08em;
  text-transform: uppercase; background: #3a2a12; color: var(--gold);
  border-radius: 5px; padding: 2px 7px; margin-left: 8px; vertical-align: 3px;
}
#sidebar .chat { display: none; }
.online-only { display: none !important; }
</style>
</head>
<body>
${body}
<script>
/* ---- process shim: the game module reads env vars for its clocks ---- */
var process = { env: {} };
</script>
<script>
/* =================== engine.js (verbatim) =================== */
${engine}
</script>
<script>
/* ==================== game.js (verbatim) ==================== */
${game}
</script>
<script>${practiceShim}</script>
<script>${bootstrap}</script>
<script>
${appJs}
</script>
</body>
</html>
`;

const out = path.join(root, 'practice.html');
fs.writeFileSync(out, html);
console.log('wrote', out, `(${(html.length / 1024).toFixed(0)} KB)`);
