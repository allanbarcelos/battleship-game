/*
 * Battleship Game Script
 * Author: Allan Barcelos
 * Description: Multiplayer Battleship game with Socket.IO
 */

(function () {
  /* ── Constantes ──────────────────────────────────────────── */
  const GRID_SIZE = 26;
  const MAX_CELLS = GRID_SIZE * GRID_SIZE; // 676
  const CELL_PX = 23;

  /* ── Estado do jogo ──────────────────────────────────────── */
  const grids = document.getElementsByClassName('grid');
  const squadGrid = document.getElementById('squad-grid');
  const oceanGrid = document.getElementById('ocean-grid');
  const startGameBtn = document.getElementById('startGame');
  const gameCodeInput = document.getElementById('gameCode');

  const squaresSquad = [];
  const squaresOcean = [];
  let occupiedSquares = [];
  let myTurn = false;
  const attackedCells = new Set();

  const explosionAudio = new Audio('assets/explosion.mp3');
  const waterAudio = new Audio('assets/water.mp3');

  const ships = [
    { class: 'cruzader', frame: { h: '0010000E1111111', v: '01E01E01E11E01E01E01' } },
    { class: 'aircraft', frame: { h: '1111100E1111111E1111100', v: '010E010E111E111E111E111E111' } },
    { class: 'frigate', frame: { h: '0011100E1111111', v: '01E01E11E11E11E01E01' } },
    { class: 'submarine', frame: { h: '000100E111111', v: '01E01E11E01E01E01' } },
  ];

  /* ── Grid ────────────────────────────────────────────────── */
  function initGrid() {
    let id = 1;
    for (let i = 1; i < GRID_SIZE + 1; i++) {
      for (let j = 1; j < GRID_SIZE + 1; j++) {
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

  /* ── Posicionamento de navios ─────────────────────────────── */
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
          randomIndex = Math.floor(Math.random() * MAX_CELLS) + 1; // 1..676
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
            }
            k++;
          }
        }
      }

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

  /* ── Controle de turno ───────────────────────────────────── */
  function setMyTurn(value) {
    myTurn = value;
    if (oceanGrid) oceanGrid.style.cursor = myTurn ? 'pointer' : 'not-allowed';
  }

  /* ── Áudio ───────────────────────────────────────────────── */
  function playSound(hit) {
    explosionAudio.pause(); explosionAudio.currentTime = 0;
    waterAudio.pause(); waterAudio.currentTime = 0;
    if (hit) explosionAudio.play();
    else waterAudio.play();
  }

  /* ── Header de status ────────────────────────────────────── */
  function updateHeader(gameCode, msg) {
    const divHeader = document.getElementById('header');
    const existing = document.getElementById('box');
    if (existing) existing.remove();

    const box = document.createElement('div');
    box.id = 'box';
    const codeEl = document.createElement('p');
    codeEl.id = 'code';
    codeEl.textContent = gameCode;
    const msgEl = document.createElement('p');
    msgEl.id = 'msg';
    msgEl.textContent = msg;

    if (startGameBtn && gameCodeInput) {
      startGameBtn.remove();
      gameCodeInput.remove();
    }

    box.appendChild(msgEl);
    box.appendChild(codeEl);
    divHeader.insertBefore(box, divHeader.firstChild);
  }

  /* ── Game Over ───────────────────────────────────────────── */
  function showGameOver(winner) {
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

    box.appendChild(msgEl);
    divHeader.insertBefore(box, divHeader.firstChild);
  }

  /* ── Socket.IO ───────────────────────────────────────────── */
  function initSocket() {
    const pathParts = window.location.pathname.split('/');
    pathParts.pop();
    const basePath = pathParts.join('/');

    const socket = window.io(window.location.origin, {
      path: `${basePath}/socket.io`,
      transports: ['websocket', 'polling'],
      withCredentials: false,
    });

    socket.on('connect', () => {
      console.log('Conectado ao servidor Socket.IO');
    });

    socket.on('connect_error', (error) => {
      console.error('Erro de conexão Socket.IO:', error);
    });

    socket.on('startGame', res => {
      /* Primeiro jogador recebe "Your Turn", segundo recebe "wait for your turn" */
      setMyTurn(res.msg === 'Your Turn');
      updateHeader(res.gameCode, res.msg);
    });

    /* Recebe ataque do oponente — avalia hit nos próprios navios; agora é nossa vez */
    socket.on('attack', res => {
      const squad = document.getElementById(res);
      if (!squad) return;
      const isHit = occupiedSquares.includes(res);
      squad.classList.add(isHit ? 'explosion' : 'water');
      playSound(isHit);
      setMyTurn(true);
    });

    /* Recebe resultado do próprio ataque — calculado pelo servidor */
    socket.on('hit', res => {
      const ocean = document.getElementById(res.id);
      if (!ocean) return;
      ocean.classList.add(res.hit ? 'explosion' : 'water');
      playSound(res.hit);
      attackedCells.add(res.id);
      setMyTurn(false); // aguarda oponente atacar
    });

    socket.on('gameOver', res => {
      setMyTurn(false);
      showGameOver(res.winner);
    });

    socket.on('playerLeft', () => {
      setMyTurn(false);
      updateHeader('', 'Opponent disconnected. Game over.');
    });

    socket.on('error', res => {
      console.warn('Server error:', res.code);
      /* Reverte estado otimista se o servidor rejeitar o ataque */
      if (res.code === 'NOT_YOUR_TURN' || res.code === 'ALREADY_ATTACKED') {
        setMyTurn(true);
      }
    });

    return socket;
  }

  /* ── UI ──────────────────────────────────────────────────── */
  function initUI(socket) {
    if (startGameBtn) {
      startGameBtn.addEventListener('click', () => {
        const gameCode = gameCodeInput.value;
        socket.emit('startGame', { gameCode, ships: occupiedSquares });
      });
    }

    if (oceanGrid) {
      oceanGrid.addEventListener('click', e => {
        const cellId = e.target.id;
        if (!cellId) return;
        if (!myTurn) return;                        // não é a vez do jogador
        if (attackedCells.has(cellId)) return;      // célula já atacada
        setMyTurn(false);                           // bloqueia double-click
        socket.emit('attack', cellId);
      });
    }

    /* Modal */
    const infoModal = document.getElementById('infoModal');
    const openModalBtns = document.getElementsByClassName('openModal');
    const closeModalBtn = document.getElementsByClassName('close')[0];

    if (openModalBtns) {
      Array.from(openModalBtns).forEach(btn => {
        const modal = document.getElementById(`${btn.dataset.modal}Modal`);
        if (modal) {
          btn.addEventListener('click', () => modal.style.display = 'block');
        }
      });
    }

    if (closeModalBtn) {
      closeModalBtn.addEventListener('click', () => {
        infoModal.style.display = 'none';
      });
    }

    if (window.screen.width < 1440 && window.screen.height < 900) {
      alert('A minimum resolution of 1440x900 is recommended.');
    }
  }

  /* ── Boot ────────────────────────────────────────────────── */
  initGrid();
  initShips();
  const socket = initSocket();
  initUI(socket);
})();
