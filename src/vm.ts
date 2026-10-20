/**
 * 栈式字节码虚拟机。
 *
 * 单一值栈 + 调用帧：每帧占据栈上连续的槽位窗口（参数即槽位 0..n-1），
 * 临时值压在窗口之上。闭包用 upvalue 实现——被内层函数捕获的局部变量
 * 在作用域退出时从栈槽「关闭」到堆上，与 Lua/clox 同一套机制。
 *
 * 运行时错误信息与树遍历解释器逐字对齐（含行/列），差分测试依赖这一点。
 */
import { Chunk, Op, TemplateInfo, type Upvalue, type VMFunction } from './chunk'
import {
  ChaFunction,
  ChaMap,
  DEFAULT_LOOP_BUDGET,
  MAX_CALL_DEPTH,
  RuntimeError,
  TOO_DEEP_MESSAGE,
  ThrowSignal,
  caughtValue,
  formatNumber,
  formatValue,
  isTruthy,
  loopBudgetMessage,
  typeName,
  valuesEqual,
  type NativeFunction,
  type Value,
} from './values'
import { createBuiltins, type ReadLine } from './builtins'

/** 字节码后端的运行时函数值：树遍历器的函数值形状 + chunk/upvalues */
export type VMClosure = ChaFunction & { chunk: Chunk; upvalues: Upvalue[] }

/** 一个 try 登记的处理器：catch 入口 + 进入 try 时的栈深 */
interface Handler {
  catchIp: number
  depth: number
}

interface Frame {
  closure: VMClosure
  /** 返回地址（字节码下标） */
  ip: number
  /** 本帧栈槽窗口的起始下标：参数在 base..base+arity-1 */
  base: number
  /** 帧内活跃的 try 处理器栈；没有 try 时不分配 */
  handlers: Handler[] | null
}

/** catch 到的值：throw 出去什么就是什么；内建与语言内部的错误给那条中文消息 */
function catchValueOf(e: unknown): Value | undefined {
  if (e instanceof ThrowSignal) return e.value
  if (e instanceof RuntimeError) return caughtValue(e)
  return undefined
}

export interface VMOptions {
  output?: (text: string) => void
  clock?: () => number
  /** 循环轮数预算（数循环体进了多少轮，不是指令数）；超了就报错，默认 DEFAULT_LOOP_BUDGET */
  loopBudget?: number
  /** 每条指令执行前的轨迹回调（调试/教学用） */
  trace?: (info: { addr: number; op: string; sp: number; base: number }) => void
  /** input() 的数据来源；不提供则 input() 报「宿主没有提供标准输入」 */
  readLine?: ReadLine | null
}

export class VirtualMachine {
  private stack: Value[] = []
  private sp = 0
  private frames: Frame[] = []
  private openUpvalues: Upvalue[] = []
  /** 原生调用复用同一个参数数组：内建函数全部同步读取、不回调 VM，可安全共享 */
  private nativeArgs: Value[] = []
  readonly globals = new Map<string, Value>()
  private output: (text: string) => void
  private clock: () => number
  private loopBudget: number
  private loops = 0
  private trace?: VMOptions['trace']

  constructor(options: VMOptions = {}) {
    this.output = options.output ?? (() => {})
    this.clock = options.clock ?? (() => Date.now() / 1000)
    this.loopBudget = options.loopBudget ?? DEFAULT_LOOP_BUDGET
    this.trace = options.trace
    for (const native of createBuiltins(this.output, this.clock, options.readLine ?? null)) {
      this.globals.set(native.name, native)
    }
  }

  /** 执行一个顶层函数原型（compile() 的产物），直至 RETURN */
  execute(proto: VMFunction): void {
    this.loops = 0
    // 上一次运行可能出错停在半路：unwind 会把帧弹光，栈高却留在任意位置。
    // 顶层帧固定从 base 0 开始，所以这里必须把栈恢复到干净状态。
    this.frames.length = 0
    this.openUpvalues.length = 0
    this.sp = 0
    this.frames.push({ closure: this.makeClosure(proto, []), ip: 0, base: 0, handlers: null })
    this.run()
  }

  private makeClosure(proto: VMFunction, upvalues: Upvalue[]): VMClosure {
    return {
      type: 'function',
      name: proto.name,
      params: proto.paramNames,
      body: [],
      chunk: proto.chunk,
      upvalues,
    }
  }

  // ---------- 主循环 ----------

  /**
   * 跑到底：指令循环一出错就先去登记过的处理器里找落点，接住了就从中断处继续跑；
   * 一路没人接就把错误原样交给宿主（run()/runVM() 折算成结构化信息）。
   */
  private run(): void {
    for (;;) {
      try {
        this.dispatch()
        return
      } catch (e) {
        if (!this.unwind(e)) throw e
      }
    }
  }

  /** 把错误交给本帧或某个调用者的 catch */
  private unwind(e: unknown): boolean {
    const value = catchValueOf(e)
    if (value === undefined) return false // return / break / continue 不是错误，原样往上抛
    while (this.frames.length > 0) {
      const frame = this.frames[this.frames.length - 1]!
      const handler = frame.handlers?.pop()
      if (handler) {
        // catch 体眼前的世界：try 里的临时值全部消失，抛出值压在栈顶（槽位就是 catch 参数）
        this.closeUpvaluesFrom(handler.depth)
        this.sp = handler.depth
        this.stack[this.sp++] = value
        frame.ip = handler.catchIp
        return true
      }
      // 本帧没人接：关掉它的 upvalue、弹帧，到调用者里接着找
      this.closeUpvaluesFrom(frame.base)
      this.frames.pop()
      this.sp = frame.base - 1
    }
    return false
  }

  private dispatch(): void {
    const stack = this.stack
    let frame = this.frames[this.frames.length - 1]!
    let code = frame.closure.chunk.code
    let lines = frame.closure.chunk.lines
    let cols = frame.closure.chunk.cols
    let constants = frame.closure.chunk.constants
    let ip = frame.ip

    const err = (at: number, message: string): RuntimeError =>
      new RuntimeError(message, lines[at]!, cols[at]!)

    while (true) {
      const start = ip
      if (this.trace) {
        this.trace({ addr: start, op: Op[code[start]!] ?? `op${code[start]}`, sp: this.sp, base: frame.base })
      }
      switch (code[ip++]!) {
        case Op.CONST: {
          stack[this.sp] = constants[code[ip]! | (code[ip + 1]! << 8)] as Value
          this.sp++
          ip += 2
          break
        }
        case Op.NIL:
          stack[this.sp++] = null
          break
        case Op.TRUE:
          stack[this.sp++] = true
          break
        case Op.FALSE:
          stack[this.sp++] = false
          break
        case Op.POP:
          this.sp--
          break
        case Op.DUP:
          stack[this.sp] = stack[this.sp - 1]!
          this.sp++
          break
        case Op.DUP2:
          stack[this.sp] = stack[this.sp - 2]!
          stack[this.sp + 1] = stack[this.sp - 1]!
          this.sp += 2
          break
        case Op.SWAP: {
          const top = stack[this.sp - 1]!
          stack[this.sp - 1] = stack[this.sp - 2]!
          stack[this.sp - 2] = top
          break
        }
        case Op.PICK:
          stack[this.sp] = stack[this.sp - code[ip++]!]!
          this.sp++
          break

        case Op.GET_LOCAL:
          stack[this.sp] = stack[frame.base + (code[ip]! | (code[ip + 1]! << 8))]!
          this.sp++
          ip += 2
          break
        case Op.SET_LOCAL:
          stack[frame.base + (code[ip]! | (code[ip + 1]! << 8))] = stack[this.sp - 1]!
          ip += 2
          break

        case Op.GET_GLOBAL: {
          const name = constants[code[ip]! | (code[ip + 1]! << 8)] as string
          ip += 2
          const value = this.globals.get(name)
          if (value === undefined) throw err(start, `未定义的变量 '${name}'`)
          stack[this.sp++] = value
          break
        }
        case Op.SET_GLOBAL: {
          const name = constants[code[ip]! | (code[ip + 1]! << 8)] as string
          ip += 2
          if (!this.globals.has(name)) throw err(start, `未定义的变量 '${name}'`)
          this.globals.set(name, stack[this.sp - 1]!)
          break
        }
        case Op.DEFINE_GLOBAL: {
          const name = constants[code[ip]! | (code[ip + 1]! << 8)] as string
          ip += 2
          this.globals.set(name, stack[this.sp - 1]!)
          this.sp--
          break
        }

        case Op.GET_UPVALUE: {
          const up = frame.closure.upvalues[code[ip++]!]!
          stack[this.sp++] = up.slot !== null ? stack[up.slot]! : up.closed!
          break
        }
        case Op.SET_UPVALUE: {
          const up = frame.closure.upvalues[code[ip++]!]!
          if (up.slot !== null) stack[up.slot] = stack[this.sp - 1]!
          else up.closed = stack[this.sp - 1]!
          break
        }

        case Op.CLOSE_UPVALUES: {
          const minSlot = frame.base + (code[ip]! | (code[ip + 1]! << 8))
          ip += 2
          this.closeUpvaluesFrom(minSlot)
          break
        }

        case Op.GET_INDEX: {
          const index = stack[this.sp - 1]!
          const target = stack[this.sp - 2]!
          this.sp--
          stack[this.sp - 1] = this.readIndex(start, target, index)
          break
        }
        case Op.SET_INDEX: {
          const value = stack[this.sp - 1]!
          const index = stack[this.sp - 2]!
          const target = stack[this.sp - 3]!
          this.writeIndex(start, target, index, value)
          this.sp -= 2
          stack[this.sp - 1] = value
          break
        }

        case Op.ARRAY: {
          const n = code[ip]! | (code[ip + 1]! << 8)
          ip += 2
          stack[this.sp - n] = stack.slice(this.sp - n, this.sp)
          this.sp -= n - 1
          break
        }
        case Op.MAP: {
          const pairs = code[ip]! | (code[ip + 1]! << 8)
          ip += 2
          const first = this.sp - pairs * 2
          const map = new ChaMap()
          for (let i = 0; i < pairs; i++) map.map.set(stack[first + i * 2]!, stack[first + i * 2 + 1]!)
          this.sp = first + 1
          stack[first] = map
          break
        }

        case Op.NEG: {
          const v = stack[this.sp - 1]!
          if (typeof v !== 'number') throw err(start, `一元 '-' 只能用于数字，得到的是 ${typeName(v)}`)
          stack[this.sp - 1] = -v
          break
        }
        case Op.NOT:
          stack[this.sp - 1] = !isTruthy(stack[this.sp - 1]!)
          break

        case Op.ADD: {
          const right = stack[this.sp - 1]!
          const left = stack[this.sp - 2]!
          this.sp--
          if (typeof left === 'number' && typeof right === 'number') stack[this.sp - 1] = left + right
          else if (typeof left === 'string' && typeof right === 'string') stack[this.sp - 1] = left + right
          else
            throw err(
              start,
              `加法 '+' 需要两个数字或两个字符串，得到 ${typeName(left)} + ${typeName(right)}；混排请用 "\${...}" 插值`
            )
          break
        }
        case Op.SUB: {
          const right = stack[this.sp - 1]!
          const left = stack[this.sp - 2]!
          this.sp--
          if (typeof left !== 'number' || typeof right !== 'number')
            throw err(start, `运算 '-' 需要两个数字，得到 ${typeName(left)} 和 ${typeName(right)}`)
          stack[this.sp - 1] = left - right
          break
        }
        case Op.MUL: {
          const right = stack[this.sp - 1]!
          const left = stack[this.sp - 2]!
          this.sp--
          if (typeof left !== 'number' || typeof right !== 'number')
            throw err(start, `运算 '*' 需要两个数字，得到 ${typeName(left)} 和 ${typeName(right)}`)
          stack[this.sp - 1] = left * right
          break
        }
        case Op.DIV: {
          const right = stack[this.sp - 1]!
          const left = stack[this.sp - 2]!
          this.sp--
          if (typeof left !== 'number' || typeof right !== 'number')
            throw err(start, `运算 '/' 需要两个数字，得到 ${typeName(left)} 和 ${typeName(right)}`)
          if (right === 0) throw err(start, '除数不能为 0')
          stack[this.sp - 1] = left / right
          break
        }
        case Op.MOD: {
          const right = stack[this.sp - 1]!
          const left = stack[this.sp - 2]!
          this.sp--
          if (typeof left !== 'number' || typeof right !== 'number')
            throw err(start, `运算 '%' 需要两个数字，得到 ${typeName(left)} 和 ${typeName(right)}`)
          if (right === 0) throw err(start, '取模的除数不能为 0')
          stack[this.sp - 1] = left % right
          break
        }
        case Op.EQ: {
          const right = stack[this.sp - 1]!
          const left = stack[this.sp - 2]!
          this.sp--
          stack[this.sp - 1] = valuesEqual(left, right)
          break
        }
        case Op.NEQ: {
          const right = stack[this.sp - 1]!
          const left = stack[this.sp - 2]!
          this.sp--
          stack[this.sp - 1] = !valuesEqual(left, right)
          break
        }
        case Op.LT:
        case Op.GT:
        case Op.LTE:
        case Op.GTE: {
          const right = stack[this.sp - 1]!
          const left = stack[this.sp - 2]!
          this.sp--
          stack[this.sp - 1] = this.compare(start, code[start]!, left, right)
          break
        }

        case Op.JUMP: {
          const offset = code[ip]! | (code[ip + 1]! << 8)
          ip += 2 + offset
          break
        }
        case Op.JUMP_IF_FALSE: {
          const offset = code[ip]! | (code[ip + 1]! << 8)
          ip += 2
          if (!isTruthy(stack[--this.sp]!)) ip += offset
          break
        }
        case Op.JUMP_IF_FALSE_PEEK: {
          const offset = code[ip]! | (code[ip + 1]! << 8)
          ip += 2
          // 跳转时左值就是结果（不弹）；未跳转由编译器安排的 POP 弹掉左值
          if (!isTruthy(stack[this.sp - 1]!)) ip += offset
          break
        }
        case Op.JUMP_IF_TRUE_PEEK: {
          const offset = code[ip]! | (code[ip + 1]! << 8)
          ip += 2
          if (isTruthy(stack[this.sp - 1]!)) ip += offset
          break
        }
        case Op.LOOP: {
          const offset = code[ip]! | (code[ip + 1]! << 8)
          ip += 2 - offset
          // 一次回跳 = 一轮循环体，树遍历器在同一个语义点计数，两边才能同轮报错
          if (++this.loops > this.loopBudget) throw err(start, loopBudgetMessage(this.loopBudget))
          break
        }

        case Op.TRY: {
          const offset = code[ip]! | (code[ip + 1]! << 8)
          ip += 2
          const handlers = frame.handlers ?? (frame.handlers = [])
          handlers.push({ catchIp: ip + offset, depth: this.sp })
          break
        }
        case Op.END_TRY:
          // try 体正常走完：这个 catch 不再接收后面的错误
          frame.handlers?.pop()
          break
        case Op.THROW: {
          const value = stack[--this.sp]!
          throw new ThrowSignal(value, lines[start]!, cols[start]!)
        }

        case Op.CALL: {
          const argc = code[ip++]!
          const callee = stack[this.sp - 1 - argc]!
          if (typeof callee === 'object' && callee !== null && 'type' in callee) {
            if (callee.type === 'native') {
              const native = callee as NativeFunction
              if (native.arity !== 'variadic' && argc !== native.arity) {
                throw err(start, `${native.name}() 需要 ${native.arity} 个参数，收到 ${argc} 个`)
              }
              const args = this.nativeArgs
              args.length = argc
              for (let i = 0; i < argc; i++) args[i] = stack[this.sp - argc + i]!
              let result: Value
              try {
                result = native.fn(args)
              } catch (e) {
                // 内建函数抛出的 RuntimeError 无行列信息（0,0），改挂到调用点
                if (e instanceof RuntimeError && e.line === 0) {
                  throw new RuntimeError(e.message.replace(/^\[line 0, col 0\] /, ''), lines[start]!, cols[start]!)
                }
                throw e
              }
              this.sp -= argc + 1
              stack[this.sp++] = result
              break
            }
            if (callee.type === 'function') {
              // VM 里能遇到的函数值都是本 VM 编译产物的闭包
              const fn = callee as VMClosure
              if (argc !== fn.params.length) {
                throw err(
                  start,
                  `函数 ${fn.name ?? '(匿名)'}() 需要 ${fn.params.length} 个参数，收到 ${argc} 个`
                )
              }
              // 返回地址写回父帧，子帧从 0 开始执行
              frame.ip = ip
              // 顶层脚本帧不算一次 cha 调用，减掉才能和树遍历器的 depth 同点触发
              if (this.frames.length - 1 >= MAX_CALL_DEPTH) throw err(start, TOO_DEEP_MESSAGE)
              this.frames.push({ closure: fn, ip: 0, base: this.sp - argc, handlers: null })
              frame = this.frames[this.frames.length - 1]!
              code = frame.closure.chunk.code
              lines = frame.closure.chunk.lines
              cols = frame.closure.chunk.cols
              constants = frame.closure.chunk.constants
              ip = 0
              break
            }
          }
          throw err(start, `${typeName(callee)} 不是函数，不能调用`)
        }

        case Op.RETURN: {
          const result = stack[this.sp - 1]!
          const base = frame.base
          this.closeUpvaluesFrom(base)
          this.frames.pop()
          if (this.frames.length === 0) {
            this.sp = 0
            stack[0] = result
            this.sp = 1
            return
          }
          this.sp = base
          stack[this.sp - 1] = result
          frame = this.frames[this.frames.length - 1]!
          code = frame.closure.chunk.code
          lines = frame.closure.chunk.lines
          cols = frame.closure.chunk.cols
          constants = frame.closure.chunk.constants
          ip = frame.ip
          break
        }

        case Op.TEMPLATE: {
          const info = constants[code[ip]! | (code[ip + 1]! << 8)] as TemplateInfo
          ip += 2
          const { parts, count } = info
          let text = parts[0] ?? ''
          for (let i = 0; i < count; i++) {
            text += formatValue(stack[this.sp - count + i]!)
            text += parts[i + 1] ?? ''
          }
          this.sp -= count
          stack[this.sp++] = text
          break
        }

        case Op.CLOSURE: {
          const proto = constants[code[ip]! | (code[ip + 1]! << 8)] as VMFunction
          ip += 2
          const upvalues: Upvalue[] = []
          for (let i = 0; i < proto.upvalueCount; i++) {
            const isLocal = code[ip++]!
            const index = code[ip++]!
            if (isLocal) {
              const slot = frame.base + index
              const existing = this.openUpvalues.find((up) => up.slot === slot)
              upvalues.push(existing ?? this.openUpvalues[this.openUpvalues.push({ slot, closed: undefined }) - 1]!)
            } else {
              // 直接词法父函数就是当前帧，复制它的 upvalue
              upvalues.push(frame.closure.upvalues[index]!)
            }
          }
          stack[this.sp++] = this.makeClosure(proto, upvalues)
          break
        }

        default:
          throw err(start, `内部错误：未知指令 ${code[start]}（位于 ${start}）`)
      }
    }
  }

  // ---------- 与树遍历器逐字对齐的运行时操作 ----------

  private compare(
    at: number,
    op: Op,
    left: Value,
    right: Value
  ): boolean {
    const opChar = op === Op.LT ? '<' : op === Op.GT ? '>' : op === Op.LTE ? '<=' : '>='
    if (typeof left === 'number' && typeof right === 'number') {
      switch (op) {
        case Op.LT:
          return left < right
        case Op.GT:
          return left > right
        case Op.LTE:
          return left <= right
        default:
          return left >= right
      }
    }
    if (typeof left === 'string' && typeof right === 'string') {
      switch (op) {
        case Op.LT:
          return left < right
        case Op.GT:
          return left > right
        case Op.LTE:
          return left <= right
        default:
          return left >= right
      }
    }
    throw new RuntimeError(`比较运算 '${opChar}' 只能用于两个数字或两个字符串`, this.currentLine(at), this.currentCol(at))
  }

  private currentLine(at: number): number {
    const frame = this.frames[this.frames.length - 1]!
    return frame.closure.chunk.lines[at]!
  }

  private currentCol(at: number): number {
    const frame = this.frames[this.frames.length - 1]!
    return frame.closure.chunk.cols[at]!
  }

  /** 下标操作用的错误构造：热路径上不再每次分配闭包 */
  private errAt(at: number, message: string): RuntimeError {
    return new RuntimeError(message, this.currentLine(at), this.currentCol(at))
  }

  /** 关闭 slot >= minSlot 的开放 upvalue（原地压缩，避免每次作用域退出都新建数组） */
  private closeUpvaluesFrom(minSlot: number): void {
    const stack = this.stack
    const list = this.openUpvalues
    let keep = 0
    for (let i = 0; i < list.length; i++) {
      const up = list[i]!
      if (up.slot !== null && up.slot >= minSlot) {
        up.closed = stack[up.slot]
        up.slot = null
      } else {
        list[keep++] = up
      }
    }
    list.length = keep
  }

  private readIndex(at: number, target: Value, index: Value): Value {
    if (Array.isArray(target)) {
      if (typeof index !== 'number' || !Number.isInteger(index)) {
        throw this.errAt(at, `数组下标必须是整数，得到 ${formatValue(index)}`)
      }
      if (index < 0 || index >= target.length) {
        throw this.errAt(at, `数组下标越界：长度 ${target.length}，下标 ${formatNumber(index)}`)
      }
      return target[index]!
    }
    if (target instanceof ChaMap) {
      return target.map.get(index) ?? null
    }
    if (typeof target === 'string') {
      if (typeof index !== 'number' || !Number.isInteger(index)) {
        throw this.errAt(at, `字符串下标必须是整数，得到 ${formatValue(index)}`)
      }
      if (index < 0 || index >= target.length) {
        throw this.errAt(at, `字符串下标越界：长度 ${target.length}，下标 ${formatNumber(index)}`)
      }
      return target[index]!
    }
    throw this.errAt(at, `${typeName(target)} 不支持下标访问`)
  }

  private writeIndex(at: number, target: Value, index: Value, value: Value): void {
    if (Array.isArray(target)) {
      if (typeof index !== 'number' || !Number.isInteger(index)) {
        throw this.errAt(at, `数组下标必须是整数，得到 ${formatValue(index)}`)
      }
      if (index < 0 || index >= target.length) {
        throw this.errAt(at, `数组下标越界：长度 ${target.length}，下标 ${formatNumber(index)}`)
      }
      target[index] = value
      return
    }
    if (target instanceof ChaMap) {
      target.map.set(index, value)
      return
    }
    throw this.errAt(at, `${typeName(target)} 不支持按下标赋值`)
  }
}
