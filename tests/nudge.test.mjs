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

// ── next-lamp nudges (BP rate) ────────────────────────────────────────────────

describe('computeNudges: next-lamp goals', () => {
  it('CLEAR + low BP rate → HARD CLEAR nudge', () => {
    const out = computeNudges([pb({ lamp: 'CLEAR', bp: 10, notecount: 1000 })]);
    assert.equal(out.length, 1);
    assert.equal(out[0].nudge.goal, 'HARD CLEAR');
    assert.ok(out[0].nudge.reason.includes('1.0%'));
  });

  it('EASY CLEAR + low BP rate → HARD CLEAR nudge', () => {
    const out = computeNudges([pb({ lamp: 'EASY CLEAR', bp: 20, notecount: 1000 })]);
    assert.equal(out.length, 1);
    assert.equal(out[0].nudge.goal, 'HARD CLEAR');
  });

  it('FAILED + BP rate within 5% → CLEAR nudge', () => {
    const out = computeNudges([pb({ lamp: 'FAILED', bp: 20, notecount: 500 })]);
    assert.equal(out.length, 1);
    assert.equal(out[0].nudge.goal, 'CLEAR');
  });

  it('HARD CLEAR + very low BP rate → EX HARD nudge', () => {
    const out = computeNudges([pb({ lamp: 'HARD CLEAR', bp: 8, notecount: 1000 })]);
    assert.equal(out.length, 1);
    assert.equal(out[0].nudge.goal, 'EX HARD');
  });

  it('CLEAR + high BP rate → no nudge', () => {
    const out = computeNudges([pb({ lamp: 'CLEAR', bp: 100, notecount: 1000 })]);
    assert.equal(out.length, 0);
  });

  it('falls back to absolute BP when notecount is missing', () => {
    const out = computeNudges([pb({ lamp: 'CLEAR', bp: 15 })]);
    assert.equal(out.length, 1);
    assert.equal(out[0].nudge.goal, 'HARD CLEAR');
    assert.ok(out[0].nudge.reason.includes('BP 15'));
  });

  it('no nudge when BP is missing and percent is missing', () => {
    const out = computeNudges([pb({ lamp: 'CLEAR' })]);
    assert.equal(out.length, 0);
  });
});

// ── FULL COMBO nudge ──────────────────────────────────────────────────────────

describe('computeNudges: FULL COMBO goal', () => {
  it('EX HARD + BP ≤ 5 → FULL COMBO nudge', () => {
    const out = computeNudges([pb({ lamp: 'EX HARD CLEAR', bp: 3 })]);
    assert.equal(out.length, 1);
    assert.equal(out[0].nudge.goal, 'FULL COMBO');
    assert.ok(out[0].nudge.reason.includes('BP 3'));
  });

  it('FULL COMBO lamp → no nudge (already achieved)', () => {
    const out = computeNudges([pb({ lamp: 'FULL COMBO', bp: 0 })]);
    assert.equal(out.length, 0);
  });

  it('FAILED + BP 3 → no FC nudge (below CLEAR), gets CLEAR nudge instead', () => {
    const out = computeNudges([pb({ lamp: 'FAILED', bp: 3 })]);
    assert.equal(out.length, 1);
    assert.equal(out[0].nudge.goal, 'CLEAR');
  });
});

// ── grade nudges ──────────────────────────────────────────────────────────────

describe('computeNudges: grade goals', () => {
  it('percent just below AAA → AAA nudge', () => {
    const out = computeNudges([pb({ lamp: 'HARD CLEAR', percent: 88.5 })]);
    assert.equal(out.length, 1);
    assert.equal(out[0].nudge.goal, 'AAA');
    assert.ok(out[0].nudge.reason.includes('AAAまであと'));
  });

  it('percent just below AA → AA nudge', () => {
    const out = computeNudges([pb({ lamp: 'CLEAR', percent: 77.0 })]);
    assert.equal(out.length, 1);
    assert.equal(out[0].nudge.goal, 'AA');
  });

  it('percent far from any boundary → no nudge', () => {
    const out = computeNudges([pb({ lamp: 'CLEAR', percent: 60 })]);
    assert.equal(out.length, 0);
  });

  it('percent above MAX- boundary → no grade nudge', () => {
    const out = computeNudges([pb({ lamp: 'FULL COMBO', percent: 99 })]);
    assert.equal(out.length, 0);
  });
});

// ── selection & ordering ──────────────────────────────────────────────────────

describe('computeNudges: selection and ordering', () => {
  it('picks the closest goal when multiple candidates exist', () => {
    // EX HARD candidate (rate 0.2% → closeness ≈ 0.87) beats FC (BP 2 → closeness ≈ 0.67)
    const out = computeNudges([pb({ lamp: 'HARD CLEAR', bp: 2, notecount: 1000 })]);
    assert.equal(out.length, 1);
    assert.equal(out[0].nudge.goal, 'EX HARD');
  });

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
