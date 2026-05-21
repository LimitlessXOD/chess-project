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

    socket.on("room_joined", ({ roomId, color, opponentName }) => {
      roomIdRef.current      = roomId;
      playerColorRef.current = color;
      opponentRef.current    = opponentName;
      setRoomId(roomId);
      setPlayerColor(color);
      setOpponentName(opponentName);
      setStatus(`Playing against ${opponentName}`);
    });

    socket.on("opponent_joined", ({ opponentName }) => {
      opponentRef.current = opponentName;
      setOpponentName(opponentName);
      setStatus(`Playing against ${opponentName}`);
    });

    socket.on("game_start", ({ whitePlayer, blackPlayer }) => {
      setStatus(`${whitePlayer} (White) vs ${blackPlayer} (Black)`);
    });

    // Server ACKs our move — update board to authoritative state
    socket.on("move_ack", ({ move, fen }) => {
      const g = new Chess(fen);
      gameRef.current = g;
      setGame(g);
      setMoveHistory((h) => [...h, move]);
      if (g.isCheck()) setStatus("Check!");
    });

    // Opponent's move arrives with server-authoritative FEN
    socket.on("opponent_move", ({ move, fen }) => {
      const g = new Chess(fen);
      gameRef.current = g;
      setGame(g);
      setMoveHistory((h) => [...h, move]);
      if (g.isCheck()) setStatus("Check!");
    });

    // Server rejected move — revert to authoritative FEN
    socket.on("illegal_move", ({ fen }) => {
      const g = new Chess(fen);
      gameRef.current = g;
      setGame(g);
      setStatus("Illegal move.");
    });

    socket.on("game_over", ({ result }) => {
      setGameResult(result);
      setStatus("Game over");
    });

    socket.on("opponent_disconnected", ({ reconnecting: oppReconnecting }) => {
      setStatus(oppReconnecting
        ? "Opponent disconnected — waiting 30s for reconnect…"
        : "Opponent disconnected."
      );
    });

    socket.on("opponent_left",       ()            => { setStatus("Opponent left."); setGameResult("Opponent left."); });
    socket.on("error",               ({ message }) => setStatus(`Error: ${message}`));
    socket.on("clock_update",        ({ times })   => setTimes(times));
    socket.on("draw_offered",        ({ from })    => setDrawOffer(from));
    socket.on("draw_declined",       ()            => { setDrawOffer(null); setStatus("Draw declined."); });
    socket.on("rematch_requested",   ({ from })    => setRematchRequest(from));
    socket.on("rematch_declined",    ()            => { setRematchRequest(null); setStatus("Rematch declined."); });

    socket.on("rematch_start", ({ colors, fen }) => {
      const fresh = new Chess(fen);
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
      setStatus(`Playing against ${opponentRef.current}`);
    });

    return () => socket.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // No optimistic updates — just validate locally and send to server.
  // Server responds with move_ack (accepted) or illegal_move (rejected).
  const onDrop = useCallback((sourceSquare, targetSquare, piece) => {
    const color  = playerColorRef.current;
    const room   = roomIdRef.current;
    const g      = gameRef.current;
    const result = resultRef.current;

    if (!color || result) return false;
    if (g.turn() !== color) return false;

    const promotion =
      (piece === "wP" && targetSquare[1] === "8") ||
      (piece === "bP" && targetSquare[1] === "1")
        ? "q" : undefined;

    // Local validation so illegal drags snap back immediately
    const copy = new Chess(g.fen());
    const localMove = copy.move({ from: sourceSquare, to: targetSquare, promotion });
    if (!localMove) return false;

    // Send to server — board updates only when move_ack comes back
    socketRef.current?.emit("move", {
      roomId: room,
      move: { from: sourceSquare, to: targetSquare, promotion },
    });

    // Optimistically show the move so it feels responsive
    gameRef.current = copy;
    setGame(copy);

    return true;
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
  const boardOrientation = playerColor === "b" ? "black" : "white";

  const movePairs = [];
  for (let i = 0; i < moveHistory.length; i += 2) {
    movePairs.push({ num: Math.floor(i / 2) + 1, w: moveHistory[i], b: moveHistory[i + 1] });
  }

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
          {gameResult
            ? <span className="result-text">{gameResult}</span>
            : <span className={isMyTurn ? "your-turn" : "their-turn"}>
                {isMyTurn ? "Your turn" : status}
              </span>
          }
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
        <Chessboard
          position={game.fen()}
          onPieceDrop={onDrop}
          boardOrientation={boardOrientation}
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
