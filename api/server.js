/**
 * BattleshipGame API com Redis
 * 
 * Description:
 * Backend do jogo Batalha Naval com Socket.IO e Redis para gerenciar conexões,
 * salas, sessões e turnos. Escalável e pronto para multi-instância.
 * 
 * Author: Allan Barcelos
 * Updated: 2025-11-09
 * Version: 2.0
 */

const express = require("express");
const cors = require("cors");
const http = require("http");
const { createClient } = require("redis");
const { Server } = require("socket.io");
const { createAdapter } = require("@socket.io/redis-adapter");

const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: "*" }));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

/* Redis Setup */
const redisHost = process.env.REDIS_HOST || "localhost";
const redisPort = process.env.REDIS_PORT || 6379;

const pubClient = createClient({ url: `redis://${redisHost}:${redisPort}` });
const subClient = pubClient.duplicate();

Promise.all([pubClient.connect(), subClient.connect()])
  .then(() => console.log("Redis conectado com sucesso"))
  .catch(console.error);

// Conectar o Redis como adaptador do Socket.IO
io.adapter(createAdapter(pubClient, subClient));

/* Rotas HTTP */
app.get("/", async (req, res) => {
  res.json({ message: "BattleshipGame API with Redis" });
});

/* Lógica do Jogo */
io.on("connection", (socket) => {
  console.log(`Novo jogador conectado: ${socket.id}`);

  socket.on("startGame", async (res) => {
    const gameCode = res?.gameCode || makeid(10);
    const roomKey = `room:${gameCode}`;

    let room = await pubClient.lRange(roomKey, 0, -1);

    if (room.length >= 2) {
      socket.emit("roomFull", true);
      return;
    }

    await pubClient.rPush(roomKey, socket.id);
    socket.join(gameCode);

    if (room.length === 0) {
      socket.emit("startGame", {
        gameCode,
        msg: "Send this code to your friend to start the game",
      });
    } else {
      const opponentId = room[0];
      const turnKey = `turn:${gameCode}`;
      await pubClient.set(turnKey, opponentId);

      io.to(opponentId).emit("startGame", { gameCode, msg: "Your Turn" });
      socket.emit("startGame", {
        gameCode,
        msg: "Game started, wait for your turn...",
      });
    }
  });

  socket.on("attack", async (res) => {
    const gameCode = await findRoomBySocket(socket.id);
    if (!gameCode) return;

    const roomKey = `room:${gameCode}`;
    const room = await pubClient.lRange(roomKey, 0, -1);
    const opponentId = room.find((id) => id !== socket.id);

    io.to(opponentId).emit("attack", res.replace("ocean", "squad"));

    // alternar turno
    const turnKey = `turn:${gameCode}`;
    await pubClient.set(turnKey, opponentId);
  });

  socket.on("hit", async (res) => {
    const gameCode = await findRoomBySocket(socket.id);
    if (!gameCode) return;

    const roomKey = `room:${gameCode}`;
    const room = await pubClient.lRange(roomKey, 0, -1);
    const opponentId = room.find((id) => id !== socket.id);

    io.to(opponentId).emit("hit", {
      hit: res.hit,
      id: res.id.replace("squad", "ocean"),
    });
  });

  socket.on("disconnect", async () => {
    console.log(`${socket.id} desconectado`);
    const gameCode = await findRoomBySocket(socket.id);
    if (!gameCode) return;

    const roomKey = `room:${gameCode}`;
    await pubClient.lRem(roomKey, 0, socket.id);

    io.to(gameCode).emit("playerLeft", { msg: "Opponent disconnected" });
  });
});

/* Funções Auxiliares */
function makeid(length) {
  let result = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

async function findRoomBySocket(socketId) {
  const keys = await pubClient.keys("room:*");
  for (let key of keys) {
    const members = await pubClient.lRange(key, 0, -1);
    if (members.includes(socketId)) {
      return key.split(":")[1];
    }
  }
  return null;
}

/* Iniciar Servidor */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`BattleshipGame API running on port ${PORT}`);
});
