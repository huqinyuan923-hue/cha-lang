import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildSync } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'

let dir: string
let cli: string
let historyFile: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cha-cli-'))
  cli = join(dir, 'cha.cjs')
  historyFile = join(dir, 'repl-history')
  buildSync({
    entryPoints: [join(process.cwd(), 'src', 'cli.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: cli,
    logLevel: 'silent',
  })
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function write(name: string, content: string): string {
  const file = join(dir, name)
  writeFileSync(file, content, 'utf8')
  return file
}

function cha(args: string[], input?: string) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    input,
    env: { ...process.env, CHA_HISTORY: historyFile },
  })
}

describe('CLI check', () => {
  it('多个文件全部通过时逐个报告并以 0 退出', () => {
    const a = write('ok-a.cha', 'var a = 1;\nprint(a);\n')
    const b = write('ok-b.cha', 'fn f(x) { return x + 1; }\nprint(f(1));\n')
    const r = cha(['check', a, b])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain(`检查通过：${a}`)
    expect(r.stdout).toContain(`检查通过：${b}`)
    expect(r.stderr).toBe('')
  })

  it('语法错误带行列、源码行和插入符，并以 65 退出', () => {
    const bad = write('bad.cha', 'var a = ;\n')
    const r = cha(['check', bad])
    expect(r.status).toBe(65)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('语法错误（第 1 行，第 9 列）')
    expect(r.stderr).toContain(' 1 | var a = ;')
    expect(r.stderr).toContain('^')
  })

  it('一个文件失败不影响后面的文件继续检查', () => {
    const good = write('after-bad-ok.cha', 'print("ok");\n')
    const bad = write('after-bad.cha', 'fn () {}\n')
    const r = cha(['check', bad, good])
    expect(r.status).toBe(65)
    expect(r.stderr).toContain('语法错误')
    expect(r.stdout).toContain(`检查通过：${good}`)
  })

  it('只做静态检查：运行时才会出错的程序也能通过', () => {
    const file = write('runtime-only.cha', 'print([1][5]);\n')
    const r = cha(['check', file])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain(`检查通过：${file}`)
  })

  it('读不到文件与未知选项各自返回 66 / 64', () => {
    const missing = cha(['check', join(dir, 'missing.cha')])
    expect(missing.status).toBe(66)
    expect(missing.stderr).toContain('读不到文件：')

    const flagged = cha(['check', '--tree', write('flag.cha', 'print(1);\n')])
    expect(flagged.status).toBe(64)
    expect(flagged.stderr).toContain('check 不接受选项')
  })

  it('一个文件都不给时打印用法并返回 64', () => {
    const r = cha(['check'])
    expect(r.status).toBe(64)
    expect(r.stderr).toContain('cha check <文件.cha>...')
  })
})

describe('CLI 源码读取', () => {
  it('剥掉 UTF-8 BOM 后 check 与 run 都正常', () => {
    const bom = write('bom.cha', '\uFEFFvar 茶 = "好";\nprint(茶);\n')
    const checked = cha(['check', bom])
    expect(checked.status).toBe(0)

    const ran = cha(['run', bom])
    expect(ran.status).toBe(0)
    expect(ran.stdout).toBe('好\n')
  })

  it('运行时错误返回 70，并附带出错行', () => {
    const file = write('runtime.cha', 'var 结果 = 1;\nprint(结果 + 未知变量);\n')
    const r = cha(['run', file])
    expect(r.status).toBe(70)
    expect(r.stderr).toContain('运行时错误（第 2 行')
    expect(r.stderr).toContain('print(结果 + 未知变量);')
    expect(r.stderr).toContain('^')
  })

  it('--help 列出 check', () => {
    const r = cha(['--help'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('cha check <文件.cha>...')
  })
})

describe('REPL 终端输出', () => {
  it('错误带当前输入内的行列，:help 可用，退出语正常', () => {
    const r = cha([], '1 +\n:help\n:q\n')
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/语法错误（第 1 行，第 \d+ 列）/)
    expect(r.stdout).toContain(':help 显示本帮助')
    expect(r.stdout).toContain('茶凉了，下次再喝')
  })
})
