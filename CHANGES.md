# Chess Project — Improvements

## What changed

### `server/index.js`
| Issue | Fix |
|---|---|
| Server accepted `fen` from client | `fen` param is now ignored — server owns board state via its own `chess.js` instance |
| No move legality check on server | Every move is validated with `chess.js` on the server; illegal moves get `illegal_move` event back |
| Client could fake `game_over` | Removed `game_over` relay from client; server emits it after checking `chess.isGameOver()` |
| Clock paused mid-game on disconnect | Added 30 s reconnect grace period — clock pauses, slot held |
| `game_start` never emitted | Now emitted when both players are in the room |
| Accept draw: offerer could accept own offer | Added `room.drawOfferFrom === socket.id` guard |

### `client/src/pages/Game.jsx`
| Issue | Fix |
|---|---|
| Hardcoded local IP `192.168.43.235` | Uses `import.meta.env.VITE_SOCKET_URL` (falls back to `localhost:3001`) |
| No reconnect logic | On connect, checks `sessionStorage` for a saved session and emits `reconnect_room` |
| Move sent FEN to server | Now sends `{ from, to, promotion }` object only — no FEN |
| No handler for `move_ack` / `illegal_move` | Added both — `move_ack` syncs authoritative FEN; `illegal_move` reverts the board |
| No handling for `opponent_left` | Added — shows message and marks game over |
| `reconnecting` state not tracked | Board is disabled while reconnecting |

---

## Setup

### 1. Install server dependency

```bash
cd server
npm install
```

chess.js is now a server dependency. Run `npm install` to pull it in.

### 2. Configure the client socket URL

Create `client/.env`:

```
VITE_SOCKET_URL=http://YOUR_SERVER_IP:3001
```

For local dev, this defaults to `http://localhost:3001` automatically.

### 3. Run

```bash
# Terminal 1
cd server && npm start

# Terminal 2
cd client && npm run dev
```

---

## What's still left to do (future work)

- **Persistent storage** — rooms live in RAM; a server restart wipes all active games. Use Redis for production.
- **Multiple servers** — Socket.IO needs a Redis adapter if you run more than one server process.
- **Rate limiting** — moves and chat have no rate limit yet; a spammer could flood the server.
- **Promotion choice** — currently always promotes to queen. Add a UI picker.
- **Win tracking** — the Home page has hardcoded 0/0/0 stats. Hook these up to a database.
