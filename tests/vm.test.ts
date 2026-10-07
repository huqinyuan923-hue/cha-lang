import { describe, expect, it } from 'vitest'
import { run, runVM } from '../src/index'
import { disassemble } from '../src/chunk'
import { compile } from '../src/compiler'
import { parse } from '../src/parser'

/**
 * 差分断言：字节码 VM 的输出与错误必须和树遍历解释器完全一致。
 * 树遍历器是参照实现——它的行为就是语言规范。
 */
const diff = (src: string) => {
  const tree = run(src)
  const vm = runVM(src)
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

describe('VM 专属：字节码与反汇编', () => {
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
      diff(readFileSync(join(dir, file), 'utf-8'))
    }
  })
})
