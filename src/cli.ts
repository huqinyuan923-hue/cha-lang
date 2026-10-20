#!/usr/bin/env node
/**
 * Cha 命令行入口：
 *   cha run 文件.cha            运行脚本（默认字节码 VM）
 *   cha run 文件.cha --tree     用树遍历解释器跑
 *   cha run 文件.cha --disasm   只打印字节码，不执行
 *   cha check 文件.cha...       只做静态检查，不执行
 *   cha（或 cha repl）          进入 REPL
 */
import { readFileSync } from 'fs'
import { formatDiagnostic, run, runVM } from './index'
import { disassemble } from './chunk'
import { compile } from './compiler'
import { parse } from './parser'
import { resolve } from './resolver'
import { startRepl } from './repl'
import { createStdinReader } from './stdin'

const KNOWN_FLAGS = ['--tree', '--disasm']

const USAGE = `用法：
  cha run <文件.cha>            运行脚本（默认字节码 VM）
  cha run <文件.cha> --tree     用树遍历解释器跑
  cha run <文件.cha> --disasm   只打印字节码，不执行
  cha check <文件.cha>...       只做词法/语法/作用域/编译检查，不执行
  cha [repl]                    进入交互式环境`

export function main(argv: string[] = process.argv.slice(2)): void {
  const [command, ...rest] = argv

  if (command === '--help' || command === '-h' || command === 'help') {
    console.log(USAGE)
    return
  }

  if (command === 'check') {
    const flags = rest.filter((a) => a.startsWith('-'))
    if (flags.length > 0) {
      console.error(`check 不接受选项，收到 '${flags.join(' ')}'。\n${USAGE}`)
      process.exit(64)
    }
    if (rest.length === 0) {
      console.error(`用法：cha check <文件.cha>...`)
      process.exit(64)
    }
    let failed = false
    for (const file of rest) {
      let source: string
      try {
        source = readSource(file)
      } catch {
        console.error(`读不到文件：${file}`)
        process.exit(66)
      }
      try {
        const program = parse(source)
        resolve(program)
        compile(program)
      } catch (e) {
        reportCompileError(e, source)
        failed = true
        continue
      }
      console.log(`检查通过：${file}`)
    }
    if (failed) process.exit(65)
    return
  }

  if (command === 'run') {
    const flags = rest.filter((a) => a.startsWith('--'))
    const files = rest.filter((a) => !a.startsWith('--'))
    const unknown = flags.filter((f) => !KNOWN_FLAGS.includes(f))
    if (unknown.length > 0) {
      // 拼错的 --tre 会被当成「没有 flag」，静默换后端比报错危险得多
      console.error(`未知选项 '${unknown.join(' ')}'。\n${USAGE}`)
      process.exit(64)
    }
    if (flags.includes('--tree') && flags.includes('--disasm')) {
      console.error('--tree 与 --disasm 不能同时使用（--disasm 只编译，不选后端）。')
      process.exit(64)
    }
    if (files.length > 1) {
      console.error(`只接受一个脚本文件，收到 ${files.length} 个：${files.join(' ')}`)
      process.exit(64)
    }
    const file = files[0]
    if (!file) {
      console.error('用法：cha run <文件.cha> [--tree | --disasm]')
      process.exit(64)
    }
    let source: string
    try {
      source = readSource(file)
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
        reportCompileError(e, source)
        process.exit(65)
      }
      return
    }

    const backend = flags.includes('--tree') ? run : runVM
    // 流式输出：input() 的提示语必须出现在它之前的 print 之后，不能等程序跑完再一起打
    const result = backend(source, {
      output: (text) => process.stdout.write(`${text}\n`),
      readLine: createStdinReader(),
    })
    if (result.error) {
      const e = result.error
      const position = e.line > 0 ? `（第 ${e.line} 行，第 ${e.col} 列）` : ''
      const header = `${phaseName(e.phase)}错误${position}：${e.message}`
      console.error(`\n${formatDiagnostic(source, e, { header })}`)
      process.exit(70)
    }
    return
  }

  if (command === undefined || command === 'repl') {
    void startRepl()
    return
  }

  console.error(`未知命令 '${command}'。\n${USAGE}`)
  process.exit(64)
}

/** 读源码并剥掉 UTF-8 BOM：Windows 编辑器常带，U+FEFF 不是语言的一部分 */
function readSource(file: string): string {
  const source = readFileSync(file, 'utf8')
  return source.charCodeAt(0) === 0xfeff ? source.slice(1) : source
}

/** 编译期错误（--disasm / check 路径）的统一展示 */
function reportCompileError(e: unknown, source: string): void {
  if (e instanceof Error) {
    const anyE = e as Error & { line?: number; col?: number }
    const line = anyE.line ?? 0
    const col = anyE.col ?? 0
    // 错误自身的消息带着内部位置前缀，展示时以结构化行列为准
    const message = e.message.replace(/^\[line \d+, col \d+\] /, '')
    const position = line > 0 ? `（第 ${line} 行，第 ${col} 列）` : ''
    const header = `${compilePhaseName(e.name)}错误${position}：${message}`
    console.error(formatDiagnostic(source, { name: e.name, message, line, col }, { header }))
    return
  }
  console.error(`错误：${String(e)}`)
}

function compilePhaseName(name: string): string {
  switch (name) {
    case 'LexError':
      return '词法'
    case 'ParseError':
      return '语法'
    case 'ResolveError':
      return '作用域'
    default:
      return '编译'
  }
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
