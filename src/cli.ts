#!/usr/bin/env node
/**
 * Cha 命令行入口：
 *   cha run 文件.cha            运行脚本（默认字节码 VM）
 *   cha run 文件.cha --tree     用树遍历解释器跑
 *   cha run 文件.cha --disasm   只打印字节码，不执行
 *   cha（或 cha repl）          进入 REPL
 */
import { readFileSync } from 'fs'
import { run, runVM } from './index'
import { disassemble } from './chunk'
import { compile } from './compiler'
import { parse } from './parser'
import { resolve } from './resolver'
import { startRepl } from './repl'

export function main(argv: string[] = process.argv.slice(2)): void {
  const [command, ...rest] = argv

  if (command === 'run') {
    const flags = rest.filter((a) => a.startsWith('--'))
    const file = rest.find((a) => !a.startsWith('--'))
    if (!file) {
      console.error('用法：cha run <文件.cha> [--tree | --disasm]')
      process.exit(64)
    }
    let source: string
    try {
      source = readFileSync(file, 'utf8')
    } catch {
      console.error(`读不到文件：${file}`)
      process.exit(66)
    }

    if (flags.includes('--disasm')) {
      try {
        const program = parse(source)
        resolve(program)
        console.log(disassemble(compile(program)))
      } catch (e) {
        reportCompileError(e)
        process.exit(65)
      }
      return
    }

    const backend = flags.includes('--tree') ? run : runVM
    const result = backend(source)
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

  console.error(`未知命令 '${command}'。用法：cha [run <文件.cha> [--tree|--disasm] | repl]`)
  process.exit(64)
}

/** 编译期错误（--disasm 路径）的统一展示 */
function reportCompileError(e: unknown): void {
  if (e instanceof Error) {
    const anyE = e as Error & { line?: number; col?: number }
    const pos = anyE.line ? `（第 ${anyE.line} 行，第 ${anyE.col} 列）` : ''
    console.error(`${e.name}${pos}：${e.message}`)
    return
  }
  console.error(`错误：${String(e)}`)
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
