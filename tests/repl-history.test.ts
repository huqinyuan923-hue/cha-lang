import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { loadHistory, normalizeHistory, saveHistory } from '../src/repl-history'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cha-history-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('REPL 历史', () => {
  it('丢掉空行与连续重复，保留非连续的重复输入', () => {
    expect(normalizeHistory(['var a = 1;', '', 'var a = 1;', 'print(a);', 'var a = 1;'])).toEqual([
      'var a = 1;',
      'print(a);',
      'var a = 1;',
    ])
  })

  it('只保留最近 limit 条', () => {
    expect(normalizeHistory(['a', 'b', 'c', 'd', 'e'], 3)).toEqual(['c', 'd', 'e'])
    expect(normalizeHistory(['a', 'b'], 0)).toEqual([])
  })

  it('读写往返：CRLF 统一成 LF，文件末尾带换行', () => {
    const file = join(tempDir(), 'history')
    writeFileSync(file, 'print(1);\r\n\r\nprint(2);\r\nprint(2);\r\n', 'utf8')
    expect(loadHistory(file)).toEqual(['print(1);', 'print(2);'])

    saveHistory(file, ['print(3);', 'print(3);', 'print(4);'])
    expect(readFileSync(file, 'utf8')).toBe('print(3);\nprint(4);\n')
    expect(loadHistory(file)).toEqual(['print(3);', 'print(4);'])
  })

  it('文件不存在或不可读时返回空历史', () => {
    expect(loadHistory(join(tempDir(), 'missing'))).toEqual([])
    expect(loadHistory(tempDir())).toEqual([])
  })

  it('写不进去时静默失败（历史记录不该让 REPL 退出报错）', () => {
    const blocked = join(tempDir(), 'no-such-dir', 'history')
    expect(() => saveHistory(blocked, ['print(1);'])).not.toThrow()
  })
})
