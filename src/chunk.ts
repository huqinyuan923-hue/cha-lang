/**
 * 字节码层：指令集、代码块（Chunk）与反汇编器。
 *
 * 栈式指令集，操作数一律小端 u16（跳转偏移、常量池下标、槽位号）。
 * 每条指令都记录行/列，VM 的运行时错误可以精确到出错表达式，
 * 与树遍历解释器的错误位置完全对齐。
 */
import type { Value } from './values'

export enum Op {
  /** u16 常量下标，压入常量 */
  CONST,
  NIL,
  TRUE,
  FALSE,
  POP,
  /** 交换栈顶两个值 */
  SWAP,

  /** u16 槽位：读/写当前帧的局部变量（SET_* 写入后值留在栈顶） */
  GET_LOCAL,
  SET_LOCAL,
  /** u16 常量（变量名）：全局变量的读 / 赋值 / 声明 */
  GET_GLOBAL,
  SET_GLOBAL,
  DEFINE_GLOBAL,
  /** u8 upvalue 下标：读/写外层函数捕获的变量 */
  GET_UPVALUE,
  SET_UPVALUE,

  /** [target, index] → 值 / [target, index, value] → value（写后留值） */
  GET_INDEX,
  SET_INDEX,

  /** u16 元素个数：弹出 N 个值（栈底→栈顶顺序），压入数组 */
  ARRAY,
  /** u16 键值对数：弹出 2N 个值（key,value 依次入栈），压入 map */
  MAP,
  /** u8 n：复制栈顶往下第 n 个值（n=1 等价 DUP） */
  PICK,

  NEG,
  NOT,
  ADD,
  SUB,
  MUL,
  DIV,
  MOD,
  EQ,
  NEQ,
  LT,
  GT,
  LTE,
  GTE,

  /** u16 前向偏移 */
  JUMP,
  /** u16：弹出条件，假则跳转 */
  JUMP_IF_FALSE,
  /** u16：窥视条件（不弹），假则跳转——and 短路时左值就是结果 */
  JUMP_IF_FALSE_PEEK,
  /** u16：窥视条件（不弹），真则跳转——or 短路时左值就是结果 */
  JUMP_IF_TRUE_PEEK,
  /** u16 后向偏移：循环回跳 */
  LOOP,

  /** u16 前向偏移：登记 catch 入口与当前栈深，压入一个处理器 */
  TRY,
  /** try 体正常走完：弹掉最内层处理器，之后的错误不该再落进这个 catch */
  END_TRY,
  /** 弹出栈顶值作为抛出内容，向外找处理器（本帧 → 调用者帧 → ……） */
  THROW,

  /** u8 参数个数：栈顶布局 [callee, arg1..argN] */
  CALL,
  /** u16 常量（函数原型）+ upvalue 描述对 (isLocal u8, index u8) × n */
  CLOSURE,
  /** u16 槽位下界：关闭所有指向 ≥ 该槽位的开放 upvalue（块退出/break/continue） */
  CLOSE_UPVALUES,
  RETURN,

  /** u16 常量（类名）：创建新类压栈 */
  CLASS,
  /** u16 常量（方法名）：[class, closure] → [class]，方法装进类 */
  METHOD,
  /** [superclass, class] → [superclass]：校验父类并把 class 挂上去（父类值留给 super 用） */
  INHERIT,
  /** u16 常量（方法名）：[receiver, superclass] → boundMethod */
  GET_SUPER_METHOD,

  /** u16 常量（TemplateInfo）：弹出 count 个值，插值组装成字符串 */
  TEMPLATE,
}

/** 模板插值的编译期描述：parts.length === count + 1 */
export interface TemplateInfo {
  parts: string[]
  count: number
}

export interface VMFunction {
  type: 'vmFunction'
  name?: string
  arity: number
  /** 参数名（运行时错误信息与闭包值展示用） */
  paramNames: string[]
  chunk: Chunk
  upvalueCount: number
}

/**
 * upvalue：打开时指向栈槽，关闭后把值搬到堆上。
 * 由 VM 创建与关闭，这里只是数据形状。
 */
export interface Upvalue {
  /** null = 已关闭，值在 closed 里 */
  slot: number | null
  closed?: Value
}

export class Chunk {
  code: number[] = []
  /** 与 code 平行的行/列号：VM 报错与反汇编共用 */
  lines: number[] = []
  cols: number[] = []
  /** 常量池：数字/字符串/布尔/nil 会去重；VMFunction / TemplateInfo 按对象入池 */
  constants: (Value | VMFunction | TemplateInfo)[] = []

  private constantIndex = new Map<string, number>()

  write(byte: number, line: number, col: number): void {
    if (!(byte >= 0 && byte <= 0xff)) throw new Error(`编译错误：字节 ${byte} 超出 0..255（行 ${line} 列 ${col}）`)
    this.code.push(byte)
    this.lines.push(line)
    this.cols.push(col)
  }

  /** 写入小端 u16 操作数 */
  writeU16(value: number, line: number, col: number): void {
    if (!(value >= 0 && value <= 0xffff)) throw new Error(`编译错误：操作数 ${value} 超出 u16（行 ${line} 列 ${col}）`)
    this.write(value & 0xff, line, col)
    this.write((value >>> 8) & 0xff, line, col)
  }

  /** 修改已写入的 u16（跳转回填用），offset 为指令起始地址 */
  patchU16(at: number, value: number): void {
    if (!(value >= 0 && value <= 0xffff)) throw new Error(`编译错误：回填值 ${value} 超出 u16（地址 ${at}）`)
    if (at + 2 >= this.code.length) throw new Error(`编译错误：回填地址 ${at} 越界`)
    this.code[at + 1] = value & 0xff
    this.code[at + 2] = (value >>> 8) & 0xff
  }

  addConstant(v: Value | VMFunction | TemplateInfo): number {
    if (v !== null && typeof v === 'object') {
      // 函数原型与模板描述按对象身份入池；数组/map 是运行时产物，不会走到这里
      this.constants.push(v as VMFunction | TemplateInfo)
      return this.constants.length - 1
    }
    const key = `${typeof v}:${String(v)}`
    const hit = this.constantIndex.get(key)
    if (hit !== undefined) return hit
    this.constants.push(v)
    this.constantIndex.set(key, this.constants.length - 1)
    return this.constants.length - 1
  }
}

const OP_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(Op)
    .filter(([, v]) => typeof v === 'number')
    .map(([k, v]) => [v, k])
)

/** u16 操作数的指令 → 反汇编时展示的常量/槽位宽度 */
const U16_OPS = new Set([
  Op.CONST,
  Op.GET_LOCAL,
  Op.SET_LOCAL,
  Op.GET_GLOBAL,
  Op.SET_GLOBAL,
  Op.DEFINE_GLOBAL,
  Op.TEMPLATE,
  Op.ARRAY,
  Op.MAP,
  Op.JUMP,
  Op.JUMP_IF_FALSE,
  Op.JUMP_IF_FALSE_PEEK,
  Op.JUMP_IF_TRUE_PEEK,
  Op.LOOP,
  Op.TRY,
  Op.CLOSE_UPVALUES,
  Op.CLASS,
  Op.METHOD,
  Op.GET_SUPER_METHOD,
])

export type DisasmRow =
  | { kind: 'fn'; fn: string; text: string }
  | {
      kind: 'op'
      fn: string
      text: string
      addr: number
      op: string
      operand: string
      line: number
      col: number
    }

/**
 * 结构化反汇编：文本与 disassemble 完全一致，额外带上每行所属函数与地址，
 * 便于调用方做轨迹联动。CLOSURE 的内嵌函数体会紧跟在该指令之后展开。
 */
export function disassembleRows(fn: VMFunction, label = 'script'): DisasmRow[] {
  const rows: DisasmRow[] = []
  emitDisasmRows(fn, label, rows)
  return rows
}

/** 反汇编一个函数的字节码。行号/列号一并展示，跳转指令标出目标地址。 */
export function disassemble(fn: VMFunction, label = 'script'): string {
  return disassembleRows(fn, label)
    .map((row) => row.text)
    .join('\n')
}

function emitDisasmRows(fn: VMFunction, label: string, rows: DisasmRow[]): void {
  const chunk = fn.chunk
  const fnName = fn.name ?? label
  rows.push({
    kind: 'fn',
    fn: fnName,
    text: `== ${fnName} (arity ${fn.arity}, upvalues ${fn.upvalueCount}) ==`,
  })

  let ip = 0
  const pad = (n: number | string, w: number): string => String(n).padStart(w, ' ')
  while (ip < chunk.code.length) {
    const addr = ip
    const op = chunk.code[ip++] as Op
    const line = chunk.lines[addr]!
    const col = chunk.cols[addr]!
    const head = `${pad(addr, 4)}  ${pad(OP_NAMES[op] ?? `op${op}`, 20)}`
    const note = (text: string): void => {
      rows.push({
        kind: 'op',
        fn: fnName,
        text: text === '' ? `${head}   ; ${line}:${col}` : `${head} ${text}  ; ${line}:${col}`,
        addr,
        op: OP_NAMES[op] ?? `op${op}`,
        operand: text,
        line,
        col,
      })
    }

    if (U16_OPS.has(op)) {
      const operand = chunk.code[ip]! | (chunk.code[ip + 1]! << 8)
      ip += 2
      switch (op) {
        case Op.CONST:
        case Op.GET_GLOBAL:
        case Op.SET_GLOBAL:
        case Op.DEFINE_GLOBAL:
        case Op.TEMPLATE:
        case Op.CLASS:
        case Op.METHOD:
        case Op.GET_SUPER_METHOD: {
          const c = chunk.constants[operand]
          const shown =
            typeof c === 'string'
              ? JSON.stringify(c)
              : c !== null && typeof c === 'object' && 'type' in c
                ? `<fn ${(c as VMFunction).name ?? '匿名'}>`
                : String(c)
          note(`${pad(operand, 5)}  ${shown}`)
          break
        }
        case Op.GET_LOCAL:
        case Op.SET_LOCAL:
        case Op.CLOSE_UPVALUES:
          note(String(operand))
          break
        case Op.JUMP:
        case Op.JUMP_IF_FALSE:
        case Op.JUMP_IF_FALSE_PEEK:
        case Op.JUMP_IF_TRUE_PEEK:
        case Op.TRY:
          note(`-> ${pad(addr + 3 + operand, 4)}`)
          break
        case Op.LOOP:
          note(`-> ${pad(addr + 3 - operand, 4)}`)
          break
      }
      continue
    }

    if (op === Op.CLOSURE) {
      const fnIdx = chunk.code[ip]! | (chunk.code[ip + 1]! << 8)
      ip += 2
      const proto = chunk.constants[fnIdx] as VMFunction
      const upvalues: string[] = []
      for (let i = 0; i < proto.upvalueCount; i++) {
        const isLocal = chunk.code[ip++]!
        const index = chunk.code[ip++]!
        upvalues.push(`${isLocal ? 'local' : 'upval'} ${index}`)
      }
      note(`${pad(fnIdx, 5)}  upvalues: [${upvalues.join(', ')}]`)
      emitDisasmRows(proto, proto.name ?? '匿名函数', rows)
      continue
    }

    if (op === Op.CALL || op === Op.PICK || op === Op.GET_UPVALUE || op === Op.SET_UPVALUE) {
      note(String(chunk.code[ip++]!))
      continue
    }

    note('')
  }
}
