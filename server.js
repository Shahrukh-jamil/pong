const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.get('/', (req, res) => res.status(200).send('pong-server-ok'));
app.get('/healthz', (req, res) => res.status(200).send('ok'));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// World/constants (server-authoritative physics)
const WORLD = { W: 900, H: 1600 };
const TICK_RATE = 60;         // physics updates per second
const SEND_RATE = 30;         // state broadcast rate
const MAX_DT = 0.05;          // clamp dt to avoid huge steps
const PADDING = 70;
const PADDLE_WIDTH_FRAC = 0.28;
const PADDLE_HEIGHT_FRAC = 0.02;
const BALL_RADIUS_FRAC = 0.018;
const INIT_BALL_SPEED = 780;  // units/sec
const MAX_BALL_SPEED = 1200;
const SPEED_UP = 1.03;        // speed up on every paddle hit
const MAX_BOUNCE_ANGLE = 1.05; // radians relative to vertical (~60°)
const HEARTS_START = 3;

const rooms = new Map();    // roomId -> room
const waitingQueue = [];    // array of ws
const clients = new Map();  // clientId -> ws

function safeSend(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function nowMs() {
  return Date.now();
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function sanitizeName(raw) {
  if (!raw || typeof raw !== 'string') return 'Player';
  let name = raw.trim().slice(0, 16);
  // Basic sanitization: remove control chars
  name = name.replace(/[\x00-\x1F\x7F]/g, '');
  if (!name) name = 'Player';
  return name;
}

function opponentSide(side) {
  return side === 'top' ? 'bottom' : 'top';
}

function makeRoom(a, b, swapSides = false) {
  const id = uuidv4();
  const W = WORLD.W;
  const H = WORLD.H;
  const pw = PADDLE_WIDTH_FRAC * W;
  const ph = PADDLE_HEIGHT_FRAC * H;
  const r = BALL_RADIUS_FRAC * W;
  const topY = PADDING + ph * 0.5;
  const bottomY = H - (PADDING + ph * 0.5);

  let bottom = a, top = b;
  if (swapSides) {
    bottom = b;
    top = a;
  } else {
    if (Math.random() < 0.5) {
      bottom = b;
      top = a;
    }
  }

  top.side = 'top';
  bottom.side = 'bottom';
  top.roomId = id;
  bottom.roomId = id;

  const room = {
    id,
    players: {
      top: { ws: top, id: top.id, name: top.name, hearts: HEARTS_START },
      bottom: { ws: bottom, id: bottom.id, name: bottom.name, hearts: HEARTS_START }
    },
    params: { W, H, pw, ph, r, topY, bottomY },
    paddles: { topX: 0.5, bottomX: 0.5 },
    ball: { x: W / 2, y: H / 2, vx: 0, vy: 0, speed: INIT_BALL_SPEED },
    phase: 'countdown', // countdown | playing | between | gameover
    serveToward: Math.random() < 0.5 ? 'top' : 'bottom',
    nextPhaseAt: nowMs() + 3000,
    lastTickAt: nowMs(),
    lastBroadcastAt: 0,
    rematchVotes: { top: false, bottom: false },
    loops: { tick: null, send: null }
  };

  rooms.set(id, room);

  // Send match found to both
  const playersPayloadTop = [
    { name: room.players.top.name, side: 'top' },
    { name: room.players.bottom.name, side: 'bottom' }
  ];
  const playersPayloadBottom = [
    { name: room.players.top.name, side: 'top' },
    { name: room.players.bottom.name, side: 'bottom' }
  ];

  safeSend(top, {
    type: 'matchFound',
    roomId: id,
    players: playersPayloadTop,
    you: 'top',
    countdown: 3
  });
  safeSend(bottom, {
    type: 'matchFound',
    roomId: id,
    players: playersPayloadBottom,
    you: 'bottom',
    countdown: 3
  });

  startLoops(room);
  return room;
}

function startLoops(room) {
  room.loops.tick = setInterval(() => tick(room), 1000 / TICK_RATE);
  room.loops.send = setInterval(() => broadcastState(room), 1000 / SEND_RATE);
}

function stopLoops(room) {
  if (room.loops.tick) clearInterval(room.loops.tick);
  if (room.loops.send) clearInterval(room.loops.send);
  room.loops.tick = null;
  room.loops.send = null;
}

function destroyRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  stopLoops(room);
  rooms.delete(roomId);
}

function tick(room) {
  const t = nowMs();
  let dt = (t - room.lastTickAt) / 1000;
  room.lastTickAt = t;
  if (dt <= 0) return;
  if (dt > MAX_DT) dt = MAX_DT;

  // Handle phase transitions
  if (room.phase !== 'playing') {
    if (t >= room.nextPhaseAt && room.phase !== 'gameover') {
      if (room.phase === 'countdown' || room.phase === 'between') {
        // serve
        serveBall(room);
        room.phase = 'playing';
      }
    }
    return; // Do not integrate physics during pauses
  }

  integrate(room, dt);
}

function serveBall(room) {
  const { W, H } = room.params;
  room.ball.x = W / 2;
  room.ball.y = H / 2;
  let angle = (Math.random() * 0.8) - 0.4; // -0.4..0.4 rad around vertical
  const dir = room.serveToward === 'top' ? -1 : 1; // vy direction
  const s = INIT_BALL_SPEED;
  room.ball.speed = s;
  room.ball.vx = s * Math.sin(angle);
  room.ball.vy = dir * Math.cos(angle);
}

function integrate(room, dt) {
  const { W, H, pw, ph, r, topY, bottomY } = room.params;
  const b = room.ball;

  // Move
  b.x += b.vx * dt;
  b.y += b.vy * dt;

  // Walls (left/right)
  if (b.x - r <= 0) {
    b.x = r;
    b.vx = Math.abs(b.vx);
  } else if (b.x + r >= W) {
    b.x = W - r;
    b.vx = -Math.abs(b.vx);
  }

  // Paddle collisions
  // Top paddle
  const topX = room.paddles.topX * W;
  if (b.vy < 0 && (b.y - r) <= (topY + ph / 2) && (b.y + r) >= (topY - ph / 2)) {
    const minX = topX - pw / 2;
    const maxX = topX + pw / 2;
    if (b.x + r >= minX && b.x - r <= maxX) {
      // Hit top paddle, reflect downward
      paddleBounce(room, 'top', topX);
      return;
    }
  }
  // Bottom paddle
  const bottomX = room.paddles.bottomX * W;
  if (b.vy > 0 && (b.y + r) >= (bottomY - ph / 2) && (b.y - r) <= (bottomY + ph / 2)) {
    const minX = bottomX - pw / 2;
    const maxX = bottomX + pw / 2;
    if (b.x + r >= minX && b.x - r <= maxX) {
      // Hit bottom paddle, reflect upward
      paddleBounce(room, 'bottom', bottomX);
      return;
    }
  }

  // Miss check (top/bottom out)
  if (b.y + r < 0) {
    // Top missed
    onScore(room, 'top');
    return;
  }
  if (b.y - r > H) {
    // Bottom missed
    onScore(room, 'bottom');
    return;
  }
}

function paddleBounce(room, side, paddleCenterX) {
  const { pw } = room.params;
  const b = room.ball;
  const rel = clamp((b.x - paddleCenterX) / (pw / 2), -1, 1); // -1 .. 1
  // Compute new speed
  const newSpeed = clamp(b.speed * SPEED_UP, 100, MAX_BALL_SPEED);
  // Angle relative to vertical axis
  const angle = rel * MAX_BOUNCE_ANGLE;
  b.vx = newSpeed * Math.sin(angle);
  if (side === 'top') {
    b.vy = Math.abs(newSpeed * Math.cos(angle));
  } else {
    b.vy = -Math.abs(newSpeed * Math.cos(angle));
  }
  b.speed = newSpeed;
}

function onScore(room, loserSide) {
  if (room.phase !== 'playing') return;
  room.phase = 'between';

  const loser = room.players[loserSide];
  const winnerSide = opponentSide(loserSide);
  loser.hearts = Math.max(0, loser.hearts - 1);

  // Broadcast score update immediately
  broadcastEvent(room, {
    type: 'score',
    hearts: {
      top: room.players.top.hearts,
      bottom: room.players.bottom.hearts
    },
    lastMiss: loserSide
  });

  const topHearts = room.players.top.hearts;
  const bottomHearts = room.players.bottom.hearts;

  if (topHearts <= 0 && bottomHearts <= 0) {
    // Tie (edge case)
    endGame(room, null, 'tie');
    return;
  } else if (loser.hearts <= 0) {
    endGame(room, winnerSide, 'hearts');
    return;
  }

  // Prepare next serve toward the player who just lost the point
  room.serveToward = loserSide;
  room.nextPhaseAt = nowMs() + 1500;
  // Freeze ball
  room.ball.vx = 0;
  room.ball.vy = 0;
  room.ball.x = room.params.W / 2;
  room.ball.y = room.params.H / 2;
  room.ball.speed = INIT_BALL_SPEED;
}

function endGame(room, winnerSide, reason) {
  room.phase = 'gameover';
  room.ball.vx = 0;
  room.ball.vy = 0;

  broadcastEvent(room, {
    type: 'gameOver',
    winner: winnerSide, // 'top' | 'bottom' | null (tie)
    reason,
    hearts: {
      top: room.players.top.hearts,
      bottom: room.players.bottom.hearts
    }
  });

  // The room will stay open to allow rematch until someone leaves
}

function broadcastState(room) {
  const t = nowMs();
  const payload = {
    type: 'state',
    t,
    phase: room.phase,
    ball: { x: room.ball.x, y: room.ball.y },
    paddles: {
      topX: room.paddles.topX,
      bottomX: room.paddles.bottomX
    },
    hearts: {
      top: room.players.top.hearts,
      bottom: room.players.bottom.hearts
    },
    params: {
      W: room.params.W,
      H: room.params.H,
      r: room.params.r,
      pw: room.params.pw,
      ph: room.params.ph
    },
    you: null // filled per-socket
  };

  // Send individualized (you) value
  ['top', 'bottom'].forEach(side => {
    const player = room.players[side];
    if (!player || !player.ws || player.ws.readyState !== WebSocket.OPEN) return;
    payload.you = side;
    safeSend(player.ws, payload);
  });
}

function broadcastEvent(room, event) {
  ['top', 'bottom'].forEach(side => {
    const player = room.players[side];
    if (player && player.ws && player.ws.readyState === WebSocket.OPEN) {
      safeSend(player.ws, event);
    }
  });
}

function requestRematch(room, side) {
  if (!room || room.phase !== 'gameover') return;
  room.rematchVotes[side] = true;

  // Notify the other
  const other = opponentSide(side);
  const opp = room.players[other];
  if (opp && opp.ws && opp.ws.readyState === WebSocket.OPEN) {
    safeSend(opp.ws, { type: 'rematchOffered' });
  }

  if (room.rematchVotes.top && room.rematchVotes.bottom) {
    // Start rematch; swap sides for fairness
    startRematch(room);
  }
}

function startRematch(oldRoom) {
  const a = oldRoom.players.top.ws;
  const b = oldRoom.players.bottom.ws;

  // Reset client flags
  oldRoom.rematchVotes.top = false;
  oldRoom.rematchVotes.bottom = false;

  // Create a new room with swapped sides
  const newRoom = makeRoom(a, b, true);

  // Reset hearts
  newRoom.players.top.hearts = HEARTS_START;
  newRoom.players.bottom.hearts = HEARTS_START;
  newRoom.phase = 'countdown';
  newRoom.nextPhaseAt = nowMs() + 3000;

  // Tell clients rematch started
  broadcastEvent(newRoom, {
    type: 'rematchStart',
    countdown: 3
  });

  // Destroy the old room
  destroyRoom(oldRoom.id);
}

function leaveRoom(ws, reason = 'left') {
  if (!ws.roomId) return;
  const room = rooms.get(ws.roomId);
  if (!room) {
    ws.roomId = null;
    return;
  }

  // Announce opponent left if applicable
  const side = ws.side;
  const otherSide = opponentSide(side);
  const opp = room.players[otherSide];

  if (room.phase !== 'gameover' && opp && opp.ws && opp.ws.readyState === WebSocket.OPEN) {
    // Forfeit win for opponent
    broadcastEvent(room, {
      type: 'gameOver',
      winner: otherSide,
      reason: 'disconnect',
      hearts: {
        top: room.players.top.hearts,
        bottom: room.players.bottom.hearts
      }
    });
  }

  // Remove this player
  room.players[side].ws = null;

  // If both gone, clean room
  if (!room.players.top.ws && !room.players.bottom.ws) {
    destroyRoom(room.id);
  }

  ws.roomId = null;
  ws.side = null;
}

function tryMatch() {
  // Filter out invalid items
  for (let i = waitingQueue.length - 1; i >= 0; i--) {
    const c = waitingQueue[i];
    if (!c || c.readyState !== WebSocket.OPEN || c.roomId) {
      waitingQueue.splice(i, 1);
    }
  }

  while (waitingQueue.length >= 2) {
    const a = waitingQueue.shift();
    const b = waitingQueue.shift();
    if (!a || !b) continue;
    if (a.readyState !== WebSocket.OPEN || b.readyState !== WebSocket.OPEN) continue;
    makeRoom(a, b);
  }
}

// WebSocket connection handling
wss.on('connection', (ws) => {
  ws.id = uuidv4();
  ws.name = 'Player';
  ws.roomId = null;
  ws.side = null;
  ws.isAlive = true;

  clients.set(ws.id, ws);

  safeSend(ws, { type: 'hello', id: ws.id });

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'joinQueue': {
        const name = sanitizeName(msg.name);
        ws.name = name;
        // Avoid duplicates in queue
        if (!ws.roomId && !waitingQueue.includes(ws)) {
          waitingQueue.push(ws);
          safeSend(ws, { type: 'finding', queueSize: waitingQueue.length });
          tryMatch();
        }
        break;
      }
      case 'cancelQueue': {
        const idx = waitingQueue.indexOf(ws);
        if (idx >= 0) waitingQueue.splice(idx, 1);
        safeSend(ws, { type: 'queueCancelled' });
        break;
      }
      case 'paddle': {
        if (!ws.roomId || ws.side !== 'top' && ws.side !== 'bottom') return;
        const room = rooms.get(ws.roomId);
        if (!room) return;
        const x = clamp(Number(msg.x), 0, 1);
        if (ws.side === 'top') room.paddles.topX = x;
        else room.paddles.bottomX = x;
        break;
      }
      case 'rematchRequest': {
        if (!ws.roomId || !ws.side) return;
        const room = rooms.get(ws.roomId);
        if (!room) return;
        requestRematch(room, ws.side);
        break;
      }
      case 'leaveRoom': {
        leaveRoom(ws, 'left');
        break;
      }
      default:
        safeSend(ws, { type: 'error', message: 'Unknown message type' });
    }
  });

  ws.on('close', () => {
    // Remove from queue
    const idx = waitingQueue.indexOf(ws);
    if (idx >= 0) waitingQueue.splice(idx, 1);

    // Leave room if in one
    leaveRoom(ws, 'closed');
    clients.delete(ws.id);
  });

  ws.on('error', () => {
    // Graceful cleanup on error
    const idx = waitingQueue.indexOf(ws);
    if (idx >= 0) waitingQueue.splice(idx, 1);
    leaveRoom(ws, 'error');
    clients.delete(ws.id);
  });
});

// Keep-alive and stale client cleanup
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch {}
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 30000);

wss.on('close', function close() {
  clearInterval(interval);
});

server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
