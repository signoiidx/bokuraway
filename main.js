require('dotenv').config({ path: require('path').join(__dirname, '.env') });
console.log('CLIENT_ID:', process.env.CLIENT_ID);
console.log('CLIENT_SECRET:', process.env.CLIENT_SECRET ? '***loaded***' : 'UNDEFINED');
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const http = require('http');
const path = require('path');
const axios = require('axios');

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:8080/callback';
const TACHI_BASE = 'https://boku.tachi.ac/api/v1';

let mainWindow;
let accessToken = null;
let callbackServer = null;

// ─── Lamp helpers ─────────────────────────────────────────────────────────────

const LAMP_ORDER = { FAILED: 0, ASSIST: 1, EASY: 2, CLEAR: 3, HARD: 4, EXHARD: 5, FC: 6 };

function lampCat(lamp) {
  if (!lamp) return 'FAILED';
  const l = lamp.toUpperCase();
  if (l.includes('FULL COMBO')) return 'FC';
  if (l.startsWith('EX HARD')) return 'EXHARD';
  if (l === 'HARD CLEAR' || l === 'HARD') return 'HARD';
  if (l === 'CLEAR') return 'CLEAR';
  if (l === 'EASY CLEAR' || l === 'EASY') return 'EASY';
  if (l.includes('ASSIST')) return 'ASSIST';
  return 'FAILED';
}

// ─── Data helpers ─────────────────────────────────────────────────────────────

// Join scores array with separate charts/songs arrays returned by the API
function joinScores(data) {
  const scores = data.scores ?? [];
  const chartMap = new Map((data.charts ?? []).map(c => [c.chartID, c]));

  return scores.map(s => {
    const chart = chartMap.get(s.chartID) ?? {};
    return {
      ...s,
      chart: { ...chart, songTitle: chart.song?.title ?? s.chartID, artist: chart.song?.artist ?? '' },
    };
  });
}

// Deduplicate to one entry per chart, keeping the best lamp
function bestPerChart(scores) {
  const best = new Map();
  for (const s of scores) {
    if (!s.chartID) continue;
    const prev = best.get(s.chartID);
    const curr = LAMP_ORDER[lampCat(s.scoreData?.lamp)] ?? -1;
    const prev_ = prev ? (LAMP_ORDER[lampCat(prev.scoreData?.lamp)] ?? -1) : -1;
    if (!prev || curr > prev_) best.set(s.chartID, s);
  }
  return [...best.values()];
}

function getLevel(chart) {
  return chart?.levelNum ?? (parseFloat(chart?.level) || 0);
}

// ─── Window ───────────────────────────────────────────────────────────────────

function createWindow() {
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
  mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ─── OAuth ────────────────────────────────────────────────────────────────────

ipcMain.handle('oauth-start', async () => {
  const serverReady = new Promise((resolve, reject) => {
    callbackServer = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost:8080');
      if (url.pathname !== '/callback') { res.end(); return; }
      const code = url.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body style="background:#0f0f14;color:#c8c8d0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><p>認証完了。このタブを閉じてください。</p></body></html>');
      callbackServer.close();
      resolve(code);
    });
    callbackServer.listen(8080, () => { });
    callbackServer.on('error', reject);
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
    const detail = e.response?.data ?? e.message;
    console.error('TOKEN ERROR:', JSON.stringify(detail, null, 2));
    return { success: false, error: JSON.stringify(detail) };
  }
});

// ─── API util ─────────────────────────────────────────────────────────────────

async function tachiGet(path) {
  console.log('tachiGet:', path, '/ token:', accessToken ? '***set***' : 'NOT SET');
  try {
    const res = await axios.get(`${TACHI_BASE}${path}`, {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    });
    console.log('tachiGet response:', JSON.stringify(res.data).slice(0, 200));
    return res.data.body;
  } catch (e) {
    const detail = e.response?.data ?? e.message;
    console.error('tachiGet ERROR:', JSON.stringify(detail, null, 2));
    throw e;
  }
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────

ipcMain.handle('get-me', async () => {
  try {
    return await tachiGet('/users/me');
  } catch (e) {
    const detail = e.response?.data ?? e.message;
    console.error('GET-ME ERROR:', JSON.stringify(detail, null, 2));
    throw e;
  }
});

// Returns flat joined array (one entry per score, chart+song data embedded)
ipcMain.handle('get-scores', async (_e, userID) => {
  let data;
  try {
    data = await tachiGet(`/users/${userID}/games/bms-7k/pbs/all`);
  } catch (e) {
    if (e.response?.status === 404) return [];
    throw e;
  }
  const chartMap = new Map((data.charts ?? []).map(c => [c.chartID, c]));
  return (data.pbs ?? []).map(pb => {
    const chart = chartMap.get(pb.chartID) ?? {};
    return { ...pb, chart: { ...chart, songTitle: chart.song?.title ?? '', artist: chart.song?.artist ?? '' } };
  });
});

// Returns { toHard: [...], toClear: [...] } — best lamp per chart, sorted by level
ipcMain.handle('get-recommend', async (_e, userID) => {
  console.log('get-recommend userID:', userID);
  let data;
  try {
    data = await tachiGet(`/users/${userID}/games/bms-7k/pbs/all`);
  } catch (e) {
    if (e.response?.status === 404) return { toHard: [], toClear: [], noProfile: true };
    throw e;
  }
  const chartMap = new Map((data.charts ?? []).map(c => [c.chartID, c]));
  const pbs = (data.pbs ?? []).map(pb => {
    const chart = chartMap.get(pb.chartID) ?? {};
    return { ...pb, chart: { ...chart, songTitle: chart.song?.title ?? '', artist: chart.song?.artist ?? '' } };
  });

  const best = bestPerChart(pbs);
  const toHard = best
    .filter(s => (LAMP_ORDER[lampCat(s.scoreData?.lamp)] ?? -1) < LAMP_ORDER.HARD)
    .sort((a, b) => getLevel(a.chart) - getLevel(b.chart));
  const toClear = best
    .filter(s => (LAMP_ORDER[lampCat(s.scoreData?.lamp)] ?? -1) < LAMP_ORDER.CLEAR)
    .sort((a, b) => getLevel(a.chart) - getLevel(b.chart));

  return { toHard, toClear };
});

// Returns { byLevel: { [lv]: { FC, EXHARD, HARD, CLEAR, EASY, ASSIST, FAILED } }, totals, total }
ipcMain.handle('get-stats', async (_e, userID) => {
  let data;
  try {
    data = await tachiGet(`/users/${userID}/games/bms-7k/pbs/all`);
  } catch (e) {
    if (e.response?.status === 404) return { byLevel: {}, totals: { FC: 0, EXHARD: 0, HARD: 0, CLEAR: 0, EASY: 0, ASSIST: 0, FAILED: 0 }, total: 0 };
    throw e;
  }
  const chartMap = new Map((data.charts ?? []).map(c => [c.chartID, c]));
  const pbs = (data.pbs ?? []).map(pb => {
    const chart = chartMap.get(pb.chartID) ?? {};
    return { ...pb, chart: { ...chart, songTitle: chart.song?.title ?? '', artist: chart.song?.artist ?? '' } };
  });

  const empty = () => ({ FC: 0, EXHARD: 0, HARD: 0, CLEAR: 0, EASY: 0, ASSIST: 0, FAILED: 0 });
  const byLevel = {};
  const totals = empty();

  for (const s of pbs) {
    const cat = lampCat(s.scoreData?.lamp);
    const lv = getLevel(s.chart);
    if (!byLevel[lv]) byLevel[lv] = empty();
    byLevel[lv][cat]++;
    totals[cat]++;
  }

  return { byLevel, totals, total: pbs.length };
});
