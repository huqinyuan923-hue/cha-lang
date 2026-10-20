/**
 * REPL 历史的读写：Node 的 readline 只在内存里留最近若干条，
 * 这里把退出时的历史落盘，下次启动再装回去（最多 1000 条）。
 */
import { readFileSync, writeFileSync } from 'fs'

export const HISTORY_LIMIT = 1000

/** 丢掉空行与连续重复，只保留最近 limit 条 */
export function normalizeHistory(entries: string[], limit = HISTORY_LIMIT): string[] {
  const out: string[] = []
  for (const entry of entries) {
    const line = entry.replace(/\r$/, '')
    if (line === '') continue
    if (out.length > 0 && out[out.length - 1] === line) continue
    out.push(line)
  }
  const capped = Math.max(0, Math.trunc(limit))
  return capped === 0 ? [] : out.slice(-capped)
}

export function loadHistory(path: string, limit = HISTORY_LIMIT): string[] {
  try {
    return normalizeHistory(readFileSync(path, 'utf8').split('\n'), limit)
  } catch {
    return []
  }
}

/** 写不进去就算了：历史记录不该让 REPL 退出失败 */
export function saveHistory(path: string, entries: string[], limit = HISTORY_LIMIT): void {
  try {
    writeFileSync(path, normalizeHistory(entries, limit).join('\n') + '\n', 'utf8')
  } catch {
    // 只读目录、磁盘满、权限不足都静默忽略
  }
}
