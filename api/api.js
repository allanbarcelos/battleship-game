/**
 * BattleshipGame API
 * 
 * Description: This script implements the backend API for a Battleship game using Socket.IO for real-time communication.
 * It allows players to start a game, make attacks, and handle hits.
 * 
 * Author: Allan Barcelos
 * Date: 2024-05-13
 * Version: 1.0
 */

const dotenv = require('dotenv');
const path = require('path');
const express = require("express");
const cors = require("cors");
const http = require("http");
const socketio = require("socket.io");

dotenv.config({ path: path.join(__dirname, '.env') });

const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: "*" }));
app.use(express.json());

const server = http.createServer(app);
const io = socketio(server, { cors: { origin: "*" } });
let rooms = {};
let sockets = {};

// Rotas
app.get("/api/", async (req, res) => {
    res.json({ message: "BattleshipGame API" });
});

// Socket.io
io.on('connection', (socket) => {
    sockets[socket.id] = socket;

    socket.on("startGame", (res) => {
        const gameCode = res?.gameCode ? res.gameCode : makeid(10);

        if (rooms[gameCode] && rooms[gameCode].length > 2) {
            socket.emit('roomFull', true);
            return 0;
        }

        if (!rooms[gameCode])
            rooms[gameCode] = [socket.id];
        else
            rooms[gameCode].push(socket.id);

        socket.join(gameCode);

        if (rooms[gameCode].length === 1) {
            socket.emit('startGame', { gameCode, msg: 'Send this code to your friend to start the game' });
        } else {
            const opponentId = rooms[gameCode].find(id => id !== socket.id);
            sockets[opponentId].emit('startGame', { gameCode, msg: 'Your Turn' });
            socket.emit('startGame', { gameCode, msg: 'The game start, wait for your turn ...' });
        }
    });

    socket.on("attack", (res) => {
        const room = findKeyByValue(socket.id);
        const opponentId = rooms[room].find(id => id !== socket.id);
        sockets[opponentId].emit('attack', res.replace("ocean", "squad"));
    });

    socket.on("hit", (res) => {
        const room = findKeyByValue(socket.id);
        const opponentId = rooms[room].find(id => id !== socket.id);
        sockets[opponentId].emit('hit', { hit: res.hit, id: res.id.replace("squad", "ocean") });
    });

    socket.on("disconnect", () => {
        console.log(`${socket.id} disconnected`);
        delete sockets[socket.id];
    });
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});

// Funções auxiliares
function makeid(length) {
    let result = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const charsLength = chars.length;
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * charsLength));
    }
    return result;
}

function findKeyByValue(value) {
    for (let key in rooms) {
        if (rooms[key].includes(value)) {
            return key;
        }
    }
    return null;
}
