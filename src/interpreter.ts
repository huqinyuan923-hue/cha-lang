import type { Expr, Program, Stmt } from './ast'
import { createBuiltins, type ReadLine } from './builtins'
import {
  ChaClass,
  ChaInstance,
  ChaMap,
  DEFAULT_LOOP_BUDGET,
  DEFAULT_MAX_RANGE_LENGTH,
  Environment,
  MAX_CALL_DEPTH,
  RuntimeError,
  TOO_DEEP_MESSAGE,
  ThrowSignal,
  caughtValue,
  classArityMessage,
  formatNumber,
  formatValue,
  instanceKeyMessage,
  instanceMissingPropertyMessage,
  isTruthy,
  loopBudgetMessage,
  superclassNotClassMessage,
  superMissingMethodMessage,
  typeName,
  valuesEqual,
  type BoundMethod,
  type ChaFunction,
  type NativeFunction,
  type Value,
} from './values'

export { RuntimeError }

/** 控制流信号：用异常实现 return / break / continue 的非局部跳转 */
class BreakSignal {}
class ContinueSignal {}
class ReturnSignal {
  constructor(public value: Value) {}
}

/** 这条异常该不该交给 catch：throw 给原值，内建与语言内部的错误给它的中文消息 */
function catchBinding(e: unknown): { value: Value } | null {
  if (e instanceof ThrowSignal) return { value: e.value }
  if (e instanceof RuntimeError) return { value: caughtValue(e) }
  return null
}

/** 复合赋值的二元运算符：'+=' → '+'（索引取首字符，避免热点路径上分配字符串） */
function compoundOp(op: '+=' | '-=' | '*=' | '/=' | '%='): '+' | '-' | '*' | '/' | '%' {
  return op[0] as '+' | '-' | '*' | '/' | '%'
}

export interface InterpreterOptions {
  /** print 的去处（默认丢弃）；REPL/CLI 接 stdout，测试接数组 */
  output?: (text: string) => void
  clock?: () => number
  /** input() 的数据来源；不提供则 input() 报「宿主没有提供标准输入」 */
  readLine?: ReadLine | null
  /** 循环轮数预算，与 VM 同一语义（数循环体进了多少轮） */
  loopBudget?: number
  /** range() 单次最多分配的元素个数；默认 DEFAULT_MAX_RANGE_LENGTH */
  maxRangeLength?: number
}

type Resolutions = Map<Expr, number>

export class Interpreter {
  private globals = new Environment()
  private env = this.globals
  private output: (text: string) => void
  private clock: () => number
  private readLine: ReadLine | null
  /** 当前 cha 函数的调用深度，与 VM 的帧数用同一个上限，错误文案才能一致 */
  private depth = 0
  /** 已执行的循环轮数，与 VM 的 LOOP 回跳一一对应 */
  private loops = 0
  private loopBudget: number
  private maxRangeLength: number
  /** 用 WeakMap 累积：会话里早先声明的函数体还活着，它们的解析结果就不能丢 */
  private resolutions = new WeakMap<Expr, number>()

  constructor(resolutions: Resolutions, options: InterpreterOptions = {}) {
    this.addResolutions(resolutions)
    this.output = options.output ?? (() => {})
    this.clock = options.clock ?? (() => Date.now() / 1000)
    this.readLine = options.readLine ?? null
    this.loopBudget = options.loopBudget ?? DEFAULT_LOOP_BUDGET
    this.maxRangeLength = options.maxRangeLength ?? DEFAULT_MAX_RANGE_LENGTH
    this.installBuiltins()
  }

  /** REPL/会话场景：把新一段代码的解析结果并进当前表，早先函数的距离仍然有效 */
  addResolutions(resolutions: Resolutions): void {
    for (const [expr, dist] of resolutions) this.resolutions.set(expr, dist)
  }

  run(program: Program): void {
    this.loops = 0
    for (const stmt of program) this.execStmt(stmt)
  }

  /** 一轮循环体收尾：与 VM 执行 LOOP 回跳是同一个语义点 */
  private countLoop(stmt: Stmt): void {
    if (++this.loops > this.loopBudget) throw this.err(stmt, loopBudgetMessage(this.loopBudget))
  }

  // ---------- 语句 ----------

  private execStmts(stmts: Stmt[]): void {
    for (let i = 0; i < stmts.length; i++) this.execStmt(stmts[i]!)
  }

  private execStmt(stmt: Stmt): void {
    switch (stmt.type) {
      case 'exprStmt':
        this.evaluate(stmt.expr)
        return
      case 'var': {
        const value = stmt.initializer ? this.evaluate(stmt.initializer) : null
        this.env.declare(stmt.name, value, true)
        return
      }
      case 'fnDecl': {
        const fn = stmt.fn
        this.env.declare(fn.name!, {
          type: 'function',
          name: fn.name,
          params: fn.params,
          body: fn.body,
          closure: this.env,
        })
        return
      }
      case 'class': {
        // 父类先求值；类作用域无条件建出来（有无父类都不影响方法看到的层数）
        let superclass: ChaClass | null = null
        const classEnv = new Environment(this.env)
        if (stmt.superclass) {
          const v = this.evaluate(stmt.superclass)
          if (!(v instanceof ChaClass)) {
            throw this.err(stmt.superclass, superclassNotClassMessage(stmt.name, v))
          }
          superclass = v
          classEnv.declare('super', v, true)
        }
        const klass = new ChaClass(stmt.name, superclass)
        for (const m of stmt.methods) {
          klass.methods.set(m.name, {
            type: 'function',
            name: `${stmt.name}.${m.name}`,
            params: m.params,
            body: m.body,
            closure: classEnv,
            isInitializer: m.name === 'init',
          })
        }
        // 名字在方法体解析之后才写进环境也没关系：闭包持有的是同一个环境对象
        this.env.declare(stmt.name, klass, true)
        return
      }
      case 'block': {
        const prev = this.env
        this.env = new Environment(prev)
        try {
          this.execStmts(stmt.body)
        } finally {
          this.env = prev
        }
        return
      }
      case 'if': {
        if (isTruthy(this.evaluate(stmt.test))) this.execStmt(stmt.then)
        else if (stmt.else) this.execStmt(stmt.else)
        return
      }
      case 'while': {
        while (isTruthy(this.evaluate(stmt.test))) {
          try {
            this.execStmt(stmt.body)
          } catch (e) {
            if (e instanceof BreakSignal) break
            if (!(e instanceof ContinueSignal)) throw e
          }
          this.countLoop(stmt)
        }
        return
      }
      case 'for': {
        // 循环头里的 init 只活在 for 自己的作用域里
        const prev = this.env
        this.env = new Environment(prev)
        try {
          if (stmt.init) this.execStmt(stmt.init)
          while (stmt.test === undefined || isTruthy(this.evaluate(stmt.test))) {
            try {
              this.execStmt(stmt.body)
            } catch (e) {
              if (e instanceof BreakSignal) break
              if (!(e instanceof ContinueSignal)) throw e
            }
            if (stmt.update) this.evaluate(stmt.update)
            this.countLoop(stmt)
          }
        } finally {
          this.env = prev
        }
        return
      }
      case 'return': {
        const value = stmt.value ? this.evaluate(stmt.value) : null
        throw new ReturnSignal(value)
      }
      case 'break':
        throw new BreakSignal()
      case 'continue':
        throw new ContinueSignal()
      case 'throw':
        throw new ThrowSignal(this.evaluate(stmt.value), stmt.line, stmt.col)
      case 'try': {
        const prev = this.env
        let bound: { value: Value } | null = null
        try {
          this.env = new Environment(prev)
          this.execStmts(stmt.body)
          // try 体顺利跑完，catch 体一眼都不看（VM 那边由 END_TRY + JUMP 跳过）
          return
        } catch (e) {
          // return / break / continue 不是错误，照常往外穿透
          bound = catchBinding(e)
          if (!bound) throw e
        } finally {
          this.env = prev
        }
        this.env = new Environment(prev)
        try {
          this.env.declare(stmt.catchParam, bound!.value, true)
          this.execStmts(stmt.catchBody)
        } finally {
          this.env = prev
        }
        return
      }
    }
  }

  // ---------- 表达式 ----------

  private evaluate(expr: Expr): Value {
    switch (expr.type) {
      case 'literal':
        return expr.value
      case 'identifier':
        return this.lookup(expr)
      case 'template': {
        let text = expr.parts[0] ?? ''
        for (let i = 0; i < expr.exprs.length; i++) {
          text += formatValue(this.evaluate(expr.exprs[i]!))
          text += expr.parts[i + 1] ?? ''
        }
        return text
      }
      case 'array':
        return expr.elements.map((el) => this.evaluate(el))
      case 'map': {
        const map = new ChaMap()
        for (const entry of expr.entries) {
          map.map.set(this.evaluate(entry.key), this.evaluate(entry.value))
        }
        return map
      }
      case 'unary': {
        const v = this.evaluate(expr.operand)
        if (expr.op === '!') return !isTruthy(v)
        if (typeof v !== 'number') {
          throw this.err(expr, `一元 '-' 只能用于数字，得到的是 ${typeName(v)}`)
        }
        return -v
      }
      case 'binary': {
        // and / or 短路，并返回决定结果的那个操作数（Python 风格）
        if (expr.op === 'and') {
          const left = this.evaluate(expr.left)
          return isTruthy(left) ? this.evaluate(expr.right) : left
        }
        if (expr.op === 'or') {
          const left = this.evaluate(expr.left)
          return isTruthy(left) ? left : this.evaluate(expr.right)
        }
        const left = this.evaluate(expr.left)
        const right = this.evaluate(expr.right)
        return this.binary(expr.op, expr, left, right)
      }
      case 'conditional':
        return isTruthy(this.evaluate(expr.test))
          ? this.evaluate(expr.consequent)
          : this.evaluate(expr.alternate)
      case 'call': {
        const callee = this.evaluate(expr.callee)
        const args: Value[] = new Array(expr.args.length)
        for (let i = 0; i < args.length; i++) args[i] = this.evaluate(expr.args[i]!)
        return this.call(callee, args, expr)
      }
      case 'index': {
        const target = this.evaluate(expr.target)
        const index = this.evaluate(expr.index)
        return this.readIndex(expr, target, index)
      }
      case 'member': {
        const target = this.evaluate(expr.target)
        return this.readIndex(expr, target, expr.key)
      }
      case 'fn': {
        return {
          type: 'function',
          name: expr.name,
          params: expr.params,
          body: expr.body,
          closure: this.env,
        }
      }
      case 'assign':
        return this.assign(expr)
      case 'this': {
        const dist = this.resolutions.get(expr)
        if (dist === undefined) throw new Error('内部错误：this 没有解析结果')
        return this.env.get('this', dist)
      }
      case 'superMember': {
        const dist = this.resolutions.get(expr)
        if (dist === undefined) throw new Error('内部错误：super 没有解析结果')
        const superclass = this.env.get('super', dist) as ChaClass
        const receiver = this.lookupThis() as ChaInstance
        const method = superclass.findMethod(expr.key)
        if (!method) throw this.err(expr, superMissingMethodMessage(superclass.name, expr.key))
        return { type: 'boundMethod', receiver, method }
      }
    }
  }

  /** super.方法 的接收者：沿环境链找最近的 this（this 是关键字，不会被用户变量遮蔽） */
  private lookupThis(): Value {
    const slot = this.env.find('this')
    if (!slot) throw new Error('内部错误：找不到 this')
    return slot.value
  }

  /** 标识符取值：resolver 给了距离就跳层；全局（无记录）按名字回溯 */
  private lookup(expr: Extract<Expr, { type: 'identifier' }>): Value {
    const dist = this.resolutions.get(expr)
    if (dist !== undefined && dist >= 0) return this.env.get(expr.name, dist)
    return this.lookupDynamic(expr.name, expr)
  }

  /** 全局/未解析的名字：沿链查一次 Map/层，找不到才算未定义 */
  private lookupDynamic(name: string, node: { line: number; col: number }): Value {
    const slot = this.env.find(name)
    if (!slot) throw this.err(node, `未定义的变量 '${name}'`)
    if (!slot.initialized) throw new Error(`变量 ${name} 在声明前不可使用`)
    return slot.value
  }

  private err(node: { line: number; col: number }, message: string): RuntimeError {
    return new RuntimeError(message, node.line, node.col)
  }

  private binary(
    op: '==' | '!=' | '<' | '>' | '<=' | '>=' | '+' | '-' | '*' | '/' | '%',
    node: { line: number; col: number },
    left: Value,
    right: Value
  ): Value {
    switch (op) {
      case '==':
        return valuesEqual(left, right)
      case '!=':
        return !valuesEqual(left, right)
      case '<':
      case '>':
      case '<=':
      case '>=': {
        if (typeof left === 'number' && typeof right === 'number') {
          switch (op) {
            case '<':
              return left < right
            case '>':
              return left > right
            case '<=':
              return left <= right
            default:
              return left >= right
          }
        }
        if (typeof left === 'string' && typeof right === 'string') {
          switch (op) {
            case '<':
              return left < right
            case '>':
              return left > right
            case '<=':
              return left <= right
            default:
              return left >= right
          }
        }
        throw this.err(node, `比较运算 '${op}' 只能用于两个数字或两个字符串`)
      }
      case '+': {
        if (typeof left === 'number' && typeof right === 'number') return left + right
        if (typeof left === 'string' && typeof right === 'string') return left + right
        throw this.err(
          node,
          `加法 '+' 需要两个数字或两个字符串，得到 ${typeName(left)} + ${typeName(right)}；混排请用 "${'$'}{...}" 插值`
        )
      }
      case '-':
      case '*':
      case '/':
      case '%': {
        if (typeof left !== 'number' || typeof right !== 'number') {
          throw this.err(node, `运算 '${op}' 需要两个数字，得到 ${typeName(left)} 和 ${typeName(right)}`)
        }
        switch (op) {
          case '-':
            return left - right
          case '*':
            return left * right
          case '/':
            if (right === 0) throw this.err(node, '除数不能为 0')
            return left / right
          default:
            if (right === 0) throw this.err(node, '取模的除数不能为 0')
            return left % right
        }
      }
    }
  }

  private readIndex(
    node: { line: number; col: number },
    target: Value,
    index: Value
  ): Value {
    if (Array.isArray(target)) {
      if (typeof index !== 'number' || !Number.isInteger(index)) {
        throw this.err(node, `数组下标必须是整数，得到 ${formatValue(index)}`)
      }
      if (index < 0 || index >= target.length) {
        throw this.err(node, `数组下标越界：长度 ${target.length}，下标 ${formatNumber(index)}`)
      }
      return target[index]!
    }
    if (target instanceof ChaMap) {
      return target.map.get(index) ?? null
    }
    if (typeof target === 'string') {
      if (typeof index !== 'number' || !Number.isInteger(index)) {
        throw this.err(node, `字符串下标必须是整数，得到 ${formatValue(index)}`)
      }
      if (index < 0 || index >= target.length) {
        throw this.err(node, `字符串下标越界：长度 ${target.length}，下标 ${formatNumber(index)}`)
      }
      return target[index]!
    }
    if (target instanceof ChaInstance) {
      if (typeof index !== 'string') throw this.err(node, instanceKeyMessage(target.klass.name, index))
      const field = target.fields.get(index)
      if (field !== undefined) return field
      const method = target.klass.findMethod(index)
      if (method) return { type: 'boundMethod', receiver: target, method }
      throw this.err(node, instanceMissingPropertyMessage(target.klass.name, index))
    }
    throw this.err(node, `${typeName(target)} 不支持下标访问`)
  }

  private assign(expr: Extract<Expr, { type: 'assign' }>): Value {
    const target = expr.target

    if (target.kind === 'identifier') {
      let value = this.evaluate(expr.value)
      // 写入距离由 resolver 挂在 assign 节点上；全局写入没有距离，走动态链
      const dist = this.resolutions.get(expr)
      if (expr.op !== '=') {
        const current =
          dist !== undefined && dist >= 0
            ? this.env.get(target.name, dist)
            : this.lookupDynamic(target.name, target)
        value = this.binary(
          compoundOp(expr.op),
          expr,
          current,
          value
        )
      }
      if (dist !== undefined && dist >= 0) {
        this.env.assign(target.name, dist, value)
      } else if (!this.env.assignDynamic(target.name, value)) {
        throw this.err(expr, `未定义的变量 '${target.name}'`)
      }
      return value
    }

    if (target.kind === 'index') {
      const obj = this.evaluate(target.target)
      const key = this.evaluate(target.index)
      let value = this.evaluate(expr.value)
      if (expr.op !== '=') {
        value = this.binary(compoundOp(expr.op), expr, this.readIndex(expr, obj, key), value)
      }
      this.writeIndex(expr, obj, key, value)
      return value
    }

    // member：m.k = v 等价于 m["k"] = v
    const obj = this.evaluate(target.target)
    let value = this.evaluate(expr.value)
    if (expr.op !== '=') {
      value = this.binary(compoundOp(expr.op), expr, this.readIndex(expr, obj, target.key), value)
    }
    this.writeIndex(expr, obj, target.key, value)
    return value
  }

  private writeIndex(
    node: { line: number; col: number },
    target: Value,
    index: Value,
    value: Value
  ): void {
    if (Array.isArray(target)) {
      if (typeof index !== 'number' || !Number.isInteger(index)) {
        throw this.err(node, `数组下标必须是整数，得到 ${formatValue(index)}`)
      }
      if (index < 0 || index >= target.length) {
        throw this.err(node, `数组下标越界：长度 ${target.length}，下标 ${formatNumber(index)}`)
      }
      target[index] = value
      return
    }
    if (target instanceof ChaMap) {
      target.map.set(index, value)
      return
    }
    if (target instanceof ChaInstance) {
      if (typeof index !== 'string') throw this.err(node, instanceKeyMessage(target.klass.name, index))
      target.fields.set(index, value)
      return
    }
    throw this.err(node, `${typeName(target)} 不支持按下标赋值`)
  }

  private call(callee: Value, args: Value[], node: { line: number; col: number }): Value {
    if (typeof callee === 'object' && callee !== null && 'type' in callee) {
      if (callee.type === 'native') {
        const native = callee as NativeFunction
        if (native.arity !== 'variadic' && args.length !== native.arity) {
          throw this.err(node, `${native.name}() 需要 ${native.arity} 个参数，收到 ${args.length} 个`)
        }
        try {
          return native.fn(args)
        } catch (e) {
          // 内建函数抛出的 RuntimeError 无行列信息（0,0），改挂到调用点
          if (e instanceof RuntimeError && e.line === 0) {
            throw new RuntimeError(e.message.replace(/^\[line 0, col 0\] /, ''), node.line, node.col)
          }
          throw e
        }
      }
      if (callee.type === 'class') {
        const klass = callee as ChaClass
        const init = klass.findMethod('init')
        const arity = init ? init.params.length : 0
        if (args.length !== arity) {
          throw this.err(node, classArityMessage(klass.name, arity, args.length))
        }
        const instance = new ChaInstance(klass)
        if (!init) return instance
        return this.invoke(init, args, instance, node)
      }
      if (callee.type === 'boundMethod') {
        const bound = callee as BoundMethod
        return this.invoke(bound.method, args, bound.receiver, node)
      }
      if (callee.type === 'function') {
        return this.invoke(callee, args, null, node)
      }
    }
    throw this.err(node, `${typeName(callee)} 不是函数，不能调用`)
  }

  /** 调用 cha 函数/方法：receiver 非空时在局部作用域里多绑一个 this */
  private invoke(
    callee: ChaFunction,
    args: Value[],
    receiver: ChaInstance | null,
    node: { line: number; col: number }
  ): Value {
    if (args.length !== callee.params.length) {
      throw this.err(
        node,
        `函数 ${callee.name ?? '(匿名)'}() 需要 ${callee.params.length} 个参数，收到 ${args.length} 个`
      )
    }
    const prev = this.env
    const local = new Environment(callee.closure)
    if (this.depth >= MAX_CALL_DEPTH) throw this.err(node, TOO_DEEP_MESSAGE)
    this.depth++
    try {
      if (receiver) local.declare('this', receiver, true)
      for (let i = 0; i < callee.params.length; i++) {
        local.declare(callee.params[i]!, args[i]!, true)
      }
      this.env = local
      this.execStmts(callee.body)
    } catch (e) {
      if (e instanceof ReturnSignal) return callee.isInitializer ? receiver : e.value
      // 树遍历器一个 cha 调用要占好几层 JS 栈，可能先于深度上限栈溢出。
      // 在这里归位成与 VM 同一条错误：最深那层 invoke() 先接住，node 正好是递归调用点。
      if (e instanceof RangeError) throw this.err(node, TOO_DEEP_MESSAGE)
      throw e
    } finally {
      this.depth--
      this.env = prev
    }
    return callee.isInitializer ? receiver : null
  }

  // ---------- 内建函数 ----------

  private installBuiltins(): void {
    // 内建实现抽到 builtins.ts，与字节码 VM 共用同一份
    for (const builtin of createBuiltins(this.output, this.clock, this.readLine, this.maxRangeLength)) {
      this.globals.declare(builtin.name, builtin)
    }
  }
}
