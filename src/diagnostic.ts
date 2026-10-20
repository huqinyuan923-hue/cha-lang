/**
 * 把结构化错误渲染成「标题 + 出错行 + 插入符」的文本。
 * 宿主（CLI / Playground）共用同一份逻辑，两个后端自然也就共用。
 *
 * 插入符要落在终端/等宽字体里的真实位置上：中文按两格、组合符零格、
 * tab 展开成 4 格、代理对整体算一个字符；超长行围绕插入符裁剪。
 */

export interface DiagnosticInfo {
  name: string
  message: string
  line: number
  col: number
}

export interface ExcerptOptions {
  /** 制表符展开宽度，默认 4 */
  tabSize?: number
  /** 源码行的最大显示宽度（终端列），默认 120；<= 0 表示不裁剪 */
  maxLineWidth?: number
}

export interface DiagnosticOptions extends ExcerptOptions {
  /** 覆盖默认标题（CLI 用它换成人话相位名） */
  header?: string
}

const DEFAULT_TAB_SIZE = 4
const DEFAULT_MAX_LINE_WIDTH = 120
// 用 ASCII 省略号：U+2026 在中文字体里可能占两格，插入符就和源码错开了
const ELLIPSIS = '...'
const ELLIPSIS_WIDTH = ELLIPSIS.length

/** 标题行：有位置就带「第 x 行，第 y 列」，内部错误（行 0）只给名字和消息 */
export function formatErrorHeader(error: DiagnosticInfo): string {
  const position = error.line > 0 ? `（第 ${error.line} 行，第 ${error.col} 列）` : ''
  return `${error.name}${position}：${error.message}`
}

export function formatDiagnostic(
  source: string,
  error: DiagnosticInfo,
  options: DiagnosticOptions = {}
): string {
  const header = options.header ?? formatErrorHeader(error)
  const excerpt = sourceExcerpt(source, error.line, error.col, options)
  return excerpt === null ? header : `${header}\n${excerpt}`
}

/**
 * 单独取出源码片段：两行是「行号 | 源码」，第三行是插入符。
 * 行号不合法（0、负数、超出源码）时返回 null——宁可不给，也不能指错行。
 */
export function sourceExcerpt(
  source: string,
  line: number,
  col: number,
  options: ExcerptOptions = {}
): string | null {
  if (!Number.isInteger(line) || line < 1) return null
  const lines = source.split(/\r\n|\r|\n/)
  const raw = lines[line - 1]
  if (raw === undefined) return null

  const tabSize = Math.max(1, Math.trunc(options.tabSize ?? DEFAULT_TAB_SIZE))
  const maxLineWidth = options.maxLineWidth ?? DEFAULT_MAX_LINE_WIDTH
  const measured = measureLine(raw, col, tabSize)
  const clipped = clipLine(measured.text, measured.caret, measured.width, maxLineWidth)

  const number = String(line)
  const gutter = ' '.repeat(number.length)
  return (
    ` ${number} | ${clipped.line}\n` +
    ` ${gutter} | ${' '.repeat(clipped.caret)}^`
  )
}

interface MeasuredLine {
  /** tab 已展开成空格的源码行 */
  text: string
  /** 插入符前的显示格数（不是 UTF-16 下标） */
  caret: number
  width: number
}

function measureLine(line: string, col: number, tabSize: number): MeasuredLine {
  const target = Number.isFinite(col) ? Math.max(0, Math.trunc(col) - 1) : 0
  let units = 0
  let width = 0
  let caret = -1
  let text = ''

  for (const glyph of glyphWidths(line)) {
    // 列号落在代理对中间时，插入符停在那个字符的起点
    if (caret < 0 && units + glyph.text.length > target) caret = width
    if (glyph.text === '\t') {
      const spaces = tabSize - (width % tabSize)
      text += ' '.repeat(spaces)
      width += spaces
    } else {
      text += glyph.text
      width += glyph.width
    }
    units += glyph.text.length
  }

  return { text, caret: caret < 0 ? width : caret, width }
}

function clipLine(
  line: string,
  caret: number,
  width: number,
  maxLineWidth: number
): { line: string; caret: number } {
  if (maxLineWidth <= 0 || width <= maxLineWidth) return { line, caret }

  const budget = Math.max(1, maxLineWidth - ELLIPSIS_WIDTH * 2)
  const start = Math.max(0, Math.min(Math.trunc(caret - budget / 2), width - budget))
  const slice = sliceByWidth(line, start, start + budget)
  const hasLeft = slice.start > 0
  const hasRight = slice.end < width

  return {
    line: `${hasLeft ? ELLIPSIS : ''}${slice.text}${hasRight ? ELLIPSIS : ''}`,
    caret: Math.max(0, caret - slice.start + (hasLeft ? ELLIPSIS_WIDTH : 0)),
  }
}

function sliceByWidth(
  text: string,
  startCell: number,
  endCell: number
): { text: string; start: number; end: number } {
  let cell = 0
  let start = -1
  let end = 0
  let out = ''

  for (const glyph of glyphWidths(text)) {
    if (cell >= endCell) break
    if (cell + glyph.width <= startCell) {
      cell += glyph.width
      continue
    }
    if (start < 0) start = cell
    out += glyph.text
    cell += glyph.width
    end = cell
  }

  if (start < 0) start = Math.min(startCell, cell)
  return { text: out, start, end: Math.max(end, start) }
}

interface Glyph {
  text: string
  width: number
}

/** 逐个码点给出显示宽度；顺带处理 ZWJ 序列、肤色修饰、旗帜和 emoji 变体选择符 */
function* glyphWidths(text: string): Generator<Glyph> {
  let joinNext = false
  let prevWasRegional = false
  let lastWidth = 0

  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    let width = codePointWidth(cp)

    if (joinNext) {
      width = 0
      joinNext = false
    }
    if (cp === 0x200d) {
      joinNext = true
      width = 0
    }
    if (isRegionalIndicator(cp)) {
      if (prevWasRegional) {
        width = 0
        prevWasRegional = false
      } else {
        prevWasRegional = true
      }
    } else {
      prevWasRegional = false
    }
    // 文本型字符 + VS16 会按 emoji 渲染（两格）：❤️ 而不是 ❤
    if (cp === 0xfe0f && lastWidth === 1) width = 1

    yield { text: ch, width }
    lastWidth = width
  }
}

function codePointWidth(cp: number): number {
  // 零宽：ZWSP / ZWNJ / ZWJ / 词连接符 / BOM / 标签字符
  if (
    cp === 0x200b ||
    cp === 0x200c ||
    cp === 0x200d ||
    cp === 0x2060 ||
    cp === 0xfeff ||
    (cp >= 0xe0020 && cp <= 0xe007f)
  ) {
    return 0
  }
  if (cp < 0x20 || cp === 0x7f) return 0
  if (isZeroWidthMark(cp)) return 0
  return isWide(cp) ? 2 : 1
}

function isZeroWidthMark(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) || // 组合变音符号
    (cp >= 0x0483 && cp <= 0x0489) ||
    (cp >= 0x0591 && cp <= 0x05bd) ||
    (cp >= 0x0610 && cp <= 0x061a) ||
    (cp >= 0x064b && cp <= 0x065f) ||
    (cp >= 0x0900 && cp <= 0x0903) ||
    (cp >= 0x093a && cp <= 0x094f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) || // 变体选择符
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    (cp >= 0x1f3fb && cp <= 0x1f3ff) || // 肤色修饰
    (cp >= 0xe0100 && cp <= 0xe01ef)
  )
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // 谚文字母
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) || // CJK / 部首 / 注音 / 彝文
    (cp >= 0xac00 && cp <= 0xd7a3) || // 谚文音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) || // 全角
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f000 && cp <= 0x1faff) || // emoji / 麻将 / 牌
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK 扩展
  )
}

function isRegionalIndicator(cp: number): boolean {
  return cp >= 0x1f1e6 && cp <= 0x1f1ff
}
