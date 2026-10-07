import type { Expr, Program, Stmt } from './ast'

export class ResolveError extends Error {
  constructor(
    message: string,
    public line: number,
    public col: number
  ) {
    super(`[line ${line}, col ${col}] ${message}`)
    this.name = 'ResolveError'
  }
}

/**
 * 静态作用域解析器：在程序运行前遍历 AST，为每个变量引用算出
 * 「从使用处到声明处隔了几层作用域」，解释器据此直接跳层取值。
 *
 * 同时把一批运行时才能发现的错误提前到编译期：
 *  - return 出现在函数外
 *  - break / continue 出现在循环外
 *  - 同一作用域重复声明
 *  - 使用了「已声明但尚未初始化」的变量（var x = x;）
 *
 * 返回值：Expr 节点 → 作用域距离。全局变量不出现在表里（dist 视为 -1）。
 */
export function resolve(program: Program): Map<Expr, number> {
  const resolutions = new Map<Expr, number>()

  interface Scope {
    names: Map<string, boolean> // name → 已初始化？
  }
  const scopes: Scope[] = []
  const globalNames = new Map<string, boolean>() // 全局层的声明状态（只做检查，不出距离表）
  let fnDepth = 0
  let loopDepth = 0

  const begin = (): void => {
    scopes.push({ names: new Map() })
  }
  const end = (): void => {
    scopes.pop()
  }
  const declare = (name: string, line: number, col: number): void => {
    const scope = scopes[scopes.length - 1]
    if (!scope) {
      // 全局层：解释器按名字回溯，这里只做重复声明与初始化状态检查
      if (globalNames.has(name)) {
        throw new ResolveError(`全局作用域里已经有名为 '${name}' 的变量了`, line, col)
      }
      globalNames.set(name, false)
      return
    }
    if (scope.names.has(name)) {
      throw new ResolveError(`当前作用域里已经有名为 '${name}' 的变量了`, line, col)
    }
    scope.names.set(name, false)
  }
  const define = (name: string): void => {
    const scope = scopes[scopes.length - 1]
    if (!scope) {
      globalNames.set(name, true)
      return
    }
    scope.names.set(name, true)
  }

  /** 函数声明专用：重名检查后立即标记已初始化（函数体解析前生效，递归因此可用） */
  const declareImmediately = (name: string, line: number, col: number): void => {
    const scope = scopes[scopes.length - 1]
    if (!scope) {
      if (globalNames.has(name)) {
        throw new ResolveError(`全局作用域里已经有名为 '${name}' 的变量了`, line, col)
      }
      globalNames.set(name, true)
      return
    }
    if (scope.names.has(name)) {
      throw new ResolveError(`当前作用域里已经有名为 '${name}' 的变量了`, line, col)
    }
    scope.names.set(name, true)
  }

  /** 从最内层作用域向外找，返回距离；找不到返回 null（全局） */
  function lookup(name: string): number | null {
    for (let i = scopes.length - 1; i >= 0; i--) {
      if (scopes[i]!.names.has(name)) return scopes.length - 1 - i
    }
    return null
  }

  function resolveIdentifier(expr: Extract<Expr, { type: 'identifier' }>, isWrite: boolean): void {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const scope = scopes[i]!
      if (scope.names.has(expr.name)) {
        if (isWrite === false && scope.names.get(expr.name) === false && i === scopes.length - 1) {
          throw new ResolveError(
            `不能在本层作用域读取尚未初始化的变量 '${expr.name}'（var x = x 是自引用）`,
            expr.line,
            expr.col
          )
        }
        resolutions.set(expr, scopes.length - 1 - i)
        return
      }
    }
    // 全局层：检查读取未初始化的变量
    if (!isWrite && globalNames.get(expr.name) === false) {
      throw new ResolveError(
        `不能读取尚未初始化的全局变量 '${expr.name}'（var x = x 是自引用）`,
        expr.line,
        expr.col
      )
    }
  }

  function resolveExpr(expr: Expr): void {
    switch (expr.type) {
      case 'literal':
        return
      case 'identifier':
        return resolveIdentifier(expr, false)
      case 'template':
        for (const sub of expr.exprs) resolveExpr(sub)
        return
      case 'array':
        for (const el of expr.elements) resolveExpr(el)
        return
      case 'map':
        for (const entry of expr.entries) {
          resolveExpr(entry.key)
          resolveExpr(entry.value)
        }
        return
      case 'unary':
        return resolveExpr(expr.operand)
      case 'binary':
        resolveExpr(expr.left)
        resolveExpr(expr.right)
        return
      case 'conditional':
        resolveExpr(expr.test)
        resolveExpr(expr.consequent)
        resolveExpr(expr.alternate)
        return
      case 'call':
        resolveExpr(expr.callee)
        for (const arg of expr.args) resolveExpr(arg)
        return
      case 'index':
        resolveExpr(expr.target)
        resolveExpr(expr.index)
        return
      case 'member':
        return resolveExpr(expr.target)
      case 'assign':
        if (expr.target.kind === 'identifier') {
          resolveIdentifier(
            { type: 'identifier', name: expr.target.name, line: expr.target.line, col: expr.target.col },
            true
          )
        } else if (expr.target.kind === 'index') {
          resolveExpr(expr.target.target)
          resolveExpr(expr.target.index)
        } else {
          resolveExpr(expr.target.target)
        }
        return resolveExpr(expr.value)
      case 'fn':
        return resolveFn(expr)
    }
  }

  function resolveFn(fn: Extract<Expr, { type: 'fn' }>): void {
    begin()
    for (const p of fn.params) declare(p, fn.line, fn.col)
    for (const p of fn.params) define(p)
    fnDepth++
    // break/continue 只对包含它们的循环生效，跨函数边界一律非法
    const prevLoopDepth = loopDepth
    loopDepth = 0
    for (const stmt of fn.body) resolveStmt(stmt)
    loopDepth = prevLoopDepth
    fnDepth--
    end()
  }

  function resolveStmt(stmt: Stmt): void {
    switch (stmt.type) {
      case 'exprStmt':
        return resolveExpr(stmt.expr)
      case 'var': {
        declare(stmt.name, stmt.line, stmt.col)
        if (stmt.initializer) resolveExpr(stmt.initializer)
        define(stmt.name)
        return
      }
      case 'fnDecl': {
        // 先重名检查并立即生效，再解析函数体——函数体内引用自己（递归）必须可用
        declareImmediately(stmt.fn.name!, stmt.fn.line, stmt.fn.col)
        resolveFn(stmt.fn)
        return
      }
      case 'block':
        begin()
        for (const s of stmt.body) resolveStmt(s)
        end()
        return
      case 'if':
        resolveExpr(stmt.test)
        resolveStmt(stmt.then)
        if (stmt.else) resolveStmt(stmt.else)
        return
      case 'while':
        resolveExpr(stmt.test)
        loopDepth++
        resolveStmt(stmt.body)
        loopDepth--
        return
      case 'for':
        begin() // for 的初始化只活在循环头里
        if (stmt.init) resolveStmt(stmt.init)
        if (stmt.test) resolveExpr(stmt.test)
        if (stmt.update) resolveExpr(stmt.update)
        loopDepth++
        resolveStmt(stmt.body)
        loopDepth--
        end()
        return
      case 'return': {
        if (fnDepth === 0) {
          throw new ResolveError('return 只能出现在函数里', stmt.line, stmt.col)
        }
        if (stmt.value) resolveExpr(stmt.value)
        return
      }
      case 'break':
      case 'continue':
        if (loopDepth === 0) {
          throw new ResolveError(
            stmt.type === 'break' ? 'break 只能出现在循环里' : 'continue 只能出现在循环里',
            stmt.line,
            stmt.col
          )
        }
        return
    }
  }

  for (const stmt of program) resolveStmt(stmt)
  return resolutions
}
