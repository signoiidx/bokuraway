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
  getStats(userID: number | string): Promise<StatsData>;
  getTableData(): Promise<Record<string, DiffTableEntry[]>>;
}

// e2e テスト専用フック。通常のアプリフローからは呼ばれない
interface TestAPI {
  setScores(data: TachiPB[]): void;
  setRecommendData(data: RecommendData): void;
  setActiveRecommendTab(tab: string): void;
  renderRecommendList(): void;
  setTableData(entries: DiffTableEntry[]): void;
  setActiveTableTab(tab: string): void;
  setScoreSearchQuery(q: string): void;
  setTableSearchQuery(q: string): void;
  renderTableView(): void;
  renderScoreList(): void;
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
let statsData: StatsData | null = null;
let activeRecommendTab: RecommendTab = 'nudges';
let activeScoreLamp = 'ALL';
let scoreSearchQuery = '';
let tableSearchQuery = '';

const LAMP_ORDER: Record<LampCategory, number> = {
  FAILED: 0, ASSIST: 1, EASY: 2, CLEAR: 3, HARD: 4, EXHARD: 5, FC: 6,
};

const el = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

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
  const status = el('auth-status');
  status.textContent = 'ブラウザを開いています…';
  const result = await window.tachi.startOAuth();
  if (!result.success) { status.textContent = 'エラー: ' + result.error; return; }
  status.textContent = 'ユーザー情報を取得中…';
  try {
    const me = await window.tachi.getMe();
    currentUser = me.user ?? me;
    el('user-chip').textContent = currentUser.username;
    el('auth-screen').style.display = 'none';
    el('main-screen').classList.add('active');
    Promise.all([loadRecommend(), loadStats(), loadScores()]);
    loadTableData();
  } catch {
    status.textContent = 'ユーザー情報の取得に失敗しました';
  }
});

// ── search ───────────────────────────────────────────────────────────────────
// 曲名・アーティスト名の部分一致 (大文字小文字無視)。query が空なら常に true
function matchesQuery(query: string, ...fields: (string | undefined)[]): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return fields.some(f => (f || '').toLowerCase().includes(q));
}

el<HTMLInputElement>('score-search').addEventListener('input', e => {
  scoreSearchQuery = (e.target as HTMLInputElement).value.trim();
  renderScoreList();
});

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
        <div class="score-title">${title}</div>
        ${artist ? `<div class="score-artist">${artist}</div>` : ''}
        <div class="score-meta">
          <span class="lv-badge">${lv}</span>
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
        <div class="score-title">${entry.title || '(no title)'}</div>
        <div class="score-meta"><span class="lv-badge">${entry.level}</span></div>
      </div>
      <div class="score-right"><span class="lamp-badge lamp-NOPLAY">NO PLAY</span></div>
    </div>`;
}

// ── recommend ────────────────────────────────────────────────────────────────
async function loadRecommend(): Promise<void> {
  const list    = el('recommend-list');
  const statsEl = el('recommend-stats');
  try {
    recommendData = await window.tachi.getRecommend(currentUser!.id ?? currentUser!.username);
    if (recommendData.noProfile) {
      statsEl.innerHTML = '';
      list.innerHTML = '<div class="status">Bokutachi に BMS 7K のプレイデータが見つかりません。スコアをインポートしてください。</div>';
      return;
    }
    statsEl.innerHTML = `
      <div class="stat-card">
        <div class="stat-label">あと一歩</div>
        <div class="stat-value c-accent">${(recommendData.nudges ?? []).length}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">HARD CLEAR 候補</div>
        <div class="stat-value c-hard">${recommendData.toHard.length}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">EASY CLEAR 候補</div>
        <div class="stat-value c-easy">${recommendData.toEasy.length}</div>
      </div>`;
    renderRecommendList();
  } catch (e) {
    list.innerHTML = `<div class="status">取得エラー: ${(e as Error).message}</div>`;
  }
}

function renderRecommendList(): void {
  if (!recommendData) return;
  const list   = el('recommend-list');
  const scores = recommendData[activeRecommendTab] ?? [];
  if (scores.length === 0) {
    const msg = activeRecommendTab === 'nudges'
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
async function loadStats(): Promise<void> {
  const wrap     = el('stats-table-wrap');
  const totalsEl = el('stats-totals');
  try {
    statsData = await window.tachi.getStats(currentUser!.id);
    const { totals, byLevel, total } = statsData;

    const hardPlus  = totals.HARD + totals.EXHARD + totals.FC;
    const clearPlus = totals.CLEAR + hardPlus;

    const cards: [string, number, string][] = [
      ['総譜面数',   total,                      ''],
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
      const row: Partial<Record<LampCategory, number>> = byLevel[lv] ?? {};
      const rowTotal = COLS.reduce((sum, c) => sum + (row[c] ?? 0), 0);
      return `<tr>
        <td>☆${lv}</td>
        ${COLS.map(c => {
          const n = row[c] ?? 0;
          return `<td class="${n > 0 ? 'cell-' + c.toLowerCase() : ''}">${n > 0 ? n : '–'}</td>`;
        }).join('')}
        <td>${rowTotal}</td>
      </tr>`;
    }).join('');

    wrap.innerHTML = `<table class="stats-table"><thead>${header}</thead><tbody>${rows}</tbody></table>`;
  } catch (e) {
    wrap.innerHTML = `<div class="status">取得エラー: ${(e as Error).message}</div>`;
  }
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
    if (el('page-tables').classList.contains('active')) renderTableView();
  } catch (e) {
    list.innerHTML = `<div class="status">取得エラー: ${(e as Error).message}</div>`;
  }
}

function renderScoreList(): void {
  if (!allScores) return;
  const list = el('score-list');
  const lampFiltered = activeScoreLamp === 'ALL'
    ? allScores
    : allScores.filter(s => lampCat(s.scoreData?.lamp) === activeScoreLamp);
  const filtered = lampFiltered.filter(s =>
    matchesQuery(scoreSearchQuery, s.chart?.songTitle, s.chart?.artist));

  if (filtered.length === 0) {
    list.innerHTML = '<div class="status">該当するスコアがありません</div>';
    return;
  }
  list.innerHTML = filtered.slice(0, 100).map((s, i) => scoreItemHTML(s, i + 1)).join('');
}

// ── difficulty tables ─────────────────────────────────────────────────────────
let activeTableTab = 'insane';
// md5 → DiffTableEntry[]  (1曲が複数テーブルに載ることがあるため配列)
let tableIndex = new Map<string, DiffTableEntry[]>();
let tableDataLoaded = false;

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
    renderTableView();
  } catch (e) {
    el('table-list').innerHTML = `<div class="status">難易度表の取得に失敗: ${(e as Error).message}</div>`;
  }
}

function renderTableView(): void {
  const listEl  = el('table-list');
  const statsEl = el('table-stats');

  if (!allScores || !tableDataLoaded) {
    listEl.innerHTML  = '<div class="status dot-loader">読み込み中</div>';
    statsEl.innerHTML = '';
    return;
  }

  // Match played scores against the active table.
  // 検索クエリはプレイ済み・未プレイの両方に適用する (レベルグルーピングは維持)
  const matchesSearch = (s: TachiPB) => matchesQuery(tableSearchQuery, s.chart?.songTitle, s.chart?.artist);
  const mapped = allScores.filter(matchesSearch).map(s => {
    const allEntries = tableIndex.get((s.chart?.data?.hashMD5 || '').toLowerCase()) ?? [];
    return { s, entry: allEntries.find(e => e.table === activeTableTab) ?? null };
  });
  type PlayedRow = { s: TachiPB; entry: DiffTableEntry };
  const tableScores     = mapped.filter((m): m is PlayedRow => m.entry !== null);
  const unmatchedScores = mapped.filter(({ entry }) => entry === null);

  // Find table entries that have no matching played score (未挑戦)
  const playedMD5s = new Set(
    allScores.map(s => (s.chart?.data?.hashMD5 || '').toLowerCase()).filter(Boolean)
  );
  const unplayedEntries: DiffTableEntry[] = [];
  for (const [md5, entries] of tableIndex) {
    const entry = entries.find(e => e.table === activeTableTab);
    if (entry && !playedMD5s.has(md5) && matchesQuery(tableSearchQuery, entry.title)) {
      unplayedEntries.push(entry);
    }
  }

  const counts: Record<LampCategory, number> = { FC: 0, EXHARD: 0, HARD: 0, CLEAR: 0, EASY: 0, ASSIST: 0, FAILED: 0 };
  for (const { s } of tableScores) counts[lampCat(s.scoreData?.lamp)]++;
  const hardPlus  = counts.HARD + counts.EXHARD + counts.FC;
  const clearPlus = counts.CLEAR + hardPlus;

  const statCards: [string, number, string][] = [
    ['テーブル総数', tableScores.length + unplayedEntries.length, ''],
    ['HARD以上',    hardPlus,                                     'c-hard'],
    ['CLEAR以上',   clearPlus,                                    'c-clear'],
    ['未挑戦',      unplayedEntries.length,                       ''],
  ];
  statsEl.innerHTML = statCards.map(([label, val, cls]) => `
    <div class="stat-card">
      <div class="stat-label">${label}</div>
      <div class="stat-value ${cls}">${val}</div>
    </div>`).join('');

  if (tableScores.length === 0 && unplayedEntries.length === 0) {
    listEl.innerHTML = tableSearchQuery
      ? '<div class="status">検索に一致する譜面がありません</div>'
      : '<div class="status">このテーブルのスコアがありません</div>';
    return;
  }

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

  const sortedSections = levels.map(lv => {
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
          <span>${symbol}${lv}</span>
          <div class="level-progress"><div class="level-progress-fill" style="width:${hardPct}%"></div></div>
          <span class="level-count">${played.length} / ${total}曲</span>
        </div>
        <div class="score-list">
          ${sortedPlayed.map(({ s, entry }, i) => scoreItemHTML(s, i + 1, entry.level)).join('')}
          ${unplayed.map((entry, i) => unchartedItemHTML(entry, played.length + i + 1)).join('')}
        </div>
      </div>`;
  });

  if (unmatchedScores.length > 0) {
    const sortedUnmatched = unmatchedScores.slice().sort((a, b) => {
      const la = LAMP_ORDER[lampCat(a.s.scoreData?.lamp)] ?? -1;
      const lb = LAMP_ORDER[lampCat(b.s.scoreData?.lamp)] ?? -1;
      return lb - la;
    });
    sortedSections.push(`
      <div class="level-section">
        <div class="level-header">
          <span>-</span>
          <span class="level-count">${sortedUnmatched.length}曲</span>
        </div>
        <div class="score-list">${sortedUnmatched.map(({ s }, i) => scoreItemHTML(s, i + 1, '-')).join('')}</div>
      </div>`);
  }

  listEl.innerHTML = sortedSections.join('');
}

document.querySelectorAll<HTMLElement>('#page-tables .tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#page-tables .tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    activeTableTab = btn.dataset.table!;
    renderTableView();
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
  setActiveTableTab: (tab) => { activeTableTab = tab; },
  setScoreSearchQuery: (q) => { scoreSearchQuery = q; },
  setTableSearchQuery: (q) => { tableSearchQuery = q; },
  renderTableView,
  renderScoreList,
};

})();
