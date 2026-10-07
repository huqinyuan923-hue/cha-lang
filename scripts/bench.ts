/**
 * 双后端性能基准：树遍历解释器 vs 字节码 VM。
 * 用法：npx tsx scripts/bench.ts [迭代倍率]
 * 每个用例预热一次后计时取中位数，输出相对加速比。
 */
import { run } from '../src/index'
import { runVM } from '../src/index'

/** 负载倍率：改这里（不做命令行参数，避免把外部输入喂进解释器） */
const scale = 1

const CASES: { name: string; src: (s: number) => string }[] = [
  {
    name: '递归 fib(22)',
    src: (s) => `
      fn fib(n) { if (n < 2) return n; return fib(n - 1) + fib(n - 2); }
      var total = 0;
      for (var i = 0; i < ${Math.round(2 * scale)}; i += 1) { total += fib(22); }
      print(total);
    `,
  },
  {
    name: '循环累加 20 万次',
    src: (s) => `
      var sum = 0;
      for (var i = 0; i < ${Math.round(100000 * scale)}; i += 1) {
        sum += i % 7 * 3 - 1;
      }
      print(sum);
    `,
  },
  {
    name: '闭包计数器 ×5 万',
    src: (s) => `
      fn makeCounter() { var n = 0; fn inc() { n += 1; return n; } return inc; }
      var c = makeCounter();
      var last = 0;
      for (var i = 0; i < ${Math.round(50000 * scale)}; i += 1) { last = c(); }
      print(last);
    `,
  },
  {
    name: '数组与 map 混合操作 ×2 万',
    src: (s) => `
      var arr = [];
      var m = {};
      for (var i = 0; i < ${Math.round(20000 * scale)}; i += 1) {
        push(arr, i % 100);
        m["k\${i % 16}"] = i;
        if (len(arr) > 64) { pop(arr); }
      }
      print(len(arr), m["k3"]);
    `,
  },
]

function benchOnce(fn: () => void): number {
  const t0 = performance.now()
  fn()
  return performance.now() - t0
}

console.log(`基准（倍率 ×${scale}）——各跑 5 轮取中位数\n`)
console.log('用例'.padEnd(24), '树遍历'.padStart(12), '字节码 VM'.padStart(12), '加速比'.padStart(8))

for (const c of CASES) {
  const src = c.src(scale)
  const treeRes = run(src)
  const vmRes = runVM(src)
  if (JSON.stringify(treeRes) !== JSON.stringify(vmRes)) {
    console.log(`${c.name.padEnd(24)}  ⚠ 输出不一致，跳过`)
    continue
  }

  // 预热
  run(src)
  runVM(src)

  const treeTimes: number[] = []
  const vmTimes: number[] = []
  for (let i = 0; i < 5; i++) treeTimes.push(benchOnce(() => run(src)))
  for (let i = 0; i < 5; i++) vmTimes.push(benchOnce(() => runVM(src)))
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
  const t = median(treeTimes)
  const v = median(vmTimes)
  console.log(
    c.name.padEnd(24),
    `${t.toFixed(1)}ms`.padStart(12),
    `${v.toFixed(1)}ms`.padStart(12),
    `${(t / v).toFixed(2)}x`.padStart(8)
  )
}
