import 'dotenv/config';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import http from 'http';
import path from 'path';
import axios, { AxiosError } from 'axios';

console.log('CLIENT_ID:', process.env.CLIENT_ID);
console.log('CLIENT_SECRET:', process.env.CLIENT_SECRET ? '***loaded***' : 'UNDEFINED');

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:8080/callback';
const TACHI_BASE = 'https://boku.tachi.ac/api/v1';

let mainWindow: BrowserWindow | null = null;
let accessToken: string | null = null;
let callbackServer: http.Server | null = null;

// ─── Lamp helpers ─────────────────────────────────────────────────────────────

type LampCat = 'FAILED' | 'ASSIST' | 'EASY' | 'CLEAR' | 'HARD' | 'EXHARD' | 'FC';

const LAMP_ORDER: Record<LampCat, number> = {
  FAILED: 0, ASSIST: 1, EASY: 2, CLEAR: 3, HARD: 4, EXHARD: 5, FC: 6,
};

function lampCat(lamp: string | undefined | null): LampCat {
  if (!lamp) return 'FAILED';
  const l = lamp.toUpperCase();
  if (l.includes('FULL COMBO')) return 'FC';
  if (l.startsWith('EX HARD'))  return 'EXHARD';
  if (l === 'HARD CLEAR' || l === 'HARD') return 'HARD';
  if (l === 'CLEAR')            return 'CLEAR';
  if (l === 'EASY CLEAR' || l === 'EASY') return 'EASY';
  if (l.includes('ASSIST'))     return 'ASSIST';
  return 'FAILED';
}

// ─── Difficulty table fetching ────────────────────────────────────────────────

interface DiffTableEntry {
  md5: string;
  title: string;
  level: string;
  levelNum: number;
  table: string;
}

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

interface TachiSong {
  id: string;
  title: string;
  artist: string;
}

interface TachiChart {
  chartID: string;
  level: string;
  levelNum: number;
  difficulty: string;
  song?: TachiSong;
  data?: {
    hashMD5?: string;
    hashSHA256?: string;
    aiLevel?: string;
    tableFolders?: Record<string, string>;
    notecount?: number;
  };
}

interface TachiScoreData {
  lamp?: string;
}

interface TachiPB {
  chartID: string;
  scoreData?: TachiScoreData;
  chart?: TachiChart & { songTitle: string; artist: string };
}

interface TachiPBsResponse {
  pbs?: TachiPB[];
  charts?: TachiChart[];
  songs?: TachiSong[];
}

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

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f0f14',
  });
  mainWindow.loadFile(path.join(__dirname, '../index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ─── OAuth ────────────────────────────────────────────────────────────────────

ipcMain.handle('oauth-start', async () => {
  const serverReady = new Promise<string | null>((resolve, reject) => {
    callbackServer = http.createServer((req, res) => {
      const url = new URL(req.url!, 'http://localhost:8080');
      if (url.pathname !== '/callback') { res.end(); return; }
      const code = url.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body style="background:#0f0f14;color:#c8c8d0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><p>認証完了。このタブを閉じてください。</p></body></html>');
      callbackServer!.close();
      resolve(code);
    });
    callbackServer!.listen(8080, () => { });
    callbackServer!.on('error', reject);
  });

  shell.openExternal(`https://boku.tachi.ac/oauth/request-auth?clientID=${CLIENT_ID}`);

  const code = await serverReady;
  if (!code) return { success: false, error: 'No code received' };

  try {
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
  }
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
    throw e;
  }
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
    data = await tachiGet(`/users/${userID}/games/bms-7k/pbs/all`) as TachiPBsResponse;
  } catch (e) {
    if ((e as AxiosError).response?.status === 404) return [];
    throw e;
  }
  return joinedPBs(data);
});

// Returns { toHard: [...], toClear: [...] } — best lamp per chart, sorted by level
ipcMain.handle('get-recommend', async (_e, userID: number) => {
  console.log('get-recommend userID:', userID);
  let data: TachiPBsResponse;
  try {
    data = await tachiGet(`/users/${userID}/games/bms-7k/pbs/all`) as TachiPBsResponse;
  } catch (e) {
    if ((e as AxiosError).response?.status === 404) return { toHard: [], toClear: [], noProfile: true };
    throw e;
  }

  const best = bestPerChart(joinedPBs(data));
  const toHard = best
    .filter(s => (LAMP_ORDER[lampCat(s.scoreData?.lamp)] ?? -1) < LAMP_ORDER.HARD)
    .sort((a, b) => getLevel(a.chart) - getLevel(b.chart));
  const toClear = best
    .filter(s => (LAMP_ORDER[lampCat(s.scoreData?.lamp)] ?? -1) < LAMP_ORDER.CLEAR)
    .sort((a, b) => getLevel(a.chart) - getLevel(b.chart));

  return { toHard, toClear };
});

// Returns { byLevel: { [lv]: { FC, EXHARD, HARD, CLEAR, EASY, ASSIST, FAILED } }, totals, total }
ipcMain.handle('get-stats', async (_e, userID: number) => {
  let data: TachiPBsResponse;
  try {
    data = await tachiGet(`/users/${userID}/games/bms-7k/pbs/all`) as TachiPBsResponse;
  } catch (e) {
    if ((e as AxiosError).response?.status === 404) {
      return { byLevel: {}, totals: { FC: 0, EXHARD: 0, HARD: 0, CLEAR: 0, EASY: 0, ASSIST: 0, FAILED: 0 }, total: 0 };
    }
    throw e;
  }

  const empty = (): Record<LampCat, number> => ({ FC: 0, EXHARD: 0, HARD: 0, CLEAR: 0, EASY: 0, ASSIST: 0, FAILED: 0 });
  const byLevel: Record<number, Record<LampCat, number>> = {};
  const totals = empty();

  for (const s of joinedPBs(data)) {
    const cat = lampCat(s.scoreData?.lamp);
    const lv = getLevel(s.chart);
    if (!byLevel[lv]) byLevel[lv] = empty();
    byLevel[lv][cat]++;
    totals[cat]++;
  }

  return { byLevel, totals, total: (data.pbs ?? []).length };
});

ipcMain.handle('get-table-data', async () => {
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
  return result;
});
