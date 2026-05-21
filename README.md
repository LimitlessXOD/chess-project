# ♛ Leroy vs Dorothy — Chess

A real-time multiplayer chess website built with React + Socket.io.

---

## Setup

### 1. Install dependencies

**Backend** (in the root `chess-project/` folder):
```bash
npm install
```

**Frontend** (in the `client/` folder):
```bash
cd client
npm install
npm install chess.js react-chessboard socket.io-client react-router-dom
```

---

### 2. Copy the new server file

Copy `server/index.js` into your root `chess-project/` folder
(next to your existing `package.json`).

---

### 3. Run the project

**Terminal 1 — Start the backend server:**
```bash
# in chess-project/ root
node server/index.js
```
Server runs on http://localhost:3001

**Terminal 2 — Start the frontend:**
```bash
# in chess-project/client/
npm run dev
```
Frontend runs on http://localhost:5173

---

## How to play

1. Open http://localhost:5173
2. Player 1: Enter name → **Create Room** → copy the room code
3. Player 2: Enter name → **Join Room** → paste the code
4. Play chess! Moves sync in real-time.

---

## Project Structure

```
chess-project/
├── server/
│   └── index.js          ← Express + Socket.io server
├── client/
│   └── src/
│       ├── App.jsx        ← Page router
│       ├── index.css      ← Global reset
│       └── pages/
│           ├── Home.jsx   ← Landing page
│           ├── Home.css
│           ├── Game.jsx   ← Chess game + multiplayer
│           └── Game.css
└── package.json
```

---

## Tech Stack

- **React + Vite** — Frontend
- **chess.js** — Chess rules & move validation
- **react-chessboard** — Chess board UI component
- **Socket.io** — Real-time multiplayer
- **Express** — Backend server
