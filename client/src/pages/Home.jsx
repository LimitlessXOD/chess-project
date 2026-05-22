import { useState } from "react";
import "./Home.css";

export default function Home({ onStartGame }) {
  const [mode, setMode] = useState(null); // 'create' | 'join' | null
  const [playerName, setPlayerName] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [error, setError] = useState("");
  const [activeSession, setActiveSession] = useState(() => {
    const savedRoomId = sessionStorage.getItem("chess_roomId");
    const savedPlayerName = sessionStorage.getItem("chess_playerName");
    return savedRoomId && savedPlayerName ? { roomId: savedRoomId, playerName: savedPlayerName } : null;
  });

  const handleCreate = () => {
    if (!playerName.trim()) { setError("Enter your name first"); return; }
    sessionStorage.removeItem("chess_roomId");
    sessionStorage.removeItem("chess_playerName");
    onStartGame({ mode: "create", playerName: playerName.trim() });
  };

  const handleJoin = () => {
    if (!playerName.trim()) { setError("Enter your name first"); return; }
    if (!roomCode.trim()) { setError("Enter a room code"); return; }
    sessionStorage.removeItem("chess_roomId");
    sessionStorage.removeItem("chess_playerName");
    onStartGame({ mode: "join", playerName: playerName.trim(), roomCode: roomCode.trim().toUpperCase() });
  };

  return (
    <div className="home">
      <div className="home-bg" />

      <header className="home-header">
        <div className="crown">♛</div>
        <h1 className="home-title">Leroy <span className="vs">vs</span> Dorothy</h1>
        <p className="home-subtitle">The ultimate chess showdown — play online with a friend</p>
      </header>

      <div className="home-stats">
        <div className="stat-card">
          <span className="stat-num">0</span>
          <span className="stat-label">Leroy Wins</span>
        </div>
        <div className="stat-divider">♟</div>
        <div className="stat-card center">
          <span className="stat-num">0</span>
          <span className="stat-label">Draws</span>
        </div>
        <div className="stat-divider">♟</div>
        <div className="stat-card">
          <span className="stat-num">0</span>
          <span className="stat-label">Dorothy Wins</span>
        </div>
      </div>

      <div className="home-play">
        {activeSession && (
          <div className="active-session-banner">
            <span className="session-icon">⚡</span>
            <div className="session-info">
              <h4>Active Game Detected</h4>
              <p>You have a game in progress in room <strong>{activeSession.roomId}</strong> as <strong>{activeSession.playerName}</strong>.</p>
            </div>
            <div className="session-actions">
              <button className="play-btn primary small" onClick={() => {
                onStartGame({
                  mode: "reconnect",
                  playerName: activeSession.playerName,
                  roomCode: activeSession.roomId
                });
              }}>
                Resume Game
              </button>
              <button className="play-btn ghost small" onClick={() => {
                sessionStorage.removeItem("chess_roomId");
                sessionStorage.removeItem("chess_playerName");
                setActiveSession(null);
              }}>
                Dismiss
              </button>
            </div>
          </div>
        )}

        {!mode ? (
          <div className="play-options">
            <div className="name-row">
              <input
                className="name-input"
                placeholder="Your name…"
                value={playerName}
                onChange={(e) => { setPlayerName(e.target.value); setError(""); }}
                onKeyDown={(e) => e.key === "Enter" && setMode("create")}
              />
            </div>
            {error && <p className="error-msg">{error}</p>}
            <div className="play-buttons">
              <button className="play-btn primary" onClick={() => { if (!playerName.trim()) { setError("Enter your name first"); return; } setMode("create"); }}>
                ♔ Create Room
              </button>
              <button className="play-btn secondary" onClick={() => { if (!playerName.trim()) { setError("Enter your name first"); return; } setMode("join"); }}>
                ♖ Join Room
              </button>
            </div>
            <button className="play-btn local" onClick={() => {
              const name = playerName.trim() || "Guest";
              sessionStorage.removeItem("chess_roomId");
              sessionStorage.removeItem("chess_playerName");
              onStartGame({ mode: "local", playerName: name });
            }}>
              ♟ Local Play (Sandbox)
            </button>
          </div>
        ) : mode === "create" ? (
          <div className="modal-box">
            <h3>Create a Room</h3>
            <p>Share the room code with your opponent after creating.</p>
            {error && <p className="error-msg">{error}</p>}
            <div className="modal-actions">
              <button className="play-btn primary" onClick={handleCreate}>Create & Get Code</button>
              <button className="play-btn ghost" onClick={() => { setMode(null); setError(""); }}>← Back</button>
            </div>
          </div>
        ) : (
          <div className="modal-box">
            <h3>Join a Room</h3>
            <input
              className="name-input code-input"
              placeholder="Room code (e.g. AB12CD)"
              value={roomCode}
              onChange={(e) => { setRoomCode(e.target.value); setError(""); }}
              onKeyDown={(e) => e.key === "Enter" && handleJoin()}
              maxLength={6}
            />
            {error && <p className="error-msg">{error}</p>}
            <div className="modal-actions">
              <button className="play-btn primary" onClick={handleJoin}>Join Game</button>
              <button className="play-btn ghost" onClick={() => { setMode(null); setError(""); setRoomCode(""); }}>← Back</button>
            </div>
          </div>
        )}
      </div>

      <div className="home-features">
        <div className="feature">
          <span className="feature-icon">♜</span>
          <h4>Real-Time Multiplayer</h4>
          <p>Instant move sync via WebSockets — no lag, no delays</p>
        </div>
        <div className="feature">
          <span className="feature-icon">♞</span>
          <h4>Full Chess Rules</h4>
          <p>Castling, en passant, promotion — all handled automatically</p>
        </div>
        <div className="feature">
          <span className="feature-icon">♝</span>
          <h4>Move History</h4>
          <p>Every game recorded in standard chess notation</p>
        </div>
      </div>

      <footer className="home-footer">
        <span>Made with ♥ — Leroy vs Dorothy Chess Club</span>
      </footer>
    </div>
  );
}
