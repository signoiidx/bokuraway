// ─── Nudge logic ──────────────────────────────────────────────────────────────
// BMS の主な評価指標について「達成できそうだけど、まだできていない」譜面を検出する。
// ランプは HARD CLEAR / EASY CLEAR、スコアは A / AA / AAA のグレード境界を基準とする。
// main プロセス (get-recommend) から使われる純粋モジュール。tests/nudge.test.mjs が直接 import する。

export type LampCat = 'FAILED' | 'ASSIST' | 'EASY' | 'CLEAR' | 'HARD' | 'EXHARD' | 'FC';

export const LAMP_ORDER: Record<LampCat, number> = {
  FAILED: 0, ASSIST: 1, EASY: 2, CLEAR: 3, HARD: 4, EXHARD: 5, FC: 6,
};

export function lampCat(lamp: string | undefined | null): LampCat {
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

export interface NudgePB {
  chartID?: string;
  scoreData?: {
    lamp?: string;
    percent?: number;
    optional?: { bp?: number | null };
  };
  chart?: {
    levelNum?: number;
    level?: string;
    data?: { notecount?: number };
  };
}

export interface Nudge {
  goal: 'EASY CLEAR' | 'HARD CLEAR' | 'A' | 'AA' | 'AAA';
  reason: string;    // 表示用の日本語ラベル
  closeness: number; // 0–1。1 に近いほど目標達成が近い(表示順に使用)
}

// 目標ランプを狙える BP 率の閾値。notecount が取れない場合は絶対 BP で代用する。
interface NudgeRule { from: LampCat[]; goal: Nudge['goal']; maxBpRate: number; maxBpAbs: number; }

const NUDGE_RULES: NudgeRule[] = [
  { from: ['FAILED', 'ASSIST'], goal: 'EASY CLEAR', maxBpRate: 0.05,  maxBpAbs: 30 },
  { from: ['EASY', 'CLEAR'],    goal: 'HARD CLEAR', maxBpRate: 0.035, maxBpAbs: 20 },
];

// スコア (Tachi の percent = EXスコア率) の目標グレード境界。
// 境界まで GRADE_GAP_MAX % 以内ならグレード更新を狙える。
const GRADE_BOUNDARIES: { grade: 'A' | 'AA' | 'AAA'; percent: number }[] = [
  { grade: 'A',   percent: 600 / 9 }, // 66.67%
  { grade: 'AA',  percent: 700 / 9 }, // 77.78%
  { grade: 'AAA', percent: 800 / 9 }, // 88.89%
];
const GRADE_GAP_MAX = 1.0;

function getLevel(chart: NudgePB['chart']): number {
  return chart?.levelNum ?? (parseFloat(chart?.level ?? '') || 0);
}

function lampNudge(pb: NudgePB): Nudge | null {
  const bp = pb.scoreData?.optional?.bp;
  if (typeof bp !== 'number' || bp < 0) return null;

  const cat = lampCat(pb.scoreData?.lamp);
  const rule = NUDGE_RULES.find(r => r.from.includes(cat));
  if (!rule) return null;

  const notes = pb.chart?.data?.notecount;
  if (typeof notes === 'number' && notes > 0) {
    const rate = bp / notes;
    if (rate > rule.maxBpRate) return null;
    return {
      goal: rule.goal,
      reason: `${rule.goal}が狙えるBP率 ${(rate * 100).toFixed(1)}%`,
      closeness: 1 - rate / rule.maxBpRate,
    };
  }

  if (bp > rule.maxBpAbs) return null;
  return {
    goal: rule.goal,
    reason: `${rule.goal}が狙えるBP ${bp}`,
    closeness: 1 - bp / (rule.maxBpAbs + 1),
  };
}

function gradeNudge(pb: NudgePB): Nudge | null {
  const percent = pb.scoreData?.percent;
  if (typeof percent !== 'number') return null;

  const next = GRADE_BOUNDARIES.find(b => b.percent > percent);
  if (!next) return null;

  const gap = next.percent - percent;
  if (gap > GRADE_GAP_MAX) return null;
  return {
    goal: next.grade,
    reason: `${next.grade}まであと${gap.toFixed(2)}%`,
    closeness: 1 - gap / GRADE_GAP_MAX,
  };
}

// 各譜面ごとに最も達成が近い目標をひとつ選び、達成の近い順 (closeness 降順) に並べて返す
export function computeNudges<T extends NudgePB>(pbs: T[]): (T & { nudge: Nudge })[] {
  const out: (T & { nudge: Nudge })[] = [];
  for (const pb of pbs) {
    const candidates = [lampNudge(pb), gradeNudge(pb)].filter((n): n is Nudge => n !== null);
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => b.closeness - a.closeness);
    out.push({ ...pb, nudge: candidates[0] });
  }
  out.sort((a, b) =>
    b.nudge.closeness - a.nudge.closeness || getLevel(a.chart) - getLevel(b.chart)
  );
  return out;
}
