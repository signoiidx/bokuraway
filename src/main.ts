import 'dotenv/config';
import { app, BrowserWindow, ipcMain, screen, shell } from 'electron';
import fs from 'fs';
import http from 'http';
import path from 'path';
import axios, { AxiosError } from 'axios';
import { LAMP_ORDER, lampCat, computeNudges } from './nudge';
import { readCache, writeCache } from './cache';

console.log('CLIENT_ID:', process.env.CLIENT_ID);
console.log('CLIENT_SECRET:', process.env.CLIENT_SECRET ? '***loaded***' : 'UNDEFINED');

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:8080/callback';
const TACHI_BASE = 'https://boku.tachi.ac/api/v1';

let mainWindow: BrowserWindow | null = null;
let accessToken: string | null = null;
let callbackServer: http.Server | null = null;

// ─── Difficulty table fetching ────────────────────────────────────────────────
// DiffTableEntry などの共有型は src/types.ts (グローバル宣言) を参照

interface DiffTableConfig {
  id: string;
  symbol: string;
  headerUrl: string;
}

const DIFF_TABLE_CONFIGS: DiffTableConfig[] = [
  { id: 'insane',    symbol: '★',  headerUrl: 'https://miraiscarlet.github.io/bms/table/genocide_insane/header_insane.json' },
  { id: 'satellite', symbol: 'sl', headerUrl: 'https://stellabms.xyz/sl/header.json' },
  { id: 'stella',    symbol: 'st', headerUrl: 'https://stellabms.xyz/st/header.json' },
  { id: 'overjoy',   symbol: '★★', headerUrl: 'https://lr2.sakura.ne.jp/data/header.json' },
];

async function fetchBmsTable(config: DiffTableConfig): Promise<DiffTableEntry[]> {
  let headerUrl = config.headerUrl;

  if (headerUrl.endsWith('.html')) {
    const html = (await axios.get<string>(headerUrl, { timeout: 10_000 })).data as string;
    const m = html.match(/name=["']bmstable["'][^>]*content=["']([^"']+)["']|content=["']([^"']+)["'][^>]*name=["']bmstable["']/i);
    const metaUrl = m?.[1] || m?.[2];
    if (!metaUrl) throw new Error(`No bmstable meta in ${headerUrl}`);
    headerUrl = metaUrl;
  }

  const header = (await axios.get<{ data_url: string }>(headerUrl, { timeout: 10_000 })).data;
  const dataUrl = new URL(header.data_url, headerUrl).href;
  const entries = (await axios.get<unknown[]>(dataUrl, { timeout: 10_000 })).data;

  return (entries as { md5?: string; title?: string; level?: string | number }[])
    .map(e => {
      const md5 = (e.md5 || '').toLowerCase().trim();
      const rawLevel = String(e.level ?? '');
      return { md5, title: e.title ?? '', level: `${config.symbol}${rawLevel}`, levelNum: parseInt(rawLevel) || 0, table: config.id };
    })
    .filter(e => /^[0-9a-f]{32}$/.test(e.md5));
}

// ─── Data helpers ─────────────────────────────────────────────────────────────

function joinedPBs(data: TachiPBsResponse): TachiPB[] {
  const chartMap = new Map((data.charts ?? []).map(c => [c.chartID, c]));
  return (data.pbs ?? []).map(pb => {
    const chart = chartMap.get(pb.chartID) ?? {} as TachiChart;
    return { ...pb, chart: { ...chart, songTitle: chart.song?.title ?? '', artist: chart.song?.artist ?? '' } };
  });
}

function bestPerChart(scores: TachiPB[]): TachiPB[] {
  const best = new Map<string, TachiPB>();
  for (const s of scores) {
    if (!s.chartID) continue;
    const prev = best.get(s.chartID);
    const curr = LAMP_ORDER[lampCat(s.scoreData?.lamp)] ?? -1;
    const prev_ = prev ? (LAMP_ORDER[lampCat(prev.scoreData?.lamp)] ?? -1) : -1;
    if (!prev || curr > prev_) best.set(s.chartID, s);
  }
  return [...best.values()];
}

function getLevel(chart: TachiPB['chart']): number {
  return chart?.levelNum ?? (parseFloat(chart?.level ?? '') || 0);
}

// ─── Window ───────────────────────────────────────────────────────────────────

const MIN_WIDTH = 800;
const MIN_HEIGHT = 600;

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized?: boolean;
}

const DEFAULT_WINDOW_STATE: WindowState = { width: 1100, height: 750 };

function windowStatePath(): string {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState(): WindowState {
  let raw: Partial<WindowState>;
  try {
    raw = JSON.parse(fs.readFileSync(windowStatePath(), 'utf8')) as Partial<WindowState>;
  } catch {
    return { ...DEFAULT_WINDOW_STATE };
  }
  if (typeof raw.width !== 'number' || typeof raw.height !== 'number') {
    return { ...DEFAULT_WINDOW_STATE };
  }

  const state: WindowState = {
    width: Math.max(MIN_WIDTH, Math.round(raw.width)),
    height: Math.max(MIN_HEIGHT, Math.round(raw.height)),
    isMaximized: raw.isMaximized === true,
  };

  if (typeof raw.x === 'number' && typeof raw.y === 'number') {
    // マルチモニター構成が変わって保存位置が画面外になった場合は位置を捨てる
    // (幅・高さは残し、位置は OS のデフォルト配置に任せる)
    const onScreen = screen.getAllDisplays().some(d => {
      const a = d.workArea;
      return raw.x! < a.x + a.width && raw.x! + state.width > a.x
          && raw.y! < a.y + a.height && raw.y! + state.height > a.y;
    });
    if (onScreen) {
      state.x = Math.round(raw.x);
      state.y = Math.round(raw.y);
    }
  }
  return state;
}

function saveWindowState(win: BrowserWindow): void {
  try {
    // 最大化中は getBounds() が画面いっぱいの値を返すため、通常時の枠を保存する
    const state: WindowState = { ...win.getNormalBounds(), isMaximized: win.isMaximized() };
    fs.writeFileSync(windowStatePath(), JSON.stringify(state));
  } catch (e) {
    console.error('Failed to save window state:', e);
  }
}

function createWindow(): void {
  const state = loadWindowState();
  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f0f14',
  });
  if (state.isMaximized) mainWindow.maximize();
  mainWindow.on('close', () => { if (mainWindow) saveWindowState(mainWindow); });
  mainWindow.loadFile(path.join(__dirname, '../index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ─── OAuth ────────────────────────────────────────────────────────────────────

function closeCallbackServer(): void {
  if (callbackServer) {
    callbackServer.close();
    callbackServer = null;
  }
}

ipcMain.handle('oauth-start', async () => {
  if (callbackServer) {
    return { success: false, error: 'OAuth already in progress' };
  }

  try {
    const serverReady = new Promise<string | null>((resolve, reject) => {
      callbackServer = http.createServer((req, res) => {
        const url = new URL(req.url!, 'http://localhost:8080');
        if (url.pathname !== '/callback') { res.end(); return; }
        const code = url.searchParams.get('code');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body style="background:#0f0f14;color:#c8c8d0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><p>認証完了。このタブを閉じてください。</p></body></html>');
        closeCallbackServer();
        resolve(code);
      });
      callbackServer.listen(8080, () => { });
      callbackServer.on('error', reject);
    });

    shell.openExternal(`https://boku.tachi.ac/oauth/request-auth?clientID=${CLIENT_ID}`);

    const code = await serverReady;
    if (!code) return { success: false, error: 'No code received' };

    const res = await axios.post(`${TACHI_BASE}/oauth/token`, {
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }, {
      headers: { 'Content-Type': 'application/json' },
    });
    accessToken = res.data.body.token;
    return { success: true };
  } catch (e) {
    const err = e as AxiosError;
    const detail = err.response?.data ?? err.message;
    console.error('TOKEN ERROR:', JSON.stringify(detail, null, 2));
    return { success: false, error: JSON.stringify(detail) };
  } finally {
    closeCallbackServer();
  }
});

ipcMain.handle('logout', async () => {
  accessToken = null;
  closeCallbackServer();
  return { success: true };
});

// ─── API util ─────────────────────────────────────────────────────────────────

async function tachiGet(apiPath: string): Promise<unknown> {
  console.log('tachiGet:', apiPath, '/ token:', accessToken ? '***set***' : 'NOT SET');
  try {
    const res = await axios.get(`${TACHI_BASE}${apiPath}`, {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    });
    console.log('tachiGet response:', JSON.stringify(res.data).slice(0, 200));
    return res.data.body;
  } catch (e) {
    const err = e as AxiosError;
    const detail = err.response?.data ?? err.message;
    console.error('tachiGet ERROR:', JSON.stringify(detail, null, 2));
    if (err.response?.status === 401) {
      // Custom Error properties don't survive the ipcMain.handle serialization
      // boundary (only `message` reaches the renderer), so signal via message text.
      accessToken = null;
      throw new Error('AUTH_EXPIRED');
    }
    throw e;
  }
}

// ─── PB fetching with cache ───────────────────────────────────────────────────
// 起動直後はディスクキャッシュを即座に返してレンダリングを始め、裏で最新を取得。
// 差分があればキャッシュを更新して 'pbs-updated' をレンダラーに通知する。
// メモリ上のコピー (pbsMemo) は同一セッション内の再フェッチと通知ループを防ぐ。

const pbsMemo = new Map<number, TachiPBsResponse>();
const pbsRefreshing = new Set<number>();

function pbsCacheKey(userID: number): string {
  return `pbs-bms-7k-${userID}`;
}

async function fetchPBsFresh(userID: number): Promise<TachiPBsResponse> {
  const fresh = await tachiGet(`/users/${userID}/games/bms-7k/pbs/all`) as TachiPBsResponse;
  pbsMemo.set(userID, fresh);
  writeCache(pbsCacheKey(userID), fresh);
  return fresh;
}

function refreshPBsInBackground(userID: number, cached: TachiPBsResponse): void {
  if (pbsRefreshing.has(userID)) return;
  pbsRefreshing.add(userID);
  fetchPBsFresh(userID)
    .then(fresh => {
      if (JSON.stringify(fresh) !== JSON.stringify(cached)) {
        mainWindow?.webContents.send('pbs-updated');
      }
    })
    .catch(e => console.error('Background PB refresh failed:', (e as AxiosError).message))
    .finally(() => pbsRefreshing.delete(userID));
}

async function fetchPBs(userID: number): Promise<TachiPBsResponse> {
  const memo = pbsMemo.get(userID);
  if (memo) return memo;

  const cached = readCache<TachiPBsResponse>(pbsCacheKey(userID));
  if (cached) {
    refreshPBsInBackground(userID, cached);
    return cached;
  }

  return fetchPBsFresh(userID);
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────

ipcMain.handle('get-me', async () => {
  try {
    return await tachiGet('/users/me');
  } catch (e) {
    const err = e as AxiosError;
    const detail = err.response?.data ?? err.message;
    console.error('GET-ME ERROR:', JSON.stringify(detail, null, 2));
    throw e;
  }
});

// Returns flat joined array (one entry per score, chart+song data embedded)
ipcMain.handle('get-scores', async (_e, userID: number) => {
  let data: TachiPBsResponse;
  try {
    data = await fetchPBs(userID);
  } catch (e) {
    if ((e as AxiosError).response?.status === 404) return [];
    throw e;
  }
  return joinedPBs(data);
});

// Returns { nudges: [...], toHard: [...], toEasy: [...] } — best lamp per chart.
// nudges = HARD/EASY CLEAR まであと一歩の譜面 (closeness 降順)。toHard/toEasy はレベル昇順。
ipcMain.handle('get-recommend', async (_e, userID: number) => {
  console.log('get-recommend userID:', userID);
  let data: TachiPBsResponse;
  try {
    data = await fetchPBs(userID);
  } catch (e) {
    if ((e as AxiosError).response?.status === 404) return { nudges: [], toHard: [], toEasy: [], noProfile: true };
    throw e;
  }

  const best = bestPerChart(joinedPBs(data));
  const nudges = computeNudges(best);
  // HARD CLEAR 狙い: EASY/CLEAR 済みでまだ HARD CLEAR していない譜面
  const toHard = best
    .filter(s => {
      const o = LAMP_ORDER[lampCat(s.scoreData?.lamp)] ?? -1;
      return o >= LAMP_ORDER.EASY && o < LAMP_ORDER.HARD;
    })
    .sort((a, b) => getLevel(a.chart) - getLevel(b.chart));
  // EASY CLEAR 狙い: まだ EASY CLEAR にも届いていない譜面 (FAILED, ASSIST)
  const toEasy = best
    .filter(s => (LAMP_ORDER[lampCat(s.scoreData?.lamp)] ?? -1) < LAMP_ORDER.EASY)
    .sort((a, b) => getLevel(a.chart) - getLevel(b.chart));

  return { nudges, toHard, toEasy };
});

const TABLE_CACHE_KEY = 'diff-tables';
const TABLE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

ipcMain.handle('get-table-data', async () => {
  const cached = readCache<Record<string, DiffTableEntry[]>>(TABLE_CACHE_KEY, TABLE_CACHE_TTL_MS);
  if (cached) {
    console.log('Difficulty tables served from cache');
    return cached;
  }

  const result: Record<string, DiffTableEntry[]> = {};
  await Promise.allSettled(
    DIFF_TABLE_CONFIGS.map(async config => {
      try {
        result[config.id] = await fetchBmsTable(config);
        console.log(`Table ${config.id}: ${result[config.id].length} entries`);
      } catch (e) {
        console.error(`Table ${config.id} failed:`, (e as AxiosError).message);
        result[config.id] = [];
      }
    })
  );
  // 全テーブル失敗時はキャッシュせず、次回起動で再取得させる
  if (Object.values(result).some(entries => entries.length > 0)) {
    writeCache(TABLE_CACHE_KEY, result);
  }
  return result;
});
