import { describe, expect, it } from 'vitest'
import { LexError, scan } from '../src/lexer'
import type { Token } from '../src/token'

const types = (src: string) => scan(src).map((t) => t.type)
const numbers = (src: string) =>
  scan(src)
    .filter((t) => t.type === 'NUMBER')
    .map((t) => t.literal)

describe('基础 token', () => {
  it('单字符标点与运算符', () => {
    expect(types('()[]{};,?')).toEqual([
      'LEFT_PAREN', 'RIGHT_PAREN', 'LEFT_BRACKET', 'RIGHT_BRACKET', 'LEFT_BRACE',
      'RIGHT_BRACE', 'SEMICOLON', 'COMMA', 'QUESTION', 'EOF',
    ])
    expect(types('< > = ! + - * / % : .')).toEqual([
      'LESS', 'GREATER', 'ASSIGN', 'BANG', 'PLUS', 'MINUS', 'STAR', 'SLASH',
      'PERCENT', 'COLON', 'DOT', 'EOF',
    ])
  })

  it('双字符运算符不被拆开', () => {
    expect(types('== != <= >= += -= *= /= %=')).toEqual([
      'EQUAL', 'BANG_EQUAL', 'LESS_EQUAL', 'GREATER_EQUAL',
      'PLUS_ASSIGN', 'MINUS_ASSIGN', 'STAR_ASSIGN', 'SLASH_ASSIGN', 'PERCENT_ASSIGN', 'EOF',
    ])
  })

  it('单个 = 与 != 的边界', () => {
    expect(types('= =')).toEqual(['ASSIGN', 'ASSIGN', 'EOF'])
    expect(types('!= =')).toEqual(['BANG_EQUAL', 'ASSIGN', 'EOF'])
    expect(types('!==')).toEqual(['BANG_EQUAL', 'ASSIGN', 'EOF'])
  })

  it('数字：整数、小数、科学计数法', () => {
    expect(numbers('42 1.5 1e3 2.5e-2')).toEqual([42, 1.5, 1000, 0.025])
  })

  it('关键字与标识符', () => {
    expect(types('var fn if else while for return true false nil and or break continue')).toEqual([
      'VAR', 'FN', 'IF', 'ELSE', 'WHILE', 'FOR', 'RETURN', 'TRUE', 'FALSE',
      'NIL', 'AND', 'OR', 'BREAK', 'CONTINUE', 'EOF',
    ])
    expect(types('variable ifx for_ _x')).toEqual([
      'IDENTIFIER', 'IDENTIFIER', 'IDENTIFIER', 'IDENTIFIER', 'EOF',
    ])
  })

  it('中文变量名是一等公民', () => {
    const tokens = scan('变量 = "值"')
    expect(tokens[0]).toMatchObject({ type: 'IDENTIFIER', lexeme: '变量' })
    expect(types('打印你好世界')).toEqual(['IDENTIFIER', 'EOF'])
  })

  it('行号与列号', () => {
    const tokens = scan('var x\n  y')
    expect(tokens[0]).toMatchObject({ type: 'VAR', line: 1, col: 1 })
    expect(tokens[1]).toMatchObject({ type: 'IDENTIFIER', lexeme: 'x', line: 1, col: 5 })
    expect(tokens[2]).toMatchObject({ type: 'IDENTIFIER', lexeme: 'y', line: 2, col: 3 })
  })

  it('多字符运算符的位置记录起点', () => {
    const tokens = scan('a == b')
    expect(tokens[1]).toMatchObject({ type: 'EQUAL', line: 1, col: 3 })
  })
})

describe('字符串', () => {
  it('普通字符串与转义', () => {
    const t = scan('"a\\n\\t\\"\\\\b"')[0]!
    expect(t.type).toBe('STRING')
    expect(t.literal).toBe('a\n\t"\\b')
  })

  it('字符串可以跨行，token 记录起始行', () => {
    const t = scan('"第一行\n第二行"')[0]!
    expect(t.literal).toBe('第一行\n第二行')
    expect(t.line).toBe(1)
  })

  it('未闭合字符串报错并带位置', () => {
    expect(() => scan('"abc')).toThrow(LexError)
    expect(() => scan('"abc')).toThrow(/缺少收尾的双引号/)
  })

  it('未知转义报错', () => {
    expect(() => scan('"\\x"')).toThrow(/未知的转义序列/)
  })

  it('单独的 $ 不是插值', () => {
    expect(scan('"100$ 5$"')[0]!.literal).toBe('100$ 5$')
  })

  it('\\$ 转义阻止插值', () => {
    expect(scan('"\\${name}"')[0]!.literal).toBe('${name}')
  })
})

describe('模板字符串插值', () => {
  /** 主流里的插值表达式 token 都挂在标记的 .interp 上 */
  const interpOf = (src: string): Token[] => {
    const tokens = scan(src)
    const start = tokens.find((t) => t.type === 'TEMPLATE_START' || t.type === 'TEMPLATE_MIDDLE')
    expect(start, '应有插值标记').toBeDefined()
    return start!.interp ?? []
  }

  it('简单插值：主流只剩三段式标记', () => {
    const tokens = scan('"你好 ${name}！"')
    expect(types('"你好 ${name}！"')).toEqual(['TEMPLATE_START', 'TEMPLATE_END', 'EOF'])
    expect(tokens[0]!.literal).toBe('你好 ')
    expect(tokens[0]!.interp?.map((t) => t.type)).toEqual(['IDENTIFIER', 'EOF'])
    expect(tokens[1]!.literal).toBe('！')
  })

  it('多个插值：START MIDDLE MIDDLE END', () => {
    const tokens = scan('"${a}-${b}-${c}"')
    expect(types('"${a}-${b}-${c}"')).toEqual([
      'TEMPLATE_START', 'TEMPLATE_MIDDLE', 'TEMPLATE_MIDDLE', 'TEMPLATE_END', 'EOF',
    ])
    expect(tokens[0]!.interp?.[0]).toMatchObject({ type: 'IDENTIFIER', lexeme: 'a' })
    expect(tokens[1]!.literal).toBe('-')
    expect(tokens[1]!.interp?.[0]).toMatchObject({ lexeme: 'b' })
    expect(tokens[2]!.interp?.[0]).toMatchObject({ lexeme: 'c' })
  })

  it('插值里可以有完整表达式', () => {
    expect(interpOf('"${1 + (2 * 3)}"').map((t) => t.type)).toEqual([
      'NUMBER', 'PLUS', 'LEFT_PAREN', 'NUMBER', 'STAR', 'NUMBER', 'RIGHT_PAREN', 'EOF',
    ])
  })

  it('插值里的 map 花括号不与插值边界混淆', () => {
    expect(interpOf('"${ {a: 1}.a }"').map((t) => t.type)).toEqual([
      'LEFT_BRACE', 'IDENTIFIER', 'COLON', 'NUMBER', 'RIGHT_BRACE', 'DOT', 'IDENTIFIER', 'EOF',
    ])
  })

  it('插值里可以嵌套字符串', () => {
    const inner = interpOf('"${ "hello" }"')
    expect(inner.map((t) => t.type)).toEqual(['STRING', 'EOF'])
    expect(inner[0]!.literal).toBe('hello')
  })

  it('嵌套插值：插值里的字符串里再插值（递归分组）', () => {
    const outer = interpOf('"outer ${ "inner ${deep}" } tail"')
    // 外层插值表达式 = 一个嵌套模板表达式 + 若干 token
    const nestedStart = outer.find((t) => t.type === 'TEMPLATE_START')
    expect(nestedStart, '嵌套模板应以 TEMPLATE_START 出现在外层插值里').toBeDefined()
    expect(nestedStart!.literal).toBe('inner ')
    expect(nestedStart!.interp?.[0]).toMatchObject({ type: 'IDENTIFIER', lexeme: 'deep' })
    // 外层主流里只有一对 START/END
    expect(types('"outer ${ "inner ${deep}" } tail"')).toEqual([
      'TEMPLATE_START', 'TEMPLATE_END', 'EOF',
    ])
  })

  it('纯文本模板：START/MIDDLE 携带字面量，END 收尾', () => {
    const tokens = scan('"a${x}b${y}c"')
    expect(tokens[0]!.literal).toBe('a')
    expect(tokens[1]!.literal).toBe('b')
    expect(tokens[2]!.literal).toBe('c')
    expect(tokens[2]!.type).toBe('TEMPLATE_END')
    expect(tokens[1]!.interp?.[0]).toMatchObject({ lexeme: 'y' })
  })

  it('插值缺少 } 时，收尾引号被当作嵌套字符串的开引号，最终报字符串未闭合', () => {
    // 这是纯词法器的已知歧义点：无法区分「插值后的收尾引号」与「嵌套字符串开引号」，
    // 系列 TODO 里会用解析器协同解决；当前行为是报「字符串缺少收尾的双引号」
    expect(() => scan('"${1 + 2"')).toThrow(/字符串缺少收尾的双引号/)
  })

  it('插值后的字符串未闭合报错', () => {
    expect(() => scan('"${1}abc')).toThrow(/缺少收尾的双引号/)
  })
})

describe('注释', () => {
  it('行注释到行尾', () => {
    expect(types('1 // 这是注释\n2')).toEqual(['NUMBER', 'NUMBER', 'EOF'])
  })

  it('块注释可以嵌套', () => {
    expect(types('1 /* 外层 /* 内层 */ 还是外层 */ 2')).toEqual(['NUMBER', 'NUMBER', 'EOF'])
  })

  it('未闭合块注释报错', () => {
    expect(() => scan('/* abc')).toThrow(/缺少收尾/)
  })

  it('注释里的字符串不会开启字符串模式', () => {
    expect(types('// "abc\n1')).toEqual(['NUMBER', 'EOF'])
  })
})

describe('错误', () => {
  it('意外字符带位置', () => {
    try {
      scan('var @')
      expect.fail('应当抛错')
    } catch (e) {
      const err = e as LexError
      expect(err).toBeInstanceOf(LexError)
      expect(err.line).toBe(1)
      expect(err.col).toBe(5)
    }
  })

  it('数字不能以点开头', () => {
    expect(() => scan('.5')).toThrow(/不能以点开头/)
    expect(() => scan('1.')).toThrow(/小数点必须跟数字/)
    expect(() => scan('1e')).toThrow(/e 后面必须是数字/)
  })
})
