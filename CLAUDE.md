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

- **`main.js`** — Main process. Creates the `BrowserWindow`, runs an OAuth callback server on `http://localhost:8080/callback`, and exposes four IPC handlers: `oauth-start`, `get-me`, `get-scores`, `get-recommend`. All Bokutachi API calls go through `tachiGet()` here using the stored `accessToken`.
- **`preload.js`** — Context bridge. Exposes `window.tachi` to the renderer with four methods: `startOAuth`, `getMe`, `getScores`, `getRecommend`. `nodeIntegration` is disabled; this is the only way renderer code talks to the main process.
- **`index.html`** — Single-file renderer (HTML + CSS + JS). Handles the auth screen, sidebar navigation, and two pages: "レコメンド" (Recommend) and "スコア一覧" (Score List). No framework or bundler.

## Bokutachi API

Base URL: `https://boku.tachi.ac/api/v1`

OAuth flow: open `https://boku.tachi.ac/oauth/request-auth?clientID=...` in the system browser → local HTTP server captures the `code` at `/callback` → POST to `/oauth/token` → store bearer token in memory.

Credentials (`CLIENT_ID`, `CLIENT_SECRET`) are read from `.env` via `dotenv`.

## Recommend logic

`get-recommend` IPC handler (in `main.js:110`):

1. Fetches all 7K BMS scores for the user.
2. Separates charts into "HARD CLEARed or FC'd" and "CLEARed or EASY CLEARed".
3. Returns up to 30 charts that are CLEARed but not yet HARD CLEARed, sorted ascending by level.
