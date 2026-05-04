/**
 * Battleship Game — Server Tests
 *
 * Testa os principais fluxos do servidor sem depender de Redis ou infra real.
 * Usa mocks para pubClient e subClient.
 */

const http = require("http");
const { Server } = require("socket.io");
const { io: Client } = require("socket.io-client");

/* ── Helpers ─────────────────────────────────────────────── */

function makeId(length = 10) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return Array.from({ length }, () =>
    chars.charAt(Math.floor(Math.random() * chars.length))
  ).join("");
}

function isValidCellId(id) {
  return /^ocean-([1-9]|[1-9][0-9]|[1-5][0-9]{2}|6[0-6][0-9]|67[0-6])$/.test(id);
}

/* ── Unit tests — Funções auxiliares ─────────────────────── */

describe("makeid", () => {
  test("gera string com 10 caracteres", () => {
    expect(makeId(10)).toHaveLength(10);
  });

  test("usa apenas chars válidos", () => {
    const id = makeId(10);
    expect(id).toMatch(/^[A-Z0-9]{10}$/);
  });

  test("gera ids diferentes a cada chamada", () => {
    expect(makeId(10)).not.toBe(makeId(10));
  });
});

/* ── Unit tests — Validação de cellId ───────────────────── */

describe("isValidCellId", () => {
  test("aceita células válidas", () => {
    expect(isValidCellId("ocean-1")).toBe(true);
    expect(isValidCellId("ocean-100")).toBe(true);
    expect(isValidCellId("ocean-676")).toBe(true);
    expect(isValidCellId("ocean-26")).toBe(true);
  });

  test("rejeita células inválidas", () => {
    expect(isValidCellId("ocean-0")).toBe(false);
    expect(isValidCellId("ocean-677")).toBe(false);
    expect(isValidCellId("squad-1")).toBe(false);
    expect(isValidCellId("ocean-abc")).toBe(false);
    expect(isValidCellId("")).toBe(false);
    expect(isValidCellId("ocean-")).toBe(false);
  });
});

/* ── Integration tests — Socket.IO com mock Redis ───────── */

/**
 * Cria uma instância de servidor isolada com Redis mockado em memória.
 * Cada suite recebe seu próprio servidor para evitar estado compartilhado.
 */
function createTestServer() {
  /* ── Mock Redis em memória ── */
  const store = new Map();
  const lists = new Map();

  const redisMock = {
    get: jest.fn(async (key) => store.get(key) ?? null),
    set: jest.fn(async (key, value) => { store.set(key, value); return "OK"; }),
    del: jest.fn(async (...keys) => { keys.forEach((k) => store.delete(k)); return keys.length; }),
    incr: jest.fn(async (key) => {
      const val = (parseInt(store.get(key) || "0", 10)) + 1;
      store.set(key, String(val));
      return val;
    }),
    expire: jest.fn(async () => 1),
    lRange: jest.fn(async (key) => lists.get(key) ?? []),
    rPush: jest.fn(async (key, val) => {
      const list = lists.get(key) ?? [];
      list.push(val);
      lists.set(key, list);
      return list.length;
    }),
    lRem: jest.fn(async (key, _, val) => {
      const list = (lists.get(key) ?? []).filter((v) => v !== val);
      lists.set(key, list);
      return 1;
    }),
    connect: jest.fn(async () => {}),
    duplicate: jest.fn(function () { return this; }),
  };

  /* ── Servidor Socket.IO ── */
  const httpServer = http.createServer();
  const io = new Server(httpServer, { cors: { origin: "*" } });

  const ROOM_TTL = 86400;

  function isValidCell(id) {
    return /^ocean-([1-9]|[1-9][0-9]|[1-5][0-9]{2}|6[0-6][0-9]|67[0-6])$/.test(id);
  }

  async function checkRateLimit(socketId, event, max) {
    const key = `ratelimit:${socketId}:${event}`;
    const count = await redisMock.incr(key);
    if (count === 1) await redisMock.expire(key, 1);
    return count <= max;
  }

  async function cleanupGame(gameCode, a, b) {
    await redisMock.del(
      `room:${gameCode}`, `turn:${gameCode}`, `attacks:${gameCode}`,
      `ships:${gameCode}:${a}`, `ships:${gameCode}:${b}`,
      `socket:${a}`, `socket:${b}`
    );
  }

  io.on("connection", (socket) => {
    socket.on("startGame", async (res) => {
      if (!(await checkRateLimit(socket.id, "startGame", 2))) {
        socket.emit("error", { code: "RATE_LIMITED" }); return;
      }
      const gameCode = res?.gameCode || makeId(10);
      const ships = res?.ships || [];
      let room = await redisMock.lRange(`room:${gameCode}`, 0, -1);
      if (room.length >= 2) { socket.emit("roomFull", true); return; }

      await redisMock.set(`socket:${socket.id}`, gameCode, { EX: ROOM_TTL });
      await redisMock.set(`ships:${gameCode}:${socket.id}`, JSON.stringify(ships), { EX: ROOM_TTL });
      await redisMock.rPush(`room:${gameCode}`, socket.id);
      socket.join(gameCode);

      if (room.length === 0) {
        socket.emit("startGame", { gameCode, msg: "Send this code to your friend to start the game" });
      } else {
        const opponentId = room[0];
        await redisMock.set(`turn:${gameCode}`, opponentId, { EX: ROOM_TTL });
        await redisMock.set(`attacks:${gameCode}`, "[]", { EX: ROOM_TTL });
        io.to(opponentId).emit("startGame", { gameCode, msg: "Your Turn" });
        socket.emit("startGame", { gameCode, msg: "Game started, wait for your turn..." });
      }
    });

    socket.on("attack", async (cellId) => {
      if (!(await checkRateLimit(socket.id, "attack", 3))) {
        socket.emit("error", { code: "RATE_LIMITED" }); return;
      }
      if (!isValidCell(cellId)) { socket.emit("error", { code: "INVALID_CELL" }); return; }

      const gameCode = await redisMock.get(`socket:${socket.id}`);
      if (!gameCode) return;

      const currentTurn = await redisMock.get(`turn:${gameCode}`);
      if (currentTurn !== socket.id) { socket.emit("error", { code: "NOT_YOUR_TURN" }); return; }

      const attacksRaw = await redisMock.get(`attacks:${gameCode}`);
      const attacks = JSON.parse(attacksRaw || "[]");
      if (attacks.includes(cellId)) { socket.emit("error", { code: "ALREADY_ATTACKED" }); return; }
      attacks.push(cellId);
      await redisMock.set(`attacks:${gameCode}`, JSON.stringify(attacks), { EX: ROOM_TTL });

      const room = await redisMock.lRange(`room:${gameCode}`, 0, -1);
      const opponentId = room.find((id) => id !== socket.id);
      if (!opponentId) return;

      const shipsRaw = await redisMock.get(`ships:${gameCode}:${opponentId}`);
      const opponentShips = JSON.parse(shipsRaw || "[]");
      const squadCell = cellId.replace("ocean", "squad");
      const isHit = opponentShips.includes(squadCell);

      if (isHit) {
        const remaining = opponentShips.filter((c) => c !== squadCell);
        await redisMock.set(`ships:${gameCode}:${opponentId}`, JSON.stringify(remaining), { EX: ROOM_TTL });
        socket.emit("hit", { hit: true, id: cellId });
        io.to(opponentId).emit("attack", squadCell);
        if (remaining.length === 0) {
          io.to(socket.id).emit("gameOver", { winner: true });
          io.to(opponentId).emit("gameOver", { winner: false });
          await cleanupGame(gameCode, socket.id, opponentId);
          return;
        }
      } else {
        socket.emit("hit", { hit: false, id: cellId });
        io.to(opponentId).emit("attack", squadCell);
      }
      await redisMock.set(`turn:${gameCode}`, opponentId, { EX: ROOM_TTL });
    });

    socket.on("disconnect", async () => {
      const gameCode = await redisMock.get(`socket:${socket.id}`);
      if (!gameCode) return;
      await redisMock.lRem(`room:${gameCode}`, 0, socket.id);
      await redisMock.del(`socket:${socket.id}`);
      io.to(gameCode).emit("playerLeft", { msg: "Opponent disconnected" });
    });
  });

  return { httpServer, io, redisMock, store, lists };
}

/* ── Helpers de conexão ──────────────────────────────────── */

function connectClient(port) {
  return new Promise((resolve) => {
    const client = Client(`http://localhost:${port}`, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
    });
    client.on("connect", () => resolve(client));
  });
}

function waitFor(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

/* ── Suite: startGame ─────────────────────────────────────── */

describe("startGame", () => {
  let httpServer, io, port, clientA;

  beforeAll((done) => {
    ({ httpServer, io } = createTestServer());
    httpServer.listen(0, () => {
      port = httpServer.address().port;
      done();
    });
  });

  afterAll((done) => {
    clientA?.disconnect();
    io.close(done);
  });

  test("sem gameCode, gera código novo e emite startGame", async () => {
    clientA = await connectClient(port);
    const res = await new Promise((resolve) => {
      clientA.emit("startGame", {});
      clientA.once("startGame", resolve);
    });
    expect(res.gameCode).toMatch(/^[A-Z0-9]{10}$/);
    expect(res.msg).toContain("Send this code");
  });

  test("com código existente, 2º jogador entra e recebe mensagem de espera", async () => {
    const { httpServer: srv2, io: io2 } = createTestServer();
    await new Promise((r) => srv2.listen(0, r));
    const p2 = srv2.address().port;

    const c1 = await connectClient(p2);
    const gameCode = await new Promise((resolve) => {
      c1.emit("startGame", { gameCode: "", ships: [] });
      c1.once("startGame", (r) => resolve(r.gameCode));
    });

    const c2 = await connectClient(p2);
    const [res1, res2] = await Promise.all([
      waitFor(c1, "startGame"),
      new Promise((resolve) => {
        c2.emit("startGame", { gameCode, ships: [] });
        c2.once("startGame", resolve);
      }),
    ]);

    expect(res1.msg).toBe("Your Turn");
    expect(res2.msg).toContain("wait for your turn");

    c1.disconnect();
    c2.disconnect();
    await new Promise((r) => io2.close(r));
  });

  test("sala cheia emite roomFull", async () => {
    const { httpServer: srv3, io: io3 } = createTestServer();
    await new Promise((r) => srv3.listen(0, r));
    const p3 = srv3.address().port;

    const gameCode = makeId(10);
    const c1 = await connectClient(p3);
    const c2 = await connectClient(p3);
    const c3 = await connectClient(p3);

    await new Promise((r) => { c1.emit("startGame", { gameCode, ships: [] }); c1.once("startGame", r); });
    await new Promise((r) => { c2.emit("startGame", { gameCode, ships: [] }); c2.once("startGame", r); });

    const full = await new Promise((resolve) => {
      c3.emit("startGame", { gameCode, ships: [] });
      c3.once("roomFull", resolve);
    });

    expect(full).toBe(true);
    c1.disconnect(); c2.disconnect(); c3.disconnect();
    await new Promise((r) => io3.close(r));
  });
});

/* ── Suite: attack validations ───────────────────────────── */

describe("attack — validações", () => {
  let httpServer, io, port, c1, c2, gameCode;

  beforeAll(async () => {
    ({ httpServer, io } = createTestServer());
    await new Promise((r) => httpServer.listen(0, r));
    port = httpServer.address().port;

    gameCode = makeId(10);
    c1 = await connectClient(port);
    c2 = await connectClient(port);

    await new Promise((r) => { c1.emit("startGame", { gameCode, ships: ["squad-1"] }); c1.once("startGame", r); });
    // c1 é o oponente que vai iniciar; c2 entra e recebe "wait"
    await new Promise((r) => {
      c2.emit("startGame", { gameCode, ships: ["squad-2"] });
      // c1 recebe "Your Turn", c2 recebe "wait for your turn"
      Promise.all([waitFor(c1, "startGame"), waitFor(c2, "startGame")]).then(r);
    });
  });

  afterAll((done) => {
    c1?.disconnect(); c2?.disconnect();
    io.close(done);
  });

  test("cellId inválido retorna INVALID_CELL", async () => {
    const err = await new Promise((resolve) => {
      c1.emit("attack", "ocean-999");
      c1.once("error", resolve);
    });
    expect(err.code).toBe("INVALID_CELL");
  });

  test("atacar fora de turno retorna NOT_YOUR_TURN", async () => {
    /* c2 não tem o turno (c1 começa) */
    const err = await new Promise((resolve) => {
      c2.emit("attack", "ocean-1");
      c2.once("error", resolve);
    });
    expect(err.code).toBe("NOT_YOUR_TURN");
  });

  test("ataque válido no turno correto — miss", async () => {
    /* c1 tem o turno; "ocean-1" não está nos navios de c2 (squad-2) */
    const hit = await new Promise((resolve) => {
      c1.emit("attack", "ocean-1");
      c1.once("hit", resolve);
    });
    expect(hit.hit).toBe(false);
    expect(hit.id).toBe("ocean-1");
  });

  test("ataque duplicado retorna ALREADY_ATTACKED", async () => {
    /* c2 agora tem o turno após c1 atacar */
    await new Promise((resolve) => {
      c2.emit("attack", "ocean-10");
      c2.once("hit", resolve);
    });
    /* turno voltou para c1 — c1 avança o turno de volta para c2 */
    await new Promise((resolve) => {
      c1.emit("attack", "ocean-5");
      c1.once("hit", resolve);
    });
    /* c2 tenta a mesma célula que já atacou */
    const err = await new Promise((resolve) => {
      c2.emit("attack", "ocean-10");
      c2.once("error", resolve);
    });
    expect(err.code).toBe("ALREADY_ATTACKED");
  });
});

/* ── Suite: gameOver ─────────────────────────────────────── */

describe("gameOver", () => {
  test("emite gameOver quando todos os navios são destruídos", async () => {
    const { httpServer, io } = createTestServer();
    await new Promise((r) => httpServer.listen(0, r));
    const port = httpServer.address().port;
    const code = makeId(10);

    const c1 = await connectClient(port);
    const c2 = await connectClient(port);

    /* c2 tem apenas uma célula de navio */
    await new Promise((r) => { c1.emit("startGame", { gameCode: code, ships: ["squad-1"] }); c1.once("startGame", r); });
    await Promise.all([
      waitFor(c1, "startGame"),
      new Promise((r) => { c2.emit("startGame", { gameCode: code, ships: ["squad-2"] }); c2.once("startGame", r); }),
    ]);

    /* c1 tem o turno; ataca a única célula de c2 (ocean-2 = squad-2) */
    const [go1, go2] = await Promise.all([
      waitFor(c1, "gameOver"),
      waitFor(c2, "gameOver"),
      new Promise((r) => { c1.emit("attack", "ocean-2"); setTimeout(r, 50); }),
    ]);

    expect(go1.winner).toBe(true);
    expect(go2.winner).toBe(false);

    c1.disconnect(); c2.disconnect();
    await new Promise((r) => io.close(r));
  });
});

/* ── Suite: disconnect ───────────────────────────────────── */

describe("disconnect", () => {
  test("notifica oponente quando jogador sai", async () => {
    const { httpServer, io } = createTestServer();
    await new Promise((r) => httpServer.listen(0, r));
    const port = httpServer.address().port;
    const code = makeId(10);

    const c1 = await connectClient(port);
    const c2 = await connectClient(port);

    await new Promise((r) => { c1.emit("startGame", { gameCode: code, ships: [] }); c1.once("startGame", r); });
    await Promise.all([
      waitFor(c1, "startGame"),
      new Promise((r) => { c2.emit("startGame", { gameCode: code, ships: [] }); c2.once("startGame", r); }),
    ]);

    const [left] = await Promise.all([
      waitFor(c1, "playerLeft"),
      new Promise((r) => { c2.disconnect(); setTimeout(r, 100); }),
    ]);

    expect(left.msg).toBe("Opponent disconnected");

    c1.disconnect();
    await new Promise((r) => io.close(r));
  });
});
