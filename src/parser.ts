import type {
  AssignTarget,
  BinaryExpr,
  Expr,
  FnExpr,
  MapEntry,
  Program,
  Stmt,
} from './ast'
import { scan } from './lexer'
import type { Token } from './token'

export class ParseError extends Error {
  constructor(
    message: string,
    public line: number,
    public col: number
  ) {
    super(`[line ${line}, col ${col}] ${message}`)
    this.name = 'ParseError'
  }
}

/**
 * 解析器：token 流 → AST（递归下降）。
 *
 * 表达式优先级从低到高：
 *   赋值 < 三元 < or < and < 相等 < 比较 < 加减 < 乘除模 < 一元 < 调用/下标 < 字面量
 */
export function parse(source: string): Program {
  const tokens = scan(source)
  let view: Token[] = tokens // 解析插值表达式时会临时切换到子 token 序列
  let current = 0

  const peek = (): Token => view[current]!
  const previous = (): Token => view[current - 1]!
  const atEnd = (): boolean => peek().type === 'EOF'
  const check = (type: string): boolean => peek().type === type
  const advance = (): Token => {
    if (!atEnd()) current++
    return previous()
  }
  const checkNext = (type: string): boolean =>
    tokens[current + 1] !== undefined && tokens[current + 1]!.type === type

  const error = (token: Token, message: string): never => {
    throw new ParseError(message, token.line, token.col)
  }

  /** 消费期望中的 token，否则报错 */
  function expect(type: string, message: string): Token {
    if (check(type)) return advance()
    return error(peek(), message)
  }

  // ---------- 语句 ----------

  function program(): Program {
    const body: Stmt[] = []
    while (!atEnd()) body.push(declaration())
    return body
  }

  function declaration(): Stmt {
    if (check('VAR')) return varDecl()
    if (check('FN') && checkNext('IDENTIFIER')) return fnDecl()
    return statement()
  }

  function varDecl(): Stmt {
    const kw = advance() // var
    const name = expect('IDENTIFIER', 'var 后面应该是变量名')
    let initializer: Expr | undefined
    if (match('ASSIGN')) initializer = expression()
    expect('SEMICOLON', "var 声明应以 ';' 结尾")
    return { type: 'var', name: name.lexeme, initializer, line: kw.line, col: kw.col }
  }

  function fnDecl(): Stmt {
    const kw = advance() // fn
    const name = expect('IDENTIFIER', 'fn 后面应该是函数名')
    const fn = fnBody(name.lexeme, kw)
    return { type: 'fnDecl', fn, line: kw.line, col: kw.col }
  }

  /** 解析函数的参数表与函数体（供 fn 声明与匿名 fn 表达式共用） */
  function fnBody(name: string | undefined, kw: Token): FnExpr {
    expect('LEFT_PAREN', `fn ${name ?? '(匿名)'} 后面应该是 '('`)
    const params: string[] = []
    if (!check('RIGHT_PAREN')) {
      do {
        if (params.length >= 255) error(peek(), '参数不能超过 255 个')
        params.push(expect('IDENTIFIER', '参数应是标识符').lexeme)
      } while (match('COMMA'))
    }
    expect('RIGHT_PAREN', "参数表应以 ')' 结尾")
    expect('LEFT_BRACE', `fn ${name ?? '(匿名)'} 的函数体应是 {`)
    const body = block()
    return { type: 'fn', name, params, body, line: kw.line, col: kw.col }
  }

  function statement(): Stmt {
    if (match('SEMICOLON')) {
      // 空语句：无害地吞掉多余的分号
      const at = previous()!
      return { type: 'block', body: [], line: at.line, col: at.col }
    }
    if (match('IF')) return ifStmt()
    if (match('WHILE')) return whileStmt()
    if (match('FOR')) return forStmt()
    if (match('RETURN')) return returnStmt()
    if (check('BREAK')) return breakContinue('break')
    if (check('CONTINUE')) return breakContinue('continue')
    if (match('LEFT_BRACE')) {
      const open = previous()!
      const body = block()
      return { type: 'block', body, line: open.line, col: open.col }
    }
    return expressionStmt()
  }

  function ifStmt(): Stmt {
    const kw = previous()!
    expect('LEFT_PAREN', "if 后面应该是 '('")
    const test = expression()
    expect('RIGHT_PAREN', "if 条件应以 ')' 结尾")
    const then = statement()
    let elseBranch: Stmt | undefined
    if (match('ELSE')) elseBranch = statement()
    return { type: 'if', test, then, else: elseBranch, line: kw.line, col: kw.col }
  }

  function whileStmt(): Stmt {
    const kw = previous()!
    expect('LEFT_PAREN', "while 后面应该是 '('")
    const test = expression()
    expect('RIGHT_PAREN', "while 条件应以 ')' 结尾")
    const body = statement()
    return { type: 'while', test, body, line: kw.line, col: kw.col }
  }

  /** for 是语法糖：解析后直接还原成 while 三件套 */
  function forStmt(): Stmt {
    const kw = previous()!
    expect('LEFT_PAREN', "for 后面应该是 '('")

    let init: Stmt | undefined
    if (match('SEMICOLON')) init = undefined
    else if (check('VAR')) init = varDecl()
    else init = expressionStmt()

    let test: Expr | undefined
    if (!check('SEMICOLON')) test = expression()
    expect('SEMICOLON', "for 循环条件应以 ';' 结尾")

    let update: Expr | undefined
    if (!check('RIGHT_PAREN')) update = expression()
    expect('RIGHT_PAREN', "for 头部应以 ')' 结尾")

    const body = statement()

    return { type: 'for', init, test, update, body, line: kw.line, col: kw.col }
  }

  function returnStmt(): Stmt {
    const kw = previous()!
    let value: Expr | undefined
    if (!check('SEMICOLON')) value = expression()
    expect('SEMICOLON', "return 语句应以 ';' 结尾")
    return { type: 'return', value, line: kw.line, col: kw.col }
  }

  function breakContinue(kind: 'break' | 'continue'): Stmt {
    const kw = advance()
    expect('SEMICOLON', `${kind} 语句应以 ';' 结尾`)
    return { type: kind, line: kw.line, col: kw.col }
  }

  function block(): Stmt[] {
    const open = previous()!
    const body: Stmt[] = []
    while (!check('RIGHT_BRACE') && !atEnd()) body.push(declaration())
    if (atEnd()) error(open, '代码块缺少收尾的 }')
    advance() // }
    return body
  }

  function expressionStmt(): Stmt {
    const expr = expression()
    expect('SEMICOLON', "表达式语句应以 ';' 结尾")
    return { type: 'exprStmt', expr, line: expr.line, col: expr.col }
  }

  // ---------- 表达式 ----------

  function expression(): Expr {
    return assignment()
  }

  function match(...types: string[]): Token | null {
    for (const t of types) {
      if (check(t)) return advance()
    }
    return null
  }

  const ASSIGN_OPS: Record<string, string> = {
    ASSIGN: '=',
    PLUS_ASSIGN: '+=',
    MINUS_ASSIGN: '-=',
    STAR_ASSIGN: '*=',
    SLASH_ASSIGN: '/=',
    PERCENT_ASSIGN: '%=',
  }

  function assignment(): Expr {
    // 先按普通表达式解析左值；若是赋值目标且后面是赋值运算符，改写成 Assign
    const expr = conditional()
    const opToken = match(...Object.keys(ASSIGN_OPS))
    if (opToken) {
      const value = assignment() // 右结合：a = b = c
      const target = toAssignTarget(expr, opToken)
      return {
        type: 'assign',
        target,
        op: ASSIGN_OPS[opToken.type] as '=',
        value,
        line: opToken.line,
        col: opToken.col,
      }
    }
    return expr
  }

  /** 校验赋值目标合法性：标识符、下标、点号成员 */
  function toAssignTarget(expr: Expr, opToken: Token): AssignTarget {
    switch (expr.type) {
      case 'identifier':
        return { kind: 'identifier', name: expr.name, line: expr.line, col: expr.col }
      case 'index':
        return {
          kind: 'index',
          target: expr.target,
          index: expr.index,
          line: expr.line,
          col: expr.col,
        }
      case 'member':
        return { kind: 'member', target: expr.target, key: expr.key, line: expr.line, col: expr.col }
      default:
        return error(opToken, '这里不能被赋值')
    }
  }

  function conditional(): Expr {
    const test = or()
    if (match('QUESTION')) {
      const consequent = assignment()
      expect('COLON', "三元运算符缺少 ':'")
      const alternate = assignment()
      return { type: 'conditional', test, consequent, alternate, line: test.line, col: test.col }
    }
    return test
  }

  function or(): Expr {
    let expr = and()
    while (match('OR')) {
      const op = previous()!
      const right = and()
      expr = { type: 'binary', op: 'or', left: expr, right, line: op.line, col: op.col }
    }
    return expr
  }

  function and(): Expr {
    let expr = equality()
    while (match('AND')) {
      const op = previous()!
      const right = equality()
      expr = { type: 'binary', op: 'and', left: expr, right, line: op.line, col: op.col }
    }
    return expr
  }

  function binaryChain(next: () => Expr, ops: Record<string, string>): Expr {
    let expr = next()
    for (;;) {
      const opToken = match(...Object.keys(ops))
      if (!opToken) return expr
      const right = next()
      expr = {
        type: 'binary',
        op: ops[opToken.type] as BinaryExpr['op'],
        left: expr,
        right,
        line: opToken.line,
        col: opToken.col,
      }
    }
  }

  const equalityOps = { EQUAL: '==', BANG_EQUAL: '!=' }
  const comparisonOps = { LESS: '<', GREATER: '>', LESS_EQUAL: '<=', GREATER_EQUAL: '>=' }
  const termOps = { PLUS: '+', MINUS: '-' }
  const factorOps = { STAR: '*', SLASH: '/', PERCENT: '%' }

  function equality(): Expr {
    return binaryChain(comparison, equalityOps)
  }
  function comparison(): Expr {
    return binaryChain(term, comparisonOps)
  }
  function term(): Expr {
    return binaryChain(factor, termOps)
  }
  function factor(): Expr {
    return binaryChain(unary, factorOps)
  }

  function unary(): Expr {
    const opToken = match('BANG', 'MINUS')
    if (opToken) {
      const operand = unary()
      const op = opToken.type === 'BANG' ? '!' : '-'
      return { type: 'unary', op, operand, line: opToken.line, col: opToken.col }
    }
    return call()
  }

  /** 调用/下标/点号取值的后缀链：f(1)[2].k */
  function call(): Expr {
    let expr = primary()
    for (;;) {
      if (match('LEFT_PAREN')) {
        const args: Expr[] = []
        if (!check('RIGHT_PAREN')) {
          do {
            if (args.length >= 255) error(peek(), '参数不能超过 255 个')
            args.push(expression())
          } while (match('COMMA'))
        }
        const close = expect('RIGHT_PAREN', "调用参数表应以 ')' 结尾")
        expr = { type: 'call', callee: expr, args, line: close.line, col: close.col }
      } else if (match('LEFT_BRACKET')) {
        const index = expression()
        const close = expect('RIGHT_BRACKET', "下标应以 ']' 结尾")
        expr = { type: 'index', target: expr, index, line: close.line, col: close.col }
      } else if (match('DOT')) {
        const key = expect('IDENTIFIER', "'.' 后面应该是属性名")
        expr = { type: 'member', target: expr, key: key.lexeme, line: key.line, col: key.col }
      } else {
        return expr
      }
    }
  }

  function primary(): Expr {
    const token = peek()
    switch (token.type) {
      case 'NUMBER': {
        advance()
        return { type: 'literal', value: token.literal as number, line: token.line, col: token.col }
      }
      case 'STRING': {
        advance()
        return { type: 'literal', value: token.literal as string, line: token.line, col: token.col }
      }
      case 'TRUE': {
        advance()
        return { type: 'literal', value: true, line: token.line, col: token.col }
      }
      case 'FALSE': {
        advance()
        return { type: 'literal', value: false, line: token.line, col: token.col }
      }
      case 'NIL': {
        advance()
        return { type: 'literal', value: null, line: token.line, col: token.col }
      }
      case 'IDENTIFIER': {
        advance()
        return { type: 'identifier', name: token.lexeme, line: token.line, col: token.col }
      }
      case 'LEFT_PAREN': {
        advance()
        const expr = expression()
        expect('RIGHT_PAREN', "缺少匹配的 ')'")
        return expr
      }
      case 'LEFT_BRACKET': {
        const open = advance()
        const elements: Expr[] = []
        if (!check('RIGHT_BRACKET')) {
          do {
            if (check('RIGHT_BRACKET')) break // 允许末尾逗号 [1, 2,]
            elements.push(expression())
          } while (match('COMMA'))
        }
        expect('RIGHT_BRACKET', "数组字面量应以 ']' 结尾")
        return { type: 'array', elements, line: open.line, col: open.col }
      }
      case 'LEFT_BRACE': {
        const open = advance()
        const entries: MapEntry[] = []
        if (!check('RIGHT_BRACE')) {
          do {
            if (check('RIGHT_BRACE')) break // 允许末尾逗号
            entries.push(mapEntry())
          } while (match('COMMA'))
        }
        expect('RIGHT_BRACE', "map 字面量应以 '}' 结尾")
        return { type: 'map', entries, line: open.line, col: open.col }
      }
      case 'TEMPLATE_START': {
        advance()
        return finishTemplate(token)
      }
      case 'FN': {
        // 匿名函数表达式：fn (x) { ... }（后面不跟标识符时）
        advance()
        return fnBody(undefined, token)
      }
      default:
        return error(token, `这里不能出现 '${token.lexeme || token.type}'`)
    }
  }

  /** map 字面量的一个键值对：键是字符串/数字/标识符（标识符按字符串处理） */
  function mapEntry(): MapEntry {
    const keyToken = peek()
    let key: Expr
    if (check('STRING')) {
      advance()
      key = { type: 'literal', value: keyToken.literal as string, line: keyToken.line, col: keyToken.col }
    } else if (check('NUMBER')) {
      advance()
      key = { type: 'literal', value: keyToken.literal as number, line: keyToken.line, col: keyToken.col }
    } else if (check('IDENTIFIER')) {
      advance()
      key = { type: 'literal', value: keyToken.lexeme, line: keyToken.line, col: keyToken.col }
    } else if (check('LEFT_BRACKET')) {
      // 计算键：{ [k]: v }
      advance()
      key = expression()
      expect('RIGHT_BRACKET', "计算键应以 ']' 结尾")
    } else {
      return error(keyToken, 'map 的键应是字符串、数字、标识符或 [表达式]')
    }
    expect('COLON', "map 键值对缺少 ':'")
    const value = expression()
    return { key, value }
  }

  /** 消费 MIDDLE/END 序列，组装 TemplateExpr */
  function finishTemplate(start: Token): Expr {
    const parts: string[] = [start.literal as string]
    const exprs: Expr[] = []
    const interpTokens = start.interp
    if (interpTokens) exprs.push(parseSubTokens(interpTokens))

    for (;;) {
      if (check('TEMPLATE_MIDDLE')) {
        const mid = advance()
        parts.push(mid.literal as string)
        if (mid.interp) exprs.push(parseSubTokens(mid.interp))
        continue
      }
      if (check('TEMPLATE_END')) {
        const end = advance()
        parts.push(end.literal as string)
        break
      }
      // 词法器保证不会发生，防御性报错
      return error(peek(), '模板字符串结构不完整')
    }
    return { type: 'template', parts, exprs, line: start.line, col: start.col }
  }

  /** 把插值 token 序列当完整源码解析成表达式（词法器已附上 EOF） */
  function parseSubTokens(subTokens: Token[]): Expr {
    const savedView = view
    const savedCurrent = current
    view = subTokens
    current = 0
    try {
      const expr = expression()
      if (!atEnd()) error(peek(), '插值表达式只能是一个表达式')
      return expr
    } finally {
      view = savedView
      current = savedCurrent
    }
  }

  return program()
}
