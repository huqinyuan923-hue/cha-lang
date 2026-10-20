import { describe, expect, it } from 'vitest'
import { run, runVM, Session, VMSession, type RunOptions } from '../src/index'
import { disassemble } from '../src/chunk'
import { compile } from '../src/compiler'
import { parse } from '../src/parser'

/**
 * 差分断言：字节码 VM 的输出与错误必须和树遍历解释器完全一致。
 * 树遍历器是参照实现——它的行为就是语言规范。
 */
const diff = (src: string, options: RunOptions = {}) => {
  const tree = run(src, options)
  const vm = runVM(src, options)
  expect({ out: vm.output, err: vm.error }).toEqual({ out: tree.output, err: tree.error })
  return vm
}

describe('VM 与树遍历器差分：算术与格式化', () => {
  it('四则与取模', () => {
    diff('print(1 + 2 * 3);')
    diff('print((1 + 2) * 3);')
    diff('print(10 / 4);')
    diff('print(10 % 3);')
    diff('print(-5 + 2);')
    diff('print(2.0, 0.1 + 0.2, 1 / 3);')
  })

  it('字符串与插值', () => {
    diff('var n = 3; print("合计 ${n} 件");')
    diff('print("${1 + 2} * ${2}");')
    diff('var m = {key: "值"}; print("取到 ${m["k${"e"}y"]}");')
    diff('print("${[1, 2]}");')
    diff('print("${{a: 1}}");')
    diff('print("茶馆"[0], len("手写一门编程语言"));')
  })

  it('真值与短路', () => {
    diff('print(!nil, !false, !0, !"");')
    diff('print(nil or "默认", 0 or 99, false or 99);')
    diff('print("有" and "后值", nil and "不可达");')
    diff('var x = 0; false and (x = 5); print(x);')
    diff('var y = 0; true or (y = 9); print(y);')
  })
})

describe('VM 与树遍历器差分：变量与作用域', () => {
  it('全局变量与遮蔽', () => {
    diff('var x = 1; { var x = 2; print(x); } print(x);')
    diff('var a = 1; { a = 99; } print(a);')
    diff('var v = 10; v += 5; v *= 2; v -= 1; v /= 3; v %= 4; print(v);')
  })

  it('局部变量槽位与嵌套作用域', () => {
    diff(`
      fn f() {
        var a = 1;
        { var a = 2; { var a = 3; print(a); } print(a); }
        print(a);
      }
      f();
    `)
    diff(`
      var s = 0;
      for (var i = 0; i < 5; i += 1) { var t = i * 2; s += t; }
      print(s);
    `)
  })

  it('局部递归函数（var 绑定的 fn 自引用）', () => {
    diff(`
      fn outer() {
        var fact = fn f(n) { if (n <= 1) return 1; return n * f(n - 1); };
        return fact(6);
      }
      print(outer());
    `)
  })
})

describe('VM 与树遍历器差分：闭包与 upvalue', () => {
  it('计数器闭包（教科书用例）', () => {
    diff(`
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
      print(tea(), tea(), cake(), tea());
    `)
  })

  it('三层 upvalue 链', () => {
    diff(`
      fn outer() {
        var x = "外";
        fn middle() {
          fn inner() { return x; }
          return inner;
        }
        return middle();
      }
      print(outer()());
    `)
  })

  it('多个闭包共享同一个变量', () => {
    diff(`
      fn makePair() {
        var n = 0;
        fn inc() { n += 1; return n; }
        fn get() { return n; }
        return {inc: inc, get: get};
      }
      var p = makePair();
      p.inc(); p.inc(); p.inc();
      print(p.get());
    `)
  })

  it('循环体内创建的闭包（upvalue 在块退出时关闭）', () => {
    diff(`
      var fns = [];
      for (var i = 0; i < 3; i += 1) {
        var label = "第${'$'}{i}号";
        fns.push(fn() { return "\${label}@\${i}"; });
      }
      for (var j = 0; j < len(fns); j += 1) print(fns[j]());
    `)
  })

  it('内层同名变量遮蔽外层时，闭包捕获的是内层那个', () => {
    diff(`
      fn f() {
        var x = "外";
        {
          var x = "内";
          return fn () { return fn () { return x; }; };
        }
      }
      print(f()()());
    `)
  })
})

describe('VM 与树遍历器差分：循环与控制流', () => {
  it('while + break / continue', () => {
    diff(`
      var i = 0;
      while (true) {
        i += 1;
        if (i % 2 == 0) continue;
        if (i > 7) break;
        print(i);
      }
      print(i);
    `)
  })

  it('for + continue 仍执行 update', () => {
    diff(`
      var s = 0;
      for (var i = 0; i < 10; i += 1) {
        if (i % 3 == 0) continue;
        if (i > 8) break;
        s += i;
      }
      print(s);
    `)
  })

  it('嵌套循环：break 只跳出一层', () => {
    diff(`
      for (var i = 0; i < 3; i += 1) {
        for (var j = 0; j < 3; j += 1) {
          if (j == 1) break;
          print("\${i}-\${j}");
        }
      }
    `)
  })
})

describe('VM 与树遍历器差分：数组 / map / 内建函数', () => {
  it('数组操作与复合下标赋值', () => {
    diff('var list = [3, 1, 2]; push(list, 4); print(list, pop(list), len(list));')
    diff('var a = [1, 2, 3]; a[1] = 99; a[0] += 10; a[2] *= 2; print(a);')
    diff('var a = [1, 2]; a[0] -= a[1]; print(a);')
    diff('print(range(3), range(1, 4), range(10, 0, -3));')
  })

  it('map 操作与点号赋值', () => {
    diff(`
      var user = {name: "ADCakeyuan", site: "adcakeyuan.top"};
      user["level"] = 3;
      user.level += 1;
      print(user, keys(user), values(user), has(user, "level"), has(user, "email"));
    `)
  })

  it('数字与类型工具', () => {
    diff('print(floor(3.99), abs(-7), num("42") + 1, str(42) + "!");')
    diff('print(type(1), type("字"), type(nil), type(true), type([]), type({}), type(print));')
  })
})

describe('VM 与树遍历器差分：标准输入 input()', () => {
  /** 每次运行各拿一份独立队列，两个后端读到同样的行 */
  const feed = (...lines: string[]): RunOptions => {
    let i = 0
    return { readLine: () => (i < lines.length ? lines[i++]! : null) }
  }
  const diffFed = (src: string, lines: string[] = []) => {
    const tree = run(src, feed(...lines))
    const vm = runVM(src, feed(...lines))
    expect({ out: vm.output, err: vm.error }).toEqual({ out: tree.output, err: tree.error })
    return vm
  }

  it('读取整行并可用于插值', () => {
    expect(diffFed('var a = input("名字："); print("你好 ${a}");', ['张三']).output).toEqual(['你好 张三'])
  })

  it('EOF 返回 nil', () => {
    expect(diffFed('var a = input(); print(a == nil, type(a));', []).output).toEqual(['true nil'])
  })

  it('循环逐行读取直到 EOF', () => {
    const src = `
      var total = 0;
      while (true) {
          var line = input();
          if (line == nil) { break; }
          total += num(line);
      }
      print(total);
    `
    expect(diffFed(src, ['1', '2', '3']).output).toEqual(['6'])
  })

  it('参数超过 1 个时报错在调用点', () => {
    const r = diffFed('print(input("a", "b"));', ['x'])
    expect(r.error).toMatchObject({ phase: 'runtime', line: 1 })
    expect(r.error!.message).toContain('input() 只能接受 0 或 1 个参数')
  })

  it('宿主没给标准输入时两个后端同样报错', () => {
    const r = diff('print(input());')
    expect(r.error!.message).toContain('宿主没有提供标准输入')
  })
})

describe('VM 与树遍历器差分：字符串工具', () => {
  it('split / join / trim / lower / upper 的正常路径', () => {
    diff('print(split("a,b,c", ","));')
    // 空分隔符按码点拆开
    diff('print(split("中文", ""));')
    // join 里嵌套数组的格式化
    diff('print(join(["x", 1, [2, 3]], "-"));')
    diff('print(trim("  空格  "));')
    diff('print(upper("Mix中文"), lower("MIX中文"));')
    diff('var parts = split("甲,乙,丙", ","); print(join(parts, "|"), len(parts));')
  })

  it('contains 的字符串 / 数组 / nil 语义', () => {
    diff('print(contains("手写语言", "语"), contains("手写语言", "茶"), contains("", ""));')
    diff('print(contains([1, 2, 3], 2));')
    // 数字与字符串不相等
    diff('print(contains([1, 2], "1"));')
    diff('print(contains([nil, true], nil), contains([nil], false));')
    diff('print(contains([[1, 2], 3], [1, 2]));')
  })

  it('slice 的正负下标与缺省 end', () => {
    diff('print(slice("手写一门语言", 0, 2));')
    diff('print(slice("abcdef", -3));')
    diff('print(slice([1, 2, 3, 4], 1), slice([1, 2, 3], 1, 2));')
    diff('print(slice("abc", 0, 0), slice([], 0), type(slice("abc", 9)));')
  })

  it('参数类型错误必须逐字对齐', () => {
    diff('print(split(1, ","));')
    diff('print(split("a", 1));')
    diff('print(join("ab", ","));')
    diff('print(join([1], 2));')
    diff('print(trim(1));')
    diff('print(upper(1));')
    diff('print(lower(true));')
    diff('print(contains("s", 1));')
    diff('print(contains({a: 1}, "a"));')
    diff('print(contains(1, 1));')
    diff('print(slice(1, 0));')
    diff('print(slice("abc", "x"));')
    diff('print(slice({a: 1}, 0, 1));')
  })

  it('variadic 的个数检查：两个后端走不同代码路径', () => {
    // slice 声明为 variadic，个数校验发生在内建函数里，
    // 而固定元数内建函数（split/join/trim/contains）的个数校验发生在各自后端 CALL 之前
    const few = diff('print(slice("abc"));')
    expect(few.error).toMatchObject({ phase: 'runtime', line: 1 })
    expect(few.error!.message).toContain('slice() 需要 2~3 个参数，收到 1 个')

    const many = diff('print(slice("abc", 0, 1, 2));')
    expect(many.error).toMatchObject({ phase: 'runtime', line: 1 })
    expect(many.error!.message).toContain('slice() 需要 2~3 个参数，收到 4 个')

    const noArg = diff('print(slice());')
    expect(noArg.error!.message).toContain('slice() 需要 2~3 个参数，收到 0 个')

    diff('print(split("a,b"));')
    diff('print(trim("x", "y"));')
    diff('print(contains([1], 1, 2));')
  })
})

describe('VM 与树遍历器差分：错误必须逐字对齐', () => {
  it('算术与类型错误', () => {
    diff('print(1 / 0);')
    diff('print(5 % 0);')
    diff('print("a" + 1);')
    diff('print(1 - "x");')
    diff('print(-"字");')
    diff('print(1 < "a");')
  })

  it('下标错误', () => {
    diff('var a = [1]; print(a[5]);')
    diff('var a = [1]; print(a[-1]);')
    diff('var a = [1]; a[3] = 0;')
    diff('print("abc"[9]);')
    diff('var a = [1]; print(a["k"]);')
    diff('print(1[0]);')
    diff('var n = 5; n[0] = 1;')
  })

  it('变量与调用错误', () => {
    diff('print(未定义);')
    diff('不存在 = 5;')
    diff('var x = 1; x();')
    diff('nil();')
    diff('print(len(1, 2));')
    diff('print(floor("x"));')
    diff('print(num("abc") + 1);')
    diff('var print = 1; print("x");')
  })
})

describe('VM 与树遍历器差分：调用深度失控', () => {
  /** 树遍历器靠 JS 栈，VM 靠自己的帧数组——失控递归必须两边都收敛到同一条中文错误 */
  const tooDeep = (src: string) => {
    const result = diff(src)
    expect(result.error?.name).toBe('RuntimeError')
    expect(result.error?.message).toContain('递归太深')
    expect(result.error?.line).toBeGreaterThan(0)
    expect(result.output).toEqual([])
  }

  it('没有出口的自递归', () => {
    tooDeep('fn f(n) { return f(n - 1) + 1; } print(f(5000));')
  })

  it('有出口但超过上限', () => {
    tooDeep('fn f(n) { if (n <= 0) return 0; return 1 + f(n - 1); } print(f(5000));')
  })

  it('互递归报错在同一个调用点', () => {
    tooDeep('fn a(n) { return b(n - 1) + 1; } fn b(n) { return a(n - 1) + 1; } print(a(9000));')
  })

  it('函数值转手调用（trampoline 式）', () => {
    tooDeep('fn apply(g) { return g(); } fn loop() { return apply(loop); } print(loop());')
  })

  it('闭包内递归，且深度检查晚于参数个数检查', () => {
    tooDeep('fn make(n) { fn inner(m) { return inner(m - 1) + n; } return inner(9000); } print(make(1));')
    diff('fn f(a, b) { return f(a, b); } print(f(1));')
  })

  it('上限之内照常算，边界两侧各验一次', () => {
    const ok = diff('fn f(n) { if (n <= 0) return 0; return 1 + f(n - 1); } print(f(499));')
    expect(ok.output).toEqual(['499'])
    // f(N) 要 N+1 层：第 500 层还能进去，第 501 层才报错
    tooDeep('fn f(n) { if (n <= 0) return 0; return 1 + f(n - 1); } print(f(500));')
  })

  it('深度错误优先于同一层的类型错误', () => {
    tooDeep('fn f(n) { return f(n - 1) + "x"; } print(f(9000));')
  })
})

describe('VM 与树遍历器差分：循环轮数预算', () => {
  /**
   * 预算数的是「循环体进了多少轮」：VM 在 LOOP 回跳处计数，树遍历器在每轮收尾处计数。
   * diff() 先保证两个后端逐字一致（差一轮输出就散），再看读数是否符合语义。
   */
  const trip = (src: string, loopBudget: number, expectedOutput: string[]) => {
    const result = diff(src, { loopBudget })
    expect(result.error?.message).toBe(`循环跑了太多轮（超过 ${loopBudget} 轮），疑似死循环`)
    expect(result.output).toEqual(expectedOutput)
    return result
  }

  it('while 死循环：第 N+1 轮收尾时才停', () => {
    const r = trip('var i = 0; while (true) { i = i + 1; print(i); }', 12, [
      '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13',
    ])
    // 报错归位到 while 关键字，两个后端都是这一列
    expect({ line: r.error?.line, col: r.error?.col }).toEqual({ line: 1, col: 12 })
  })

  it('for 死循环，update 也算在这一轮里', () => {
    const r = trip('for (var i = 1; ; i = i + 1) print(i);', 8, ['1', '2', '3', '4', '5', '6', '7', '8', '9'])
    expect({ line: r.error?.line, col: r.error?.col }).toEqual({ line: 1, col: 1 })
  })

  it('continue 走回跳的那些轮同样计入', () => {
    // 11 轮里有若干轮被 continue 提前跳到回跳，print 只发生在偶数轮
    trip('var i = 0; while (true) { i = i + 1; if (i % 2 == 1) continue; print(i); }', 10, ['2', '4', '6', '8', '10'])
    trip('for (var i = 0; i < 99; i = i + 1) { if (i % 2 == 1) continue; print(i); }', 10, [
      '0', '2', '4', '6', '8', '10',
    ])
  })

  it('break 的那一轮不计入（回跳根本没执行）', () => {
    // 循环要跑到 i=4 才 break，但只回跳 3 次：预算 3 刚好放过，预算 2 就报
    const ok = diff('var i = 0; while (true) { i = i + 1; if (i > 3) break; print(i); }', { loopBudget: 3 })
    expect(ok.output).toEqual(['1', '2', '3'])
    expect(ok.error).toBeUndefined()
    trip('var i = 0; while (true) { i = i + 1; if (i > 3) break; print(i); }', 2, ['1', '2', '3'])
  })

  it('嵌套循环：内层每一轮、外层每一轮都算', () => {
    // 外层一轮 = 内层 3 轮 + 自己 1 轮 = 4 次计数；预算 10 停在第 3 个外层轮的内层第 3 轮
    trip('for (var i = 0; i < 99; i = i + 1) { print("o"); for (var j = 0; j < 3; j = j + 1) print("i"); }', 10, [
      'o', 'i', 'i', 'i', 'o', 'i', 'i', 'i', 'o', 'i', 'i', 'i',
    ])
  })

  it('函数里的循环，调用深度不占循环预算', () => {
    const ok = diff('fn count(n) { var i = 0; while (i < n) { i = i + 1; } return i; } print(count(5));', {
      loopBudget: 8,
    })
    expect(ok.output).toEqual(['5'])
    expect(ok.error).toBeUndefined()
  })

  it('预算之内行为完全不变', () => {
    const r = diff('var s = ""; for (var i = 0; i < 5; i = i + 1) { s = s + "x"; } print(s);', {
      loopBudget: 5,
    })
    expect(r.output).toEqual(['xxxxx'])
    expect(r.error).toBeUndefined()
  })
})

describe('VM 与树遍历器差分：字符串插值', () => {
  /** 词法器把插值表达式扫成独立的 token 序列，两个后端必须解析出同一棵树 */
  const both = (src: string, expected: string[]) => {
    const result = diff(src)
    expect(result.output).toEqual(expected)
    expect(result.error).toBeUndefined()
  }

  it('基本形态：单插值、多插值、紧邻', () => {
    both('var 名字 = "茶"; print("你好 ${名字}！");', ['你好 茶！'])
    both('print("a${1}b${2 + 3}c");', ['a1b5c'])
    both('print("${1}"); print("${2}");', ['1', '2'])
    both('print("纯文本没有插值");', ['纯文本没有插值'])
  })

  it('转义优先于插值触发', () => {
    both('print("价格 \\${不是插值} 100");', ['价格 ${不是插值} 100'])
    both('print("两个美元 $$ 和 $x");', ['两个美元 $$ 和 $x'])
  })

  it('插值里再套字符串、数组、map 下标（花括号歧义）', () => {
    both('print("${ "内层字符串" }");', ['内层字符串'])
    both('print("${ {a: 1}["a"] }");', ['1'])
    both('print("${ {a: {b: 2}}["a"]["b"] }");', ['2'])
    both('print("${ [1, 2, 3][1] }");', ['2'])
    both('print("数组 ${[1, {a: 2}]} 结束");', ['数组 [1, {"a": 2}] 结束'])
  })

  it('多层嵌套插值', () => {
    both('print("${"外${"内"}外"}");', ['外内外'])
    both('var s = "值"; print("插值里再插值 ${ "内层 ${s}" } 结束");', ['插值里再插值 内层 值 结束'])
    both('print("${"a${"b${"c${1 + 1}d"}c"}b"}a");', ['abc2dcba'])
    both('print("${ "外${ {k: 1}["k"] }内" }");', ['外1内'])
  })

  it('插值里可以是任何表达式：三目、短路、函数调用、匿名函数', () => {
    both('print("${ 1 > 2 ? "大" : "小" }");', ['小'])
    both('print("${ nil or "兜底" }");', ['兜底'])
    both('print("${len("abc")}");', ['3'])
    both('print("${ (fn(a) { return a * 2; })(21) }");', ['42'])
    both('var n = 2; print("${n}2" == "22");', ['true'])
  })

  it('插值走作用域：局部变量与 upvalue', () => {
    both('fn f() { var y = 2; return "内层 ${y}"; } print(f());', ['内层 2'])
    both('fn outer() { var c = 7; fn inner() { return "${c}"; } return inner(); } print(outer());', ['7'])
    // 嵌套字符串按 formatValue 原样输出，不带引号 —— 看得出是插值结果，但类型要靠 type() 证明
    both(
      'fn make() { var k = 0; fn bump() { k = k + 1; return "#${k}"; } return [bump(), bump()]; } print(make());',
      ['[#1, #2]']
    )
    both(
      'fn make() { var k = 0; fn bump() { k = k + 1; return "#${k}"; } return [bump(), bump()]; } print(type(make()[0]));',
      ['string']
    )
  })

  it('插值出现在 map 值、数组元素、跨行与注释里', () => {
    both('var m = {k: "${1 + 1}", b: 2}; print(m["k"], m);', ['2 {"k": 2, "b": 2}'])
    both('print([1, "${2 + 2}", 3]);', ['[1, 4, 3]'])
    both('print(type([1, "${2 + 2}", 3][1]));', ['string'])
    both('print("${\n  1 + 1\n}");', ['2'])
    both('print("${ 1 /* 块注释 */ + 2 }");', ['3'])
    both('var x = 1; // 注释里出现 ${ 不算插值\nprint("${x}");', ['1'])
  })

  it('插值的错误：阶段、文案与位置两个后端一致', () => {
    const errs = (src: string) => {
      const r = diff(src)
      expect(r.output).toEqual([])
      expect(r.error).toBeDefined()
      return { phase: r.error!.phase, name: r.error!.name, message: r.error!.message, line: r.error!.line, col: r.error!.col }
    }
    expect(errs('print("${1);')).toEqual({ phase: 'lex', name: 'LexError', message: '插值表达式缺少匹配的 }', line: 1, col: 8 })
    expect(errs('print("a ${1 + 2");')).toEqual({ phase: 'lex', name: 'LexError', message: '字符串缺少收尾的双引号', line: 1, col: 18 })
    expect(errs('print("${}");')).toEqual({ phase: 'parse', name: 'ParseError', message: "这里不能出现 'EOF'", line: 1, col: 10 })
    expect(errs('print("${ var x = 1; x }");')).toEqual({ phase: 'parse', name: 'ParseError', message: "这里不能出现 'var'", line: 1, col: 11 })
    expect(errs('print("${ 1; }");')).toEqual({ phase: 'parse', name: 'ParseError', message: '插值表达式只能是一个表达式', line: 1, col: 12 })
    // 未定义变量归位到 ${ 处，而不是整条字符串的开头
    expect(errs('print("你好 ${名字}！");')).toEqual({ phase: 'runtime', name: 'RuntimeError', message: "未定义的变量 '名字'", line: 1, col: 13 })
  })
})

describe('VM 与树遍历器差分：try/catch 与 throw', () => {
  const both = (src: string, expected: string[], options: RunOptions = {}) => {
    const r = diff(src, options)
    expect(r.output).toEqual(expected)
    expect(r.error).toBeUndefined()
    return r
  }
  /** 出错路径也要逐字一致：diff() 比过两个后端，这里再钉住文案与位置 */
  const fails = (src: string, expected: unknown, options: RunOptions = {}) => {
    const r = diff(src, options)
    expect(r.error).toEqual(expected)
    return r
  }

  it('throw 的值原样落到 catch；语言内部的错误落到的是那条中文消息', () => {
    both('try { throw "茶凉了"; } catch (e) { print("接住：" + e); }', ['接住：茶凉了'])
    both('var 盘 = ["龙井"]; try { print(盘[5]); } catch (e) { print(e); }', ['数组下标越界：长度 1，下标 5'])
    both('try { print(1 / 0); } catch (e) { print(e); }', ['除数不能为 0'])
    // 内建函数抛的错误本来挂在调用点上，catch 拿到的仍是同一条消息
    both('try { len(1); } catch (e) { print(e); }', ['len() 只能用于字符串、数组、map，得到 number'])
    both('try { throw "x"; } catch (e) { print(type(e)); }', ['string'])
  })

  it('抛出的是普通值：map、数组、nil、数字、函数都带类型过去', () => {
    both('try { throw {码: 7}; } catch (e) { print(type(e), e["码"]); }', ['map 7'])
    both('try { throw {层: {再: "深"}}; } catch (e) { print(e["层"]["再"]); }', ['深'])
    both('try { throw [1, "a"]; } catch (e) { print(type(e), e); }', ['array [1, a]'])
    both('try { throw nil; } catch (e) { print(e == nil, e); }', ['true nil'])
    both('try { throw 42; } catch (e) { print(e + 1); }', ['43'])
    both('try { throw 3 % 0; } catch (e) { print(e); }', ['取模的除数不能为 0'])
    both('try { throw fn (x) { return x * 2; }; } catch (e) { print(type(e), e(21)); }', ['function 42'])
  })

  it('错误穿透函数调用，接住之后调用者的局部变量完好', () => {
    both(
      [
        'fn 取(m, k) { if (has(m, k)) return m[k]; throw "没有这味：${k}"; }',
        'var 菜单 = {龙井: 30};',
        'for (var i = 0; i < 2; i += 1) {',
        '    var 名 = i == 0 ? "龙井" : "普洱";',
        '    try { print("${名} ${取(菜单, 名)} 元"); } catch (e) { print("接住：${e}"); }',
        '}',
      ].join('\n'),
      ['龙井 30 元', '接住：没有这味：普洱']
    )
  })

  it('嵌套 try：内层 catch 再抛外层接；catch 体自己的错不被自己接住', () => {
    both('try { try { throw "内"; } catch (e) { throw "${e}→外"; } } catch (o) { print(o); }', ['内→外'])
    both('try { try { print("平安"); } catch (e) { print("不该跑"); } } catch (o) { print("也不该跑"); }', ['平安'])
    both('try { try { throw "a"; } catch (e) { undefinedFn(); } } catch (o) { print("外层：${o}"); }', [
      "外层：未定义的变量 'undefinedFn'",
    ])
    // try 体跑顺了，catch 体一眼都不看——树遍历器曾在这里漏了 return
    both('try { print("只跑 try"); } catch (e) { print("不该跑"); } print("收尾");', ['只跑 try', '收尾'])
  })

  it('return / break / continue 穿过 try 不算错误', () => {
    both('fn f() { try { return 1; } catch (e) { print("不该跑"); } print("也不该跑"); return 2; } print(f());', ['1'])
    both(
      'var 出 = [];\nvar 最后 = 0;\nfor (var i = 0; i < 4; i += 1) {\n    最后 = i;\n    try {\n        if (i % 2 == 0) { continue; }\n        if (i == 3) { break; }\n        throw "轮 ${i}";\n    } catch (e) { push(出, e); }\n}\nprint(出, 最后);',
      ['[轮 1] 3']
    )
    both(
      'var 出 = [];\nvar i = 0;\nwhile (i < 3) {\n    i += 1;\n    try { if (i == 2) { break; } throw "轮 ${i}"; } catch (e) { push(出, e); }\n}\nprint(出, i);',
      ['[轮 1] 2']
    )
  })

  it('break 跳出 try 时处理器一并弹掉，之后没人接的错误照原样报出', () => {
    // 少了 END_TRY 的话，这处越界会落进循环里那个早就离开的 catch
    const r = fails(
      'var 盘 = [1];\nvar i = 0;\nwhile (i < 2) { i += 1; try { break; } catch (e) { print("不该接住"); } }\nprint(盘[7]);',
      {
        name: 'RuntimeError',
        message: '数组下标越界：长度 1，下标 7',
        line: 4,
        col: 10,
        phase: 'runtime',
      }
    )
    expect(r.output).toEqual([])
  })

  it('递归失控与循环超预算都能接住，接住之后照常往下跑', () => {
    both('fn g(n) { return g(n + 1); }\ntry { g(0); } catch (e) { print("深：${e}"); }\nprint("之后还活着");', [
      '深：递归太深：调用深度超过 500 层，可能没有出口',
      '之后还活着',
    ])
    both('try { while (true) { } } catch (e) { print(e); } print("之后");', ['循环跑了太多轮（超过 100 轮），疑似死循环', '之后'], {
      loopBudget: 100,
    })
    // 预算是宿主级的止损，接住之后不重新计时：第二次一进循环就再撞
    both(
      [
        'fn 空转() { while (true) { } }',
        'var 记 = [];',
        'try { 空转(); } catch (e) { push(记, "一 ${e}"); }',
        'try { 空转(); } catch (e) { push(记, "二"); }',
        'print(记);',
      ].join('\n'),
      ['[一 循环跑了太多轮（超过 10 轮），疑似死循环, 二]'],
      { loopBudget: 10 }
    )
  })

  it('catch 参数只在 catch 体里可见：能遮蔽外层同名变量，也能被闭包带走', () => {
    both('var e = "外层"; try { throw "内层"; } catch (e) { print(e); } print(e);', ['内层', '外层'])
    both('var 记 = []; try { throw "带走"; } catch (err) { push(记, fn () { return err; }); } print(记[0]());', ['带走'])
    both(
      'try { throw 1; } catch (e) { var 只在catch = 2; print(只在catch); }\ntry { print(只在catch); } catch (e2) { print(e2); }',
      ['2', "未定义的变量 '只在catch'"]
    )
    fails('try { throw 1; } catch (e) { var e = 2; print(e); }', {
      name: 'ResolveError',
      message: "当前作用域里已经有名为 'e' 的变量了",
      line: 1,
      col: 30,
      phase: 'resolve',
    })
  })

  it('没人接住的 throw 报的是 throw 那一行的位置', () => {
    fails('throw "没人接";', {
      name: 'ThrowError',
      message: 'throw 抛出的值未被捕获：没人接',
      line: 1,
      col: 1,
      phase: 'runtime',
    })
    fails('fn f() {\n    throw "深处";\n}\nf();', {
      name: 'ThrowError',
      message: 'throw 抛出的值未被捕获：深处',
      line: 2,
      col: 5,
      phase: 'runtime',
    })
    fails('throw [1, "a"];', {
      name: 'ThrowError',
      message: 'throw 抛出的值未被捕获：[1, a]',
      line: 1,
      col: 1,
      phase: 'runtime',
    })
    // try 之前就没机会：语法错误在跑起来之前，catch 帮不上忙
    fails('try { throw } catch (e) { }', {
      name: 'ParseError',
      message: "这里不能出现 '}'",
      line: 1,
      col: 13,
      phase: 'parse',
    })
  })

  it('循环外的 break 仍然报错，包在 try 里也一样', () => {
    fails('try { break; } catch (e) { print(e); }', {
      name: 'ResolveError',
      message: 'break 只能出现在循环里',
      line: 1,
      col: 7,
      phase: 'resolve',
    })
    fails('try { return 1; } catch (e) { print(e); }', {
      name: 'ResolveError',
      message: 'return 只能出现在函数里',
      line: 1,
      col: 7,
      phase: 'resolve',
    })
  })
})

describe('VM 与树遍历器差分：类与继承', () => {
  const both = (src: string, expected: string[]) => {
    const r = diff(src)
    expect(r.error).toBeUndefined()
    expect(r.output).toEqual(expected)
    return r
  }
  /** 出错路径也要逐字一致：diff() 比过两个后端，这里再钉住文案与位置 */
  const fails = (src: string, expected: unknown) => {
    const r = diff(src)
    expect(r.error).toEqual(expected)
    return r
  }

  it('构造、字段读写、方法与 this', () => {
    both(
      `
      class 茶 {
          init(名, 年) { this.名 = 名; this.年 = 年; }
          介绍() { return this.名 + "（" + str(this.年) + " 年）"; }
          陈化(n) { this.年 += n; return this; }
      }
      var a = 茶("龙井", 2024);
      print(a.介绍());
      print(a.陈化(2).介绍());
      print(a.名, a["年"]);
      `,
      ['龙井（2024 年）', '龙井（2026 年）', '龙井 2026']
    )
  })

  it('实例之间字段独立；方法取出来仍然绑定接收者', () => {
    both(
      `
      class 计 {
          init() { this.n = 0; }
          加() { this.n = this.n + 1; return this.n; }
      }
      var a = 计();
      var b = 计();
      var f = a.加;
      print(f(), f(), a.n, b.n);
      a.n = 10;
      print(a.加(), b.加());
      `,
      ['1 2 2 0', '11 1']
    )
  })

  it('继承、覆写与多级 super 调用', () => {
    both(
      `
      class 动物 {
          init(名) { this.名 = 名; }
          说话() { return this.名 + "…"; }
          介绍() { return "我是 " + this.说话(); }
      }
      class 猫 < 动物 {
          init(名) { super.init(名); }
          说话() { return this.名 + "：喵"; }
      }
      class 波斯猫 < 猫 {
          说话() { return super.说话() + "（长毛）"; }
      }
      var c = 波斯猫("咪");
      print(c.介绍());
      print(c.说话());
      `,
      ['我是 咪：喵（长毛）', '咪：喵（长毛）']
    )
  })

  it('子类没有 init 时继承父类的 init', () => {
    both(
      `
      class 基 { init(x) { this.x = x; } }
      class 子 < 基 { }
      var s = 子(4);
      print(s.x);
      s.init(9);
      print(s.x);
      `,
      ['4', '9']
    )
  })

  it('局部类：类名在方法里递归，且被闭包捕获', () => {
    both(
      `
      fn 造(n) {
          class 节点 {
              init(v, 下) { this.v = v; this.下 = 下; }
              和() {
                  if (this.下 == nil) return this.v;
                  return this.v + this.下.和();
              }
              加(x) { return 节点(this.v + x, this.下); }
          }
          return 节点(n, 节点(n + 1, nil));
      }
      print(造(3).和());
      print(造(3).加(10).和());
      `,
      ['7', '17']
    )
  })

  it('嵌套函数捕获 this 与 super', () => {
    both(
      `
      fn 造() {
          class 基 { m() { return "基"; } }
          class 子 < 基 {
              m() { return "子+" + super.m(); }
              包() { return fn () { return this.m() + "/" + super.m(); }; }
          }
          return 子();
      }
      print(造().包()());
      `,
      ['子+基/基']
    )
  })

  it('字段可以遮蔽方法，也能按字符串下标读写', () => {
    both(
      `
      class A { m() { return "方法"; } }
      var a = A();
      print(a.m());
      a.m = fn () { return "字段"; };
      print(a.m());
      a["x"] = 1;
      a.x += 2;
      print(a.x, a["x"]);
      `,
      ['方法', '字段', '3 3']
    )
  })

  it('类相关运行时错误逐字对齐', () => {
    fails('class A { } print(A().nope);', {
      name: 'RuntimeError',
      message: "实例 A 没有属性 'nope'",
      line: 1,
      col: 23,
      phase: 'runtime',
    })
    fails('class A { init(x) { this.x = x; } } A();', {
      name: 'RuntimeError',
      message: '类 A() 需要 1 个参数，收到 0 个',
      line: 1,
      col: 39,
      phase: 'runtime',
    })
    fails('class A { } A(1);', {
      name: 'RuntimeError',
      message: '类 A() 需要 0 个参数，收到 1 个',
      line: 1,
      col: 16,
      phase: 'runtime',
    })
    fails('fn f() { } class A < f { }', {
      name: 'RuntimeError',
      message: '类 A 只能继承另一个类，得到 function',
      line: 1,
      col: 22,
      phase: 'runtime',
    })
    fails('class A < 不存在 { }', {
      name: 'RuntimeError',
      message: "未定义的变量 '不存在'",
      line: 1,
      col: 11,
      phase: 'runtime',
    })
    fails('class A { } class B < A { m() { return super.nope(); } } B().m();', {
      name: 'RuntimeError',
      message: "父类 A 没有方法 'nope'",
      line: 1,
      col: 40,
      phase: 'runtime',
    })
    fails('class A { m(x) { return x; } } A().m();', {
      name: 'RuntimeError',
      message: '函数 A.m() 需要 1 个参数，收到 0 个',
      line: 1,
      col: 38,
      phase: 'runtime',
    })
    fails('class A { } A()[0] = 1;', {
      name: 'RuntimeError',
      message: '实例 A 的属性名必须是字符串，得到 0',
      line: 1,
      col: 20,
      phase: 'runtime',
    })
    fails('class A { } print(A()[0]);', {
      name: 'RuntimeError',
      message: '实例 A 的属性名必须是字符串，得到 0',
      line: 1,
      col: 24,
      phase: 'runtime',
    })
  })

  it('类相关静态错误逐字对齐（解析期与作用域期）', () => {
    fails('print(this);', {
      name: 'ResolveError',
      message: 'this 只能用在类的方法里',
      line: 1,
      col: 7,
      phase: 'resolve',
    })
    fails('class A { m() { return super.m(); } }', {
      name: 'ResolveError',
      message: 'super 只能用在有父类的类的方法里',
      line: 1,
      col: 24,
      phase: 'resolve',
    })
    fails('class A { init() { return 1; } }', {
      name: 'ResolveError',
      message: 'init 里不能 return 值（构造完总是交出实例本身）',
      line: 1,
      col: 20,
      phase: 'resolve',
    })
    fails('class A { m() { } m() { } }', {
      name: 'ResolveError',
      message: "类 A 里已经有名为 'm' 的方法了",
      line: 1,
      col: 19,
      phase: 'resolve',
    })
    fails('class A < A { }', {
      name: 'ResolveError',
      message: '类 A 不能继承自己',
      line: 1,
      col: 11,
      phase: 'resolve',
    })
    fails('class A { m() { this = 1; } }', {
      name: 'ParseError',
      message: '这里不能被赋值',
      line: 1,
      col: 22,
      phase: 'parse',
    })
    // init 里的裸 return 合法；嵌套函数里的 return 值不受 init 规则约束
    both(
      `
      class A {
          init(x) { if (x > 0) return; this.x = x; }
          包() { return fn () { return 1; }; }
      }
      print(A(1), A(-1).x, A(0).包()());
      `,
      ['<A 实例> -1 1']
    )
  })

  it('catch 能接住类相关的运行时错误', () => {
    both(
      `
      class A { }
      try { print(A().x); } catch (e) { print("接住", e); }
      try { A(1); } catch (e) { print("接住", e); }
      print("继续");
      `,
      ['接住 实例 A 没有属性 \'x\'', '接住 类 A() 需要 0 个参数，收到 1 个', '继续']
    )
  })
})

describe('VM 专属：字节码与反汇编', () => {
  it('反汇编展示 CLASS / METHOD / INHERIT / GET_SUPER_METHOD', () => {
    const text = disassemble(
      compile(parse('class A { m() { return 1; } } class B < A { m() { return super.m(); } }'))
    )
    expect(text).toContain('CLASS')
    expect(text).toContain('METHOD')
    expect(text).toContain('INHERIT')
    expect(text).toContain('GET_SUPER_METHOD')
  })

  it('方法帧里的 this 编译成槽位 0 的 GET_LOCAL', () => {
    const text = disassemble(compile(parse('class A { m() { return this; } }')))
    // 只看 A.m 自己那一帧：整份输出里别处也可能出现 GET_LOCAL 0
    const frame = text.split(/(?=^== )/m).find((s) => s.startsWith('== A.m '))
    expect(frame).toBeDefined()
    expect(frame).toMatch(/GET_LOCAL\s+0\b/)
  })

  it('反汇编展示 TRY / END_TRY / THROW 三件套', () => {
    const text = disassemble(compile(parse('try { throw "x"; } catch (e) { print(e); }')))
    expect(text).toMatch(/ TRY\s+->/) // TRY 带前向偏移，落点就是 catch 入口
    expect(text).toContain('END_TRY')
    expect(text).toContain('THROW')
  })

  it('反汇编输出包含指令与位置', () => {
    const proto = compile(parse('var x = 1; print(x + 2);'))
    const text = disassemble(proto)
    expect(text).toContain('CONST')
    expect(text).toContain('GET_GLOBAL')
    expect(text).toContain('ADD')
    expect(text).toContain('RETURN')
    expect(text).toMatch(/; \d+:\d+/)
  })

  it('示例程序全部可跑且两个后端一致', () => {
    const { readdirSync, readFileSync } = require('node:fs') as typeof import('node:fs')
    const { join } = require('node:path') as typeof import('node:path')
    const dir = join(__dirname, '..', 'examples')
    for (const file of readdirSync(dir).filter((f: string) => f.endsWith('.cha'))) {
      // 示例里的 input() 统一喂一行固定文本
      diff(readFileSync(join(dir, file), 'utf-8'), { readLine: () => '示例输入' })
    }
  })
})

describe('会话（Session / VMSession）跨段类声明', () => {
  const classSource = `class 茶 {
    init(名字) { this.名字 = 名字; }
    介绍() { return this.名字; }
}
class 普洱 < 茶 {
    介绍() { return super.介绍() + "！"; }
}`

  it('树遍历会话：上一段声明的类在下一段照常调用（this/super 不丢解析结果）', () => {
    const out: string[] = []
    const session = new Session({ output: (text) => out.push(text) })
    expect(session.run(classSource).error).toBeUndefined()
    const result = session.run('var p = 普洱("熟普"); print(p.介绍());\nvar f = p.介绍; print(f());')
    expect(result.error).toBeUndefined()
    expect(out).toEqual(['熟普！', '熟普！'])
  })

  it('字节码会话跨段行为与树遍历会话一致', () => {
    const session = new VMSession()
    expect(session.run(classSource).error).toBeUndefined()
    const result = session.run('var p = 普洱("熟普"); print(p.介绍());')
    expect(result.error).toBeUndefined()
    expect(result.output).toEqual(['熟普！'])
  })
})
