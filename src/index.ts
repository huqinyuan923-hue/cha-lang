import { Interpreter, RuntimeError } from './interpreter'
import { LexError } from './lexer'
import { parse, ParseError } from './parser'
import { ResolveError, resolve } from './resolver'
import { compile, FunctionCompiler } from './compiler'
import { disassemble, disassembleRows, type DisasmRow, type VMFunction } from './chunk'
import { ThrowSignal, uncaughtThrowMessage, outputLimitMessage } from './values'
import { VirtualMachine } from './vm'
import type { VMOptions, VMTraceStep } from './vm'
import type { ReadLine } from './builtins'

export { RuntimeError }
export { compile, FunctionCompiler }
export { disassemble, disassembleRows }
export type { DisasmRow, VMFunction }
export type { VMTraceStep }
export { formatDiagnostic, formatErrorHeader, sourceExcerpt } from './diagnostic'
export type { DiagnosticInfo, DiagnosticOptions, ExcerptOptions } from './diagnostic'

export interface ChaErrorInfo {
  name: string
  message: string
  line: number
  col: number
  /** 用户 throw 没被接住时是 'ThrowError'，其余按出错阶段命名 */
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
  /** input() 的数据来源；浏览器 Playground 接 prompt()，CLI 接标准输入 */
  readLine?: ReadLine
  /** 循环轮数预算：宿主按自己能容忍的卡顿时长决定，两个后端拿同一个数 */
  loopBudget?: number
  /**
   * print 次数上限；不设则不限。超限后 print 抛一条可被 catch 的运行时错误，
   * 且本轮内不再放行新的输出——宿主收集输出的数组不会无限膨胀。
   */
  maxOutputLines?: number
  /** range() 单次最多分配的元素个数；默认 DEFAULT_MAX_RANGE_LENGTH */
  maxRangeLength?: number
  /** 字节码 VM 的逐指令轨迹回调；树遍历后端忽略 */
  trace?: VMOptions['trace']
  /** 轨迹最多记录多少步；树遍历后端忽略 */
  traceLimit?: number
}

/**
 * print 次数闸门：包在宿主 sink 外面，两个后端与两类会话共用，
 * 计数语义才和错误文案一起保持唯一。
 */
function createOutputGate(sink: (text: string) => void, limit?: number) {
  let count = 0
  return {
    emit(text: string): void {
      if (limit !== undefined && count >= limit) throw new RuntimeError(outputLimitMessage(limit))
      count += 1
      sink(text)
    },
    reset(): void {
      count = 0
    },
  }
}

type OutputGate = ReturnType<typeof createOutputGate>

/**
 * 运行一段 Cha 源码。词法 → 解析 → 作用域解析 → 求值，
 * 任何阶段的错误都折算成结构化的 ChaErrorInfo 返回，不抛出。
 * 这是未来浏览器 Playground 的入口——本模块不依赖 Node API。
 */
export function run(source: string, options: RunOptions = {}): RunResult {
  const output: string[] = []
  const sink = options.output ?? ((text: string) => output.push(text))
  const gate = createOutputGate(sink, options.maxOutputLines)

  try {
    const program = parse(source)
    const resolutions = resolve(program)
    const interpreter = new Interpreter(resolutions, {
      output: gate.emit,
      clock: options.clock,
      readLine: options.readLine,
      loopBudget: options.loopBudget,
      maxRangeLength: options.maxRangeLength,
    })
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
  if (e instanceof ThrowSignal) {
    // 一路没人接住的 throw：位置就是 throw 语句自己
    return {
      name: e.name,
      message: uncaughtThrowMessage(e.value),
      line: e.line,
      col: e.col,
      phase: 'runtime',
    }
  }
  if (e instanceof RangeError) {
    // 解析或求值的嵌套层级把 JS 栈打满（cha 函数调用深度两边都有显式上限，走不到这里）
    return {
      name: 'InternalError',
      message: '嵌套层级过深，超出了引擎的调用栈限制',
      line: 0,
      col: 0,
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
  private gate: OutputGate

  constructor(options: RunOptions = {}) {
    this.gate = createOutputGate(options.output ?? (() => {}), options.maxOutputLines)
    this.interpreter = new Interpreter(new Map(), {
      ...options,
      output: this.gate.emit,
    })
  }

  run(source: string): RunResult {
    this.gate.reset()
    try {
      const program = parse(source)
      this.interpreter.addResolutions(resolve(program))
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
  const gate = createOutputGate(sink, options.maxOutputLines)

  try {
    const program = parse(source)
    resolve(program) // 编译期错误（重复声明、自引用等）与 run() 同相位
    const proto = compile(program)
    const vm = new VirtualMachine({
      output: gate.emit,
      clock: options.clock,
      readLine: options.readLine,
      loopBudget: options.loopBudget,
      maxRangeLength: options.maxRangeLength,
      trace: options.trace,
      traceLimit: options.traceLimit,
    })
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
  private gate: OutputGate

  constructor(options: RunOptions = {}) {
    this.gate = createOutputGate((text) => {
      this.buffer.push(text)
      options.output?.(text)
    }, options.maxOutputLines)
    this.vm = new VirtualMachine({
      ...options,
      output: this.gate.emit,
    })
  }

  run(source: string): RunResult {
    this.buffer = []
    this.gate.reset()
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
