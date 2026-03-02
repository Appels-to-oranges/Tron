const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static('public'));

const rooms = new Map();
const clients = new Map();

const GRID = 80;
const TICK_MS = 100;
const MAX_PLAYERS = 4;
const COLORS = ['#00ffff', '#ff00ff', '#ffff00', '#00ff44'];
const COLOR_NAMES = ['Cyan', 'Magenta', 'Yellow', 'Green'];

const SPAWNS = [
  { x: 10, y: 40, dir: 'right' },
  { x: 69, y: 40, dir: 'left' },
  { x: 40, y: 10, dir: 'down' },
  { x: 40, y: 69, dir: 'up' },
];

const OPPOSITES = { up: 'down', down: 'up', left: 'right', right: 'left' };

function getRoom(roomKey) {
  if (!rooms.has(roomKey)) {
    rooms.set(roomKey, {
      players: [],
      state: 'waiting',
      grid: null,
      tickInterval: null,
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
    players: room.players.map((p, i) => ({
      nickname: p.nickname,
      color: COLORS[i],
      colorName: COLOR_NAMES[i],
    })),
  });
}

function createGrid() {
  const grid = [];
  for (let y = 0; y < GRID; y++) {
    grid[y] = new Array(GRID).fill(0);
  }
  return grid;
}

function startCountdown(roomKey) {
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
      room.tickInterval = setInterval(() => tick(roomKey), TICK_MS);
    }
  }, 1000);
}

function tick(roomKey) {
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
      const room = getRoom(roomKey);

      if (room.players.length >= MAX_PLAYERS) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room is full (max 4 players).' }));
        return;
      }
      if (room.state !== 'waiting') {
        ws.send(JSON.stringify({ type: 'error', message: 'Game already in progress. Wait for it to finish.' }));
        return;
      }

      const player = {
        ws,
        nickname,
        x: 0, y: 0,
        dir: 'right', nextDir: 'right',
        alive: true,
        color: '',
      };

      room.players.push(player);
      clients.set(ws, { roomKey, nickname });

      ws.send(JSON.stringify({
        type: 'joined',
        nickname,
        room: roomKey,
        playerIndex: room.players.length - 1,
      }));

      sendLobby(roomKey);
    }

    if (msg.type === 'direction') {
      const client = clients.get(ws);
      if (!client) return;
      const room = rooms.get(client.roomKey);
      if (!room || room.state !== 'playing') return;
      const player = room.players.find((p) => p.ws === ws);
      if (!player || !player.alive) return;
      if (msg.dir && OPPOSITES[msg.dir] && msg.dir !== OPPOSITES[player.dir]) {
        player.nextDir = msg.dir;
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
          if (alive.length <= 1) {
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
server.listen(PORT, () => console.log(`Tron server on http://localhost:${PORT}`));
