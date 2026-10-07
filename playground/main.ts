/**
 * Playground 入口：把语言前端 + 树遍历解释器 + 字节码 VM 打进一个 bundle。
 * src/index 不依赖 Node API，这里是唯一接触 DOM 的地方。
 */
import { run as runTree, runVM } from '../src/index'
import { disassemble } from '../src/chunk'
import { compile } from '../src/compiler'
import { parse } from '../src/parser'
import { resolve } from '../src/resolver'

const editor = document.getElementById('editor') as HTMLTextAreaElement
const output = document.getElementById('output') as HTMLPreElement
const timing = document.getElementById('timing') as HTMLElement
const backendSel = document.getElementById('backend') as HTMLSelectElement
const exampleSel = document.getElementById('example') as HTMLSelectElement
const showDisasm = document.getElementById('showDisasm') as HTMLInputElement
const runBtn = document.getElementById('run') as HTMLButtonElement

const EXAMPLES: Record<string, string> = {
  '递归 fib（编译器的主场）': `// 经典递归：字节码 VM 省掉了每次重新走 AST 的开销
fn fib(n) {
    if (n < 2) return n;
    return fib(n - 1) + fib(n - 2);
}

for (var i = 0; i <= 20; i += 1) {
    print("fib(\${i}) = \${fib(i)}");
}`,
  '闭包与 upvalue': `// 闭包：函数记得它出生的地方
fn makeCounter(prefix) {
    var count = 0;
    fn increment() {
        count += 1;
        return "\${prefix} 第 \${count} 次";
    }
    return increment;
}

var tea = makeCounter("茶");
var cake = makeCounter("点心");
print(tea(), tea(), cake(), tea());`,
  'FizzBuzz': `for (var i = 1; i <= 15; i += 1) {
    if (i % 15 == 0) {
        print("FizzBuzz");
    } else if (i % 3 == 0) {
        print("Fizz");
    } else if (i % 5 == 0) {
        print("Buzz");
    } else {
        print(i);
    }
}`,
  '数组与 map': `var 盘子 = ["苹果", "橘子", "桃子"];
push(盘子, "荔枝");
print("果盘里有 \${len(盘子)} 样水果：\${盘子}");

var 价格表 = {苹果: 5, 橘子: 3, 桃子: 8};
var 总价 = 0;
for (var i = 0; i < len(盘子); i += 1) {
    var 水果 = 盘子[i];
    if (has(价格表, 水果)) { 总价 += 价格表[水果]; }
}
print("总价：\${总价} 元");`,
  '性能对比：循环累加': `// 试试切换两个后端感受差距（树遍历 vs 字节码）
var sum = 0;
for (var i = 0; i < 200000; i += 1) {
    sum += i % 7 * 3 - 1;
}
print(sum);`,
}

function render(src: string): void {
  const t0 = performance.now()
  const backend = backendSel.value
  const result = backend === 'vm' ? runVM(src) : runTree(src)
  const ms = performance.now() - t0
  timing.textContent = `${backend === 'vm' ? '字节码 VM' : '树遍历'} · ${ms.toFixed(1)}ms`

  if (showDisasm.checked) {
    try {
      const program = parse(src)
      resolve(program)
      output.textContent = disassemble(compile(program))
      output.className = 'disasm'
      return
    } catch {
      // 编译失败时回落到普通输出视图
    }
  }

  output.className = ''
  const parts: string[] = result.output.map((line) => `<div class="out-line">${escapeHtml(line)}</div>`)
  if (result.error) {
    const e = result.error
    parts.push(
      `<div class="out-err">\n${e.name}（第 ${e.line} 行，第 ${e.col} 列）：${escapeHtml(e.message)}</div>`
    )
  }
  output.innerHTML = parts.join('') || '<div class="meta">（无输出）</div>'
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

for (const name of Object.keys(EXAMPLES)) {
  const opt = document.createElement('option')
  opt.value = name
  opt.textContent = name
  exampleSel.appendChild(opt)
}

exampleSel.addEventListener('change', () => {
  editor.value = EXAMPLES[exampleSel.value] ?? ''
  render(editor.value)
})
backendSel.addEventListener('change', () => render(editor.value))
runBtn.addEventListener('click', () => render(editor.value))
editor.addEventListener('input', () => {
  exampleSel.value = ''
  clearTimeout((editor as HTMLTextAreaElement & { _t?: number })._t)
  ;(editor as HTMLTextAreaElement & { _t?: number })._t = window.setTimeout(() => render(editor.value), 400)
})
showDisasm.addEventListener('change', () => render(editor.value))

editor.value = EXAMPLES['递归 fib（编译器的主场）']!
render(editor.value)
