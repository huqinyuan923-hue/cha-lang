import type { Token, TokenType } from './token'

export class LexError extends Error {
  constructor(
    message: string,
    public line: number,
    public col: number
  ) {
    super(`[line ${line}, col ${col}] ${message}`)
    this.name = 'LexError'
  }
}

const KEYWORDS: Record<string, TokenType> = {
  var: 'VAR',
  fn: 'FN',
  if: 'IF',
  else: 'ELSE',
  while: 'WHILE',
  for: 'FOR',
  return: 'RETURN',
  true: 'TRUE',
  false: 'FALSE',
  nil: 'NIL',
  and: 'AND',
  or: 'OR',
  break: 'BREAK',
  continue: 'CONTINUE',
}

const ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  '\\': '\\',
  '"': '"',
  $: '$',
}

/** 标识符：ASCII 字母/下划线 + CJK（中文变量名是一等公民） */
function isAlpha(ch: string): boolean {
  return (
    (ch >= 'a' && ch <= 'z') ||
    (ch >= 'A' && ch <= 'Z') ||
    ch === '_' ||
    (ch >= '\u4E00' && ch <= '\u9FFF') ||
    (ch >= '\u3400' && ch <= '\u4DBF')
  )
}
function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}
function isAlphaNumeric(ch: string): boolean {
  return isAlpha(ch) || isDigit(ch)
}

/**
 * 词法分析器：字符流 → token 流。
 *
 * 两个值得一提的机制（系列文章第 2 章的主角）：
 *  1. 模板字符串插值 "hello ${name}" —— 字符串与代码两种模式互相递归；
 *     插值表达式整体作为一个 token 数组挂在 TEMPLATE_START/MIDDLE 上，
 *     嵌套插值（插值里的字符串里再插值）自然递归，主 token 流零歧义；
 *  2. 支持嵌套的块注释 —— /* 里面可以再套 /* 一层 *​/，C 语言都做不到。
 */
export function scan(source: string): Token[] {
  const tokens: Token[] = []
  let pos = 0
  let line = 1
  let col = 1

  const eof = (): boolean => pos >= source.length
  const peek = (): string => (eof() ? '\0' : source[pos]!)
  const peekNext = (): string => (pos + 1 >= source.length ? '\0' : source[pos + 1]!)
  const advance = (): string => {
    const ch = source[pos]!
    pos++
    if (ch === '\n') {
      line++
      col = 1
    } else {
      col++
    }
    return ch
  }
  const match = (expected: string): boolean => {
    if (peek() !== expected) return false
    advance()
    return true
  }
  const mark = (): { line: number; col: number } => ({ line, col })
  const emit = (
    at: { line: number; col: number },
    type: TokenType,
    lexeme: string,
    literal?: number | string,
    interp?: Token[]
  ): void => {
    tokens.push({ type, lexeme, literal, interp, line: at.line, col: at.col })
  }
  const error = (at: { line: number; col: number }, message: string): never => {
    throw new LexError(message, at.line, at.col)
  }

  /** 扫描数字：整数、小数、科学计数法（要求首个数字已被 advance） */
  function scanNumber(first: string, at: { line: number; col: number }): void {
    let text = first
    while (isDigit(peek())) text += advance()
    if (peek() === '.') {
      if (!isDigit(peekNext())) {
        error(at, `数字后的小数点必须跟数字，比如 1.5 而不是 ${text}.`)
      }
      text += advance() // '.'
      while (isDigit(peek())) text += advance()
    }
    if (peek() === 'e' || peek() === 'E') {
      let exp = advance()
      if (peek() === '+' || peek() === '-') exp += advance()
      if (!isDigit(peek())) error(at, '科学计数法的 e 后面必须是数字')
      while (isDigit(peek())) exp += advance()
      text += exp
    }
    emit(at, 'NUMBER', text, Number(text))
  }

  /** 读标识符或关键字（要求首字符已被 advance） */
  function scanIdentifier(first: string, at: { line: number; col: number }): void {
    let text = first
    while (isAlphaNumeric(peek())) text += advance()
    emit(at, KEYWORDS[text] ?? 'IDENTIFIER', text)
  }

  /**
   * 读字符串字面量。要求开引号已被消费。
   * 含插值（或位于插值内部）时按 TEMPLATE_START/MIDDLE/END 流出，
   * 每段插值表达式的 token 序列挂在对应标记的 .interp 上。
   */
  function readString(): void {
    const start = mark()
    let cooked = ''
    let template = false
    for (;;) {
      if (eof()) error(start, '字符串缺少收尾的双引号')
      const ch = peek()
      if (ch === '"') {
        const at = mark()
        advance()
        if (template) emit(at, 'TEMPLATE_END', '"', cooked)
        else emit(start, 'STRING', `"${cooked}"`, cooked)
        return
      }
      if (ch === '$' && peekNext() === '{') {
        const at = mark()
        advance() // $
        advance() // {
        const interpTokens = readInterpolation(start)
        if (template) emit(at, 'TEMPLATE_MIDDLE', '${', cooked, interpTokens)
        else emit(at, 'TEMPLATE_START', '"${', cooked, interpTokens)
        cooked = ''
        template = true
        continue
      }
      if (ch === '\\') {
        const at = mark()
        advance()
        const esc = peek()
        const mapped = ESCAPES[esc]
        if (mapped === undefined) {
          error(at, `未知的转义序列 \\${esc}（支持 \\n \\t \\r \\\\ \\" \\$）`)
        }
        advance()
        cooked += mapped
        continue
      }
      cooked += advance()
    }
  }

  /**
   * 扫描插值表达式：直到与 ${ 匹配的 }（已消费），返回收集到的 token（含 EOF）。
   * 内部出现字符串字面量时递归 readString——嵌套插值同样被收进各自的 .interp。
   */
  function readInterpolation(outerStart: { line: number; col: number }): Token[] {
    const collected: Token[] = []
    const emitIntoCollected = (
      at: { line: number; col: number },
      type: TokenType,
      lexeme: string,
      literal?: number | string,
      interp?: Token[]
    ): void => {
      collected.push({ type, lexeme, literal, interp, line: at.line, col: at.col })
    }
    let braceDepth = 0
    for (;;) {
      if (eof()) error(outerStart, '插值表达式缺少匹配的 }')
      const at = mark()
      const ch = peek()
      if (ch === '"') {
        advance()
        // 嵌套字符串里的 token（含它自己的插值标记）一律收进本插值的序列
        const mainLen = tokens.length
        readString()
        collected.push(...tokens.splice(mainLen))
        continue
      }
      if (ch === '{') {
        braceDepth++
        advance()
        emitIntoCollected(at, 'LEFT_BRACE', '{')
        continue
      }
      if (ch === '}') {
        advance()
        if (braceDepth === 0) {
          collected.push({ type: 'EOF', lexeme: '', line: at.line, col: at.col })
          return collected
        }
        braceDepth--
        emitIntoCollected(at, 'RIGHT_BRACE', '}')
        continue
      }
      const before = tokens.length
      scanAtom()
      collected.push(...tokens.splice(before))
    }
  }

  /** 单个原子 token：数字、标识符、运算符、标点（不含字符串与插值边界） */
  function scanAtom(): void {
    const at = mark()
    const ch = advance()
    switch (ch) {
      case ' ':
      case '\r':
      case '\t':
      case '\n':
        return
      case '(':
        emit(at, 'LEFT_PAREN', ch)
        return
      case ')':
        emit(at, 'RIGHT_PAREN', ch)
        return
      case '{':
        emit(at, 'LEFT_BRACE', ch)
        return
      case '}':
        emit(at, 'RIGHT_BRACE', ch)
        return
      case '[':
        emit(at, 'LEFT_BRACKET', ch)
        return
      case ']':
        emit(at, 'RIGHT_BRACKET', ch)
        return
      case ',':
        emit(at, 'COMMA', ch)
        return
      case ';':
        emit(at, 'SEMICOLON', ch)
        return
      case ':':
        emit(at, 'COLON', ch)
        return
      case '?':
        emit(at, 'QUESTION', ch)
        return
      case '.':
        if (isDigit(peek())) error(at, `数字不能以点开头，请写成 0${peek()}`)
        emit(at, 'DOT', ch)
        return
      case '+': {
        const eq = match('=')
        emit(at, eq ? 'PLUS_ASSIGN' : 'PLUS', eq ? '+=' : '+')
        return
      }
      case '-': {
        const eq = match('=')
        emit(at, eq ? 'MINUS_ASSIGN' : 'MINUS', eq ? '-=' : '-')
        return
      }
      case '*': {
        const eq = match('=')
        emit(at, eq ? 'STAR_ASSIGN' : 'STAR', eq ? '*=' : '*')
        return
      }
      case '/':
        if (match('/')) {
          while (!eof() && peek() !== '\n') advance()
          return
        }
        if (match('*')) {
          readBlockComment(at)
          return
        }
        {
          const eq = match('=')
          emit(at, eq ? 'SLASH_ASSIGN' : 'SLASH', eq ? '/=' : '/')
        }
        return
      case '%': {
        const eq = match('=')
        emit(at, eq ? 'PERCENT_ASSIGN' : 'PERCENT', eq ? '%=' : '%')
        return
      }
      case '=': {
        const eq = match('=')
        emit(at, eq ? 'EQUAL' : 'ASSIGN', eq ? '==' : '=')
        return
      }
      case '!': {
        const eq = match('=')
        emit(at, eq ? 'BANG_EQUAL' : 'BANG', eq ? '!=' : '!')
        return
      }
      case '<': {
        const eq = match('=')
        emit(at, eq ? 'LESS_EQUAL' : 'LESS', eq ? '<=' : '<')
        return
      }
      case '>': {
        const eq = match('=')
        emit(at, eq ? 'GREATER_EQUAL' : 'GREATER', eq ? '>=' : '>')
        return
      }
      default:
        if (isDigit(ch)) {
          scanNumber(ch, at)
          return
        }
        if (isAlpha(ch)) {
          scanIdentifier(ch, at)
          return
        }
        error(at, `意外字符 '${ch}'`)
    }
  }

  /** 块注释，支持嵌套 */
  function readBlockComment(at: { line: number; col: number }): void {
    let depth = 1
    while (depth > 0) {
      if (eof()) error(at, '块注释缺少收尾的 */')
      if (peek() === '*' && peekNext() === '/') {
        advance()
        advance()
        depth--
        continue
      }
      if (peek() === '/' && peekNext() === '*') {
        advance()
        advance()
        depth++
        continue
      }
      advance()
    }
  }

  while (!eof()) {
    if (peek() === '"') {
      advance()
      readString()
      continue
    }
    scanAtom()
  }

  tokens.push({ type: 'EOF', lexeme: '', line, col })
  return tokens
}
