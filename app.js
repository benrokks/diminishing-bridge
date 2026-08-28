/* Diminishing Bridge — browser client.
   The server is authoritative; this file only renders what it is told and
   sends intents back. It never decides legality or scoring on its own. */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const SUIT_SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };
  const SUIT_NAMES = { S: 'Spades', H: 'Hearts', D: 'Diamonds', C: 'Clubs' };
  const RANK_LABEL = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

  const parse = (id) => ({ rank: parseInt(id, 10), suit: id.slice(-1), id });
  const label = (rank) => RANK_LABEL[rank] || String(rank);
  const isRed = (suit) => suit === 'H' || suit === 'D';

  // ------------------------------------------------------------- state
  let ws = null;
  let state = null;     // latest game view from the server
  let room = null;      // latest room meta
  let myId = null;

  /**
   * Who am I? The server states this outright in every state payload, which is
   * more reliable than the id we cached from the join handshake — a reconnect
   * or a locally hosted table may never replay that handshake.
   */
  const selfId = () => (state && state.you ? state.you.id : myId);
  let myOrder = [];     // client-side hand order
  let reconnectDelay = 800;
  let toastTimer = null;

  const savedName = (() => {
    try { return localStorage.getItem('db_name') || ''; } catch { return ''; }
  })();

  /* ------------------------------------------------------------------ device
     A private per-browser id. Not a login — it just keeps career standings
     attached to the right browser no matter what nickname is typed, so nobody
     can inherit your record by copying your name. */
  const deviceId = (() => {
    try {
      let id = localStorage.getItem('db_device');
      if (!id) {
        id = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now())
          .replace(/[^A-Za-z0-9_-]/g, '');
        localStorage.setItem('db_device', id);
      }
      return id;
    } catch {
      // Private browsing with storage disabled: stats simply will not persist.
      return null;
    }
  })();

  /* ------------------------------------------------------------------- sound
     Everything is synthesised with WebAudio, so there are no asset files to
     host and nothing extra to download. Browsers block audio until the user
     interacts with the page, so the context is created on first gesture. */
  const Sound = (() => {
    let ctx = null;
    let enabled = true;
    try { enabled = localStorage.getItem('db_sound') !== 'off'; } catch { /* default on */ }

    function ensure() {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        try { ctx = new AC(); } catch { return null; }
      }
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    }

    function tone(freq, start, dur, { type = 'sine', gain = 0.13 } = {}) {
      const c = ensure();
      if (!c) return;
      const osc = c.createOscillator();
      const amp = c.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      const t0 = c.currentTime + start;
      amp.gain.setValueAtTime(0.0001, t0);
      amp.gain.linearRampToValueAtTime(gain, t0 + 0.012);
      amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(amp);
      amp.connect(c.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.03);
    }

    const CUES = {
      // Distinctly attention-grabbing: this is the one you must not miss.
      yourTurn:   () => { tone(660, 0, 0.13, { type: 'triangle', gain: 0.16 });
                          tone(990, 0.11, 0.20, { type: 'triangle', gain: 0.16 }); },
      cardPlay:   () => tone(320, 0, 0.06, { type: 'square', gain: 0.05 }),
      trickWon:   () => { tone(523, 0, 0.12); tone(659, 0.08, 0.13); tone(784, 0.16, 0.22); },
      trickLost:  () => tone(196, 0, 0.14, { type: 'sine', gain: 0.07 }),
      bidsIn:     () => { tone(440, 0, 0.09, { type: 'triangle', gain: 0.1 });
                          tone(587, 0.07, 0.16, { type: 'triangle', gain: 0.1 }); },
      roundEnd:   () => { tone(392, 0, 0.14); tone(523, 0.12, 0.14); tone(659, 0.24, 0.26); },
      gameOver:   () => { tone(523, 0, 0.16); tone(659, 0.14, 0.16);
                          tone(784, 0.28, 0.16); tone(1047, 0.42, 0.42); },
      chat:       () => tone(880, 0, 0.05, { type: 'sine', gain: 0.05 }),
      bidNow:     () => { tone(587, 0, 0.11, { type: 'triangle', gain: 0.13 });
                          tone(880, 0.09, 0.18, { type: 'triangle', gain: 0.13 }); },
    };

    return {
      play(name) { if (enabled && CUES[name]) { try { CUES[name](); } catch { /* audio blocked */ } } },
      get enabled() { return enabled; },
      toggle() {
        enabled = !enabled;
        try { localStorage.setItem('db_sound', enabled ? 'on' : 'off'); } catch { /* ignore */ }
        if (enabled) { ensure(); this.play('cardPlay'); }
        return enabled;
      },
      warm() { ensure(); },
    };
  })();

  // Edge detection so cues fire on transitions, never on every repaint.
  const cue = {
    myTurn: false,
    phase: null,
    roundIndex: -1,
    trickLen: 0,
    winnerSeat: undefined,
    finished: false,
  };

  /* ----------------------------------------------------------- account
     A claimed name + PIN makes an all-time record follow the player to any
     device. Without it, stats are tied to this browser only. */
  let account = null;

  function savedAccount() {
    try { return JSON.parse(localStorage.getItem('db_acct') || 'null'); } catch { return null; }
  }
  function rememberAccount(name, pin) {
    try { localStorage.setItem('db_acct', JSON.stringify({ name, pin })); } catch { /* ignore */ }
  }
  function forgetAccount() {
    try { localStorage.removeItem('db_acct'); } catch { /* ignore */ }
  }

  function renderAccount() {
    const state$ = $('acctState');
    const out = $('btnSignOut');
    const inn = $('btnSignIn');
    if (!state$) return;
    if (account) {
      state$.textContent = `signed in as ${account}`;
      state$.className = 'hint acct-signed';
      inn.textContent = 'Switch';
      out.style.display = '';
      $('acctHint').textContent =
        'Your record follows this name on any device. Sign in with the same name and PIN anywhere.';
    } else {
      state$.textContent = 'not signed in';
      state$.className = 'hint';
      inn.textContent = 'Sign in';
      out.style.display = 'none';
      $('acctHint').textContent =
        'First time with a name claims it. 4–8 digits. Without this, stats stay in this browser.';
    }
  }

  // ------------------------------------------------------------- socket
  function connect() {
    // Practice mode runs the identical server logic inside this page instead
    // of over a network, and hands us an object with the same shape as a
    // WebSocket. Everything below this line is unaware of the difference.
    if (window.__PRACTICE__) {
      ws = window.__PRACTICE__.connect(onMessage);
      return;
    }

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);

    ws.onopen = () => {
      reconnectDelay = 800;
      const saved = savedAccount();
      if (saved && saved.name && saved.pin) {
        sendMsg({ t: 'signIn', name: saved.name, pin: saved.pin });
      }
      if (currentScreen() === 'screen-landing') {
        sendMsg({ t: 'watchLobby' });
        requestBoard();
      }
    };

    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      onMessage(m);
    };

    ws.onclose = () => {
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.6, 8000);
    };

    ws.onerror = () => { /* onclose handles retry */ };
  }

  function sendMsg(m) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(m));
  }

  function onMessage(m) {
    switch (m.t) {
      case 'hello': renderStorageState(m.standings); break;
      case 'rooms': renderRoomList(m.rooms); break;
      case 'joined': myId = m.playerId; chatMsgs = []; break;
      case 'left':
        state = null; room = null; chatMsgs = [];
        resetCues();
        showScreen('screen-landing');
        requestBoard();
        break;
      case 'error': toast(m.msg); break;
      case 'event': onEvent(m); break;
      case 'chatHistory': chatMsgs = m.msgs || []; renderChat(); break;
      case 'chat': pushChat(m.msg); break;
      case 'leaderboard':
        if (m.account !== undefined) { account = m.account; renderAccount(); }
        renderLeaderboard(m.rows, m.mine);
        break;
      case 'account':
        account = m.handle;
        renderAccount();
        if (m.handle) toast(m.created ? `Name claimed — welcome, ${m.handle}` : `Signed in as ${m.handle}`);
        break;
      case 'state':
        room = m.room;
        state = m.game;
        render();
        break;
    }
  }

  function resetCues() {
    cue.myTurn = false;
    cue.phase = null;
    cue.roundIndex = -1;
    cue.trickLen = 0;
    cue.winnerSeat = undefined;
    cue.finished = false;
  }

  function onEvent(e) {
    if (e.kind === 'roundStart') {
      myOrder = [];
      hide($('resultOverlay'));
      playDealAnimation();
    }
    if (e.kind === 'bidsRevealed') Sound.play('bidsIn');
  }

  /** Fire audio cues for meaningful state transitions only. */
  function runCues() {
    const r = state.round;

    if (state.status === 'finished') {
      if (!cue.finished) { cue.finished = true; Sound.play('gameOver'); }
      return;
    }
    cue.finished = false;
    if (!r) return;

    if (state.roundIndex !== cue.roundIndex) {
      cue.roundIndex = state.roundIndex;
      cue.phase = null;
      cue.trickLen = 0;
      cue.winnerSeat = undefined;
      if (r.phase === 'bidding' && state.yourBid === null) Sound.play('bidNow');
    }

    if (r.phase !== cue.phase) {
      cue.phase = r.phase;
      // The bid reveal has its own server event, so it is not cued here.
      if (r.phase === 'roundEnd') Sound.play('roundEnd');
    }

    if (r.phase === 'trickEnd' && r.winnerSeat !== cue.winnerSeat) {
      cue.winnerSeat = r.winnerSeat;
      const mine = state.you && r.winnerSeat === state.you.seat;
      Sound.play(mine ? 'trickWon' : 'trickLost');
    }
    if (r.phase !== 'trickEnd') cue.winnerSeat = undefined;

    const len = r.trick.length;
    if (len > cue.trickLen) Sound.play('cardPlay');
    cue.trickLen = len;

    // No "your turn" chime on the blind round — nothing is being asked of you.
    const isMyTurn = !!(r.phase === 'playing' && !r.blind
      && state.you && r.currentSeat === state.you.seat);
    if (isMyTurn && !cue.myTurn) Sound.play('yourTurn');
    cue.myTurn = isMyTurn;
  }

  // ------------------------------------------------------------- screens
  function currentScreen() {
    const el = document.querySelector('.screen.active');
    return el ? el.id : null;
  }
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  }
  const show = (el) => el.classList.add('show');
  const hide = (el) => el.classList.remove('show');

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    show(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => hide(t), 3200);
  }

  function nameValue() {
    const v = $('nameInput').value.trim();
    if (v) { try { localStorage.setItem('db_name', v); } catch { /* private mode */ } }
    return v || 'Player';
  }

  // ------------------------------------------------------------- landing
  function renderRoomList(rooms) {
    const box = $('roomList');
    if (!rooms || !rooms.length) {
      box.innerHTML = '<p class="empty">No open tables right now. Create one and share the code, or hit Quick Play.</p>';
      return;
    }
    box.innerHTML = '';
    for (const r of rooms) {
      const row = document.createElement('div');
      row.className = 'room-row';
      row.innerHTML =
        `<span class="rc">${r.code}</span>` +
        `<span class="rn">${r.names.map(esc).join(', ') || 'empty'}` +
        `${r.bots ? ` <span style="opacity:.6">+ ${r.bots} bot${r.bots === 1 ? '' : 's'}</span>` : ''}</span>` +
        `<span class="rp">${r.players}/${r.max}</span>`;
      const btn = document.createElement('button');
      btn.className = 'btn tiny';
      btn.textContent = 'Join';
      btn.onclick = () => sendMsg({ t: 'joinRoom', code: r.code, name: nameValue(), deviceId });
      row.appendChild(btn);
      box.appendChild(row);
    }
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ------------------------------------------------------------- render
  function render() {
    if (!state) return;
    if (state.status === 'lobby') {
      resetCues();
      renderLobby();
      showScreen('screen-lobby');
      return;
    }
    showScreen('screen-game');
    renderGame();
    runCues();
  }

  function renderLobby() {
    $('lobbyCode').textContent = room.code;
    $('lobbyPrivacy').textContent = room.isPrivate
      ? 'Private table — only people with the code can join.'
      : 'Listed publicly. Anyone can find and join this table.';

    const isHost = selfId() === room.hostId;
    const MIN = room.minPlayers || 5;
    const MAX = room.maxPlayers || 10;

    const box = $('lobbyPlayers');
    box.innerHTML = '';
    for (const p of state.players) {
      const c = document.createElement('span');
      c.className = 'chip' + (p.id === room.hostId ? ' host' : '') + (p.fill ? ' bot' : '');
      c.innerHTML = esc(p.name) +
        (p.id === room.hostId ? ' (host)' : '') +
        (p.fill ? '<span class="tag">BOT</span>' : '');
      // The host can clear a bot out to leave the seat open for a person.
      if (p.fill && isHost) {
        const x = document.createElement('button');
        x.className = 'kick';
        x.title = 'Remove this bot';
        x.textContent = '×';
        x.onclick = () => sendMsg({ t: 'removeBot', botId: p.id });
        c.appendChild(x);
      }
      box.appendChild(c);
    }

    const total = state.players.length;
    const humans = room.humans != null ? room.humans : total;
    const bots = room.bots || 0;
    const need = Math.max(0, MIN - total);

    const who = `<b>${humans}</b> ${humans === 1 ? 'person' : 'people'}` +
      (bots ? ` and <b>${bots}</b> bot${bots === 1 ? '' : 's'}` : '');
    $('lobbyStatus').innerHTML = need > 0
      ? `${who} seated. A table needs ${MIN} seats — add ${need} more ` +
        `${need === 1 ? 'player or bot' : 'players or bots'} to start.`
      : `${who} seated. Ready when you are.`;

    // Host-only seating controls.
    const bc = $('botControls');
    bc.classList.toggle('show', isHost);
    const rc = $('ruleControls');
    rc.classList.toggle('show', isHost);
    const opts = room.options || {};
    $('ruleBlindBonus').checked = !!opts.blindBonus;
    $('ruleBotChat').checked = opts.botChat !== false;
    if (isHost) {
      const picker = $('sizePicker');
      picker.innerHTML = '';
      for (let n = MIN; n <= MAX; n++) {
        const b = document.createElement('button');
        b.textContent = n;
        b.className = n === total ? 'on' : '';
        b.disabled = n < humans; // can't shrink below the people already here
        b.title = n < humans ? `${humans} people are already seated` : `Seat ${n} players`;
        b.onclick = () => sendMsg({ t: 'tableSize', size: n });
        picker.appendChild(b);
      }
      const fill = $('btnFillBots');
      fill.disabled = total >= MAX;
      fill.textContent = need > 0 ? `Add ${need} bot${need === 1 ? '' : 's'} and be ready` : 'Add a bot';
      fill.onclick = () => sendMsg(need > 0 ? { t: 'tableSize', size: MIN } : { t: 'addBot' });
      $('botHint').textContent =
        'Bots fill seats so you can play without a full table. They follow suit, ' +
        'chase their bids, and never appear in the all-time standings. Anyone who ' +
        'joins later takes a bot’s seat automatically.';
    }

    const btn = $('btnStart');
    btn.disabled = !(isHost && room.canStart);
    btn.textContent = isHost
      ? (room.canStart ? `Start game — ${total} players` : `Need ${need} more`)
      : 'Waiting for the host to start';

    $('lobbyPreview').textContent = total >= MIN
      ? `With ${total} players: ${Math.floor(51 / total)} cards each in round 1, ` +
        `${2 * Math.floor(51 / total) - 1} rounds total.`
      : '';
  }

  function renderGame() {
    const r = state.round;
    $('gameCode').textContent = room.code;

    renderRoundInfo();
    renderScoreboard();
    renderLog();
    renderLastTrick();
    renderSeats();
    renderCenter();
    renderHand();
    renderTrumpChip();
    renderBidOverlay();
    renderRevealOverlay();
    renderResultOverlay();
    void r;
  }

  /** Trump repeated beside the hand, where your eyes are when choosing. */
  function renderTrumpChip() {
    const chip = $('trumpChip');
    const r = state.round;
    if (!chip) return;
    if (!r) { chip.className = 'trump-chip'; chip.innerHTML = ''; return; }
    if (r.noTrump) {
      chip.className = 'trump-chip show none';
      chip.innerHTML = '<span class="lab">no trump</span><span class="val">this round</span>';
      return;
    }
    chip.className = 'trump-chip show' + (isRed(r.trumpSuit) ? ' red' : '');
    chip.innerHTML = `<span class="lab">trump</span>` +
      `<span class="suit">${SUIT_SYMBOL[r.trumpSuit]}</span>` +
      `<span class="val">${SUIT_NAMES[r.trumpSuit]}</span>`;
  }

  function renderRoundInfo() {
    const r = state.round;
    const box = $('roundInfo');
    if (!r) {
      box.innerHTML = '<span class="big">Game over</span>';
      return;
    }
    const ladder = state.schedule
      .map((n, i) => (i === state.roundIndex ? `<b>${n}</b>` : n))
      .join(' · ');
    const trump = r.noTrump
      ? '<span class="trump-tag none">NO TRUMP this round</span>'
      : `<span class="trump-tag">Trump: ${SUIT_SYMBOL[r.trumpSuit]} ${SUIT_NAMES[r.trumpSuit]}</span>`;

    box.innerHTML =
      `<span class="big">Round ${state.roundIndex + 1} of ${state.totalRounds}</span>` +
      `${r.cardsPerHand} card${r.cardsPerHand === 1 ? '' : 's'} each · ` +
      `trick ${Math.min(r.trickNumber, r.tricksTotal)} of ${r.tricksTotal}<br>` +
      trump +
      `<div class="ladder" style="margin-top:8px">${ladder}</div>` +
      (r.bidsRevealed
        ? `<div style="margin-top:6px">Bids total <b>${r.totalBid}</b> vs <b>${r.tricksTotal}</b> tricks available</div>`
        : '');
  }

  function renderScoreboard() {
    const players = state.players.slice().sort((a, b) => b.score - a.score || a.seat - b.seat);
    const top = players.length ? players[0].score : 0;
    let html = '<table><thead><tr><th>Player</th><th class="num">Bid</th><th class="num">Won</th><th class="num">Score</th></tr></thead><tbody>';
    for (const p of players) {
      const cls = [p.id === selfId() ? 'me' : '', p.score === top && top > 0 ? 'lead' : ''].filter(Boolean).join(' ');
      const bid = state.round && state.round.bidsRevealed ? p.bid
        : (p.id === selfId() && state.yourBid !== null ? state.yourBid : (p.hasBid ? '•' : '–'));
      html += `<tr class="${cls}"><td>${esc(p.name)}</td>` +
        `<td class="num">${bid === null ? '–' : bid}</td>` +
        `<td class="num">${state.round ? p.tricksWon : '–'}</td>` +
        `<td class="num">${p.score}</td></tr>`;
    }
    html += '</tbody></table>';
    $('scoreboard').innerHTML = html;
  }

  function renderLog() {
    $('logBox').innerHTML = (state.log || [])
      .slice()
      .reverse()
      .map((l) => `<div>${esc(l.text)}</div>`)
      .join('');
  }

  /**
   * Where a seat sits on the oval. Index 0 is always you, at the bottom, and
   * the rest run clockwise from there. `pull` shrinks the radius, which is how
   * played cards get drawn just inside their owner.
   */
  function seatPos(seat, pull) {
    const n = state.players.length;
    const mySeat = state.you ? state.you.seat : 0;
    const k = (seat - mySeat + n) % n;
    const theta = (Math.PI / 2) + (k * 2 * Math.PI) / n;
    const f = pull == null ? 1 : pull;
    return { x: 50 + 40 * f * Math.cos(theta), y: 50 + 39 * f * Math.sin(theta) };
  }

  function renderSeats() {
    const box = $('seats');
    const r = state.round;

    box.innerHTML = '';
    for (const p of state.players) {
      const { x, y } = seatPos(p.seat);
      const isMe = p.id === selfId();

      const el = document.createElement('div');
      el.className = 'seat';
      el.style.left = x + '%';
      el.style.top = y + '%';

      const isTurn = !!(r && r.phase === 'playing' && r.currentSeat === p.seat);
      const tookIt = !!(r && r.winnerSeat === p.seat);
      if (isTurn) el.classList.add('active');
      if (tookIt) el.classList.add('winner');
      if (isMe) el.classList.add('me', 'is-me');
      if (r && r.leadSeat === p.seat && (r.phase === 'bidding' || r.phase === 'bidReveal')) {
        el.classList.add('is-leader');
      }
      if (!p.connected) el.classList.add('offline');
      if (r && r.bidsRevealed) {
        if (p.tricksWon === p.bid) el.classList.add('bid-hit');
        else if (p.tricksWon > p.bid) el.classList.add('bid-over');
      }

      // One badge at a time, most urgent first. Who leads is announced from
      // the moment the round is dealt — before bidding, not after — because on
      // the blind round that is the single most useful thing you know.
      let badge = '';
      if (tookIt) badge = '<div class="badge took">took it</div>';
      else if (isTurn) badge = `<div class="badge turn">${isMe ? 'your turn' : 'to play'}</div>`;
      else if (r && (r.phase === 'bidding' || r.phase === 'bidReveal') && r.leadSeat === p.seat) {
        badge = isMe
          ? '<div class="badge lead you-lead">▶ you lead</div>'
          : '<div class="badge lead">leads first</div>';
      } else if (r && r.phase === 'playing' && r.leadSeat === p.seat && !r.trick.length) {
        badge = '<div class="badge lead">leads</div>';
      } else if (r && r.phase === 'playing' && r.leadSeat === p.seat) {
        badge = '<div class="badge lead">led</div>';
      }

      // A big standing number next to the name once the bids are open.
      const bidNum = r && r.bidsRevealed && p.bid !== null
        ? `<div class="bidnum${p.bid === 0 ? ' zero' : ''}">${p.bid}</div>`
        : '';

      // Two short lines rather than one long one — at seat width, a single
      // line wraps mid-phrase and is hard to read at a glance.
      let meta = '';
      let pips = '';
      if (r) {
        if (r.bidsRevealed) {
          const diff = p.tricksWon - p.bid;
          const cls = diff === 0 ? 'hit' : diff > 0 ? 'over' : 'under';
          meta = `<span class="${cls}">${p.tricksWon} of ${p.bid}</span>`;
          // A dot per bid trick, filled as they take them; red dots are overtricks.
          const dots = [];
          for (let i = 0; i < p.bid; i++) dots.push(`<span class="pip${i < p.tricksWon ? ' won' : ''}"></span>`);
          for (let i = p.bid; i < p.tricksWon; i++) dots.push('<span class="pip over"></span>');
          if (dots.length) pips = `<div class="tricks-pips">${dots.join('')}</div>`;
        } else {
          meta = p.hasBid ? '<span class="hit">bid in ✓</span>' : 'thinking…';
        }
        meta += `<div class="pts">${p.score} pts</div>`;
      }

      // On the blind single-card round, everyone else's card is face up.
      let blind = '';
      if (r && r.blind && p.visibleHand && p.visibleHand.length) {
        blind = `<div class="blindcards">${p.visibleHand.map((c) => cardHTML(c, 'sm')).join('')}</div>`;
      } else if (r && r.blind && isMe) {
        blind = `<div class="blindcards">${p.handCount ? '<div class="card sm back"></div>' : ''}</div>`;
      }

      el.innerHTML =
        badge + bidNum +
        `<div class="avatar">` +
        `<div class="nm">${esc(p.name)}${p.isBot ? '<span class="bot-tag">BOT</span>' : ''}</div>` +
        `<div class="meta">${meta}</div>` +
        pips +
        blind +
        `</div>`;
      box.appendChild(el);
    }
  }

  function cardHTML(id, size) {
    const c = parse(id);
    const cls = ['card', size || '', isRed(c.suit) ? 'red' : ''].filter(Boolean).join(' ');
    return `<div class="${cls}" data-card="${id}">` +
      `<span class="r">${label(c.rank)}</span><span class="s">${SUIT_SYMBOL[c.suit]}</span></div>`;
  }

  function renderCenter() {
    const r = state.round;
    const trumpBox = $('trumpBlock');
    const trickBox = $('trickLayer');
    const msg = $('centerMsg');

    if (!r) { trumpBox.innerHTML = ''; trickBox.innerHTML = ''; msg.textContent = ''; return; }

    const tc = parse(r.trumpCard);
    trumpBox.innerHTML =
      `<div class="tlabel">turned up</div>` +
      `<div class="card sm ${isRed(tc.suit) ? 'red' : ''} trumpcard">` +
      `<span class="r">${label(tc.rank)}</span><span class="s">${SUIT_SYMBOL[tc.suit]}</span></div>` +
      `<div class="tname ${r.noTrump ? 'none' : ''}">` +
      `${r.noTrump ? 'NO TRUMP' : SUIT_SYMBOL[r.trumpSuit] + ' ' + SUIT_NAMES[r.trumpSuit]}</div>`;

    renderTrick(trickBox, r);

    paintStatus();
  }

  /** The live status line, mirrored into the felt and the mobile bar. */
  function paintStatus() {
    const m = centerMessage();
    const centre = $('centerMsg');
    centre.innerHTML = m.html;
    centre.className = 'center-msg' + (m.big ? ' big' : '');
    const bar = $('statusBar');
    if (bar) {
      bar.innerHTML = m.html;
      bar.className = 'status-bar' + (m.big ? ' big' : '');
    }
  }

  /**
   * Each played card is drawn just inside the seat that played it.
   *
   * Built incrementally on purpose: blowing away innerHTML on every state
   * update restarts the deal-in animation on every card at once, which makes
   * the whole trick flicker and wash out. Cards already on the table keep
   * their DOM node; only genuinely new plays animate in.
   */
  function renderTrick(box, r) {
    const want = r.trick.map((x) => `${state.roundIndex}:${r.trickNumber}:${x.seat}:${x.card}`);
    const have = [...box.children].map((el) => el.dataset.key);
    const isPrefix = want.length >= have.length && have.every((k, i) => k === want[i]);

    if (!isPrefix) box.innerHTML = '';
    const existing = isPrefix ? have.length : 0;

    for (let i = existing; i < r.trick.length; i++) {
      const x = r.trick[i];
      const c = parse(x.card);
      const { x: px, y: py } = seatPos(x.seat, 0.52);
      const el = document.createElement('div');
      el.className = 'trick-slot';
      el.dataset.key = want[i];
      el.dataset.seat = String(x.seat);
      el.style.left = px + '%';
      el.style.top = py + '%';
      el.innerHTML =
        `<span class="order">${i + 1}</span>` +
        `<div class="card ${isRed(c.suit) ? 'red' : ''}">` +
        `<span class="r">${label(c.rank)}</span><span class="s">${SUIT_SYMBOL[c.suit]}</span></div>` +
        `<div class="who">${esc(x.name)}</div>`;
      box.appendChild(el);
    }

    // Win/lose styling is applied to the surviving nodes, not rebuilt.
    const settled = r.winnerSeat !== undefined;
    [...box.children].forEach((el, i) => {
      const seat = Number(el.dataset.seat);
      el.classList.toggle('led', i === 0);
      el.classList.toggle('winner', r.winnerSeat === seat);
      el.classList.toggle('faded', settled && r.winnerSeat !== seat);
      // While the trick is still open, mark whichever card is on pace to take
      // it, so you can judge whether it is worth attacking.
      el.classList.toggle('leading', !settled && r.leadingSeat === seat);
    });
  }

  function centerMessage() {
    const r = state.round;
    if (!r) return { html: '' };
    const me = state.you;
    const secs = Math.max(0, Math.ceil((r.deadline - Date.now()) / 1000));
    const clock = `<span class="timer-ring${secs <= 5 ? ' urgent' : ''}">${secs}s</span>`;

    if (r.phase === 'bidding') {
      const waiting = state.players.filter((p) => !p.hasBid).length;
      const leader = state.players.find((p) => p.seat === r.leadSeat);
      const leadLine = leader
        ? `<span class="sub">${me && leader.seat === me.seat ? 'You lead' : esc(leader.name) + ' leads'} the first trick</span>`
        : '';
      return { html: `Sealed bidding — ${waiting} still to bid · ${clock}${leadLine}` };
    }
    if (r.phase === 'bidReveal') {
      const total = state.players.reduce((s, p) => s + (p.bid || 0), 0);
      return { big: true, html: `${total} bid · ${r.tricksTotal} available` };
    }
    if (r.phase === 'trickEnd') {
      const w = state.players.find((p) => p.seat === r.winnerSeat);
      if (!w) return { html: '' };
      const card = r.trick.find((x) => x.seat === r.winnerSeat);
      const withCard = card ? parse(card.card) : null;
      const why = withCard
        ? (r.trumpSuit && withCard.suit === r.trumpSuit
          ? ` with ${label(withCard.rank)}${SUIT_SYMBOL[withCard.suit]} (trump)`
          : ` with ${label(withCard.rank)}${SUIT_SYMBOL[withCard.suit]}`)
        : '';
      const mine = me && r.winnerSeat === me.seat;
      return {
        big: true,
        html: `${mine ? 'You take' : esc(w.name) + ' takes'} the trick` +
          `<span class="sub">${why.trim()} · they lead the next one</span>`,
      };
    }
    if (r.phase === 'roundEnd') return { big: true, html: 'Round over — scoring…' };
    if (r.phase === 'playing') {
      const cur = state.players.find((p) => p.seat === r.currentSeat);
      if (!cur) return { html: '' };
      if (r.blind) {
        // Nobody is choosing anything — say so rather than implying a wait.
        return {
          html: `${esc(cur.name)}'s card turns over` +
            `<span class="sub">Blind round — cards play themselves, ` +
            `${r.trick.length} of ${state.players.length} turned</span>`,
        };
      }
      const leading = r.trick.length === 0;
      const suit = r.ledSuit
        ? `<span class="sub">Led ${SUIT_SYMBOL[r.ledSuit]} ${SUIT_NAMES[r.ledSuit]} · ` +
          `${r.trick.length} of ${state.players.length} played</span>`
        : `<span class="sub">Trick ${r.trickNumber} of ${r.tricksTotal} · any card may be led</span>`;
      const who = me && cur.seat === me.seat
        ? (leading ? 'Your lead' : 'Your turn')
        : `${esc(cur.name)} ${leading ? 'leads' : 'to play'}`;
      return { html: `${who} · ${clock}${suit}` };
    }
    return { html: '' };
  }

  /* --------------------------------------------------------- bid reveal
     All bids flip at once in their own phase; no card can be played until it
     is over, so it is a real beat in the round rather than a line of text. */
  let revealKey = null;

  function renderRevealOverlay() {
    const ov = $('revealOverlay');
    const r = state.round;
    if (!r || r.phase !== 'bidReveal') { hide(ov); revealKey = null; return; }

    // Build once per round. Rebuilding would restart every flip animation
    // mid-reveal and make the numbers blink.
    const key = `${state.roundIndex}`;
    if (revealKey === key) { show(ov); return; }
    revealKey = key;

    const total = state.players.reduce((s, p) => s + (p.bid || 0), 0);
    const tricks = r.tricksTotal;
    const diff = total - tricks;

    $('revealGrid').innerHTML = state.players
      .slice()
      .sort((a, b) => a.seat - b.seat)
      .map((p, i) => {
        const cls = ['reveal-player',
          p.bid === 0 ? 'zero' : '',
          p.bid >= Math.ceil(tricks / 2) && p.bid > 1 ? 'bold' : '',
          p.id === selfId() ? 'mine' : ''].filter(Boolean).join(' ');
        // Stagger the flips so they read left to right.
        return `<div class="${cls}" style="animation-delay:${i * 70}ms">` +
          `<div class="bignum">${p.bid}</div>` +
          `<div class="who">${esc(p.name)}</div></div>`;
      }).join('');

    $('revealTotal').innerHTML =
      `<span>${total} bid</span><span class="vs">vs</span>` +
      `<span>${tricks} trick${tricks === 1 ? '' : 's'} available</span>`;

    const v = $('revealVerdict');
    if (diff > 0) {
      v.className = 'reveal-verdict over';
      v.innerHTML = `Over by ${diff}` +
        `<span class="why">The table has bid more tricks than exist — at least ` +
        `${diff === 1 ? 'one player' : 'some players'} must come up short.</span>`;
    } else if (diff < 0) {
      v.className = 'reveal-verdict under';
      v.innerHTML = `Under by ${-diff}` +
        `<span class="why">${-diff} trick${diff === -1 ? '' : 's'} nobody wants. ` +
        `Someone is going to be handed ${diff === -1 ? 'one' : 'them'} whether they like it or not.</span>`;
    } else {
      v.className = 'reveal-verdict even';
      v.innerHTML = 'Dead even' +
        `<span class="why">Bids match the tricks exactly. Everybody can still hit — ` +
        `and everybody can still be wrecked.</span>`;
    }
    show(ov);
  }

  /* ------------------------------------------------------- deal animation
     Purely cosmetic: a quick shuffle and a card flicked to every seat, so a
     new round announces itself instead of just appearing. */
  let dealingUntil = 0;

  function playDealAnimation() {
    const layer = $('dealLayer');
    if (!layer || !state || !state.players.length) return;
    const felt = $('felt');
    const w = felt.clientWidth || 800;
    const h = felt.clientHeight || 400;

    layer.innerHTML = '<div class="deal-stack"></div>';
    dealingUntil = Date.now() + 1150;
    felt.classList.add('dealing'); // hides the centre text so the deck is clear

    const cardsEach = Math.min(3, (state.round && state.round.cardsPerHand) || 1);
    let i = 0;
    for (let pass = 0; pass < cardsEach; pass++) {
      for (const p of state.players) {
        const { x, y } = seatPos(p.seat, 0.92);
        const el = document.createElement('div');
        el.className = 'deal-card';
        el.style.setProperty('--dx', ((x - 50) / 100) * w + 'px');
        el.style.setProperty('--dy', ((y - 50) / 100) * h + 'px');
        el.style.setProperty('--rot', (pass * 9 - 9) + 'deg');
        el.style.animationDelay = (500 + i * 22) + 'ms';
        layer.appendChild(el);
        i++;
      }
    }
    setTimeout(() => {
      layer.innerHTML = '';
      felt.classList.remove('dealing');
      render();
    }, 1200);
  }

  /** A small replay of the previous trick, so a fast table stays followable. */
  function renderLastTrick() {
    const box = $('lastTrick');
    const r = state.round;
    const lt = r && r.lastTrick;
    if (!lt || !lt.plays.length) { box.innerHTML = ''; return; }
    const winner = state.players.find((p) => p.seat === lt.winnerSeat);
    box.innerHTML =
      `<div class="lt-head">Last trick — ${winner ? esc(winner.name) : '?'} took it</div>` +
      `<div class="lt-cards">` +
      lt.plays.map((x) => {
        const c = parse(x.card);
        const won = x.seat === lt.winnerSeat;
        return `<div class="lt-item${won ? ' won' : ''}">` +
          `<div class="card xs ${isRed(c.suit) ? 'red' : ''}">` +
          `<span class="r">${label(c.rank)}</span><span class="s">${SUIT_SYMBOL[c.suit]}</span></div>` +
          `<div class="nm">${esc(x.name)}</div></div>`;
      }).join('') +
      `</div>`;
  }

  // ------------------------------------------------------------- hand
  function orderedHand() {
    const hand = state.yourHand || [];
    const set = new Set(hand);
    const out = myOrder.filter((id) => set.has(id));
    for (const id of hand) if (!out.includes(id)) out.push(id);
    myOrder = out;
    return out;
  }

  function renderHand() {
    const box = $('hand');
    const r = state.round;
    const hint = $('handHint');
    const lbl = $('handLabel');

    if (r && r.blind) {
      const me = state.players.find((p) => p.id === selfId());
      lbl.textContent = 'Your card (hidden from you)';
      box.innerHTML = me && me.handCount ? '<div class="card back"></div>' : '';
      // One card, unseen: there is nothing to decide, so the server plays it
      // for everyone in turn. Never ask for a click that has no meaning.
      const myTurnBlind = !!(r.phase === 'playing' && state.you && r.currentSeat === state.you.seat);
      const el = box.querySelector('.card');
      if (el) el.classList.toggle('autoplaying', myTurnBlind);
      hint.textContent = myTurnBlind
        ? 'Your card is playing itself — nothing to choose on this round.'
        : (r.phase === 'playing'
          ? 'Cards play themselves this round. You can see everyone else’s, not your own.'
          : 'Blind round: you can see everyone else’s card but not your own.');
      return;
    }

    lbl.textContent = 'Your hand';
    const hand = orderedHand();
    const legal = state.legal ? new Set(state.legal) : null;
    const myTurn = !!(r && r.phase === 'playing' && state.you && r.currentSeat === state.you.seat);

    box.innerHTML = '';
    for (const id of hand) {
      const c = parse(id);
      const el = document.createElement('div');
      const playable = myTurn && legal && legal.has(id);
      el.className = 'card' + (isRed(c.suit) ? ' red' : '') +
        (playable ? ' playable' : '') +
        (myTurn && legal && !legal.has(id) ? ' illegal' : '');
      el.dataset.card = id;
      el.draggable = true;
      el.innerHTML = `<span class="r">${label(c.rank)}</span><span class="s">${SUIT_SYMBOL[c.suit]}</span>`;

      el.addEventListener('click', () => {
        if (!myTurn) return toast('Not your turn yet.');
        if (legal && !legal.has(id)) {
          return toast(`You must follow ${SUIT_NAMES[r.ledSuit]} — you still hold one.`);
        }
        sendMsg({ t: 'play', card: id });
      });

      attachDrag(el, id);
      box.appendChild(el);
    }

    if (!myTurn) {
      hint.textContent = 'Drag cards to reorder them.';
    } else if (!r.ledSuit) {
      hint.textContent = 'You lead — play any card. Drag to reorder.';
    } else if (legal && legal.size === hand.length) {
      // Void in the led suit: everything is legal, which is worth saying
      // outright rather than leaving the player to work out.
      hint.textContent = `You have no ${SUIT_NAMES[r.ledSuit]} — play anything.` +
        (r.trumpSuit ? ` A ${SUIT_NAMES[r.trumpSuit]} would take the trick.` : '');
    } else {
      hint.textContent =
        `You must follow ${SUIT_SYMBOL[r.ledSuit]} ${SUIT_NAMES[r.ledSuit]}. Drag to reorder.`;
    }
  }

  // Pointer-based drag reordering (works with mouse and touch).
  let dragId = null;
  function attachDrag(el, id) {
    el.addEventListener('dragstart', (e) => {
      dragId = id;
      el.classList.add('dragging');
      try { e.dataTransfer.setData('text/plain', id); e.dataTransfer.effectAllowed = 'move'; } catch { /* older browsers */ }
    });
    el.addEventListener('dragend', () => {
      dragId = null;
      el.classList.remove('dragging');
      clearDropHints();
    });
    el.addEventListener('dragover', (e) => {
      if (!dragId || dragId === id) return;
      e.preventDefault();
      clearDropHints();
      const before = e.offsetX < el.offsetWidth / 2;
      el.classList.add(before ? 'drop-left' : 'drop-right');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-left', 'drop-right'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!dragId || dragId === id) return;
      const before = e.offsetX < el.offsetWidth / 2;
      reorder(dragId, id, before);
      clearDropHints();
    });

    // Touch fallback: long-press-free swap by dragging across cards.
    let startX = null;
    el.addEventListener('touchstart', (e) => { startX = e.touches[0].clientX; }, { passive: true });
    el.addEventListener('touchend', (e) => {
      if (startX === null) return;
      const endX = e.changedTouches[0].clientX;
      if (Math.abs(endX - startX) < 24) { startX = null; return; }
      const target = document.elementFromPoint(endX, e.changedTouches[0].clientY);
      const card = target && target.closest ? target.closest('.card[data-card]') : null;
      if (card && card.dataset.card !== id) {
        reorder(id, card.dataset.card, endX < startX);
        e.preventDefault();
      }
      startX = null;
    });
  }

  function clearDropHints() {
    document.querySelectorAll('.hand .card').forEach((c) => c.classList.remove('drop-left', 'drop-right'));
  }

  function reorder(movingId, targetId, before) {
    const arr = orderedHand().filter((x) => x !== movingId);
    const at = arr.indexOf(targetId);
    if (at === -1) return;
    arr.splice(before ? at : at + 1, 0, movingId);
    myOrder = arr;
    sendMsg({ t: 'reorder', order: arr });
    renderHand();
  }

  function sortBy(mode) {
    const r = state.round;
    const suits = ['S', 'H', 'D', 'C'];
    const trump = r && r.trumpSuit;
    const arr = orderedHand().slice().map(parse);
    if (mode === 'suit') {
      arr.sort((a, b) => {
        const sa = trump && a.suit === trump ? -1 : suits.indexOf(a.suit);
        const sb = trump && b.suit === trump ? -1 : suits.indexOf(b.suit);
        return sa - sb || b.rank - a.rank;
      });
    } else {
      arr.sort((a, b) => b.rank - a.rank || suits.indexOf(a.suit) - suits.indexOf(b.suit));
    }
    myOrder = arr.map((c) => c.id);
    sendMsg({ t: 'reorder', order: myOrder });
    renderHand();
  }

  // ------------------------------------------------------------- bidding

  /**
   * Whether you open the round is the single biggest thing shaping a bid, so
   * it gets a banner rather than a clause in a sentence.
   */
  function paintLeadBanner(r) {
    const el = $('leadBanner');
    if (!el) return '';
    const leader = state.players.find((p) => p.seat === r.leadSeat);
    if (!leader) { el.className = 'lead-banner'; el.innerHTML = ''; return ''; }
    const iLead = !!(state.you && leader.seat === state.you.seat);
    if (iLead) {
      el.className = 'lead-banner show you';
      el.innerHTML = '<span class="icon">▶</span><span>YOU LEAD THIS ROUND' +
        '<span class="sub">You choose the first card. Nobody sets the suit for you.</span></span>';
    } else {
      el.className = 'lead-banner show them';
      el.innerHTML = `<span class="icon">▶</span><span><b>${esc(leader.name)}</b> leads this round` +
        '<span class="sub">They open; you follow their suit if you can.</span></span>';
    }
    return iLead;
  }

  function bidButtonsInto(box, maxBid) {
    if (box.childElementCount === maxBid + 1) return;
    box.innerHTML = '';
    for (let i = 0; i <= maxBid; i++) {
      const b = document.createElement('button');
      b.className = 'btn';
      b.textContent = i;
      b.onclick = () => sendMsg({ t: 'bid', n: i });
      box.appendChild(b);
    }
  }

  /**
   * On the blind round the whole point is reading the other nine cards before
   * you commit, so the bid controls go in the hand dock and the felt is left
   * completely unobscured. Every other round uses the panel over the felt,
   * where your own hand is what matters and is visible below it.
   */
  function renderBidOverlay() {
    const r = state.round;
    const ov = $('bidOverlay');
    const dock = $('bidDock');

    if (!r || r.phase !== 'bidding') { hide(ov); dock.classList.remove('show'); return; }

    // Hold the bid UI back until the deal animation has finished, so the round
    // opens with the cards arriving rather than a panel appearing over them.
    if (Date.now() < dealingUntil) { hide(ov); dock.classList.remove('show'); return; }

    const already = state.players.filter((p) => p.hasBid).length;
    const leader = state.players.find((p) => p.seat === r.leadSeat);
    const iLead = !!(state.you && leader && leader.seat === state.you.seat);
    const leadLine = leader
      ? `<b>${iLead ? 'You lead' : esc(leader.name) + ' leads'} the first trick.</b> `
      : '';
    const left = state.players.filter((p) => !p.hasBid).map((p) => p.name);
    const secs = Math.max(0, Math.ceil((r.deadline - Date.now()) / 1000));
    const clock = `<span class="timer-ring${secs <= 5 ? ' urgent' : ''}">${secs}s</span>`;

    if (r.blind) {
      hide(ov);
      dock.classList.add('show');
      if (state.yourBid !== null) {
        dock.innerHTML =
          `<div class="bd-title">You bid ${state.yourBid}</div>` +
          `<div class="bd-sub">${left.length ? 'Waiting on ' + left.map(esc).join(', ') + '…' : 'Revealing bids…'}</div>`;
        return;
      }
      if (!dock.querySelector('#bidDockButtons')) {
        dock.innerHTML =
          `<div class="bd-title">Blind round — will you take the trick?</div>` +
          `<div class="bd-sub" id="bidDockSub"></div>` +
          `<div class="bid-buttons" id="bidDockButtons"></div>`;
      }
      $('bidDockSub').innerHTML =
        (iLead
          ? '<span class="you-lead-inline">▶ YOU LEAD THIS ROUND.</span> '
          : leadLine) +
        `Every other player's card is face up on the table. Yours is not. ` +
        (r.noTrump ? 'No trump this round. ' : `${SUIT_SYMBOL[r.trumpSuit]} ${SUIT_NAMES[r.trumpSuit]} is trump. `) +
        `${already} of ${state.players.length} have bid · ${clock}`;
      bidButtonsInto($('bidDockButtons'), r.maxBid);
      return;
    }

    dock.classList.remove('show');
    show(ov);
    paintLeadBanner(r);

    if (state.yourBid !== null) {
      $('bidButtons').innerHTML = '';
      $('bidSub').textContent = `You bid ${state.yourBid}.`;
      $('bidWaiting').textContent = left.length
        ? `Waiting on ${left.join(', ')}…`
        : 'Revealing bids…';
      return;
    }

    $('bidSub').innerHTML =
      leadLine +
      `How many of the ${r.tricksTotal} trick${r.tricksTotal === 1 ? '' : 's'} will you take? ` +
      (r.noTrump ? 'No trump this round. ' : `${SUIT_NAMES[r.trumpSuit]} is trump. `) + clock;
    bidButtonsInto($('bidButtons'), r.maxBid);
    $('bidWaiting').textContent =
      `${already} of ${state.players.length} have bid. All bids reveal together.`;
  }

  // ------------------------------------------------------------- results
  let boardRequestedForGame = false;

  function renderResultOverlay() {
    const ov = $('resultOverlay');
    const r = state.round;

    if (state.status === 'finished') {
      const sorted = state.players.slice().sort((a, b) => b.score - a.score);
      const top = sorted[0].score;
      const winners = sorted.filter((p) => p.score === top);
      $('resultTitle').textContent = winners.length === 1
        ? `${winners[0].name} wins!`
        : `Tie at ${top} points`;
      $('resultBody').innerHTML = resultTable(
        sorted.map((p) => ({ name: p.name, total: p.score })), true);
      $('resultSub').textContent = selfId() === room.hostId
        ? 'Play again keeps everyone seated and resets the scores.'
        : 'Waiting for the host to start another game.';
      $('endButtons').style.display = '';
      $('btnRematch').style.display = selfId() === room.hostId ? '' : 'none';
      if (!boardRequestedForGame) { boardRequestedForGame = true; setTimeout(requestBoard, 600); }
      show(ov);
      return;
    }
    boardRequestedForGame = false;

    if (r && r.phase === 'roundEnd' && r.results) {
      $('resultTitle').textContent = `Round ${state.roundIndex + 1} scored`;
      $('resultBody').innerHTML = resultTable(r.results, false);
      const nextIdx = state.roundIndex + 1;
      $('resultSub').textContent = nextIdx < state.totalRounds
        ? `Next: round ${nextIdx + 1} with ${state.schedule[nextIdx]} card${state.schedule[nextIdx] === 1 ? '' : 's'} each.`
        : 'That was the final round.';
      $('endButtons').style.display = 'none';
      $('careerBox').classList.remove('show');
      show(ov);
      return;
    }
    hide(ov);
  }

  function resultTable(rows, finalOnly) {
    let html = '<table class="result-table"><thead><tr><th>Player</th>';
    if (!finalOnly) html += '<th class="num">Bid</th><th class="num">Took</th><th class="num">Points</th>';
    html += '<th class="num">Total</th></tr></thead><tbody>';
    for (const x of rows) {
      html += `<tr><td>${esc(x.name)}</td>`;
      if (!finalOnly) {
        const cls = x.gained >= 10 ? 'gain-hit' : x.gained === 0 ? 'gain-zero' : 'gain-over';
        html += `<td class="num">${x.bid}</td><td class="num">${x.tricksWon}</td>` +
          `<td class="num ${cls}">+${x.gained}</td>`;
      }
      html += `<td class="num">${x.total}</td></tr>`;
    }
    return html + '</tbody></table>';
  }

  // -------------------------------------------------------------- chat
  /* Chat is unfiltered by request. The one thing done to every message is
     HTML escaping — without it any player could inject script into everyone
     else's browser and read their hand. That is an XSS defence, not a word
     filter: the text itself is passed through completely untouched. */
  let chatMsgs = [];
  let chatUnread = 0;
  let chatCollapsed = false;

  function pushChat(msg) {
    chatMsgs.push(msg);
    if (chatMsgs.length > 120) chatMsgs.shift();
    if (!msg.system && msg.playerId !== selfId()) {
      Sound.play('chat');
      if (chatCollapsed) chatUnread += 1;
    }
    renderChat();
  }

  function chatHTML() {
    if (!chatMsgs.length) {
      return '<div class="chat-empty">No messages yet. Say hello.</div>';
    }
    return chatMsgs.map((m) => {
      if (m.system) return `<div class="chat-msg system">${esc(m.text)}</div>`;
      const mine = m.playerId === selfId() ? ' mine' : '';
      return `<div class="chat-msg${mine}">` +
        `<span class="who">${esc(m.from)}</span>` +
        `<span class="body">${esc(m.text)}</span></div>`;
    }).join('');
  }

  function renderChat() {
    const html = chatHTML();
    for (const id of ['chatLog', 'chatLog2']) {
      const box = $(id);
      if (!box) continue;
      const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
      box.innerHTML = html;
      if (atBottom) box.scrollTop = box.scrollHeight;
    }
    const btn = $('btnChatToggle');
    if (btn) {
      btn.innerHTML = (chatCollapsed ? 'Show' : 'Hide') +
        (chatUnread ? `<span class="chat-badge">${chatUnread}</span>` : '');
    }
  }

  function sendChat(input) {
    const text = input.value;
    if (!text.trim()) return;
    sendMsg({ t: 'chat', text });
    input.value = '';
  }

  // Say plainly whether this server keeps standings forever or only until it
  // next restarts. Free hosts with no disk do the latter, and the difference
  // is invisible until a week of records vanishes.
  function renderStorageState(s) {
    const el = $('storageState');
    if (!el || !s) return;
    el.classList.remove('durable', 'fragile');
    if (s.durable) {
      el.classList.add('durable');
      el.textContent = 'Standings are saved to a database — they survive restarts. '
        + 'Sign in above and your record follows you to any device.';
    } else {
      el.classList.add('fragile');
      el.textContent = 'Heads up: this server has no database attached, so standings '
        + 'reset whenever it restarts or sleeps. Games still play normally.';
    }
  }

  // -------------------------------------------------------- leaderboard
  function requestBoard() {
    sendMsg({ t: 'leaderboard', deviceId });
  }

  function pct(x) { return `${Math.round(x * 100)}%`; }

  function renderLeaderboard(rows, mine) {
    const box = $('leaderboard');
    if (!rows || !rows.length) {
      box.innerHTML = '<p class="empty">No games recorded yet. Finish one and it shows up here.</p>';
    } else {
      let html = '<table><thead><tr><th></th><th>Player</th><th class="num">W</th>' +
        '<th class="num">Games</th><th class="num">Avg</th><th class="num">Best</th>' +
        '<th class="num">On bid</th></tr></thead><tbody>';
      rows.forEach((r, i) => {
        const me = r.isMe ? ' class="me"' : '';
        html += `<tr${me}><td class="rankcell">${i + 1}</td><td>${esc(r.name)}</td>` +
          `<td class="num">${r.wins}</td><td class="num">${r.games}</td>` +
          `<td class="num">${r.avgScore.toFixed(0)}</td><td class="num">${r.bestScore}</td>` +
          `<td class="num">${pct(r.accuracy)}</td></tr>`;
      });
      box.innerHTML = html + '</tbody></table>';
    }

    const ms = $('myStats');
    if (mine) {
      ms.classList.add('show');
      ms.innerHTML =
        `<b>${esc(mine.name)}</b> — rank <b>${mine.rank}</b> of ${mine.of}` +
        `<div class="row">` +
        `<span><b>${mine.games}</b> ${mine.games === 1 ? 'game' : 'games'}</span>` +
        `<span><b>${mine.wins}</b> wins (${pct(mine.winRate)})</span>` +
        `<span>avg <b>${mine.avgScore.toFixed(0)}</b></span>` +
        `<span>best <b>${mine.bestScore}</b></span>` +
        `<span>hit bid <b>${pct(mine.accuracy)}</b></span>` +
        `<span><b>${mine.tricks}</b> tricks</span>` +
        `</div>`;
    } else {
      ms.classList.remove('show');
    }

    // Also reflect career stats on the end-of-game screen.
    const cb = $('careerBox');
    if (cb && mine && state && state.status === 'finished') {
      cb.classList.add('show');
      const g = mine.games === 1 ? 'game' : 'games';
      const w = mine.wins === 1 ? 'win' : 'wins';
      cb.innerHTML = `All-time: <b>${mine.games}</b> ${g}, <b>${mine.wins}</b> ${w}, ` +
        `rank <b>${mine.rank}</b> of ${mine.of}, best score <b>${mine.bestScore}</b>.`;
    }
  }

  // ------------------------------------------------------------- wiring
  $('nameInput').value = savedName;

  $('btnQuickPlay').onclick = () => sendMsg({ t: 'quickPlay', name: nameValue(), deviceId });
  $('btnCreate').onclick = () =>
    sendMsg({ t: 'createRoom', name: nameValue(), private: $('privateCheck').checked, deviceId });
  $('btnJoin').onclick = () => {
    const code = $('codeInput').value.trim().toUpperCase();
    if (!code) return toast('Enter a table code first.');
    sendMsg({ t: 'joinRoom', code, name: nameValue(), deviceId });
  };
  $('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnJoin').click(); });

  $('btnStart').onclick = () => sendMsg({ t: 'start' });
  $('btnLeave').onclick = () => sendMsg({ t: 'leaveRoom' });
  $('btnCopy').onclick = async () => {
    const url = `${location.origin}/?code=${room.code}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('Invite link copied.');
    } catch {
      toast(url);
    }
  };

  $('btnSortSuit').onclick = () => sortBy('suit');
  $('btnSortRank').onclick = () => sortBy('rank');
  $('btnScoreToggle').onclick = () => $('scoreboard').classList.toggle('open');
  $('btnBackToLobby').onclick = () => {
    hide($('resultOverlay'));
    sendMsg({ t: 'leaveRoom' });
  };
  $('btnRematch').onclick = () => {
    hide($('resultOverlay'));
    sendMsg({ t: 'rematch' });
  };

  // chat
  $('chatForm').addEventListener('submit', (e) => { e.preventDefault(); sendChat($('chatInput')); });
  $('chatForm2').addEventListener('submit', (e) => { e.preventDefault(); sendChat($('chatInput2')); });
  $('btnChatToggle').onclick = () => {
    chatCollapsed = !chatCollapsed;
    if (!chatCollapsed) chatUnread = 0;
    document.querySelector('#sidebar .chat').classList.toggle('collapsed', chatCollapsed);
    renderChat();
  };
  $('chatInput').addEventListener('focus', () => { chatUnread = 0; renderChat(); });

  // sound
  const soundBtn = $('btnSound');
  const paintSound = () => {
    soundBtn.textContent = Sound.enabled ? '🔊' : '🔇';
    soundBtn.title = Sound.enabled ? 'Sound on — click to mute' : 'Muted — click to unmute';
  };
  soundBtn.onclick = () => { Sound.toggle(); paintSound(); };
  paintSound();
  // Browsers refuse to play audio until the user has interacted with the page.
  document.addEventListener('pointerdown', () => Sound.warm(), { once: true });
  document.addEventListener('keydown', () => Sound.warm(), { once: true });

  // leaderboard
  $('btnRefreshBoard').onclick = requestBoard;

  // account
  (function wireAccount() {
    const saved = savedAccount();
    if (saved && saved.name) $('acctName').value = saved.name;
    $('btnSignIn').onclick = () => {
      const name = $('acctName').value.trim();
      const pin = $('acctPin').value.trim();
      if (!name || name.length < 2) return toast('Pick a name of at least two characters.');
      if (!/^\d{4,8}$/.test(pin)) return toast('PIN must be 4 to 8 digits.');
      rememberAccount(name, pin);
      sendMsg({ t: 'signIn', name, pin });
      $('acctPin').value = '';
    };
    $('btnSignOut').onclick = () => {
      forgetAccount();
      sendMsg({ t: 'signOut' });
      toast('Signed out. Stats will stay in this browser.');
    };
    $('acctPin').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnSignIn').click(); });
    renderAccount();
  })();

  // table rules (host only; the server rejects anyone else)
  $('ruleBlindBonus').onchange = (e) =>
    sendMsg({ t: 'setRule', rule: 'blindBonus', on: e.target.checked });
  $('ruleBotChat').onchange = (e) =>
    sendMsg({ t: 'setRule', rule: 'botChat', on: e.target.checked });

  // Prefill a code from an invite link.
  const urlCode = new URLSearchParams(location.search).get('code');
  if (urlCode) $('codeInput').value = urlCode.toUpperCase();

  // Repaint the countdowns once a second without a server round-trip.
  setInterval(() => {
    if (!state || !state.round) return;
    if (currentScreen() !== 'screen-game') return;
    // Only the clock changes between server updates; leave the trick alone so
    // the "took it" animation is not restarted every second.
    paintStatus();
    if (state.round.phase === 'bidding' && state.yourBid === null) renderBidOverlay();
  }, 1000);

  connect();
})();
