import { useState } from "react";
import Home from "./pages/Home";
import Game from "./pages/Game";

function App() {
  const [page, setPage] = useState("home");
  const [gameConfig, setGameConfig] = useState(null);
  const [homeScores, setHomeScores] = useState({ w: 0, b: 0, draws: 0 });
  const [homeHistory, setHomeHistory] = useState([]);

  const startGame = (config) => {
    setGameConfig(config);
    setPage("game");
  };

  const goHome = () => {
    setPage("home");
    setGameConfig(null);
  };

  const handleScoresUpdate = (scores, history) => {
    setHomeScores(scores);
    setHomeHistory(history);
  };

  const handleRoomSaved = (roomInfo) => {
    // Save persistent room to localStorage
    try {
      const saved = JSON.parse(localStorage.getItem("chess_saved_rooms") || "[]");
      const existing = saved.findIndex(r => r.roomId === roomInfo.roomId);
      if (existing >= 0) {
        saved[existing] = roomInfo;
      } else {
        saved.unshift(roomInfo);
      }
      // Keep max 10 saved rooms
      if (saved.length > 10) saved.pop();
      localStorage.setItem("chess_saved_rooms", JSON.stringify(saved));
    } catch (e) {
      console.error("Failed to save room:", e);
    }
  };

  if (page === "game" && gameConfig) {
    return (
      <Game
        config={gameConfig}
        onLeave={goHome}
        onScoresUpdate={handleScoresUpdate}
        onRoomSaved={handleRoomSaved}
      />
    );
  }

  return (
    <Home
      onStartGame={startGame}
      externalScores={homeScores}
      externalHistory={homeHistory}
    />
  );
}

export default App;
