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

- **`src/main.ts`** — Main process. Creates the `BrowserWindow`, runs an OAuth callback server on `http://localhost:8080/callback`, and exposes five IPC handlers: `oauth-start`, `get-me`, `get-scores`, `get-recommend`, `get-table-data`. All Bokutachi API calls go through `tachiGet()` using the stored `accessToken`. Difficulty table data is fetched from external JSON endpoints via `fetchBmsTable()`. PB and table responses are cached on disk (see "Local cache" below).
- **`src/cache.ts`** — Minimal JSON disk cache (`userData/cache/<key>.json`, `{ savedAt, data }`), main-process only, with optional TTL on read.
- **`src/nudge.ts`** — Pure module with the lamp helpers (`lampCat`, `LAMP_ORDER`) and the nudge logic (`computeNudges`). No Electron imports, so `tests/nudge.test.mjs` unit-tests the compiled `dist/nudge.js` directly without launching the app.
- **`src/preload.ts`** — Context bridge. Exposes `window.tachi` to the renderer with six invoke methods (`startOAuth`, `getMe`, `getScores`, `getRecommend`, `getTableData`, `logout`) plus `onPBsUpdated(cb)`, which subscribes to the `pbs-updated` push event. `nodeIntegration` is disabled.
- **`src/renderer.ts`** — Renderer logic, loaded by `index.html` as `<script src="./dist/renderer.js">`. Handles the auth screen, sidebar navigation, and four pages: "レコメンド" (Recommend), "スコア一覧" (Score List), "統計" (Stats), "難易度表" (Difficulty Tables). The Stats page is computed renderer-side from `allScores` (`renderStats()`) so the global table filter can be applied to it. Written as a **non-module script** (no `import`/`export`) so plain `tsc` output runs in the context-isolated renderer without a bundler; the implementation is wrapped in an IIFE and only `window.__test` is exposed.
- **`src/types.ts`** — Shared type declarations (`TachiPB`, `DiffTableEntry`, `RecommendData`, …). Also a global script with no `import`/`export`, so both the module-based `main.ts` and the non-module `renderer.ts` see the types without imports. Type-only; the emitted `dist/types.js` is unused.
- **`index.html`** — Markup + CSS only. No framework or bundler.

### Test interface

`src/renderer.ts` exposes `window.__test` at the bottom of its IIFE for use by `tests/e2e.mjs`. It is never called during normal app flow:

```js
window.__test = {
  setScores(data),            // sets allScores
  setRecommendData(data),     // sets recommendData ({ nudges, toHard, toEasy })
  setActiveRecommendTab(tab), // sets activeRecommendTab ('nudges' | 'toHard' | 'toEasy')
  renderRecommendList(),
  setTableData(entries),      // builds tableIndex (Map<md5, entry[]>) and sets tableDataLoaded = true
  setTableFilter(filter),     // merges into tableFilter ({ insane, satellite, stella, overjoy, outside }) and syncs the checkboxes on all pages
  setScoreSearchQuery(q),     // sets scoreSearchQuery (score list search box state)
  setTableSearchQuery(q),     // sets tableSearchQuery (table view search box state)
  renderTableView(),
  renderScoreList(),
  renderStats(),              // renders the Stats page from allScores (table filter applied)
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

## Local cache

To make startup fast, `main.ts` caches API responses on disk via `src/cache.ts`:

- **PBs** (`get-scores` / `get-recommend` share `fetchPBs()`): if a disk cache exists it is returned immediately and a background refresh is kicked off (once per user per session, guarded by `pbsRefreshing`); when the fresh response differs, the cache is updated and `pbs-updated` is sent to the renderer, which reloads the pages (Stats re-renders from the reloaded scores). An in-memory copy (`pbsMemo`) prevents re-fetch loops within a session.
- **Difficulty tables** (`get-table-data`): cached with a 24h TTL. A fully-failed fetch (all four tables empty) is not cached, so the next launch retries.

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

### Global table filter

Every page (Recommend, Score List, Stats, Difficulty Tables) has a table filter bar: one checkbox per table plus 表外 (charts in no table). Defaults: all tables checked, 表外 unchecked. The checkboxes are generated by `renderer.ts` into each page's `.table-filter-bar` element (the tables page's bar also has `id="table-filter-bar"`); the state is the single shared `tableFilter` object, so changing a checkbox on any page syncs all bars (`syncTableFilterBars()`) and re-renders every page (`rerenderFilteredViews()`). `passesTableFilter(score)` decides visibility by MD5 lookup in `tableIndex`; before table data loads, nothing is filtered. The Recommend list/stat cards, Score List, and Stats aggregation all apply it.

On the difficulty table view, each checked table renders as a `.table-section` (heading + level sections); checking 表外 appends a section with scores whose MD5 is in no table. Within a table, scores are grouped by level, played charts show their lamp and BP, and unplayed table entries render as dimmed NO PLAY rows. A thin progress bar in each level header shows the HARD+ rate. Stat cards count charts uniquely by MD5 across the checked tables.

## Search

The score list and difficulty table pages each have a `.search-input` box (`#score-search`, `#table-search`) that filters by song title or artist (case-insensitive substring) as you type. The table view uses `matchesQuery()` and applies the query to played and unplayed rows while keeping the level grouping; unplayed entries only match on title (table data has no artist). Level sections with no matches disappear.

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
