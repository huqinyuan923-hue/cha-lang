import { createInterface } from 'readline'
import { pathToFileURL } from 'url'
import { Session } from './index'

/**
 * 独立 REPL（`pnpm repl`）。
 * 特性：表达式自动回显、括号未闭合时多行续输入、全局状态跨行共享。
 */
export async function startRepl(): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '茶> ',
  })
  console.log('Cha（茶）REPL — 输入表达式直接看结果，:q 退出')
  rl.prompt()

  // 会话：变量与函数跨行共享
  const session = new Session({
    output: (text) => console.log(text),
  })

  let pending = ''

  function finishTurn(): void {
    pending = ''
    rl.setPrompt('茶> ')
    rl.prompt()
  }

  rl.on('line', (line: string) => {
    const input = (pending + line).trim()

    if (!pending && (input === ':q' || input === ':quit' || input === 'exit')) {
      rl.close()
      return
    }
    if (!pending && input === '') {
      rl.prompt()
      return
    }

    const source = pending === '' ? asSource(input) : `${input}\n`
    let result = session.run(source)

    // 表达式解析失败 → 按语句重试（例如以 { 开头的代码块）
    if (pending === '' && looksLikeExpression(input) && result.error?.phase === 'parse') {
      result = session.run(`${input};\n`)
    }

    // 解析错误且输入明显没写完 → 进入/维持多行模式
    if (result.error?.phase === 'parse' && isOpenEnded(result.error)) {
      pending = `${pending}${line}\n`
      rl.setPrompt('…> ')
      rl.prompt()
      return
    }

    for (const out of result.output) console.log(out)
    if (result.error) {
      console.log(`  ⚠ ${phaseName(result.error.phase)}错误：${result.error.message}`)
    }
    finishTurn()
  }).on('close', () => {
    console.log('茶凉了，下次再喝 ☕')
    process.exit(0)
  })
}

function asSource(input: string): string {
  return looksLikeExpression(input) ? `print(${input});` : `${input}${input.endsWith(';') ? '' : ';'}`
}

function looksLikeExpression(input: string): boolean {
  return !/^(var|fn|if|while|for|return|break|continue)\b/.test(input)
}

function isOpenEnded(error: { phase: string; message: string }): boolean {
  if (error.phase !== 'parse') return false
  // 只把这些「真的没写完」错误当作需要续行
  return (
    /缺少收尾的 \}/.test(error.message) ||
    /缺少匹配的 '\)'/.test(error.message) ||
    /应以 '\)' 结尾/.test(error.message) ||
    /字符串缺少收尾的双引号/.test(error.message)
  )
}

function phaseName(phase: string): string {
  switch (phase) {
    case 'lex':
      return '词法'
    case 'parse':
      return '语法'
    case 'resolve':
      return '作用域'
    default:
      return '运行时'
  }
}

// 仅在直接执行本文件（pnpm repl）时启动；被 cli.ts 导入时不产生副作用
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) void startRepl()
