# Deploying to Render — Step by Step

## What you'll end up with

| Service | URL (example) |
|---|---|
| Server | `https://chess-server.onrender.com` |
| Client | `https://chess-client.onrender.com` |

Your friends visit the client URL and play from anywhere.

---

## Prerequisites

- A [Render](https://render.com) account (free)
- Your project pushed to a **GitHub repo**

If you haven't pushed to GitHub yet:
```bash
cd chess-project
git init          # skip if already a git repo
git add .
git commit -m "initial commit"
# Create a repo on github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/chess-project.git
git push -u origin main
```

---

## Step 1 — Add the config files to your project

Copy the following two files into your project:

- `render.yaml` → root of the project (next to `client/` and `server/`)
- Replace `client/.env` contents with just:
  ```
  VITE_SOCKET_URL=PASTE_YOUR_SERVER_URL_HERE
  ```
  (you'll fill in the real URL after the server deploys)

Commit and push:
```bash
git add render.yaml
git commit -m "add render deployment config"
git push
```

---

## Step 2 — Deploy the SERVER first

1. Go to [render.com/dashboard](https://dashboard.render.com)
2. Click **"New +"** → **"Web Service"**
3. Connect your GitHub repo
4. Fill in:
   - **Name:** `chess-server` (or anything)
   - **Root Directory:** `server`
   - **Runtime:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `node index.js`
   - **Plan:** Free
5. Under **Environment Variables**, add:
   - `PORT` = `3001`
6. Click **"Create Web Service"**
7. Wait for the build to finish (2–3 min)
8. **Copy the URL** shown at the top — looks like `https://chess-server-xxxx.onrender.com`

---

## Step 3 — Deploy the CLIENT

1. Click **"New +"** → **"Static Site"**
2. Connect the same GitHub repo
3. Fill in:
   - **Name:** `chess-client`
   - **Root Directory:** `client`
   - **Build Command:** `npm install && npm run build`
   - **Publish Directory:** `dist`
4. Under **Environment Variables**, add:
   - `VITE_SOCKET_URL` = `https://chess-server-xxxx.onrender.com`
     *(paste the exact URL from Step 2 — no trailing slash)*
5. Click **"Create Static Site"**
6. Wait for build (2–3 min)
7. Your client URL appears at the top — share this with your friends!

---

## Step 4 — Test it

1. Open the client URL in your browser
2. Create a room
3. Send the room code to a friend
4. They open the same client URL, enter the code, and join

---

## ⚠️ Important: Free Tier Spin-Down

Render's free tier **spins down the server after 15 minutes of inactivity**.
The first connection after that takes **~30 seconds** to wake up.

To work around this:
- Just warn your friends: "first load might be slow"
- Or upgrade to Render's $7/mo "Starter" plan to keep it always-on
- Or use a free service like [UptimeRobot](https://uptimerobot.com) to ping
  your `/health` endpoint every 10 minutes to keep it warm:
  - Monitor type: HTTP(S)
  - URL: `https://chess-server-xxxx.onrender.com/health`
  - Interval: 10 minutes

---

## Updating the game later

After any code change:
```bash
git add .
git commit -m "your message"
git push
```
Render auto-redeploys both services whenever you push to `main`.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Client connects but moves don't sync | Check `VITE_SOCKET_URL` in Render env vars — must match server URL exactly |
| "Room not found" errors | Server likely restarted (free tier) — create a new room |
| Build fails on client | Make sure `VITE_SOCKET_URL` env var is set before building |
| WebSocket connection refused | Render supports WebSockets on all plans — check server logs in Render dashboard |
