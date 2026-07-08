// ─── Nudge logic ──────────────────────────────────────────────────────────────
// BMS の主な評価指標である HARD CLEAR / EASY CLEAR について、
// 「達成できそうだけど、まだできていない」譜面を検出する。
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
    optional?: { bp?: number | null };
  };
  chart?: {
    levelNum?: number;
    level?: string;
    data?: { notecount?: number };
  };
}

export interface Nudge {
  goal: 'EASY CLEAR' | 'HARD CLEAR';
  reason: string;    // 表示用の日本語ラベル
  closeness: number; // 0–1。1 に近いほど目標達成が近い(表示順に使用)
}

// 目標ランプを狙える BP 率の閾値。notecount が取れない場合は絶対 BP で代用する。
interface NudgeRule { from: LampCat[]; goal: Nudge['goal']; maxBpRate: number; maxBpAbs: number; }

const NUDGE_RULES: NudgeRule[] = [
  { from: ['FAILED', 'ASSIST'], goal: 'EASY CLEAR', maxBpRate: 0.05,  maxBpAbs: 30 },
  { from: ['EASY', 'CLEAR'],    goal: 'HARD CLEAR', maxBpRate: 0.035, maxBpAbs: 20 },
];

function getLevel(chart: NudgePB['chart']): number {
  return chart?.levelNum ?? (parseFloat(chart?.level ?? '') || 0);
}

function nudgeFor(pb: NudgePB): Nudge | null {
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

// 目標達成が近い譜面を、達成の近い順 (closeness 降順) に並べて返す
export function computeNudges<T extends NudgePB>(pbs: T[]): (T & { nudge: Nudge })[] {
  const out: (T & { nudge: Nudge })[] = [];
  for (const pb of pbs) {
    const nudge = nudgeFor(pb);
    if (nudge) out.push({ ...pb, nudge });
  }
  out.sort((a, b) =>
    b.nudge.closeness - a.nudge.closeness || getLevel(a.chart) - getLevel(b.chart)
  );
  return out;
}
