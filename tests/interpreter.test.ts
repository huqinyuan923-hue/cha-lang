import { describe, expect, it } from 'vitest'
import { run } from '../src/index'

/** 运行并返回输出与（可选）错误 */
const execute = (src: string) => run(src)

describe('算术与数字', () => {
  it('四则与取模', () => {
    expect(execute('print(1 + 2 * 3);').output).toEqual(['7'])
    expect(execute('print((1 + 2) * 3);').output).toEqual(['9'])
    expect(execute('print(10 / 4);').output).toEqual(['2.5'])
    expect(execute('print(10 % 3);').output).toEqual(['1'])
    expect(execute('print(-5 + 2);').output).toEqual(['-3'])
  })

  it('整数不带小数点，浮点误差被清洗', () => {
    expect(execute('print(2.0);').output).toEqual(['2'])
    expect(execute('print(0.1 + 0.2);').output).toEqual(['0.3'])
    expect(execute('print(1 / 3);').output).toEqual(['0.333333333333333'])
  })

  it('除零报错', () => {
    const r = execute('print(1 / 0);')
    expect(r.error).toMatchObject({ phase: 'runtime', line: 1 })
    expect(r.error!.message).toContain('除数不能为 0')
  })
})

describe('字符串与模板', () => {
  it('字符串拼接只限字符串', () => {
    expect(execute('print("a" + "b");').output).toEqual(['ab'])
    const r = execute('print("a" + 1);')
    expect(r.error).toMatchObject({ phase: 'runtime' })
    expect(r.error!.message).toContain('混排请用')
  })

  it('模板插值：数字自动格式化', () => {
    expect(execute('var n = 3; print("合计 ${n} 件");').output).toEqual(['合计 3 件'])
    expect(execute('print("${1 + 2} * ${2}");').output).toEqual(['3 * 2'])
  })

  it('嵌套插值', () => {
    const src = 'var m = {key: "值"}; print("取到 ${m["k${"e"}y"]}");'
    expect(execute(src).output).toEqual(['取到 值'])
  })

  it('模板里数组和 map 的展示', () => {
    expect(execute('print("${[1, 2]}");').output).toEqual(['[1, 2]'])
    expect(execute('print("${{a: 1}}");').output).toEqual(['{"a": 1}'])
  })

  it('str() 给字符串带引号，print() 不带', () => {
    expect(execute('print(str("hi"));').output).toEqual(['"hi"'])
    expect(execute('print("hi");').output).toEqual(['hi'])
  })

  it('字符串下标', () => {
    expect(execute('print("茶馆"[0]);').output).toEqual(['茶'])
    expect(execute('print("abc"[5]);').error).toMatchObject({ phase: 'runtime' })
  })
})

describe('真值与逻辑', () => {
  it('false 和 nil 为假，0 为真', () => {
    expect(execute('print(!nil, !false, !0, !"");').output).toEqual(['true true false false'])
  })

  it('and/or 短路并返回操作数本身', () => {
    expect(execute('print(nil or "默认");').output).toEqual(['默认'])
    // 注意：0 是真值（本语言的既定语义），所以 or 保留左值
    expect(execute('print(0 or 99);').output).toEqual(['0'])
    expect(execute('print(false or 99);').output).toEqual(['99'])
    expect(execute('print("有" and "后值");').output).toEqual(['后值'])
    // 短路：右侧不执行
    expect(execute('var x = 0; false and (x = 5); print(x);').output).toEqual(['0'])
  })
})

describe('变量与作用域', () => {
  it('声明、遮蔽与恢复', () => {
    const src = `
      var x = "外层";
      {
        var x = "内层";
        print(x);
      }
      print(x);
    `
    expect(execute(src).output).toEqual(['内层', '外层'])
  })

  it('块内赋值作用于外层变量', () => {
    const src = `
      var n = 1;
      {
        n += 10;
      }
      print(n);
    `
    expect(execute(src).output).toEqual(['11'])
  })

  it('未定义变量报错', () => {
    const r = execute('print(不存在);')
    expect(r.error).toMatchObject({ phase: 'runtime', message: "未定义的变量 '不存在'" })
  })
})

describe('控制流', () => {
  it('if/else 与嵌套', () => {
    const src = `
      var score = 85;
      if (score >= 90) {
        print("优");
      } else if (score >= 80) {
        print("良");
      } else {
        print("加油");
      }
    `
    expect(execute(src).output).toEqual(['良'])
  })

  it('while 与 break/continue', () => {
    const src = `
      var i = 0;
      var sum = 0;
      while (true) {
        i += 1;
        if (i > 10) {
          break;
        }
        if (i % 2 == 0) {
          continue;
        }
        sum += i;
      }
      print(sum);
    `
    expect(execute(src).output).toEqual(['25'])
  })

  it('for 循环与 range', () => {
    const src = `
      var total = 0;
      for (var i = 1; i <= 100; i += 1) {
        total += i;
      }
      print(total);
      for (var n in []) {}
    `.replace('for (var n in []) {}', 'print(len(range(2, 10, 2)));')
    expect(execute(src).output).toEqual(['5050', '4'])
  })

  it('for 的循环变量不泄漏', () => {
    const src = `
      for (var i = 0; i < 3; i += 1) {}
      print(i);
    `
    const r = execute(src)
    expect(r.error).toMatchObject({ phase: 'runtime' })
  })
})

describe('函数与闭包', () => {
  it('递归：斐波那契', () => {
    const src = `
      fn fib(n) {
        if (n < 2) return n;
        return fib(n - 1) + fib(n - 2);
      }
      print(fib(10));
    `
    expect(execute(src).output).toEqual(['55'])
  })

  it('闭包：计数器', () => {
    const src = `
      fn makeCounter() {
        var count = 0;
        fn increment() {
          count += 1;
          return count;
        }
        return increment;
      }
      var a = makeCounter();
      var b = makeCounter();
      a();
      a();
      print(a());
      print(b());
    `
    expect(execute(src).output).toEqual(['3', '1'])
  })

  it('函数是一等公民', () => {
    const src = `
      fn add(a, b) { return a + b; }
      fn twice(f, v) { return f(f(v)); }
      print(twice(fn(x) { return x * 3; }, 2));
      var ops = [add];
      print(ops[0](1, 2));
    `
    expect(execute(src).output).toEqual(['18', '3'])
  })

  it('没有 return 的函数返回 nil', () => {
    expect(execute('fn f() {}\nprint(f());').output).toEqual(['nil'])
  })

  it('参数个数不匹配报错', () => {
    const r = execute('fn f(a, b) {}\nf(1);')
    expect(r.error).toMatchObject({ phase: 'runtime', line: 2 })
    expect(r.error!.message).toContain('需要 2 个参数，收到 1 个')
  })

  it('调用非函数报错', () => {
    const r = execute('var x = 1;\nx();')
    expect(r.error).toMatchObject({ phase: 'runtime' })
    expect(r.error!.message).toContain('不是函数')
  })
})

describe('数组与 map', () => {
  it('数组读写与 push/pop', () => {
    const src = `
      var a = [1, 2];
      a[0] = 10;
      push(a, 3);
      print(a);
      print(pop(a), len(a));
    `
    expect(execute(src).output).toEqual(['[10, 2, 3]', '3 2'])
  })

  it('map 读写、点号语法、keys/values/has', () => {
    const src = `
      var m = {name: "茶", version: 1};
      m["author"] = "我";
      m.dot = "点号也行";
      print(m.name, m["author"], m.dot);
      print(has(m, "name"), has(m, "nope"));
      print(len(keys(m)), len(values(m)));
      print(m.missing);
    `
    expect(execute(src).output).toEqual([
      '茶 我 点号也行',
      'true false',
      '4 4',
      'nil',
    ])
  })

  it('深层相等', () => {
    expect(execute('print([1, [2, 3]] == [1, [2, 3]]);').output).toEqual(['true'])
    expect(execute('print({a: 1} == {a: 1});').output).toEqual(['true'])
    expect(execute('print([1] == [2]);').output).toEqual(['false'])
  })

  it('数组越界赋值/读取报错', () => {
    expect(execute('var a = [1];\na[5] = 2;').error).toMatchObject({ phase: 'runtime', line: 2 })
    expect(execute('var a = [1];\nprint(a[1]);').error).toMatchObject({ phase: 'runtime' })
  })

  it('类型不匹配的下标操作报错', () => {
    expect(execute('var n = 1;\nn[0] = 2;').error).toMatchObject({ phase: 'runtime' })
  })
})

describe('内建函数', () => {
  it('type / num / floor / abs', () => {
    expect(execute('print(type(1), type("s"), type(nil), type(true), type([1]), type({}), type(print));').output).toEqual([
      'number string nil bool array map function',
    ])
    expect(execute('print(num("42") + 1, num("x"));').output).toEqual(['43 nil'])
    expect(execute('print(floor(3.7), abs(-2));').output).toEqual(['3 2'])
  })

  it('range 三种用法', () => {
    expect(execute('print(range(4));').output).toEqual(['[0, 1, 2, 3]'])
    expect(execute('print(range(1, 5));').output).toEqual(['[1, 2, 3, 4]'])
    expect(execute('print(range(5, 1, -2));').output).toEqual(['[5, 3]'])
  })

  it('clock 返回数字', () => {
    const r = execute('print(type(clock()));')
    expect(r.output).toEqual(['number'])
  })
})

describe('错误定位与结构化返回', () => {
  it('运行时错误带行号', () => {
    const r = execute('var a = 1;\nprint(a + "x");')
    expect(r.error).toMatchObject({ phase: 'runtime', line: 2 })
    expect(r.error!.message).not.toContain('[line')
  })

  it('解析错误带阶段与位置', () => {
    const r = execute('var = 1;')
    expect(r.error).toMatchObject({ phase: 'parse', line: 1 })
  })

  it('resolver 错误：return 在函数外 / break 在循环外 / 重复声明 / 声明前使用', () => {
    expect(execute('return 1;').error).toMatchObject({ phase: 'resolve', message: /return 只能出现在函数里/ })
    expect(execute('break;').error).toMatchObject({ phase: 'resolve' })
    expect(execute('var a = 1;\nvar a = 2;').error).toMatchObject({ phase: 'resolve', message: /已经有名为 'a'/ })
    expect(execute('var x = x;').error).toMatchObject({ phase: 'resolve', message: /声明前不可使用/ })
  })

  it('正常结束后没有 error', () => {
    expect(execute('print("ok");').error).toBeUndefined()
  })
})

describe('示例程序（集成）', () => {
  it('fizzbuzz', () => {
    const src = `
      for (var i = 1; i <= 15; i += 1) {
        if (i % 15 == 0) {
          print("FizzBuzz");
        } else if (i % 3 == 0) {
          print("Fizz");
        } else if (i % 5 == 0) {
          print("Buzz");
        } else {
          print(i);
        }
      }
    `
    const out = execute(src).output
    expect(out[0]).toBe('1')
    expect(out[2]).toBe('Fizz')
    expect(out[4]).toBe('Buzz')
    expect(out[14]).toBe('FizzBuzz')
    expect(out).toHaveLength(15)
  })

  it('汉诺塔', () => {
    const src = `
      var steps = 0;
      fn hanoi(n, from, to, via) {
        if (n == 0) return;
        hanoi(n - 1, from, via, to);
        steps += 1;
        hanoi(n - 1, via, to, from);
      }
      hanoi(5, "A", "C", "B");
      print(steps);
    `
    expect(execute(src).output).toEqual(['31'])
  })
})
