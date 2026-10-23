/**
 * Playground 入口：把语言前端 + 树遍历解释器 + 字节码 VM 打进一个 bundle。
 * src/index 不依赖 Node API，这里是唯一接触 DOM 的地方。
 */
import { formatDiagnostic, formatErrorHeader, run as runTree, runVM, sourceExcerpt } from '../src/index'
import type { ChaErrorInfo, RunOptions, RunResult, VMTraceStep } from '../src/index'
import { disassembleRows, type DisasmRow } from '../src/chunk'
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
const showTrace = document.getElementById('showTrace') as HTMLInputElement
const tracePanel = document.getElementById('tracePanel') as HTMLDivElement
const traceBody = document.getElementById('traceBody') as HTMLDivElement
const traceEmpty = document.getElementById('traceEmpty') as HTMLDivElement
const traceNote = document.getElementById('traceNote') as HTMLDivElement
const traceWindow = document.getElementById('traceWindow') as HTMLDivElement
const traceStack = document.getElementById('traceStack') as HTMLDivElement
const traceFrames = document.getElementById('traceFrames') as HTMLSpanElement
const traceStackInfo = document.getElementById('traceStackInfo') as HTMLSpanElement
const traceCount = document.getElementById('traceCount') as HTMLSpanElement
const traceRange = document.getElementById('traceRange') as HTMLInputElement
const traceFirst = document.getElementById('traceFirst') as HTMLButtonElement
const tracePrev = document.getElementById('tracePrev') as HTMLButtonElement
const tracePlay = document.getElementById('tracePlay') as HTMLButtonElement
const traceNext = document.getElementById('traceNext') as HTMLButtonElement
const traceLast = document.getElementById('traceLast') as HTMLButtonElement
const traceCopy = document.getElementById('traceCopy') as HTMLButtonElement
const traceExport = document.getElementById('traceExport') as HTMLButtonElement
const traceSource = document.getElementById('traceSource') as HTMLPreElement
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
  'try/catch 与 throw': `// throw 扔的是任意值，catch 接住的就是那个值；运行时错误也能接，接到的是那句中文消息
fn 点单(数量) {
    if (数量 <= 0) throw {"错误码": "数量不对", "收到": 数量};
    return 数量 * 8;
}
try { print(点单(3)); } catch (原因) { print("不该跑：", 原因); }
try { print(点单(0)); } catch (原因) { print("接住了：", 原因["错误码"], 原因["收到"]); }
try { print([1, 2][9]); } catch (消息) { print("运行时错误也接：", 消息); }
print("程序还在");`,
  '类与继承（this / super）': `// init 构造，this 指实例；子类覆写方法，super 调父类那一段；不写 init 就继承父类的
class 茶 {
    init(名字, 年份) { this.名字 = 名字; this.年份 = 年份; }
    介绍() { return "\${this.名字}（\${this.年份}）"; }
    陈化(n) { this.年份 += n; return this; }
}
class 普洱 < 茶 {
    介绍() { return super.介绍() + "，越陈越香"; }
}
var a = 茶("龙井", 2024);
var b = 普洱("熟普", 2000);
print(a.陈化(2).介绍());
print(b.介绍());
print(b.名字, b["年份"]);
try { print(a.产地); } catch (消息) { print("查不到：", 消息); }`,
  '执行轨迹演示': `// 勾选右上角「执行轨迹」再点「运行」，然后播放/逐步回放每条字节码
fn 加(a, b) {
    var 和 = a + b;
    return 和;
}
var 总数 = 0;
for (var i = 1; i <= 3; i += 1) {
    总数 = 加(总数, i);
}
print("总数 = \${总数}");`,
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
/**
 * print 次数预算：循环不轮转也能靠每轮狂打印拖垮页面，这里在收集端先止损。
 * 2 万行远高于任何示例的输出量，又能在几十毫秒内撞上。
 */
const OUTPUT_BUDGET = 20_000
/** range() 单次分配预算：再大就会在浏览器里卡住甚至吃光内存 */
const RANGE_BUDGET = 2_000_000
/** 轨迹最多记录/回放多少步：足够覆盖教学示例，又不会把浏览器拖垮 */
const MAX_TRACE_STEPS = 5000
const TRACE_PLAY_MS = 120
const TRACE_WINDOW_BEFORE = 2
const TRACE_WINDOW_AFTER = 2
const TRACE_PAGE_JUMP = 10

interface SavedState {
  code: string
  backend: 'vm' | 'tree'
  disasm: boolean
  trace: boolean
  example: string
}

function formatError(e: ChaErrorInfo, source: string): string {
  return formatDiagnostic(source, e)
}

/** 错误块：标题红色，源码片段整体调暗，只有插入符保持红色 */
function renderError(e: ChaErrorInfo, source: string): string {
  const header = `<div class="out-err">${escapeHtml(formatErrorHeader(e))}</div>`
  const excerpt = sourceExcerpt(source, e.line, e.col)
  if (excerpt === null) return header

  const split = excerpt.lastIndexOf('\n')
  const body = excerpt.slice(0, split)
  const caretLine = excerpt.slice(split + 1)
  const caretAt = caretLine.lastIndexOf('^')
  return (
    `<div class="err-block">${header}<div class="err-snippet">${escapeHtml(body)}\n` +
    `${escapeHtml(caretLine.slice(0, caretAt))}<span class="err-caret">^</span></div></div>`
  )
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
      trace: showTrace.checked,
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
      trace: parsed.trace === true,
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
      const rows = disassembleRows(compile(program))
      output.className = 'disasm'
      lastPlainText = rows.map((row) => row.text).join('\n')
      let html = renderDisasm(rows)
      if (result.error) {
        lastPlainText += `\n\n${formatError(result.error, src)}`
        html += `\n\n${renderError(result.error, src)}`
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
    const errLine = formatError(result.error, src)
    lastPlainText += `${lastPlainText ? '\n\n' : ''}${errLine}`
    parts.push(renderError(result.error, src))
    setStatus(`运行出错：第 ${result.error.line} 行，第 ${result.error.col} 列`)
  } else {
    setStatus(`运行完成：${result.output.length} 行输出，耗时 ${ms.toFixed(1)} 毫秒`)
  }
  output.innerHTML = parts.join('') || '<div class="meta">（无输出）</div>'
  output.scrollTop = 0
}

// ---------- 执行轨迹：记录 + 回放 ----------

let traceSteps: VMTraceStep[] = []
let traceIndex = 0
let traceTimer: number | undefined
let traceTruncated = false

const TRACE_BUTTONS = [traceFirst, tracePrev, tracePlay, traceNext, traceLast, traceCopy, traceExport]
const TRACE_EMPTY_HINT = '按「运行」采集轨迹'
const TRACE_EMPTY_ERROR = '程序没有执行到任何指令（编译未通过）'

function stopTracePlayback(): void {
  if (traceTimer !== undefined) {
    window.clearInterval(traceTimer)
    traceTimer = undefined
  }
  tracePlay.textContent = '▶ 播放'
  tracePlay.setAttribute('aria-label', '播放轨迹')
}

function resetTrace(): void {
  stopTracePlayback()
  traceSteps = []
  traceIndex = 0
  traceTruncated = false
  traceEmpty.textContent = TRACE_EMPTY_HINT
}

function updateTraceVisibility(): void {
  const isVm = backendSel.value !== 'tree'
  showTrace.disabled = !isVm
  tracePanel.hidden = !isVm || !showTrace.checked
}

function renderTrace(): void {
  updateTraceVisibility()
  const total = traceSteps.length
  const hasSteps = total > 0
  traceBody.hidden = !hasSteps
  traceEmpty.hidden = hasSteps
  traceRange.disabled = !hasSteps
  for (const button of TRACE_BUTTONS) button.disabled = !hasSteps
  traceRange.max = String(Math.max(0, total - 1))

  if (!hasSteps) {
    traceIndex = 0
    traceRange.value = '0'
    traceRange.setAttribute('aria-valuetext', '暂无轨迹')
    traceCount.textContent = '第 0 / 0 步'
    traceFrames.textContent = '—'
    traceStackInfo.textContent = ''
    traceStack.textContent = '（空）'
    traceWindow.replaceChildren()
    traceSource.replaceChildren()
    traceNote.hidden = true
    traceNote.textContent = ''
    clearDisasmHighlight()
    return
  }

  traceIndex = Math.max(0, Math.min(total - 1, traceIndex))
  const step = traceSteps[traceIndex]!
  traceRange.value = String(traceIndex)
  traceRange.setAttribute(
    'aria-valuetext',
    `第 ${traceIndex + 1} / ${total} 步：${step.fn} ${step.op}，第 ${step.line} 行第 ${step.col} 列`
  )
  traceCount.textContent = `第 ${traceIndex + 1} / ${total} 步`

  const atStart = traceIndex === 0
  const atEnd = traceIndex === total - 1
  traceFirst.disabled = atStart
  tracePrev.disabled = atStart
  traceNext.disabled = atEnd
  traceLast.disabled = atEnd
  tracePlay.disabled = total < 2

  const hidden = step.depth > step.frames.length ? '… › ' : ''
  traceFrames.textContent = `${hidden}${step.frames.join(' › ')}（深度 ${step.depth}）`

  traceWindow.replaceChildren(...traceWindowRows())
  renderTraceStack(step)
  renderTraceSource(step)
  highlightDisasm(step)

  traceNote.hidden = !traceTruncated
  traceNote.textContent = traceTruncated
    ? `轨迹只记录了前 ${MAX_TRACE_STEPS} 步，程序本身已完整执行`
    : ''
}

function traceRowText(step: VMTraceStep, marker: string): string {
  return `${marker} ${step.fn}  ${String(step.addr).padStart(4, ' ')}  ${step.op.padEnd(18, ' ')} ${step.line}:${step.col}`
}

/** 当前步的纯文本快照，供「复制本步」使用 */
function traceStepText(step: VMTraceStep): string {
  const excerpt = sourceExcerpt(editor.value, step.line, step.col)
  const lines = [
    `Cha 执行轨迹 第 ${step.step + 1} / ${traceSteps.length} 步`,
    `函数：${step.fn}（深度 ${step.depth}，地址 ${step.addr}）`,
    `调用栈：${step.frames.join(' › ')}`,
    `当前指令：${step.op} · 第 ${step.line} 行，第 ${step.col} 列`,
    ...(excerpt === null ? [] : ['当前源码：', ...excerpt.split('\n')]),
    '指令窗口：',
    ...traceWindowRows().map((row) => row.textContent ?? ''),
    `栈快照（执行前 · sp=${step.sp}）：`,
  ]
  if (step.stack.length === 0) lines.push('（空）')
  else lines.push(...step.stack.map((item) => `[${item.slot}] ${item.text}`))
  if (traceTruncated) lines.push(`轨迹只记录了前 ${MAX_TRACE_STEPS} 步，程序本身已完整执行`)
  return lines.join('\n')
}

/** 整段轨迹（含源码与每步状态）下载为 JSON，浏览器里也能离线分析 */
function downloadTrace(): void {
  if (traceSteps.length === 0) return
  const payload = {
    format: 'cha-trace',
    version: 1,
    backend: 'vm',
    limit: MAX_TRACE_STEPS,
    truncated: traceTruncated,
    total: traceSteps.length,
    source: editor.value,
    steps: traceSteps,
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `cha-trace-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  flashButton(traceExport, '已导出')
  setStatus(`已导出 ${traceSteps.length} 步轨迹（JSON）`)
}

/** 当前步前后各 2 步，全部用 textContent 生成（轨迹内容来自用户程序） */
function traceWindowRows(): HTMLElement[] {
  const from = Math.max(0, traceIndex - TRACE_WINDOW_BEFORE)
  const to = Math.min(traceSteps.length, traceIndex + TRACE_WINDOW_AFTER + 1)
  const rows: HTMLElement[] = []
  for (let i = from; i < to; i += 1) {
    const step = traceSteps[i]!
    const row = document.createElement('div')
    row.className = i === traceIndex ? 'trace-line current' : 'trace-line'
    if (i === traceIndex) row.setAttribute('aria-current', 'step')
    const marker = i === traceIndex ? '▶' : ' '
    row.textContent = traceRowText(step, marker)
    rows.push(row)
  }
  return rows
}

function renderTraceStack(step: VMTraceStep): void {
  const slots = step.stack.map((item) => {
    const row = document.createElement('div')
    row.className = 'trace-slot'
    const index = document.createElement('span')
    index.className = 'trace-slot-index'
    index.textContent = `[${item.slot}]`
    row.append(index, document.createTextNode(` ${item.text}`))
    return row
  })
  if (slots.length === 0) {
    traceStack.textContent = '（空）'
  } else {
    traceStack.replaceChildren(...slots)
  }
  const overflow = step.sp - step.base > step.stack.length
  traceStackInfo.textContent = `执行前 · sp=${step.sp}${overflow ? ' · 只显示栈顶 8 个槽位' : ''}`
}

/** 当前指令对应的源码行：源码文本走 textContent，只有插入符是受控标记 */
function renderTraceSource(step: VMTraceStep): void {
  const excerpt = sourceExcerpt(editor.value, step.line, step.col)
  if (excerpt === null) {
    traceSource.textContent = '（源码不可用）'
    return
  }
  const split = excerpt.lastIndexOf('\n')
  const caretLine = split < 0 ? '' : excerpt.slice(split + 1)
  const caretAt = caretLine.lastIndexOf('^')
  if (split < 0 || caretAt < 0) {
    traceSource.textContent = excerpt
    return
  }
  const caret = document.createElement('span')
  caret.className = 'trace-caret'
  caret.textContent = '^'
  traceSource.replaceChildren(
    document.createTextNode(`${excerpt.slice(0, split)}\n${caretLine.slice(0, caretAt)}`),
    caret,
    document.createTextNode(caretLine.slice(caretAt + 1))
  )
}

function clearDisasmHighlight(): void {
  output.querySelectorAll('.d-current').forEach((row) => row.classList.remove('d-current'))
}

/** 反汇编视图在场时，把当前轨迹步对应的指令行标出来（同名匿名函数可能命中多行） */
function highlightDisasm(step: VMTraceStep): void {
  clearDisasmHighlight()
  if (!showDisasm.checked) return
  const addr = String(step.addr)
  let first: HTMLElement | null = null
  for (const row of Array.from(output.querySelectorAll<HTMLElement>('.d-row[data-addr]'))) {
    if (row.dataset.addr !== addr || row.dataset.fn !== step.fn) continue
    row.classList.add('d-current')
    first ??= row
  }
  first?.scrollIntoView({ block: 'nearest' })
}

/** 找到相邻步之间发生深度变化的位置：进入函数（调用）或回到调用者（返回） */
function findDepthChange(from: number, dir: 1 | -1, kind: 'call' | 'return'): number | null {
  for (let i = from; i > 0 && i < traceSteps.length; i += dir) {
    const previous = traceSteps[i - 1]!
    const current = traceSteps[i]!
    const hit = kind === 'call' ? current.depth > previous.depth : current.depth < previous.depth
    if (hit) return i
  }
  return null
}

function jumpDepthChange(kind: 'call' | 'return', dir: 1 | -1): void {
  const target = findDepthChange(traceIndex + dir, dir, kind)
  if (target !== null) goTrace(target)
}

function goTrace(next: number): void {
  if (traceSteps.length === 0) return
  stopTracePlayback()
  traceIndex = Math.max(0, Math.min(traceSteps.length - 1, next))
  renderTrace()
}

function startTracePlayback(): void {
  if (traceSteps.length === 0 || traceTimer !== undefined) return
  if (traceIndex >= traceSteps.length - 1) traceIndex = 0
  tracePlay.textContent = '⏸ 暂停'
  tracePlay.setAttribute('aria-label', '暂停轨迹')
  traceTimer = window.setInterval(() => {
    if (traceIndex >= traceSteps.length - 1) {
      stopTracePlayback()
      return
    }
    traceIndex += 1
    renderTrace()
  }, TRACE_PLAY_MS)
  renderTrace()
}

function toggleTracePlayback(): void {
  if (traceTimer !== undefined) stopTracePlayback()
  else startTracePlayback()
}

function render(src: string, interactive = false): void {
  const t0 = performance.now()
  const backend = backendSel.value === 'tree' ? 'tree' : 'vm'
  inputWasSkipped = false
  resetTrace()
  updateTraceVisibility()
  // 只有显式运行、勾选轨迹、且是 VM 后端时才记录；打字自动重跑走无 trace 快路径
  const collectTrace = interactive && backend === 'vm' && showTrace.checked
  const readLine = interactive ? dialogReader : silentReader
  const steps: VMTraceStep[] = []
  const runOptions: RunOptions = {
    readLine,
    loopBudget: LOOP_BUDGET,
    maxOutputLines: OUTPUT_BUDGET,
    maxRangeLength: RANGE_BUDGET,
  }
  if (collectTrace) {
    runOptions.trace = (step) => steps.push(step)
    runOptions.traceLimit = MAX_TRACE_STEPS
  }
  const result = backend === 'vm' ? runVM(src, runOptions) : runTree(src, runOptions)
  const ms = performance.now() - t0
  const backendName = backend === 'vm' ? '字节码 VM' : '树遍历'
  timing.textContent = `${backendName} · ${ms.toFixed(1)}ms`
  paintResult(result, ms, src)
  if (collectTrace) {
    traceSteps = steps
    traceIndex = 0
    traceTruncated = steps.length >= MAX_TRACE_STEPS
    if (steps.length === 0 && result.error) traceEmpty.textContent = TRACE_EMPTY_ERROR
  }
  renderTrace()
  if (inputWasSkipped) {
    setStatus(`${status?.textContent ?? ''} · 代码里的 input() 返回 nil，按「运行」才会弹窗要输入`)
  }
  if (backend === 'tree' && showTrace.checked) {
    setStatus(`${status?.textContent ?? ''} · 执行轨迹仅支持字节码 VM 后端`)
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** 反汇编行 → 着色 HTML：地址/操作码/字符串常量/跳转目标/源位置分色。 */
function renderDisasm(disasmRows: DisasmRow[]): string {
  const html: string[] = []
  for (const row of disasmRows) {
    if (row.kind === 'fn') {
      html.push(`<div class="d-fn" data-fn="${escapeAttr(row.fn)}">${escapeHtml(row.text)}</div>`)
      continue
    }
    const m = /^(\s*)(\d+)(\s+)([A-Z_0-9]+)(\s+)(.*?)(\s*); (\d+):(\d+)$/.exec(row.text)
    if (!m) {
      html.push(`<div class="d-row" data-fn="${escapeAttr(row.fn)}" data-addr="${row.addr}">${escapeHtml(row.text)}</div>`)
      continue
    }
    const operand = escapeHtml(m[6]!)
      .replace(/("(?:[^"\\]|\\.)*")/g, '<span class="d-str">$1</span>')
      .replace(/(->\s*\d+)/g, '<span class="d-jump">$1</span>')
    html.push(
      `<div class="d-row" data-fn="${escapeAttr(row.fn)}" data-addr="${row.addr}">${m[1]}<span class="d-addr">${m[2]}</span>${m[3]}<span class="d-op">${m[4]}</span>${m[5]}${operand}<span class="d-pos">${m[7]}; ${m[8]}:${m[9]}</span></div>`
    )
  }
  return html.join('')
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
  // 代码一改就丢掉旧轨迹，避免展示与当前代码不符的状态
  resetTrace()
  renderTrace()
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
  resetTrace()
  const steps: VMTraceStep[] = []
  const collectTrace = showTrace.checked && backendSel.value !== 'tree'
  const vmOptions: RunOptions = {
    readLine: dialog.ask,
    loopBudget: LOOP_BUDGET,
    maxOutputLines: OUTPUT_BUDGET,
    maxRangeLength: RANGE_BUDGET,
  }
  if (collectTrace) {
    vmOptions.trace = (step) => steps.push(step)
    vmOptions.traceLimit = MAX_TRACE_STEPS
  }
  const t0 = performance.now()
  const vmResult = runVM(src, vmOptions)
  const t1 = performance.now()
  runTree(src, {
    readLine: dialog.playback,
    loopBudget: LOOP_BUDGET,
    maxOutputLines: OUTPUT_BUDGET,
    maxRangeLength: RANGE_BUDGET,
  })
  const t2 = performance.now()
  const vmMs = t1 - t0
  const treeMs = t2 - t1
  const speed = vmMs > 0 ? treeMs / vmMs : 1
  timing.textContent = `对比：VM ${vmMs.toFixed(1)}ms · 树遍历 ${treeMs.toFixed(1)}ms · ${speed.toFixed(2)}x`
  paintResult(vmResult, vmMs, src)
  if (collectTrace) {
    traceSteps = steps
    traceIndex = 0
    traceTruncated = steps.length >= MAX_TRACE_STEPS
    if (steps.length === 0 && vmResult.error) traceEmpty.textContent = TRACE_EMPTY_ERROR
  }
  renderTrace()
  setStatus(
    `双后端对比完成：字节码 VM ${vmMs.toFixed(1)} 毫秒，树遍历 ${treeMs.toFixed(1)} 毫秒，加速比 ${speed.toFixed(2)} 倍`
  )
  saveState()
})
showDisasm.addEventListener('change', () => {
  render(editor.value)
  saveState()
})
showTrace.addEventListener('change', () => {
  resetTrace()
  renderTrace()
  saveState()
})
traceFirst.addEventListener('click', () => goTrace(0))
tracePrev.addEventListener('click', () => goTrace(traceIndex - 1))
traceNext.addEventListener('click', () => goTrace(traceIndex + 1))
traceLast.addEventListener('click', () => goTrace(traceSteps.length - 1))
tracePlay.addEventListener('click', toggleTracePlayback)
traceCopy.addEventListener('click', () => {
  const step = traceSteps[traceIndex]
  if (!step) return
  navigator.clipboard.writeText(traceStepText(step)).then(
    () => {
      flashButton(traceCopy, '已复制')
      setStatus(`已复制第 ${traceIndex + 1} 步轨迹到剪贴板`)
    },
    () => {
      flashButton(traceCopy, '复制失败')
      setStatus('剪贴板不可用，复制轨迹失败')
    }
  )
})
traceExport.addEventListener('click', downloadTrace)
traceRange.addEventListener('input', () => {
  stopTracePlayback()
  traceIndex = Number(traceRange.value) || 0
  renderTrace()
})
tracePanel.addEventListener('keydown', (event) => {
  if (traceSteps.length === 0) return
  // 滑块自己处理方向键，按钮自己处理空格/回车
  if (event.target instanceof HTMLInputElement) return
  switch (event.key) {
    case 'ArrowLeft':
      event.preventDefault()
      goTrace(traceIndex - 1)
      break
    case 'ArrowRight':
      event.preventDefault()
      goTrace(traceIndex + 1)
      break
    case 'Home':
      event.preventDefault()
      goTrace(0)
      break
    case 'End':
      event.preventDefault()
      goTrace(traceSteps.length - 1)
      break
    case '[':
    case '【':
      event.preventDefault()
      jumpDepthChange('call', -1)
      break
    case ']':
    case '】':
      event.preventDefault()
      jumpDepthChange('call', 1)
      break
    case '{':
    case '｛':
      event.preventDefault()
      jumpDepthChange('return', -1)
      break
    case '}':
    case '｝':
      event.preventDefault()
      jumpDepthChange('return', 1)
      break
    case 'PageUp':
      event.preventDefault()
      goTrace(traceIndex - TRACE_PAGE_JUMP)
      break
    case 'PageDown':
      event.preventDefault()
      goTrace(traceIndex + TRACE_PAGE_JUMP)
      break
    case ' ':
      if (event.target instanceof HTMLButtonElement) return
      event.preventDefault()
      toggleTracePlayback()
      break
  }
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
  showTrace.checked = false
  exampleSel.value = ''
  history.replaceState(null, '', location.pathname + location.search)
} else if (saved) {
  editor.value = saved.code
  backendSel.value = saved.backend
  showDisasm.checked = saved.disasm
  showTrace.checked = saved.trace
  exampleSel.value = saved.example && EXAMPLES[saved.example] === saved.code ? saved.example : ''
} else {
  editor.value = EXAMPLES[DEFAULT_EXAMPLE]!
  backendSel.value = 'vm'
  showDisasm.checked = false
  showTrace.checked = false
  exampleSel.value = DEFAULT_EXAMPLE
}
render(editor.value)