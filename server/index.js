/**
 * Chess Server — Improved
 *
 * Key fixes over original:
 *  1. chess.js runs on the SERVER — moves are validated here, not trusted from client
 *  2. FEN is never accepted from client — server owns board state
 *  3. game_over cannot be faked — server only emits it after verifying state
 *  4. Reconnect grace period (30 s) — brief disconnect doesn't kill the game
 *  5. game_start event is now emitted so the client listener actually fires
 *  6. SOCKET_URL is driven by an env var on the client side (see vite.config note)
 */

const express  = require("express");
const http     = require("http");
const { Server } = require("socket.io");
const { Chess }  = require("chess.js"); // npm install chess.js

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// ─── Room store ────────────────────────────────────────────────────────────────
// rooms: { [roomId]: Room }
// Room: {
//   players:       Player[],        // max 2
//   chess:         Chess,           // server-authoritative board
//   turn:          "w" | "b",
//   rematchVotes:  Set<socketId>,
//   drawOfferFrom: socketId | null,
//   chatHistory:   ChatEntry[],
//   clockInterval: NodeJS.Timeout | null,
//   reconnectTimers: { [socketId]: NodeJS.Timeout }   // grace-period timers
// }
// Player: { id, name, color, timeMs, disconnected? }

const rooms = {};

const ROOM_CLEANUP_DELAY = 30_000;   // ms — empty room TTL
const RECONNECT_GRACE_MS = 30_000;   // ms — how long we hold a slot for a dropped player
const DEFAULT_TIME_MS    = 10 * 60 * 1000;

// ─── Helpers ───────────────────────────────────────────────────────────────────

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
      console.log(`Room ${roomId} cleaned up.`);
    }
  }, ROOM_CLEANUP_DELAY);
}

// ─── Clock ─────────────────────────────────────────────────────────────────────

function startClock(roomId) {
  const room = rooms[roomId];
  if (!room || room.clockInterval) return;

  room.clockInterval = setInterval(() => {
    const r = rooms[roomId];
    if (!r) { clearInterval(room.clockInterval); return; }

    const current = r.players.find((p) => p.color === r.turn && !p.disconnected);
    if (!current) return; // don't tick while player is reconnecting

    current.timeMs -= 1000;

    io.to(roomId).emit("clock_update", {
      times: r.players.reduce((acc, p) => { acc[p.color] = p.timeMs; return acc; }, {}),
    });

    if (current.timeMs <= 0) {
      clearInterval(r.clockInterval);
      r.clockInterval = null;
      const winner = current.color === "w" ? "Black" : "White";
      io.to(roomId).emit("game_over", { result: `${winner} wins on time` });
    }
  }, 1000);
}

function stopClock(roomId) {
  const room = rooms[roomId];
  if (!room || !room.clockInterval) return;
  clearInterval(room.clockInterval);
  room.clockInterval = null;
}

// ─── Room reset (rematch) ──────────────────────────────────────────────────────

function resetRoom(room) {
  room.chess        = new Chess();
  room.turn         = "w";
  room.rematchVotes = new Set();
  room.drawOfferFrom = null;
  room.chatHistory  = room.chatHistory || [];
  room.players.forEach((p) => { p.timeMs = DEFAULT_TIME_MS; });
}

// ─── Server-side end-of-game check ────────────────────────────────────────────
// Called after every validated move. Returns a result string or null.

function checkServerGameOver(chess) {
  if (chess.isCheckmate()) {
    const winner = chess.turn() === "w" ? "Black" : "White";
    return `Checkmate! ${winner} wins.`;
  }
  if (chess.isStalemate())          return "Draw by stalemate.";
  if (chess.isInsufficientMaterial()) return "Draw — insufficient material.";
  if (chess.isThreefoldRepetition()) return "Draw by threefold repetition.";
  if (chess.isDraw())               return "Draw!";
  return null;
}

// ─── Socket handlers ───────────────────────────────────────────────────────────

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  // ── Per-socket rate limiting ─────────────────────────────────────────────────
  // Simple token-bucket: tracks last-event timestamps to reject floods.
  const rateLimit = {
    move:      { lastMs: 0, minInterval: 100  }, // max 10 moves/sec
    offer_draw:{ lastMs: 0, minInterval: 3000 }, // max 1 draw offer per 3 s
    chat:      { lastMs: 0, minInterval: 500  }, // max 2 messages/sec
  };

  function checkRate(key) {
    const bucket = rateLimit[key];
    const now = Date.now();
    if (now - bucket.lastMs < bucket.minInterval) return false;
    bucket.lastMs = now;
    return true;
  }

  // ── Create Room ─────────────────────────────────────────────────────────────
  socket.on("create_room", ({ playerName }) => {
    if (!playerName || typeof playerName !== "string" || !playerName.trim()) {
      return socket.emit("error", { message: "Invalid player name." });
    }
    const name   = playerName.trim().substring(0, 20);
    const roomId = generateRoomId();

    rooms[roomId] = {
      players:         [{ id: socket.id, name, color: "w", timeMs: DEFAULT_TIME_MS }],
      chess:           new Chess(),
      turn:            "w",
      rematchVotes:    new Set(),
      drawOfferFrom:   null,
      chatHistory:     [],
      clockInterval:   null,
      reconnectTimers: {},
    };

    socket.join(roomId);
    socket.emit("room_created", { roomId, color: "w", playerName: name });
    console.log(`Room ${roomId} created by ${name}`);
  });

  // ── Join Room ────────────────────────────────────────────────────────────────
  socket.on("join_room", ({ roomId, playerName }) => {
    if (!playerName || typeof playerName !== "string" || !playerName.trim()) {
      return socket.emit("error", { message: "Invalid player name." });
    }
    const id = roomId?.toUpperCase();
    if (!id) return socket.emit("error", { message: "Invalid room ID." });

    const room = rooms[id];
    if (!room)                    return socket.emit("error", { message: "Room not found." });
    if (room.players.length >= 2) return socket.emit("error", { message: "Room is full." });

    const name = playerName.trim().substring(0, 20);
    room.players.push({ id: socket.id, name, color: "b", timeMs: DEFAULT_TIME_MS });
    socket.join(id);

    const white = room.players[0];
    socket.emit("room_joined",   { roomId: id, color: "b", opponentName: white.name });
    io.to(white.id).emit("opponent_joined", { opponentName: name });

    // Emit game_start to both players so clients can mark the game as active
    io.to(id).emit("game_start", {
      whitePlayer: white.name,
      blackPlayer: name,
    });

    // Small delay so clients finish processing room_joined/opponent_joined
    // before the first clock_update arrives
    setTimeout(() => startClock(id), 500);
    console.log(`${name} joined room ${id}`);
  });

  // ── Move — SERVER VALIDATES ──────────────────────────────────────────────────
  socket.on("move", ({ roomId, move }) => {
    if (!checkRate("move")) return; // flood protection
    // NOTE: 'fen' from client is intentionally ignored — server owns board state
    const room = rooms[roomId];
    if (!room) return;

    const player = room.players.find((p) => p.id === socket.id);
    if (!player || player.color !== room.turn) {
      return socket.emit("error", { message: "Not your turn." });
    }

    // Attempt the move on the server's Chess instance
    let result;
    try {
      result = room.chess.move(move); // move can be SAN string or { from, to, promotion }
    } catch {
      result = null;
    }

    if (!result) {
      // Illegal move — tell client to revert
      return socket.emit("illegal_move", { fen: room.chess.fen() });
    }

    // Move is legal — update authoritative state
    room.turn         = room.chess.turn();
    room.drawOfferFrom = null;

    // Broadcast the validated move + authoritative FEN to both players
    const fen = room.chess.fen();
    socket.to(roomId).emit("opponent_move", { move: result.san, fen });
    // Echo back the authoritative FEN to the mover too (so they stay in sync)
    socket.emit("move_ack", { move: result.san, fen });

    // Check for game over conditions server-side
    const gameOver = checkServerGameOver(room.chess);
    if (gameOver) {
      stopClock(roomId);
      io.to(roomId).emit("game_over", { result: gameOver });
    }
  });

  // ── Resign ───────────────────────────────────────────────────────────────────
  socket.on("resign", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;

    stopClock(roomId);
    const winner = player.color === "w" ? "Black" : "White";
    io.to(roomId).emit("game_over", { result: `${winner} wins by resignation` });
  });

  // ── Draw Offer ───────────────────────────────────────────────────────────────
  socket.on("offer_draw", ({ roomId }) => {
    if (!checkRate("offer_draw")) return; // prevents draw spam
    const room = rooms[roomId];
    if (!room) return;
    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;

    if (room.drawOfferFrom) {
      return socket.emit("error", { message: "A draw offer is already pending." });
    }
    room.drawOfferFrom = socket.id;
    socket.to(roomId).emit("draw_offered", { from: player.name });
  });

  socket.on("accept_draw", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || !room.drawOfferFrom) return;
    // Only the non-offerer can accept
    if (room.drawOfferFrom === socket.id) return;
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

  // ── Rematch ───────────────────────────────────────────────────────────────────
  socket.on("rematch_request", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;

    room.rematchVotes.add(socket.id);
    if (room.rematchVotes.size === 1) {
      socket.to(roomId).emit("rematch_requested", { from: player.name });
    }
    if (room.rematchVotes.size >= 2) {
      stopClock(roomId);
      // Swap colors each rematch
      room.players.forEach((p) => { p.color = p.color === "w" ? "b" : "w"; });
      resetRoom(room);
      io.to(roomId).emit("rematch_start", {
        colors: room.players.reduce((acc, p) => { acc[p.id] = p.color; return acc; }, {}),
        fen:    room.chess.fen(),
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

  // ── Chat ──────────────────────────────────────────────────────────────────────
  socket.on("chat_message", ({ roomId, message }) => {
    if (!checkRate("chat")) return; // prevents chat flood
    const room = rooms[roomId];
    if (!room) return;
    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;
    if (!message || typeof message !== "string" || !message.trim()) return;

    const sanitized = message.trim().substring(0, 200);
    const entry = { name: player.name, message: sanitized, timestamp: Date.now() };
    room.chatHistory.push(entry);
    if (room.chatHistory.length > 100) room.chatHistory.shift();
    io.to(roomId).emit("chat_message", entry);
  });

  // ── Spectate ─────────────────────────────────────────────────────────────────
  socket.on("spectate", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit("error", { message: "Room not found." });
    socket.join(roomId);
    socket.emit("spectate_state", {
      fen:         room.chess.fen(),
      moves:       room.chess.history(),
      players:     room.players.map((p) => ({ name: p.name, color: p.color, timeMs: p.timeMs })),
      chatHistory: room.chatHistory,
    });
  });

  // ── Leave Room ────────────────────────────────────────────────────────────────
  socket.on("leave_room", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    const playerIndex = room.players.findIndex((p) => p.id === socket.id);
    if (playerIndex === -1) return;

    const player = room.players[playerIndex];
    console.log(`${player.name} left room ${roomId} explicitly.`);

    // Cancel any reconnect timer for this player
    if (room.reconnectTimers[socket.id]) {
      clearTimeout(room.reconnectTimers[socket.id]);
      delete room.reconnectTimers[socket.id];
    }

    // Remove player
    room.players.splice(playerIndex, 1);

    // Stop clock
    stopClock(roomId);

    // Notify opponent
    socket.to(roomId).emit("opponent_left");

    // Clean up room if empty
    if (room.players.length === 0) {
      delete rooms[roomId];
      console.log(`Room ${roomId} cleaned up immediately because all players left.`);
    }

    socket.leave(roomId);
  });

  // ── Disconnect with reconnect grace period ───────────────────────────────────
  socket.on("disconnect", () => {
    const found = getRoomOfSocket(socket.id);
    if (!found) return console.log("Disconnected (no room):", socket.id);

    const { roomId, room, player } = found;
    console.log(`${player.name} disconnected from room ${roomId} — holding slot for ${RECONNECT_GRACE_MS / 1000}s`);

    // Pause the clock while they're gone
    stopClock(roomId);
    player.disconnected = true;
    socket.to(roomId).emit("opponent_disconnected", { reconnecting: true });

    // Give them 30 seconds to reconnect before forfeiting their slot
    room.reconnectTimers[socket.id] = setTimeout(() => {
      const r = rooms[roomId];
      if (!r) return;

      r.players = r.players.filter((p) => p.id !== socket.id);
      io.to(roomId).emit("opponent_left");

      if (r.players.length === 0) scheduleRoomCleanup(roomId);
      console.log(`${player.name}'s reconnect window expired for room ${roomId}`);
    }, RECONNECT_GRACE_MS);
  });

  // ── Reconnect ─────────────────────────────────────────────────────────────────
  // Client should emit this immediately on connect if they have a stored roomId + playerName
  socket.on("reconnect_room", ({ roomId, playerName }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit("error", { message: "Room expired or not found." });

    const player = room.players.find(
      (p) => p.name === playerName && p.disconnected
    );
    if (!player) return socket.emit("error", { message: "No reconnect slot found." });

    // Cancel the eviction timer
    if (room.reconnectTimers[player.id]) {
      clearTimeout(room.reconnectTimers[player.id]);
      delete room.reconnectTimers[player.id];
    }

    // Swap to new socket ID
    player.id = socket.id;
    player.disconnected = false;
    socket.join(roomId);

    const opponent = room.players.find((p) => p.id !== socket.id);

    socket.emit("reconnected", {
      color:        player.color,
      fen:          room.chess.fen(),
      moves:        room.chess.history(),
      times:        room.players.reduce((acc, p) => { acc[p.color] = p.timeMs; return acc; }, {}),
      opponentName: opponent?.name || null,
      yourTurn:     room.turn === player.color,
      chatHistory:  room.chatHistory,
    });

    if (opponent) {
      io.to(opponent.id).emit("opponent_reconnected", { name: player.name });
      // Only restart clock if both players are present and game isn't over
      if (!room.chess.isGameOver()) startClock(roomId);
    }

    console.log(`${player.name} reconnected to room ${roomId}`);
  });
});

// ─── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (_req, res) =>
  res.json({ status: "ok", rooms: Object.keys(rooms).length })
);

const PORT = process.env.PORT || 3001;
server.listen(PORT, "0.0.0.0", () =>
  console.log(`Server running on port ${PORT}`)
);
