# Cha（茶）☕

[![CI](https://github.com/huqinyuan923-hue/cha-lang/actions/workflows/ci.yml/badge.svg)](https://github.com/huqinyuan923-hue/cha-lang/actions/workflows/ci.yml)

> 用 **TypeScript 从零手写**的微型编程语言：手写词法分析器 → 递归下降解析器 → 静态作用域解析，
> 两个可互换的执行后端——树遍历求值器与字节码编译器 + 栈式虚拟机。
> 零运行时依赖，`src/index.ts` 是纯模块（不依赖 Node API），可以直接编译进浏览器 Playground。

**在线体验**：<https://cha.adcakeyuan.top> —— 浏览器内编辑运行、双后端一键切换、可查看编译出的字节码。

<p align="center">
  <img src="docs/playground.png" width="49%" alt="Cha Playground：左侧编辑源码，右侧实时输出" />
  <img src="docs/playground-disasm.png" width="49%" alt="字节码视图：操作码、常量与跳转目标分色渲染" />
</p>

```cha
// 一杯茶的时间，看懂这门语言
var 杯子 = ["龙井", "普洱", "铁观音"];
fn 冲泡(茶名, 次数) {
    return "第 ${次数} 泡 ${茶名}";
}
for (var i = 1; i <= len(杯子); i += 1) {
    print(冲泡(杯子[i - 1], i));
}
```

## 快速开始

```bash
pnpm install

pnpm repl                # 交互式 REPL（表达式回显、多行输入、状态共享）
pnpm cha run examples/hello.cha   # 运行脚本
pnpm test                # 122 个测试用例
pnpm build               # esbuild 打包成单文件 dist/cha.cjs
```

## 语言一览

```cha
// 变量（中文变量名是一等公民）
var 名字 = "茶";
var 版本 = 1;

// 控制流
if (版本 >= 1 and 名字 == "茶") {
    print("上茶！");
} else {
    print("茶还没好");
}

// 循环：while 和 for（for 是 while 的语法糖）
while (版本 < 3) {
    版本 += 1;
}
for (var i = 0; i < 3; i += 1) {
    print(i);
}

// 函数与闭包：函数是一等公民，闭包记得出生地
fn makeCounter() {
    var count = 0;
    fn inc() {
        count += 1;
        return count;
    }
    return inc;
}
var 计数 = makeCounter();
计数();  // 1
计数();  // 2

// 数组与 map（键支持字符串/标识符/数字/[计算]）
var 茶单 = {龙井: 30, 普洱: 25};
茶单["铁观音"] = 28;
print(茶单["龙井"], len(茶单), has(茶单, "普洱"));  // 30 3 true
```

### 语法要点

| 主题 | 规则 |
| --- | --- |
| 语句结尾 | 每条语句以 `;` 结尾（暂时不做自动分号插入，这是特性不是缺陷） |
| 真值 | 只有 `false` 和 `nil` 为假，**`0` 和 `""` 都为真**（Lox 风格） |
| 加法 `+` | 只能数字+数字 或 字符串+字符串；混排请用 `"${...}"` 插值 |
| 相等 | `==` 对数组/map 做**深比较** |
| and/or | 短路求值，返回决定结果的那个操作数（Python 风格） |
| 注释 | `//` 行注释；`/* */` 块注释，**支持嵌套** |
| 字符串 | 双引号，支持 `\n` `\t` `\$` 转义；`${表达式}` 插值可任意嵌套 |
| 打印嵌套值 | 数组/map 里的字符串**不带引号**（`print([1, "a"])` → `[1, a]`），只有 map 的键带引号；`str()` 也只给顶层字符串加引号，看类型请用 `type()` |
| 标识符 | ASCII + **中文**（`var 变量 = 1` 合法） |
| `{}` 歧义 | 语句开头的 `{` 是代码块；表达式位置的 `{}` 是 map（与 JS 相同） |

### 内建函数

`print(...)` `clock()` `len(x)` `type(x)` `str(x)` `num(s)` `floor(n)` `abs(n)` `push(arr, v)` `pop(arr)` `keys(m)` `values(m)` `has(m, k)` `range(a[, b[, step]])` `input([提示语])` `split(s, sep)` `join(arr, sep)` `trim(s)` `lower(s)` `upper(s)` `contains(v, x)` `slice(v, start[, end])`

字符串工具是后加的：一开始字符串只有 `len`、下标和插值，切个 csv、判断包含、取个子串都得手写循环，
写示例时才发现有多别扭。`contains` 对字符串查子串、对数组查成员（map 请用 `has`）；
`slice` 对字符串给子串、对数组给子数组，下标允许负数，缺省 `end` 到结尾。
字符串一律按 UTF-16 码元计算（`len("👍")` 是 2，下标和 `split(s, "")` 也会把代理对劈成两半）——
这是玩具阶段的已知取舍，跟 `len`/下标从一开始就是码元语义保持一致。

`input()` 读一行（不含换行），参数是会原样写到标准输出的提示语；输入结束（EOF）返回 `nil`。
CLI 与 REPL 走真实标准输入，Playground 用浏览器的输入对话框——只在点「运行」时弹，
打字时的自动重跑不会打断你（那时 `input()` 直接返回 `nil`）。

### 运行时上限

调用深度上限 500 层，两个后端共用同一个常数，超限就在**递归调用那一行**报
`递归太深：调用深度超过 500 层，可能没有出口`。

这条是给 Playground 兜底的：没有上限时，VM 的帧数组会一路涨到把页签拖死，树遍历器则直接漏出
`Maximum call stack size exceeded`。500 不是拍脑袋——树遍历器吃的是宿主 JS 栈，浏览器里每层 cha
调用要占十几层 JS 栈，实测最费栈的形状（递归函数里再套一层闭包调用）在 Chromium 约 860 层就把栈
吃满。留足余量取 500，两个后端才能在桌面和手机浏览器里都先撞计数器，报错行列逐字一致。
万一某台宿主栈更浅，树遍历器会把 `RangeError` 归位成同一条中文错误，只是调用点可能差一层。

死循环另有轮数预算：数的是**循环体进了多少轮**，VM 在 `LOOP` 回跳处计数，树遍历器在每轮收尾处
计数，`continue` 的那轮算、`break` 的那轮不算，所以两边同一轮停下、报同一个行列。默认 2000 万轮
（CLI 里约 5 秒），Playground 压到 200 万轮（打字时自动重跑，最多卡 400 毫秒），`loopBudget` 可按宿主改。

## 项目结构（一条流水线，两个后端）

```
源码.cha
  → src/lexer.ts       词法分析：字符流 → token（模板插值、嵌套注释都在这）
  → src/parser.ts      语法分析：token → AST（递归下降 + 优先级链）
  → src/resolver.ts    作用域解析：算出每个变量到声明处的距离，提前抓静态错误
  │
  ├─ 后端一（树遍历）  src/interpreter.ts   环境链求值，参照实现
  └─ 后端二（字节码）  src/compiler.ts      AST → 字节码（栈槽分配 / upvalue 分析）
                       src/vm.ts            栈式虚拟机：值栈 + 调用帧 + upvalue 闭包
                       src/chunk.ts         指令集、常量池与反汇编器
  │
  → src/index.ts       对外 API：run() / runVM() / Session / VMSession（纯模块，可进浏览器）
  → src/cli.ts / repl.ts   命令行与交互环境
  → playground/        浏览器 Playground（在线版 <https://cha.adcakeyuan.top>，双后端切换 + 字节码视图）
```

两个后端由 **136 个测试 + 300 个种子的差分模糊测试**保证行为逐字一致——
包括错误信息里的行号和列号。

## 基准（Node 24，Windows，中位数）

| 用例 | 树遍历 | 字节码 VM | 加速比 |
|---|---|---|---|
| 递归 fib(22) | 79.4ms | 31.3ms | **2.53x** |
| 闭包计数器 ×5 万 | 49.8ms | 17.4ms | **2.86x** |
| 循环累加 20 万次 | 41.4ms | 28.7ms | 1.44x |
| 数组/map 混合 ×2 万 | 21.5ms | 16.0ms | 1.34x |

复现：`pnpm bench`。纯计算场景接近 3 倍——符合树遍历 vs 栈式 VM 的理论预期。
数组/map 用例原本只有 0.92x（VM 反而更慢）：内建函数每次调用 `slice` 出一个参数数组、
每次作用域退出重建 upvalue 列表。改成复用参数缓冲区 + 原地压缩之后翻到 1.34x。

## 快速上手字节码

```bash
pnpm cha run examples/fib.cha --disasm   # 看编译出的字节码
pnpm cha run examples/fib.cha            # 默认字节码 VM 跑
pnpm cha run examples/fib.cha --tree     # 树遍历解释器跑
```

标准输入也是通的：

```bash
printf '张三\n42\n' | pnpm cha run examples/input.cha   # input() 逐行读 stdin
```

## 测试

```bash
pnpm test        # 全量 158 个用例（含差分与模糊测试）
pnpm test:watch  # 开发模式
```

## 路线图

- [x] 字节码编译器 + 栈式虚拟机（差分验证：错误信息逐字一致，基准 1.4~3x）
- [x] 浏览器 Playground（[在线版](https://cha.adcakeyuan.top)，双后端切换 + 字节码视图，`playground/index.html`）
- [x] `input()` 标准输入（CLI/REPL 同步读 stdin，Playground 用输入对话框）
- [x] 字符串插值的解析器协同（词法器把 `${...}` 直接扫成一段独立 token，花括号歧义在词法阶段就消解了——这项其实早就做完，缺的是测试，现已用差分用例钉死嵌套、歧义、作用域与报错位置）
- [ ] 类与继承（成员方法、this）
- [ ] try/catch 错误处理
- [ ] 自动分号插入（也许永远不做）

## 系列文章

实现过程中的设计决策、踩坑与取舍，写成了一系列文章（大纲见 [docs/SERIES.md](docs/SERIES.md)）。

## 许可证

[MIT](LICENSE) © 2026 huqinyuan923-hue
