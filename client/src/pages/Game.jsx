import { useEffect, useState, useCallback, useRef } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import { io } from "socket.io-client";
import "./Game.css";

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || "http://localhost:3001";

export default function Game({ config, onLeave }) {
  const { mode, playerName, roomCode } = config;

  // ─── Single source of truth: FEN string (not a Chess object in state) ───────
  // This avoids stale Chess object bugs. We keep a Chess object only in a ref.
  const [fen, setFen]                        = useState("start");
  const [playerColor, setPlayerColor]        = useState(mode === "local" ? "w" : null);
  const [roomId, setRoomId]                  = useState(null);
  const [opponentName, setOpponentName]      = useState(null);
  const [status, setStatus]                  = useState(mode === "local" ? "Local Sandbox Mode" : "Connecting…");
  const [moveHistory, setMoveHistory]        = useState([]);
  const [gameResult, setGameResult]          = useState(null);
  const [copied, setCopied]                  = useState(false);
  const [times, setTimes]                    = useState({ w: null, b: null });
  const [drawOffer, setDrawOffer]            = useState(null);
  const [rematchRequest, setRematchRequest]  = useState(null);
  const [gameStarted, setGameStarted]        = useState(mode === "local");
  const [selectedSquare, setSelectedSquare]  = useState(null);
  const [optionSquares, setOptionSquares]    = useState({});
  const [lastMoveSquares, setLastMoveSquares]= useState({});

  // ─── Local Sandbox & Connection States ──────────────────────────────────────
  const [autoFlip, setAutoFlip]              = useState(true);
  const [connectionStatus, setConnectionStatus] = useState(mode === "local" ? "connected" : "connecting");

  // ─── Refs (always current, no stale closure issues) ──────────────────────────
  const socketRef       = useRef(null);
  const moveListRef     = useRef(null);
  const playerColorRef  = useRef(mode === "local" ? "w" : null);
  const opponentRef     = useRef(null);
  const roomIdRef       = useRef(null);
  const gameRef         = useRef(new Chess());   // authoritative game state
  const resultRef       = useRef(null);
  const gameStartedRef  = useRef(mode === "local");

  // ─── Helpers ─────────────────────────────────────────────────────────────────
  const loadFen = (f) => {
    try { return new Chess(f); }
    catch { const g = new Chess(); g.load(f); return g; }
  };

  const applyServerFen = useCallback((f) => {
    const g = loadFen(f);
    gameRef.current = g;
    setFen(g.fen());
    return g;
  }, []);

  // ─── Socket setup ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (mode === "local") return;

    const socket = io(SOCKET_URL, { reconnectionAttempts: 5, timeout: 8000 });
    socketRef.current = socket;

    socket.on("connect", () => {
      setConnectionStatus("connected");
      if (mode === "create") socket.emit("create_room", { playerName });
      else                   socket.emit("join_room", { roomId: roomCode, playerName });
    });

    socket.on("connect_error", () => {
      setConnectionStatus("offline");
      setStatus("Server offline — check connection");
    });

    socket.on("disconnect", () => {
      setConnectionStatus("offline");
    });

    socket.on("room_created", ({ roomId: rid, color }) => {
      roomIdRef.current      = rid;
      playerColorRef.current = color;
      setRoomId(rid);
      setPlayerColor(color);
      setStatus("Waiting for opponent… Share the room code!");
    });

    socket.on("room_joined", ({ roomId: rid, color, opponentName: opp }) => {
      roomIdRef.current      = rid;
      playerColorRef.current = color;
      opponentRef.current    = opp;
      setRoomId(rid);
      setPlayerColor(color);
      setOpponentName(opp);
      setStatus(`Playing against ${opp}`);
      gameStartedRef.current = true;
      setGameStarted(true);
    });

    socket.on("opponent_joined", ({ opponentName: opp }) => {
      opponentRef.current    = opp;
      gameStartedRef.current = true;
      setOpponentName(opp);
      setGameStarted(true);
      setStatus(`Playing against ${opp}`);
    });

    socket.on("game_start", ({ whitePlayer, blackPlayer }) => {
      gameStartedRef.current = true;
      setGameStarted(true);
      setStatus(`${whitePlayer} (White) vs ${blackPlayer} (Black)`);
    });

    // Server confirms our move — just update move history & status.
    // Board position is already correct from optimistic update, so DON'T
    // call setFen here (avoids flicker). Only sync if FEN mismatches.
    socket.on("move_ack", ({ move, fen: serverFen }) => {
      // Only correct if server disagrees (shouldn't happen for legal moves)
      if (gameRef.current.fen() !== serverFen) {
        applyServerFen(serverFen);
      }
      setMoveHistory((h) => [...h, move]);
      setSelectedSquare(null);
      setOptionSquares({});
      const hist = gameRef.current.history({ verbose: true });
      if (hist.length > 0) {
        const last = hist[hist.length - 1];
        setLastMoveSquares({
          [last.from]: { background: "rgba(255, 255, 0, 0.25)" },
          [last.to]:   { background: "rgba(255, 255, 0, 0.4)"  },
        });
      }
      if (gameRef.current.isCheck()) setStatus("Check!");
      else setStatus("");
    });

    socket.on("opponent_move", ({ move, fen: serverFen }) => {
      const g = applyServerFen(serverFen);
      setMoveHistory((h) => [...h, move]);
      setSelectedSquare(null);
      setOptionSquares({});
      const hist = g.history({ verbose: true });
      if (hist.length > 0) {
        const last = hist[hist.length - 1];
        setLastMoveSquares({
          [last.from]: { background: "rgba(255, 255, 0, 0.25)" },
          [last.to]:   { background: "rgba(255, 255, 0, 0.4)"  },
        });
      }
      if (g.isCheck()) setStatus("Check!");
      else setStatus("");
    });

    // Server rejected move — roll back board to server's FEN
    socket.on("illegal_move", ({ fen: serverFen }) => {
      applyServerFen(serverFen);
      setSelectedSquare(null);
      setOptionSquares({});
    });

    socket.on("game_over", ({ result }) => {
      resultRef.current = result;
      setGameResult(result);
      setStatus("Game over");
    });

    socket.on("opponent_disconnected", ({ reconnecting: r }) => {
      setStatus(r ? "Opponent disconnected — waiting 30s…" : "Opponent disconnected.");
    });

    socket.on("opponent_left",  ()            => { setStatus("Opponent left."); setGameResult("Opponent left."); });
    socket.on("error",          ({ message }) => setStatus(`Error: ${message}`));
    socket.on("clock_update",   ({ times: t }) => setTimes(t));
    socket.on("draw_offered",   ({ from })    => setDrawOffer(from));
    socket.on("draw_declined",  ()            => { setDrawOffer(null); setStatus("Draw declined."); });
    socket.on("rematch_requested", ({ from }) => setRematchRequest(from));
    socket.on("rematch_declined",  ()         => { setRematchRequest(null); setStatus("Rematch declined."); });

    socket.on("rematch_start", ({ colors, fen: f }) => {
      const myColor = colors[socket.id];
      const fresh   = loadFen(f);
      gameRef.current        = fresh;
      resultRef.current      = null;
      playerColorRef.current = myColor;
      gameStartedRef.current = true;
      setFen(fresh.fen());
      setMoveHistory([]);
      setGameResult(null);
      setRematchRequest(null);
      setDrawOffer(null);
      setTimes({ w: null, b: null });
      setPlayerColor(myColor);
      setSelectedSquare(null);
      setOptionSquares({});
      setLastMoveSquares({});
      setGameStarted(true);
      setStatus(`Playing against ${opponentRef.current}`);
    });

    socket.on("reconnected", ({ color, fen: f, moves, times: t, opponentName: opp }) => {
      const g = applyServerFen(f);
      playerColorRef.current = color;
      opponentRef.current    = opp;
      gameStartedRef.current = true;
      setPlayerColor(color);
      setOpponentName(opp);
      setMoveHistory(moves || []);
      setTimes(t || { w: null, b: null });
      setGameStarted(true);
      setStatus(`Playing against ${opp}`);
    });

    return () => socket.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Show legal move dots ─────────────────────────────────────────────────
  const getMoveOptions = useCallback((square) => {
    const g     = gameRef.current;
    const color = playerColorRef.current;
    const isLocal = mode === "local";

    if (!isLocal && g.turn() !== color) return false;
    // In local mode, only allow highlighting/moving pieces of the active turn
    const piece = g.get(square);
    if (isLocal && piece?.color !== g.turn()) return false;

    const moves = g.moves({ square, verbose: true });
    if (!moves.length) { setOptionSquares({}); return false; }
    const squares = {};
    moves.forEach(({ to }) => {
      squares[to] = {
        background: g.get(to)
          ? "radial-gradient(circle, rgba(255,0,0,0.4) 60%, transparent 65%)"
          : "radial-gradient(circle, rgba(0,0,0,0.25) 30%, transparent 33%)",
        borderRadius: "50%",
      };
    });
    squares[square] = { background: "rgba(255, 255, 0, 0.4)" };
    setOptionSquares(squares);
    setSelectedSquare(square);
    return true;
  }, [mode]);

  // ─── Click to move ────────────────────────────────────────────────────────
  const onSquareClick = useCallback((square) => {
    const color = playerColorRef.current;
    const room  = roomIdRef.current;
    const g     = gameRef.current;
    const isLocal = mode === "local";

    if (!isLocal) {
      if (!color || resultRef.current) return;
      if (!gameStarted) return; // Prevent early moves!
      if (g.turn() !== color) { setSelectedSquare(null); setOptionSquares({}); return; }
    } else {
      if (resultRef.current) return;
    }

    // Second click: try to move
    if (selectedSquare && selectedSquare !== square) {
      const piece = g.get(selectedSquare);
      const promotion =
        piece?.type === "p" &&
        ((g.turn() === "w" && square[1] === "8") || (g.turn() === "b" && square[1] === "1"))
          ? "q" : undefined;

      try {
        const copy = loadFen(g.fen());
        const move = copy.move({ from: selectedSquare, to: square, promotion });
        if (move) {
          gameRef.current = copy;
          setFen(copy.fen());
          setMoveHistory((h) => [...h, move.san]);
          setLastMoveSquares({
            [selectedSquare]: { background: "rgba(255, 255, 0, 0.25)" },
            [square]:          { background: "rgba(255, 255, 0, 0.4)"  },
          });
          setSelectedSquare(null);
          setOptionSquares({});

          if (isLocal) {
            // Check game over local sandbox
            const over = copy.isCheckmate() ? "Checkmate!" :
                         copy.isStalemate() ? "Draw by stalemate." :
                         copy.isInsufficientMaterial() ? "Draw by insufficient material." :
                         copy.isThreefoldRepetition() ? "Draw by threefold repetition." :
                         copy.isDraw() ? "Draw!" : null;
            if (over) {
              setGameResult(over);
              resultRef.current = over;
            } else {
              if (copy.isCheck()) setStatus("Check!");
              else setStatus("");
            }

            if (autoFlip) {
              setPlayerColor(copy.turn());
              playerColorRef.current = copy.turn();
            }
          } else {
            socketRef.current?.emit("move", {
              roomId: room,
              move: { from: selectedSquare, to: square, promotion },
            });
          }
          return;
        }
      } catch { /* fall through to select */ }
    }

    // First click (or invalid target): select piece and show options
    getMoveOptions(square);
  }, [selectedSquare, getMoveOptions, mode, gameStarted, autoFlip]);

  // ─── Drag and drop ───────────────────────────────────────────────────────
  const onDrop = useCallback((sourceSquare, targetSquare, piece) => {
    const color = playerColorRef.current;
    const room  = roomIdRef.current;
    const g     = gameRef.current;
    const isLocal = mode === "local";

    if (!isLocal) {
      if (!color || resultRef.current) return false;
      if (!gameStarted) return false; // Prevent early moves!
      if (g.turn() !== color) return false;
    } else {
      if (resultRef.current) return false;
    }

    const promotion =
      (piece === "wP" && targetSquare[1] === "8") ||
      (piece === "bP" && targetSquare[1] === "1")
        ? "q" : undefined;

    try {
      const copy = loadFen(g.fen());
      const move = copy.move({ from: sourceSquare, to: targetSquare, promotion });
      if (!move) return false;

      gameRef.current = copy;
      setFen(copy.fen());
      setMoveHistory((h) => [...h, move.san]);
      setLastMoveSquares({
        [sourceSquare]: { background: "rgba(255, 255, 0, 0.25)" },
        [targetSquare]: { background: "rgba(255, 255, 0, 0.4)"  },
      });
      setSelectedSquare(null);
      setOptionSquares({});

      if (isLocal) {
        // Check game over local sandbox
        const over = copy.isCheckmate() ? "Checkmate!" :
                     copy.isStalemate() ? "Draw by stalemate." :
                     copy.isInsufficientMaterial() ? "Draw by insufficient material." :
                     copy.isThreefoldRepetition() ? "Draw by threefold repetition." :
                     copy.isDraw() ? "Draw!" : null;
        if (over) {
          setGameResult(over);
          resultRef.current = over;
        } else {
          if (copy.isCheck()) setStatus("Check!");
          else setStatus("");
        }

        if (autoFlip) {
          setPlayerColor(copy.turn());
          playerColorRef.current = copy.turn();
        }
      } else {
        socketRef.current?.emit("move", {
          roomId: room,
          move: { from: sourceSquare, to: targetSquare, promotion },
        });
      }
      return true; // ← piece stays, no snap-back
    } catch {
      return false;
    }
  }, [mode, gameStarted, autoFlip]);

  // ─── Auto-scroll move list ────────────────────────────────────────────────
  useEffect(() => {
    if (moveListRef.current) {
      moveListRef.current.scrollTop = moveListRef.current.scrollHeight;
    }
  }, [moveHistory]);

  const copyRoomCode = () => {
    navigator.clipboard.writeText(roomId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const requestRematch = () => {
    setRematchRequest(null);
    socketRef.current?.emit("rematch_request", { roomId });
  };

  const acceptDraw  = () => { setDrawOffer(null); socketRef.current?.emit("accept_draw",  { roomId }); };
  const declineDraw = () => { setDrawOffer(null); socketRef.current?.emit("decline_draw", { roomId }); };
  const offerDraw   = ()  => socketRef.current?.emit("offer_draw", { roomId });
  const resign      = ()  => socketRef.current?.emit("resign",     { roomId });

  const restartSandbox = () => {
    const fresh = new Chess();
    gameRef.current = fresh;
    setFen(fresh.fen());
    setMoveHistory([]);
    setGameResult(null);
    resultRef.current = null;
    playerColorRef.current = "w";
    setPlayerColor("w");
    setLastMoveSquares({});
    setOptionSquares({});
    setStatus("Local Sandbox Mode");
  };

  const formatTime = (ms) => {
    if (ms === null || ms === undefined) return null;
    const total = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  // ─── Derived values ───────────────────────────────────────────────────────
  // Use gameRef (not state) for turn check so canMove is always accurate
  const currentTurn      = gameRef.current.turn();
  const canMove          = gameStarted && !gameResult && currentTurn === playerColor;
  const isMyTurn         = canMove;
  const boardOrientation = playerColor === "b" ? "black" : "white";

  const statusLabel = (() => {
    if (gameResult) return gameResult;
    if (isMyTurn)   return gameRef.current.isCheck() ? "Check! Your turn" : "Your turn";
    if (gameRef.current.isCheck() && opponentName) return "Check!";
    return status;
  })();

  const movePairs = [];
  for (let i = 0; i < moveHistory.length; i += 2) {
    movePairs.push({ num: Math.floor(i / 2) + 1, w: moveHistory[i], b: moveHistory[i + 1] });
  }

  const customSquareStyles = { ...lastMoveSquares, ...optionSquares };

  return (
    <div className="game-page">
      <div className="game-sidebar left">
        <button className="back-btn" onClick={onLeave}>← Home</button>

        <div className="player-card opponent">
          <span className="player-piece">{playerColor === "w" ? "♛" : "♔"}</span>
          <div>
            <div className="player-name">
              {mode === "local"
                ? (playerColor === "w" ? "Black Player" : "White Player")
                : (opponentName || "Waiting…")}
            </div>
            <div className="player-color">{playerColor === "w" ? "Black" : "White"}</div>
          </div>
          {formatTime(times[playerColor === "w" ? "b" : "w"]) && (
            <span className="clock">{formatTime(times[playerColor === "w" ? "b" : "w"])}</span>
          )}
          {((mode === "local" ? currentTurn !== playerColor : !isMyTurn && opponentName) && !gameResult) && (
            <span className="thinking-dot" />
          )}
        </div>

        <div className="status-bar">
          <span className={gameResult ? "result-text" : isMyTurn ? "your-turn" : "their-turn"}>
            {statusLabel}
          </span>
        </div>

        <div className="player-card me">
          <span className="player-piece">{playerColor === "w" ? "♔" : "♛"}</span>
          <div>
            <div className="player-name">
              {mode === "local"
                ? (playerColor === "w" ? "White Player" : "Black Player")
                : playerName}
            </div>
            <div className="player-color">{playerColor === "w" ? "White" : "Black"}</div>
          </div>
          {formatTime(times[playerColor]) && (
            <span className="clock">{formatTime(times[playerColor])}</span>
          )}
          {isMyTurn && <span className="your-turn-dot" />}
        </div>

        {roomId && !opponentName && (
          <div className="room-code-box">
            <p>Share this code:</p>
            <div className="room-code">{roomId}</div>
            <button className="copy-btn" onClick={copyRoomCode}>
              {copied ? "✓ Copied!" : "Copy Code"}
            </button>
          </div>
        )}

        {drawOffer && !gameResult && (
          <div className="offer-banner">
            <p>{drawOffer} offers a draw</p>
            <div className="offer-actions">
              <button className="play-btn primary small" onClick={acceptDraw}>Accept</button>
              <button className="play-btn ghost small"   onClick={declineDraw}>Decline</button>
            </div>
          </div>
        )}

        {rematchRequest && gameResult && (
          <div className="offer-banner">
            <p>{rematchRequest} wants a rematch</p>
            <div className="offer-actions">
              <button className="play-btn primary small" onClick={requestRematch}>Accept</button>
              <button className="play-btn ghost small" onClick={() => {
                socketRef.current?.emit("rematch_decline", { roomId });
                setRematchRequest(null);
              }}>Decline</button>
            </div>
          </div>
        )}

        {opponentName && !gameResult && (
          <div className="in-game-actions">
            <button className="play-btn ghost small" onClick={offerDraw}>½ Draw</button>
            <button className="play-btn ghost small danger" onClick={resign}>Resign</button>
          </div>
        )}

        {gameResult && !rematchRequest && (
          <div className="game-over-actions">
            {mode === "local" ? (
              <button className="play-btn primary" onClick={restartSandbox}>Restart Sandbox</button>
            ) : (
              <button className="play-btn primary" onClick={requestRematch}>Rematch</button>
            )}
            <button className="play-btn ghost"   onClick={onLeave}>Leave</button>
          </div>
        )}

        {mode === "local" && (
          <div className="local-toggles">
            <div className="toggle-row">
              <span className="toggle-label">Auto-Flip POV</span>
              <button
                className={`toggle-btn ${autoFlip ? "active" : ""}`}
                onClick={() => {
                  const next = !autoFlip;
                  setAutoFlip(next);
                  if (!next) {
                    setPlayerColor("w");
                    playerColorRef.current = "w";
                  } else {
                    setPlayerColor(gameRef.current.turn());
                    playerColorRef.current = gameRef.current.turn();
                  }
                }}
              >
                {autoFlip ? "ON" : "OFF"}
              </button>
            </div>
            <div className="toggle-row">
              <span className="toggle-label">Manual Flip</span>
              <button
                className="toggle-btn"
                onClick={() => {
                  const next = playerColor === "w" ? "b" : "w";
                  setPlayerColor(next);
                  playerColorRef.current = next;
                }}
              >
                Flip Board
              </button>
            </div>
            {!gameResult && (
              <button className="play-btn primary small" onClick={restartSandbox}>
                Restart Sandbox
              </button>
            )}
          </div>
        )}

        {connectionStatus === "offline" && (
          <div className="offline-card">
            <h4>Server Offline</h4>
            <p>We lost connection to the chess server at <code>{SOCKET_URL}</code>.</p>
            <p className="hint">Make sure the backend server is running on port 3001.</p>
            <div className="offline-actions">
              <button className="play-btn primary" onClick={() => {
                if (socketRef.current) {
                  socketRef.current.connect();
                  setConnectionStatus("connecting");
                  setStatus("Reconnecting…");
                }
              }}>Retry</button>
              <button className="play-btn ghost" onClick={onLeave}>Leave</button>
            </div>
          </div>
        )}
      </div>

      <div className="game-board-wrap">
        <Chessboard
          id="main-board"
          position={fen}
          onPieceDrop={onDrop}
          onSquareClick={onSquareClick}
          boardOrientation={boardOrientation}
          customSquareStyles={customSquareStyles}
          customBoardStyle={{ borderRadius: "8px", boxShadow: "0 16px 60px rgba(0,0,0,0.6)" }}
          customDarkSquareStyle={{ backgroundColor: "#8B6914" }}
          customLightSquareStyle={{ backgroundColor: "#F0D9A0" }}
          arePiecesDraggable={true}
          animationDuration={150}
        />
      </div>

      <div className="game-sidebar right">
        <div className="move-history">
          <h3>Move History</h3>
          <div className="move-list" ref={moveListRef}>
            {movePairs.length === 0
              ? <p className="no-moves">{gameStarted ? "No moves yet" : "Waiting for opponent…"}</p>
              : movePairs.map((pair) => (
                  <div key={pair.num} className="move-row">
                    <span className="move-num">{pair.num}.</span>
                    <span className="move-white">{pair.w}</span>
                    <span className="move-black">{pair.b || ""}</span>
                  </div>
                ))
            }
          </div>
        </div>

        <div className="board-legend">
          <div className="legend-item"><span className="legend-sq dark" /> Dark: #8B6914</div>
          <div className="legend-item"><span className="legend-sq light" /> Light: #F0D9A0</div>
        </div>
      </div>
    </div>
  );
}
