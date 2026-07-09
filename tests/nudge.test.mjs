import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeNudges } from '../dist/nudge.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function pb({ id = 'c1', lamp, bp, percent, notecount, levelNum = 10 } = {}) {
  return {
    chartID: id,
    scoreData: {
      lamp,
      ...(percent !== undefined ? { percent } : {}),
      ...(bp !== undefined ? { optional: { bp } } : {}),
    },
    chart: {
      levelNum,
      data: notecount !== undefined ? { notecount } : {},
    },
  };
}

// ── HARD CLEAR 狙い ───────────────────────────────────────────────────────────

describe('computeNudges: HARD CLEAR goal', () => {
  it('CLEAR + BP rate within 3.5% → HARD CLEAR nudge', () => {
    const out = computeNudges([pb({ lamp: 'CLEAR', bp: 10, notecount: 1000 })]);
    assert.equal(out.length, 1);
    assert.equal(out[0].nudge.goal, 'HARD CLEAR');
    assert.ok(out[0].nudge.reason.includes('HARD CLEARが狙えるBP率 1.0%'));
  });

  it('EASY CLEAR + BP rate within 3.5% → HARD CLEAR nudge', () => {
    const out = computeNudges([pb({ lamp: 'EASY CLEAR', bp: 20, notecount: 1000 })]);
    assert.equal(out.length, 1);
    assert.equal(out[0].nudge.goal, 'HARD CLEAR');
  });

  it('CLEAR + high BP rate → no nudge', () => {
    const out = computeNudges([pb({ lamp: 'CLEAR', bp: 100, notecount: 1000 })]);
    assert.equal(out.length, 0);
  });
});

// ── EASY CLEAR 狙い ───────────────────────────────────────────────────────────

describe('computeNudges: EASY CLEAR goal', () => {
  it('FAILED + BP rate within 5% → EASY CLEAR nudge', () => {
    const out = computeNudges([pb({ lamp: 'FAILED', bp: 20, notecount: 500 })]);
    assert.equal(out.length, 1);
    assert.equal(out[0].nudge.goal, 'EASY CLEAR');
    assert.ok(out[0].nudge.reason.includes('EASY CLEARが狙えるBP率 4.0%'));
  });

  it('ASSIST EASY + BP rate within 5% → EASY CLEAR nudge', () => {
    const out = computeNudges([pb({ lamp: 'ASSIST CLEAR', bp: 10, notecount: 500 })]);
    assert.equal(out.length, 1);
    assert.equal(out[0].nudge.goal, 'EASY CLEAR');
  });

  it('FAILED + high BP rate → no nudge', () => {
    const out = computeNudges([pb({ lamp: 'FAILED', bp: 100, notecount: 500 })]);
    assert.equal(out.length, 0);
  });
});

// ── lamps already at goal ─────────────────────────────────────────────────────

describe('computeNudges: lamps at or above HARD CLEAR get no lamp nudge', () => {
  for (const lamp of ['HARD CLEAR', 'EX HARD CLEAR', 'FULL COMBO']) {
    it(`${lamp} → no nudge`, () => {
      const out = computeNudges([pb({ lamp, bp: 1, notecount: 1000 })]);
      assert.equal(out.length, 0);
    });
  }
});

// ── grade goals (A / AA / AAA) ────────────────────────────────────────────────

describe('computeNudges: grade goals', () => {
  it('percent just below A (66.67%) → A nudge', () => {
    const out = computeNudges([pb({ lamp: 'HARD CLEAR', percent: 66.0 })]);
    assert.equal(out.length, 1);
    assert.equal(out[0].nudge.goal, 'A');
    assert.ok(out[0].nudge.reason.includes('Aまであと'));
  });

  it('percent just below AA (77.78%) → AA nudge', () => {
    const out = computeNudges([pb({ lamp: 'HARD CLEAR', percent: 77.0 })]);
    assert.equal(out.length, 1);
    assert.equal(out[0].nudge.goal, 'AA');
  });

  it('percent just below AAA (88.89%) → AAA nudge', () => {
    const out = computeNudges([pb({ lamp: 'HARD CLEAR', percent: 88.5 })]);
    assert.equal(out.length, 1);
    assert.equal(out[0].nudge.goal, 'AAA');
    assert.ok(out[0].nudge.reason.includes('AAAまであと0.39%'));
  });

  it('percent far from the next boundary → no nudge', () => {
    const out = computeNudges([pb({ lamp: 'HARD CLEAR', percent: 80.0 })]);
    assert.equal(out.length, 0);
  });

  it('percent above AAA → no grade nudge', () => {
    const out = computeNudges([pb({ lamp: 'FULL COMBO', percent: 94.0 })]);
    assert.equal(out.length, 0);
  });

  it('grade nudge applies even to FAILED charts', () => {
    const out = computeNudges([pb({ lamp: 'FAILED', percent: 88.5 })]);
    assert.equal(out.length, 1);
    assert.equal(out[0].nudge.goal, 'AAA');
  });

  it('picks the closer goal when both lamp and grade nudges apply', () => {
    // lamp: rate 0.1% → closeness ≈ 0.97 / grade: gap 0.78% → closeness ≈ 0.22
    const out = computeNudges([pb({ lamp: 'CLEAR', bp: 1, notecount: 1000, percent: 77.0 })]);
    assert.equal(out.length, 1);
    assert.equal(out[0].nudge.goal, 'HARD CLEAR');
  });
});

// ── fallbacks & missing data ──────────────────────────────────────────────────

describe('computeNudges: fallbacks', () => {
  it('falls back to absolute BP when notecount is missing', () => {
    const out = computeNudges([pb({ lamp: 'CLEAR', bp: 15 })]);
    assert.equal(out.length, 1);
    assert.equal(out[0].nudge.goal, 'HARD CLEAR');
    assert.ok(out[0].nudge.reason.includes('BP 15'));
  });

  it('absolute BP above threshold → no nudge', () => {
    const out = computeNudges([pb({ lamp: 'CLEAR', bp: 21 })]);
    assert.equal(out.length, 0);
  });

  it('no nudge when BP is missing', () => {
    const out = computeNudges([pb({ lamp: 'CLEAR' })]);
    assert.equal(out.length, 0);
  });
});

// ── ordering ──────────────────────────────────────────────────────────────────

describe('computeNudges: ordering', () => {
  it('sorts results by closeness descending', () => {
    const far  = pb({ id: 'far',  lamp: 'CLEAR', bp: 34, notecount: 1000 }); // rate 3.4%, barely in
    const near = pb({ id: 'near', lamp: 'CLEAR', bp: 1,  notecount: 1000 }); // rate 0.1%
    const out = computeNudges([far, near]);
    assert.equal(out.length, 2);
    assert.equal(out[0].chartID, 'near');
    assert.equal(out[1].chartID, 'far');
  });

  it('keeps original PB fields on the returned items', () => {
    const out = computeNudges([pb({ id: 'keep', lamp: 'CLEAR', bp: 5, notecount: 1000 })]);
    assert.equal(out[0].chartID, 'keep');
    assert.equal(out[0].scoreData.lamp, 'CLEAR');
  });
});
