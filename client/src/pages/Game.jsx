import { useEffect, useState, useCallback, useRef } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import { io } from "socket.io-client";
import "./Game.css";

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || "http://localhost:3001";

export default function Game({ config, onLeave }) {
  const { mode, playerName, roomCode } = config;

  const [game, setGame]                     = useState(new Chess());
  const [playerColor, setPlayerColor]       = useState(null);
  const [roomId, setRoomId]                 = useState(null);
  const [opponentName, setOpponentName]     = useState(null);
  const [status, setStatus]                 = useState("Connecting…");
  const [moveHistory, setMoveHistory]       = useState([]);
  const [gameResult, setGameResult]         = useState(null);
  const [copied, setCopied]                 = useState(false);
  const [times, setTimes]                   = useState({ w: null, b: null });
  const [drawOffer, setDrawOffer]           = useState(null);
  const [rematchRequest, setRematchRequest] = useState(null);

  // Move highlights
  const [selectedSquare, setSelectedSquare]   = useState(null);
  const [optionSquares, setOptionSquares]     = useState({});
  const [lastMoveSquares, setLastMoveSquares] = useState({});

  const socketRef      = useRef(null);
  const moveListRef    = useRef(null);
  const playerColorRef = useRef(null);
  const opponentRef    = useRef(null);
  const roomIdRef      = useRef(null);
  const gameRef        = useRef(new Chess());
  const resultRef      = useRef(null);

  useEffect(() => { playerColorRef.current = playerColor; }, [playerColor]);
  useEffect(() => { opponentRef.current    = opponentName; }, [opponentName]);
  useEffect(() => { roomIdRef.current      = roomId; }, [roomId]);
  useEffect(() => { gameRef.current        = game; }, [game]);
  useEffect(() => { resultRef.current      = gameResult; }, [gameResult]);

  useEffect(() => {
    const socket = io(SOCKET_URL);
    socketRef.current = socket;

    socket.on("connect", () => {
      if (mode === "create") {
        socket.emit("create_room", { playerName });
      } else {
        socket.emit("join_room", { roomId: roomCode, playerName });
      }
    });

    socket.on("room_created", ({ roomId, color }) => {
      roomIdRef.current      = roomId;
      playerColorRef.current = color;
      setRoomId(roomId);
      setPlayerColor(color);
      setStatus("Waiting for opponent… Share the room code!");
    });


    socket.on("room_joined", ({ roomId, color, opponentName: opp }) => {
      roomIdRef.current      = roomId;
      playerColorRef.current = color;
      opponentRef.current    = opp;   // FIX: sync ref immediately, don't wait for useEffect
      setRoomId(roomId);
      setPlayerColor(color);
      setOpponentName(opp);
      setStatus(`Playing against ${opp}`);
    });

    socket.on("opponent_joined", ({ opponentName: opp }) => {
      opponentRef.current = opp;   // FIX: sync ref immediately so moves unblock at once
      setOpponentName(opp);
      setStatus(`Playing against ${opp}`);
    });

    socket.on("game_start", ({ whitePlayer, blackPlayer }) => {
      setStatus(`${whitePlayer} (White) vs ${blackPlayer} (Black)`);
    });

    // Server ACKs our move — sync to server's authoritative FEN
    socket.on("move_ack", ({ move, fen }) => {
      const g = new Chess();
      g.load(fen);
      gameRef.current = g;
      setGame(g);
      setMoveHistory((h) => [...h, move]);
      setSelectedSquare(null);
      setOptionSquares({});
      if (g.isCheck()) setStatus("Check!");
    });

    // Opponent's move arrives — update board and highlight last move squares
    socket.on("opponent_move", ({ move, fen }) => {
      const g = new Chess();
      g.load(fen);
      gameRef.current = g;
      setGame(g);
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

    // Server rejected our move — revert to authoritative FEN
    socket.on("illegal_move", ({ fen }) => {
      const g = new Chess();
      g.load(fen);
      gameRef.current = g;
      setGame(g);
      setSelectedSquare(null);
      setOptionSquares({});
    });

    socket.on("game_over",            ({ result })  => { setGameResult(result); setStatus("Game over"); });
    socket.on("opponent_disconnected", ({ reconnecting: r }) => {
      setStatus(r ? "Opponent disconnected — waiting 30s…" : "Opponent disconnected.");
    });
    socket.on("opponent_left",        ()            => { setStatus("Opponent left."); setGameResult("Opponent left."); });
    socket.on("error",                ({ message }) => setStatus(`Error: ${message}`));
    socket.on("clock_update",         ({ times })   => setTimes(times));
    socket.on("draw_offered",         ({ from })    => setDrawOffer(from));
    socket.on("draw_declined",        ()            => { setDrawOffer(null); setStatus("Draw declined."); });
    socket.on("rematch_requested",    ({ from })    => setRematchRequest(from));
    socket.on("rematch_declined",     ()            => { setRematchRequest(null); setStatus("Rematch declined."); });

    socket.on("rematch_start", ({ colors, fen }) => {
      const fresh = new Chess();
      fresh.load(fen);
      gameRef.current   = fresh;
      resultRef.current = null;
      const myColor = colors[socket.id];
      playerColorRef.current = myColor;
      setGame(fresh);
      setMoveHistory([]);
      setGameResult(null);
      setRematchRequest(null);
      setDrawOffer(null);
      setTimes({ w: null, b: null });
      setPlayerColor(myColor);
      setSelectedSquare(null);
      setOptionSquares({});
      setLastMoveSquares({});
      setStatus(`Playing against ${opponentRef.current}`);
    });

    return () => socket.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Show legal-move dots when a piece is clicked
  const getMoveOptions = useCallback((square, g, color) => {
    if (g.turn() !== color) return false;
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
  }, []);

  const onSquareClick = useCallback((square) => {
    const color  = playerColorRef.current;
    const room   = roomIdRef.current;
    const g      = gameRef.current;
    const result = resultRef.current;

    // FIX: Guard — must have color, no game over, game must have started (opponent present)
    if (!color || result || !opponentRef.current) return;
    // FIX: Guard — only act on your own turn
    if (g.turn() !== color) {
      setSelectedSquare(null);
      setOptionSquares({});
      return;
    }

    // If a piece is already selected and we click a different square — try the move
    if (selectedSquare && selectedSquare !== square) {
      const piece = g.get(selectedSquare);

      const promotion =
        piece?.type === "p" &&
        ((color === "w" && square[1] === "8") || (color === "b" && square[1] === "1"))
          ? "q" : undefined;

      // FIX: chess.js v1.x throws on illegal moves — must use try/catch
      let move = null;
      try {
        const copy = new Chess();
        copy.load(g.fen());
        move = copy.move({ from: selectedSquare, to: square, promotion });

        if (move) {
          // Optimistically update UI and send to server
          gameRef.current = copy;
          setGame(copy);
          setSelectedSquare(null);
          setOptionSquares({});
          setLastMoveSquares({
            [selectedSquare]: { background: "rgba(255, 255, 0, 0.25)" },
            [square]:         { background: "rgba(255, 255, 0, 0.4)"  },
          });
          socketRef.current?.emit("move", {
            roomId: room,
            move:   { from: selectedSquare, to: square, promotion },
          });
          return;
        }
      } catch {
        // Invalid move — fall through to select new square below
      }
    }

    // Select the clicked square (show move dots or clear if no moves)
    getMoveOptions(square, g, color);
  }, [selectedSquare, getMoveOptions]);

  const onDrop = useCallback((sourceSquare, targetSquare, piece) => {
    const color  = playerColorRef.current;
    const room   = roomIdRef.current;
    const g      = gameRef.current;
    const result = resultRef.current;

    if (!color || result || !opponentRef.current) return false;
    if (g.turn() !== color) return false;

    const promotion =
      (piece === "wP" && targetSquare[1] === "8") ||
      (piece === "bP" && targetSquare[1] === "1")
        ? "q" : undefined;

    // FIX: chess.js v1.x throws on illegal moves — must use try/catch
    let move = null;
    try {
      const copy = new Chess();
      copy.load(g.fen());
      move = copy.move({ from: sourceSquare, to: targetSquare, promotion });

      if (!move) return false;

      gameRef.current = copy;
      setGame(copy);
      setSelectedSquare(null);
      setOptionSquares({});
      setLastMoveSquares({
        [sourceSquare]: { background: "rgba(255, 255, 0, 0.25)" },
        [targetSquare]: { background: "rgba(255, 255, 0, 0.4)"  },
      });

      socketRef.current?.emit("move", {
        roomId: room,
        move:   { from: sourceSquare, to: targetSquare, promotion },
      });

      return true;
    } catch {
      // Illegal move — piece snaps back
      return false;
    }
  }, []);

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

  const formatTime = (ms) => {
    if (ms === null || ms === undefined) return null;
    const total = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const isMyTurn         = game.turn() === playerColor && !gameResult && !!opponentName;
  // FIX: board orientation uses playerColor state — add key={playerColor} on Chessboard
  // to force remount when color is first assigned (react-chessboard v5 needs this)
  const boardOrientation = playerColor === "b" ? "black" : "white";

  // Status label: show check when relevant, otherwise show turn/status text
  const statusLabel = (() => {
    if (gameResult) return gameResult;
    if (isMyTurn)   return game.isCheck() ? "Check! Your turn" : "Your turn";
    if (game.isCheck() && opponentName) return "Check!";
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
            <div className="player-name">{opponentName || "Waiting…"}</div>
            <div className="player-color">{playerColor === "w" ? "Black" : "White"}</div>
          </div>
          {formatTime(times[playerColor === "w" ? "b" : "w"]) && (
            <span className="clock">{formatTime(times[playerColor === "w" ? "b" : "w"])}</span>
          )}
          {!isMyTurn && opponentName && !gameResult && <span className="thinking-dot" />}
        </div>

        <div className="status-bar">
          <span className={gameResult ? "result-text" : isMyTurn ? "your-turn" : "their-turn"}>
            {statusLabel}
          </span>
        </div>

        <div className="player-card me">
          <span className="player-piece">{playerColor === "w" ? "♔" : "♛"}</span>
          <div>
            <div className="player-name">{playerName}</div>
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
            <button className="play-btn primary" onClick={requestRematch}>Rematch</button>
            <button className="play-btn ghost"   onClick={onLeave}>Leave</button>
          </div>
        )}
      </div>

      <div className="game-board-wrap">
        {/* FIX: key={playerColor} forces Chessboard to remount when color is assigned,
            ensuring boardOrientation takes effect in react-chessboard v5 */}
        <Chessboard
          key={playerColor}
          position={game.fen()}
          onPieceDrop={onDrop}
          onSquareClick={onSquareClick}
          boardOrientation={boardOrientation}
          customSquareStyles={customSquareStyles}
          customBoardStyle={{ borderRadius: "8px", boxShadow: "0 16px 60px rgba(0,0,0,0.6)" }}
          customDarkSquareStyle={{ backgroundColor: "#8B6914" }}
          customLightSquareStyle={{ backgroundColor: "#F0D9A0" }}
          arePiecesDraggable={isMyTurn}
        />
      </div>

      <div className="game-sidebar right">
        <div className="move-history">
          <h3>Move History</h3>
          <div className="move-list" ref={moveListRef}>
            {movePairs.length === 0
              ? <p className="no-moves">Game not started yet</p>
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
