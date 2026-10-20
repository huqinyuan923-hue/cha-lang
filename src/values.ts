/** 运行时值系统：数字、字符串、布尔、nil、数组、map、函数 */

/** 运行时错误：line/col 为 0 表示「由内建函数抛出，等待调用点归位」 */
export class RuntimeError extends Error {
  constructor(
    message: string,
    public line: number = 0,
    public col: number = 0
  ) {
    super(line === 0 ? message : `[line ${line}, col ${col}] ${message}`)
    this.name = 'RuntimeError'
  }
}

/**
 * 用户 throw 出去的值。借 JS 异常做非局部跳转（与 break/continue/return 同一套路），
 * 树遍历器靠它穿透递归调用，字节码 VM 靠它穿透帧。line/col 是 throw 语句自己的位置：
 * 一路没人接住时，报错就得用它。
 */
export class ThrowSignal extends Error {
  constructor(
    public value: Value,
    public line: number,
    public col: number
  ) {
    super(`[line ${line}, col ${col}] throw`)
    this.name = 'ThrowError'
  }
}

/** 没人接住的 throw 显示成什么：文案只由这里产出，两个后端才能逐字一致 */
export const uncaughtThrowMessage = (v: Value): string =>
  `throw 抛出的值未被捕获：${formatValue(v)}`

/**
 * catch 到的值：语言内部与内建函数的运行时错误给的是它的中文消息（去掉内部位置前缀），
 * 用户 throw 的东西则原样给出。cha 还没有「错误对象」这种类型，消息字符串是最省心的选择。
 */
export const caughtValue = (e: RuntimeError): string =>
  e.message.replace(/^\[line \d+, col \d+\] /, '')

/**
 * 调用深度上限。树遍历器消耗的是 JS 调用栈，VM 只在自己的帧数组上增长，
 * 两边都在进函数前检查同一个数，失控递归才能得到同一条中文错误（带调用点行列），
 * 而不是一个泄漏 RangeError、另一个无声涨内存。
 *
 * 500 是量出来的：Playground 里最费栈的形状（每层再套一个闭包调用）在 Chromium
 * 大约 860 层就把 JS 栈吃满，那时只能靠 RangeError 兜底，报错调用点会比 VM 差一层。
 * 留出这个余量，桌面和手机浏览器里两个后端都先撞计数器，行列才逐字一致。
 */
export const MAX_CALL_DEPTH = 500

/** 两个后端共用的错误文案，保证差分测试逐字一致 */
export const TOO_DEEP_MESSAGE = `递归太深：调用深度超过 ${MAX_CALL_DEPTH} 层，可能没有出口`

/**
 * 循环轮数预算的默认值。宿主可以按自己的容忍度改：CLI 挂在那里没人看，
 * 给足算力；浏览器打字时自动重跑，几百毫秒就得停下来。
 * 预算数的是「循环体进了多少轮」，两个后端在同一个语义点计数（VM 的 LOOP 回跳 /
 * 树遍历器的迭代收尾），所以嵌套、break、continue 都算得一一对齐。
 */
export const DEFAULT_LOOP_BUDGET = 20_000_000

/** 同样是为了两个后端逐字一致：文案只由这里产出 */
export const loopBudgetMessage = (budget: number): string =>
  `循环跑了太多轮（超过 ${budget} 轮），疑似死循环`

export interface ChaFunction {
  type: 'function'
  name?: string
  params: string[]
  body: import('./ast').Stmt[]
  /** 闭包：定义时的作用域（字节码后端的函数值没有这个字段） */
  closure?: Environment
  /** 字节码后端专属：编译产物与捕获的 upvalue（树遍历器不使用） */
  chunk?: import('./chunk').Chunk
  upvalues?: import('./chunk').Upvalue[]
}

export interface NativeFunction {
  type: 'native'
  name: string
  arity: number | 'variadic'
  /** 行列信息由调用点兜底（内建函数内部抛 0,0，call() 会改挂到调用点） */
  fn: (args: Value[]) => Value
}

export type Value = number | string | boolean | null | Value[] | ChaMap | ChaFunction | NativeFunction

/** map 用 JS Map 承载：保持插入序、支持任意键类型 */
export class ChaMap {
  readonly map = new Map<Value, Value>()
}

export class Environment {
  private values = new Map<string, { value: Value; initialized: boolean }>()

  constructor(public parent?: Environment) {}

  declare(name: string, value: Value, initialized = true): void {
    this.values.set(name, { value, initialized })
  }

  isDeclared(name: string): boolean {
    return this.values.has(name)
  }

  isInitialized(name: string): boolean {
    return this.values.get(name)?.initialized === true
  }

  /** 沿作用域链向上走 dist 步取值（dist 由 resolver 预计算，0 = 当前层） */
  get(name: string, dist: number): Value {
    const scope = this.ancestor(dist)
    const slot = scope.values.get(name)
    if (!slot) throw new Error(`内部错误：变量 ${name} 未在预期作用域中`)
    if (!slot.initialized) throw new Error(`变量 ${name} 在声明前不可使用`)
    return slot.value
  }

  assign(name: string, dist: number, value: Value): void {
    const scope = this.ancestor(dist)
    const slot = scope.values.get(name)
    if (!slot) throw new Error(`内部错误：变量 ${name} 未在预期作用域中`)
    slot.value = value
    slot.initialized = true
  }

  private ancestor(dist: number): Environment {
    let env: Environment = this
    for (let i = 0; i < dist; i++) {
      if (!env.parent) throw new Error(`内部错误：作用域链深度超出（还差 ${dist - i} 层）`)
      env = env.parent
    }
    return env
  }
}

// ---------- 值的通用操作 ----------

export function typeName(v: Value): string {
  if (v === null) return 'nil'
  if (typeof v === 'number') return 'number'
  if (typeof v === 'string') return 'string'
  if (typeof v === 'boolean') return 'bool'
  if (Array.isArray(v)) return 'array'
  if (v instanceof ChaMap) return 'map'
  if ('type' in v) return 'function'
  return 'unknown'
}

/** false 与 nil 为假，其余一切为真（0 也是真值——写进文档的特点） */
export function isTruthy(v: Value): boolean {
  if (v === null) return false
  if (typeof v === 'boolean') return v
  return true
}

/**
 * 数字的显示格式：整数去掉小数点；小数用 15 位有效数字清洗浮点误差，
 * 让 0.1 + 0.2 显示为 0.3 而不是 0.30000000000000004
 */
export function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n)
  if (!Number.isFinite(n)) return n > 0 ? 'inf' : Number.isNaN(n) ? 'nan' : '-inf'
  const cleaned = Number(n.toPrecision(15))
  return String(cleaned)
}

/** 值的展示格式（print / str 共用） */
export function formatValue(v: Value): string {
  if (v === null) return 'nil'
  if (typeof v === 'number') return formatNumber(v)
  if (typeof v === 'string') return v
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (Array.isArray(v)) return `[${v.map(formatValue).join(', ')}]`
  if (v instanceof ChaMap) {
    const parts: string[] = []
    for (const [k, val] of v.map) parts.push(`${formatKey(k)}: ${formatValue(val)}`)
    return `{${parts.join(', ')}}`
  }
  if (v.type === 'function') return `<fn ${v.name ?? '匿名'}>`
  return '<native fn>'
}

function formatKey(k: Value): string {
  if (typeof k === 'string') return `"${k}"`
  return formatValue(k)
}

/** str() 与 print() 的区别：字符串会带引号 */
export function inspectValue(v: Value): string {
  if (typeof v === 'string') return `"${v}"`
  return formatValue(v)
}

/** 深相等：数组与 map 递归比较，其余按值 */
export function valuesEqual(a: Value, b: Value): boolean {
  if (a === null && b === null) return true
  if (typeof a === 'number' && typeof b === 'number') return a === b
  if (typeof a === 'string' && typeof b === 'string') return a === b
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((x, i) => valuesEqual(x, b[i]!))
  }
  if (a instanceof ChaMap && b instanceof ChaMap) {
    if (a.map.size !== b.map.size) return false
    for (const [k, v] of a.map) {
      if (!b.map.has(k) || !valuesEqual(v, b.map.get(k)!)) return false
    }
    return true
  }
  return a === b
}
