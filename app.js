// Set this to your Render WebSocket URL:
const SERVER_URL = 'wss://YOUR-RENDER-SERVICE.onrender.com';

const WORLD = { W: 900, H: 1600 }; // must match server
const HEARTS_START = 3;

const app = {
  ws: null,
  connected: false,
  name: '',
  roomId: null,
  you: null, // 'top' | 'bottom'
  phase: 'countdown', // mirror server
  hearts: { top: HEARTS_START, bottom: HEARTS_START },
  paddles: { topX: 0.5, bottomX: 0.5 }, // normalized 0..1 (server authoritative)
  ball: { x: WORLD.W / 2, y: WORLD.H / 2 }, // world units from server
  // interpolation buffer
  stateBuf: [],
  lastStateTime: 0,
  // Input
  input: { active: false, lastSentAt: 0, sendHz: 30 },
  // Canvas
  canvas: null,
  ctx: null,
  dpr: Math.max(1, Math.min(3, window.devicePixelRatio || 1)),
  rafId: null
};

const $ = sel => document.querySelector(sel);
const screens = {
  home: $('#screen-home'),
  finding: $('#screen-finding'),
  game: $('#screen-game')
};
const overlay = $('#overlay');
const overlayContent = $('#overlayContent');
const overlayActions = $('#overlayActions');

const topNameEl = $('#topName');
const bottomNameEl = $('#bottomName');
const topHeartsEl = $('#topHearts');
const bottomHeartsEl = $('#bottomHearts');

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
}

function setOverlay(html, actionsHtml = '') {
  overlayContent.innerHTML = html;
  overlayActions.innerHTML = actionsHtml;
  overlay.classList.remove('hidden');
}
function hideOverlay() {
  overlay.classList.add('hidden');
}

function heartsStr(n) {
  const full = '❤️'.repeat(n);
  const empty = '🤍'.repeat(Math.max(0, HEARTS_START - n));
  return full + empty;
}

function connectAndQueue(name) {
  if (app.ws && app.connected) {
    try { app.ws.close(); } catch {}
  }
  app.ws = new WebSocket(SERVER_URL);
  app.connected = false;

  app.ws.onopen = () => {
    app.connected = true;
    // Join queue
    app.ws.send(JSON.stringify({ type: 'joinQueue', name }));
  };

  app.ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleServerMessage(msg);
  };

  app.ws.onclose = () => {
    app.connected = false;
    // If mid-game, show disconnect overlay
    if (screens.game.classList.contains('active')) {
      setOverlay(`
        <h2>Connection lost</h2>
        <p>Please check your internet and try again.</p>
      `, `
        <button class="btn" onclick="goHome()">Home</button>
      `);
    } else {
      showScreen('home');
    }
  };

  app.ws.onerror = () => {
    // handled by onclose
  };
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'hello': {
      // server handshake
      break;
    }
    case 'finding': {
      showScreen('finding');
      break;
    }
    case 'queueCancelled': {
      showScreen('home');
      break;
    }
    case 'matchFound': {
      app.roomId = msg.roomId;
      app.you = msg.you; // 'top' or 'bottom'
      const youIsBottom = app.you === 'bottom';

      const top = msg.players.find(p => p.side === 'top');
      const bottom = msg.players.find(p => p.side === 'bottom');

      topNameEl.textContent = top.name;
      bottomNameEl.textContent = bottom.name;

      app.hearts = { top: HEARTS_START, bottom: HEARTS_START };
      updateHUD();

      showScreen('game');
      hideOverlay();

      setOverlay(`
        <h2>Match found</h2>
        <p>${youIsBottom ? 'You are Bottom' : 'You are Top'} • Get ready!</p>
        <h1 style="font-size:56px;margin:10px 0;">${msg.countdown}</h1>
      `);

      // Overlay will hide once game actually starts (state messages)
      break;
    }
    case 'state': {
      app.phase = msg.phase;
      app.hearts = msg.hearts;
      app.paddles.topX = msg.paddles.topX;
      app.paddles.bottomX = msg.paddles.bottomX;

      // buffer states for interpolation
      app.stateBuf.push({ t: msg.t, ball: { x: msg.ball.x, y: msg.ball.y } });
      if (app.stateBuf.length > 4) app.stateBuf.shift();

      updateHUD();

      // If this is the first state after countdown, hide overlay
      if (!overlay.classList.contains('hidden') && (app.phase === 'playing' || app.phase === 'between')) {
        hideOverlay();
        // Show a small hint once
        setTimeout(() => {
          setOverlay(`
            <p>Tip: Drag anywhere on your half to move the paddle.</p>
          `, `<button class="btn primary" onclick="hideOverlay()">OK</button>`);
          setTimeout(hideOverlay, 2000);
        }, 200);
      }

      break;
    }
    case 'score': {
      app.hearts = msg.hearts;
      updateHUD();
      break;
    }
    case 'gameOver': {
      const winner = msg.winner; // 'top' | 'bottom' | null
      const isTie = winner === null;
      const youWin = !isTie && winner === app.you;
      const title = isTie ? 'Tie Game' : youWin ? 'You Win!' : 'You Lose';
      const reason = msg.reason === 'disconnect' ? 'Opponent disconnected' :
                     msg.reason === 'hearts' ? '' : msg.reason;

      setOverlay(`
        <h2>${title}</h2>
        <p>${reason || 'Play again?'}</p>
      `, `
        <button class="btn primary" onclick="requestRematch()">Rematch</button>
        <button class="btn" onclick="goHome()">Home</button>
      `);
      break;
    }
    case 'rematchOffered': {
      setOverlay(`
        <h2>Rematch?</h2>
        <p>Your opponent wants a rematch.</p>
      `, `
        <button class="btn primary" onclick="requestRematch()">Accept</button>
        <button class="btn" onclick="goHome()">Home</button>
      `);
      break;
    }
    case 'rematchStart': {
      app.hearts = { top: HEARTS_START, bottom: HEARTS_START };
      updateHUD();
      setOverlay(`
        <h2>Rematch starting</h2>
        <h1 style="font-size:56px;margin:10px 0;">${msg.countdown}</h1>
      `);
      break;
    }
    case 'error': {
      // Non-fatal: show message briefly
      setOverlay(`<p>${msg.message || 'Error'}</p>`, `<button class="btn" onclick="hideOverlay()">Dismiss</button>`);
      break;
    }
  }
}

function updateHUD() {
  topHeartsEl.textContent = heartsStr(app.hearts.top);
  bottomHeartsEl.textContent = heartsStr(app.hearts.bottom);
}

// Canvas + rendering
function setupCanvas() {
  const canvas = document.getElementById('gameCanvas');
  app.canvas = canvas;
  app.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // Input: drag anywhere on your half to control your paddle
  const onPointer = (e) => {
    e.preventDefault();
    if (!app.you) return;

    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left);
    const y = (e.clientY - rect.top);

    const myHalfTop = app.you === 'top';
    const inMyHalf = myHalfTop ? (y < rect.height / 2) : (y >= rect.height / 2);
    if (!inMyHalf) return;

    const nx = clamp(x / rect.width, 0, 1);
    sendPaddle(nx);
  };

  canvas.addEventListener('pointerdown', onPointer, { passive: false });
  canvas.addEventListener('pointermove', onPointer, { passive: false });

  // Prevent default gestures
  ['touchstart', 'touchmove', 'gesturestart', 'dblclick'].forEach(evt =>
    canvas.addEventListener(evt, e => e.preventDefault(), { passive: false })
  );

  startRenderLoop();
}

function resizeCanvas() {
  // Portrait first; fill viewport
  const w = app.canvas.clientWidth;
  const h = app.canvas.clientHeight;
  const dpr = app.dpr;

  app.canvas.width = Math.floor(w * dpr);
  app.canvas.height = Math.floor(h * dpr);
}

function startRenderLoop() {
  cancelAnimationFrame(app.rafId);
  const loop = () => {
    draw();
    app.rafId = requestAnimationFrame(loop);
  };
  loop();
}

function draw() {
  const ctx = app.ctx;
  const cw = app.canvas.width;
  const ch = app.canvas.height;
  const dpr = app.dpr;

  ctx.clearRect(0, 0, cw, ch);

  // Map world->screen
  const scaleX = cw / WORLD.W;
  const scaleY = ch / WORLD.H;

  // Interpolate ball smoothly between last two states
  const ball = interpBall();
  const ballX = ball.x * scaleX;
  const ballY = ball.y * scaleY;

  // Paddle positions
  const pw = 0.28 * WORLD.W * scaleX; // scaleX already applied
  const ph = 0.02 * WORLD.H * scaleY;
  const r = 0.018 * WORLD.W * scaleX;

  const topY = (70 + (0.02 * WORLD.H) / 2) * scaleY;
  const bottomY = (WORLD.H - (70 + (0.02 * WORLD.H) / 2)) * scaleY;

  const topX = app.paddles.topX * cw;
  const bottomX = app.paddles.bottomX * cw;

  // Court mid line
  ctx.save();
  ctx.globalAlpha = 0.2;
  ctx.strokeStyle = '#ffffff';
  ctx.setLineDash([10, 14]);
  ctx.beginPath();
  ctx.moveTo(cw / 2, 0);
  ctx.lineTo(cw / 2, ch);
  ctx.stroke();
  ctx.restore();

  // Paddles
  drawPaddle(ctx, topX, topY, pw, ph);
  drawPaddle(ctx, bottomX, bottomY, pw, ph);

  // Ball
  ctx.fillStyle = '#f1f5f9';
  ctx.beginPath();
  ctx.arc(ballX, ballY, r, 0, Math.PI * 2);
  ctx.fill();

  // Names under paddles (subtle)
  ctx.font = `${Math.max(12, Math.floor(14 * app.dpr))}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.globalAlpha = 0.45;
  ctx.fillStyle = '#d1d5db';
  ctx.fillText('TOP: ' + topNameEl.textContent, topX, topY - 10);
  ctx.fillText('BOTTOM: ' + bottomNameEl.textContent, bottomX, bottomY + 18);
  ctx.globalAlpha = 1;
}

function drawPaddle(ctx, cx, cy, w, h) {
  const x = cx - w / 2;
  const y = cy - h / 2;
  const r = Math.min(h / 2, 12);
  ctx.fillStyle = '#6ae39c';
  roundRect(ctx, x, y, w, h, r);
  ctx.fill();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function interpBall() {
  const buf = app.stateBuf;
  if (buf.length === 0) return app.ball;

  // keep the last state for reference
  const now = performance.now();
  // simple: use the most recent
  if (buf.length === 1) {
    app.ball = buf[0].ball;
    return app.ball;
  }
  // interpolate between last two by time
  const a = buf[buf.length - 2];
  const b = buf[buf.length - 1];
  const total = Math.max(1, b.t - a.t);
  const local = Math.min(total, now - b.t + total); // try to lag ~1 frame
  const alpha = clamp(local / total, 0, 1);
  app.ball = {
    x: a.ball.x + (b.ball.x - a.ball.x) * alpha,
    y: a.ball.y + (b.ball.y - a.ball.y) * alpha
  };
  return app.ball;
}

// Input sending (throttled)
function sendPaddle(nx) {
  // Throttle to ~30 Hz
  const t = performance.now();
  const minGap = 1000 / app.input.sendHz;
  if (t - app.input.lastSentAt < minGap) return;
  app.input.lastSentAt = t;

  if (app.ws && app.ws.readyState === WebSocket.OPEN) {
    app.ws.send(JSON.stringify({ type: 'paddle', x: nx }));
  }
}

// Buttons/flows
window.requestRematch = function requestRematch() {
  hideOverlay();
  if (app.ws && app.ws.readyState === WebSocket.OPEN) {
    app.ws.send(JSON.stringify({ type: 'rematchRequest' }));
    setOverlay(`<p>Waiting for opponent…</p>`, `<button class="btn" onclick="goHome()">Home</button>`);
  }
};

window.goHome = function goHome() {
  hideOverlay();
  // Tell server we are leaving room
  if (app.ws && app.ws.readyState === WebSocket.OPEN) {
    app.ws.send(JSON.stringify({ type: 'leaveRoom' }));
    try { app.ws.close(); } catch {}
  }
  app.ws = null;
  app.roomId = null;
  app.you = null;
  showScreen('home');
};

function initUI() {
  $('#startBtn').addEventListener('click', () => {
    const name = ($('#nameInput').value || '').trim().slice(0, 16);
    app.name = name || 'Player';
    showScreen('finding');
    connectAndQueue(app.name);
  });

  $('#cancelFindBtn').addEventListener('click', () => {
    if (app.ws && app.ws.readyState === WebSocket.OPEN) {
      app.ws.send(JSON.stringify({ type: 'cancelQueue' }));
      try { app.ws.close(); } catch {}
    }
    showScreen('home');
  });
}

// Init
window.addEventListener('load', () => {
  initUI();
  setupCanvas();
});

// Utility
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
