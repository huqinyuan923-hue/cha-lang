import { describe, expect, it } from 'vitest'
import { formatDiagnostic, formatErrorHeader, sourceExcerpt } from '../src/diagnostic'
import { run, runVM } from '../src/index'
import type { ChaErrorInfo } from '../src/index'

const runtime = (col: number): ChaErrorInfo => ({
  name: 'RuntimeError',
  message: "未定义的变量 '未知变量'",
  line: 1,
  col,
  phase: 'runtime',
})

describe('sourceExcerpt：源码行与插入符', () => {
  it('中文按两格对齐', () => {
    const src = 'var 结果 = 未知变量 + 1;'
    expect(sourceExcerpt(src, 1, 10)).toBe(
      ' 1 | var 结果 = 未知变量 + 1;\n' + `   | ${' '.repeat(11)}^`
    )
  })

  it('tab 按 4 格展开，可选宽度', () => {
    const src = '\t\tprint(1);'
    expect(sourceExcerpt(src, 1, 3)).toBe(
      ' 1 |         print(1);\n' + `   | ${' '.repeat(8)}^`
    )
    expect(sourceExcerpt(src, 1, 3, { tabSize: 2 })).toBe(
      ' 1 |     print(1);\n' + `   | ${' '.repeat(4)}^`
    )
  })

  it('emoji 的代理对算一个字符、两格', () => {
    const src = 'var 😀 = 1;'
    expect(sourceExcerpt(src, 1, 8)).toBe(
      ' 1 | var 😀 = 1;\n' + `   | ${' '.repeat(7)}^`
    )
    // 列号落进代理对中间时，插入符停在 emoji 起点
    expect(sourceExcerpt(src, 1, 6)).toBe(
      ' 1 | var 😀 = 1;\n' + `   | ${' '.repeat(4)}^`
    )
  })

  it('组合符零格，VS16 让文本符号变成两格', () => {
    const combining = 'var e\u0301 = 1;'
    expect(sourceExcerpt(combining, 1, 8)).toBe(
      ' 1 | var e\u0301 = 1;\n' + `   | ${' '.repeat(6)}^`
    )
    const heart = 'var ❤️ = 1;'
    expect(sourceExcerpt(heart, 1, 8)).toBe(
      ' 1 | var ❤️ = 1;\n' + `   | ${' '.repeat(7)}^`
    )
  })

  it('超长行围绕插入符裁剪，插入符仍对准原字符', () => {
    const src = '0123456789'.repeat(10)
    expect(sourceExcerpt(src, 1, 61, { maxLineWidth: 20 })).toBe(
      ' 1 | ...34567890123456...\n' + `   | ${' '.repeat(10)}^`
    )
    // 0 关闭裁剪
    expect(sourceExcerpt(src, 1, 61, { maxLineWidth: 0 })!.length).toBeGreaterThan(100)
  })

  it('CRLF 不把 \\r 带进片段', () => {
    const src = 'var a = 1;\r\nvar b = 2;'
    expect(sourceExcerpt(src, 2, 5)).toBe(
      ' 2 | var b = 2;\n' + `   | ${' '.repeat(4)}^`
    )
  })

  it('列号越过行尾时贴到行尾', () => {
    expect(sourceExcerpt('var x = 1;', 1, 99)).toBe(
      ' 1 | var x = 1;\n' + `   | ${' '.repeat(10)}^`
    )
  })

  it('行号不合法就不给片段', () => {
    expect(sourceExcerpt('var x = 1;', 0, 1)).toBeNull()
    expect(sourceExcerpt('var x = 1;', -1, 1)).toBeNull()
    expect(sourceExcerpt('var x = 1;', 2, 1)).toBeNull()
    expect(sourceExcerpt('var x = 1;', 1.5, 1)).toBeNull()
  })

  it('末尾空行也能指出来', () => {
    expect(sourceExcerpt('var x = 1;\n', 2, 1)).toBe(' 2 | \n   | ^')
  })
})

describe('formatDiagnostic', () => {
  it('默认标题带错误名与行列，再拼片段', () => {
    const src = 'var 结果 = 未知变量 + 1;'
    expect(formatDiagnostic(src, runtime(10))).toBe(
      "RuntimeError（第 1 行，第 10 列）：未定义的变量 '未知变量'\n" +
        ' 1 | var 结果 = 未知变量 + 1;\n' +
        `   | ${' '.repeat(11)}^`
    )
  })

  it('行 0（内部错误）不编造位置，也不给片段', () => {
    const error: ChaErrorInfo = {
      name: 'InternalError',
      message: '嵌套层级过深',
      line: 0,
      col: 0,
      phase: 'runtime',
    }
    expect(formatErrorHeader(error)).toBe('InternalError：嵌套层级过深')
    expect(formatDiagnostic('var x = 1;', error)).toBe('InternalError：嵌套层级过深')
  })

  it('宿主可以覆盖标题，但片段照旧', () => {
    const src = 'var x = 未知;'
    const error: ChaErrorInfo = { ...runtime(9), line: 1, col: 9 }
    const text = formatDiagnostic(src, error, { header: '自定义标题' })
    expect(text.startsWith('自定义标题\n 1 | var x = 未知;')).toBe(true)
  })

  it('行号超出源码时只留标题', () => {
    const error = { ...runtime(1), line: 9 }
    expect(formatDiagnostic('var x = 1;', error)).toBe(
      "RuntimeError（第 9 行，第 1 列）：未定义的变量 '未知变量'"
    )
  })
})

describe('错误片段：两个后端逐字一致', () => {
  const cases = [
    ['词法', 'var s = "没关引号;'],
    ['语法', 'if (true) {'],
    ['作用域', 'print(不存在);'],
    ['运行时', 'print(1 / 0);'],
    ['未捕获 throw', 'throw "没茶了";'],
  ] as const

  for (const [label, src] of cases) {
    it(label, () => {
      const tree = run(src)
      const vm = runVM(src)
      expect(tree.error).toBeDefined()
      expect(vm.error).toEqual(tree.error)
      expect(formatDiagnostic(src, tree.error!)).toBe(formatDiagnostic(src, vm.error!))
      expect(formatDiagnostic(src, tree.error!)).toContain('^')
    })
  }

  it('多行程序指向真正出错的那一行', () => {
    const src = 'var x = 1;\nvar y = 2;\nprint(x + 未知);'
    const tree = run(src)
    const vm = runVM(src)
    expect(tree.error?.line).toBe(3)
    const text = formatDiagnostic(src, tree.error!)
    expect(text).toContain(' 3 | print(x + 未知);')
    expect(text).not.toContain(' 1 | var x = 1;')
    expect(formatDiagnostic(src, vm.error!)).toBe(text)
  })
})
