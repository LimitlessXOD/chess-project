import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "../components/Chessboard";
import { io } from "socket.io-client";
import "./Game.css";

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || "http://localhost:3001";

export default function Game({ config, onLeave }) {
  const { mode, playerName, roomCode } = config;

  // ─── Refs (always current, no stale closure issues) ──────────────────────────
  const socketRef       = useRef(null);
  const moveListRef     = useRef(null);
  const playerColorRef  = useRef(mode === "local" ? "w" : null);
  const opponentRef     = useRef(null);
  const roomIdRef       = useRef(null);
  const gameRef         = useRef(new Chess());   // authoritative game state
  const resultRef       = useRef(null);
  const gameStartedRef  = useRef(mode === "local");

  // ─── System Logs Debug overlay ──────────────────────────────────────────────
  const [logs, setLogs] = useState([]);
  const addLog = useCallback((msg) => {
    console.log("[ChessLog]", msg);
    setLogs((prev) => [msg, ...prev].slice(0, 8));
  }, []);

  const handleLeave = useCallback(() => {
    sessionStorage.removeItem("chess_roomId");
    sessionStorage.removeItem("chess_playerName");
    if (roomIdRef.current && socketRef.current) {
      socketRef.current.emit("leave_room", { roomId: roomIdRef.current });
    }
    onLeave();
  }, [onLeave]);

  // ─── Single source of truth: FEN string (not a Chess object in state) ───────
  // This avoids stale Chess object bugs. We keep a Chess object only in a ref.
  const [fen, setFen]                        = useState(mode === "local" ? "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1" : "start");
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
      
      if (roomIdRef.current) {
        addLog(`Reconnecting to room ${roomIdRef.current} as ${playerName}`);
        socket.emit("reconnect_room", { roomId: roomIdRef.current, playerName });
      } else if (mode === "reconnect") {
        addLog(`Reconnecting to room ${roomCode} as ${playerName}`);
        socket.emit("reconnect_room", { roomId: roomCode, playerName });
      } else {
        if (mode === "create") socket.emit("create_room", { playerName });
        else                   socket.emit("join_room", { roomId: roomCode, playerName });
      }
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
      sessionStorage.setItem("chess_roomId", rid);
      sessionStorage.setItem("chess_playerName", playerName);
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
      sessionStorage.setItem("chess_roomId", rid);
      sessionStorage.setItem("chess_playerName", playerName);
    });

    socket.on("opponent_joined", ({ opponentName: opp }) => {
      opponentRef.current    = opp;
      gameStartedRef.current = true;
      setOpponentName(opp);
      setGameStarted(true);
      setStatus(`Playing against ${opp}`);
    });

    socket.on("opponent_reconnected", ({ name }) => {
      opponentRef.current    = name;
      setOpponentName(name);
      setStatus(`Playing against ${name}`);
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
          [last.from]: { backgroundColor: "rgba(235, 210, 140, 0.25)" },
          [last.to]:   { backgroundColor: "rgba(235, 210, 140, 0.4)"  },
        });
      }
      if (gameRef.current.isCheck()) setStatus("Check!");
      else setStatus("");
    });

    socket.on("opponent_move", ({ move, fen: serverFen }) => {
      try {
        gameRef.current.move(move);
      } catch {
        addLog(`opponent_move desync fallback: loading FEN`);
        const g = loadFen(serverFen);
        gameRef.current = g;
      }
      setFen(gameRef.current.fen());
      setMoveHistory((h) => [...h, move]);
      setSelectedSquare(null);
      setOptionSquares({});
      const hist = gameRef.current.history({ verbose: true });
      if (hist.length > 0) {
        const last = hist[hist.length - 1];
        setLastMoveSquares({
          [last.from]: { backgroundColor: "rgba(235, 210, 140, 0.25)" },
          [last.to]:   { backgroundColor: "rgba(235, 210, 140, 0.4)"  },
        });
      }
      if (gameRef.current.isCheck()) setStatus("Check!");
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
      if (!roomIdRef.current && mode === "reconnect") {
        roomIdRef.current = roomCode;
        setRoomId(roomCode);
      }
      const g = new Chess();
      if (moves && moves.length > 0) {
        for (const m of moves) {
          try { g.move(m); }
          catch (e) { console.error("Failed to replay move:", m, e); }
        }
      } else {
        g.load(f);
      }
      gameRef.current = g;
      setFen(g.fen());
      playerColorRef.current = color;
      opponentRef.current    = opp;
      gameStartedRef.current = true;
      setPlayerColor(color);
      setOpponentName(opp);
      setMoveHistory(moves || []);
      setTimes(t || { w: null, b: null });
      setGameStarted(true);
      setStatus(`Playing against ${opp}`);
      
      const hist = g.history({ verbose: true });
      if (hist.length > 0) {
        const last = hist[hist.length - 1];
        setLastMoveSquares({
          [last.from]: { backgroundColor: "rgba(235, 210, 140, 0.25)" },
          [last.to]:   { backgroundColor: "rgba(235, 210, 140, 0.4)"  },
        });
      } else {
        setLastMoveSquares({});
      }
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
    if (isLocal && piece?.color !== g.turn()) {
      addLog(`getMoveOptions: Piece color mismatch (piece=${piece?.color}, turn=${g.turn()})`);
      return false;
    }

    const moves = g.moves({ square, verbose: true });
    if (!moves.length) {
      addLog(`getMoveOptions: No moves available for ${square}`);
      setOptionSquares({});
      return false;
    }

    addLog(`getMoveOptions: Highlighted ${moves.length} moves for ${square}`);
    const squares = {};
    moves.forEach(({ to }) => {
      squares[to] = g.get(to)
        ? { boxShadow: "inset 0 0 0 3px rgba(210, 110, 110, 0.75)", borderRadius: "50%" }
        : { background: "radial-gradient(circle, rgba(112, 138, 131, 0.55) 18%, transparent 20%)" };
    });
    squares[square] = {
      backgroundColor: "rgba(210, 110, 110, 0.55)",
      outline: "2px solid rgba(210, 110, 110, 0.9)",
      outlineOffset: "-2px"
    };
    setOptionSquares(squares);
    setSelectedSquare(square);
    return true;
  }, [mode, addLog]);

  // ─── Click to move ────────────────────────────────────────────────────────
  const onSquareClick = useCallback(({ square }) => {
    const isLocal = mode === "local";
    const g     = gameRef.current;

    addLog(`onSquareClick: Square clicked ${square}`);

    if (!isLocal) {
      const color = playerColorRef.current;
      if (!color) {
        addLog("onSquareClick: Error - Player color is null");
        return;
      }
      if (resultRef.current) {
        addLog("onSquareClick: Error - Game already over");
        return;
      }
      if (!gameStarted) {
        addLog("onSquareClick: Error - Game not started yet");
        return;
      }
      if (g.turn() !== color) {
        addLog(`onSquareClick: Error - Not your turn (turn=${g.turn()}, color=${color})`);
        setSelectedSquare(null);
        setOptionSquares({});
        return;
      }
    } else {
      if (resultRef.current) {
        addLog("onSquareClick: Error - Game already over");
        return;
      }
    }

    // Second click: try to move
    if (selectedSquare && selectedSquare !== square) {
      const selectedPiece = g.get(selectedSquare);

      // Check turn matches piece in local mode
      if (isLocal && selectedPiece?.color !== g.turn()) {
        addLog(`onSquareClick: Select wrong color piece (color=${selectedPiece?.color}, turn=${g.turn()})`);
        setSelectedSquare(null);
        setOptionSquares({});
        return;
      }

      const promotion =
        selectedPiece?.type === "p" &&
        ((g.turn() === "w" && square[1] === "8") || (g.turn() === "b" && square[1] === "1"))
          ? "q" : undefined;

      try {
        addLog(`onSquareClick: Attempting move ${selectedSquare} -> ${square}`);
        const move = g.move({ from: selectedSquare, to: square, promotion });
        if (move) {
          addLog(`onSquareClick: Success - ${move.san}`);

          setFen(g.fen());
          setMoveHistory((h) => [...h, move.san]);
          setLastMoveSquares({
            [selectedSquare]: { backgroundColor: "rgba(235, 210, 140, 0.25)" },
            [square]:          { backgroundColor: "rgba(235, 210, 140, 0.4)"  },
          });
          setSelectedSquare(null);
          setOptionSquares({});

          if (isLocal) {
            // Check game over local sandbox
            const over = g.isCheckmate() ? "Checkmate!" :
                         g.isStalemate() ? "Draw by stalemate." :
                         g.isInsufficientMaterial() ? "Draw by insufficient material." :
                         g.isThreefoldRepetition() ? "Draw by threefold repetition." :
                         g.isDraw() ? "Draw!" : null;
            if (over) {
              setGameResult(over);
              resultRef.current = over;
              addLog(`onSquareClick: Game Over - ${over}`);
            } else {
              if (g.isCheck()) {
                setStatus("Check!");
                addLog("onSquareClick: Check!");
              } else {
                setStatus("");
              }
            }

            if (autoFlip) {
              const nextTurn = g.turn();
              setPlayerColor(nextTurn);
              playerColorRef.current = nextTurn;
              addLog(`onSquareClick: Auto-flipping to ${nextTurn === "w" ? "White" : "Black"}`);
            }
          } else {
            const room  = roomIdRef.current;
            socketRef.current?.emit("move", {
              roomId: room,
              move: { from: selectedSquare, to: square, promotion },
            });
          }
          return;
        }
      } catch (e) {
        addLog(`onSquareClick: Exception - ${e.message}`);
        setSelectedSquare(null);
        setOptionSquares({});
        return;
      }
    }

    // First click (or invalid target): select piece and show options
    getMoveOptions(square);
  }, [selectedSquare, getMoveOptions, mode, gameStarted, autoFlip, addLog]);

  // ─── Drag and drop ───────────────────────────────────────────────────────
  const onDrop = useCallback(({ piece, sourceSquare, targetSquare }) => {
    const isLocal = mode === "local";
    const g     = gameRef.current;

    addLog(`onDrop: Attempt ${piece} ${sourceSquare} -> ${targetSquare}`);

    if (!isLocal) {
      const color = playerColorRef.current;
      if (!color) {
        addLog("onDrop: Error - Player color is null");
        return false;
      }
      if (resultRef.current) {
        addLog("onDrop: Error - Game already over");
        return false;
      }
      if (!gameStarted) {
        addLog("onDrop: Error - Game not started yet");
        return false;
      }
      if (g.turn() !== color) {
        addLog(`onDrop: Error - Not your turn (turn=${g.turn()}, color=${color})`);
        return false;
      }
    } else {
      if (resultRef.current) {
        addLog("onDrop: Error - Game already over");
        return false;
      }
      // In local mode, make sure they are moving the correct color piece
      const pieceColor = piece?.[0]; // "w" or "b"
      if (pieceColor !== g.turn()) {
        addLog(`onDrop: Error - Moving wrong color piece (piece=${piece}, turn=${g.turn()})`);
        return false;
      }
    }

    const promotion =
      (piece === "wP" && targetSquare[1] === "8") ||
      (piece === "bP" && targetSquare[1] === "1")
        ? "q" : undefined;

    try {
      const move = g.move({ from: sourceSquare, to: targetSquare, promotion });
      if (!move) {
        addLog(`onDrop: Error - chess.js returned null move`);
        return false;
      }

      addLog(`onDrop: Success - ${move.san}`);

      setFen(g.fen());
      setMoveHistory((h) => [...h, move.san]);
      setLastMoveSquares({
        [sourceSquare]: { backgroundColor: "rgba(235, 210, 140, 0.25)" },
        [targetSquare]: { backgroundColor: "rgba(235, 210, 140, 0.4)"  },
      });
      setSelectedSquare(null);
      setOptionSquares({});

      if (isLocal) {
        // Check game over local sandbox
        const over = g.isCheckmate() ? "Checkmate!" :
                     g.isStalemate() ? "Draw by stalemate." :
                     g.isInsufficientMaterial() ? "Draw by insufficient material." :
                     g.isThreefoldRepetition() ? "Draw by threefold repetition." :
                     g.isDraw() ? "Draw!" : null;
        if (over) {
          setGameResult(over);
          resultRef.current = over;
          addLog(`onDrop: Game Over - ${over}`);
        } else {
          if (g.isCheck()) {
            setStatus("Check!");
            addLog("onDrop: Check!");
          } else {
            setStatus("");
          }
        }

        if (autoFlip) {
          const nextTurn = g.turn();
          setPlayerColor(nextTurn);
          playerColorRef.current = nextTurn;
          addLog(`onDrop: Auto-flipping to ${nextTurn === "w" ? "White" : "Black"}`);
        }
      } else {
        const room  = roomIdRef.current;
        socketRef.current?.emit("move", {
          roomId: room,
          move: { from: sourceSquare, to: targetSquare, promotion },
        });
      }
      return true; // ← piece stays, no snap-back
    } catch (e) {
      addLog(`onDrop: Exception - ${e.message}`);
      return false;
    }
  }, [mode, gameStarted, autoFlip, addLog]);

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
    addLog("Restarting Sandbox...");
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
  // Create a reactive game instance for rendering purposes, derived from the fen state.
  // This avoids accessing refs during render and keeps it perfectly in sync with React's state model.
  const gameForRender = useMemo(() => {
    return loadFen(fen);
  }, [fen]);

  const currentTurn      = gameForRender.turn();
  const canMove          = gameStarted && !gameResult && currentTurn === playerColor;
  const isMyTurn         = canMove;
  const boardOrientation = playerColor === "b" ? "black" : "white";

  const statusLabel = (() => {
    if (gameResult) return gameResult;
    if (isMyTurn)   return gameForRender.isCheck() ? "Check! Your turn" : "Your turn";
    if (gameForRender.isCheck() && opponentName) return "Check!";
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
        <button className="back-btn" onClick={handleLeave}>← Home</button>

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
            <button className="play-btn ghost"   onClick={handleLeave}>Leave</button>
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
              <button className="play-btn ghost" onClick={handleLeave}>Leave</button>
            </div>
          </div>
        )}
      </div>

      <div className="game-board-wrap">
        <Chessboard
          id="main-board"
          key={boardOrientation}
          position={fen}
          onPieceDrop={onDrop}
          onSquareClick={onSquareClick}
          boardOrientation={boardOrientation}
          customSquareStyles={customSquareStyles}
          customBoardStyle={{ borderRadius: "8px", boxShadow: "0 16px 60px rgba(0,0,0,0.6)" }}
          customDarkSquareStyle={{ backgroundColor: "#708A83" }}
          customLightSquareStyle={{ backgroundColor: "#ECE3D4" }}
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
          <div className="legend-item"><span className="legend-sq dark" style={{ backgroundColor: "#708A83" }} /> Sage Green: #708A83</div>
          <div className="legend-item"><span className="legend-sq light" style={{ backgroundColor: "#ECE3D4" }} /> Cream: #ECE3D4</div>
        </div>

        {mode === "local" && (
          <div className="move-history" style={{ marginTop: "16px", maxHeight: "180px", overflow: "hidden", display: "flex", flexDirection: "column" }}>
            <h3 style={{ color: "#c8a84b" }}>System Logs</h3>
            <div className="move-list" style={{ fontSize: "0.75rem", fontFamily: "monospace", flex: 1, overflowY: "auto" }}>
              {logs.length === 0 ? (
                <p className="no-moves">No system logs yet</p>
              ) : (
                logs.map((log, index) => (
                  <div key={index} style={{ padding: "2px 0", borderBottom: "1px solid rgba(255,255,255,0.02)", color: log.includes("Error") || log.includes("Exception") ? "#ff8b8b" : "#e8d9b8" }}>
                    {log}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
