import type { Expr, Program, Stmt } from './ast'
import { createBuiltins } from './builtins'
import {
  ChaMap,
  Environment,
  RuntimeError,
  formatNumber,
  formatValue,
  isTruthy,
  typeName,
  valuesEqual,
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

export interface InterpreterOptions {
  /** print 的去处（默认丢弃）；REPL/CLI 接 stdout，测试接数组 */
  output?: (text: string) => void
  clock?: () => number
}

type Resolutions = Map<Expr, number>

export class Interpreter {
  private globals = new Environment()
  private env = this.globals
  private output: (text: string) => void
  private clock: () => number
  private resolutions: Resolutions

  constructor(resolutions: Resolutions, options: InterpreterOptions = {}) {
    this.resolutions = resolutions
    this.output = options.output ?? (() => {})
    this.clock = options.clock ?? (() => Date.now() / 1000)
    this.installBuiltins()
  }

  /** REPL/会话场景：每段新代码有自己的作用域解析结果，但共享全局环境 */
  setResolutions(resolutions: Resolutions): void {
    this.resolutions = resolutions
  }

  run(program: Program): void {
    for (const stmt of program) this.execStmt(stmt)
  }

  // ---------- 语句 ----------

  private execStmts(stmts: Stmt[]): void {
    for (const stmt of stmts) this.execStmt(stmt)
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
            if (e instanceof ContinueSignal) continue
            throw e
          }
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
        const args = expr.args.map((arg) => this.evaluate(arg))
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
    }
  }

  /** 标识符取值：resolver 给了距离就跳层；全局（无记录）按名字回溯 */
  private lookup(expr: Extract<Expr, { type: 'identifier' }>): Value {
    const dist = this.resolutions.get(expr)
    if (dist !== undefined && dist >= 0) return this.env.get(expr.name, dist)
    let scope: Environment | undefined = this.env
    while (scope) {
      if (scope.isDeclared(expr.name)) return scope.get(expr.name, 0)
      scope = scope.parent
    }
    throw this.err(expr, `未定义的变量 '${expr.name}'`)
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
    throw this.err(node, `${typeName(target)} 不支持下标访问`)
  }

  private assign(expr: Extract<Expr, { type: 'assign' }>): Value {
    const target = expr.target

    if (target.kind === 'identifier') {
      let value = this.evaluate(expr.value)
      const ref: Expr = {
        type: 'identifier',
        name: target.name,
        line: target.line,
        col: target.col,
      }
      if (expr.op !== '=') {
        value = this.binary(
          expr.op.replace('=', '') as '+',
          expr,
          this.lookup(ref),
          value
        )
      }
      const dist = this.resolutions.get(ref)
      if (dist !== undefined && dist >= 0) {
        this.env.assign(target.name, dist, value)
      } else {
        let scope: Environment | undefined = this.env
        let found = false
        while (scope) {
          if (scope.isDeclared(target.name)) {
            scope.assign(target.name, 0, value)
            found = true
            break
          }
          scope = scope.parent
        }
        if (!found) throw this.err(expr, `未定义的变量 '${target.name}'`)
      }
      return value
    }

    if (target.kind === 'index') {
      const obj = this.evaluate(target.target)
      const key = this.evaluate(target.index)
      let value = this.evaluate(expr.value)
      if (expr.op !== '=') {
        value = this.binary(expr.op.replace('=', '') as '+', expr, this.readIndex(expr, obj, key), value)
      }
      this.writeIndex(expr, obj, key, value)
      return value
    }

    // member：m.k = v 等价于 m["k"] = v
    const obj = this.evaluate(target.target)
    let value = this.evaluate(expr.value)
    if (expr.op !== '=') {
      value = this.binary(expr.op.replace('=', '') as '+', expr, this.readIndex(expr, obj, target.key), value)
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
      if (callee.type === 'function') {
        if (args.length !== callee.params.length) {
          throw this.err(
            node,
            `函数 ${callee.name ?? '(匿名)'}() 需要 ${callee.params.length} 个参数，收到 ${args.length} 个`
          )
        }
        const prev = this.env
        const local = new Environment(callee.closure)
        try {
          callee.params.forEach((p, i) => local.declare(p, args[i]!, true))
          this.env = local
          this.execStmts(callee.body)
        } catch (e) {
          if (e instanceof ReturnSignal) return e.value
          throw e
        } finally {
          this.env = prev
        }
        return null
      }
    }
    throw this.err(node, `${typeName(callee)} 不是函数，不能调用`)
  }

  // ---------- 内建函数 ----------

  private installBuiltins(): void {
    // 内建实现抽到 builtins.ts，与字节码 VM 共用同一份
    for (const builtin of createBuiltins(this.output, this.clock)) {
      this.globals.declare(builtin.name, builtin)
    }
  }
}
