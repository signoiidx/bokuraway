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
  none:      'ffff0000ffff0000ffff0000ffff0001',
};

const MOCK_SCORES = [
  { chartID: 'c1', scoreData: { lamp: 'HARD CLEAR', optional: { bp: 42 } }, chart: { levelNum: 11, difficulty: 'CHART', songTitle: '発狂曲A', artist: 'ArtistA', data: { hashMD5: MD5.insane11 } } },
  { chartID: 'c2', scoreData: { lamp: 'CLEAR' },                            chart: { levelNum: 12, difficulty: 'CHART', songTitle: '発狂曲B', artist: 'ArtistB', data: { hashMD5: MD5.insane12 } } },
  { chartID: 'c3', scoreData: { lamp: 'FAILED' },                           chart: { levelNum: 5,  difficulty: 'CHART', songTitle: '未登録曲', artist: 'ArtistC', data: { hashMD5: MD5.none     } } },
];

const MOCK_RECOMMEND = {
  nudges: [
    {
      chartID: 'c1',
      nudge: { goal: 'HARD CLEAR', reason: 'HARD CLEARが狙えるBP率 1.0%', closeness: 0.71 },
      scoreData: { lamp: 'CLEAR', optional: { bp: 10 } },
      chart: { levelNum: 11, difficulty: 'CHART', songTitle: '発狂曲A', artist: 'ArtistA', data: { hashMD5: MD5.insane11 } },
    },
  ],
  toHard: [],
  toClear: [],
};

// MD5.insane13 is in the table but has no matching score → should appear as NO PLAY
const MOCK_TABLE_ENTRIES = [
  { md5: MD5.insane11, title: '発狂曲A',  level: '★11', levelNum: 11, table: 'insane' },
  { md5: MD5.insane12, title: '発狂曲B',  level: '★12', levelNum: 12, table: 'insane' },
  { md5: MD5.insane13, title: '未挑戦曲', level: '★13', levelNum: 13, table: 'insane' },
];

// ── helpers ───────────────────────────────────────────────────────────────────

async function injectMockAndRender(page, tab = 'insane') {
  await page.evaluate(({ scores, entries, tab }) => {
    window.__test.setScores(scores);
    window.__test.setTableData(entries);
    window.__test.setActiveTableTab(tab);
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
  }, { scores: MOCK_SCORES, entries: MOCK_TABLE_ENTRIES, tab });
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

    it('has table tabs: insane, satellite, stella, overjoy', async () => {
      const tabs = await page.evaluate(() =>
        [...document.querySelectorAll('#page-tables .tab')].map(t => t.dataset.table)
      );
      for (const expected of ['insane', 'satellite', 'stella', 'overjoy']) {
        assert.ok(tabs.includes(expected), `table tab "${expected}" should exist`);
      }
    });
  });

  // ── table view ───────────────────────────────────────────────────────────────

  describe('table view (insane)', () => {
    before(() => injectMockAndRender(page, 'insane'));

    it('renders level sections for matched charts', async () => {
      const headers = await page.evaluate(() =>
        [...document.querySelectorAll('#page-tables .level-header span:first-child')]
          .map(el => el.textContent.trim())
      );
      assert.ok(headers.includes('★11'), 'should have ★11 section');
      assert.ok(headers.includes('★12'), 'should have ★12 section');
      await page.screenshot({ path: path.join(SHOT_DIR, '02-tables-insane.png') });
    });

    it('renders "-" section for charts not in the table', async () => {
      const headers = await page.evaluate(() =>
        [...document.querySelectorAll('#page-tables .level-header span:first-child')]
          .map(el => el.textContent.trim())
      );
      assert.ok(headers.includes('-'), 'should have "-" section for unmatched charts');
    });

    it('"-" section contains the unmatched chart title', async () => {
      const dashSection = await page.evaluate(() => {
        const sections = [...document.querySelectorAll('#page-tables .level-section')];
        return sections
          .find(sec => sec.querySelector('.level-header span')?.textContent.trim() === '-')
          ?.querySelector('.score-list')?.innerText ?? '';
      });
      assert.ok(dashSection.includes('未登録曲'), '"-" section should show unmatched song title');
    });

    it('matched charts do NOT appear in the "-" section', async () => {
      const dashSection = await page.evaluate(() => {
        const sections = [...document.querySelectorAll('#page-tables .level-section')];
        return sections
          .find(sec => sec.querySelector('.level-header span')?.textContent.trim() === '-')
          ?.querySelector('.score-list')?.innerText ?? '';
      });
      assert.ok(!dashSection.includes('発狂曲A'), 'matched chart should not be in "-" section');
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
      assert.ok(tabs.includes('toHard'), 'recommend tab "toHard" should still exist');
    });

    it('renders nudge badge with the goal reason', async () => {
      const text = await page.evaluate(() =>
        [...document.querySelectorAll('#recommend-list .nudge-badge')].map(el => el.textContent.trim()).join(' ')
      );
      assert.ok(text.includes('HARD CLEARが狙えるBP率 1.0%'), 'nudge reason should be rendered');
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
});
