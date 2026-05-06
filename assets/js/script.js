/*
 * Battleship Game Script
 * Author: Allan Barcelos
 * Description: Multiplayer Battleship game — WebRTC P2P + ntfy.sh signaling
 */

(function () {
  /* ── Constants ───────────────────────────────────────────────── */
  const GRID_SIZE = 26;
  const MAX_CELLS = GRID_SIZE * GRID_SIZE;
  const NTFY = 'https://ntfy.sh';
  const TURN_CREDENTIALS_URL = 'https://rough-grass-f40b.allan-d68.workers.dev';
  const TURN_SECONDS = 30;

  /* ── DOM ─────────────────────────────────────────────────────── */
  const grids = document.getElementsByClassName('grid');
  const squadGrid = document.getElementById('squad-grid');
  const oceanGrid = document.getElementById('ocean-grid');
  const startGameBtn = document.getElementById('startGame');
  const gameCodeInput = document.getElementById('gameCode');

  /* ── Game state ──────────────────────────────────────────────── */
  const squaresSquad = [];
  const squaresOcean = [];
  let occupiedSquares = [];           // squad-N cells our ships occupy
  const shipCells = [];               // per-ship cell groups: [[id,…], …]
  const spriteData = [];              // ship sprite info (for sessionStorage restore)
  let myTurn = false;
  const attackedCells = new Set();    // ocean-N cells we've attacked
  const oceanHits = new Set();        // ocean-N cells confirmed as hits
  const destroyedSquares = new Set(); // squad-N cells of ours that were hit
  const squadMisses = new Set();      // squad-N cells opponent missed
  let opponentSunk = 0;               // count of enemy ships we've sunk
  let gameEnded = false;

  /* ── Audio ───────────────────────────────────────────────────── */
  const explosionAudio = new Audio('assets/audio/explosion.mp3');
  const waterAudio = new Audio('assets/audio/water.mp3');

  /* ── Ships definition ────────────────────────────────────────── */
  // Frame encoda a máscara do navio como string:
  //   '1' = célula ocupada, '0' = célula vazia (bounding-box), 'E' = separador de linha.
  // Exemplo: '0010000E1111111' → 2 linhas, 7 colunas.
  //   linha 1: 0 0 1 0 0 0 0   (torre/bridge)
  //   linha 2: 1 1 1 1 1 1 1   (casco completo)
  // O bounding-box é w×h para dimensionar o sprite; '1's dentro marcam as células ocupadas.
  const ships = [
    { class: 'cruzader',  frame: { h: '0010000E1111111',          v: '01E01E01E11E01E01E01E01E' } },
    { class: 'aircraft',  frame: { h: '1111100E1111111E1111100',   v: '010E010E111E111E111E111E111' } },
    { class: 'frigate',   frame: { h: '0011100E1111111',           v: '01E01E11E11E11E01E01' } },
    { class: 'submarine', frame: { h: '000100E111111',             v: '01E01E11E01E01E01' } },
  ];

  /* ── P2P state ───────────────────────────────────────────────── */
  let peer = null;
  let dataChannel = null;
  let myRole = null;          // 'host' | 'guest'
  let gameCode = null;
  let signalingEs = null;     // EventSource to ntfy.sh
  let remoteDescSet = false;
  const iceCandidateQueue = [];
  let signalingChain = Promise.resolve();

  /* ── Turn timer state ───────────────────────────────────────── */
  let turnTimer = null;
  let turnTimeLeft = 0;

  /* ── Reconnection state ──────────────────────────────────────── */
  let hasGameStarted = false;
  let isReconnecting = false;
  let reconnectAttempts = 0;
  const MAX_RECONNECT = 5;
  let reconnectTimer = null;
  let rematchPending = false;   // opponent requested rematch, waiting for our accept

  /* ────────────────────────────────────────────────────────────── */
  /* Grid                                                           */
  /* ────────────────────────────────────────────────────────────── */
  function initGrid() {
    let id = 1;
    for (let i = 1; i <= GRID_SIZE; i++) {
      for (let j = 1; j <= GRID_SIZE; j++) {
        Array.from(grids).forEach(e => {
          const square = document.createElement('div');
          square.id = (e.id === 'squad-grid' ? 'squad' : 'ocean') + '-' + id;
          square.dataset.y = i;
          square.dataset.x = j;
          e.appendChild(square);
          if (e.id === 'squad-grid') squaresSquad.push(square);
          else squaresOcean.push(square);
        });
        id++;
      }
    }
  }

  /* ────────────────────────────────────────────────────────────── */
  /* Ship placement                                                 */
  /* ────────────────────────────────────────────────────────────── */
  function initShips() {
    // Calculado em runtime para desacoplar de --grid-width no CSS.
    const CELL_PX = Math.round(squadGrid.getBoundingClientRect().width / GRID_SIZE);
    ships.forEach(ship => {
      const direction = Math.random() < 0.5 ? 'h' : 'v';
      const frame = ship.frame[direction];
      const h = frame.split('E').length;
      const w = frame.split('E')[0].length;
      let x, y, randomIndex, square, occupied;

      do {
        occupied = false;
        do {
          randomIndex = Math.floor(Math.random() * MAX_CELLS) + 1;
          square = document.getElementById(`squad-${randomIndex}`);
          x = +square.dataset.x;
          y = +square.dataset.y;
        } while (h + y > GRID_SIZE || w + x > GRID_SIZE);

        // +1 amplia a zona de verificação por 1 célula além do bounding-box para
        // garantir que navios não fiquem adjacentes (buffer mínimo de 1 célula).
        for (let j = y; j < y + h + 1; j++) {
          for (let i = x; i < x + w + 1; i++) {
            const s = document.querySelector(`div[data-x="${i}"][data-y="${j}"]`);
            if (s && occupiedSquares.includes(s.id)) occupied = true;
          }
        }
      } while (occupied);

      let k = 0, firstSquareTop, firstSquareLeft;
      const thisCells = [];
      for (let j = y; j < y + h + 1; j++) {
        for (let i = x; i < x + w + 1; i++) {
          const s = document.querySelector(`div[data-x="${i}"][data-y="${j}"]`);
          if (s) {
            if (j === y && i === x) {
              firstSquareTop = s.offsetTop;
              firstSquareLeft = s.offsetLeft;
            }
            if (frame[k] === '1') {
              occupiedSquares.push(s.id);
              s.classList.add('occupied');
              thisCells.push(s.id);
            }
            k++;
          }
        }
      }
      shipCells.push(thisCells);
      spriteData.push({
        shipClass: ship.class, direction,
        top: `${firstSquareTop}px`, left: `${firstSquareLeft}px`,
        width: `${w * CELL_PX}px`, height: `${h * CELL_PX}px`,
      });

      const shipDiv = document.createElement('span');
      shipDiv.style.width = `${w * CELL_PX}px`;
      shipDiv.style.height = `${h * CELL_PX}px`;
      shipDiv.dataset.ship = ship.class;
      shipDiv.style.position = 'absolute';
      shipDiv.style.top = `${firstSquareTop}px`;
      shipDiv.style.left = `${firstSquareLeft}px`;
      shipDiv.classList.add(`sprite-${direction}`, `${ship.class}-${direction}`);
      squadGrid.appendChild(shipDiv);
    });
  }

  /* ────────────────────────────────────────────────────────────── */
  /* Helpers                                                        */
  /* ────────────────────────────────────────────────────────────── */
  function setMyTurn(value) {
    myTurn = value;
    oceanGrid.style.cursor = myTurn ? 'pointer' : 'not-allowed';
    squadGrid.classList.toggle('board-hidden', myTurn);
    oceanGrid.classList.toggle('board-hidden', !myTurn);
    const labelSpan = document.querySelector('#board-label span');
    if (labelSpan) labelSpan.textContent = myTurn ? 'Ocean' : 'Your Squad';
    if (value) startTurnTimer(); else stopTurnTimer();
  }

  function playSound(hit) {
    explosionAudio.pause(); explosionAudio.currentTime = 0;
    waterAudio.pause();     waterAudio.currentTime = 0;
    (hit ? explosionAudio : waterAudio).play().catch(() => {});
  }

  function updateHeader(code, msg) {
    const divHeader = document.getElementById('header');
    const existing = document.getElementById('box');
    if (existing) existing.remove();
    if (startGameBtn && startGameBtn.parentNode) startGameBtn.remove();
    if (gameCodeInput && gameCodeInput.parentNode) gameCodeInput.remove();

    const box = document.createElement('div');
    box.id = 'box';
    const codeEl = document.createElement('p');
    codeEl.id = 'code';
    codeEl.textContent = code;
    const msgEl = document.createElement('p');
    msgEl.id = 'msg';
    msgEl.textContent = msg;
    box.appendChild(msgEl);
    box.appendChild(codeEl);
    divHeader.insertBefore(box, divHeader.firstChild);
  }

  function showGameOver(winner) {
    gameEnded = true;
    setMyTurn(false);
    const divHeader = document.getElementById('header');
    const existing = document.getElementById('box');
    if (existing) existing.remove();

    const box = document.createElement('div');
    box.id = 'box';

    const msgEl = document.createElement('p');
    msgEl.id = 'msg';
    msgEl.style.fontSize = '1.8em';
    msgEl.style.fontWeight = 'bold';
    msgEl.textContent = winner ? '🏆 You Win!' : '💀 You Lose!';

    const rematchBtn = document.createElement('button');
    rematchBtn.id = 'rematch-btn';
    rematchBtn.textContent = 'Rematch';
    rematchBtn.addEventListener('click', onRematchClick);

    box.appendChild(msgEl);
    box.appendChild(rematchBtn);
    divHeader.insertBefore(box, divHeader.firstChild);
  }

  function startTurnTimer() {
    stopTurnTimer();
    turnTimeLeft = TURN_SECONDS;
    renderTimerDisplay();
    turnTimer = setInterval(() => {
      turnTimeLeft--;
      renderTimerDisplay();
      if (turnTimeLeft <= 0) { stopTurnTimer(); autoAttack(); }
    }, 1000);
  }

  function stopTurnTimer() {
    if (turnTimer) { clearInterval(turnTimer); turnTimer = null; }
    const el = document.getElementById('turn-timer');
    if (el) { el.textContent = ''; el.className = ''; }
  }

  function renderTimerDisplay() {
    const el = document.getElementById('turn-timer');
    if (!el) return;
    el.textContent = `0:${String(turnTimeLeft).padStart(2, '0')}`;
    el.className = turnTimeLeft <= 10 ? 'timer-urgent' : '';
  }

  function autoAttack() {
    if (!myTurn || !dataChannel || dataChannel.readyState !== 'open') return;
    const candidates = squaresOcean.filter(s => !attackedCells.has(s.id));
    if (!candidates.length) return;
    const cell = candidates[Math.floor(Math.random() * candidates.length)];
    setMyTurn(false);
    dataChannel.send(JSON.stringify({ type: 'attack', cellId: cell.id }));
  }

  async function detectConnectionType() {
    if (!peer) return null;
    try {
      const stats = await peer.getStats();
      const localCandidates = {};
      let activePair = null;
      stats.forEach(r => {
        if (r.type === 'local-candidate') localCandidates[r.id] = r;
        if (r.type === 'candidate-pair' && r.nominated) activePair = r;
      });
      // Fallback: alguns browsers não marcam nominated, usamos state=succeeded
      if (!activePair) {
        stats.forEach(r => {
          if (r.type === 'candidate-pair' && r.state === 'succeeded') activePair = r;
        });
      }
      if (!activePair) return null;
      const local = localCandidates[activePair.localCandidateId];
      return local ? local.candidateType : null;
    } catch (_) { return null; }
  }

  function showConnectionType(type) {
    const el = document.getElementById('conn-indicator');
    if (!el) return;
    if (type === 'relay') {
      el.textContent = 'via relay';
      el.className = 'conn-relay';
    } else if (type === 'host' || type === 'srflx' || type === 'prflx') {
      el.textContent = 'P2P direto';
      el.className = 'conn-p2p';
    }
  }

  function makeid(length) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  }

  /* ────────────────────────────────────────────────────────────── */
  /* Session persistence (feature 6)                                */
  /* ────────────────────────────────────────────────────────────── */
  const SAVE_KEY = 'bsg-v1';

  function saveState() {
    if (!hasGameStarted || !gameCode) return;
    try {
      sessionStorage.setItem(SAVE_KEY, JSON.stringify({
        gameCode, myRole,
        occupiedSquares, shipCells, spriteData,
        attackedCells:    [...attackedCells],
        oceanHits:        [...oceanHits],
        destroyedSquares: [...destroyedSquares],
        squadMisses:      [...squadMisses],
        opponentSunk, myTurn,
      }));
    } catch (_) {}
  }

  function loadState() {
    try {
      const raw = sessionStorage.getItem(SAVE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }

  function restoreState(s) {
    gameCode         = s.gameCode;
    myRole           = s.myRole;
    occupiedSquares  = s.occupiedSquares;
    shipCells.push(...s.shipCells);
    spriteData.push(...s.spriteData);
    s.attackedCells.forEach(id    => attackedCells.add(id));
    s.oceanHits.forEach(id        => oceanHits.add(id));
    s.destroyedSquares.forEach(id => destroyedSquares.add(id));
    s.squadMisses.forEach(id      => squadMisses.add(id));
    opponentSunk = s.opponentSunk;
    myTurn       = s.myTurn;
    hasGameStarted = true;

    // Re-apply DOM state
    s.occupiedSquares.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.add('occupied');
    });
    s.destroyedSquares.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.add('explosion');
    });
    s.squadMisses.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.add('water');
    });
    s.oceanHits.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.add('explosion');
    });
    const hitSet = new Set(s.oceanHits);
    s.attackedCells.filter(id => !hitSet.has(id)).forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.add('water');
    });

    // Restore ship sprites
    s.spriteData.forEach(sd => {
      const span = document.createElement('span');
      span.style.cssText =
        `width:${sd.width};height:${sd.height};position:absolute;top:${sd.top};left:${sd.left}`;
      span.dataset.ship = sd.shipClass;
      span.classList.add(`sprite-${sd.direction}`, `${sd.shipClass}-${sd.direction}`);
      squadGrid.appendChild(span);
    });

    updateFleetCounters();
    // Show correct board immediately (no animation — just sync CSS)
    squadGrid.classList.toggle('board-hidden', myTurn);
    oceanGrid.classList.toggle('board-hidden', !myTurn);
    const labelSpan = document.querySelector('#board-label span');
    if (labelSpan) labelSpan.textContent = myTurn ? 'Ocean' : 'Your Squad';
  }

  function clearSavedState() {
    sessionStorage.removeItem(SAVE_KEY);
  }

  function updateFleetCounters() {
    const myRemaining = shipCells.filter(cells => cells.some(id => !destroyedSquares.has(id))).length;
    const enemyRemaining = ships.length - opponentSunk;
    const meEl  = document.getElementById('fleet-me');
    const eneEl = document.getElementById('fleet-enemy');
    if (!meEl || !eneEl) return;
    meEl.innerHTML  = `<span>Your Fleet</span><span class="fleet-count">${myRemaining} / ${ships.length}</span>`;
    eneEl.innerHTML = `<span>Enemy Fleet</span><span class="fleet-count">${enemyRemaining} / ${ships.length}</span>`;
    meEl.style.display  = '';
    eneEl.style.display = '';
  }

  function onRematchClick() {
    if (!dataChannel || dataChannel.readyState !== 'open') return;
    const btn = document.getElementById('rematch-btn');
    if (rematchPending) {
      // Opponent already requested — accept it
      dataChannel.send(JSON.stringify({ type: 'rematch-accept' }));
      startRematch();
    } else {
      // Request rematch
      dataChannel.send(JSON.stringify({ type: 'rematch-request' }));
      if (btn) { btn.textContent = 'Waiting...'; btn.disabled = true; }
    }
  }

  function startRematch() {
    rematchPending = false;
    gameEnded = false;
    hasGameStarted = true;

    clearSavedState();

    // Reset state
    occupiedSquares = [];
    shipCells.length = 0;
    spriteData.length = 0;
    attackedCells.clear();
    oceanHits.clear();
    destroyedSquares.clear();
    squadMisses.clear();
    opponentSunk = 0;

    // Reset cell DOM classes
    squaresSquad.forEach(s => s.classList.remove('explosion', 'water', 'occupied'));
    squaresOcean.forEach(s => s.classList.remove('explosion', 'water'));

    // Remove old ship sprites
    squadGrid.querySelectorAll('span[data-ship]').forEach(s => s.remove());

    // Place new ships randomly
    initShips();
    updateFleetCounters();

    // Host always goes first on rematch (same as original start)
    if (myRole === 'host') {
      setMyTurn(true);
      updateHeader(gameCode, 'Your Turn');
      dataChannel.send(JSON.stringify({ type: 'start', yourTurn: false }));
    } else {
      setMyTurn(false);
      updateHeader(gameCode, 'Wait for your turn...');
    }
  }

  /* ────────────────────────────────────────────────────────────── */
  /* Signaling via ntfy.sh                                         */
  /*                                                               */
  /* ntfy.sh is used only during connection setup to exchange      */
  /* WebRTC SDP offer/answer and ICE candidates. Once the          */
  /* DataChannel is open the EventSource is closed and all         */
  /* game traffic flows directly P2P.                              */
  /* ────────────────────────────────────────────────────────────── */
  function ntfyTopic() {
    return `battleship-p2p-${gameCode.toLowerCase()}`;
  }

  async function postSignal(payload) {
    try {
      await fetch(`${NTFY}/${ntfyTopic()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(payload),
      });
    } catch (_) {}
  }

  function startSignaling() {
    // Guest usa lookback de 10 min porque o host pode ter postado o offer antes do guest abrir a página.
    // Host usa apenas 30 s — só precisa receber answer + ICE do guest, que chegam em tempo real.
    const sinceTs = Math.floor(Date.now() / 1000) - (myRole === 'guest' ? 600 : 30);
    signalingEs = new EventSource(`${NTFY}/${ntfyTopic()}/sse?since=${sinceTs}`);

    signalingEs.addEventListener('message', (e) => {
      let payload;
      try {
        const wrapper = JSON.parse(e.data);
        payload = JSON.parse(wrapper.message);
      } catch (_) { return; }

      // ntfy.sh ecoa a própria mensagem de volta; ignoramos mensagens enviadas por nós mesmos.
      if (!payload || payload.from === myRole) return;

      // Promise chain garante que o SDP (offer/answer) seja processado antes dos ICE candidates,
      // mesmo que o EventSource entregue as mensagens fora de ordem.
      signalingChain = signalingChain
        .then(() => handleSignaling(payload))
        .catch(() => {});
    });
  }

  async function handleSignaling(msg) {
    if (!peer) return;

    if (msg.type === 'offer' && myRole === 'guest') {
      await peer.setRemoteDescription(
        new RTCSessionDescription({ type: 'offer', sdp: msg.sdp })
      );
      await flushIceCandidateQueue();
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      await postSignal({ type: 'answer', from: 'guest', sdp: answer.sdp });

    } else if (msg.type === 'answer' && myRole === 'host') {
      await peer.setRemoteDescription(
        new RTCSessionDescription({ type: 'answer', sdp: msg.sdp })
      );
      await flushIceCandidateQueue();

    } else if (msg.type === 'ice') {
      await addIceCandidate(msg.candidate);
    }
  }

  async function addIceCandidate(candidate) {
    if (remoteDescSet) {
      try { await peer.addIceCandidate(new RTCIceCandidate(candidate)); } catch (_) {}
    } else {
      // RTCPeerConnection rejeita ICE candidates antes de ter remote description.
      // Enfileiramos e aplicamos em flushIceCandidateQueue() logo após setRemoteDescription().
      iceCandidateQueue.push(candidate);
    }
  }

  async function flushIceCandidateQueue() {
    remoteDescSet = true;
    for (const c of iceCandidateQueue) {
      try { await peer.addIceCandidate(new RTCIceCandidate(c)); } catch (_) {}
    }
    iceCandidateQueue.length = 0;
  }

  /* ────────────────────────────────────────────────────────────── */
  /* P2P connection setup                                           */
  /* ────────────────────────────────────────────────────────────── */
  async function fetchIceServers() {
    try {
      const res = await fetch(TURN_CREDENTIALS_URL);
      if (!res.ok) throw new Error('turn-fetch-failed');
      return await res.json();
    } catch (_) {
      // fallback: Google STUN only (P2P direto; pode falhar em CGNAT)
      return [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ];
    }
  }

  async function initP2P(role, code) {
    myRole = role;
    gameCode = code;
    remoteDescSet = false;
    iceCandidateQueue.length = 0;
    signalingChain = Promise.resolve();

    const iceServers = await fetchIceServers();
    peer = new RTCPeerConnection({ iceServers });

    peer.onicecandidate = ({ candidate }) => {
      if (candidate) postSignal({ type: 'ice', from: myRole, candidate: candidate.toJSON() });
    };

    peer.onconnectionstatechange = () => {
      const state = peer.connectionState;
      if ((state === 'failed' || state === 'disconnected') && !gameEnded) {
        scheduleReconnect();
      }
    };

    startSignaling();

    if (role === 'host') {
      dataChannel = peer.createDataChannel('game');
      setupDataChannel();

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await postSignal({ type: 'offer', from: 'host', sdp: offer.sdp });
      if (!isReconnecting) updateHeader(code, 'Waiting for opponent...');
    } else {
      peer.ondatachannel = ({ channel }) => {
        dataChannel = channel;
        setupDataChannel();
      };
      if (!isReconnecting) updateHeader(code, 'Connecting...');
    }
  }

  /* ────────────────────────────────────────────────────────────── */
  /* DataChannel setup                                              */
  /* ────────────────────────────────────────────────────────────── */
  function setupDataChannel() {
    dataChannel.onopen = () => {
      // Signaling is no longer needed once P2P is established
      if (signalingEs) { signalingEs.close(); signalingEs = null; }

      isReconnecting = false;
      reconnectAttempts = 0;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

      if (!hasGameStarted) {
        hasGameStarted = true;
        updateFleetCounters();
        initChat();
        // Detecta tipo de conexão após ICE estabilizar (2s de margem)
        setTimeout(() => detectConnectionType().then(showConnectionType), 2000);
        if (myRole === 'host') {
          setMyTurn(true);
          updateHeader(gameCode, 'Your Turn');
          dataChannel.send(JSON.stringify({ type: 'start', yourTurn: false }));
        }
      } else {
        // Reconnected — host sends full board state to guest
        updateFleetCounters();
        updateHeader(gameCode, myTurn ? 'Your Turn' : 'Wait for your turn...');
        // Detecta tipo de conexão após ICE estabilizar (2s de margem)
        setTimeout(() => detectConnectionType().then(showConnectionType), 2000);
        if (myRole === 'host') {
          const hostShipsSunk = shipCells.filter(
            cells => cells.every(id => destroyedSquares.has(id))
          ).length;
          // Perspectivas cruzadas no resync:
          //   hostOceanHits/Misses   → células onde o host atacou (= squad do guest)
          //   hostSquadDestroyed/Misses → células onde o guest atacou (= ocean do guest)
          //   guestOpponentSunk = navios do host destruídos = "afundados pelo guest"
          dataChannel.send(JSON.stringify({
            type: 'resync',
            hostTurn:          myTurn,
            hostOceanHits:     [...oceanHits],
            hostOceanMisses:   [...attackedCells].filter(id => !oceanHits.has(id)),
            hostSquadDestroyed:[...destroyedSquares],
            hostSquadMisses:   [...squadMisses],
            hostOpponentSunk:  opponentSunk,
            guestOpponentSunk: hostShipsSunk,
          }));
        }
      }
    };

    dataChannel.onmessage = ({ data }) => {
      try { handleGameMessage(JSON.parse(data)); } catch (_) {}
    };

    dataChannel.onclose = () => {
      if (!gameEnded) scheduleReconnect();
    };
  }

  /* ────────────────────────────────────────────────────────────── */
  /* Reconnection                                                   */
  /* ────────────────────────────────────────────────────────────── */
  function scheduleReconnect() {
    if (gameEnded || reconnectTimer) return;
    if (reconnectAttempts >= MAX_RECONNECT) {
      setMyTurn(false);
      updateHeader('', 'Could not reconnect. Reload to try again.');
      return;
    }

    reconnectAttempts++;
    // Backoff exponencial com cap em 16s: 1 << n = 2^n sem dependência de Math.pow
    const delay = Math.min(1000 * (1 << (reconnectAttempts - 1)), 16000); // 1s 2s 4s 8s 16s
    setMyTurn(false);
    updateHeader(gameCode, `Reconnecting... (${reconnectAttempts}/${MAX_RECONNECT})`);

    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      isReconnecting = true;

      if (dataChannel) { try { dataChannel.close(); } catch (_) {} dataChannel = null; }
      if (peer)        { try { peer.close(); }        catch (_) {} peer = null; }
      if (signalingEs) { signalingEs.close(); signalingEs = null; }
      // Limpa indicador de conexão — será re-detectado após reconexão
      const connEl = document.getElementById('conn-indicator');
      if (connEl) { connEl.textContent = ''; connEl.className = ''; }

      remoteDescSet = false;
      iceCandidateQueue.length = 0;
      signalingChain = Promise.resolve();

      await initP2P(myRole, gameCode);
    }, delay);
  }

  /* ────────────────────────────────────────────────────────────── */
  /* Game protocol over DataChannel                                 */
  /*                                                               */
  /* Message types:                                                 */
  /*   start           → { yourTurn: bool }   host on open/rematch  */
  /*   attack          → { cellId }           attacker → defender   */
  /*   result          → { cellId, hit, sunk} defender → attacker   */
  /*   defeat          → {}                   defender → attacker   */
  /*   chat            → { text }             either → other        */
  /*   rematch-request → {}                   either → other        */
  /*   rematch-accept  → {}                   either → other        */
  /* ────────────────────────────────────────────────────────────── */
  function handleGameMessage(msg) {
    switch (msg.type) {

      case 'start':
        setMyTurn(msg.yourTurn);
        updateHeader(gameCode, msg.yourTurn ? 'Your Turn' : 'Wait for your turn...');
        saveState();
        break;

      case 'attack': {
        // Opponent attacked us — evaluate against our own ships
        const squadId = msg.cellId.replace('ocean', 'squad');
        const hit = occupiedSquares.includes(squadId);

        const cell = document.getElementById(squadId);
        if (cell) cell.classList.add(hit ? 'explosion' : 'water');
        playSound(hit);
        if (hit) destroyedSquares.add(squadId);
        else     squadMisses.add(squadId);

        // Detect if this hit sank an entire ship
        const sunk = hit && shipCells.some(cells =>
          cells.includes(squadId) && cells.every(id => destroyedSquares.has(id))
        );

        updateFleetCounters();
        saveState();
        dataChannel.send(JSON.stringify({ type: 'result', cellId: msg.cellId, hit, sunk }));

        if (occupiedSquares.every(s => destroyedSquares.has(s))) {
          // All our ships destroyed — we lost
          dataChannel.send(JSON.stringify({ type: 'defeat' }));
          showGameOver(false);
        } else {
          setMyTurn(true); // still ships left, our turn to counter-attack
        }
        break;
      }

      case 'result': {
        // Feedback on our own attack
        const cell = document.getElementById(msg.cellId);
        if (cell) cell.classList.add(msg.hit ? 'explosion' : 'water');
        playSound(msg.hit);
        attackedCells.add(msg.cellId);
        if (msg.hit) oceanHits.add(msg.cellId);
        if (msg.sunk) opponentSunk++;
        updateFleetCounters();
        saveState();
        setMyTurn(false); // wait for opponent's turn
        break;
      }

      case 'defeat':
        // Opponent declared they lost — we win
        showGameOver(true);
        break;

      case 'resync': {
        // Full board state from host — clear and reapply
        squaresSquad.forEach(s => s.classList.remove('explosion', 'water'));
        squaresOcean.forEach(s => s.classList.remove('explosion', 'water'));
        destroyedSquares.clear(); squadMisses.clear();
        attackedCells.clear();    oceanHits.clear();

        // Restore squad grid (where host attacked us)
        msg.hostOceanHits.forEach(oId => {
          const sId = oId.replace('ocean', 'squad');
          destroyedSquares.add(sId);
          const el = document.getElementById(sId);
          if (el) el.classList.add('explosion');
        });
        msg.hostOceanMisses.forEach(oId => {
          const sId = oId.replace('ocean', 'squad');
          squadMisses.add(sId);
          const el = document.getElementById(sId);
          if (el) el.classList.add('water');
        });

        // Restore ocean grid (where we attacked host)
        msg.hostSquadDestroyed.forEach(sId => {
          const oId = sId.replace('squad', 'ocean');
          oceanHits.add(oId); attackedCells.add(oId);
          const el = document.getElementById(oId);
          if (el) el.classList.add('explosion');
        });
        msg.hostSquadMisses.forEach(sId => {
          const oId = sId.replace('squad', 'ocean');
          attackedCells.add(oId);
          const el = document.getElementById(oId);
          if (el) el.classList.add('water');
        });

        opponentSunk = msg.hostOpponentSunk;
        setMyTurn(!msg.hostTurn);
        updateHeader(gameCode, myTurn ? 'Your Turn' : 'Wait for your turn...');
        updateFleetCounters();
        saveState();
        break;
      }

      case 'chat':
        appendChatMessage(msg.text, false);
        break;

      case 'rematch-request': {
        rematchPending = true;
        const btn = document.getElementById('rematch-btn');
        if (btn) { btn.textContent = 'Accept Rematch'; btn.disabled = false; }
        break;
      }

      case 'rematch-accept':
        startRematch();
        break;
    }
  }

  /* ────────────────────────────────────────────────────────────── */
  /* Chat                                                           */
  /* ────────────────────────────────────────────────────────────── */
  function appendChatMessage(text, mine) {
    const messages = document.getElementById('chat-messages');
    if (!messages) return;
    const div = document.createElement('div');
    div.className = `msg ${mine ? 'msg-me' : 'msg-opp'}`;
    div.textContent = text;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
  }

  function initChat() {
    const panel   = document.getElementById('chat-panel');
    const input   = document.getElementById('chat-input');
    const sendBtn = document.getElementById('chat-send');
    panel.style.display = 'flex';

    function send() {
      const text = input.value.trim();
      if (!text || !dataChannel || dataChannel.readyState !== 'open') return;
      dataChannel.send(JSON.stringify({ type: 'chat', text }));
      appendChatMessage(text, true);
      input.value = '';
    }

    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); send(); }
    });
  }

  /* ────────────────────────────────────────────────────────────── */
  /* UI                                                             */
  /* ────────────────────────────────────────────────────────────── */
  function initUI() {
    startGameBtn.addEventListener('click', () => {
      // `peer` já existindo = clique duplo enquanto conecta; `hasGameStarted` = jogo ativo.
      // Ambas as guards evitam criar múltiplas conexões com o mesmo código.
      if (peer || hasGameStarted) return;
      startGameBtn.disabled = true;
      clearSavedState();
      const inputCode = gameCodeInput.value.trim().toUpperCase();
      if (inputCode.length === 10) {
        initP2P('guest', inputCode);
      } else {
        const code = makeid(10);
        gameCodeInput.value = code;
        initP2P('host', code);
      }
    });

    oceanGrid.addEventListener('click', e => {
      const cellId = e.target.id;
      if (!cellId || !myTurn || attackedCells.has(cellId)) return;
      if (!dataChannel || dataChannel.readyState !== 'open') return;
      setMyTurn(false); // trava otimista: desabilita o grid antes da resposta chegar para evitar duplo-ataque
      dataChannel.send(JSON.stringify({ type: 'attack', cellId }));
    });

    /* Modal */
    const infoModal = document.getElementById('infoModal');
    Array.from(document.getElementsByClassName('openModal')).forEach(btn => {
      const modal = document.getElementById(`${btn.dataset.modal}Modal`);
      if (modal) btn.addEventListener('click', () => modal.style.display = 'block');
    });

    const closeModalBtn = document.getElementsByClassName('close')[0];
    if (closeModalBtn) {
      closeModalBtn.addEventListener('click', () => { infoModal.style.display = 'none'; });
    }

    if (window.screen.width < 1440 && window.screen.height < 900) {
      alert('A minimum resolution of 1440x900 is recommended.');
    }
  }

  /* ── Boot ── */
  initGrid();
  const _saved = loadState();
  if (_saved) {
    restoreState(_saved);
    initUI();
    isReconnecting = true;
    initP2P(_saved.myRole, _saved.gameCode);
    updateHeader(_saved.gameCode, 'Reconnecting...');
  } else {
    initShips();
    initUI();
  }
})();
