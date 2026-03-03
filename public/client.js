(() => {
  const $ = (s) => document.querySelector(s);

  const joinScreen   = $('#joinScreen');
  const gameScreen   = $('#gameScreen');
  const joinForm     = $('#joinForm');
  const nicknameIn   = $('#nicknameInput');
  const roomIn       = $('#roomInput');
  const joinError    = $('#joinError');
  const roomLabel    = $('#roomLabel');
  const gameTypeLabel= $('#gameTypeLabel');
  const playerListEl = $('#playerList');
  const canvas       = $('#gameCanvas');
  const ctx          = canvas.getContext('2d');
  const overlay      = $('#overlay');
  const overlayTitle = $('#overlayTitle');
  const overlaySub   = $('#overlaySubtitle');
  const overlayBtn   = $('#overlayBtn');
  const countdownEl  = $('#countdownDisplay');
  const controlsHint = $('#controlsHint');

  let ws;
  let myIndex = -1;
  let gameType = 'tron';
  let gameState = 'lobby';
  let players = [];
  let animFrame;

  // Tron state
  let gridSize = 80;
  let cellPx = 8;
  let trails = [];

  // Frogger state
  let froggerCols = 11;
  let froggerRows = 12;
  let froggerCellW = 0;
  let froggerCellH = 0;
  let cars = [];
  let logs = [];

  function getGameType() {
    const el = joinForm.querySelector('input[name="gameType"]:checked');
    return el ? el.value : 'tron';
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = () => {
      const nickname = nicknameIn.value.trim() || 'Player';
      const room = roomIn.value.trim() || 'default';
      const gt = getGameType();
      ws.send(JSON.stringify({ type: 'join', nickname, room, gameType: gt }));
    };
    ws.onmessage = (e) => handleMessage(JSON.parse(e.data));
    ws.onclose = () => {
      joinError.textContent = 'Disconnected from server.';
      joinScreen.style.display = '';
      gameScreen.style.display = 'none';
      if (animFrame) cancelAnimationFrame(animFrame);
    };
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'joined':
        myIndex = msg.playerIndex;
        gameType = msg.gameType || 'tron';
        roomLabel.textContent = `Room: ${msg.room}`;
        gameTypeLabel.textContent = gameType;
        joinScreen.style.display = 'none';
        gameScreen.style.display = 'flex';
        updateControlsHint();
        break;

      case 'error':
        joinError.textContent = msg.message;
        break;

      case 'lobby':
        gameState = 'lobby';
        gameType = msg.gameType || gameType;
        gameTypeLabel.textContent = gameType;
        players = msg.players;
        renderPlayerList(players);
        showOverlay('Waiting for players...', `${players.length}/4 joined`, players.length >= 2);
        if (animFrame) cancelAnimationFrame(animFrame);
        resizeCanvas();
        drawFrame();
        break;

      case 'gameInit':
        gameType = msg.gameType || 'tron';
        gameTypeLabel.textContent = gameType;
        if (gameType === 'tron') {
          gridSize = msg.grid;
          players = msg.players;
          trails = players.map((p) => [{ x: p.x, y: p.y }]);
        } else {
          froggerCols = msg.cols;
          froggerRows = msg.rows;
          players = msg.players;
          cars = msg.cars || [];
          logs = msg.logs || [];
        }
        renderPlayerList(players);
        resizeCanvas();
        break;

      case 'countdown':
        gameState = 'countdown';
        overlay.classList.add('hidden');
        countdownEl.classList.remove('hidden');
        countdownEl.textContent = msg.count;
        drawFrame();
        break;

      case 'go':
        gameState = 'playing';
        countdownEl.classList.add('hidden');
        overlay.classList.add('hidden');
        startRenderLoop();
        break;

      case 'tick':
        if (msg.gameType === 'frogger') {
          msg.players.forEach((p, i) => {
            players[i].x = p.x;
            players[i].y = p.y;
            players[i].alive = p.alive;
            players[i].score = p.score;
            players[i].lives = p.lives;
          });
          cars = msg.cars || cars;
          logs = msg.logs || logs;
        } else {
          msg.players.forEach((p, i) => {
            players[i].x = p.x;
            players[i].y = p.y;
            players[i].dir = p.dir;
            players[i].alive = p.alive;
            if (p.alive && p.x >= 0 && p.x < gridSize && p.y >= 0 && p.y < gridSize) {
              trails[i].push({ x: p.x, y: p.y });
            }
          });
        }
        renderPlayerList(players);
        break;

      case 'froggerMove':
        if (msg.playerIndex !== undefined && players[msg.playerIndex]) {
          players[msg.playerIndex].x = msg.x;
          players[msg.playerIndex].y = msg.y;
          players[msg.playerIndex].score = msg.score;
        }
        renderPlayerList(players);
        break;

      case 'gameover':
        gameState = 'gameover';
        if (animFrame) cancelAnimationFrame(animFrame);
        drawFrame();
        const winText = msg.winner ? `${msg.winner} wins!` : 'Draw!';
        showOverlay(winText, 'Press to play again', false, true);
        break;
    }
  }

  function updateControlsHint() {
    controlsHint.textContent = gameType === 'frogger'
      ? 'Arrow keys or WASD to move'
      : 'Arrow keys or WASD to steer';
  }

  function showOverlay(title, subtitle, showStart, showRestart) {
    overlay.classList.remove('hidden');
    overlayTitle.textContent = title;
    overlaySub.textContent = subtitle || '';
    if (showStart) {
      overlayBtn.style.display = '';
      overlayBtn.textContent = 'Start Game';
      overlayBtn.onclick = () => ws.send(JSON.stringify({ type: 'start' }));
    } else if (showRestart) {
      overlayBtn.style.display = '';
      overlayBtn.textContent = 'Play Again';
      overlayBtn.onclick = () => ws.send(JSON.stringify({ type: 'restart' }));
    } else {
      overlayBtn.style.display = 'none';
    }
  }

  function renderPlayerList(list) {
    playerListEl.innerHTML = list.map((p, i) => {
      const dead = p.alive === false ? ' dead' : '';
      const extra = gameType === 'frogger' && p.lives !== undefined
        ? ` · ${p.score} pts · ${p.lives} lives`
        : '';
      return `<span class="playerTag${dead}">
        <span class="playerDot" style="background:${p.color};box-shadow:0 0 .375rem ${p.color}"></span>
        <span class="playerName">${esc(p.nickname || p.colorName)}${i === myIndex ? ' (you)' : ''}${extra}</span>
      </span>`;
    }).join('');
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  /* ---------- CANVAS ---------- */

  function resizeCanvas() {
    const wrap = $('#canvasWrap');
    const maxW = wrap.clientWidth;
    const maxH = wrap.clientHeight;

    if (gameType === 'frogger') {
      const cellW = maxW / froggerCols;
      const cellH = maxH / froggerRows;
      const cell = Math.min(cellW, cellH);
      froggerCellW = cell;
      froggerCellH = cell;
      canvas.width = froggerCols * cell;
      canvas.height = froggerRows * cell;
      canvas.style.width = canvas.width + 'px';
      canvas.style.height = canvas.height + 'px';
    } else {
      const maxDim = Math.min(maxW, maxH);
      cellPx = Math.floor(maxDim / gridSize);
      if (cellPx < 1) cellPx = 1;
      const side = cellPx * gridSize;
      canvas.width = side;
      canvas.height = side;
      canvas.style.width = side + 'px';
      canvas.style.height = side + 'px';
    }
  }

  function drawFrame() {
    if (gameType === 'frogger') {
      drawFrogger();
    } else {
      drawTron();
    }
  }

  function drawTron() {
    ctx.fillStyle = '#0a0a12';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = 'rgba(30,30,58,0.5)';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= gridSize; i++) {
      const pos = i * cellPx;
      ctx.beginPath(); ctx.moveTo(pos, 0); ctx.lineTo(pos, canvas.height); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, pos); ctx.lineTo(canvas.width, pos); ctx.stroke();
    }

    for (let i = 0; i < players.length; i++) {
      const color = players[i].color;
      if (!trails[i]) continue;

      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 4;

      for (const seg of trails[i]) {
        ctx.fillRect(seg.x * cellPx, seg.y * cellPx, cellPx, cellPx);
      }

      if (players[i].alive) {
        ctx.shadowBlur = 12;
        ctx.fillStyle = '#fff';
        ctx.fillRect(players[i].x * cellPx, players[i].y * cellPx, cellPx, cellPx);
      }
    }

    ctx.shadowBlur = 0;
  }

  function drawFrogger() {
    const cw = froggerCellW;
    const ch = froggerCellH;

    ctx.fillStyle = '#0a0a12';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const roadColor = '#2a2a2a';
    const riverColor = '#0a1a2a';
    const safeColor = '#1a1a2a';
    const goalColor = '#0a2a1a';

    for (let row = 0; row < froggerRows; row++) {
      let fill = safeColor;
      if ([1, 2, 4].includes(row)) fill = roadColor;
      if ([5, 6, 8, 9].includes(row)) fill = riverColor;
      if (row === 0) fill = goalColor;

      ctx.fillStyle = fill;
      ctx.fillRect(0, row * ch, canvas.width, ch);

      ctx.strokeStyle = 'rgba(30,30,58,0.4)';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(0, row * ch, canvas.width, ch);
    }

    ctx.fillStyle = '#cc6600';
    for (const c of cars) {
      ctx.fillRect(c.x * cw, c.y * ch, c.w * cw, ch);
    }

    ctx.fillStyle = '#4a3520';
    for (const l of logs) {
      ctx.fillRect(l.x * cw, l.y * ch, l.w * cw, ch);
    }

    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (p.alive === false) continue;
      const px = p.x ?? Math.floor(froggerCols / 2);
      const py = p.y ?? froggerRows - 1;
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.arc((px + 0.5) * cw, (py + 0.5) * ch, Math.min(cw, ch) * 0.35, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;

    ctx.fillStyle = '#00ff44';
    ctx.globalAlpha = 0.5;
    for (let col = 2; col < froggerCols; col += 4) {
      ctx.beginPath();
      ctx.arc((col + 0.5) * cw, 0.5 * ch, cw * 0.3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function startRenderLoop() {
    if (animFrame) cancelAnimationFrame(animFrame);
    function loop() {
      drawFrame();
      if (gameState === 'playing') animFrame = requestAnimationFrame(loop);
    }
    loop();
  }

  /* ---------- INPUT ---------- */

  const KEY_MAP = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    w: 'up', W: 'up',
    s: 'down', S: 'down',
    a: 'left', A: 'left',
    d: 'right', D: 'right',
  };

  document.addEventListener('keydown', (e) => {
    const dir = KEY_MAP[e.key];
    if (dir && gameState === 'playing' && ws.readyState === 1) {
      e.preventDefault();
      ws.send(JSON.stringify({ type: 'direction', dir }));
    }
  });

  let touchStart = null;

  canvas.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    touchStart = { x: t.clientX, y: t.clientY };
  }, { passive: true });

  canvas.addEventListener('touchend', (e) => {
    if (!touchStart) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStart.x;
    const dy = t.clientY - touchStart.y;
    touchStart = null;
    if (Math.abs(dx) < 20 && Math.abs(dy) < 20) return;
    let dir;
    if (Math.abs(dx) > Math.abs(dy)) {
      dir = dx > 0 ? 'right' : 'left';
    } else {
      dir = dy > 0 ? 'down' : 'up';
    }
    if (gameState === 'playing' && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'direction', dir }));
    }
  }, { passive: true });

  /* ---------- RESIZE ---------- */

  window.addEventListener('resize', () => {
    resizeCanvas();
    drawFrame();
  });

  /* ---------- FORM ---------- */

  joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    joinError.textContent = '';
    connect();
  });
})();
