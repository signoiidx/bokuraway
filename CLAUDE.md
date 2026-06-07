# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

**bokuraway** is an Electron desktop app that helps BMS (Beat Music Simulator) players improve by surfacing practice recommendations via the [Bokutachi](https://boku.tachi.ac) API.

## Running the app

```
npm install
# Copy .env.example to .env and fill in CLIENT_ID and CLIENT_SECRET from the Bokutachi developer console
npm start
```

No build step — Electron loads files directly.

## Architecture

The app follows Electron's standard main/renderer split with context isolation:

- **`main.js`** — Main process. Creates the `BrowserWindow`, runs an OAuth callback server on `http://localhost:8080/callback`, and exposes five IPC handlers: `oauth-start`, `get-me`, `get-scores`, `get-recommend`, `get-stats`. All Bokutachi API calls go through `tachiGet()` here using the stored `accessToken`.
- **`preload.js`** — Context bridge. Exposes `window.tachi` to the renderer with five methods: `startOAuth`, `getMe`, `getScores`, `getRecommend`, `getStats`. `nodeIntegration` is disabled; this is the only way renderer code talks to the main process.
- **`index.html`** — Single-file renderer (HTML + CSS + JS). Handles the auth screen, sidebar navigation, and three pages: "レコメンド" (Recommend), "スコア一覧" (Score List), and "統計" (Stats). No framework or bundler.

## Bokutachi API

Base URL: `https://boku.tachi.ac/api/v1`

OAuth flow: open `https://boku.tachi.ac/oauth/request-auth?clientID=...` in the system browser → local HTTP server captures the `code` at `/callback` → POST to `/oauth/token` → store bearer token in memory.

Credentials (`CLIENT_ID`, `CLIENT_SECRET`) are read from `.env` via `dotenv`.

### Tachi v3 API notes

- **Game identifier:** Tachi v3 merged the old `/:gameGroup/:playtype` path segments into a single `/:game` identifier. BMS 7K is `bms-7k` (not `bms/7K`). The PB endpoint is `/users/:userID/games/bms-7k/pbs/all`.
- **ChartDocument schema:** The song is embedded directly inside each `ChartDocument` as `chart.song` (fields: `title`, `artist`, `id`, etc.). There is no separate `chart.songID` join key — use `chart.song.title` / `chart.song.artist` directly.
- **BMS difficulty:** BMS 7K has only one difficulty value: `"CHART"`. This is correct and intentional — each BMS file is its own standalone chart.
- **BMS level:** Charts not listed in any difficulty table have `levelNum: 0`. Charts with table entries (insane, satellite, etc.) carry their actual level.

## Recommend logic

`get-recommend` IPC handler:

1. Fetches all BMS 7K PBs for the user via `/users/:userID/games/bms-7k/pbs/all`.
2. Deduplicates to one entry per chart keeping the best lamp (`bestPerChart`).
3. Returns `{ toHard, toClear }`:
   - `toHard` — charts CLEARed or EASY CLEARed but not yet HARD CLEARed, sorted ascending by level.
   - `toClear` — charts below CLEAR (EASY, ASSIST, FAILED), sorted ascending by level.
