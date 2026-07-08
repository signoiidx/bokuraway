import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeNudges } from '../dist/nudge.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function pb({ id = 'c1', lamp, bp, notecount, levelNum = 10 } = {}) {
  return {
    chartID: id,
    scoreData: {
      lamp,
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

describe('computeNudges: lamps at or above HARD CLEAR get no nudge', () => {
  for (const lamp of ['HARD CLEAR', 'EX HARD CLEAR', 'FULL COMBO']) {
    it(`${lamp} → no nudge`, () => {
      const out = computeNudges([pb({ lamp, bp: 1, notecount: 1000 })]);
      assert.equal(out.length, 0);
    });
  }
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
