// ─── Nudge logic ──────────────────────────────────────────────────────────────
// 「特定の目標を達成できそうだけど、まだできていない」譜面を検出する。
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
  goal: string;      // 'CLEAR' | 'HARD CLEAR' | 'EX HARD' | 'FULL COMBO' | 'AA' | 'AAA' | 'MAX-'
  reason: string;    // 表示用の日本語ラベル
  closeness: number; // 0–1。1 に近いほど目標達成が近い(表示順に使用)
}

// 次のランプを狙える BP 率の閾値。notecount が取れない場合は絶対 BP で代用する。
interface LampRule { from: LampCat[]; goal: string; maxBpRate: number; maxBpAbs: number; }

const NEXT_LAMP_RULES: LampRule[] = [
  { from: ['FAILED', 'ASSIST'], goal: 'CLEAR',      maxBpRate: 0.05,  maxBpAbs: 30 },
  { from: ['EASY', 'CLEAR'],    goal: 'HARD CLEAR', maxBpRate: 0.035, maxBpAbs: 20 },
  { from: ['HARD'],             goal: 'EX HARD',    maxBpRate: 0.015, maxBpAbs: 10 },
];

// CLEAR 以上かつ BP がこれ以下なら FULL COMBO を狙える
const FC_BP_MAX = 5;

// Tachi (IIDX 式) のグレード境界。境界まで GRADE_GAP_MAX % 以内ならグレード更新を狙える
const GRADE_BOUNDARIES = [
  { grade: 'AA',   percent: 700 / 9 },    // 77.78%
  { grade: 'AAA',  percent: 800 / 9 },    // 88.89%
  { grade: 'MAX-', percent: 1700 / 18 },  // 94.44%
];
const GRADE_GAP_MAX = 1.0;

function getLevel(chart: NudgePB['chart']): number {
  return chart?.levelNum ?? (parseFloat(chart?.level ?? '') || 0);
}

function nudgeCandidates(pb: NudgePB): Nudge[] {
  const candidates: Nudge[] = [];
  const cat = lampCat(pb.scoreData?.lamp);
  const bp = pb.scoreData?.optional?.bp;
  const notes = pb.chart?.data?.notecount;

  if (typeof bp === 'number' && bp >= 0) {
    const rule = NEXT_LAMP_RULES.find(r => r.from.includes(cat));
    if (rule) {
      if (typeof notes === 'number' && notes > 0) {
        const rate = bp / notes;
        if (rate <= rule.maxBpRate) {
          candidates.push({
            goal: rule.goal,
            reason: `${rule.goal}が狙えるBP率 ${(rate * 100).toFixed(1)}%`,
            closeness: 1 - rate / rule.maxBpRate,
          });
        }
      } else if (bp <= rule.maxBpAbs) {
        candidates.push({
          goal: rule.goal,
          reason: `${rule.goal}が狙えるBP ${bp}`,
          closeness: 1 - bp / (rule.maxBpAbs + 1),
        });
      }
    }

    if (cat !== 'FC' && LAMP_ORDER[cat] >= LAMP_ORDER.CLEAR && bp <= FC_BP_MAX) {
      candidates.push({
        goal: 'FULL COMBO',
        reason: `FULL COMBOまでBP ${bp}`,
        closeness: 1 - bp / (FC_BP_MAX + 1),
      });
    }
  }

  const percent = pb.scoreData?.percent;
  if (typeof percent === 'number') {
    const next = GRADE_BOUNDARIES.find(b => b.percent > percent);
    if (next) {
      const gap = next.percent - percent;
      if (gap <= GRADE_GAP_MAX) {
        candidates.push({
          goal: next.grade,
          reason: `${next.grade}まであと${gap.toFixed(2)}%`,
          closeness: 1 - gap / GRADE_GAP_MAX,
        });
      }
    }
  }

  return candidates;
}

// 各譜面ごとに最も達成が近い目標をひとつ選び、達成の近い順に並べて返す
export function computeNudges<T extends NudgePB>(pbs: T[]): (T & { nudge: Nudge })[] {
  const out: (T & { nudge: Nudge })[] = [];
  for (const pb of pbs) {
    const candidates = nudgeCandidates(pb);
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => b.closeness - a.closeness);
    out.push({ ...pb, nudge: candidates[0] });
  }
  out.sort((a, b) =>
    b.nudge.closeness - a.nudge.closeness || getLevel(a.chart) - getLevel(b.chart)
  );
  return out;
}
