/**
 * 标准输入的同步读取。
 *
 * 两个后端都是同步求值的，`input()` 必须当场返回一行，所以走 readSync 逐字节读，
 * 而不是 readline 的异步回调。字节先攒起来再按 UTF-8 解码——逐字节转字符串会把
 * 中文（多字节）截断成乱码。
 */
import { readSync } from 'fs'
import type { ReadLine } from './builtins'

export function createStdinReader(): ReadLine {
  const byte = Buffer.alloc(1)
  return (prompt) => {
    if (prompt !== null) process.stdout.write(prompt)
    const chunks: number[] = []
    for (;;) {
      let read = 0
      try {
        read = readSync(0, byte, 0, 1, null)
      } catch {
        break // 标准输入已关闭或不可读，等同于 EOF
      }
      if (read === 0) break
      if (byte[0] === 0x0a) return Buffer.from(chunks).toString('utf8')
      if (byte[0] !== 0x0d) chunks.push(byte[0]!)
    }
    return chunks.length > 0 ? Buffer.from(chunks).toString('utf8') : null
  }
}
