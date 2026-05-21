import { useState } from "react";
import Home from "./pages/Home";
import Game from "./pages/Game";

function App() {
  const [page, setPage] = useState("home");
  const [gameConfig, setGameConfig] = useState(null);

  const startGame = (config) => {
    setGameConfig(config);
    setPage("game");
  };

  const goHome = () => {
    setPage("home");
    setGameConfig(null);
  };

  if (page === "game" && gameConfig) {
    return <Game config={gameConfig} onLeave={goHome} />;
  }

  return <Home onStartGame={startGame} />;
}

export default App;
