/** 运行时值系统：数字、字符串、布尔、nil、数组、map、函数 */

export interface ChaFunction {
  type: 'function'
  name?: string
  params: string[]
  body: import('./ast').Stmt[]
  /** 闭包：定义时的作用域 */
  closure: Environment
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
