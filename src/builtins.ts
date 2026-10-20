/**
 * 内建函数库：树遍历解释器与字节码 VM 共用同一份实现。
 * 内建函数内部抛出的 RuntimeError 不带行列信息（0,0），由调用点归位。
 */
import { RuntimeError } from './values'
import { ChaMap, formatValue, inspectValue, typeName, type NativeFunction, type Value } from './values'

/** 宿主提供的行读取：返回不含换行的一行，输入结束（EOF）返回 null */
export type ReadLine = (prompt: string | null) => string | null

export function createBuiltins(
  output: (text: string) => void,
  clock: () => number,
  readLine: ReadLine | null = null
): NativeFunction[] {
  const native = (
    name: string,
    arity: number | 'variadic',
    fn: (args: Value[]) => Value
  ): NativeFunction => ({ type: 'native', name, arity, fn })

  return [
    native('print', 'variadic', (args) => {
      output(args.map((a) => formatValue(a!)).join(' '))
      return null
    }),
    native('clock', 0, () => clock()),
    native('len', 1, (args) => {
      const v = args[0]!
      if (typeof v === 'string' || Array.isArray(v)) return v.length
      if (v instanceof ChaMap) return v.map.size
      throw new RuntimeError(`len() 只能用于字符串、数组、map，得到 ${typeName(v)}`)
    }),
    native('type', 1, (args) => typeName(args[0]!)),
    native('str', 1, (args) => inspectValue(args[0]!)),
    native('num', 1, (args) => {
      const v = args[0]!
      if (typeof v === 'number') return v
      if (typeof v === 'string') {
        const n = Number(v.trim())
        return v.trim() !== '' && !Number.isNaN(n) ? n : null
      }
      throw new RuntimeError(`num() 只能用于数字或字符串，得到 ${typeName(v)}`)
    }),
    native('floor', 1, (args) => {
      const v = args[0]!
      if (typeof v !== 'number') throw new RuntimeError(`floor() 只能用于数字，得到 ${typeName(v)}`)
      return Math.floor(v)
    }),
    native('abs', 1, (args) => {
      const v = args[0]!
      if (typeof v !== 'number') throw new RuntimeError(`abs() 只能用于数字，得到 ${typeName(v)}`)
      return Math.abs(v)
    }),
    native('push', 2, (args) => {
      const arr = args[0]!
      const v = args[1]!
      if (!Array.isArray(arr)) throw new RuntimeError(`push() 第一个参数应是数组，得到 ${typeName(arr)}`)
      arr.push(v)
      return arr
    }),
    native('pop', 1, (args) => {
      const arr = args[0]!
      if (!Array.isArray(arr)) throw new RuntimeError(`pop() 只能用于数组，得到 ${typeName(arr)}`)
      return arr.length > 0 ? (arr.pop() as Value) : null
    }),
    native('keys', 1, (args) => {
      const m = args[0]!
      if (!(m instanceof ChaMap)) throw new RuntimeError(`keys() 只能用于 map，得到 ${typeName(m)}`)
      return [...m.map.keys()]
    }),
    native('values', 1, (args) => {
      const m = args[0]!
      if (!(m instanceof ChaMap)) throw new RuntimeError(`values() 只能用于 map，得到 ${typeName(m)}`)
      return [...m.map.values()]
    }),
    native('has', 2, (args) => {
      const m = args[0]!
      const k = args[1]!
      if (!(m instanceof ChaMap)) throw new RuntimeError(`has() 第一个参数应是 map，得到 ${typeName(m)}`)
      return m.map.has(k)
    }),
    native('range', 'variadic', (args) => {
      let start = 0
      let stop: number
      let step = 1
      if (args.length === 1) {
        if (typeof args[0] !== 'number') throw new RuntimeError('range() 参数必须是数字')
        stop = args[0]
      } else if (args.length === 2 || args.length === 3) {
        if (args.some((a) => typeof a !== 'number')) throw new RuntimeError('range() 参数必须是数字')
        start = args[0] as number
        stop = args[1] as number
        if (args.length === 3) step = args[2] as number
      } else {
        throw new RuntimeError('range() 需要 1~3 个参数')
      }
      if (step === 0) throw new RuntimeError('range() 的步长不能为 0')
      const out: Value[] = []
      if (step > 0) for (let i = start; i < stop; i += step) out.push(i)
      else for (let i = start; i > stop; i += step) out.push(i)
      return out
    }),
    native('input', 'variadic', (args) => {
      if (args.length > 1) {
        throw new RuntimeError(`input() 只能接受 0 或 1 个参数（提示语），收到 ${args.length} 个`)
      }
      if (!readLine) throw new RuntimeError('input() 在当前环境不可用：宿主没有提供标准输入')
      return readLine(args.length === 1 ? formatValue(args[0]!) : null)
    }),
  ]
}
