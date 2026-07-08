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

TypeScript source is compiled to `dist/` before launch (`tsc`). `npm start` runs the build automatically.

## Testing

```
npm test   # tsc build → node --test tests/nudge.test.mjs (unit tests) → node tests/e2e.mjs (Playwright + node:test)
```

Screenshots are written to `tests/shots/` (gitignored) on each run.

## Architecture

The app follows Electron's standard main/renderer split with context isolation:

- **`src/main.ts`** — Main process. Creates the `BrowserWindow`, runs an OAuth callback server on `http://localhost:8080/callback`, and exposes six IPC handlers: `oauth-start`, `get-me`, `get-scores`, `get-recommend`, `get-stats`, `get-table-data`. All Bokutachi API calls go through `tachiGet()` using the stored `accessToken`. Difficulty table data is fetched from external JSON endpoints via `fetchBmsTable()`.
- **`src/nudge.ts`** — Pure module with the lamp helpers (`lampCat`, `LAMP_ORDER`) and the nudge logic (`computeNudges`). No Electron imports, so `tests/nudge.test.mjs` unit-tests the compiled `dist/nudge.js` directly without launching the app.
- **`src/preload.ts`** — Context bridge. Exposes `window.tachi` to the renderer with six methods: `startOAuth`, `getMe`, `getScores`, `getRecommend`, `getStats`, `getTableData`. `nodeIntegration` is disabled.
- **`index.html`** — Single-file renderer (HTML + CSS + JS). Handles the auth screen, sidebar navigation, and four pages: "レコメンド" (Recommend), "スコア一覧" (Score List), "統計" (Stats), "難易度表" (Difficulty Tables). No framework or bundler.

### Test interface

`index.html` exposes `window.__test` at the bottom of its `<script>` block for use by `tests/e2e.mjs`. It is never called during normal app flow:

```js
window.__test = {
  setScores(data),            // sets allScores
  setRecommendData(data),     // sets recommendData ({ nudges, toHard, toEasy })
  setActiveRecommendTab(tab), // sets activeRecommendTab ('nudges' | 'toHard' | 'toEasy')
  renderRecommendList(),
  setTableData(entries),      // builds tableIndex (Map<md5, entry[]>) and sets tableDataLoaded = true
  setActiveTableTab(tab),     // sets activeTableTab
  renderTableView(),
  renderScoreList(),
}
```

## Bokutachi API

Base URL: `https://boku.tachi.ac/api/v1`

OAuth flow: open `https://boku.tachi.ac/oauth/request-auth?clientID=...` in the system browser → local HTTP server captures the `code` at `/callback` → POST to `/oauth/token` → store bearer token in memory.

Credentials (`CLIENT_ID`, `CLIENT_SECRET`) are read from `.env` via `dotenv`.

### Tachi v3 API notes

- **Game identifier:** Tachi v3 merged the old `/:gameGroup/:playtype` path segments into a single `/:game` identifier. BMS 7K is `bms-7k` (not `bms/7K`). The PB endpoint is `/users/:userID/games/bms-7k/pbs/all`.
- **ChartDocument schema:** The song is embedded directly inside each `ChartDocument` as `chart.song` (fields: `title`, `artist`, `id`, etc.). There is no separate `chart.songID` join key — use `chart.song.title` / `chart.song.artist` directly.
- **BMS difficulty:** BMS 7K has only one difficulty value: `"CHART"`. This is correct and intentional — each BMS file is its own standalone chart.
- **BMS level:** Charts not listed in any difficulty table have `levelNum: 0`. Charts with table entries (insane, satellite, etc.) carry their actual level.
- **Chart extra data:** `chart.data.hashMD5` is used to match scores against difficulty table entries. `chart.data.aiLevel` carries the AI-estimated level string. `scoreData.optional.bp` holds the Bad Point count.

## Recommend logic

`get-recommend` IPC handler:

1. Fetches all BMS 7K PBs for the user via `/users/:userID/games/bms-7k/pbs/all`.
2. Deduplicates to one entry per chart keeping the best lamp (`bestPerChart`).
3. Returns `{ nudges, toHard, toEasy }`:
   - `nudges` — charts where HARD CLEAR or EASY CLEAR is within reach (see below), sorted by closeness descending.
   - `toHard` — charts EASY CLEARed or CLEARed but not yet HARD CLEARed, sorted ascending by level.
   - `toEasy` — charts not yet EASY CLEARed (ASSIST, FAILED), sorted ascending by level.

### Nudge logic (`src/nudge.ts`)

`computeNudges(pbs)` detects charts where a main BMS goal looks achievable but isn't achieved yet, on two axes:

- **Lamp goals** — judged by BP rate (`bp / notecount`; falls back to absolute BP when `chart.data.notecount` is missing):
  - FAILED/ASSIST → **EASY CLEAR** when BP rate ≤ 5% (abs BP ≤ 30)
  - EASY/CLEAR → **HARD CLEAR** when BP rate ≤ 3.5% (abs BP ≤ 20)
  - Charts already at HARD CLEAR or better get no lamp nudge.
- **Grade goals** — `scoreData.percent` (EX score rate) within 1.0 point below the next grade boundary: **A** (600/9 ≈ 66.67%), **AA** (700/9 ≈ 77.78%), **AAA** (800/9 ≈ 88.89%). Applies regardless of lamp.

Each chart gets at most one nudge — the candidate with the highest `closeness` (0–1, higher = closer). Each nudge is `{ goal, reason, closeness }`; `reason` is the Japanese label rendered in the `.nudge-badge` chip. The renderer shows nudges in the 「あと一歩」tab (default tab, `data-tab="nudges"`) on the recommend page.

## Difficulty table logic

`get-table-data` IPC handler fetches four external BMS difficulty tables at login time:

| ID | Symbol | Source |
|---|---|---|
| `insane` | ★ | miraiscarlet.github.io/bms/table/genocide_insane |
| `satellite` | sl | stellabms.xyz/sl |
| `stella` | st | stellabms.xyz/st |
| `overjoy` | ★★ | lr2.sakura.ne.jp/data |

Each table's `header.json` is fetched → resolves `data_url` → downloads the chart list → entries are indexed by MD5 (`DiffTableEntry[]`).

In the renderer, `tableIndex` is `Map<md5, DiffTableEntry[]>` (a chart can appear in multiple tables). `getTableLabels(s)` returns all matching level strings joined with ` / ` (e.g. `★11 / sl7`), or `"-"` if the chart is in no table.

The difficulty table view groups scores by level, shows played charts with their lamp and BP, and renders unplayed table entries as dimmed NO PLAY rows. A thin progress bar in each level header shows the HARD+ rate.

## Lamp colors

| Lamp | Color |
|---|---|
| FULL COMBO | rainbow gradient |
| EX HARD | yellow |
| HARD | white |
| CLEAR | blue |
| EASY | green |
| ASSIST EASY | purple |
| FAILED | red |
