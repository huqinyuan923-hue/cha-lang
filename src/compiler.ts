/**
 * 字节码编译器：AST → Chunk。
 *
 * 作用域解析在这里重做一遍：resolver 负责把「作用域错误」提前到编译期
 * （重复声明、自引用、循环外的 break 等），本编译器则负责把每个变量
 * 落到具体位置——当前函数的栈槽（local）、外层函数的 upvalue，或全局表。
 *
 * 与树遍历解释器对齐的求值顺序约定（差分测试依赖这些细节）：
 *  - 调用：先 callee，再参数从左到右；
 *  - 复合赋值（x += e、a[i] += e）：先求右侧表达式，再读旧值；
 *  - var x = fn ...{...} 与函数声明：先占槽位再编译函数体，函数体里
 *    引用自己的名字按 upvalue 捕获——局部递归函数因此可用。
 */
import type { Expr, FnExpr, Program, Stmt } from './ast'
import { Chunk, Op, TemplateInfo, type VMFunction } from './chunk'

interface LocalVar {
  name: string
  slot: number
  /** 被内层函数捕获的变量，作用域退出时要关闭对应 upvalue */
  isCaptured: boolean
  line: number
  col: number
}

/** 循环编译上下文：break/continue 的回填地址与需要关闭的槽位深度 */
interface LoopCtx {
  breaks: number[]
  /** continue 的前向 JUMP 地址（仅 for：要先跳到 update） */
  continues: number[]
  /** 是否 for 循环（continue 的落点不同） */
  isFor: boolean
  /** 测试代码起始地址（while 回跳目标） */
  testStart: number
  /** continue 时槽位回退到的深度（for 的初始化变量不在此列） */
  continueDepth: number
  /** break 时槽位回退到的深度（覆盖循环自己的作用域） */
  breakDepth: number
}

const COMPOUND_OPS: Record<string, Op> = {
  '+=': Op.ADD,
  '-=': Op.SUB,
  '*=': Op.MUL,
  '/=': Op.DIV,
  '%=': Op.MOD,
}

export class FunctionCompiler {
  readonly fn: VMFunction
  private enclosing: FunctionCompiler | null
  private scopes: LocalVar[][] = []
  private slotCount = 0
  private loopCtxs: LoopCtx[] = []
  private upvalues: { isLocal: boolean; index: number }[] = []

  constructor(
    name: string | undefined,
    enclosing: FunctionCompiler | null,
    private params: string[],
    pos: { line: number; col: number },
    /** 顶层脚本为 true：语句落在全局；函数体永远有自己的局部作用域 */
    private isScript = false
  ) {
    this.enclosing = enclosing
    this.fn = {
      type: 'vmFunction',
      name,
      arity: params.length,
      paramNames: params,
      chunk: new Chunk(),
      upvalueCount: 0,
    }
    if (!isScript) {
      this.beginScope()
      for (const p of params) this.declareLocal(p, pos)
    }
  }

  private get chunk(): Chunk {
    return this.fn.chunk
  }

  // ---------- 发射 ----------

  emit(op: Op, node: { line: number; col: number }): void {
    this.chunk.write(op, node.line, node.col)
  }

  private emitConstant(
    op: Op,
    constant: VMFunction | TemplateInfo | number | string | boolean | null,
    node: { line: number; col: number }
  ): void {
    this.chunk.write(op, node.line, node.col)
    this.chunk.writeU16(this.chunk.addConstant(constant), node.line, node.col)
  }

  /** 发射前向跳转，返回指令地址（回填时用 patchJump） */
  private emitJump(op: Op, node: { line: number; col: number }): number {
    this.emit(op, node)
    this.chunk.writeU16(0xffff, node.line, node.col)
    return this.chunk.code.length - 3
  }

  private patchJump(at: number): void {
    this.chunk.patchU16(at, this.chunk.code.length - (at + 3))
  }

  /** 发射后向跳转（LOOP） */
  private emitLoop(to: number, node: { line: number; col: number }): void {
    this.emit(Op.LOOP, node)
    const offset = this.chunk.code.length + 2 - to
    if (offset > 0xffff) throw new Error('编译错误：循环体过大（超出 64KB）')
    this.chunk.writeU16(offset, node.line, node.col)
  }

  // ---------- 作用域与变量解析 ----------

  private beginScope(): void {
    this.scopes.push([])
  }

  private endScope(): void {
    const scope = this.scopes.pop()!
    if (scope.length > 0) {
      // 被捕获的变量先关闭 upvalue（值拷出栈槽），再把这个作用域的槽位全部弹掉。
      // 槽位即栈位：不弹的话，循环体重新执行时新值会压到更高的位置，槽位编号全部错位。
      const first = scope[0]!
      if (scope.some((v) => v.isCaptured)) this.emitU16Op(Op.CLOSE_UPVALUES, first.slot, first)
      for (let i = 0; i < scope.length; i++) this.emit(Op.POP, first)
    }
    this.slotCount -= scope.length
  }

  private declareLocal(name: string, node: { line: number; col: number }): void {
    this.scopes[this.scopes.length - 1]!.push({
      name,
      slot: this.slotCount++,
      isCaptured: false,
      line: node.line,
      col: node.col,
    })
  }

  private resolveLocal(name: string): number | null {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const found = this.scopes[i]!.find((v) => v.name === name)
      if (found) return found.slot
    }
    return null
  }

  private resolveUpvalue(name: string): number | null {
    if (!this.enclosing) return null
    for (const scope of this.enclosing.scopes) {
      const found = scope.find((v) => v.name === name)
      if (found) {
        found.isCaptured = true
        return this.addUpvalue(true, found.slot)
      }
    }
    const viaOuter = this.enclosing.resolveUpvalue(name)
    if (viaOuter !== null) return this.addUpvalue(false, viaOuter)
    return null
  }

  private addUpvalue(isLocal: boolean, index: number): number {
    const existing = this.upvalues.findIndex((u) => u.isLocal === isLocal && u.index === index)
    if (existing !== -1) return existing
    this.upvalues.push({ isLocal, index })
    return this.fn.upvalueCount++
  }

  // ---------- 语句 ----------

  compileStmts(stmts: Stmt[]): void {
    for (const stmt of stmts) this.compileStmt(stmt)
  }

  compileStmt(stmt: Stmt): void {
    switch (stmt.type) {
      case 'exprStmt':
        this.compileExpr(stmt.expr)
        this.emit(Op.POP, stmt)
        return
      case 'var':
        this.compileVar(stmt.name, stmt.initializer, stmt)
        return
      case 'fnDecl':
        this.compileFnDecl(stmt.fn, stmt)
        return
      case 'block':
        this.beginScope()
        this.compileStmts(stmt.body)
        this.endScope()
        return
      case 'if': {
        this.compileExpr(stmt.test)
        const elseJump = this.emitJump(Op.JUMP_IF_FALSE, stmt)
        this.compileStmt(stmt.then)
        if (stmt.else) {
          const endJump = this.emitJump(Op.JUMP, stmt)
          this.patchJump(elseJump)
          this.compileStmt(stmt.else)
          this.patchJump(endJump)
        } else {
          this.patchJump(elseJump)
        }
        return
      }
      case 'while':
        this.compileWhile(stmt.test, stmt.body, stmt)
        return
      case 'for':
        this.compileFor(stmt, stmt)
        return
      case 'return': {
        if (stmt.value) this.compileExpr(stmt.value)
        else this.emit(Op.NIL, stmt)
        this.emit(Op.RETURN, stmt)
        return
      }
      case 'break':
      case 'continue': {
        const ctx = this.loopCtxs[this.loopCtxs.length - 1]
        if (!ctx) throw new Error(`内部错误：${stmt.type} 未通过 resolver 检查`)
        const depth = stmt.type === 'continue' ? ctx.continueDepth : ctx.breakDepth
        // 跳转路径会越过内层作用域的 endScope，这里手动关闭并弹掉更深的槽位
        this.emitU16Op(Op.CLOSE_UPVALUES, depth, stmt)
        for (let s = this.slotCount; s > depth; s--) this.emit(Op.POP, stmt)
        if (stmt.type === 'continue') {
          if (ctx.isFor) {
            const jump = this.emitJump(Op.JUMP, stmt)
            ctx.continues.push(jump)
          } else {
            this.emitLoop(ctx.testStart, stmt)
          }
        } else {
          const jump = this.emitJump(Op.JUMP, stmt)
          ctx.breaks.push(jump)
        }
        return
      }
    }
  }

  /** var 声明。局部作用域下 fn 初始化器先占槽再编译，函数递归引用自己时走 upvalue */
  private compileVar(name: string, initializer: Expr | undefined, node: { line: number; col: number }): void {
    const isLocal = this.scopes.length > 0
    if (isLocal && initializer?.type === 'fn') {
      this.declareLocal(name, node)
      this.emitClosureProto(initializer, initializer)
      return
    }
    if (initializer) this.compileExpr(initializer)
    else this.emit(Op.NIL, node)
    if (isLocal) this.declareLocal(name, node)
    else this.emitConstant(Op.DEFINE_GLOBAL, name, node)
  }

  private compileFnDecl(fn: FnExpr, node: { line: number; col: number }): void {
    const isLocal = this.scopes.length > 0
    if (isLocal) this.declareLocal(fn.name!, node)
    this.emitClosureProto(fn, fn)
    if (!isLocal) this.emitConstant(Op.DEFINE_GLOBAL, fn.name!, node)
  }

  private compileWhile(test: Expr | undefined, body: Stmt, node: { line: number; col: number }): void {
    const testStart = this.chunk.code.length
    if (test) this.compileExpr(test)
    const exitJump = test ? this.emitJump(Op.JUMP_IF_FALSE, node) : -1
    const depth = this.slotCount
    const ctx: LoopCtx = { breaks: [], continues: [], isFor: false, testStart, continueDepth: depth, breakDepth: depth }
    this.loopCtxs.push(ctx)
    this.compileStmt(body)
    this.loopCtxs.pop()
    // while 的 continue 已直接回跳，这里处理 break 与出口
    this.emitLoop(testStart, node)
    if (exitJump !== -1) this.patchJump(exitJump)
    for (const at of ctx.breaks) this.patchJump(at)
  }

  private compileFor(stmt: Extract<Stmt, { type: 'for' }>, node: { line: number; col: number }): void {
    this.beginScope() // 循环头里的 init 只活在 for 自己的作用域里
    const breakDepth = this.slotCount
    if (stmt.init) this.compileStmt(stmt.init)
    const testStart = this.chunk.code.length
    if (stmt.test) this.compileExpr(stmt.test)
    const exitJump = stmt.test ? this.emitJump(Op.JUMP_IF_FALSE, node) : -1
    const ctx: LoopCtx = {
      breaks: [],
      continues: [],
      isFor: true,
      testStart,
      continueDepth: this.slotCount,
      breakDepth,
    }
    this.loopCtxs.push(ctx)
    this.compileStmt(stmt.body)
    this.loopCtxs.pop()
    // continue 统一落到 update 之前
    const updateAddr = this.chunk.code.length
    for (const at of ctx.continues) this.chunk.patchU16(at, updateAddr - (at + 3))
    if (stmt.update) {
      this.compileExpr(stmt.update)
      this.emit(Op.POP, node)
    }
    this.emitLoop(testStart, node)
    if (exitJump !== -1) this.patchJump(exitJump)
    this.endScope()
    // break 落在整个 for（含初始化变量）清理完成之后
    for (const at of ctx.breaks) this.patchJump(at)
  }

  // ---------- 表达式 ----------

  compileExpr(expr: Expr): void {
    switch (expr.type) {
      case 'literal': {
        const v = expr.value
        if (v === null) this.emit(Op.NIL, expr)
        else if (v === true) this.emit(Op.TRUE, expr)
        else if (v === false) this.emit(Op.FALSE, expr)
        else this.emitConstant(Op.CONST, v, expr)
        return
      }
      case 'identifier':
        this.compileGet(expr.name, expr)
        return
      case 'template': {
        const info: TemplateInfo = { parts: expr.parts, count: expr.exprs.length }
        for (const sub of expr.exprs) this.compileExpr(sub)
        this.emitConstant(Op.TEMPLATE, info, expr)
        return
      }
      case 'array': {
        for (const el of expr.elements) this.compileExpr(el)
        this.emitU16Op(Op.ARRAY, expr.elements.length, expr)
        return
      }
      case 'map': {
        for (const entry of expr.entries) {
          this.compileExpr(entry.key)
          this.compileExpr(entry.value)
        }
        this.emitU16Op(Op.MAP, expr.entries.length, expr)
        return
      }
      case 'unary':
        this.compileExpr(expr.operand)
        this.emit(expr.op === '!' ? Op.NOT : Op.NEG, expr)
        return
      case 'binary':
        this.compileBinary(expr)
        return
      case 'conditional': {
        this.compileExpr(expr.test)
        const altJump = this.emitJump(Op.JUMP_IF_FALSE, expr)
        this.compileExpr(expr.consequent)
        const endJump = this.emitJump(Op.JUMP, expr)
        this.patchJump(altJump)
        this.compileExpr(expr.alternate)
        this.patchJump(endJump)
        return
      }
      case 'call': {
        this.compileExpr(expr.callee)
        for (const arg of expr.args) this.compileExpr(arg)
        this.emitU8Op(Op.CALL, expr.args.length, expr)
        return
      }
      case 'index':
        this.compileExpr(expr.target)
        this.compileExpr(expr.index)
        this.emit(Op.GET_INDEX, expr)
        return
      case 'member':
        this.compileExpr(expr.target)
        this.emitConstant(Op.CONST, expr.key, expr)
        this.emit(Op.GET_INDEX, expr)
        return
      case 'fn': {
        this.emitClosureProto(expr, expr)
        return
      }
      case 'assign':
        this.compileAssign(expr)
        return
    }
  }

  private compileGet(name: string, node: { line: number; col: number }): void {
    const local = this.resolveLocal(name)
    if (local !== null) return this.emitU16Op(Op.GET_LOCAL, local, node)
    const upvalue = this.resolveUpvalue(name)
    if (upvalue !== null) return this.emitU8Op(Op.GET_UPVALUE, upvalue, node)
    this.emitConstant(Op.GET_GLOBAL, name, node)
  }

  private compileSet(name: string, node: { line: number; col: number }): void {
    const local = this.resolveLocal(name)
    if (local !== null) return this.emitU16Op(Op.SET_LOCAL, local, node)
    const upvalue = this.resolveUpvalue(name)
    if (upvalue !== null) return this.emitU8Op(Op.SET_UPVALUE, upvalue, node)
    this.emitConstant(Op.SET_GLOBAL, name, node)
  }

  private compileBinary(expr: Extract<Expr, { type: 'binary' }>): void {
    // and / or 短路，返回决定结果的那个操作数（左值不弹，条件跳转）
    if (expr.op === 'and' || expr.op === 'or') {
      this.compileExpr(expr.left)
      const short = this.emitJump(expr.op === 'and' ? Op.JUMP_IF_FALSE_PEEK : Op.JUMP_IF_TRUE_PEEK, expr)
      this.emit(Op.POP, expr)
      this.compileExpr(expr.right)
      this.patchJump(short)
      return
    }
    this.compileExpr(expr.left)
    this.compileExpr(expr.right)
    const op: Op = {
      '+': Op.ADD,
      '-': Op.SUB,
      '*': Op.MUL,
      '/': Op.DIV,
      '%': Op.MOD,
      '==': Op.EQ,
      '!=': Op.NEQ,
      '<': Op.LT,
      '>': Op.GT,
      '<=': Op.LTE,
      '>=': Op.GTE,
    }[expr.op]!
    this.emit(op, expr)
  }

  /**
   * 赋值表达式（求值结果为右侧的值，留在栈顶）。
   * 复合赋值统一「先右值、后旧值」的顺序，与树遍历器完全一致。
   */
  private compileAssign(expr: Extract<Expr, { type: 'assign' }>): void {
    const target = expr.target

    if (target.kind === 'identifier') {
      this.compileExpr(expr.value)
      if (expr.op !== '=') {
        // 旧值读取报错的位置与树遍历器对齐：挂在赋值目标（变量名）上
        this.compileGet(target.name, target)
        this.emit(Op.SWAP, expr)
        this.emit(COMPOUND_OPS[expr.op]!, expr)
      }
      this.compileSet(target.name, expr)
      return
    }

    if (target.kind === 'index') {
      this.compileExpr(target.target)
      this.compileExpr(target.index)
      this.compileCompoundIndexValue(expr)
      this.emit(Op.SET_INDEX, expr)
      return
    }

    // member：m.k 等价于 m["k"]
    this.compileExpr(target.target)
    this.emitConstant(Op.CONST, target.key, target)
    this.compileCompoundIndexValue(expr)
    this.emit(Op.SET_INDEX, expr)
  }

  /** 复合下标赋值的右侧部分：普通赋值只编译右值；复合赋值先右值、再读旧值 */
  private compileCompoundIndexValue(expr: Extract<Expr, { type: 'assign' }>): void {
    if (expr.op === '=') {
      this.compileExpr(expr.value)
      return
    }
    // [obj, key, rhs] → 复制 obj/key 到栈顶读旧值 → [obj, key, old, rhs]
    this.compileExpr(expr.value)
    this.emitU8Op(Op.PICK, 3, expr)
    this.emitU8Op(Op.PICK, 3, expr)
    this.emit(Op.GET_INDEX, expr)
    this.emit(Op.SWAP, expr)
    this.emit(COMPOUND_OPS[expr.op]!, expr)
  }

  /**
   * 编译函数原型并发射 CLOSURE 指令。
   * 指令操作数之后紧跟 upvalueCount 组 (isLocal u8, index u8) 描述对，
   * VM 据此决定每个捕获来自本帧栈槽还是外层帧的 upvalue。
   */
  private emitClosureProto(fn: FnExpr, node: { line: number; col: number }): void {
    const comp = new FunctionCompiler(fn.name, this, fn.params, fn, false)
    comp.compileStmts(fn.body)
    const end = { line: fn.line, col: fn.col }
    comp.emit(Op.NIL, end)
    comp.emit(Op.RETURN, end)
    this.emitConstant(Op.CLOSURE, comp.fn, node)
    for (const up of comp.upvalues) {
      this.chunk.write(up.isLocal ? 1 : 0, node.line, node.col)
      this.chunk.write(up.index, node.line, node.col)
    }
  }

  private emitU16Op(op: Op, operand: number, node: { line: number; col: number }): void {
    this.emit(op, node)
    this.chunk.writeU16(operand, node.line, node.col)
  }

  private emitU8Op(op: Op, operand: number, node: { line: number; col: number }): void {
    this.emit(op, node)
    this.chunk.write(operand, node.line, node.col)
  }
}

/** 编译整段程序：入口是一个无参、无 upvalue 的顶层函数 */
export function compile(program: Program): VMFunction {
  const comp = new FunctionCompiler(undefined, null, [], { line: 1, col: 1 }, true)
  comp.compileStmts(program)
  const end = program.length > 0 ? program[program.length - 1]! : { line: 1, col: 1 }
  comp.emit(Op.NIL, end)
  comp.emit(Op.RETURN, end)
  return comp.fn
}
