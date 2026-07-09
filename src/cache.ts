// ─── Disk cache ───────────────────────────────────────────────────────────────
// userData/cache/<key>.json に { savedAt, data } を書き込む素朴な JSON キャッシュ。
// 外部依存なし。main プロセス専用 (app.getPath を使うため)。

import fs from 'fs';
import path from 'path';
import { app } from 'electron';

interface CacheFile<T> {
  savedAt: number;
  data: T;
}

function cacheDir(): string {
  return path.join(app.getPath('userData'), 'cache');
}

function cachePath(key: string): string {
  return path.join(cacheDir(), `${key}.json`);
}

// maxAgeMs を渡すと、それより古いキャッシュは無いものとして扱う (TTL)
export function readCache<T>(key: string, maxAgeMs?: number): T | null {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath(key), 'utf8')) as CacheFile<T>;
    if (typeof raw.savedAt !== 'number' || !('data' in raw)) return null;
    if (maxAgeMs !== undefined && Date.now() - raw.savedAt > maxAgeMs) return null;
    return raw.data;
  } catch {
    return null;
  }
}

export function writeCache<T>(key: string, data: T): void {
  try {
    fs.mkdirSync(cacheDir(), { recursive: true });
    fs.writeFileSync(cachePath(key), JSON.stringify({ savedAt: Date.now(), data }));
  } catch (e) {
    console.error(`Failed to write cache "${key}":`, e);
  }
}
