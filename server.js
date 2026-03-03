const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static('public'));

const rooms = new Map();
const clients = new Map();

const MAX_PLAYERS = 4;
const COLORS = ['#00ffff', '#ff00ff', '#ffff00', '#00ff44'];
const COLOR_NAMES = ['Cyan', 'Magenta', 'Yellow', 'Green'];

// ============== TRON ==============
const GRID = 80;
const TICK_MS = 100;
const SPAWNS = [
  { x: 10, y: 40, dir: 'right' },
  { x: 69, y: 40, dir: 'left' },
  { x: 40, y: 10, dir: 'down' },
  { x: 40, y: 69, dir: 'up' },
];
const OPPOSITES = { up: 'down', down: 'up', left: 'right', right: 'left' };

// ============== FROGGER ==============
const FROGGER_COLS = 11;
const FROGGER_ROWS = 12;
const FROGGER_TICK_MS = 180;
const FROGGER_GOAL_POINTS = 3;

function getRoom(roomKey) {
  if (!rooms.has(roomKey)) {
    rooms.set(roomKey, {
      players: [],
      state: 'waiting',
      gameType: null,
      grid: null,
      tickInterval: null,
      frogger: null,
    });
  }
  return rooms.get(roomKey);
}

function broadcastToRoom(roomKey, message) {
  const room = rooms.get(roomKey);
  if (!room) return;
  const data = JSON.stringify(message);
  for (const p of room.players) {
    if (p.ws.readyState === 1) p.ws.send(data);
  }
}

function sendLobby(roomKey) {
  const room = rooms.get(roomKey);
  if (!room) return;
  broadcastToRoom(roomKey, {
    type: 'lobby',
    state: room.state,
    gameType: room.gameType,
    players: room.players.map((p, i) => ({
      nickname: p.nickname,
      color: COLORS[i],
      colorName: COLOR_NAMES[i],
      score: p.score,
      lives: p.lives,
    })),
  });
}

// ---------- TRON ----------
function createGrid() {
  const grid = [];
  for (let y = 0; y < GRID; y++) {
    grid[y] = new Array(GRID).fill(0);
  }
  return grid;
}

function startTron(roomKey) {
  const room = rooms.get(roomKey);
  if (!room || room.players.length < 2) return;

  room.state = 'countdown';
  room.grid = createGrid();

  room.players.forEach((p, i) => {
    const s = SPAWNS[i];
    p.x = s.x;
    p.y = s.y;
    p.dir = s.dir;
    p.nextDir = s.dir;
    p.alive = true;
    p.color = COLORS[i];
    room.grid[s.y][s.x] = i + 1;
  });

  broadcastToRoom(roomKey, {
    type: 'gameInit',
    gameType: 'tron',
    grid: GRID,
    players: room.players.map((p) => ({
      nickname: p.nickname,
      x: p.x,
      y: p.y,
      dir: p.dir,
      alive: p.alive,
      color: p.color,
    })),
  });

  let count = 3;
  broadcastToRoom(roomKey, { type: 'countdown', count });

  const cdInterval = setInterval(() => {
    count--;
    if (count > 0) {
      broadcastToRoom(roomKey, { type: 'countdown', count });
    } else {
      clearInterval(cdInterval);
      room.state = 'playing';
      broadcastToRoom(roomKey, { type: 'go' });
      room.tickInterval = setInterval(() => tickTron(roomKey), TICK_MS);
    }
  }, 1000);
}

function tickTron(roomKey) {
  const room = rooms.get(roomKey);
  if (!room || room.state !== 'playing') return;

  const alive = room.players.filter((p) => p.alive);

  for (const p of alive) {
    p.dir = p.nextDir;
    switch (p.dir) {
      case 'up':    p.y--; break;
      case 'down':  p.y++; break;
      case 'left':  p.x--; break;
      case 'right': p.x++; break;
    }
  }

  for (const p of alive) {
    if (p.x < 0 || p.x >= GRID || p.y < 0 || p.y >= GRID) {
      p.alive = false;
      continue;
    }
    if (room.grid[p.y][p.x] !== 0) {
      p.alive = false;
      continue;
    }
    for (const other of alive) {
      if (other !== p && other.x === p.x && other.y === p.y) {
        p.alive = false;
        other.alive = false;
      }
    }
  }

  for (let i = 0; i < room.players.length; i++) {
    const p = room.players[i];
    if (p.alive && p.x >= 0 && p.x < GRID && p.y >= 0 && p.y < GRID) {
      room.grid[p.y][p.x] = i + 1;
    }
  }

  broadcastToRoom(roomKey, {
    type: 'tick',
    gameType: 'tron',
    players: room.players.map((p) => ({
      x: p.x,
      y: p.y,
      dir: p.dir,
      alive: p.alive,
    })),
  });

  const stillAlive = room.players.filter((p) => p.alive);
  if (stillAlive.length <= 1) {
    clearInterval(room.tickInterval);
    room.tickInterval = null;
    room.state = 'gameover';
    const winner = stillAlive.length === 1 ? stillAlive[0].nickname : null;
    broadcastToRoom(roomKey, { type: 'gameover', winner });
  }
}

// ---------- FROGGER ----------
function initFroggerObstacles() {
  const cars = [];
  const logs = [];
  const carLanes = [1, 2, 4];
  const logLanes = [5, 6, 8, 9];
  const carSpeeds = [1, -1, 1];
  const logSpeeds = [1, -1, 1, -1];
  for (let i = 0; i < carLanes.length; i++) {
    cars.push({
      x: Math.floor(Math.random() * (FROGGER_COLS - 2)),
      y: carLanes[i],
      w: 2,
      dir: carSpeeds[i],
    });
  }
  for (let i = 0; i < logLanes.length; i++) {
    logs.push({
      x: Math.floor(Math.random() * (FROGGER_COLS - 2)),
      y: logLanes[i],
      w: 2,
      dir: logSpeeds[i],
    });
  }
  return { cars, logs };
}

function startFrogger(roomKey) {
  const room = rooms.get(roomKey);
  if (!room || room.players.length < 2) return;

  room.state = 'countdown';
  room.frogger = initFroggerObstacles();

  room.players.forEach((p, i) => {
    p.x = Math.floor(FROGGER_COLS / 2);
    p.y = FROGGER_ROWS - 1;
    p.alive = true;
    p.color = COLORS[i];
    p.score = 0;
    p.lives = 3;
  });

  broadcastToRoom(roomKey, {
    type: 'gameInit',
    gameType: 'frogger',
    cols: FROGGER_COLS,
    rows: FROGGER_ROWS,
    players: room.players.map((p) => ({
      nickname: p.nickname,
      x: p.x,
      y: p.y,
      alive: p.alive,
      color: p.color,
      score: p.score,
      lives: p.lives,
    })),
    cars: room.frogger.cars,
    logs: room.frogger.logs,
  });

  let count = 3;
  broadcastToRoom(roomKey, { type: 'countdown', count });

  const cdInterval = setInterval(() => {
    count--;
    if (count > 0) {
      broadcastToRoom(roomKey, { type: 'countdown', count });
    } else {
      clearInterval(cdInterval);
      room.state = 'playing';
      broadcastToRoom(roomKey, { type: 'go' });
      room.tickInterval = setInterval(() => tickFrogger(roomKey), FROGGER_TICK_MS);
    }
  }, 1000);
}

function tickFrogger(roomKey) {
  const room = rooms.get(roomKey);
  if (!room || room.state !== 'playing' || !room.frogger) return;

  const { cars, logs } = room.frogger;

  for (const c of cars) {
    c.x += c.dir;
    if (c.x + c.w <= 0) c.x = FROGGER_COLS;
    if (c.x >= FROGGER_COLS) c.x = -c.w;
  }
  for (const l of logs) {
    l.x += l.dir;
    if (l.x + l.w <= 0) l.x = FROGGER_COLS;
    if (l.x >= FROGGER_COLS) l.x = -l.w;
  }

  for (const p of room.players) {
    if (!p.alive) continue;
    const riverRows = [5, 6, 8, 9];
    const roadRows = [1, 2, 4];
    if (riverRows.includes(p.y)) {
      let onLog = false;
      for (const l of logs) {
        if (l.y === p.y && p.x >= l.x && p.x < l.x + l.w) {
          onLog = true;
          p.x += l.dir;
          if (p.x < 0 || p.x >= FROGGER_COLS) {
            p.alive = false;
            p.lives--;
          }
          break;
        }
      }
      if (!onLog) {
        p.lives--;
        p.alive = p.lives > 0;
        if (!p.alive) continue;
        p.x = Math.floor(FROGGER_COLS / 2);
        p.y = FROGGER_ROWS - 1;
      }
    }
    if (roadRows.includes(p.y)) {
      for (const c of cars) {
        if (c.y === p.y && p.x >= c.x && p.x < c.x + c.w) {
          p.lives--;
          p.alive = p.lives > 0;
          if (p.alive) {
            p.x = Math.floor(FROGGER_COLS / 2);
            p.y = FROGGER_ROWS - 1;
          }
          break;
        }
      }
    }
  }

  broadcastToRoom(roomKey, {
    type: 'tick',
    gameType: 'frogger',
    players: room.players.map((p) => ({
      x: p.x,
      y: p.y,
      alive: p.alive,
      score: p.score,
      lives: p.lives,
    })),
    cars: cars.map((c) => ({ x: c.x, y: c.y, w: c.w })),
    logs: logs.map((l) => ({ x: l.x, y: l.y, w: l.w })),
  });

  const alive = room.players.filter((p) => p.alive);
  const hasWinner = room.players.some((p) => p.score >= FROGGER_GOAL_POINTS);
  if (alive.length === 0 || hasWinner) {
    clearInterval(room.tickInterval);
    room.tickInterval = null;
    room.state = 'gameover';
    let winner = null;
    if (hasWinner) {
      const best = room.players.reduce((a, b) => (a.score >= b.score ? a : b), room.players[0]);
      winner = best.score >= FROGGER_GOAL_POINTS ? best.nickname : null;
    } else if (alive.length === 1) {
      winner = alive[0].nickname;
    } else if (room.players.length > 0) {
      const best = room.players.reduce((a, b) => (a.score >= b.score ? a : b), room.players[0]);
      winner = best.nickname;
    }
    broadcastToRoom(roomKey, { type: 'gameover', winner });
  }
}

function moveFrogger(roomKey, playerIndex, dir) {
  const room = rooms.get(roomKey);
  if (!room || room.state !== 'playing' || !room.frogger) return;
  const p = room.players[playerIndex];
  if (!p || !p.alive) return;

  let nx = p.x, ny = p.y;
  switch (dir) {
    case 'up':    ny--; break;
    case 'down':  ny++; break;
    case 'left':  nx--; break;
    case 'right': nx++; break;
    default: return;
  }

  if (nx < 0 || nx >= FROGGER_COLS || ny < 0 || ny >= FROGGER_ROWS) return;

  p.x = nx;
  p.y = ny;

  if (ny === 0) {
    p.score++;
    p.y = FROGGER_ROWS - 1;
    p.x = Math.floor(FROGGER_COLS / 2);
    if (p.score >= FROGGER_GOAL_POINTS) {
      clearInterval(room.tickInterval);
      room.tickInterval = null;
      room.state = 'gameover';
      broadcastToRoom(roomKey, { type: 'gameover', winner: p.nickname });
    }
  }

  broadcastToRoom(roomKey, {
    type: 'froggerMove',
    playerIndex,
    x: p.x,
    y: p.y,
    score: p.score,
  });
}

// ---------- SHARED ----------
function startCountdown(roomKey) {
  const room = rooms.get(roomKey);
  if (!room) return;
  if (room.gameType === 'frogger') startFrogger(roomKey);
  else startTron(roomKey);
}

function cleanupRoom(roomKey) {
  const room = rooms.get(roomKey);
  if (!room) return;
  if (room.tickInterval) clearInterval(room.tickInterval);
  rooms.delete(roomKey);
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      const roomKey = (msg.room || 'default').trim().toLowerCase();
      const nickname = (msg.nickname || 'Player').trim().slice(0, 20) || 'Player';
      const gameType = msg.gameType === 'frogger' ? 'frogger' : 'tron';
      const room = getRoom(roomKey);

      if (room.players.length >= MAX_PLAYERS) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room is full (max 4 players).' }));
        return;
      }
      if (room.state !== 'waiting') {
        ws.send(JSON.stringify({ type: 'error', message: 'Game already in progress. Wait for it to finish.' }));
        return;
      }
      if (room.players.length === 0) {
        room.gameType = gameType;
      } else if (room.gameType !== gameType) {
        ws.send(JSON.stringify({ type: 'error', message: `This room is playing ${room.gameType}. Join a different room for ${gameType}.` }));
        return;
      }

      const player = {
        ws,
        nickname,
        x: 0, y: 0,
        dir: 'right', nextDir: 'right',
        alive: true,
        color: '',
        score: 0,
        lives: 3,
      };

      room.players.push(player);
      clients.set(ws, { roomKey, nickname, playerIndex: room.players.length - 1 });

      ws.send(JSON.stringify({
        type: 'joined',
        nickname,
        room: roomKey,
        gameType: room.gameType,
        playerIndex: room.players.length - 1,
      }));

      sendLobby(roomKey);
    }

    if (msg.type === 'direction') {
      const client = clients.get(ws);
      if (!client) return;
      const room = rooms.get(client.roomKey);
      if (!room || room.state !== 'playing') return;

      if (room.gameType === 'tron') {
        const player = room.players.find((p) => p.ws === ws);
        if (!player || !player.alive) return;
        if (msg.dir && OPPOSITES[msg.dir] && msg.dir !== OPPOSITES[player.dir]) {
          player.nextDir = msg.dir;
        }
      } else if (room.gameType === 'frogger') {
        moveFrogger(client.roomKey, client.playerIndex, msg.dir);
      }
    }

    if (msg.type === 'start') {
      const client = clients.get(ws);
      if (!client) return;
      const room = rooms.get(client.roomKey);
      if (!room || room.state !== 'waiting') return;
      if (room.players.length < 2) {
        ws.send(JSON.stringify({ type: 'error', message: 'Need at least 2 players.' }));
        return;
      }
      startCountdown(client.roomKey);
    }

    if (msg.type === 'restart') {
      const client = clients.get(ws);
      if (!client) return;
      const room = rooms.get(client.roomKey);
      if (!room || room.state !== 'gameover') return;
      room.state = 'waiting';
      room.grid = null;
      room.frogger = null;
      if (room.tickInterval) {
        clearInterval(room.tickInterval);
        room.tickInterval = null;
      }
      sendLobby(client.roomKey);
    }
  });

  ws.on('close', () => {
    const client = clients.get(ws);
    if (!client) return;
    const room = rooms.get(client.roomKey);
    if (room) {
      room.players = room.players.filter((p) => p.ws !== ws);
      if (room.players.length === 0) {
        cleanupRoom(client.roomKey);
      } else {
        if (room.state === 'playing') {
          const alive = room.players.filter((p) => p.alive);
          if (alive.length <= 1 && room.gameType === 'tron') {
            if (room.tickInterval) clearInterval(room.tickInterval);
            room.tickInterval = null;
            room.state = 'gameover';
            broadcastToRoom(client.roomKey, {
              type: 'gameover',
              winner: alive.length === 1 ? alive[0].nickname : null,
            });
          }
        }
        sendLobby(client.roomKey);
      }
    }
    clients.delete(ws);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`));
