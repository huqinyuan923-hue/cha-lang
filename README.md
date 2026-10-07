# Cha（茶）☕

> 用 **TypeScript 从零手写**的微型编程语言：手写词法分析器 → 递归下降解析器 → 静态作用域解析 → 树遍历求值器。
> 零运行时依赖，`src/index.ts` 是纯模块（不依赖 Node API），可以直接编译进浏览器 Playground。

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
pnpm test                # 100 个测试用例
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
| 标识符 | ASCII + **中文**（`var 变量 = 1` 合法） |
| `{}` 歧义 | 语句开头的 `{` 是代码块；表达式位置的 `{}` 是 map（与 JS 相同） |

### 内建函数

`print(...)` `clock()` `len(x)` `type(x)` `str(x)` `num(s)` `floor(n)` `abs(n)` `push(arr, v)` `pop(arr)` `keys(m)` `values(m)` `has(m, k)` `range(a[, b[, step]])`

## 项目结构（一条流水线）

```
源码.cha
  → src/lexer.ts       词法分析：字符流 → token（模板插值、嵌套注释都在这）
  → src/parser.ts      语法分析：token → AST（递归下降 + 优先级链）
  → src/resolver.ts    作用域解析：算出每个变量到声明处的距离，提前抓静态错误
  → src/interpreter.ts 树遍历求值：环境链、闭包、内建函数
  → src/index.ts       对外 API：run() / Session（不依赖 Node，可进浏览器）
  → src/cli.ts / repl.ts   命令行与交互环境
```

## 测试

100 个用例，覆盖每个阶段的行为与报错：

```bash
pnpm test        # 全量
pnpm test:watch  # 开发模式
```

## 路线图

- [ ] 字符串插值的解析器协同（消掉词法器的歧义报错）
- [ ] 类与继承（成员方法、this）
- [ ] try/catch 错误处理
- [ ] 字节码编译器 + 栈式虚拟机（对照实验：快多少倍？）
- [ ] 浏览器 Playground 嵌入博客文章
- [ ] 自动分号插入（也许永远不做）

## 系列文章

实现过程中的设计决策、踩坑与取舍，写成了一系列文章（大纲见 [docs/SERIES.md](docs/SERIES.md)）。
