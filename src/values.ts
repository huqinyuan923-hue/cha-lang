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

/**
 * print 次数预算。循环预算挡不住「循环不多、每轮狂打印」的形状：
 * 浏览器里几十万行输出会把 DOM 和内存一起拖垮。数的是 print 调用次数，
 * 宿主按容忍度自行设置（Playground 给 2 万行，CLI 流式写 stdout 不设上限）。
 */
export const outputLimitMessage = (limit: number): string =>
  `输出太多行了（超过 ${limit} 行），已停止运行`

/**
 * range() 一次最多分配多少个元素。range(0, Infinity) 或超大跨度会直接
 * 申请一个几十 GB 的数组，循环预算还没来得及计数就先 OOM；分配前先按
 * 跨度估算，超限就报这条错，两个后端共用同一份实现与文案。
 */
export const DEFAULT_MAX_RANGE_LENGTH = 10_000_000

export const rangeLimitMessage = (limit: number): string =>
  `range() 一次生成太多元素（超过 ${limit} 个），已停止分配`

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
  /** init 构造方法：返回时一律把实例本身交还给调用者 */
  isInitializer?: boolean
}

/** 方法表的值：树遍历器存闭包，VM 存带 upvalue 的 VMClosure */
export class ChaClass {
  readonly type = 'class'
  constructor(
    readonly name: string,
    public superclass: ChaClass | null,
    readonly methods = new Map<string, ChaFunction>()
  ) {}

  /** 沿父类链找方法；找不到返回 null */
  findMethod(name: string): ChaFunction | null {
    const own = this.methods.get(name)
    if (own !== undefined) return own
    return this.superclass?.findMethod(name) ?? null
  }
}

export class ChaInstance {
  readonly type = 'instance'
  readonly fields = new Map<string, Value>()
  constructor(readonly klass: ChaClass) {}
}

/** 从实例上取到的方法值：调用时把接收者放在 this 上 */
export interface BoundMethod {
  type: 'boundMethod'
  receiver: ChaInstance
  method: ChaFunction
}

/** 两个后端共用的类相关错误文案 */
export const classArityMessage = (className: string, arity: number, argc: number): string =>
  `类 ${className}() 需要 ${arity} 个参数，收到 ${argc} 个`

export const instanceMissingPropertyMessage = (className: string, key: string): string =>
  `实例 ${className} 没有属性 '${key}'`

export const instanceKeyMessage = (className: string, index: Value): string =>
  `实例 ${className} 的属性名必须是字符串，得到 ${formatValue(index)}`

export const superMissingMethodMessage = (className: string, name: string): string =>
  `父类 ${className} 没有方法 '${name}'`

export const superclassNotClassMessage = (className: string, got: Value): string =>
  `类 ${className} 只能继承另一个类，得到 ${typeName(got)}`

export interface NativeFunction {
  type: 'native'
  name: string
  arity: number | 'variadic'
  /** 行列信息由调用点兜底（内建函数内部抛 0,0，call() 会改挂到调用点） */
  fn: (args: Value[]) => Value
}

export type Value =
  | number
  | string
  | boolean
  | null
  | Value[]
  | ChaMap
  | ChaFunction
  | NativeFunction
  | ChaClass
  | ChaInstance
  | BoundMethod

/** map 用 JS Map 承载：保持插入序、支持任意键类型 */
export class ChaMap {
  readonly map = new Map<Value, Value>()
}

export type EnvSlot = { value: Value; initialized: boolean }

export class Environment {
  private values = new Map<string, EnvSlot>()

  constructor(public parent?: Environment) {}

  declare(name: string, value: Value, initialized = true): void {
    this.values.set(name, { value, initialized })
  }

  /** 沿作用域链找一次名字，每层只查一次 Map（动态查找的公共路径） */
  find(name: string): EnvSlot | undefined {
    let env: Environment | undefined = this
    while (env) {
      const slot = env.values.get(name)
      if (slot) return slot
      env = env.parent
    }
    return undefined
  }

  /** 沿作用域链找到就写入并返回 true；找不到返回 false */
  assignDynamic(name: string, value: Value): boolean {
    let env: Environment | undefined = this
    while (env) {
      const slot = env.values.get(name)
      if (slot) {
        slot.value = value
        slot.initialized = true
        return true
      }
      env = env.parent
    }
    return false
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
  if (v instanceof ChaClass) return 'class'
  if (v instanceof ChaInstance) return 'instance'
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
  if (v instanceof ChaClass) return `<class ${v.name}>`
  if (v instanceof ChaInstance) return `<${v.klass.name} 实例>`
  if (v.type === 'boundMethod') return `<fn ${v.method.name ?? '匿名'}>`
  if (v.type === 'function') return `<fn ${v.name ?? '匿名'}>`
  return '<native fn>'
}

function formatKey(k: Value): string {
  if (typeof k === 'string') return `"${k}"`
  return formatValue(k)
}

const TRACE_PREVIEW_ITEMS = 6
const TRACE_PREVIEW_DEPTH = 2

/**
 * 轨迹快照里的值文本：容器只取头部与有限深度，绝不把整个大数组/大 map
 * 拼成字符串——5000 条轨迹每条都全量 formatValue 会直接卡死浏览器。
 */
export function formatTraceValue(v: Value, max = 60): string {
  const text = tracePreview(v, 0)
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function tracePreview(v: Value, depth: number): string {
  if (typeof v === 'string') return truncateTraceString(v)
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]'
    if (depth >= TRACE_PREVIEW_DEPTH) return '[…]'
    const parts = v.slice(0, TRACE_PREVIEW_ITEMS).map((item) => tracePreview(item, depth + 1))
    if (v.length > TRACE_PREVIEW_ITEMS) parts.push('…')
    return `[${parts.join(', ')}]`
  }
  if (v instanceof ChaMap) {
    if (v.map.size === 0) return '{}'
    if (depth >= TRACE_PREVIEW_DEPTH) return '{…}'
    const parts: string[] = []
    let shown = 0
    for (const [k, val] of v.map) {
      if (shown === TRACE_PREVIEW_ITEMS) {
        parts.push('…')
        break
      }
      parts.push(`${traceKey(k)}: ${tracePreview(val, depth + 1)}`)
      shown += 1
    }
    return `{${parts.join(', ')}}`
  }
  return formatValue(v)
}

function traceKey(k: Value): string {
  if (typeof k === 'string') return `"${truncateTraceString(k)}"`
  return tracePreview(k, TRACE_PREVIEW_DEPTH)
}

function truncateTraceString(s: string): string {
  return s.length > 60 ? `${s.slice(0, 59)}…` : s
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
