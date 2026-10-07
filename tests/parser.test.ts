import { describe, expect, it } from 'vitest'
import { parse } from '../src/parser'
import { ParseError } from '../src/parser'
import type { Expr, Stmt } from '../src/ast'

/** 取第一条语句的表达式（exprStmt） */
const exprOf = (src: string): Expr => {
  const stmts = parse(src) as Stmt[]
  const first = stmts[0]!
  if (first.type !== 'exprStmt') throw new Error(`第一句是 ${first.type}，不是表达式语句`)
  return first.expr
}
const stmtsOf = (src: string): Stmt[] => parse(src)

describe('表达式优先级', () => {
  it('乘法优先于加法：1 + 2 * 3', () => {
    const e = exprOf('1 + 2 * 3;') as Extract<Expr, { type: 'binary' }>
    expect(e.op).toBe('+')
    expect((e.left as Extract<Expr, { type: 'literal' }>).value).toBe(1)
    expect((e.right as Extract<Expr, { type: 'binary' }>).op).toBe('*')
  })

  it('括号覆盖优先级：(1 + 2) * 3', () => {
    const e = exprOf('(1 + 2) * 3;') as Extract<Expr, { type: 'binary' }>
    expect(e.op).toBe('*')
    expect((e.left as Extract<Expr, { type: 'binary' }>).op).toBe('+')
  })

  it('左结合：1 - 2 - 3', () => {
    const e = exprOf('1 - 2 - 3;') as Extract<Expr, { type: 'binary' }>
    expect(e.op).toBe('-')
    expect((e.right as Extract<Expr, { type: 'literal' }>).value).toBe(3)
    expect((e.left as Extract<Expr, { type: 'binary' }>).op).toBe('-')
  })

  it('比较低于加减：1 + 2 < 4', () => {
    const e = exprOf('1 + 2 < 4;') as Extract<Expr, { type: 'binary' }>
    expect(e.op).toBe('<')
    expect((e.left as Extract<Expr, { type: 'binary' }>).op).toBe('+')
  })

  it('and 优先于 or', () => {
    const e = exprOf('true or false and true;') as Extract<Expr, { type: 'binary' }>
    expect(e.op).toBe('or')
    expect((e.right as Extract<Expr, { type: 'binary' }>).op).toBe('and')
  })

  it('一元运算绑定紧：-2 * 3 → (-2) * 3', () => {
    const e = exprOf('-2 * 3;') as Extract<Expr, { type: 'binary' }>
    expect((e.left as Extract<Expr, { type: 'unary' }>).op).toBe('-')
  })

  it('双一元：!!true', () => {
    const e = exprOf('!!true;') as Extract<Expr, { type: 'unary' }>
    expect(e.op).toBe('!')
    expect((e.operand as Extract<Expr, { type: 'unary' }>).op).toBe('!')
  })

  it('三元运算符', () => {
    const e = exprOf('x > 1 ? "大" : "小";') as Extract<Expr, { type: 'conditional' }>
    expect(e.test.type).toBe('binary')
    expect((e.consequent as Extract<Expr, { type: 'literal' }>).value).toBe('大')
  })
})

describe('赋值', () => {
  it('右结合：a = b = 1', () => {
    const e = exprOf('a = b = 1;') as Extract<Expr, { type: 'assign' }>
    expect(e.op).toBe('=')
    expect(e.target).toMatchObject({ kind: 'identifier', name: 'a' })
    expect((e.value as Extract<Expr, { type: 'assign' }>).target).toMatchObject({ name: 'b' })
  })

  it('复合赋值', () => {
    const e = exprOf('n += 2;') as Extract<Expr, { type: 'assign' }>
    expect(e.op).toBe('+=')
  })

  it('下标赋值与点号赋值', () => {
    expect(exprOf('a[0] = 9;')).toMatchObject({ type: 'assign', target: { kind: 'index' } })
    expect(exprOf('m.k = 9;')).toMatchObject({ type: 'assign', target: { kind: 'member', key: 'k' } })
  })

  it('非法赋值目标报错', () => {
    expect(() => parse('1 = 2;')).toThrow(ParseError)
    expect(() => parse('f() = 2;')).toThrow(/不能被赋值/)
  })
})

describe('调用与后缀链', () => {
  it('f(1)[2].k', () => {
    const e = exprOf('f(1)[2].k;') as Extract<Expr, { type: 'member' }>
    expect(e.key).toBe('k')
    const index = e.target as Extract<Expr, { type: 'index' }>
    expect(index.index).toMatchObject({ type: 'literal', value: 2 })
    expect((index.target as Extract<Expr, { type: 'call' }>).args).toHaveLength(1)
  })

  it('函数实参列表', () => {
    const e = exprOf('add(1, 2, 3);') as Extract<Expr, { type: 'call' }>
    expect(e.args).toHaveLength(3)
  })

  it('缺右括号报错', () => {
    expect(() => parse('f(1;')).toThrow(/'\)'/)
  })
})

describe('数组与 map 字面量', () => {
  it('数组含末尾逗号', () => {
    const e = exprOf('[1, 2, 3,];') as Extract<Expr, { type: 'array' }>
    expect(e.elements).toHaveLength(3)
  })

  it('map：字符串键、标识符键、计算键（表达式位置的 {} 才是 map）', () => {
    const s = stmtsOf('var m = {"a": 1, b: 2, [k]: 3};')[0] as Extract<Stmt, { type: 'var' }>
    const e = s.initializer! as Extract<Expr, { type: 'map' }>
    expect(e.entries).toHaveLength(3)
    expect(e.entries[0]!.key).toMatchObject({ type: 'literal', value: 'a' })
    expect(e.entries[1]!.key).toMatchObject({ type: 'literal', value: 'b' })
    expect(e.entries[2]!.key).toMatchObject({ type: 'identifier', name: 'k' })
  })

  it('语句开头的 {} 是代码块，不是 map（与 JS 同款歧义）', () => {
    const s = stmtsOf('{ print(1); }')[0]!
    expect(s.type).toBe('block')
  })

  it('map 缺冒号报错', () => {
    expect(() => parse('var m = {"a" 1};')).toThrow(/':'/)
  })
})

describe('模板字符串', () => {
  it('组装 parts 与 exprs', () => {
    const e = exprOf('"合计 ${a + b} 元，共 ${n} 件";') as Extract<Expr, { type: 'template' }>
    expect(e.parts).toEqual(['合计 ', ' 元，共 ', ' 件'])
    expect(e.exprs).toHaveLength(2)
    expect(e.exprs[0]).toMatchObject({ type: 'binary', op: '+' })
  })

  it('插值必须是单个表达式', () => {
    expect(() => parse('"${1 2}";')).toThrow(ParseError)
  })

  it('空插值报错（无表达式）', () => {
    expect(() => parse('"${}";')).toThrow(ParseError)
  })
})

describe('语句', () => {
  it('var 声明带或不带初始化', () => {
    const s = stmtsOf('var a = 1;\nvar b;')
    expect(s[0]).toMatchObject({ type: 'var', name: 'a' })
    expect(s[1]).toMatchObject({ type: 'var', name: 'b', initializer: undefined })
  })

  it('print 是内建函数：print(1, 2, 3) 是普通调用表达式', () => {
    const s = stmtsOf('print(1, 2, 3);')[0]!
    expect(s.type).toBe('exprStmt')
    expect(((s as { expr: Expr }).expr as Extract<Expr, { type: 'call' }>).args).toHaveLength(3)
  })

  it('if/else 悬挂问题：else 归属最近的 if', () => {
    const s = stmtsOf('if (a) if (b) print(1); else print(2);')[0] as Extract<Stmt, { type: 'if' }>
    expect(s.type).toBe('if')
    const inner = s.then as Extract<Stmt, { type: 'if' }>
    expect(inner.type).toBe('if')
    expect(inner.else).toBeDefined()
  })

  it('while 与 for（for 还原为结构化节点）', () => {
    const f = stmtsOf('for (var i = 0; i < 3; i += 1) print(i);')[0] as Extract<
      Stmt,
      { type: 'for' }
    >
    expect(f.type).toBe('for')
    expect(f.init).toMatchObject({ type: 'var' })
    expect(f.test).toMatchObject({ type: 'binary', op: '<' })
    expect(f.update).toMatchObject({ type: 'assign', op: '+=' })
  })

  it('return 带值/不带值', () => {
    const a = stmtsOf('fn f() { return 1; }')[0] as Extract<Stmt, { type: 'fnDecl' }>
    expect(a.fn.body[0]).toMatchObject({ type: 'return', value: { type: 'literal', value: 1 } })
    const b = stmtsOf('fn f() { return; }')[0] as Extract<Stmt, { type: 'fnDecl' }>
    expect(b.fn.body[0]).toMatchObject({ type: 'return', value: undefined })
  })

  it('fn 声明与匿名 fn 表达式', () => {
    const decl = stmtsOf('fn add(a, b) { return a + b; }')[0] as Extract<Stmt, { type: 'fnDecl' }>
    expect(decl.fn.name).toBe('add')
    expect(decl.fn.params).toEqual(['a', 'b'])

    const anon = (stmtsOf('var f = fn(x) { return x; };')[0] as Extract<Stmt, { type: 'var' }>)
      .initializer!
    expect(anon).toMatchObject({ type: 'fn', params: ['x'] })
  })

  it('块语句', () => {
    const s = stmtsOf('{ print(1); print(2); }')[0]!
    expect(s.type).toBe('block')
  })
})

describe('解析错误', () => {
  it('缺分号', () => {
    expect(() => parse('var a = 1')).toThrow(/';'/)
  })

  it('缺收尾花括号', () => {
    expect(() => parse('fn f() { print(1);')).toThrow(/}/)
  })

  it('多余 token', () => {
    expect(() => parse('var 1a;')).toThrow(ParseError)
    expect(() => parse('print(1) print(2);')).toThrow(ParseError)
  })

  it('空程序合法', () => {
    expect(parse('')).toEqual([])
    expect(parse('// 只有注释\n/* 嵌套 /* 注释 */ */')).toEqual([])
  })
})
