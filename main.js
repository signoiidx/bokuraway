require('dotenv').config();
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

// ─── OAuth ───────────────────────────────────────────────────────────────────

function startCallbackServer() {
  return new Promise((resolve, reject) => {
    callbackServer = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost:8080');
      if (url.pathname !== '/callback') return;

      const code = url.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body style="background:#0f0f14;color:#e0e0e0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><p>認証完了しました。このタブを閉じてください。</p></body></html>');
      callbackServer.close();
      resolve(code);
    });

    callbackServer.listen(8080, () => resolve(null));
    callbackServer.on('error', reject);
  });
}

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
    callbackServer.listen(8080, () => {});
    callbackServer.on('error', reject);
  });

  const oauthUrl = `https://boku.tachi.ac/oauth/request-auth?clientID=${CLIENT_ID}`;
  shell.openExternal(oauthUrl);

  const code = await serverReady;
  if (!code) return { success: false, error: 'No code received' };

  try {
    const res = await axios.post(`${TACHI_BASE}/oauth/token`, {
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
    });
    accessToken = res.data.body.token;
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ─── API ──────────────────────────────────────────────────────────────────────

async function tachiGet(path) {
  const res = await axios.get(`${TACHI_BASE}${path}`, {
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
  });
  return res.data.body;
}

ipcMain.handle('get-me', async () => {
  return await tachiGet('/users/me');
});

ipcMain.handle('get-scores', async (_e, userID) => {
  return await tachiGet(`/users/${userID}/games/bms/7K/scores`);
});

ipcMain.handle('get-recommend', async (_e, userID) => {
  // スコア一覧を取得してレコメンドロジックを適用
  const data = await tachiGet(`/users/${userID}/games/bms/7K/scores`);
  const scores = data.scores ?? [];

  // lamp でグループ化
  const lampOrder = { FAILED: 0, EASY: 1, CLEAR: 2, HARD: 3, 'FULL COMBO': 4 };

  // CLEAR済みでHARD CLEAR未達の曲を抽出、難易度でソート
  const cleared = new Map();
  const hardCleared = new Set();

  for (const s of scores) {
    const lamp = s.scoreData?.lamp;
    const chartID = s.chartID;
    if (!chartID) continue;
    if (lamp === 'HARD' || lamp === 'FULL COMBO') hardCleared.add(chartID);
    if ((lampOrder[lamp] ?? -1) >= lampOrder['CLEAR']) {
      if (!cleared.has(chartID)) cleared.set(chartID, s);
    }
  }

  const candidates = [...cleared.entries()]
    .filter(([id]) => !hardCleared.has(id))
    .map(([, s]) => s)
    .sort((a, b) => (a.chart?.level ?? 0) - (b.chart?.level ?? 0));

  return candidates.slice(0, 30);
});
