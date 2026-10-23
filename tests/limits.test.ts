import { describe, expect, it } from 'vitest'
import { run, runVM, Session, VMSession, type RunOptions } from '../src/index'

/** 差分断言：两个后端连同预算报错必须逐字一致 */
const diff = (src: string, options: RunOptions = {}) => {
  const tree = run(src, options)
  const vm = runVM(src, options)
  expect({ out: vm.output, err: vm.error }).toEqual({ out: tree.output, err: tree.error })
  return vm
}

const OUTPUT_MESSAGE = (limit: number) => `输出太多行了（超过 ${limit} 行），已停止运行`
const RANGE_MESSAGE = (limit: number) => `range() 一次生成太多元素（超过 ${limit} 个），已停止分配`

describe('输出预算：maxOutputLines', () => {
  it('不设上限时不计数', () => {
    const r = diff('for (var i = 0; i < 3000; i = i + 1) print(i);')
    expect(r.output).toHaveLength(3000)
    expect(r.output[2999]).toBe('2999')
    expect(r.error).toBeUndefined()
  })

  it('刚好到上限不报，多一次就报在触发的那次 print', () => {
    const ok = diff('for (var i = 0; i < 5; i = i + 1) print(i);', { maxOutputLines: 5 })
    expect(ok.output).toEqual(['0', '1', '2', '3', '4'])
    expect(ok.error).toBeUndefined()

    const r = diff('print("a");\nprint("b");\nprint("c");', { maxOutputLines: 2 })
    expect(r.output).toEqual(['a', 'b'])
    expect(r.error).toEqual({
      name: 'RuntimeError',
      message: OUTPUT_MESSAGE(2),
      line: 3,
      col: 10,
      phase: 'runtime',
    })
  })

  it('上限为 0 时第一次 print 就停', () => {
    const r = diff('print(1);', { maxOutputLines: 0 })
    expect(r.output).toEqual([])
    expect(r.error?.message).toBe(OUTPUT_MESSAGE(0))
  })

  it('自定义 sink 同样受预算约束', () => {
    const seen: string[] = []
    const r = run('print(1); print(2); print(3);', {
      output: (text) => seen.push(text),
      maxOutputLines: 2,
    })
    expect(seen).toEqual(['1', '2'])
    expect(r.output).toEqual([])
    expect(r.error?.message).toBe(OUTPUT_MESSAGE(2))
  })

  it('catch 之后预算不重新充能', () => {
    const src = [
      'try {',
      '  print("a");',
      '  print("b");',
      '  print("c");',
      '} catch (e) {',
      '  print("接住");',
      '}',
    ].join('\n')
    const r = diff(src, { maxOutputLines: 2 })
    expect(r.output).toEqual(['a', 'b'])
    expect(r.error?.message).toBe(OUTPUT_MESSAGE(2))
    // 第二次撞在同一轮输出闸门上，报错点是 catch 体里的那条 print
    expect({ line: r.error?.line, col: r.error?.col }).toEqual({ line: 6, col: 13 })
  })
})

describe('输出预算：会话每次 run 重新计数', () => {
  it('Session 跨段的输出计数归零', () => {
    const lines: string[] = []
    const session = new Session({ output: (text) => lines.push(text), maxOutputLines: 2 })
    expect(session.run('print(1); print(2);').error).toBeUndefined()
    expect(session.run('print(3); print(4);').error).toBeUndefined()
    const bad = session.run('print(5); print(6); print(7);')
    expect(bad.error?.message).toBe(OUTPUT_MESSAGE(2))
    expect(lines).toEqual(['1', '2', '3', '4', '5', '6'])
    // 出错的那一段用完预算，不影响下一段
    expect(session.run('print(8);').error).toBeUndefined()
    expect(lines).toEqual(['1', '2', '3', '4', '5', '6', '8'])
  })

  it('VMSession 每次 run 返回本段输出，计数同样归零', () => {
    const session = new VMSession({ maxOutputLines: 2 })
    expect(session.run('print(1); print(2);')).toEqual({ output: ['1', '2'] })
    expect(session.run('print(3); print(4);')).toEqual({ output: ['3', '4'] })
    const bad = session.run('print(5); print(6); print(7);')
    expect(bad.output).toEqual(['5', '6'])
    expect(bad.error?.message).toBe(OUTPUT_MESSAGE(2))
    expect(session.run('print(8);')).toEqual({ output: ['8'] })
  })
})

describe('range 分配预算：maxRangeLength', () => {
  it('边界之内保持原行为', () => {
    const r = diff('print(range(0, 3)); print(range(3, 0, -1)); print(range(5, 5));', {
      maxRangeLength: 3,
    })
    expect(r.output).toEqual(['[0, 1, 2]', '[3, 2, 1]', '[]'])
    expect(r.error).toBeUndefined()
  })

  it('超限在 range() 调用点报错', () => {
    const r = diff('print("前");\nprint(range(0, 4));', { maxRangeLength: 3 })
    expect(r.output).toEqual(['前'])
    expect(r.error).toEqual({
      name: 'RuntimeError',
      message: RANGE_MESSAGE(3),
      line: 2,
      col: 17,
      phase: 'runtime',
    })
  })

  it('负步长按跨度算，不按终点算', () => {
    const ok = diff('print(range(3, 0, -1));', { maxRangeLength: 3 })
    expect(ok.error).toBeUndefined()
    const bad = diff('print(range(4, 0, -1));', { maxRangeLength: 3 })
    expect(bad.error?.message).toBe(RANGE_MESSAGE(3))
  })

  it('Infinity 与超大跨度在分配前就被拦住', () => {
    // 语言没有 Infinity 字面量，num("Infinity") 是唯一入口
    const inf = diff('print(range(0, num("Infinity")));', { maxRangeLength: 1000 })
    expect(inf.output).toEqual([])
    expect(inf.error?.message).toBe(RANGE_MESSAGE(1000))

    const huge = diff('print(range(0, num("1e300")));', { maxRangeLength: 1000 })
    expect(huge.error?.message).toBe(RANGE_MESSAGE(1000))
  })

  it('浮点步长多走一步时由硬上限兜住', () => {
    // 0.1 累加不到 1，实际 11 个元素；估算 10 个放行后仍不能突破硬上限
    const r = diff('print(range(0, 1, 0.1));', { maxRangeLength: 10 })
    expect(r.output).toEqual([])
    expect(r.error?.message).toBe(RANGE_MESSAGE(10))
  })

  it('接住之后可以继续用更小的 range', () => {
    const r = diff('try { range(0, 100); } catch (e) { print(e); }\nprint(len(range(0, 2)));', {
      maxRangeLength: 3,
    })
    expect(r.output).toEqual([RANGE_MESSAGE(3), '2'])
    expect(r.error).toBeUndefined()
  })

  it('默认上限足够跑常规数据量', () => {
    const r = diff('print(len(range(0, 100000)));')
    expect(r.output).toEqual(['100000'])
    expect(r.error).toBeUndefined()
  })

  it('会话把 maxRangeLength 传到底', () => {
    const session = new Session({ maxRangeLength: 3 })
    expect(session.run('print(range(0, 4));').error?.message).toBe(RANGE_MESSAGE(3))
    expect(session.run('print(len(range(0, 3)));').error).toBeUndefined()

    const vmSession = new VMSession({ maxRangeLength: 3 })
    expect(vmSession.run('print(range(0, 4));').error?.message).toBe(RANGE_MESSAGE(3))
    expect(vmSession.run('print(len(range(0, 3)));').error).toBeUndefined()
  })
})
