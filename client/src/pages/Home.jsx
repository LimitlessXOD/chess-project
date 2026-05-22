import { useState } from "react";
import "./Home.css";

export default function Home({ onStartGame, externalScores, externalHistory }) {
  const [mode, setMode] = useState(null); // 'create' | 'join' | null
  const [playerName, setPlayerName] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [password, setPassword] = useState("");
  const [makePersistent, setMakePersistent] = useState(false);
  const [error, setError] = useState("");
  const [activeSession, setActiveSession] = useState(() => {
    const savedRoomId = sessionStorage.getItem("chess_roomId");
    const savedPlayerName = sessionStorage.getItem("chess_playerName");
    return savedRoomId && savedPlayerName
      ? { roomId: savedRoomId, playerName: savedPlayerName }
      : null;
  });

  // Saved rooms stored in localStorage for persistence across sessions
  const [savedRooms, setSavedRooms] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("chess_saved_rooms") || "[]");
    } catch { return []; }
  });

  const globalScores = externalScores || { w: 0, b: 0, draws: 0 };
  const gameHistory  = externalHistory || [];
  const [showHistory, setShowHistory] = useState(false);

  const handleCreate = () => {
    if (!playerName.trim()) { setError("Enter your name first"); return; }
    sessionStorage.removeItem("chess_roomId");
    sessionStorage.removeItem("chess_playerName");
    onStartGame({
      mode: "create",
      playerName: playerName.trim(),
      persistent: makePersistent,
      password: makePersistent ? password.trim() : null,
      onScoresUpdate: (scores, history) => {
        setGlobalScores(scores);
      },
    });
  };

  const handleJoin = () => {
    if (!playerName.trim()) { setError("Enter your name first"); return; }
    if (!roomCode.trim()) { setError("Enter a room code"); return; }
    sessionStorage.removeItem("chess_roomId");
    sessionStorage.removeItem("chess_playerName");
    onStartGame({
      mode: "join",
      playerName: playerName.trim(),
      roomCode: roomCode.trim().toUpperCase(),
      password: password.trim() || null,
    });
  };

  const handleRejoinSaved = (savedRoom) => {
    onStartGame({
      mode: "join",
      playerName: savedRoom.playerName,
      roomCode: savedRoom.roomId,
      password: savedRoom.password || null,
    });
  };

  const removeSavedRoom = (roomId) => {
    const updated = savedRooms.filter(r => r.roomId !== roomId);
    setSavedRooms(updated);
    localStorage.setItem("chess_saved_rooms", JSON.stringify(updated));
  };

  return (
    <div className="home">
      <div className="home-bg" />

      <header className="home-header">
        <div className="crown">♛</div>
        <h1 className="home-title">Ultimate Chess Showdown</h1>
        <p className="home-subtitle">The ultimate chess showdown — play online with a friend</p>
      </header>

      <div className="home-stats">
        <div className="stat-card">
          <span className="stat-num stat-animated">{globalScores.w}</span>
          <span className="stat-label">White Wins</span>
        </div>
        <div className="stat-divider">♟</div>
        <div className="stat-card center">
          <span className="stat-num stat-animated">{globalScores.draws}</span>
          <span className="stat-label">Draws</span>
        </div>
        <div className="stat-divider">♟</div>
        <div className="stat-card">
          <span className="stat-num stat-animated">{globalScores.b}</span>
          <span className="stat-label">Black Wins</span>
        </div>

        {(globalScores.w + globalScores.b + globalScores.draws) > 0 && (
          <button
            className="history-toggle-btn"
            onClick={() => setShowHistory(h => !h)}
            title="View game history"
          >
            {showHistory ? "▲ Hide History" : "▼ Match History"}
          </button>
        )}
      </div>

      {showHistory && gameHistory.length > 0 && (
        <div className="history-panel">
          <h3 className="history-title">Match History</h3>
          <div className="history-list">
            {gameHistory.map((g, i) => (
              <div key={i} className={`history-row ${g.winner === "draw" ? "draw" : ""}`}>
                <span className="history-num">#{gameHistory.length - i}</span>
                <span className="history-players">{g.playerW} <em>vs</em> {g.playerB}</span>
                <span className="history-result">{g.result}</span>
                <span className="history-moves">{g.moveCount} moves</span>
                <span className="history-date">{new Date(g.date).toLocaleDateString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="home-play">
        {activeSession && (
          <div className="active-session-banner">
            <span className="session-icon">⚡</span>
            <div className="session-info">
              <h4>Active Game Detected</h4>
              <p>Room <strong>{activeSession.roomId}</strong> as <strong>{activeSession.playerName}</strong></p>
            </div>
            <div className="session-actions">
              <button className="play-btn primary small" onClick={() => {
                onStartGame({
                  mode: "reconnect",
                  playerName: activeSession.playerName,
                  roomCode: activeSession.roomId,
                });
              }}>Resume Game</button>
              <button className="play-btn ghost small" onClick={() => {
                sessionStorage.removeItem("chess_roomId");
                sessionStorage.removeItem("chess_playerName");
                setActiveSession(null);
              }}>Dismiss</button>
            </div>
          </div>
        )}

        {savedRooms.length > 0 && !mode && (
          <div className="saved-rooms-section">
            <h4 className="saved-rooms-title">♜ Saved Rooms</h4>
            {savedRooms.map((sr) => (
              <div key={sr.roomId} className="saved-room-card">
                <div className="saved-room-info">
                  <span className="saved-room-code">{sr.roomId}</span>
                  <span className="saved-room-name">as <strong>{sr.playerName}</strong></span>
                  {sr.scores && (
                    <span className="saved-room-score">
                      W{sr.scores.w} / D{sr.scores.draws} / L{sr.scores.b}
                    </span>
                  )}
                </div>
                <div className="saved-room-actions">
                  <button className="play-btn primary small" onClick={() => handleRejoinSaved(sr)}>
                    Rejoin
                  </button>
                  <button className="play-btn ghost small" onClick={() => removeSavedRoom(sr.roomId)}>
                    ✕
                  </button>
                </div>
              </div>
            ))}
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
              <button className="play-btn primary" onClick={() => {
                if (!playerName.trim()) { setError("Enter your name first"); return; }
                setMode("create");
              }}>♔ Create Room</button>
              <button className="play-btn secondary" onClick={() => {
                if (!playerName.trim()) { setError("Enter your name first"); return; }
                setMode("join");
              }}>♖ Join Room</button>
            </div>
            <button className="play-btn local" onClick={() => {
              const name = playerName.trim() || "Guest";
              sessionStorage.removeItem("chess_roomId");
              sessionStorage.removeItem("chess_playerName");
              onStartGame({ mode: "local", playerName: name });
            }}>♟ Local Play (Sandbox)</button>
          </div>
        ) : mode === "create" ? (
          <div className="modal-box">
            <h3>Create a Room</h3>
            <p>Share the room code with your opponent after creating.</p>

            <div className="persistent-toggle">
              <label className="toggle-label-row">
                <input
                  type="checkbox"
                  checked={makePersistent}
                  onChange={(e) => setMakePersistent(e.target.checked)}
                />
                <span>Save room (remember W/L/D history)</span>
              </label>
            </div>

            {makePersistent && (
              <input
                className="name-input"
                placeholder="Room password (optional)"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                style={{ marginBottom: "12px" }}
              />
            )}

            {error && <p className="error-msg">{error}</p>}
            <div className="modal-actions">
              <button className="play-btn primary" onClick={handleCreate}>Create & Get Code</button>
              <button className="play-btn ghost" onClick={() => { setMode(null); setError(""); setPassword(""); setMakePersistent(false); }}>← Back</button>
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
            <input
              className="name-input"
              placeholder="Password (if required)"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={{ marginTop: "10px" }}
            />
            {error && <p className="error-msg">{error}</p>}
            <div className="modal-actions">
              <button className="play-btn primary" onClick={handleJoin}>Join Game</button>
              <button className="play-btn ghost" onClick={() => { setMode(null); setError(""); setRoomCode(""); setPassword(""); }}>← Back</button>
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
          <h4>Match History</h4>
          <p>Every game recorded with W/L/D history per room</p>
        </div>
      </div>

      <footer className="home-footer">
        <span>Ultimate Chess Showdown ♟</span>
      </footer>
    </div>
  );
}
