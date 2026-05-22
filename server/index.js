/**
 * Chess Server — Ultimate Chess Showdown Edition
 *
 * New features over previous version:
 *  1. Persistent named rooms — players create a room with a custom name/password
 *     and can rejoin it later to continue their W/L/D history
 *  2. Real-time score updates — scores_update emitted after every game_over
 *  3. Full game history log per room — stored as array of game records
 *  4. Title updated to "Ultimate Chess Showdown"
 */

const express  = require("express");
const http     = require("http");
const { Server } = require("socket.io");
const { Chess }  = require("chess.js");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// ─── Room store ────────────────────────────────────────────────────────────────
// rooms: { [roomId]: Room }
// Room: {
//   players:        Player[],        // max 2
//   chess:          Chess,           // server-authoritative board
//   turn:           "w" | "b",
//   rematchVotes:   Set<socketId>,
//   drawOfferFrom:  socketId | null,
//   chatHistory:    ChatEntry[],
//   clockInterval:  NodeJS.Timeout | null,
//   reconnectTimers:{ [socketId]: NodeJS.Timeout },
//   // Persistence fields:
//   isPersistent:   boolean,         // true = saved room
//   password:       string | null,   // optional password
//   scores:         { w: number, b: number, draws: number },
//   gameHistory:    GameRecord[],    // list of completed games
//   playerNames:    { w: string, b: string } | null  // stored names for persistent rooms
// }
// Player:      { id, name, color, timeMs, disconnected? }
// GameRecord:  { result, winner, date, moveCount, playerW, playerB }

const rooms = {};

const ROOM_CLEANUP_DELAY = 30_000;
const RECONNECT_GRACE_MS = 30_000;
const PERSISTENT_ROOM_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_TIME_MS    = 10 * 60 * 1000;
const MAX_GAME_HISTORY   = 50;

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
  const room = rooms[roomId];
  if (room?.isPersistent) return; // don't auto-delete persistent rooms
  setTimeout(() => {
    const r = rooms[roomId];
    if (r && r.players.length === 0 && !r.isPersistent) {
      delete rooms[roomId];
      console.log(`Room ${roomId} cleaned up.`);
    }
  }, ROOM_CLEANUP_DELAY);
}

function getScoresPayload(room) {
  return {
    scores: room.scores,
    gameHistory: room.gameHistory,
    playerNames: room.playerNames,
  };
}


function recordGameResult(room, result, winnerColor) {
  const playerW = room.players.find(p => p.color === "w")?.name || room.playerNames?.w || "White";
  const playerB = room.players.find(p => p.color === "b")?.name || room.playerNames?.b || "Black";
  const moveCount = room.chess.history().length;
  const winner = winnerColor || "draw";
  if (winner === "w") room.scores.w++;
  else if (winner === "b") room.scores.b++;
  else room.scores.draws++;
  let friendlyResult = result.replace(/\bWhite\b/g, playerW).replace(/\bBlack\b/g, playerB);
  const record = { result: friendlyResult, winner, date: new Date().toISOString(), moveCount, playerW, playerB };
  room.gameHistory.unshift(record);
  if (room.gameHistory.length > MAX_GAME_HISTORY) room.gameHistory.pop();
  if (room.isPersistent) room.playerNames = { w: playerW, b: playerB };
  return friendlyResult;
}

function startClock(roomId) {
  const room = rooms[roomId];
  if (!room || room.clockInterval) return;

  room.clockInterval = setInterval(() => {
    const r = rooms[roomId];
    if (!r) { clearInterval(room.clockInterval); return; }

    const current = r.players.find((p) => p.color === r.turn && !p.disconnected);
    if (!current) return;

    current.timeMs -= 1000;

    io.to(roomId).emit("clock_update", {
      times: r.players.reduce((acc, p) => { acc[p.color] = p.timeMs; return acc; }, {}),
    });

    if (current.timeMs <= 0) {
      clearInterval(r.clockInterval);
      r.clockInterval = null;
      const winnerColor = current.color === "w" ? "b" : "w";
      const result = `${winnerColor === "w" ? "White" : "Black"} wins on time`;
      const friendlyResult1 = recordGameResult(r, result, winnerColor);
      io.to(roomId).emit("game_over", { result: friendlyResult1 });
      io.to(roomId).emit("scores_update", getScoresPayload(r));
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

function checkServerGameOver(chess) {
  if (chess.isCheckmate()) {
    const winner = chess.turn() === "w" ? "Black" : "White";
    return `Checkmate! ${winner} wins.`;
  }
  if (chess.isStalemate())            return "Draw by stalemate.";
  if (chess.isInsufficientMaterial()) return "Draw — insufficient material.";
  if (chess.isThreefoldRepetition())  return "Draw by threefold repetition.";
  if (chess.isDraw())                 return "Draw!";
  return null;
}

// ─── Socket handlers ───────────────────────────────────────────────────────────

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  const rateLimit = {
    move:       { lastMs: 0, minInterval: 100  },
    offer_draw: { lastMs: 0, minInterval: 3000 },
    chat:       { lastMs: 0, minInterval: 500  },
  };

  function checkRate(key) {
    const bucket = rateLimit[key];
    const now = Date.now();
    if (now - bucket.lastMs < bucket.minInterval) return false;
    bucket.lastMs = now;
    return true;
  }

  // ── Create Room ─────────────────────────────────────────────────────────────
  socket.on("create_room", ({ playerName, persistent, password }) => {
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
      isPersistent:    !!persistent,
      password:        password ? password.trim().substring(0, 30) : null,
      scores:          { w: 0, b: 0, draws: 0 },
      gameHistory:     [],
      playerNames:     null,
    };

    socket.join(roomId);
    socket.emit("room_created", {
      roomId,
      color: "w",
      playerName: name,
      isPersistent: !!persistent,
      scores: rooms[roomId].scores,
      gameHistory: [],
    });
    console.log(`Room ${roomId} created by ${name}${persistent ? " (persistent)" : ""}`);
  });

  // ── Join Room ────────────────────────────────────────────────────────────────
  socket.on("join_room", ({ roomId, playerName, password }) => {
    if (!playerName || typeof playerName !== "string" || !playerName.trim()) {
      return socket.emit("error", { message: "Invalid player name." });
    }
    const id = roomId?.toUpperCase();
    if (!id) return socket.emit("error", { message: "Invalid room ID." });

    const room = rooms[id];
    if (!room) return socket.emit("error", { message: "Room not found." });

    // Check password if room is protected
    if (room.password) {
      const pw = password ? password.trim() : "";
      if (pw !== room.password) {
        return socket.emit("error", { message: "Wrong room password." });
      }
    }

    if (room.players.length >= 2) return socket.emit("error", { message: "Room is full." });

    const name = playerName.trim().substring(0, 20);
    room.players.push({ id: socket.id, name, color: "b", timeMs: DEFAULT_TIME_MS });
    socket.join(id);

    const white = room.players[0];
    socket.emit("room_joined", {
      roomId: id,
      color: "b",
      opponentName: white.name,
      isPersistent: room.isPersistent,
      scores: room.scores,
      gameHistory: room.gameHistory,
    });
    io.to(white.id).emit("opponent_joined", {
      opponentName: name,
      scores: room.scores,
      gameHistory: room.gameHistory,
    });

    io.to(id).emit("game_start", {
      whitePlayer: white.name,
      blackPlayer: name,
    });

    setTimeout(() => startClock(id), 500);
    console.log(`${name} joined room ${id}`);
  });

  // ── Move — SERVER VALIDATES ──────────────────────────────────────────────────
  socket.on("move", ({ roomId, move }) => {
    if (!checkRate("move")) return;
    const room = rooms[roomId];
    if (!room) return;

    const player = room.players.find((p) => p.id === socket.id);
    if (!player || player.color !== room.turn) {
      return socket.emit("error", { message: "Not your turn." });
    }

    let result;
    try {
      result = room.chess.move(move);
    } catch {
      result = null;
    }

    if (!result) {
      return socket.emit("illegal_move", { fen: room.chess.fen() });
    }

    room.turn         = room.chess.turn();
    room.drawOfferFrom = null;

    const fen = room.chess.fen();
    socket.to(roomId).emit("opponent_move", { move: result.san, fen });
    socket.emit("move_ack", { move: result.san, fen });

    const gameOver = checkServerGameOver(room.chess);
    if (gameOver) {
      stopClock(roomId);
      // Determine winner color: after a move, chess.turn() is the player to move next
      // If checkmate, that player LOST (they're in checkmate). Otherwise it's a draw.
      let gameOverWinnerColor = "draw";
      if (room.chess.isCheckmate()) {
        gameOverWinnerColor = room.chess.turn() === "w" ? "b" : "w";
      }
      const friendlyGameOver = recordGameResult(room, gameOver, gameOverWinnerColor);
      io.to(roomId).emit("game_over", { result: friendlyGameOver });
      io.to(roomId).emit("scores_update", getScoresPayload(room));
    }
  });

  // ── Resign ───────────────────────────────────────────────────────────────────
  socket.on("resign", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;

    stopClock(roomId);
    const resignWinnerColor = player.color === "w" ? "b" : "w";
    const resignResult = `${resignWinnerColor === "w" ? "White" : "Black"} wins by resignation`;
    const friendlyResign = recordGameResult(room, resignResult, resignWinnerColor);
    io.to(roomId).emit("game_over", { result: friendlyResign });
    io.to(roomId).emit("scores_update", getScoresPayload(room));
  });

  // ── Draw Offer ───────────────────────────────────────────────────────────────
  socket.on("offer_draw", ({ roomId }) => {
    if (!checkRate("offer_draw")) return;
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
    if (room.drawOfferFrom === socket.id) return;
    stopClock(roomId);
    room.drawOfferFrom = null;
    const friendlyDraw = recordGameResult(room, "Draw by agreement", "draw");
    io.to(roomId).emit("game_over", { result: friendlyDraw });
    io.to(roomId).emit("scores_update", getScoresPayload(room));
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
      room.players.forEach((p) => { p.color = p.color === "w" ? "b" : "w"; });
      resetRoom(room);
      io.to(roomId).emit("rematch_start", {
        colors: room.players.reduce((acc, p) => { acc[p.id] = p.color; return acc; }, {}),
        fen:    room.chess.fen(),
        scores: room.scores,
        gameHistory: room.gameHistory,
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
    if (!checkRate("chat")) return;
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
      scores:      room.scores,
      gameHistory: room.gameHistory,
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

    if (room.reconnectTimers[socket.id]) {
      clearTimeout(room.reconnectTimers[socket.id]);
      delete room.reconnectTimers[socket.id];
    }

    room.players.splice(playerIndex, 1);
    stopClock(roomId);
    socket.to(roomId).emit("opponent_left");

    if (room.players.length === 0 && !room.isPersistent) {
      delete rooms[roomId];
      console.log(`Room ${roomId} cleaned up.`);
    }

    socket.leave(roomId);
  });

  // ── Disconnect with reconnect grace period ───────────────────────────────────
  socket.on("disconnect", () => {
    const found = getRoomOfSocket(socket.id);
    if (!found) return console.log("Disconnected (no room):", socket.id);

    const { roomId, room, player } = found;
    console.log(`${player.name} disconnected from room ${roomId} — holding slot for ${RECONNECT_GRACE_MS / 1000}s`);

    stopClock(roomId);
    player.disconnected = true;
    socket.to(roomId).emit("opponent_disconnected", { reconnecting: true });

    room.reconnectTimers[socket.id] = setTimeout(() => {
      const r = rooms[roomId];
      if (!r) return;

      r.players = r.players.filter((p) => p.id !== socket.id);
      io.to(roomId).emit("opponent_left");

      if (r.players.length === 0) {
        if (r.isPersistent) {
          console.log(`Persistent room ${roomId} is now empty — keeping it alive.`);
        } else {
          scheduleRoomCleanup(roomId);
        }
      }
      console.log(`${player.name}'s reconnect window expired for room ${roomId}`);
    }, RECONNECT_GRACE_MS);
  });

  // ── Reconnect ─────────────────────────────────────────────────────────────────
  socket.on("reconnect_room", ({ roomId, playerName }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit("error", { message: "Room expired or not found." });

    const player = room.players.find(
      (p) => p.name === playerName && p.disconnected
    );
    if (!player) return socket.emit("error", { message: "No reconnect slot found." });

    if (room.reconnectTimers[player.id]) {
      clearTimeout(room.reconnectTimers[player.id]);
      delete room.reconnectTimers[player.id];
    }

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
      scores:       room.scores,
      gameHistory:  room.gameHistory,
    });

    if (opponent) {
      io.to(opponent.id).emit("opponent_reconnected", { name: player.name });
      if (!room.chess.isGameOver()) startClock(roomId);
    }

    console.log(`${player.name} reconnected to room ${roomId}`);
  });

  // ── Rejoin persistent room ────────────────────────────────────────────────────
  // Used when players return to a saved room after fully leaving (not just disconnect)
  socket.on("rejoin_persistent", ({ roomId, playerName, password }) => {
    const id = roomId?.toUpperCase();
    const room = rooms[id];
    if (!room) return socket.emit("error", { message: "Saved room not found." });
    if (!room.isPersistent) return socket.emit("error", { message: "Not a saved room." });

    if (room.password) {
      const pw = password ? password.trim() : "";
      if (pw !== room.password) {
        return socket.emit("error", { message: "Wrong room password." });
      }
    }

    if (room.players.length >= 2) return socket.emit("error", { message: "Room is full." });

    const name = playerName.trim().substring(0, 20);

    // Assign color based on what's available
    const usedColors = room.players.map(p => p.color);
    let color = usedColors.includes("w") ? "b" : "w";

    room.players.push({ id: socket.id, name, color, timeMs: DEFAULT_TIME_MS });
    socket.join(id);

    const opponent = room.players.find(p => p.id !== socket.id);

    socket.emit("room_joined", {
      roomId: id,
      color,
      opponentName: opponent?.name || null,
      isPersistent: true,
      scores: room.scores,
      gameHistory: room.gameHistory,
    });

    if (opponent) {
      io.to(opponent.id).emit("opponent_joined", {
        opponentName: name,
        scores: room.scores,
        gameHistory: room.gameHistory,
      });

      io.to(id).emit("game_start", {
        whitePlayer: color === "b" ? opponent.name : name,
        blackPlayer: color === "w" ? opponent.name : name,
      });

      setTimeout(() => startClock(id), 500);
    } else {
      setStatus?.("Waiting for your opponent to join…");
    }

    console.log(`${name} rejoined persistent room ${id}`);
  });
});

// ─── Health check + room listing ──────────────────────────────────────────────
app.get("/health", (_req, res) =>
  res.json({ status: "ok", rooms: Object.keys(rooms).length })
);

// List persistent rooms (for debug/admin — don't expose in prod without auth)
app.get("/rooms/persistent", (_req, res) => {
  const list = Object.entries(rooms)
    .filter(([, r]) => r.isPersistent)
    .map(([id, r]) => ({
      id,
      players: r.players.map(p => ({ name: p.name, color: p.color })),
      scores: r.scores,
      gamesPlayed: r.gameHistory.length,
    }));
  res.json(list);
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, "0.0.0.0", () =>
  console.log(`Server running on port ${PORT}`)
);
