// ─── Shared types ─────────────────────────────────────────────────────────────
// main プロセスとレンダラーで共有する型定義。
// import/export を持たないグローバルスクリプトなので、モジュールの main.ts からも
// 非モジュールの renderer.ts からも import なしで参照できる (バンドラー不要)。
// 型のみのため、コンパイル後の dist/types.js は実質空で、どこからも読み込まれない。

interface DiffTableEntry {
  md5: string;
  title: string;
  level: string;    // 表記 (例: "★11", "sl7")
  levelNum: number;
  table: string;    // テーブル ID (insane / satellite / stella / overjoy)
}

interface TachiSong {
  id: string;
  title: string;
  artist: string;
}

interface TachiChart {
  chartID: string;
  level: string;
  levelNum: number;
  difficulty: string;
  song?: TachiSong;
  data?: {
    hashMD5?: string;
    hashSHA256?: string;
    aiLevel?: string;
    tableFolders?: Record<string, string>;
    notecount?: number;
  };
}

interface TachiScoreData {
  lamp?: string;
  percent?: number;
  optional?: { bp?: number | null };
}

// get-recommend が nudges の各エントリに付与する目標情報 (src/nudge.ts の Nudge と互換)
interface NudgeInfo {
  goal: string;
  reason: string;
  closeness: number;
}

interface TachiPB {
  chartID: string;
  scoreData?: TachiScoreData;
  chart?: TachiChart & { songTitle: string; artist: string };
  nudge?: NudgeInfo;
}

interface TachiPBsResponse {
  pbs?: TachiPB[];
  charts?: TachiChart[];
  songs?: TachiSong[];
}

type LampCategory = 'FAILED' | 'ASSIST' | 'EASY' | 'CLEAR' | 'HARD' | 'EXHARD' | 'FC';

// get-recommend の戻り値
interface RecommendData {
  nudges: TachiPB[];
  toHard: TachiPB[];
  toEasy: TachiPB[];
  noProfile?: boolean;
}

// get-stats の戻り値
interface StatsData {
  byLevel: Record<number, Record<LampCategory, number>>;
  totals: Record<LampCategory, number>;
  total: number;
}
