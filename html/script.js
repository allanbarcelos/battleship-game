/*
 * Battleship Game Script
 * Author: Allan Barcelos
 * Description: Multiplayer Battleship game with Socket.IO
 */


let grids = document.getElementsByClassName('grid');
let squadGrid = document.getElementById('squad-grid');
let oceanGrid = document.getElementById('ocean-grid');
let startGameBtn = document.getElementById('startGame');
let gameCodeInput = document.getElementById('gameCode');
let squaresSquad = [];
let squaresOcean = [];
let occupiedSquares = [];
let explosionAudio = new Audio('assets/explosion.mp3');
let waterAudio = new Audio('assets/water.mp3');

let ships = [
  { class: 'cruzader', frame: { h: '0010000E1111111', v: '01E01E01E11E01E01E01' } },
  { class: 'aircraft', frame: { h: '1111100E1111111E1111100', v: '010E010E111E111E111E111E111' } },
  { class: 'frigate', frame: { h: '0011100E1111111', v: '01E01E11E11E11E01E01' } },
  { class: 'submarine', frame: { h: '000100E111111', v: '01E01E11E01E01E01' } },
];

function createGrid() {
  let id = 1;
  for (let i = 1; i < 27; i++) {
    for (let j = 1; j < 27; j++) {
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

function placePlayerShips() {
  ships.forEach(ship => {
    const direction = Math.random() < 0.5 ? 'h' : 'v';
    const frame = ship.frame[direction];
    let h = frame.split('E').length;
    let w = frame.split('E')[0].length;
    let x, y, randomIndex;
    let square;
    let occupied;
    do {
      occupied = false;
      do {
        randomIndex = Math.floor(Math.random() * 676);
        square = document.getElementById(`squad-${randomIndex}`);
        x = +square.dataset.x;
        y = +square.dataset.y;
      } while (h + y > 26 || w + x > 26);
      for (let j = y; j < y + h + 1; j++) {
        for (let i = x; i < x + w + 1; i++) {
          const _s = document.querySelector(`div[data-x="${i}"][data-y="${j}"]`);
          if (_s && occupiedSquares.includes(_s.id)) occupied = true;
        }
      }
    } while (occupied);

    let k = 0, firstSquareTop, firstSquareLeft;
    for (let j = y; j < y + h + 1; j++) {
      for (let i = x; i < x + w + 1; i++) {
        const _s = document.querySelector(`div[data-x="${i}"][data-y="${j}"]`);
        if (_s) {
          if (j === y && i === x) {
            firstSquareTop = _s.offsetTop;
            firstSquareLeft = _s.offsetLeft;
          }
          if (frame[k] === '1') {
            occupiedSquares.push(_s.id);
            _s.classList.add('occupied');
          }
          k++;
        }
      }
    }

    const shipDiv = document.createElement('span');
    shipDiv.style.width = `${w * 23}px`;
    shipDiv.style.height = `${h * 23}px`;
    shipDiv.dataset.ship = ship.class;
    shipDiv.style.position = 'absolute';
    shipDiv.style.top = `${firstSquareTop}px`;
    shipDiv.style.left = `${firstSquareLeft}px`;
    shipDiv.classList.add(`sprite-${direction}`, `${ship.class}-${direction}`);
    squadGrid.appendChild(shipDiv);
  });
}

function sounds(res) {
  explosionAudio.pause(); explosionAudio.currentTime = 0;
  waterAudio.pause(); waterAudio.currentTime = 0;
  if (res.success) explosionAudio.play();
  else waterAudio.play();
}

createGrid();
placePlayerShips();


// --- Socket.IO - Configuração Corrigida

const { origin, pathname } = window.location;
const fullPath = `${origin}${pathname}`;
console.log(fullPath);

const socket = io(fullPath, {
  transports: ['websocket', 'polling'], // Forçar ambos os transportes
  withCredentials: false
});

socket.on("connect", () => {
  console.log('Conectado ao servidor Socket.IO');
});

socket.on("connect_error", (error) => {
  console.error('Erro de conexão Socket.IO:', error);
});

socket.on("startGame", res => {
  const divHeader = document.getElementById('header');
  const _box = document.getElementById('box');
  if (_box) _box.remove();
  const box = document.createElement('div');
  box.id = "box";
  const code = document.createElement('p'); code.id = "code"; code.textContent = res.gameCode;
  const msg = document.createElement('p'); msg.id = "msg"; msg.textContent = res.msg;
  if (startGameBtn && gameCodeInput) { startGameBtn.remove(); gameCodeInput.remove(); }
  box.appendChild(msg); box.appendChild(code);
  divHeader.insertBefore(box, divHeader.firstChild);
});

socket.on("attack", res => {
  const squad = document.getElementById(res);
  if (occupiedSquares.includes(res)) {
    squad.classList.add('explosion');
    explosionAudio.play();
    socket.emit("hit", { hit: true, id: res });
  } else {
    squad.classList.add('water');
    waterAudio.play();
    socket.emit("hit", { hit: false, id: res });
  }
});

socket.on("hit", res => {
  const ocean = document.getElementById(res.id);
  if (res.hit) {
    ocean.classList.add('explosion');
    explosionAudio.play();
  } else {
    ocean.classList.add('water');
    waterAudio.play();
  }
});

// --- Eventos do DOM
if (startGameBtn) {
  startGameBtn.addEventListener('click', () => {
    const gameCode = gameCodeInput.value;
    socket.emit("startGame", { gameCode });
  });
}

if (oceanGrid) {
  oceanGrid.addEventListener('click', e => {
    if (e.target.id) socket.emit("attack", e.target.id);
  });
}

// Modal
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
  closeModalBtn.addEventListener('click', e => {
    if (e.target.dataset.modal === "info") infoModal.style.display = 'none';
  });
}

// --- Alert resolução mínima
if (window.screen.width < 1440 && window.screen.height < 900) {
  alert('A minimum resolution of 1440x900 is recommended.');
}