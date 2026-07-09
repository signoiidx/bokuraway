// ─── Renderer ─────────────────────────────────────────────────────────────────
// index.html から <script src="dist/renderer.js"> で読み込まれるレンダラー本体。
// contextIsolation 下で動くため import/export を使わない非モジュールスクリプトとして
// 書かれており、tsc (module: commonjs) でもプレーンな JS として出力される。
// 共有型は src/types.ts のグローバル宣言を参照する。
// 実装は IIFE に包み、グローバルへは window.__test のみを公開する。

interface OAuthResult {
  success: boolean;
  error?: string;
}

interface TachiUser {
  id: number;
  username: string;
}

interface TachiAPI {
  startOAuth(): Promise<OAuthResult>;
  getMe(): Promise<{ user?: TachiUser } & TachiUser>;
  getScores(userID: number | string): Promise<TachiPB[]>;
  getRecommend(userID: number | string): Promise<RecommendData>;
  getTableData(): Promise<Record<string, DiffTableEntry[]>>;
  logout(): Promise<{ success: boolean }>;
  onPBsUpdated(cb: () => void): void;
}

// e2e テスト専用フック。通常のアプリフローからは呼ばれない
interface TestAPI {
  setScores(data: TachiPB[]): void;
  setRecommendData(data: RecommendData): void;
  setActiveRecommendTab(tab: string): void;
  renderRecommendList(): void;
  setTableData(entries: DiffTableEntry[]): void;
  setTableFilter(filter: Record<string, boolean>): void;
  setScoreSearchQuery(q: string): void;
  setTableSearchQuery(q: string): void;
  renderTableView(): void;
  renderScoreList(): void;
  renderStats(): void;
}

interface Window {
  tachi: TachiAPI;
  __test: TestAPI;
}

(() => {

type RecommendTab = 'nudges' | 'toHard' | 'toEasy';

let currentUser: TachiUser | null = null;
let recommendData: RecommendData | null = null;
let allScores: TachiPB[] | null = null;
let activeRecommendTab: RecommendTab = 'nudges';
let activeScoreLamp = 'ALL';
let scoreSearchQuery = '';
let tableSearchQuery = '';

const LAMP_ORDER: Record<LampCategory, number> = {
  FAILED: 0, ASSIST: 1, EASY: 2, CLEAR: 3, HARD: 4, EXHARD: 5, FC: 6,
};

const el = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

// ── security helpers ────────────────────────────────────────────────────────────
// Song/chart metadata (titles, artists, difficulty table labels) comes from external
// sources (Bokutachi API, third-party BMS difficulty tables) and is untrusted —
// escape before interpolating into innerHTML to avoid XSS.
const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(str: unknown): string {
  return String(str ?? '').replace(/[&<>"']/g, c => HTML_ESCAPES[c]);
}

function isAuthExpiredError(e: unknown): boolean {
  const message = (e as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message.includes('AUTH_EXPIRED');
}

async function handleAuthExpired(): Promise<void> {
  try { await window.tachi.logout(); } catch { /* best effort */ }
  resetToAuthScreen('セッションの有効期限が切れました。再度ログインしてください。');
}

function resetToAuthScreen(message: string): void {
  currentUser = null;
  recommendData = null;
  allScores = null;
  tableIndex = new Map();
  tableDataLoaded = false;
  el('user-chip').textContent = '';
  el('btn-logout').style.display = 'none';
  el('main-screen').classList.remove('active');
  el('auth-screen').style.display = '';
  el('auth-status').textContent = message || '';
}

// ── nav ──────────────────────────────────────────────────────────────────────
document.querySelectorAll<HTMLElement>('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    item.classList.add('active');
    el('page-' + item.dataset.page).classList.add('active');
    if (item.dataset.page === 'tables') renderTableView();
  });
});

// ── auth ─────────────────────────────────────────────────────────────────────
el('btn-login').addEventListener('click', async () => {
  const btn    = el<HTMLButtonElement>('btn-login');
  const status = el('auth-status');
  btn.disabled = true;
  status.textContent = 'ブラウザを開いています…';
  try {
    const result = await window.tachi.startOAuth();
    if (!result.success) { status.textContent = 'エラー: ' + result.error; return; }
    status.textContent = 'ユーザー情報を取得中…';
    const me = await window.tachi.getMe();
    currentUser = me.user ?? me;
    el('user-chip').textContent = currentUser.username;
    el('btn-logout').style.display = '';
    el('auth-screen').style.display = 'none';
    el('main-screen').classList.add('active');
    Promise.all([loadRecommend(), loadScores()]);
    loadTableData();
  } catch {
    status.textContent = 'ユーザー情報の取得に失敗しました';
  } finally {
    btn.disabled = false;
  }
});

el('btn-logout').addEventListener('click', async () => {
  try { await window.tachi.logout(); } catch { /* best effort */ }
  resetToAuthScreen('');
});

// キャッシュ起動後のバックグラウンド更新で差分が見つかったら各ページを再読込
window.tachi?.onPBsUpdated?.(() => {
  if (!currentUser) return;
  console.log('PBs updated in background — reloading pages');
  Promise.all([loadRecommend(), loadScores()]);
});

// ── search ───────────────────────────────────────────────────────────────────
// 曲名・アーティスト名の部分一致 (大文字小文字無視)。query が空なら常に true
function matchesQuery(query: string, ...fields: (string | undefined)[]): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return fields.some(f => (f || '').toLowerCase().includes(q));
}

el<HTMLInputElement>('table-search').addEventListener('input', e => {
  tableSearchQuery = (e.target as HTMLInputElement).value.trim();
  renderTableView();
});

// ── lamp helpers ──────────────────────────────────────────────────────────────
function lampCat(lamp: string | undefined | null): LampCategory {
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

const LAMP_LABEL: Record<LampCategory, string> = {
  FC: 'FULL COMBO', EXHARD: 'EX HARD', HARD: 'HARD', CLEAR: 'CLEAR', EASY: 'EASY', ASSIST: 'ASSIST', FAILED: 'FAILED',
};

function lampBadge(lamp: string | undefined): string {
  const cat = lampCat(lamp);
  const label = cat === 'FC'
    ? `<span class="rainbow-text">${LAMP_LABEL[cat]}</span>`
    : LAMP_LABEL[cat];
  return `<span class="lamp-badge lamp-${cat}">${label}</span>`;
}

function getLevel(chart: TachiPB['chart']): number {
  return chart?.levelNum ?? (parseFloat(chart?.level ?? '') || 0);
}

// 譜面が合致する全テーブルの難易度表記を返す。どこにも載っていなければ "-"
function getTableLabels(s: TachiPB): string {
  const md5 = (s.chart?.data?.hashMD5 || '').toLowerCase();
  if (!md5) return '-';
  const entries = tableIndex.get(md5);
  return entries && entries.length > 0 ? entries.map(e => e.level).join(' / ') : '-';
}

function scoreItemHTML(s: TachiPB, rank: number, lvLabel?: string): string {
  const lv = lvLabel !== undefined
    ? lvLabel
    : tableDataLoaded
      ? getTableLabels(s)
      : (s.chart?.data?.aiLevel ?? ('☆' + getLevel(s.chart)));
  const title  = s.chart?.songTitle || s.chartID;
  const artist = s.chart?.artist    || '';
  const bp     = s.scoreData?.optional?.bp;
  return `
    <div class="score-item">
      <div class="score-rank">${rank}</div>
      <div>
        <div class="score-title">${escapeHtml(title)}</div>
        ${artist ? `<div class="score-artist">${escapeHtml(artist)}</div>` : ''}
        <div class="score-meta">
          <span class="lv-badge">${escapeHtml(lv)}</span>
          ${bp != null ? `<span class="bp-badge">BP ${bp}</span>` : ''}
          ${s.nudge ? `<span class="nudge-badge">🔔 ${s.nudge.reason}</span>` : ''}
        </div>
      </div>
      <div class="score-right">${lampBadge(s.scoreData?.lamp)}</div>
    </div>`;
}

function unchartedItemHTML(entry: DiffTableEntry, rank: number): string {
  return `
    <div class="score-item uncharted">
      <div class="score-rank">${rank}</div>
      <div>
        <div class="score-title">${escapeHtml(entry.title || '(no title)')}</div>
        <div class="score-meta"><span class="lv-badge">${escapeHtml(entry.level)}</span></div>
      </div>
      <div class="score-right"><span class="lamp-badge lamp-NOPLAY">NO PLAY</span></div>
    </div>`;
}

// ── recommend ────────────────────────────────────────────────────────────────
async function loadRecommend(): Promise<void> {
  const list = el('recommend-list');
  try {
    recommendData = await window.tachi.getRecommend(currentUser!.id ?? currentUser!.username);
    if (recommendData.noProfile) {
      el('recommend-stats').innerHTML = '';
      list.innerHTML = '<div class="status">Bokutachi に BMS 7K のプレイデータが見つかりません。スコアをインポートしてください。</div>';
      return;
    }
    renderRecommendStats();
    renderRecommendList();
  } catch (e) {
    if (isAuthExpiredError(e)) { handleAuthExpired(); return; }
    list.innerHTML = `<div class="status">取得エラー: ${escapeHtml((e as Error).message)}</div>`;
  }
}

// 統計カードもテーブルフィルタ適用後の件数を表示する
function renderRecommendStats(): void {
  if (!recommendData || recommendData.noProfile) return;
  const count = (tab: RecommendTab) => (recommendData![tab] ?? []).filter(passesTableFilter).length;
  el('recommend-stats').innerHTML = `
    <div class="stat-card">
      <div class="stat-label">あと一歩</div>
      <div class="stat-value c-accent">${count('nudges')}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">HARD CLEAR 候補</div>
      <div class="stat-value c-hard">${count('toHard')}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">EASY CLEAR 候補</div>
      <div class="stat-value c-easy">${count('toEasy')}</div>
    </div>`;
}

function renderRecommendList(): void {
  if (!recommendData) return;
  const list   = el('recommend-list');
  const all    = recommendData[activeRecommendTab] ?? [];
  const scores = all.filter(passesTableFilter);
  if (scores.length === 0) {
    const msg = all.length > 0
      ? 'テーブルフィルタに一致する譜面がありません。'
      : activeRecommendTab === 'nudges'
        ? '「あと一歩」の譜面が見つかりません。BP率の低い譜面やグレード境界（A/AA/AAA）に近い譜面がここに表示されます。'
        : activeRecommendTab === 'toHard'
          ? 'HARD CLEAR候補がありません。EASY CLEAR数を増やしましょう！'
          : 'EASY CLEAR候補がありません。';
    list.innerHTML = `<div class="status">${msg}</div>`;
    return;
  }
  list.innerHTML = scores.map((s, i) => scoreItemHTML(s, i + 1)).join('');
}

document.querySelectorAll<HTMLElement>('#page-recommend .tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#page-recommend .tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    activeRecommendTab = btn.dataset.tab as RecommendTab;
    renderRecommendList();
  });
});

// ── stats ─────────────────────────────────────────────────────────────────────
// ランプ統計はテーブルフィルタを適用するため、レンダラー側で allScores から集計する
function renderStats(): void {
  if (!allScores) return;
  const wrap     = el('stats-table-wrap');
  const totalsEl = el('stats-totals');
  const scores   = allScores.filter(passesTableFilter);

  const emptyRow = (): Record<LampCategory, number> => ({ FC: 0, EXHARD: 0, HARD: 0, CLEAR: 0, EASY: 0, ASSIST: 0, FAILED: 0 });
  const byLevel: Record<number, Record<LampCategory, number>> = {};
  const totals = emptyRow();
  for (const s of scores) {
    const cat = lampCat(s.scoreData?.lamp);
    const lv  = getLevel(s.chart);
    if (!byLevel[lv]) byLevel[lv] = emptyRow();
    byLevel[lv][cat]++;
    totals[cat]++;
  }

  const hardPlus  = totals.HARD + totals.EXHARD + totals.FC;
  const clearPlus = totals.CLEAR + hardPlus;

  const cards: [string, number, string][] = [
    ['総譜面数',   scores.length,              ''],
    ['FC',         totals.FC + totals.EXHARD,  'c-fc'],
    ['HARD以上',   hardPlus,                   'c-hard'],
    ['CLEAR以上',  clearPlus,                  'c-clear'],
    ['EASY以上',   clearPlus + totals.EASY,    'c-easy'],
  ];
  totalsEl.innerHTML = cards.map(([label, val, cls]) => `
    <div class="stat-card">
      <div class="stat-label">${label}</div>
      <div class="stat-value ${cls}">${val}</div>
    </div>`).join('');

  const levels = Object.keys(byLevel)
    .map(Number).filter(n => !isNaN(n))
    .sort((a, b) => a - b);

  if (levels.length === 0) { wrap.innerHTML = '<div class="status">データがありません</div>'; return; }

  const COLS: LampCategory[] = ['FC', 'EXHARD', 'HARD', 'CLEAR', 'EASY', 'ASSIST', 'FAILED'];
  const HEAD_LABEL: Record<LampCategory, string> = { FC: 'FC', EXHARD: 'EX HARD', HARD: 'HARD', CLEAR: 'CLEAR', EASY: 'EASY', ASSIST: 'ASSIST', FAILED: 'FAILED' };

  const header = `<tr>
    <th>Level</th>
    ${COLS.map(c => `<th>${HEAD_LABEL[c]}</th>`).join('')}
    <th>Total</th>
  </tr>`;

  const rows = levels.map(lv => {
    const row = byLevel[lv];
    const rowTotal = COLS.reduce((sum, c) => sum + row[c], 0);
    return `<tr>
      <td>☆${lv}</td>
      ${COLS.map(c => {
        const n = row[c];
        return `<td class="${n > 0 ? 'cell-' + c.toLowerCase() : ''}">${n > 0 ? n : '–'}</td>`;
      }).join('')}
      <td>${rowTotal}</td>
    </tr>`;
  }).join('');

  wrap.innerHTML = `<table class="stats-table"><thead>${header}</thead><tbody>${rows}</tbody></table>`;
}

// ── scores ────────────────────────────────────────────────────────────────────
async function loadScores(): Promise<void> {
  const list      = el('score-list');
  const filterBar = el('score-filter-bar');
  try {
    const raw = await window.tachi.getScores(currentUser!.id);

    // best lamp per chart
    const best = new Map<string, TachiPB>();
    for (const s of raw) {
      if (!s.chartID) continue;
      const prev  = best.get(s.chartID);
      const curr  = LAMP_ORDER[lampCat(s.scoreData?.lamp)] ?? -1;
      const prev_ = prev ? (LAMP_ORDER[lampCat(prev.scoreData?.lamp)] ?? -1) : -1;
      if (!prev || curr > prev_) best.set(s.chartID, s);
    }

    allScores = [...best.values()].sort((a, b) => {
      const la = LAMP_ORDER[lampCat(a.scoreData?.lamp)] ?? -1;
      const lb = LAMP_ORDER[lampCat(b.scoreData?.lamp)] ?? -1;
      return lb - la || getLevel(b.chart) - getLevel(a.chart);
    });

    const FILTERS = ['ALL', 'FC', 'EXHARD', 'HARD', 'CLEAR', 'EASY', 'ASSIST', 'FAILED'];
    const FILTER_LABEL: Record<string, string> = { ALL: 'すべて', FC: 'FC', EXHARD: 'EX HARD', HARD: 'HARD', CLEAR: 'CLEAR', EASY: 'EASY', ASSIST: 'ASSIST', FAILED: 'FAILED' };

    filterBar.innerHTML = FILTERS.map(f => `
      <button class="filter-btn${f === 'ALL' ? ' active' : ''}" data-lamp="${f}">
        ${FILTER_LABEL[f]}
      </button>`).join('');

    filterBar.querySelectorAll<HTMLElement>('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        filterBar.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeScoreLamp = btn.dataset.lamp!;
        renderScoreList();
      });
    });

    renderScoreList();
    renderStats();
    if (el('page-tables').classList.contains('active')) renderTableView();
  } catch (e) {
    if (isAuthExpiredError(e)) { handleAuthExpired(); return; }
    const msg = `<div class="status">取得エラー: ${escapeHtml((e as Error).message)}</div>`;
    list.innerHTML = msg;
    el('stats-table-wrap').innerHTML = msg; // 統計ページも同じデータ源なのでエラーを表示
  }
}

el<HTMLInputElement>('score-search').addEventListener('input', e => {
  scoreSearchQuery = (e.target as HTMLInputElement).value.trim().toLowerCase();
  renderScoreList();
});

function renderScoreList(): void {
  if (!allScores) return;
  const list = el('score-list');
  let filtered = allScores.filter(passesTableFilter);
  if (activeScoreLamp !== 'ALL') {
    filtered = filtered.filter(s => lampCat(s.scoreData?.lamp) === activeScoreLamp);
  }

  if (scoreSearchQuery) {
    filtered = filtered.filter(s => {
      const title  = (s.chart?.songTitle || '').toLowerCase();
      const artist = (s.chart?.artist    || '').toLowerCase();
      return title.includes(scoreSearchQuery) || artist.includes(scoreSearchQuery);
    });
  }

  if (filtered.length === 0) {
    list.innerHTML = '<div class="status">該当するスコアがありません</div>';
    return;
  }
  list.innerHTML = filtered.slice(0, 100).map((s, i) => scoreItemHTML(s, i + 1)).join('');
}

// ── difficulty tables ─────────────────────────────────────────────────────────
const TABLE_ORDER = ['insane', 'satellite', 'stella', 'overjoy'] as const;
const TABLE_LABEL: Record<string, string> = {
  insane: '発狂難易度', satellite: 'Satellite', stella: 'Stella', overjoy: 'Overjoy',
};
// 表示フィルタ。キーは各テーブルID + 'outside' (どの表にも載っていない譜面 = 表外)。
// 全ページ共通の状態で、各ページの .table-filter-bar チェックボックスと同期する
const tableFilter: Record<string, boolean> = {
  insane: true, satellite: true, stella: true, overjoy: true, outside: false,
};
// md5 → DiffTableEntry[]  (1曲が複数テーブルに載ることがあるため配列)
let tableIndex = new Map<string, DiffTableEntry[]>();
let tableDataLoaded = false;

// 譜面がテーブルフィルタを通過するか。難易度表データ取得前はフィルタしない
function passesTableFilter(s: TachiPB): boolean {
  if (!tableDataLoaded) return true;
  const md5 = (s.chart?.data?.hashMD5 || '').toLowerCase();
  const entries = md5 ? tableIndex.get(md5) : undefined;
  if (!entries || entries.length === 0) return !!tableFilter.outside;
  return entries.some(e => tableFilter[e.table]);
}

// テーブルフィルタの影響を受ける全ページを再描画する
function rerenderFilteredViews(): void {
  renderRecommendStats();
  renderRecommendList();
  renderStats();
  renderScoreList();
  renderTableView();
}

async function loadTableData(): Promise<void> {
  el('table-list').innerHTML = '<div class="status dot-loader">難易度表を取得中</div>';
  try {
    const data = await window.tachi.getTableData();
    tableIndex = new Map();
    for (const entries of Object.values(data)) {
      for (const entry of entries) {
        if (!entry.md5) continue;
        const key = entry.md5.toLowerCase();
        if (!tableIndex.has(key)) tableIndex.set(key, []);
        tableIndex.get(key)!.push(entry);
      }
    }
    console.log('Table index:', tableIndex.size, 'charts');
    tableDataLoaded = true;
    // フィルタが効き始め、lv バッジも難易度表表記に変わるため全ページ再描画
    rerenderFilteredViews();
  } catch (e) {
    if (isAuthExpiredError(e)) { handleAuthExpired(); return; }
    el('table-list').innerHTML = `<div class="status">難易度表の取得に失敗: ${escapeHtml((e as Error).message)}</div>`;
  }
}

type PlayedRow = { s: TachiPB; entry: DiffTableEntry };

// 1テーブル分 (見出し + レベル別セクション群) の HTML を組み立てる
function tableSectionsHTML(table: string, tableScores: PlayedRow[], unplayedEntries: DiffTableEntry[]): string {
  // Group played and unplayed by level
  const byLevel: Record<number, { played: PlayedRow[]; unplayed: DiffTableEntry[] }> = {};
  for (const row of tableScores) {
    const lv = row.entry.levelNum;
    if (!byLevel[lv]) byLevel[lv] = { played: [], unplayed: [] };
    byLevel[lv].played.push(row);
  }
  for (const entry of unplayedEntries) {
    const lv = entry.levelNum;
    if (!byLevel[lv]) byLevel[lv] = { played: [], unplayed: [] };
    byLevel[lv].unplayed.push(entry);
  }

  const levels = Object.keys(byLevel).map(Number).sort((a, b) => a - b);

  const sections = levels.map(lv => {
    const { played, unplayed } = byLevel[lv];
    const total     = played.length + unplayed.length;
    const hardCount = played.filter(({ s }) => ['HARD', 'EXHARD', 'FC'].includes(lampCat(s.scoreData?.lamp))).length;
    const hardPct   = total > 0 ? Math.round(hardCount / total * 100) : 0;
    const symbol    = (played[0]?.entry ?? unplayed[0])?.level.replace(/\d+$/, '') ?? '';

    const sortedPlayed = played.slice().sort((a, b) => {
      const la = LAMP_ORDER[lampCat(a.s.scoreData?.lamp)] ?? -1;
      const lb = LAMP_ORDER[lampCat(b.s.scoreData?.lamp)] ?? -1;
      return lb - la;
    });

    return `
      <div class="level-section">
        <div class="level-header">
          <span>${escapeHtml(symbol)}${lv}</span>
          <div class="level-progress"><div class="level-progress-fill" style="width:${hardPct}%"></div></div>
          <span class="level-count">${played.length} / ${total}曲</span>
        </div>
        <div class="score-list">
          ${sortedPlayed.map(({ s, entry }, i) => scoreItemHTML(s, i + 1, entry.level)).join('')}
          ${unplayed.map((entry, i) => unchartedItemHTML(entry, played.length + i + 1)).join('')}
        </div>
      </div>`;
  });

  return `
    <div class="table-section">
      <div class="table-section-title">${escapeHtml(TABLE_LABEL[table] ?? table)}</div>
      ${sections.join('')}
    </div>`;
}

function renderTableView(): void {
  const listEl  = el('table-list');
  const statsEl = el('table-stats');

  if (!allScores || !tableDataLoaded) {
    listEl.innerHTML  = '<div class="status dot-loader">読み込み中</div>';
    statsEl.innerHTML = '';
    return;
  }

  // 検索クエリはプレイ済み・未プレイの両方に適用する (レベルグルーピングは維持)
  const matchesSearch = (s: TachiPB) => matchesQuery(tableSearchQuery, s.chart?.songTitle, s.chart?.artist);
  const searchedScores = allScores.filter(matchesSearch);
  const playedMD5s = new Set(
    allScores.map(s => (s.chart?.data?.hashMD5 || '').toLowerCase()).filter(Boolean)
  );

  // 統計はチェック中のテーブル全体で譜面 (md5) 単位にユニーク化して数える
  // (1曲が複数テーブルに載っていても1回だけカウント)
  const statPlayed   = new Map<string, TachiPB>();
  const statUnplayed = new Set<string>();
  const sections: string[] = [];

  for (const table of TABLE_ORDER) {
    if (!tableFilter[table]) continue;

    const tableScores: PlayedRow[] = [];
    for (const s of searchedScores) {
      const md5 = (s.chart?.data?.hashMD5 || '').toLowerCase();
      const entry = (tableIndex.get(md5) ?? []).find(e => e.table === table);
      if (entry) {
        tableScores.push({ s, entry });
        statPlayed.set(md5, s);
      }
    }

    // Find table entries that have no matching played score (未挑戦)
    const unplayedEntries: DiffTableEntry[] = [];
    for (const [md5, entries] of tableIndex) {
      const entry = entries.find(e => e.table === table);
      if (entry && !playedMD5s.has(md5) && matchesQuery(tableSearchQuery, entry.title)) {
        unplayedEntries.push(entry);
        statUnplayed.add(md5);
      }
    }

    if (tableScores.length === 0 && unplayedEntries.length === 0) continue;
    sections.push(tableSectionsHTML(table, tableScores, unplayedEntries));
  }

  // 表外: どのテーブルにも載っていない譜面 (チェック時のみ表示)
  if (tableFilter.outside) {
    const outsideScores = searchedScores.filter(s => {
      const md5 = (s.chart?.data?.hashMD5 || '').toLowerCase();
      return !md5 || !tableIndex.has(md5);
    });
    if (outsideScores.length > 0) {
      const sorted = outsideScores.slice().sort((a, b) => {
        const la = LAMP_ORDER[lampCat(a.scoreData?.lamp)] ?? -1;
        const lb = LAMP_ORDER[lampCat(b.scoreData?.lamp)] ?? -1;
        return lb - la;
      });
      sections.push(`
        <div class="table-section">
          <div class="table-section-title">表外</div>
          <div class="level-section">
            <div class="level-header">
              <span>-</span>
              <span class="level-count">${sorted.length}曲</span>
            </div>
            <div class="score-list">${sorted.map((s, i) => scoreItemHTML(s, i + 1, '-')).join('')}</div>
          </div>
        </div>`);
    }
  }

  const counts: Record<LampCategory, number> = { FC: 0, EXHARD: 0, HARD: 0, CLEAR: 0, EASY: 0, ASSIST: 0, FAILED: 0 };
  for (const s of statPlayed.values()) counts[lampCat(s.scoreData?.lamp)]++;
  const hardPlus  = counts.HARD + counts.EXHARD + counts.FC;
  const clearPlus = counts.CLEAR + hardPlus;

  const statCards: [string, number, string][] = [
    ['テーブル総数', statPlayed.size + statUnplayed.size, ''],
    ['HARD以上',    hardPlus,                             'c-hard'],
    ['CLEAR以上',   clearPlus,                            'c-clear'],
    ['未挑戦',      statUnplayed.size,                    ''],
  ];
  statsEl.innerHTML = statCards.map(([label, val, cls]) => `
    <div class="stat-card">
      <div class="stat-label">${label}</div>
      <div class="stat-value ${cls}">${val}</div>
    </div>`).join('');

  if (sections.length === 0) {
    listEl.innerHTML = tableSearchQuery
      ? '<div class="status">検索に一致する譜面がありません</div>'
      : '<div class="status">表示できる譜面がありません。フィルタを確認してください。</div>';
    return;
  }

  listEl.innerHTML = sections.join('');
}

// ── table filter bars ─────────────────────────────────────────────────────────
// 各ページの .table-filter-bar にチェックボックスを生成する。状態は tableFilter で共有し、
// どのページで変更しても全バーを同期して全ページを再描画する
const FILTER_KEYS = [...TABLE_ORDER, 'outside'];
const FILTER_CHIP_LABEL: Record<string, string> = { ...TABLE_LABEL, outside: '表外' };

function syncTableFilterBars(): void {
  document.querySelectorAll<HTMLInputElement>('.table-filter-bar input[type="checkbox"]').forEach(cb => {
    cb.checked = !!tableFilter[cb.dataset.table!];
  });
}

document.querySelectorAll<HTMLElement>('.table-filter-bar').forEach(bar => {
  bar.innerHTML = FILTER_KEYS.map(key =>
    `<label class="check-chip"><input type="checkbox" data-table="${key}"${tableFilter[key] ? ' checked' : ''}>${FILTER_CHIP_LABEL[key]}</label>`
  ).join('');
  bar.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      tableFilter[cb.dataset.table!] = cb.checked;
      syncTableFilterBars();
      rerenderFilteredViews();
    });
  });
});

// Test interface — only used by e2e tests, not reachable from normal app flow
window.__test = {
  setScores: (data) => { allScores = data; },
  setRecommendData: (data) => { recommendData = data; },
  setActiveRecommendTab: (tab) => { activeRecommendTab = tab as RecommendTab; },
  renderRecommendList,
  setTableData: (entries) => {
    tableIndex = new Map();
    for (const e of entries) {
      const key = e.md5.toLowerCase();
      if (!tableIndex.has(key)) tableIndex.set(key, []);
      tableIndex.get(key)!.push(e);
    }
    tableDataLoaded = true;
  },
  setTableFilter: (filter) => {
    Object.assign(tableFilter, filter);
    // 全ページのチェックボックス表示も内部状態に同期させる
    syncTableFilterBars();
  },
  setScoreSearchQuery: (q) => { scoreSearchQuery = q; },
  setTableSearchQuery: (q) => { tableSearchQuery = q; },
  renderTableView,
  renderScoreList,
  renderStats,
};

})();
