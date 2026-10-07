/**
 * AST 节点定义。表达式与语句用 type 字段做可辨识联合。
 * 节点携带行/列信息，运行时错误可以精确定位。
 */

// ---------- 表达式 ----------

export interface LiteralExpr {
  type: 'literal'
  value: number | string | boolean | null
  line: number
  col: number
}

export interface IdentifierExpr {
  type: 'identifier'
  name: string
  line: number
  col: number
}

export interface TemplateExpr {
  type: 'template'
  /** 字面量片段：parts.length === exprs.length + 1 */
  parts: string[]
  exprs: Expr[]
  line: number
  col: number
}

export interface ArrayExpr {
  type: 'array'
  elements: Expr[]
  line: number
  col: number
}

export interface MapEntry {
  key: Expr
  value: Expr
}

export interface MapExpr {
  type: 'map'
  entries: MapEntry[]
  line: number
  col: number
}

export interface UnaryExpr {
  type: 'unary'
  op: '!' | '-'
  operand: Expr
  line: number
  col: number
}

export interface BinaryExpr {
  type: 'binary'
  op: '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '>' | '<=' | '>=' | 'and' | 'or'
  left: Expr
  right: Expr
  line: number
  col: number
}

export interface ConditionalExpr {
  type: 'conditional'
  test: Expr
  consequent: Expr
  alternate: Expr
  line: number
  col: number
}

export type CallArgs = Expr[]

export interface CallExpr {
  type: 'call'
  callee: Expr
  args: CallArgs
  line: number
  col: number
}

export interface IndexExpr {
  type: 'index'
  target: Expr
  index: Expr
  line: number
  col: number
}

export interface MemberExpr {
  type: 'member'
  target: Expr
  /** map 点号取值：a.b 等价于 a["b"] */
  key: string
  line: number
  col: number
}

export type FnExpr = {
  type: 'fn'
  name?: string
  params: string[]
  body: Stmt[]
  line: number
  col: number
}

export type Expr =
  | LiteralExpr
  | IdentifierExpr
  | TemplateExpr
  | ArrayExpr
  | MapExpr
  | UnaryExpr
  | BinaryExpr
  | ConditionalExpr
  | CallExpr
  | IndexExpr
  | MemberExpr
  | FnExpr
  | AssignExpr

/** 赋值目标：标识符、下标（a[i]）、点号（m.k） */
export type AssignTarget =
  | { kind: 'identifier'; name: string; line: number; col: number }
  | { kind: 'index'; target: Expr; index: Expr; line: number; col: number }
  | { kind: 'member'; target: Expr; key: string; line: number; col: number }

export interface AssignExpr {
  type: 'assign'
  target: AssignTarget
  op: '=' | '+=' | '-=' | '*=' | '/=' | '%='
  value: Expr
  line: number
  col: number
}

// ---------- 语句 ----------

export interface ExprStmt {
  type: 'exprStmt'
  expr: Expr
  line: number
  col: number
}

export interface VarStmt {
  type: 'var'
  name: string
  initializer?: Expr
  line: number
  col: number
}

export interface BlockStmt {
  type: 'block'
  body: Stmt[]
  line: number
  col: number
}

export interface IfStmt {
  type: 'if'
  test: Expr
  then: Stmt
  else?: Stmt
  line: number
  col: number
}

export interface WhileStmt {
  type: 'while'
  test: Expr
  body: Stmt
  line: number
  col: number
}

export interface ForStmt {
  type: 'for'
  init?: Stmt
  test?: Expr
  update?: Expr
  body: Stmt
  line: number
  col: number
}

export interface ReturnStmt {
  type: 'return'
  value?: Expr
  line: number
  col: number
}

export interface BreakStmt {
  type: 'break'
  line: number
  col: number
}

export interface ContinueStmt {
  type: 'continue'
  line: number
  col: number
}

/** fn 声明：把具名函数绑定到当前作用域 */
export interface FnDeclStmt {
  type: 'fnDecl'
  fn: FnExpr
  line: number
  col: number
}

export type Stmt =
  | ExprStmt
  | VarStmt
  | BlockStmt
  | IfStmt
  | WhileStmt
  | ForStmt
  | ReturnStmt
  | BreakStmt
  | ContinueStmt
  | FnDeclStmt

export type Program = Stmt[]
