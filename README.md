# HSHO Player API — Supabase

This package ports the submitted MongoDB-backed REST API to Supabase while preserving its current routes and player JSON shape.

## Setup

1. In Supabase SQL Editor, run `supabase/schema.sql`.
2. In Render, set `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and optionally `STEAM_APP_ID=2334220` and `STEAM_API_KEY`.
3. Set Build Command to `npm install` and Start Command to `npm start` (Node 20+).
4. Check `/health`; it should return `{"status":"ok","database":"connected"}`.

The Supabase secret key must stay in the backend environment. Do not put it in the Launcher, browser code, game files, GitHub, or a shared ZIP. `.env.example` contains placeholders only.

## Preserved routes

- `GET /live/checkversion`
- `GET /live/player/getdata`
- `GET /live/steam/info`
- `GET /health`

## Steam/game authentication limitation

The submitted source had a `requireVerifiedSteamUser` guard that reads `req.user.steamId`, but no middleware ever sets `req.user`. This port preserves the fail-closed guard; `/live/player/getdata` will continue returning 401 until the game or an authorized gateway provides a real Steam ticket and a supported verifier populates `req.user`. Do not replace this with a caller-supplied Steam ID, which would let anyone read or create another player's record.

This is a database-backed HTTP API. It does not implement HSHO's proprietary callback protocol, matchmaking, or game servers, so migrating MongoDB to Supabase by itself does not remove the in-game Error Code 4.
