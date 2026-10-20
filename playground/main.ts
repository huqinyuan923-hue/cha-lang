/**
 * Playground 入口：把语言前端 + 树遍历解释器 + 字节码 VM 打进一个 bundle。
 * src/index 不依赖 Node API，这里是唯一接触 DOM 的地方。
 */
import { run as runTree, runVM } from '../src/index'
import type { ChaErrorInfo, RunResult } from '../src/index'
import { disassemble } from '../src/chunk'
import { compile } from '../src/compiler'
import { parse } from '../src/parser'
import { resolve } from '../src/resolver'

const editor = document.getElementById('editor') as HTMLTextAreaElement
const output = document.getElementById('output') as HTMLPreElement
const timing = document.getElementById('timing') as HTMLElement
const status = document.getElementById('status') as HTMLElement | null
const backendSel = document.getElementById('backend') as HTMLSelectElement
const exampleSel = document.getElementById('example') as HTMLSelectElement
const showDisasm = document.getElementById('showDisasm') as HTMLInputElement
const runBtn = document.getElementById('run') as HTMLButtonElement
const shareBtn = document.getElementById('share') as HTMLButtonElement | null
const copyBtn = document.getElementById('copy') as HTMLButtonElement | null
const compareBtn = document.getElementById('compare') as HTMLButtonElement | null

let lastPlainText = ''

/** 浏览器没有同步 stdin：只在用户明确「运行」时用模态框收一行输入 */
const dialogReader = (prompt: string | null): string | null =>
  window.prompt(prompt ?? '输入一行：', '')

/**
 * 打字自动重跑、切示例、切后端时不弹窗——否则每敲一个字符都会被问一次。
 * 这些路径上 input() 直接得到 nil，并在状态栏提示用户按「运行」。
 */
let inputWasSkipped = false
const silentReader = (): string | null => {
  inputWasSkipped = true
  return null
}

/** 双后端对比只弹一次：第一个后端真正提问，第二个按同样顺序回放答案 */
const makeInputDialog = () => {
  const answers: (string | null)[] = []
  return {
    ask: (prompt: string | null): string | null => {
      const answer = dialogReader(prompt)
      answers.push(answer)
      return answer
    },
    playback: (): string | null => (answers.length === 0 ? null : (answers.shift() as string | null)),
  }
}

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
  '冒泡排序': `// 数组索引赋值 + 嵌套循环
var 数据 = [5, 2, 9, 1, 7, 3];
for (var i = 0; i < len(数据) - 1; i += 1) {
    for (var j = 0; j < len(数据) - 1 - i; j += 1) {
        if (数据[j] > 数据[j + 1]) {
            var 临时 = 数据[j];
            数据[j] = 数据[j + 1];
            数据[j + 1] = 临时;
        }
    }
}
print("排序后：\${数据}");`,
  '字符串工具': `// split / join / trim / contains / slice
var 行 = "  苹果,橘子,桃子  ";
var 水果 = split(trim(行), ",");
print("切分：\${水果}");
print("拼接：\${join(水果, "、")}");
print("查找：\${contains(水果, "橘子")}, \${contains("手写语言", "语言")}");
print("切片：\${slice(水果, 1)}, \${slice(行, 2, 5)}, \${slice(水果, -1)}");`,
  '运行时错误演示': `// 出错也不怕：输出区会给出准确的错误名、行号与列号
print("这行会先执行");
var 结果 = 未知变量 + 1;
print("这行不会执行");`,
  '语法错误演示': `// 编译期的错误同样带行列号与人性化提示
var 数量 = 3;
if (数量 > 2) {
    print("少了右括号";
}
print("这行永远不会执行");`,
  '标准输入 input()': `// input() 读一行，参数是提示语；没有输入时得到 nil。
// 打字时的自动运行不弹窗（返回 nil），点「运行」才会弹出输入框。
var 名字 = input("你叫什么名字？");
if (名字 == nil) {
    print("(自动运行不采集输入，点「运行」试试)");
} else {
    print("你好，\${名字}！");
}`,
  '性能对比：循环累加': `// 试试切换两个后端感受差距（树遍历 vs 字节码）
var sum = 0;
for (var i = 0; i < 200000; i += 1) {
    sum += i % 7 * 3 - 1;
}
print(sum);`,
}

const DEFAULT_EXAMPLE = '递归 fib（编译器的主场）'
const STORAGE_KEY = 'cha-playground-state-v1'
const MAX_OUTPUT_LINES = 2000
/**
 * 打字时会自动重跑，预算必须在一两帧内撞得上：实测树遍历器约 500 万轮/秒，
 * 200 万轮最多卡 400 毫秒。示例里最重的循环是 20 万轮，离预算还差一个数量级。
 */
const LOOP_BUDGET = 2_000_000

interface SavedState {
  code: string
  backend: 'vm' | 'tree'
  disasm: boolean
  example: string
}

function formatError(e: ChaErrorInfo): string {
  return `${e.name}（第 ${e.line} 行，第 ${e.col} 列）：${e.message}`
}

function setStatus(message: string): void {
  if (status) status.textContent = message
}

function saveState(): void {
  try {
    const state: SavedState = {
      code: editor.value,
      backend: backendSel.value === 'tree' ? 'tree' : 'vm',
      disasm: showDisasm.checked,
      example: exampleSel.value,
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // 隐私模式或存储不可用时静默忽略
  }
}

function loadState(): SavedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<SavedState>
    if (typeof parsed.code !== 'string') return null
    return {
      code: parsed.code,
      backend: parsed.backend === 'tree' ? 'tree' : 'vm',
      disasm: parsed.disasm === true,
      example: typeof parsed.example === 'string' ? parsed.example : '',
    }
  } catch {
    return null
  }
}

function shareHash(): string {
  return new URLSearchParams({ code: editor.value, b: backendSel.value === 'tree' ? 'tree' : 'vm' }).toString()
}

function loadShared(): { code: string; backend: 'vm' | 'tree' } | null {
  if (location.hash.length <= 1) return null
  const params = new URLSearchParams(location.hash.slice(1))
  const code = params.get('code')
  if (code === null || code.trim() === '') return null
  return { code, backend: params.get('b') === 'tree' ? 'tree' : 'vm' }
}

function paintResult(result: RunResult, ms: number, src: string): void {
  if (showDisasm.checked) {
    try {
      const program = parse(src)
      resolve(program)
      const asm = disassemble(compile(program))
      output.className = 'disasm'
      lastPlainText = asm
      let html = renderDisasm(asm)
      if (result.error) {
        lastPlainText += `\n\n${formatError(result.error)}`
        html += `\n\n<span class="out-err">${escapeHtml(formatError(result.error))}</span>`
        setStatus(`运行出错：第 ${result.error.line} 行，第 ${result.error.col} 列`)
      } else {
        setStatus(`运行完成并生成字节码：${result.output.length} 行输出，耗时 ${ms.toFixed(1)} 毫秒`)
      }
      output.innerHTML = html
      output.scrollTop = 0
      return
    } catch {
      // 编译失败时回落到普通输出视图
    }
  }

  output.className = ''
  const lines = result.output
  const shown = lines.length > MAX_OUTPUT_LINES ? lines.slice(0, MAX_OUTPUT_LINES) : lines
  const parts: string[] = shown.map((line) => `<div class="out-line">${escapeHtml(line)}</div>`)
  lastPlainText = shown.join('\n')
  if (lines.length > MAX_OUTPUT_LINES) {
    const note = `… 输出过长，仅显示前 ${MAX_OUTPUT_LINES} 行（共 ${lines.length} 行）`
    parts.push(`<div class="meta">${escapeHtml(note)}</div>`)
    lastPlainText += `\n\n${note}`
  }
  if (result.error) {
    const errLine = formatError(result.error)
    lastPlainText += `${lastPlainText ? '\n\n' : ''}${errLine}`
    parts.push(`<div class="out-err">\n${errLine}</div>`)
    setStatus(`运行出错：第 ${result.error.line} 行，第 ${result.error.col} 列`)
  } else {
    setStatus(`运行完成：${result.output.length} 行输出，耗时 ${ms.toFixed(1)} 毫秒`)
  }
  output.innerHTML = parts.join('') || '<div class="meta">（无输出）</div>'
  output.scrollTop = 0
}

function render(src: string, interactive = false): void {
  const t0 = performance.now()
  const backend = backendSel.value === 'tree' ? 'tree' : 'vm'
  inputWasSkipped = false
  const readLine = interactive ? dialogReader : silentReader
  const result =
    backend === 'vm'
      ? runVM(src, { readLine, loopBudget: LOOP_BUDGET })
      : runTree(src, { readLine, loopBudget: LOOP_BUDGET })
  const ms = performance.now() - t0
  const backendName = backend === 'vm' ? '字节码 VM' : '树遍历'
  timing.textContent = `${backendName} · ${ms.toFixed(1)}ms`
  paintResult(result, ms, src)
  if (inputWasSkipped) {
    setStatus(`${status?.textContent ?? ''} · 代码里的 input() 返回 nil，按「运行」才会弹窗要输入`)
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 反汇编文本 → 着色 HTML：地址/操作码/字符串常量/跳转目标/源位置分色。 */
function renderDisasm(text: string): string {
  const rows: string[] = []
  for (const line of text.split('\n')) {
    if (line.startsWith('==')) {
      rows.push(`<div class="d-fn">${escapeHtml(line)}</div>`)
      continue
    }
    const m = /^(\s*)(\d+)(\s+)([A-Z_0-9]+)(\s+)(.*?)(\s*); (\d+):(\d+)$/.exec(line)
    if (!m) {
      rows.push(`<div>${escapeHtml(line)}</div>`)
      continue
    }
    const operand = escapeHtml(m[6]!)
      .replace(/("(?:[^"\\]|\\.)*")/g, '<span class="d-str">$1</span>')
      .replace(/(->\s*\d+)/g, '<span class="d-jump">$1</span>')
    rows.push(
      `<div>${m[1]}<span class="d-addr">${m[2]}</span>${m[3]}<span class="d-op">${m[4]}</span>${m[5]}${operand}<span class="d-pos">${m[7]}; ${m[8]}:${m[9]}</span></div>`
    )
  }
  return rows.join('')
}

function flashButton(btn: HTMLButtonElement, text: string): void {
  if (!btn.dataset.label) btn.dataset.label = btn.textContent ?? ''
  btn.textContent = text
  window.setTimeout(() => {
    btn.textContent = btn.dataset.label ?? ''
  }, 1600)
}

function setEditorValue(next: string, selStart: number, selEnd: number = selStart): void {
  editor.value = next
  editor.selectionStart = selStart
  editor.selectionEnd = selEnd
  editor.dispatchEvent(new Event('input', { bubbles: true }))
}

function lineBlock(): { start: number; end: number; lines: string[] } {
  const value = editor.value
  const start = value.lastIndexOf('\n', Math.max(0, editor.selectionStart - 1)) + 1
  let end = value.indexOf('\n', editor.selectionEnd)
  if (end === -1) end = value.length
  return { start, end, lines: value.slice(start, end).split('\n') }
}

/** 对整行区间做等量变换，并把选区坐标映射回新文本。 */
function replaceBlock(start: number, end: number, lines: string[], out: string[]): void {
  const value = editor.value
  const selStart = editor.selectionStart
  const selEnd = editor.selectionEnd
  const map = (p: number): number => {
    let shift = 0
    let pos = start
    for (let i = 0; i < lines.length; i += 1) {
      const lineStartPos = pos
      const lineEndPos = pos + lines[i]!.length
      const d = out[i]!.length - lines[i]!.length
      if (p >= lineEndPos) shift += d
      else if (p > lineStartPos) shift += d > 0 ? d : Math.max(d, -(p - lineStartPos))
      pos = lineEndPos + 1
    }
    return p + shift
  }
  const next = value.slice(0, start) + out.join('\n') + value.slice(end)
  setEditorValue(next, map(selStart), map(selEnd))
}

function reindent(dedent: boolean): void {
  const { start, end, lines } = lineBlock()
  const out = lines.map((line) => (dedent ? line.replace(/^ {1,4}/, '') : `    ${line}`))
  replaceBlock(start, end, lines, out)
}

function toggleComment(): void {
  const { start, end, lines } = lineBlock()
  const meaningful = lines.filter((line) => line.trim() !== '')
  const allCommented = meaningful.length > 0 && meaningful.every((line) => /^\s*\/\//.test(line))
  const out = lines.map((line) => {
    if (line.trim() === '') return line
    return allCommented ? line.replace(/^(\s*)\/\/ ?/, '$1') : line.replace(/^(\s*)/, '$1// ')
  })
  replaceBlock(start, end, lines, out)
}

const customOption = document.createElement('option')
customOption.value = ''
customOption.textContent = '自定义代码…'
customOption.disabled = true
exampleSel.appendChild(customOption)

for (const name of Object.keys(EXAMPLES)) {
  const opt = document.createElement('option')
  opt.value = name
  opt.textContent = name
  exampleSel.appendChild(opt)
}

let inputTimer: number | undefined

function scheduleRender(): void {
  exampleSel.value = ''
  if (inputTimer !== undefined) window.clearTimeout(inputTimer)
  inputTimer = window.setTimeout(() => {
    render(editor.value)
    saveState()
  }, 400)
}

exampleSel.addEventListener('change', () => {
  editor.value = EXAMPLES[exampleSel.value] ?? ''
  render(editor.value)
  saveState()
})
backendSel.addEventListener('change', () => {
  render(editor.value)
  saveState()
})
runBtn.addEventListener('click', () => {
  render(editor.value, true)
  saveState()
})
shareBtn?.addEventListener('click', () => {
  const url = `${location.origin}${location.pathname}#${shareHash()}`
  navigator.clipboard.writeText(url).then(
    () => {
      flashButton(shareBtn, '已复制')
      setStatus('分享链接已复制到剪贴板，包含当前代码与后端选择')
    },
    () => {
      location.hash = shareHash()
      flashButton(shareBtn, '手动复制')
      setStatus('剪贴板不可用：分享链接已写入地址栏，请手动复制')
    }
  )
})
copyBtn?.addEventListener('click', () => {
  navigator.clipboard.writeText(lastPlainText || '(无输出)').then(
    () => {
      flashButton(copyBtn, '已复制')
      setStatus('输出已复制到剪贴板')
    },
    () => {
      flashButton(copyBtn, '复制失败')
      setStatus('剪贴板不可用，复制失败')
    }
  )
})
compareBtn?.addEventListener('click', () => {
  const src = editor.value
  const dialog = makeInputDialog()
  const t0 = performance.now()
  const vmResult = runVM(src, { readLine: dialog.ask, loopBudget: LOOP_BUDGET })
  const t1 = performance.now()
  runTree(src, { readLine: dialog.playback, loopBudget: LOOP_BUDGET })
  const t2 = performance.now()
  const vmMs = t1 - t0
  const treeMs = t2 - t1
  const speed = vmMs > 0 ? treeMs / vmMs : 1
  timing.textContent = `对比：VM ${vmMs.toFixed(1)}ms · 树遍历 ${treeMs.toFixed(1)}ms · ${speed.toFixed(2)}x`
  paintResult(vmResult, vmMs, src)
  setStatus(
    `双后端对比完成：字节码 VM ${vmMs.toFixed(1)} 毫秒，树遍历 ${treeMs.toFixed(1)} 毫秒，加速比 ${speed.toFixed(2)} 倍`
  )
  saveState()
})
showDisasm.addEventListener('change', () => {
  render(editor.value)
  saveState()
})
editor.addEventListener('input', scheduleRender)
editor.addEventListener('keydown', (event) => {
  if (event.isComposing || event.keyCode === 229) return
  if (event.key === 'Tab') {
    event.preventDefault()
    if (event.shiftKey) {
      reindent(true)
    } else if (editor.selectionStart === editor.selectionEnd) {
      const pos = editor.selectionStart
      const value = editor.value
      setEditorValue(`${value.slice(0, pos)}    ${value.slice(pos)}`, pos + 4)
    } else {
      reindent(false)
    }
    return
  }
  if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault()
    const value = editor.value
    const start = editor.selectionStart
    const end = editor.selectionEnd
    const lineStart = value.lastIndexOf('\n', Math.max(0, start - 1)) + 1
    const before = value.slice(lineStart, start)
    let indent = /^[ \t]*/.exec(before)?.[0] ?? ''
    const lastChar = before.trimEnd().slice(-1)
    if (lastChar === '{' || lastChar === '[' || lastChar === '(') indent += '    '
    const insert = `\n${indent}`
    setEditorValue(value.slice(0, start) + insert + value.slice(end), start + insert.length)
    return
  }
  if (event.key === '/' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    toggleComment()
  }
})
document.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    render(editor.value, true)
    saveState()
  }
})
window.addEventListener('pagehide', saveState)

const shared = loadShared()
const saved = shared ? null : loadState()
if (shared) {
  editor.value = shared.code
  backendSel.value = shared.backend
  showDisasm.checked = false
  exampleSel.value = ''
  history.replaceState(null, '', location.pathname + location.search)
} else if (saved) {
  editor.value = saved.code
  backendSel.value = saved.backend
  showDisasm.checked = saved.disasm
  exampleSel.value = saved.example && EXAMPLES[saved.example] === saved.code ? saved.example : ''
} else {
  editor.value = EXAMPLES[DEFAULT_EXAMPLE]!
  backendSel.value = 'vm'
  showDisasm.checked = false
  exampleSel.value = DEFAULT_EXAMPLE
}
render(editor.value)