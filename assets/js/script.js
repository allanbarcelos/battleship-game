/*
 * Battleship Game Script
 * Author: Allan Barcelos
 * Description: Multiplayer Battleship game — WebRTC P2P + ntfy.sh signaling
 */

(function () {
  /* ── Constants ───────────────────────────────────────────────── */
  const GRID_SIZE = 26;
  const MAX_CELLS = GRID_SIZE * GRID_SIZE;
  const CELL_PX = 23;
  const NTFY = 'https://ntfy.sh';

  /* ── DOM ─────────────────────────────────────────────────────── */
  const grids = document.getElementsByClassName('grid');
  const squadGrid = document.getElementById('squad-grid');
  const oceanGrid = document.getElementById('ocean-grid');
  const startGameBtn = document.getElementById('startGame');
  const gameCodeInput = document.getElementById('gameCode');

  /* ── Game state ──────────────────────────────────────────────── */
  const squaresSquad = [];
  const squaresOcean = [];
  let occupiedSquares = [];     // squad-N cells our ships occupy
  const shipCells = [];         // per-ship cell groups: [[id,…], …]
  let myTurn = false;
  const attackedCells = new Set();    // ocean-N cells we've attacked
  const destroyedSquares = new Set(); // squad-N cells of ours that were hit
  let opponentSunk = 0;               // count of enemy ships we've sunk
  let gameEnded = false;

  /* ── Audio ───────────────────────────────────────────────────── */
  const explosionAudio = new Audio('assets/audio/explosion.mp3');
  const waterAudio = new Audio('assets/audio/water.mp3');

  /* ── Ships definition ────────────────────────────────────────── */
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

  function makeid(length) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
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

    // Reset state
    occupiedSquares = [];
    shipCells.length = 0;
    attackedCells.clear();
    destroyedSquares.clear();
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
    // Guest uses a 10-minute look-back to catch an offer already posted;
    // host only wants live messages (answer + ICE from guest).
    const sinceTs = Math.floor(Date.now() / 1000) - (myRole === 'guest' ? 600 : 30);
    signalingEs = new EventSource(`${NTFY}/${ntfyTopic()}/sse?since=${sinceTs}`);

    signalingEs.addEventListener('message', (e) => {
      let payload;
      try {
        const wrapper = JSON.parse(e.data);
        payload = JSON.parse(wrapper.message);
      } catch (_) { return; }

      if (!payload || payload.from === myRole) return; // ignore own echoes

      // Process messages sequentially to preserve SDP → ICE ordering
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
      // Buffer candidates until remote description is set
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
  async function initP2P(role, code) {
    myRole = role;
    gameCode = code;
    remoteDescSet = false;
    iceCandidateQueue.length = 0;
    signalingChain = Promise.resolve();

    peer = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        // Public TURN relay for users behind symmetric NAT / strict firewalls
        { urls: 'turn:openrelay.metered.ca:80',  username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      ],
    });

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
        if (myRole === 'host') {
          setMyTurn(true);
          updateHeader(gameCode, 'Your Turn');
          dataChannel.send(JSON.stringify({ type: 'start', yourTurn: false }));
        }
      } else {
        // Reconnected — host syncs whose turn it is
        updateFleetCounters();
        updateHeader(gameCode, myTurn ? 'Your Turn' : 'Wait for your turn...');
        if (myRole === 'host') {
          dataChannel.send(JSON.stringify({ type: 'resync', hostTurn: myTurn }));
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
    const delay = Math.min(1000 * (1 << (reconnectAttempts - 1)), 16000); // 1s 2s 4s 8s 16s
    setMyTurn(false);
    updateHeader(gameCode, `Reconnecting... (${reconnectAttempts}/${MAX_RECONNECT})`);

    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      isReconnecting = true;

      if (dataChannel) { try { dataChannel.close(); } catch (_) {} dataChannel = null; }
      if (peer)        { try { peer.close(); }        catch (_) {} peer = null; }
      if (signalingEs) { signalingEs.close(); signalingEs = null; }

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
        break;

      case 'attack': {
        // Opponent attacked us — evaluate against our own ships
        const squadId = msg.cellId.replace('ocean', 'squad');
        const hit = occupiedSquares.includes(squadId);

        const cell = document.getElementById(squadId);
        if (cell) cell.classList.add(hit ? 'explosion' : 'water');
        playSound(hit);
        if (hit) destroyedSquares.add(squadId);

        // Detect if this hit sank an entire ship
        const sunk = hit && shipCells.some(cells =>
          cells.includes(squadId) && cells.every(id => destroyedSquares.has(id))
        );

        updateFleetCounters();
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
        if (msg.sunk) opponentSunk++;
        updateFleetCounters();
        setMyTurn(false); // wait for opponent's turn
        break;
      }

      case 'defeat':
        // Opponent declared they lost — we win
        showGameOver(true);
        break;

      case 'resync':
        // Received after reconnect — host tells us whose turn it is
        setMyTurn(!msg.hostTurn);
        updateHeader(gameCode, myTurn ? 'Your Turn' : 'Wait for your turn...');
        updateFleetCounters();
        break;

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
      const inputCode = gameCodeInput.value.trim().toUpperCase();
      if (inputCode.length === 10) {
        // Join existing game as guest
        initP2P('guest', inputCode);
      } else {
        // Create new game as host
        const code = makeid(10);
        gameCodeInput.value = code;
        initP2P('host', code);
      }
    });

    oceanGrid.addEventListener('click', e => {
      const cellId = e.target.id;
      if (!cellId || !myTurn || attackedCells.has(cellId)) return;
      if (!dataChannel || dataChannel.readyState !== 'open') return;
      setMyTurn(false); // optimistic lock to prevent double-click
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
  initShips();
  initUI();
})();
