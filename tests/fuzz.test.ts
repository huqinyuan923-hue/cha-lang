import { describe, expect, it } from 'vitest'
import { run, runVM } from '../src/index'

/**
 * 差分模糊测试：种子化随机生成合法（但允许运行期出错）的 Cha 程序，
 * 同时喂给树遍历解释器与字节码 VM，输出与错误必须逐字节一致。
 *
 * 生成器只保证两件事：
 *  1. 程序必然终止（while 用递减计数器、for 用常量上界、不生成递归调用）；
 *  2. 不在同一个作用域里重复声明同名变量（那是 ResolveError，单测里已覆盖）。
 * 类型错误、下标越界、对 nil 做运算等运行期错误一律放行——
 * 两个后端必须在同一条指令上以同样的信息失败，这本身就是最好的测试。
 */

type Rnd = () => number

/** mulberry32：小型可复现 PRNG */
function mulberry32(seed: number): Rnd {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type VarType = 'num' | 'str' | 'bool' | 'arr' | 'map' | 'fn' | 'any'

interface VarInfo {
  type: VarType
  /** fn：参数个数 */
  params?: number
  /** map：可选键名池 */
  keys?: string[]
  /** fn：调用之后返回的是闭包（捕获已随作用域退出而关闭），值就是这个参数个数 */
  returnsFn?: number
}

interface GenCtx {
  rnd: Rnd
  scopes: Map<string, VarInfo>[]
  loopDepth: number
  fnDepth: number
  counter: number
  /** 循环控制变量：保证终止，禁止被随机赋值改写（读取不受限） */
  noWrite: Set<string>
  /** 正在生成的函数名：体内禁止调用自己（无界递归） */
  currentFn: string | null
}

const STR_POOL = ['茶', 'cha', '苹果', 'xyz', '值', 'a', '你好世界']
const MAP_KEYS = ['x', 'y', '名字']

const pick = <T>(ctx: GenCtx, arr: T[]): T => arr[Math.floor(ctx.rnd() * arr.length)]!
const chance = (ctx: GenCtx, p: number): boolean => ctx.rnd() < p
const small = (ctx: GenCtx, max: number): number => Math.floor(ctx.rnd() * max)

/** 可见的变量池（内层遮蔽外层，同层不重名） */
function visible(ctx: GenCtx, pred: (v: VarInfo) => boolean): [string, VarInfo][] {
  const out: [string, VarInfo][] = []
  for (const scope of ctx.scopes) {
    for (const [name, info] of scope) {
      if (pred(info)) out.push([name, info])
    }
  }
  return out
}

function declare(ctx: GenCtx, type: VarType, extra?: Partial<VarInfo>): string {
  const name = `v${ctx.counter++}`
  ctx.scopes[ctx.scopes.length - 1]!.set(name, { type, ...extra })
  return name
}

/**
 * 匿名函数表达式：体内读到的外层变量会被 resolver 标成 upvalue，
 * 于是 CLOSURE / GET_UPVALUE / SETUP_UPVALUE / CLOSE_UPVALUE 全部进覆盖。
 * 沿用调用方的 currentFn（匿名函数没有名字，外层函数名仍然禁止自调用）。
 */
function genFnExpr(ctx: GenCtx, depth: number, arity: number): string {
  const params = Array.from({ length: arity }, (_, i) => `p${i}`)
  ctx.scopes.push(new Map())
  params.forEach((p) => ctx.scopes[ctx.scopes.length - 1]!.set(p, { type: 'num' }))
  const prevFnDepth = ctx.fnDepth
  // 函数体不是循环的组成部分：这里的 break/continue 会越不过函数边界，resolver 直接报错
  const prevLoopDepth = ctx.loopDepth
  ctx.fnDepth++
  ctx.loopDepth = 0
  const body = Array.from({ length: 1 + small(ctx, 2) }, () => genStmt(ctx, depth + 1))
  body.push(`${'  '.repeat(depth + 1)}return ${genNum(ctx, 2)};`)
  ctx.fnDepth = prevFnDepth
  ctx.loopDepth = prevLoopDepth
  ctx.scopes.pop()
  return `fn (${params.join(', ')}) {\n${body.join('\n')}\n${'  '.repeat(depth)}}`
}

/** 闭包工厂：内层函数捕获参数与局部变量，并把函数值 return 出去（逃逸） */
function genClosureFactory(ctx: GenCtx, depth: number, innerArity: number): string {
  const indent = '  '.repeat(Math.max(1, depth))
  const captured = genNum(ctx, 1)
  const cap = declare(ctx, 'num')
  const head = `${indent}var ${cap} = ${captured};\n`
  const inner = genFnExpr(ctx, depth, innerArity)
  return `${head}${indent}return ${inner};\n`
}

function genStmt(ctx: GenCtx, depth: number): string {
  const indent = '  '.repeat(Math.max(1, depth))
  const choices: string[] = []
  choices.push('var', 'var', 'assign', 'print', 'expr', 'if', 'block')
  if (depth < 3) choices.push('while', 'for', 'for', 'fn', 'closure')
  if (ctx.fnDepth > 0) choices.push('return')
  if (ctx.loopDepth > 0) choices.push('break', 'continue')

  const kind = pick(ctx, choices)
  switch (kind) {
    case 'var': {
      const t = pick(ctx, ['num', 'num', 'str', 'arr', 'map', 'any'] as VarType[])
      // 先出初始化表达式，再登记变量名：反过来的话 genNum 会看见刚刚登记的自己，
      // 造出 var v7 = v7 + 1 这种「读取尚未初始化」的编译期错误，白白浪费一个种子
      let init: string
      if (t === 'arr') init = `[${genNum(ctx, 1)}, ${genNum(ctx, 1)}, ${genNum(ctx, 1)}]`
      else if (t === 'map') {
        const keys = [pick(ctx, MAP_KEYS), pick(ctx, MAP_KEYS)]
        init = `{${keys[0]}: ${genNum(ctx, 1)}, ${keys[1]}: ${genStr(ctx, 1)}}`
      } else if (t === 'str') init = genStr(ctx, 1)
      else if (t === 'any') init = genAny(ctx, 1)
      else init = String(genNum(ctx, 1))
      const name = declare(ctx, t)
      return `${indent}var ${name} = ${init};`
    }
    case 'assign': {
      const candidates = visible(ctx, () => true).filter(([name]) => !ctx.noWrite.has(name))
      if (candidates.length === 0) return `${indent}print(${genNum(ctx, 1)});`
      const [name, info] = pick(ctx, candidates)
      if (info.type === 'arr' && chance(ctx, 0.4)) {
        return `${indent}${name}[${small(ctx, 3)}] = ${genAny(ctx, 1)};`
      }
      if (info.type === 'map' && chance(ctx, 0.4)) {
        return `${indent}${name}.${pick(ctx, MAP_KEYS)} = ${genAny(ctx, 1)};`
      }
      const op = pick(ctx, ['=', '+=', '-=', '*='] as const)
      if (op === '=') return `${indent}${name} = ${genAny(ctx, 1)};`
      if (info.type === 'str') return `${indent}${name} += ${genStr(ctx, 1)};`
      if (info.type === 'num') return `${indent}${name} ${op} ${genNum(ctx, 1)};`
      return `${indent}${name} = ${genAny(ctx, 1)};`
    }
    case 'print':
      return `${indent}print(${genAny(ctx, 2)}${chance(ctx, 0.4) ? `, ${genAny(ctx, 2)}` : ''});`
    case 'expr':
      return `${indent}${genExprStmt(ctx, depth)};`
    case 'if': {
      const body = genBlock(ctx, depth + 1)
      if (chance(ctx, 0.5)) return `${indent}if (${genCond(ctx, 2)}) ${body}`
      return `${indent}if (${genCond(ctx, 2)}) ${genBlock(ctx, depth + 1)} else ${genBlock(ctx, depth + 1)}`
    }
    case 'block':
      return genBlock(ctx, depth + 1)
    case 'while': {
      // 必然终止：递减计数器打头，且计数器禁止被随机赋值改写
      const name = declare(ctx, 'num')
      ctx.noWrite.add(name)
      ctx.loopDepth++
      const body = `  ${indent}${name} -= 1;\n${genLoopBody(ctx, depth + 1)}`
      ctx.loopDepth--
      ctx.noWrite.delete(name)
      return `${indent}var ${name} = ${1 + small(ctx, 5)};\n${indent}while (${name} > 0) {\n${body}${indent}}\n`
    }
    case 'for': {
      const name = declare(ctx, 'num')
      ctx.noWrite.add(name)
      ctx.loopDepth++
      const body = genLoopBody(ctx, depth + 1)
      ctx.loopDepth--
      ctx.noWrite.delete(name)
      return `${indent}for (var ${name} = 0; ${name} < ${1 + small(ctx, 5)}; ${name} += 1) {\n${body}${indent}}\n`
    }
    case 'fn': {
      // 三成概率做成「闭包工厂」：内层函数捕获外层变量后被 return 出去，
      // 于是调用发生在定义作用域退出之后 —— 关闭 upvalue 的路径只有这里有覆盖
      const closure = depth < 3 && chance(ctx, 0.3)
      const innerArity = 1 + small(ctx, 2)
      const params = Array.from({ length: 1 + small(ctx, 2) }, (_, i) => `p${i}`)
      const name = declare(ctx, 'fn', closure ? { params: params.length, returnsFn: innerArity } : { params: params.length })
      ctx.scopes.push(new Map())
      params.forEach((p) => ctx.scopes[ctx.scopes.length - 1]!.set(p, { type: 'num' }))
      const prevFn = ctx.fnDepth
      const prevSelf = ctx.currentFn
      const prevLoop = ctx.loopDepth
      ctx.fnDepth++
      ctx.currentFn = name
      ctx.loopDepth = 0
      const body = Array.from({ length: 1 + small(ctx, 3) }, () => genStmt(ctx, depth + 1))
      body.push(
        closure
          ? genClosureFactory(ctx, depth + 1, innerArity)
          : `${'  '.repeat(depth + 1)}return ${genNum(ctx, 2)};`
      )
      ctx.fnDepth = prevFn
      ctx.currentFn = prevSelf
      ctx.loopDepth = prevLoop
      ctx.scopes.pop()
      return `${indent}fn ${name}(${params.join(', ')}) {\n${body.join('\n')}\n${indent}}\n`
    }
    case 'closure': {
      // 调用闭包工厂：拿到的函数值在其定义作用域退出之后才被调用
      const factories = visible(ctx, (v) => v.type === 'fn' && v.returnsFn !== undefined).filter(
        ([name]) => name !== ctx.currentFn
      )
      if (factories.length === 0) return `${indent}print(${genNum(ctx, 1)});`
      const [factory, info] = pick(ctx, factories)
      const args = Array.from({ length: info.params ?? 1 }, () => genNum(ctx, 1))
      const call = `${factory}(${args.join(', ')})`
      // 只打印函数值本身：固化 <fn 匿名> / <fn 名字> 这条格式化路径
      if (chance(ctx, 0.3)) return `${indent}print(${call});`
      const name = declare(ctx, 'fn', { params: info.returnsFn })
      return `${indent}var ${name} = ${call};\n${indent}print(${name}(${genNum(ctx, 1)}), ${name}(${genNum(ctx, 1)}));`
    }
    case 'return':
      return `${indent}return ${genNum(ctx, 2)};`
    case 'break':
      return `${indent}break;`
    default:
      return `${indent}continue;`
  }
}

function genBlock(ctx: GenCtx, depth: number): string {
  ctx.scopes.push(new Map())
  const stmts = Array.from({ length: 1 + small(ctx, 3) }, () => genStmt(ctx, depth))
  ctx.scopes.pop()
  return `{\n${stmts.join('\n')}\n${'  '.repeat(Math.max(1, depth - 1))}}\n`
}

/** 循环体：语句 + 少量 break/continue */
function genLoopBody(ctx: GenCtx, depth: number): string {
  const lines: string[] = []
  for (let i = 0; i < 1 + small(ctx, 3); i++) lines.push(genStmt(ctx, depth))
  if (chance(ctx, 0.3)) lines.push(`${'  '.repeat(depth)}if (${genNum(ctx, 1)} > ${small(ctx, 20)}) { break; }`)
  if (chance(ctx, 0.25)) lines.push(`${'  '.repeat(depth)}if (${genNum(ctx, 1)} % 2 == 0) { continue; }`)
  return lines.join('\n') + '\n'
}

function genExprStmt(ctx: GenCtx, depth: number): string {
  const arrs = visible(ctx, (v) => v.type === 'arr')
  const maps = visible(ctx, (v) => v.type === 'map')
  const fns = visible(ctx, (v) => v.type === 'fn' && v !== undefined).filter(
    ([name]) => name !== ctx.currentFn
  )
  const choices = ['push', 'pop', 'call']
  if (arrs.length > 0) choices.push('compoundIdx', 'pushFn', 'callIdx')
  if (maps.length > 0) choices.push('compoundMember')
  switch (pick(ctx, choices)) {
    case 'push':
      if (arrs.length === 0) return genNum(ctx, depth)
      return `push(${pick(ctx, arrs)[0]}, ${genAny(ctx, depth)})`
    case 'pop':
      if (arrs.length === 0) return genNum(ctx, depth)
      return `pop(${pick(ctx, arrs)[0]})`
    case 'call':
      if (fns.length > 0 && chance(ctx, 0.7)) {
        const [name, info] = pick(ctx, fns)
        const args = Array.from({ length: info.params ?? 1 }, () => genNum(ctx, depth))
        const call = `${name}(${args.join(', ')})`
        // 闭包工厂：接着调用那个已经逃逸出来的函数值
        if (info.returnsFn !== undefined && chance(ctx, 0.5))
          return `${call}(${Array.from({ length: info.returnsFn }, () => genNum(ctx, depth)).join(', ')})`
        return call
      }
      return `len(${genStr(ctx, depth)})`
    case 'pushFn': {
      // 把闭包塞进数组：数组槽位持有函数值，之后按下标调用
      const [name] = pick(ctx, arrs)
      return `push(${name}, ${genFnExpr(ctx, depth, 1 + small(ctx, 2))})`
    }
    case 'callIdx': {
      // 槽位里未必是函数（可能是数字或 nil）：两个后端必须在同一条指令报同一句话
      const [name] = pick(ctx, arrs)
      return `${name}[${small(ctx, 3)}](${genNum(ctx, depth)})`
    }
    case 'compoundIdx': {
      const [name] = pick(ctx, arrs)
      return `${name}[${small(ctx, 3)}] += ${genNum(ctx, depth)}`
    }
    default: {
      const [name] = pick(ctx, maps)
      return `${name}.${pick(ctx, MAP_KEYS)} += 1`
    }
  }
}

function genCond(ctx: GenCtx, depth: number): string {
  const kind = pick(ctx, ['numcmp', 'numcmp', 'streq', 'any', 'logic'] as const)
  if (kind === 'numcmp') return `${genNum(ctx, depth)} ${pick(ctx, ['<', '>', '<=', '>=', '==', '!='])} ${genNum(ctx, depth)}`
  if (kind === 'streq') return `${genStr(ctx, depth)} ${pick(ctx, ['==', '!='])} ${genStr(ctx, depth)}`
  if (kind === 'logic') return `${genCond(ctx, depth)} ${pick(ctx, ['and', 'or'])} ${genCond(ctx, depth)}`
  return `${genAny(ctx, depth)} == ${genAny(ctx, depth)}`
}

function genNum(ctx: GenCtx, depth: number): string {
  const nums = visible(ctx, (v) => v.type === 'num')
  const choices = ['lit', 'lit']
  if (nums.length > 0) choices.push('var', 'binop', 'builtin')
  if (depth > 0) choices.push('binop')
  switch (pick(ctx, choices)) {
    case 'lit':
      return String(small(ctx, 20) + 1)
    case 'var':
      return pick(ctx, nums)[0]
    case 'binop': {
      const op = pick(ctx, ['+', '-', '*', '<', '>']) // 除/取模避开除零路径，由专门用例覆盖
      return `(${genNum(ctx, depth - 1)} ${op} ${genNum(ctx, depth - 1)})`
    }
    default: {
      const fn = pick(ctx, ['floor', 'abs', 'len'])
      if (fn === 'floor' || fn === 'abs') return `${fn}(${genNum(ctx, depth - 1)})`
      return `len(${JSON.stringify(pick(ctx, ['abc', '茶茶']))})`
    }
  }
}

function genStr(ctx: GenCtx, depth: number): string {
  const strs = visible(ctx, (v) => v.type === 'str')
  const choices = ['lit']
  if (strs.length > 0) choices.push('var', 'concat')
  if (depth > 0) choices.push('concat')
  switch (pick(ctx, choices)) {
    case 'lit':
      return JSON.stringify(pick(ctx, STR_POOL))
    case 'var':
      return pick(ctx, strs)[0]
    default:
      return `(${genStr(ctx, depth - 1)} + ${genStr(ctx, depth - 1)})`
  }
}

function genAny(ctx: GenCtx, depth: number): string {
  const kind = pick(ctx, ['num', 'str', 'bool', 'nil', 'arr', 'map', 'tpl', 'logic', 'cond'] as const)
  switch (kind) {
    case 'num':
      return genNum(ctx, depth)
    case 'str':
      return genStr(ctx, depth)
    case 'bool':
      return pick(ctx, ['true', 'false'])
    case 'nil':
      return 'nil'
    case 'arr':
      return `[${genAny(ctx, 1)}, ${genAny(ctx, 1)}]`
    case 'map':
      return `{${pick(ctx, MAP_KEYS)}: ${genAny(ctx, 1)}}`
    case 'tpl':
      return `"前缀${'$'}{${genAny(ctx, 1)}}后缀"`
    case 'logic':
      return `(${genAny(ctx, depth)} ${pick(ctx, ['and', 'or'])} ${genAny(ctx, depth)})`
    default:
      return `(${genCond(ctx, depth)} ? ${genNum(ctx, 1)} : ${genStr(ctx, 1)})`
  }
}

function genProgram(rnd: Rnd): string {
  const ctx: GenCtx = {
    rnd,
    scopes: [new Map()],
    loopDepth: 0,
    fnDepth: 0,
    counter: 0,
    noWrite: new Set(),
    currentFn: null,
  }
  const lines: string[] = []
  for (let i = 0; i < 4 + small(ctx, 6); i++) lines.push(genStmt(ctx, 1))
  return lines.join('\n')
}

describe('差分模糊测试：随机程序双后端逐字节一致', () => {
  it('300 个种子程序全部一致', { timeout: 60_000 }, () => {
    let checked = 0
    for (let seed = 1; seed <= 300; seed++) {
      const src = genProgram(mulberry32(seed))
      const tree = run(src)
      const vm = runVM(src)
      const norm = (r: ReturnType<typeof run>) => JSON.stringify({ out: r.output, err: r.error })
      if (norm(tree) !== norm(vm)) {
        throw new Error(
          `种子 ${seed} 出现分歧\n--- 源码 ---\n${src}\n--- 树遍历 ---\n${norm(tree)}\n--- VM ---\n${norm(vm)}`
        )
      }
      checked++
    }
    expect(checked).toBe(300)
  })
})
