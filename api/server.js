/**
 * BattleshipGame API com Redis
 *
 * Description:
 * Backend do jogo Batalha Naval com Socket.IO e Redis para gerenciar conexões,
 * salas, sessões e turnos. Escalável e pronto para multi-instância.
 *
 * Author: Allan Barcelos
 * Updated: 2026-05-03
 * Version: 3.0
 */

const express = require("express");
const cors = require("cors");
const http = require("http");
const pino = require("pino");
const { createClient } = require("redis");
const { Server } = require("socket.io");
const { createAdapter } = require("@socket.io/redis-adapter");

/* Logger estruturado */
const logger = pino({ level: process.env.LOG_LEVEL || "info" });

const app = express();
app.disable("x-powered-by");
app.use(cors({ origin: "*" }));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

/* Redis Setup */
const redisHost = process.env.REDIS_HOST || "localhost";
const redisPort = process.env.REDIS_PORT || 6379;
const ROOM_TTL = 86400; // 24h em segundos

const pubClient = createClient({ url: `redis://${redisHost}:${redisPort}` });
const subClient = pubClient.duplicate();

Promise.all([pubClient.connect(), subClient.connect()])
  .then(() => logger.info("redis connected"))
  .catch((err) => logger.error({ err }, "redis connection failed"));

io.adapter(createAdapter(pubClient, subClient));

/* Rotas HTTP */
app.get("/", (req, res) => {
  res.json({ message: "BattleshipGame API with Redis" });
});

/* Validações */
function isValidCellId(id) {
  return /^ocean-([1-9]|[1-9][0-9]|[1-5][0-9]{2}|6[0-6][0-9]|67[0-6])$/.test(id);
}

/* Rate limiting por socket via Redis — janela de 1s */
async function checkRateLimit(socketId, event, max) {
  const key = `ratelimit:${socketId}:${event}`;
  const count = await pubClient.incr(key);
  if (count === 1) await pubClient.expire(key, 1);
  return count <= max;
}

/* Lógica do Jogo */
io.on("connection", (socket) => {
  logger.info({ socketId: socket.id }, "player connected");

  /* startGame — cria ou entra em sala */
  socket.on("startGame", async (res) => {
    if (!(await checkRateLimit(socket.id, "startGame", 2))) {
      socket.emit("error", { code: "RATE_LIMITED" });
      return;
    }

    const gameCode = res?.gameCode || makeid(10);
    const ships = res?.ships || [];
    const roomKey = `room:${gameCode}`;

    let room = await pubClient.lRange(roomKey, 0, -1);

    if (room.length >= 2) {
      socket.emit("roomFull", true);
      return;
    }

    /* Indexar socket → gameCode em O(1) */
    await pubClient.set(`socket:${socket.id}`, gameCode, { EX: ROOM_TTL });

    /* Salvar layout de navios do jogador */
    await pubClient.set(
      `ships:${gameCode}:${socket.id}`,
      JSON.stringify(ships),
      { EX: ROOM_TTL }
    );

    await pubClient.rPush(roomKey, socket.id);
    await pubClient.expire(roomKey, ROOM_TTL);
    socket.join(gameCode);

    logger.info({ socketId: socket.id, gameCode, roomSize: room.length + 1 }, "player joined room");

    if (room.length === 0) {
      /* Primeiro jogador — aguarda oponente */
      socket.emit("startGame", {
        gameCode,
        msg: "Send this code to your friend to start the game",
      });
    } else {
      /* Segundo jogador — inicia o jogo; oponente começa */
      const opponentId = room[0];
      await pubClient.set(`turn:${gameCode}`, opponentId, { EX: ROOM_TTL });
      await pubClient.set(`attacks:${gameCode}`, "[]", { EX: ROOM_TTL });

      io.to(opponentId).emit("startGame", { gameCode, msg: "Your Turn" });
      socket.emit("startGame", {
        gameCode,
        msg: "Game started, wait for your turn...",
      });

      logger.info({ gameCode, firstTurn: opponentId }, "game started");
    }
  });

  /* attack — valida turno, cellId e duplicatas; calcula hit server-side */
  socket.on("attack", async (cellId) => {
    if (!(await checkRateLimit(socket.id, "attack", 3))) {
      socket.emit("error", { code: "RATE_LIMITED" });
      return;
    }

    if (!isValidCellId(cellId)) {
      socket.emit("error", { code: "INVALID_CELL" });
      return;
    }

    const gameCode = await pubClient.get(`socket:${socket.id}`);
    if (!gameCode) return;

    /* Verificar turno */
    const currentTurn = await pubClient.get(`turn:${gameCode}`);
    if (currentTurn !== socket.id) {
      socket.emit("error", { code: "NOT_YOUR_TURN" });
      return;
    }

    /* Verificar ataque duplicado */
    const attacksRaw = await pubClient.get(`attacks:${gameCode}`);
    const attacks = JSON.parse(attacksRaw || "[]");
    if (attacks.includes(cellId)) {
      socket.emit("error", { code: "ALREADY_ATTACKED" });
      return;
    }
    attacks.push(cellId);
    await pubClient.set(`attacks:${gameCode}`, JSON.stringify(attacks), { EX: ROOM_TTL });

    /* Buscar oponente */
    const room = await pubClient.lRange(`room:${gameCode}`, 0, -1);
    const opponentId = room.find((id) => id !== socket.id);
    if (!opponentId) return;

    /* Calcular hit server-side */
    const shipsRaw = await pubClient.get(`ships:${gameCode}:${opponentId}`);
    const opponentShips = JSON.parse(shipsRaw || "[]");

    /* cellId vem como "ocean-N", navios do oponente são "squad-N" */
    const squadCell = cellId.replace("ocean", "squad");
    const isHit = opponentShips.includes(squadCell);

    if (isHit) {
      const remaining = opponentShips.filter((c) => c !== squadCell);
      await pubClient.set(
        `ships:${gameCode}:${opponentId}`,
        JSON.stringify(remaining),
        { EX: ROOM_TTL }
      );

      /* Notificar ambos sobre o hit */
      socket.emit("hit", { hit: true, id: cellId });
      io.to(opponentId).emit("attack", squadCell);

      logger.info({ gameCode, attacker: socket.id, cell: cellId, remaining: remaining.length }, "hit");

      /* Verificar vitória */
      if (remaining.length === 0) {
        io.to(socket.id).emit("gameOver", { winner: true });
        io.to(opponentId).emit("gameOver", { winner: false });
        logger.info({ gameCode, winner: socket.id }, "game over");
        await cleanupGame(gameCode, socket.id, opponentId);
        return;
      }
    } else {
      socket.emit("hit", { hit: false, id: cellId });
      io.to(opponentId).emit("attack", squadCell);
      logger.info({ gameCode, attacker: socket.id, cell: cellId }, "miss");
    }

    /* Alternar turno */
    await pubClient.set(`turn:${gameCode}`, opponentId, { EX: ROOM_TTL });
  });

  /* disconnect — remove socket da sala e notifica oponente */
  socket.on("disconnect", async () => {
    const gameCode = await pubClient.get(`socket:${socket.id}`);
    logger.info({ socketId: socket.id, gameCode }, "player disconnected");

    if (!gameCode) return;

    await pubClient.lRem(`room:${gameCode}`, 0, socket.id);
    await pubClient.del(`socket:${socket.id}`);

    io.to(gameCode).emit("playerLeft", { msg: "Opponent disconnected" });
  });
});

/* Limpar chaves do jogo encerrado */
async function cleanupGame(gameCode, playerA, playerB) {
  await pubClient.del(
    `room:${gameCode}`,
    `turn:${gameCode}`,
    `attacks:${gameCode}`,
    `ships:${gameCode}:${playerA}`,
    `ships:${gameCode}:${playerB}`,
    `socket:${playerA}`,
    `socket:${playerB}`
  );
  logger.info({ gameCode }, "game cleaned up");
}

/* Funções Auxiliares */
function makeid(length) {
  let result = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/* Iniciar Servidor */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  logger.info({ port: PORT }, "BattleshipGame API running");
});

module.exports = { app, server, io, pubClient };
