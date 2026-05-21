const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// rooms: { roomId: { players, fen, moves, timers, rematchVotes, chatHistory } }
const rooms = {};

// How long (ms) an empty room persists before being cleaned up
const ROOM_CLEANUP_DELAY = 30_000; // 30 seconds
const DEFAULT_TIME_MS = 10 * 60 * 1000; // 10 minutes per player

function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function getRoomOfSocket(socketId) {
  for (const [roomId, room] of Object.entries(rooms)) {
    const player = room.players.find((p) => p.id === socketId);
    if (player) return { roomId, room, player };
  }
  return null;
}

function scheduleRoomCleanup(roomId) {
  setTimeout(() => {
    const room = rooms[roomId];
    if (room && room.players.length === 0) {
      delete rooms[roomId];
      console.log(`Room ${roomId} cleaned up after inactivity.`);
    }
  }, ROOM_CLEANUP_DELAY);
}

function startClock(roomId) {
  const room = rooms[roomId];
  if (!room || room.clockInterval) return;

  room.clockInterval = setInterval(() => {
    const r = rooms[roomId];
    if (!r) return clearInterval(r?.clockInterval);

    const current = r.players.find((p) => p.color === r.turn);
    if (!current) return;

    current.timeMs -= 1000;

    io.to(roomId).emit("clock_update", {
      times: r.players.reduce((acc, p) => {
        acc[p.color] = p.timeMs;
        return acc;
      }, {}),
    });

    if (current.timeMs <= 0) {
      clearInterval(r.clockInterval);
      r.clockInterval = null;
      io.to(roomId).emit("game_over", {
        result: `${current.color === "w" ? "Black" : "White"} wins on time`,
      });
    }
  }, 1000);
}

function stopClock(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  if (room.clockInterval) {
    clearInterval(room.clockInterval);
    room.clockInterval = null;
  }
}

function resetRoom(room) {
  room.fen = "start";
  room.moves = [];
  room.turn = "w";
  room.rematchVotes = new Set();
  room.drawOfferFrom = null;
  room.chatHistory = room.chatHistory || [];
  room.players.forEach((p) => {
    p.timeMs = DEFAULT_TIME_MS;
  });
}

io.on("connection", (socket) => {
  console.log("Player connected:", socket.id);

  // ─── Create Room ─────────────────────────────────────────────────────────
  socket.on("create_room", ({ playerName }) => {
    if (!playerName || typeof playerName !== "string" || playerName.trim() === "") {
      socket.emit("error", { message: "Invalid player name." });
      return;
    }
    const name = playerName.trim().substring(0, 20);
    const roomId = generateRoomId();
    rooms[roomId] = {
      players: [{ id: socket.id, name, color: "w", timeMs: DEFAULT_TIME_MS }],
      fen: "start",
      moves: [],
      turn: "w",
      rematchVotes: new Set(),
      drawOfferFrom: null,
      chatHistory: [],
      clockInterval: null,
    };
    socket.join(roomId);
    socket.emit("room_created", { roomId, color: "w", playerName: name });
    console.log(`Room ${roomId} created by ${name}`);
  });

  // ─── Join Room ────────────────────────────────────────────────────────────
  socket.on("join_room", ({ roomId, playerName }) => {
    if (!playerName || typeof playerName !== "string" || playerName.trim() === "") {
      socket.emit("error", { message: "Invalid player name." });
      return;
    }
    if (!roomId || typeof roomId !== "string") {
      socket.emit("error", { message: "Invalid room ID." });
      return;
    }

    const room = rooms[roomId.toUpperCase()];
    if (!room) {
      socket.emit("error", { message: "Room not found. Check the room code." });
      return;
    }
    if (room.players.length >= 2) {
      socket.emit("error", { message: "Room is full." });
      return;
    }

    const name = playerName.trim().substring(0, 20);
    room.players.push({ id: socket.id, name, color: "b", timeMs: DEFAULT_TIME_MS });
    socket.join(roomId.toUpperCase());

    const opponent = room.players[0];
    socket.emit("room_joined", {
      roomId: roomId.toUpperCase(),
      color: "b",
      opponentName: opponent.name,
    });
    io.to(opponent.id).emit("opponent_joined", { opponentName: name });

    // Start the clock when both players are in
    startClock(roomId.toUpperCase());
    console.log(`${name} joined room ${roomId.toUpperCase()}`);
  });

  // ─── Move ─────────────────────────────────────────────────────────────────
  socket.on("move", ({ roomId, move, fen }) => {
    const room = rooms[roomId];
    if (!room) return;

    // Validate it's this player's turn
    const player = room.players.find((p) => p.id === socket.id);
    if (!player || player.color !== room.turn) {
      socket.emit("error", { message: "It's not your turn." });
      return;
    }

    room.fen = fen;
    room.moves.push(move);
    room.turn = room.turn === "w" ? "b" : "w";
    room.drawOfferFrom = null; // Cancel pending draw offer on move

    socket.to(roomId).emit("opponent_move", { move, fen });
  });

  // ─── Game Over ────────────────────────────────────────────────────────────
  socket.on("game_over", ({ roomId, result }) => {
    stopClock(roomId);
    socket.to(roomId).emit("game_over", { result });
  });

  // ─── Rematch (requires BOTH players to agree) ─────────────────────────────
  socket.on("rematch_request", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;

    room.rematchVotes.add(socket.id);

    if (room.rematchVotes.size === 1) {
      // Notify opponent of the request
      socket.to(roomId).emit("rematch_requested", { from: player.name });
    }

    if (room.rematchVotes.size >= 2) {
      // Both agreed — reset and start
      stopClock(roomId);
      room.players.forEach((p) => {
        p.color = p.color === "w" ? "b" : "w";
      });
      resetRoom(room);
      io.to(roomId).emit("rematch_start", {
        colors: room.players.reduce((acc, p) => {
          acc[p.id] = p.color;
          return acc;
        }, {}),
      });
      startClock(roomId);
    }
  });

  socket.on("rematch_decline", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    room.rematchVotes = new Set();
    socket.to(roomId).emit("rematch_declined");
  });

  // ─── Draw Offer ───────────────────────────────────────────────────────────
  socket.on("offer_draw", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;

    if (room.drawOfferFrom) {
      socket.emit("error", { message: "A draw offer is already pending." });
      return;
    }

    room.drawOfferFrom = socket.id;
    socket.to(roomId).emit("draw_offered", { from: player.name });
  });

  socket.on("accept_draw", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || !room.drawOfferFrom) return;
    stopClock(roomId);
    room.drawOfferFrom = null;
    io.to(roomId).emit("game_over", { result: "Draw by agreement" });
  });

  socket.on("decline_draw", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    room.drawOfferFrom = null;
    socket.to(roomId).emit("draw_declined");
  });

  // ─── Resign ───────────────────────────────────────────────────────────────
  socket.on("resign", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;

    stopClock(roomId);
    const winner = player.color === "w" ? "Black" : "White";
    io.to(roomId).emit("game_over", { result: `${winner} wins by resignation` });
  });

  // ─── Chat ─────────────────────────────────────────────────────────────────
  socket.on("chat_message", ({ roomId, message }) => {
    const room = rooms[roomId];
    if (!room) return;

    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;

    if (!message || typeof message !== "string" || message.trim() === "") return;
    const sanitized = message.trim().substring(0, 200);

    const entry = { name: player.name, message: sanitized, timestamp: Date.now() };
    room.chatHistory.push(entry);
    if (room.chatHistory.length > 100) room.chatHistory.shift(); // keep last 100

    io.to(roomId).emit("chat_message", entry);
  });

  // ─── Spectate ─────────────────────────────────────────────────────────────
  socket.on("spectate", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) {
      socket.emit("error", { message: "Room not found." });
      return;
    }
    socket.join(roomId);
    socket.emit("spectate_state", {
      fen: room.fen,
      moves: room.moves,
      players: room.players.map((p) => ({ name: p.name, color: p.color, timeMs: p.timeMs })),
      chatHistory: room.chatHistory,
    });
    console.log(`Spectator ${socket.id} joined room ${roomId}`);
  });

  // ─── Disconnect ───────────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    const found = getRoomOfSocket(socket.id);
    if (found) {
      const { roomId, room } = found;
      stopClock(roomId);
      socket.to(roomId).emit("opponent_disconnected");
      room.players = room.players.filter((p) => p.id !== socket.id);
      if (room.players.length === 0) scheduleRoomCleanup(roomId);
    }
    console.log("Player disconnected:", socket.id);
  });
});

// Basic health check endpoint
app.get("/health", (req, res) => res.json({ status: "ok", rooms: Object.keys(rooms).length }));

const PORT = process.env.PORT || 3001;
server.listen(PORT, "0.0.0.0", () => 
  console.log(`Server running on port ${PORT}`));
