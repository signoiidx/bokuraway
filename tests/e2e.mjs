import { _electron as electron } from 'playwright-core';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as fs from 'node:fs';

const APP_DIR  = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const SHOT_DIR = path.join(APP_DIR, 'tests', 'shots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

function electronBin() {
  const base = path.join(APP_DIR, 'node_modules', 'electron', 'dist');
  if (process.platform === 'darwin') return path.join(base, 'Electron.app', 'Contents', 'MacOS', 'Electron');
  if (process.platform === 'win32') return path.join(base, 'electron.exe');
  return path.join(base, 'electron');
}

async function getPage(app) {
  return app.windows().find(w => !w.url().startsWith('devtools://'))
      ?? await app.firstWindow();
}

// ── mock data ─────────────────────────────────────────────────────────────────

const MD5 = {
  insane11:  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01',
  insane12:  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa02',
  insane13:  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa03', // unplayed — only in table, no score
  sat5:      'cccccccccccccccccccccccccccccc01', // satellite table
  none:      'ffff0000ffff0000ffff0000ffff0001', // 表外 — in no table
};

const MOCK_SCORES = [
  { chartID: 'c1', scoreData: { lamp: 'HARD CLEAR', optional: { bp: 42 } }, chart: { levelNum: 11, difficulty: 'CHART', songTitle: '発狂曲A', artist: 'ArtistA', data: { hashMD5: MD5.insane11 } } },
  { chartID: 'c2', scoreData: { lamp: 'CLEAR' },                            chart: { levelNum: 12, difficulty: 'CHART', songTitle: '発狂曲B', artist: 'ArtistB', data: { hashMD5: MD5.insane12 } } },
  { chartID: 'c3', scoreData: { lamp: 'FAILED' },                           chart: { levelNum: 5,  difficulty: 'CHART', songTitle: '未登録曲', artist: 'ArtistC', data: { hashMD5: MD5.none     } } },
  { chartID: 'c4', scoreData: { lamp: 'EASY CLEAR' },                       chart: { levelNum: 5,  difficulty: 'CHART', songTitle: 'サテ曲C', artist: 'ArtistD', data: { hashMD5: MD5.sat5     } } },
];

const MOCK_RECOMMEND = {
  nudges: [
    {
      chartID: 'c1',
      nudge: { goal: 'HARD CLEAR', reason: 'HARD CLEARが狙えるBP率 1.0%', closeness: 0.71 },
      scoreData: { lamp: 'CLEAR', optional: { bp: 10 } },
      chart: { levelNum: 11, difficulty: 'CHART', songTitle: '発狂曲A', artist: 'ArtistA', data: { hashMD5: MD5.insane11 } },
    },
    {
      chartID: 'c2',
      nudge: { goal: 'AAA', reason: 'AAAまであと0.39%', closeness: 0.61 },
      scoreData: { lamp: 'HARD CLEAR', percent: 88.5, optional: { bp: 31 } },
      chart: { levelNum: 12, difficulty: 'CHART', songTitle: '発狂曲B', artist: 'ArtistB', data: { hashMD5: MD5.insane12 } },
    },
  ],
  toHard: [],
  toEasy: [],
};

// MD5.insane13 is in the table but has no matching score → should appear as NO PLAY
const MOCK_TABLE_ENTRIES = [
  { md5: MD5.insane11, title: '発狂曲A',  level: '★11', levelNum: 11, table: 'insane' },
  { md5: MD5.insane12, title: '発狂曲B',  level: '★12', levelNum: 12, table: 'insane' },
  { md5: MD5.insane13, title: '未挑戦曲', level: '★13', levelNum: 13, table: 'insane' },
  { md5: MD5.sat5,     title: 'サテ曲C',  level: 'sl5', levelNum: 5,  table: 'satellite' },
];

// チェックボックスの初期状態と同じフィルタ (各テーブルON・表外OFF)
const DEFAULT_FILTER = { insane: true, satellite: true, stella: true, overjoy: true, outside: false };

// ── helpers ───────────────────────────────────────────────────────────────────

async function injectMockAndRender(page, filter = DEFAULT_FILTER) {
  await page.evaluate(({ scores, entries, filter }) => {
    window.__test.setScores(scores);
    window.__test.setTableData(entries);
    window.__test.setTableFilter(filter);
    document.getElementById('auth-screen').style.display = 'none';
    document.getElementById('main-screen').classList.add('active');
    const navTable = [...document.querySelectorAll('.nav-item')].find(el => el.dataset.page === 'tables');
    if (navTable) {
      document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
      navTable.classList.add('active');
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      document.getElementById('page-tables').classList.add('active');
    }
    window.__test.renderTableView();
  }, { scores: MOCK_SCORES, entries: MOCK_TABLE_ENTRIES, filter });
  await page.waitForTimeout(200);
}

// ── test suite ────────────────────────────────────────────────────────────────

describe('bokuraway e2e', async () => {
  let app, page;

  before(async () => {
    const sandboxArgs = process.env.CI ? ['--no-sandbox', '--disable-setuid-sandbox'] : [];
    app = await electron.launch({
      executablePath: electronBin(),
      args: [APP_DIR, ...sandboxArgs],
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
      timeout: 30_000,
    });
    await new Promise(r => setTimeout(r, 3_000));
    page = await getPage(app);
  });

  after(async () => {
    await app?.close();
  });

  // ── launch ──────────────────────────────────────────────────────────────────

  describe('launch', () => {
    it('shows auth screen on launch', async () => {
      const visible = await page.evaluate(() =>
        document.getElementById('auth-screen')?.style.display !== 'none'
      );
      assert.ok(visible, 'auth-screen should be visible');
      await page.screenshot({ path: path.join(SHOT_DIR, '01-auth.png') });
    });

    it('has a login button', async () => {
      const exists = await page.$('#btn-login');
      assert.ok(exists, '#btn-login should exist');
    });
  });

  // ── DOM structure ────────────────────────────────────────────────────────────

  describe('DOM structure', () => {
    it('has nav items: recommend, scores, tables', async () => {
      const pages = await page.evaluate(() =>
        [...document.querySelectorAll('.nav-item')].map(el => el.dataset.page)
      );
      assert.ok(pages.includes('recommend'), 'nav should include recommend');
      assert.ok(pages.includes('scores'),    'nav should include scores');
      assert.ok(pages.includes('tables'),    'nav should include tables');
    });

    it('has table filter checkboxes: insane, satellite, stella, overjoy, outside', async () => {
      const boxes = await page.evaluate(() =>
        [...document.querySelectorAll('#table-filter-bar input[type="checkbox"]')].map(cb => cb.dataset.table)
      );
      for (const expected of ['insane', 'satellite', 'stella', 'overjoy', 'outside']) {
        assert.ok(boxes.includes(expected), `table filter checkbox "${expected}" should exist`);
      }
    });

    it('table checkboxes default to checked, 表外 defaults to unchecked', async () => {
      const state = await page.evaluate(() =>
        Object.fromEntries(
          [...document.querySelectorAll('#table-filter-bar input[type="checkbox"]')].map(cb => [cb.dataset.table, cb.checked])
        )
      );
      for (const table of ['insane', 'satellite', 'stella', 'overjoy']) {
        assert.equal(state[table], true, `"${table}" should be checked by default`);
      }
      assert.equal(state.outside, false, '"outside" (表外) should be unchecked by default');
    });
  });

  // ── table view ───────────────────────────────────────────────────────────────

  describe('table view (insane only)', () => {
    before(() => injectMockAndRender(page, { insane: true, satellite: false, stella: false, overjoy: false, outside: false }));

    it('renders level sections for matched charts', async () => {
      const headers = await page.evaluate(() =>
        [...document.querySelectorAll('#page-tables .level-header span:first-child')]
          .map(el => el.textContent.trim())
      );
      assert.ok(headers.includes('★11'), 'should have ★11 section');
      assert.ok(headers.includes('★12'), 'should have ★12 section');
      await page.screenshot({ path: path.join(SHOT_DIR, '02-tables-insane.png') });
    });

    it('renders table section title for the checked table', async () => {
      const titles = await page.evaluate(() =>
        [...document.querySelectorAll('#table-list .table-section-title')].map(el => el.textContent.trim())
      );
      assert.deepEqual(titles, ['発狂難易度'], 'only the 発狂難易度 section title should be rendered');
    });

    it('charts in unchecked tables are hidden', async () => {
      const text = await page.evaluate(() => document.getElementById('table-list')?.innerText ?? '');
      assert.ok(!text.includes('サテ曲C'), 'satellite chart should be hidden when satellite is unchecked');
    });

    it('表外 charts are hidden while 表外 is unchecked', async () => {
      const text = await page.evaluate(() => document.getElementById('table-list')?.innerText ?? '');
      assert.ok(!text.includes('未登録曲'), 'chart in no table should be hidden by default');
    });

    it('stat テーブル総数 reflects played + unplayed', async () => {
      const totalCard = await page.evaluate(() => {
        const cards = [...document.querySelectorAll('#table-stats .stat-card')];
        const total = cards.find(c => c.querySelector('.stat-label')?.textContent.trim() === 'テーブル総数');
        return total?.querySelector('.stat-value')?.textContent.trim();
      });
      // 2 played + 1 unplayed = 3
      assert.equal(totalCard, '3', 'テーブル総数 should be 3 (2 played + 1 unplayed)');
    });

    it('stat 未挑戦 reflects unplayed entries', async () => {
      const card = await page.evaluate(() => {
        const cards = [...document.querySelectorAll('#table-stats .stat-card')];
        return cards
          .find(c => c.querySelector('.stat-label')?.textContent.trim() === '未挑戦')
          ?.querySelector('.stat-value')?.textContent.trim();
      });
      assert.equal(card, '1', '未挑戦 should be 1');
    });
  });

  // ── unplayed charts ──────────────────────────────────────────────────────────

  describe('unplayed charts', () => {
    it('renders NO PLAY badge for unplayed chart', async () => {
      const found = await page.evaluate(() => !!document.querySelector('.lamp-NOPLAY'));
      assert.ok(found, '.lamp-NOPLAY badge should exist for unplayed chart');
    });

    it('unplayed chart title appears in its level section', async () => {
      const content = await page.evaluate(() =>
        document.getElementById('table-list')?.innerText ?? ''
      );
      assert.ok(content.includes('未挑戦曲'), 'unplayed chart title should be rendered');
    });

    it('unplayed chart has .uncharted class', async () => {
      const found = await page.evaluate(() => !!document.querySelector('.score-item.uncharted'));
      assert.ok(found, '.score-item.uncharted should exist');
    });
  });

  // ── level progress ───────────────────────────────────────────────────────────

  describe('level progress', () => {
    it('renders progress bars in level headers', async () => {
      const count = await page.evaluate(() =>
        document.querySelectorAll('#page-tables .level-progress').length
      );
      assert.ok(count > 0, 'level progress bars should be rendered');
    });

    it('level count shows played / total 曲 format', async () => {
      const counts = await page.evaluate(() =>
        [...document.querySelectorAll('#page-tables .level-count')].map(el => el.textContent.trim())
      );
      assert.ok(counts.some(c => c.includes('/')), 'level count should show played / total format');
    });
  });

  // ── lamp badges ──────────────────────────────────────────────────────────────

  describe('lamp badges', () => {
    // FAILED ランプは表外の未登録曲にしか付いていないため 表外 を表示して確認する
    before(() => injectMockAndRender(page, { ...DEFAULT_FILTER, outside: true }));

    it('HARD CLEAR renders .lamp-HARD badge', async () => {
      const found = await page.evaluate(() => !!document.querySelector('.lamp-HARD'));
      assert.ok(found, '.lamp-HARD badge should be in the DOM');
    });

    it('FAILED renders .lamp-FAILED badge', async () => {
      const found = await page.evaluate(() => !!document.querySelector('.lamp-FAILED'));
      assert.ok(found, '.lamp-FAILED badge should be in the DOM');
    });
  });

  // ── BP display ───────────────────────────────────────────────────────────────

  describe('BP display', () => {
    it('shows BP badge when scoreData.optional.bp is set', async () => {
      const text = await page.evaluate(() =>
        [...document.querySelectorAll('.bp-badge')].map(el => el.textContent.trim()).join(' ')
      );
      assert.ok(text.includes('42'), 'BP 42 should be shown in a .bp-badge');
    });
  });

  // ── XSS protection ───────────────────────────────────────────────────────────

  describe('XSS protection', () => {
    it('escapes HTML in untrusted song title/artist instead of executing it', async () => {
      const malicious = {
        chartID: 'xss1',
        scoreData: { lamp: 'CLEAR' },
        chart: {
          levelNum: 1,
          difficulty: 'CHART',
          songTitle: '<img src=x onerror="window.__xssFired = true">',
          artist: '<b>evil</b>',
          data: { hashMD5: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb99' },
        },
      };
      // この譜面はどのテーブルにも載っていないため、表外を ON にして表示させる
      await page.evaluate(({ score, filter }) => {
        window.__xssFired = false;
        window.__test.setScores([score]);
        window.__test.setTableFilter(filter);
        window.__test.renderScoreList();
      }, { score: malicious, filter: { ...DEFAULT_FILTER, outside: true } });
      await page.waitForTimeout(150);

      const fired = await page.evaluate(() => window.__xssFired);
      assert.equal(fired, false, 'injected onerror handler must not execute');

      const html = await page.evaluate(() => document.getElementById('score-list').innerHTML);
      assert.ok(html.includes('&lt;img'), 'title should be rendered as escaped text, not a live <img> tag');
      assert.ok(html.includes('&lt;b&gt;evil&lt;/b&gt;'), 'artist should be escaped too');
    });
  });

  // ── score search ─────────────────────────────────────────────────────────────

  describe('score search', () => {
    before(async () => {
      await page.evaluate(({ scores, filter }) => {
        window.__test.setScores(scores);
        window.__test.setTableFilter(filter);
        document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        const navScores = [...document.querySelectorAll('.nav-item')].find(el => el.dataset.page === 'scores');
        navScores.classList.add('active');
        document.getElementById('page-scores').classList.add('active');
        window.__test.renderScoreList();
      }, { scores: MOCK_SCORES, filter: DEFAULT_FILTER });
    });

    it('filters the score list by title/artist substring', async () => {
      await page.fill('#score-search', 'ArtistB');
      await page.waitForTimeout(150);
      const text = await page.evaluate(() => document.getElementById('score-list').innerText);
      assert.ok(text.includes('発狂曲B'), 'matching title should remain visible');
      assert.ok(!text.includes('発狂曲A'), 'non-matching title should be filtered out');
    });

    it('clearing the search box restores the full list', async () => {
      await page.fill('#score-search', '');
      await page.waitForTimeout(150);
      const text = await page.evaluate(() => document.getElementById('score-list').innerText);
      assert.ok(text.includes('発狂曲A'), 'all scores should reappear once search is cleared');
      assert.ok(text.includes('発狂曲B'), 'all scores should reappear once search is cleared');
    });
  });

  // ── recommend nudge ──────────────────────────────────────────────────────────

  describe('recommend nudge', () => {
    before(async () => {
      await page.evaluate((recommend) => {
        window.__test.setRecommendData(recommend);
        window.__test.setActiveRecommendTab('nudges');
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        document.getElementById('page-recommend').classList.add('active');
        window.__test.renderRecommendList();
      }, MOCK_RECOMMEND);
      await page.waitForTimeout(100);
    });

    it('has あと一歩 tab on the recommend page', async () => {
      const tabs = await page.evaluate(() =>
        [...document.querySelectorAll('#page-recommend .tab')].map(t => t.dataset.tab)
      );
      assert.ok(tabs.includes('nudges'), 'recommend tab "nudges" should exist');
      assert.ok(tabs.includes('toHard'), 'recommend tab "toHard" should exist');
      assert.ok(tabs.includes('toEasy'), 'recommend tab "toEasy" should exist');
    });

    it('renders nudge badge with the goal reason', async () => {
      const text = await page.evaluate(() =>
        [...document.querySelectorAll('#recommend-list .nudge-badge')].map(el => el.textContent.trim()).join(' ')
      );
      assert.ok(text.includes('HARD CLEARが狙えるBP率 1.0%'), 'lamp nudge reason should be rendered');
      assert.ok(text.includes('AAAまであと0.39%'), 'grade nudge reason should be rendered');
      await page.screenshot({ path: path.join(SHOT_DIR, '03-recommend-nudge.png') });
    });

    it('renders the nudged song title', async () => {
      const content = await page.evaluate(() =>
        document.getElementById('recommend-list')?.innerText ?? ''
      );
      assert.ok(content.includes('発狂曲A'), 'nudged song title should be rendered');
    });

    it('shows guidance message when nudges are empty', async () => {
      const content = await page.evaluate((recommend) => {
        window.__test.setRecommendData({ ...recommend, nudges: [] });
        window.__test.renderRecommendList();
        return document.getElementById('recommend-list')?.innerText ?? '';
      }, MOCK_RECOMMEND);
      assert.ok(content.includes('「あと一歩」の譜面が見つかりません'), 'empty nudge message should be shown');
    });
  });

  // ── table search ─────────────────────────────────────────────────────────────

  describe('table search', () => {
    before(async () => {
      await page.evaluate(({ scores, entries, filter }) => {
        window.__test.setScores(scores);
        window.__test.setTableData(entries);
        window.__test.setTableFilter(filter);
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        document.getElementById('page-scores').classList.add('active');
        window.__test.renderScoreList();
      }, { scores: MOCK_SCORES, entries: MOCK_TABLE_ENTRIES, filter: DEFAULT_FILTER });
    });

    it('score list matches artist name case-insensitively', async () => {
      await page.fill('#score-search', 'artistb');
      await page.waitForTimeout(100);
      const text = await page.evaluate(() => document.getElementById('score-list')?.innerText ?? '');
      assert.ok(text.includes('発狂曲B'), 'artist match should remain');
      assert.ok(!text.includes('発狂曲A'), 'non-matching artist should be filtered out');
    });

    it('shows empty message when nothing matches', async () => {
      await page.fill('#score-search', 'zzz-no-match');
      await page.waitForTimeout(100);
      const text = await page.evaluate(() => document.getElementById('score-list')?.innerText ?? '');
      assert.ok(text.includes('該当するスコアがありません'), 'empty message should be shown');
      await page.fill('#score-search', '');
      await page.waitForTimeout(100);
    });

    it('table view filters played rows and keeps matching unplayed rows', async () => {
      await page.evaluate(() => {
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        document.getElementById('page-tables').classList.add('active');
        window.__test.renderTableView();
      });
      await page.fill('#table-search', '未挑戦');
      await page.waitForTimeout(100);
      const text = await page.evaluate(() => document.getElementById('table-list')?.innerText ?? '');
      assert.ok(text.includes('未挑戦曲'), 'matching unplayed entry should remain');
      assert.ok(!text.includes('発狂曲A'), 'non-matching played chart should be filtered out');
      await page.screenshot({ path: path.join(SHOT_DIR, '05-table-search.png') });
    });

    it('table view keeps level grouping for matches', async () => {
      await page.fill('#table-search', '発狂曲B');
      await page.waitForTimeout(100);
      const headers = await page.evaluate(() =>
        [...document.querySelectorAll('#page-tables .level-header span:first-child')]
          .map(el => el.textContent.trim())
      );
      assert.ok(headers.includes('★12'), '★12 section should remain for the match');
      assert.ok(!headers.includes('★11'), '★11 section should disappear');
      await page.fill('#table-search', '');
      await page.waitForTimeout(100);
    });
  });

  // ── table filter ─────────────────────────────────────────────────────────────

  describe('table filter', () => {
    before(() => injectMockAndRender(page, DEFAULT_FILTER));

    it('shows sections for every checked table by default', async () => {
      const titles = await page.evaluate(() =>
        [...document.querySelectorAll('#table-list .table-section-title')].map(el => el.textContent.trim())
      );
      assert.ok(titles.includes('発狂難易度'), '発狂難易度 section should be shown');
      assert.ok(titles.includes('Satellite'), 'Satellite section should be shown');
      assert.ok(!titles.includes('表外'), '表外 section should be hidden by default');
      await page.screenshot({ path: path.join(SHOT_DIR, '06-table-filter-default.png') });
    });

    it('hides 表外 charts by default and keeps table charts visible', async () => {
      const text = await page.evaluate(() => document.getElementById('table-list')?.innerText ?? '');
      assert.ok(text.includes('発狂曲A'), 'insane chart should be visible');
      assert.ok(text.includes('サテ曲C'), 'satellite chart should be visible');
      assert.ok(!text.includes('未登録曲'), 'chart in no table should be hidden');
    });

    it('checking 表外 reveals charts that are in no table', async () => {
      await page.check('#table-filter-bar input[data-table="outside"]');
      await page.waitForTimeout(100);
      const outsideSection = await page.evaluate(() => {
        const sections = [...document.querySelectorAll('#table-list .table-section')];
        return sections
          .find(sec => sec.querySelector('.table-section-title')?.textContent.trim() === '表外')
          ?.innerText ?? '';
      });
      assert.ok(outsideSection.includes('未登録曲'), '表外 section should show the chart in no table');
      assert.ok(!outsideSection.includes('発狂曲A'), 'table chart should not appear in 表外 section');
      await page.screenshot({ path: path.join(SHOT_DIR, '07-table-filter-outside.png') });
    });

    it('unchecking a table hides its section', async () => {
      await page.uncheck('#table-filter-bar input[data-table="satellite"]');
      await page.waitForTimeout(100);
      const text = await page.evaluate(() => document.getElementById('table-list')?.innerText ?? '');
      assert.ok(!text.includes('サテ曲C'), 'satellite chart should disappear when unchecked');
      assert.ok(text.includes('発狂曲A'), 'insane chart should remain visible');
    });

    it('stat cards dedupe charts across checked tables', async () => {
      // insane checked: 2 played (発狂曲A/B) + 1 unplayed (未挑戦曲) = 3
      const values = await page.evaluate(() =>
        Object.fromEntries(
          [...document.querySelectorAll('#table-stats .stat-card')].map(c => [
            c.querySelector('.stat-label')?.textContent.trim(),
            c.querySelector('.stat-value')?.textContent.trim(),
          ])
        )
      );
      assert.equal(values['テーブル総数'], '3', 'テーブル総数 should count insane charts only');
      assert.equal(values['未挑戦'], '1', '未挑戦 should be 1');
    });

    it('unchecking everything shows the empty-filter message', async () => {
      await page.evaluate(() => {
        window.__test.setTableFilter({ insane: false, satellite: false, stella: false, overjoy: false, outside: false });
        window.__test.renderTableView();
      });
      await page.waitForTimeout(100);
      const text = await page.evaluate(() => document.getElementById('table-list')?.innerText ?? '');
      assert.ok(text.includes('表示できる譜面がありません'), 'empty-filter message should be shown');
    });
  });

  // ── global table filter (all pages) ──────────────────────────────────────────

  describe('global table filter (all pages)', () => {
    before(() => injectMockAndRender(page, DEFAULT_FILTER));

    it('renders a filter bar with 5 checkboxes on the filtered pages', async () => {
      const counts = await page.evaluate(() =>
        [...document.querySelectorAll('.page')].map(p => [
          p.id,
          p.querySelectorAll('.table-filter-bar input[type="checkbox"]').length,
        ])
      );
      assert.equal(counts.length, 4, 'all four pages should be checked');
      for (const [id, n] of counts) {
        // ランプ統計ページはフィルタバーの代わりに難易度表タブを持つ
        assert.equal(n, id === 'page-stats' ? 0 : 5, `${id} table filter checkbox count`);
      }
    });

    it('checkbox change on one page syncs to the other pages', async () => {
      // 難易度表ページで satellite を OFF → スコア一覧ページのバーにも反映される
      await page.uncheck('#table-filter-bar input[data-table="satellite"]');
      await page.waitForTimeout(100);
      const synced = await page.evaluate(() =>
        document.querySelector('#page-scores .table-filter-bar input[data-table="satellite"]')?.checked
      );
      assert.equal(synced, false, 'satellite checkbox on the scores page should be unchecked too');
      await page.check('#table-filter-bar input[data-table="satellite"]');
      await page.waitForTimeout(100);
    });

    it('score list hides charts in unchecked tables and 表外 charts', async () => {
      await page.evaluate(() => {
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        document.getElementById('page-scores').classList.add('active');
        window.__test.renderScoreList();
      });
      await page.waitForTimeout(100);
      let text = await page.evaluate(() => document.getElementById('score-list')?.innerText ?? '');
      assert.ok(text.includes('サテ曲C'), 'satellite chart should be visible by default');
      assert.ok(!text.includes('未登録曲'), '表外 chart should be hidden by default');

      await page.uncheck('#page-scores .table-filter-bar input[data-table="satellite"]');
      await page.waitForTimeout(100);
      text = await page.evaluate(() => document.getElementById('score-list')?.innerText ?? '');
      assert.ok(!text.includes('サテ曲C'), 'satellite chart should disappear when satellite is unchecked');
      assert.ok(text.includes('発狂曲A'), 'insane chart should remain visible');
      await page.check('#page-scores .table-filter-bar input[data-table="satellite"]');
      await page.waitForTimeout(100);
      await page.screenshot({ path: path.join(SHOT_DIR, '08-score-list-filter.png') });
    });

    it('checking 表外 on the score list reveals charts in no table', async () => {
      await page.check('#page-scores .table-filter-bar input[data-table="outside"]');
      await page.waitForTimeout(100);
      const text = await page.evaluate(() => document.getElementById('score-list')?.innerText ?? '');
      assert.ok(text.includes('未登録曲'), '表外 chart should appear when 表外 is checked');
      await page.uncheck('#page-scores .table-filter-bar input[data-table="outside"]');
      await page.waitForTimeout(100);
    });

    it('recommend list and stat cards respect the table filter', async () => {
      await page.evaluate((recommend) => {
        window.__test.setRecommendData(recommend);
        window.__test.setActiveRecommendTab('nudges');
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        document.getElementById('page-recommend').classList.add('active');
        window.__test.renderRecommendList();
      }, MOCK_RECOMMEND);
      await page.waitForTimeout(100);

      // nudges は 2 件とも発狂難易度の譜面 → insane OFF で全て消える
      await page.uncheck('#page-recommend .table-filter-bar input[data-table="insane"]');
      await page.waitForTimeout(100);
      const text = await page.evaluate(() => document.getElementById('recommend-list')?.innerText ?? '');
      assert.ok(text.includes('テーブルフィルタに一致する譜面がありません'), 'filtered-empty message should be shown');
      const nudgeCard = await page.evaluate(() => {
        const cards = [...document.querySelectorAll('#recommend-stats .stat-card')];
        return cards.find(c => c.querySelector('.stat-label')?.textContent.trim() === 'あと一歩')
          ?.querySelector('.stat-value')?.textContent.trim();
      });
      assert.equal(nudgeCard, '0', 'あと一歩 stat card should be 0 with insane unchecked');
      await page.screenshot({ path: path.join(SHOT_DIR, '09-recommend-filter.png') });

      await page.check('#page-recommend .table-filter-bar input[data-table="insane"]');
      await page.waitForTimeout(100);
      const restored = await page.evaluate(() => document.getElementById('recommend-list')?.innerText ?? '');
      assert.ok(restored.includes('発狂曲A'), 'nudges should reappear when insane is re-checked');
    });

  });

  // ── lamp stats (per-table tabs) ───────────────────────────────────────────────

  describe('lamp stats page', () => {
    before(() => injectMockAndRender(page, DEFAULT_FILTER));

    const readTotals = () => page.evaluate(() =>
      Object.fromEntries(
        [...document.querySelectorAll('#stats-totals .stat-card')].map(c => [
          c.querySelector('.stat-label')?.textContent.trim(),
          c.querySelector('.stat-value')?.textContent.trim(),
        ])
      )
    );
    const readRows = () => page.evaluate(() =>
      [...document.querySelectorAll('#stats-table-wrap tbody tr')].map(tr =>
        [...tr.querySelectorAll('td')].map(td => td.textContent.trim())
      )
    );

    it('shows a per-level lamp table for the insane table by default', async () => {
      await page.evaluate(() => {
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        document.getElementById('page-stats').classList.add('active');
        window.__test.setActiveStatsTable('insane');
        window.__test.renderStats();
      });
      await page.waitForTimeout(100);

      // 発狂: 発狂曲A(★11 HARD) + 発狂曲B(★12 CLEAR) + 未挑戦曲(★13 NO PLAY)。表外・サテ曲は含まない
      const totals = await readTotals();
      assert.equal(totals['総譜面数'], '3', 'insane table has 3 charts');
      assert.equal(totals['HARD以上'], '1', 'HARD以上 should count 発狂曲A only');
      assert.equal(totals['未プレイ'], '1', '未挑戦曲 should count as unplayed');

      // 列: Level, FC, EX HARD, HARD, CLEAR, EASY, ASSIST, FAILED, NO PLAY, Total
      const rows = await readRows();
      assert.deepEqual(rows, [
        ['★11', '–', '–', '1', '–', '–', '–', '–', '–', '1'],
        ['★12', '–', '–', '–', '1', '–', '–', '–', '–', '1'],
        ['★13', '–', '–', '–', '–', '–', '–', '–', '1', '1'],
      ], 'each level row should classify charts by lamp');
      await page.screenshot({ path: path.join(SHOT_DIR, '10-stats-insane.png') });
    });

    it('tabs switch the stats to another difficulty table', async () => {
      await page.click('#stats-tab-bar .tab[data-table="satellite"]');
      await page.waitForTimeout(100);

      const totals = await readTotals();
      assert.equal(totals['総譜面数'], '1', 'satellite table has 1 chart');
      assert.equal(totals['EASY以上'], '1', 'サテ曲C is EASY CLEAR');
      const rows = await readRows();
      assert.deepEqual(rows, [
        ['sl5', '–', '–', '–', '–', '1', '–', '–', '–', '1'],
      ], 'satellite tab should show sl levels only');
      await page.screenshot({ path: path.join(SHOT_DIR, '11-stats-satellite.png') });
    });

    it('a table with no entries shows an empty message', async () => {
      await page.click('#stats-tab-bar .tab[data-table="stella"]');
      await page.waitForTimeout(100);
      const text = await page.evaluate(() => document.getElementById('stats-table-wrap')?.innerText ?? '');
      assert.ok(text.includes('この難易度表のデータがありません'), 'stella has no mock entries');

      await page.click('#stats-tab-bar .tab[data-table="insane"]');
      await page.waitForTimeout(100);
    });
  });
});
