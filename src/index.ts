import { Interpreter, RuntimeError } from './interpreter'
import { LexError } from './lexer'
import { parse, ParseError } from './parser'
import { ResolveError, resolve } from './resolver'

export interface ChaErrorInfo {
  name: string
  message: string
  line: number
  col: number
  phase: 'lex' | 'parse' | 'resolve' | 'runtime'
}

export interface RunResult {
  /** print 产生的输出，每行一条 */
  output: string[]
  /** 出错时的结构化信息；正常结束为 undefined */
  error?: ChaErrorInfo
}

export interface RunOptions {
  /** print 的去处；默认收集到 result.output */
  output?: (text: string) => void
  clock?: () => number
}

/**
 * 运行一段 Cha 源码。词法 → 解析 → 作用域解析 → 求值，
 * 任何阶段的错误都折算成结构化的 ChaErrorInfo 返回，不抛出。
 * 这是未来浏览器 Playground 的入口——本模块不依赖 Node API。
 */
export function run(source: string, options: RunOptions = {}): RunResult {
  const output: string[] = []
  const sink = options.output ?? ((text: string) => output.push(text))

  try {
    const program = parse(source)
    const resolutions = resolve(program)
    const interpreter = new Interpreter(resolutions, { output: sink, clock: options.clock })
    interpreter.run(program)
    return { output }
  } catch (e) {
    return { output, error: toErrorInfo(e) }
  }
}

function toErrorInfo(e: unknown): ChaErrorInfo {
  if (e instanceof LexError) {
    return { name: e.name, message: stripPosition(e.message), line: e.line, col: e.col, phase: 'lex' }
  }
  if (e instanceof ParseError) {
    return { name: e.name, message: stripPosition(e.message), line: e.line, col: e.col, phase: 'parse' }
  }
  if (e instanceof ResolveError) {
    return { name: e.name, message: stripPosition(e.message), line: e.line, col: e.col, phase: 'resolve' }
  }
  if (e instanceof RuntimeError) {
    return {
      name: e.name,
      message: stripPosition(e.message),
      line: e.line,
      col: e.col,
      phase: 'runtime',
    }
  }
  // 理论不可达：内部错误兜底
  const message = e instanceof Error ? e.message : String(e)
  return { name: 'InternalError', message, line: 0, col: 0, phase: 'runtime' }
}

function stripPosition(message: string): string {
  return message.replace(/^\[line \d+, col \d+\] /, '')
}

export { RuntimeError }

/**
 * 会话：多次 run 共享同一份全局环境——REPL / 浏览器 Playground 用。
 * 每段代码独立解析与作用域解析，声明过的全局变量跨段可见。
 */
export class Session {
  private interpreter: Interpreter

  constructor(options: RunOptions = {}) {
    this.interpreter = new Interpreter(new Map(), options)
  }

  run(source: string): RunResult {
    try {
      const program = parse(source)
      this.interpreter.setResolutions(resolve(program))
      this.interpreter.run(program)
      return { output: [] }
    } catch (e) {
      return { output: [], error: toErrorInfo(e) }
    }
  }
}
