/** Token 类型：字符串字面量联合，方便 switch 收窄 */
export type TokenType =
  // 字面量
  | 'NUMBER'
  | 'STRING'
  // 模板字符串：${expr} 插值的三段式标记
  | 'TEMPLATE_START'
  | 'TEMPLATE_MIDDLE'
  | 'TEMPLATE_END'
  // 标识符与关键字
  | 'IDENTIFIER'
  | 'VAR'
  | 'FN'
  | 'IF'
  | 'ELSE'
  | 'WHILE'
  | 'FOR'
  | 'RETURN'
  | 'TRUE'
  | 'FALSE'
  | 'NIL'
  | 'AND'
  | 'OR'
  | 'BREAK'
  | 'CONTINUE'
  // 单字符标点
  | 'LEFT_PAREN'
  | 'RIGHT_PAREN'
  | 'LEFT_BRACE'
  | 'RIGHT_BRACE'
  | 'LEFT_BRACKET'
  | 'RIGHT_BRACKET'
  | 'COMMA'
  | 'SEMICOLON'
  | 'COLON'
  | 'DOT'
  | 'QUESTION'
  // 运算符
  | 'ASSIGN'
  | 'PLUS_ASSIGN'
  | 'MINUS_ASSIGN'
  | 'STAR_ASSIGN'
  | 'SLASH_ASSIGN'
  | 'PERCENT_ASSIGN'
  | 'EQUAL'
  | 'BANG_EQUAL'
  | 'LESS'
  | 'GREATER'
  | 'LESS_EQUAL'
  | 'GREATER_EQUAL'
  | 'PLUS'
  | 'MINUS'
  | 'STAR'
  | 'SLASH'
  | 'PERCENT'
  | 'BANG'
  // 终点
  | 'EOF'

export interface Token {
  type: TokenType
  /** 原文（错误提示用） */
  lexeme: string
  /** NUMBER 的数值 / STRING·TEMPLATE_* 的处理后文本 */
  literal?: number | string
  /**
   * 仅 TEMPLATE_START / TEMPLATE_MIDDLE：插值表达式的 token 序列（含 EOF）。
   * 嵌套插值的内部模板会在这里递归出现，主流 token 里不再夹表达式 token，
   * 解析器因此无需处理嵌套歧义。
   */
  interp?: Token[]
  line: number
  col: number
}

export function tokenToString(t: Token): string {
  return `'${t.lexeme}'`
}
