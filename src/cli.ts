#!/usr/bin/env node
/**
 * Cha 命令行入口：
 *   cha run 文件.cha   运行脚本
 *   cha（或 cha repl） 进入 REPL
 */
import { readFileSync } from 'fs'
import { run } from './index'
import { startRepl } from './repl'

export function main(argv: string[] = process.argv.slice(2)): void {
  const [command, ...rest] = argv

  if (command === 'run') {
    const file = rest[0]
    if (!file) {
      console.error('用法：cha run <文件.cha>')
      process.exit(64)
    }
    let source: string
    try {
      source = readFileSync(file, 'utf8')
    } catch {
      console.error(`读不到文件：${file}`)
      process.exit(66)
    }
    const result = run(source)
    for (const line of result.output) console.log(line)
    if (result.error) {
      const e = result.error
      console.error(`\n${phaseName(e.phase)}错误（第 ${e.line} 行，第 ${e.col} 列）：${e.message}`)
      process.exit(70)
    }
    return
  }

  if (command === undefined || command === 'repl') {
    void startRepl()
    return
  }

  console.error(`未知命令 '${command}'。用法：cha [run <文件.cha> | repl]`)
  process.exit(64)
}

function phaseName(phase: string): string {
  switch (phase) {
    case 'lex':
      return '词法'
    case 'parse':
      return '语法'
    case 'resolve':
      return '作用域'
    default:
      return '运行时'
  }
}

main()
