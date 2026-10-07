import { Interpreter, RuntimeError } from './interpreter'
import { LexError } from './lexer'
import { parse, ParseError } from './parser'
import { ResolveError, resolve } from './resolver'
import { compile, FunctionCompiler } from './compiler'
import { disassemble, type VMFunction } from './chunk'
import { VirtualMachine } from './vm'

export { RuntimeError }
export { compile, FunctionCompiler }
export { disassemble }
export type { VMFunction }

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

/**
 * 字节码后端：词法 → 解析 → 作用域解析 → 编译 → VM 执行。
 * 输出与错误信息与 run() 完全一致，可互换使用（差分测试保证）。
 */
export function runVM(source: string, options: RunOptions = {}): RunResult {
  const output: string[] = []
  const sink = options.output ?? ((text: string) => output.push(text))

  try {
    const program = parse(source)
    resolve(program) // 编译期错误（重复声明、自引用等）与 run() 同相位
    const proto = compile(program)
    const vm = new VirtualMachine({ output: sink, clock: options.clock })
    vm.execute(proto)
    return { output }
  } catch (e) {
    return { output, error: toErrorInfo(e) }
  }
}

/**
 * 字节码后端的会话：多次 run 共享同一台 VM 的全局环境。
 * 与 Session 不同，每次 run 的 print 输出会收集进返回值。
 */
export class VMSession {
  private vm: VirtualMachine
  private buffer: string[] = []

  constructor(options: RunOptions = {}) {
    this.vm = new VirtualMachine({
      ...options,
      output: (text) => {
        this.buffer.push(text)
        options.output?.(text)
      },
    })
  }

  run(source: string): RunResult {
    this.buffer = []
    try {
      const program = parse(source)
      resolve(program)
      this.vm.execute(compile(program))
      return { output: [...this.buffer] }
    } catch (e) {
      return { output: [...this.buffer], error: toErrorInfo(e) }
    }
  }
}
