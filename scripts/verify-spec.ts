/**
 * 工具参数规格（src/tools/spec.ts）专套 —— 一份定义能不能真的派生出三样东西。
 *
 * 背景（改造前的实测，2026-09-06）：
 *   同一套参数规则在项目里写了两遍，且**没有任何机制保证一致**：
 *     ① 发给 LLM 的单子：builtin.ts 里 6 份 parameters（JSON Schema）
 *     ② 运行时的柜员审核：14 处校验件调用（requireString ×7、requireStringAllowEmpty ×1、
 *        optionalString ×3、optionalPositiveInt ×3）+ 1 处手写 boolean 强转（edit 的 replaceAll）
 *   两者之间唯一的纽带是**人手把同一个词打了多遍**：grep 的 'pattern' 在这一个工具里出现 7 次，
 *   其中 4 处是协议性的（文案 1、对象属性名 1、字符串字面量 2），而 TS 一处都不检查
 *   —— requireString 的 key 形参类型是 string，什么都能塞。把它写成 'patern'（漏一个 t），
 *   编译通过、测试不红，只在运行时让模型收到一句"patern 是必填参数"而它手上的单子写的是 pattern。
 *
 *   更硬的证据：registry.execute() 改前只有 3 行，tool.parameters 一个字段都没读。
 *   实测造一个 parameters 声明 required: ['mustHave'] 的工具，然后①什么都不传
 *   ②传一个对象 ③传 Schema 里根本不存在的参数名——三次全部返回 [OK]。
 *   所以那份单子改前的身份是"给模型的建议书"，不是契约。
 *
 * 手写校验的四个盲区（② 段逐条钉）：
 *   requireString 里的 `const str = String(val)` 是**永远通过的校验**：传 123 / {a:1} /
 *   ['src'] / true 全部通过，被强转成 "123" / "[object Object]" / "src" / "true"，
 *   然后在**文件系统层**才失败并报 [NOT_FOUND] / [NOT_FILE]——错误归因错到另一层，
 *   模型会以为是自己路径写错而开始猜路径（与 grep 那个 bug 同构）。
 *
 * 本套是**先行断言**：写它的时候 src/tools/spec.ts 还不存在，所以 ①②③⑤⑥ 段应当全红，
 * 而 ④ 段（Schema 逐字未变）应当全绿——它是护栏，钉的是"收敛源头不许顺手改契约"。
 * 用动态 import + 兜底而不是静态 import，是为了让它**红**而不是**崩**：
 * 崩了看不到红在哪，也就无法确认"红得对"。
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-spec.ts
 *      （npm run verify 会自动发现本文件，无需登记）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolRegistry } from '../src/tools/registry.js';
import { registerBuiltinTools } from '../src/tools/builtin.js';

/* ── 断言 ── */

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ── 被测件：动态装载，不存在时全套红而不是崩 ── */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let S: any = null;
try {
  S = await import('../src/tools/spec.js');
} catch {
  S = null; // 尚未实现：下面的断言会逐条红，这正是先行断言要的样子
}
check('S0 src/tools/spec.ts 存在且可装载', S !== null, S === null ? '模块还没建' : undefined);

/* ── 本套自带的三份样例规格：用构造器现搭，不从生产源码导入现成样本 ──
   理由：测试样本是测试的私产，塞进 spec.ts 当导出物就是污染，还会让人误以为它是 API 的一部分。
   现搭顺带把构造器本身也测了——构造器没导出或签名不对，这里立刻崩，比断言红更早暴露。
   S 为 null（spec.ts 还没建）时三份样本都是 null，下面各段**逐条红**而不是崩。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const demo: any = S ? { who: S.str('姓名', '一个人的名字'), age: S.optPosInt('年龄', '岁数', 18) } : null;
// 对照组：只在 demo 上覆盖 age 一个键（可选正整数 → 必填字符串），看两个派生物是否**同时**跟着变
const demoStrict: any = demo ? { ...demo, age: S.str('年龄', '岁数') } : null;
const demoAllowEmpty: any = S
  ? { body: S.strAllowEmpty('正文', '一段正文', '（删除内容请显式传空字符串）') }
  : null;

/* ── ① 同源：一份定义派生出三样，改一处三处同时变 ── */

console.log('\n① 同源性（这是整个框架的唯一卖点：规则只写一遍）');
{
  check('1-1 能用构造器搭出一份最小规格（str / optPosInt 都导出且可调用）',
    demo !== null && typeof demo === 'object',
    demo === null ? 'spec 未实现，或构造器没导出' : undefined);

  if (demo) {
    const schema = S.toJsonSchema(demo);
    // demoSpec 约定为：{ who: 必填字符串, age: 可选正整数默认 18 }
    check('1-2 required 名单 = 标了必填的字段，且按声明顺序（verify-edit A3 钉死了顺序敏感）',
      JSON.stringify(schema?.required) === JSON.stringify(['who']),
      JSON.stringify(schema?.required));
    check('1-3 properties 的键集与顺序 = spec 的键集与顺序',
      JSON.stringify(Object.keys(schema?.properties ?? {})) === JSON.stringify(['who', 'age']),
      JSON.stringify(Object.keys(schema?.properties ?? {})));
    check('1-4 每个 property.type = 对应字段的 kind（可选正整数在 Schema 里是 number，与现状逐字一致）',
      schema?.properties?.who?.type === 'string' && schema?.properties?.age?.type === 'number',
      JSON.stringify(schema?.properties));
    check('1-5 可选字段缺省时 parse 填默认值（不是 undefined）',
      S.parseSpec(demo, { who: 'x' })?.age === 18,
      JSON.stringify(S.parseSpec(demo, { who: 'x' })));

    // 对照组：只改 spec 里 age 这一处，Schema 与 parse 必须**同时**变。
    // 没有这一条，"同源"可以被实现成"两份各自硬编码但恰好一致"而全绿——那正是改造前的病。
    check('1-6 对照组存在：age 一处被改成必填字符串（demoStrict 只覆盖这一个键）',
      demoStrict !== null, '没有对照组，同源性就无法被证明（只能证明"恰好一致"）');
    if (demoStrict) {
      const s2 = S.toJsonSchema(demoStrict);
      check('1-7 派生物① Schema 跟着变：required 多出 age，且 age 的 type 从 number 变成 string',
        JSON.stringify(s2?.required) === JSON.stringify(['who', 'age']) && s2?.properties?.age?.type === 'string',
        JSON.stringify(s2));
      let threw = false;
      try { S.parseSpec(demoStrict, { who: 'x' }); } catch { threw = true; }
      check('1-8 派生物② parse 跟着变：缺 age 从此报错（改前它是可选的）', threw === true);
      let threwType = false;
      try { S.parseSpec(demoStrict, { who: 'x', age: 18 }); } catch { threwType = true; }
      check('1-8b 且变的是**类型**不只是必填性：原先合法的 18 现在也被拒（age 已声明成字符串）',
        threwType === true);
    }

    check('1-9 多余参数被拒（改造前静默忽略：{pathh:"typo"} 会返回 [OK]）',
      (() => { try { S.parseSpec(demo, { who: 'x', whoever: 'typo' }); return false; } catch { return true; } })());
  }
}

/* ── ② 四个盲区：String(val) 那个永远通过的校验 ── */

console.log('\n② 类型盲区全堵（改前 String(val) 让这四样全部通过）');
{
  if (demo) {
    const rejects = (val: unknown): boolean => {
      try { S.parseSpec(demo, { who: val }); return false; } catch { return true; }
    };
    check('2-1 传数字 123 → 拒（改前强转成 "123"，然后在文件系统层才报 [NOT_FOUND]）', rejects(123));
    check('2-2 传对象 {a:1} → 拒（改前强转成 "[object Object]"）', rejects({ a: 1 }));
    check('2-3 传数组 ["src"] → 拒（改前强转成 "src"，看着完全像个合法路径）', rejects(['src']));
    check('2-4 传布尔 true → 拒（改前强转成 "true"）', rejects(true));
    // 对照组：闸门不能焊死。合法值必须照常通过，否则 2-1~2-4 可以被"一律抛错"实现
    check('2-5 对照组：合法字符串照常通过（不是把闸门焊死）',
      S.parseSpec(demo, { who: 'src/tools' })?.who === 'src/tools');
    check('2-6 对照组：合法数字给 number 字段照常通过',
      S.parseSpec(demo, { who: 'x', age: 3 })?.age === 3);
    check('2-7 数字字符串给 number 字段仍宽容接受（模型常这么传，改前 Number(val) 也接受）',
      S.parseSpec(demo, { who: 'x', age: '3' })?.age === 3);
  } else {
    for (let i = 1; i <= 7; i++) check(`2-${i} （跳过：无 demoSpec）`, false, 'spec 未实现');
  }
}

/* ── ③ 错误文案逐字不变（护栏：不许借改造之机改文案，14 处调用点的文案有断言钉着）── */

console.log('\n③ 错误文案逐字保持（现有 41+74 项断言钉着这些字符串）');
{
  if (demo) {
    const msg = (args: Record<string, unknown>, spec = demo): string => {
      try { S.parseSpec(spec, args); return '(没报错)'; } catch (e) { return (e as Error).message; }
    };
    check('3-1 缺必填 → "姓名 (who) 是必填参数"', msg({}) === '姓名 (who) 是必填参数', msg({}));
    check('3-2 必填给空串 → "姓名 (who) 不能为空"', msg({ who: '  ' }) === '姓名 (who) 不能为空', msg({ who: '  ' }));
    check('3-3 非正整数 → "年龄 (age) 必须是正整数"',
      msg({ who: 'x', age: 0 }) === '年龄 (age) 必须是正整数', msg({ who: 'x', age: 0 }));
    check('3-4 strAllowEmpty 构造器存在（edit 的 newText 靠它：空串=删除，是合法意图）',
      demoAllowEmpty !== null);
    if (demoAllowEmpty) {
      check('3-5 allowEmpty 缺参的文案带那句括号提示（逐字，提示语是构造器的第三个入参）',
        msg({}, demoAllowEmpty) === '正文 (body) 是必填参数（删除内容请显式传空字符串）',
        msg({}, demoAllowEmpty));
      check('3-6 allowEmpty 传空串合法（不能当缺参拒绝，否则 edit 无法删内容）',
        S.parseSpec(demoAllowEmpty, { body: '' })?.body === '');
    }
  } else {
    for (let i = 1; i <= 6; i++) check(`3-${i} （跳过：无 demoSpec）`, false, 'spec 未实现');
  }
}

/* ── ④ 护栏：7 个工具发给 LLM 的 Schema 逐字未变 ── */

console.log('\n④ 护栏：发给 LLM 的 Schema 逐字未变（基线是改造前机器导出的快照，不是手打的）');
{
  const registry = new ToolRegistry();
  registerBuiltinTools(registry);
  const actual: Record<string, unknown> = {};
  for (const t of registry.getLLMTools()) actual[t.function.name] = t.function.parameters;

  const baselinePath = path.join(ROOT, 'scripts', 'fixtures', 'tool-schemas-baseline.json');
  check('4-0 基线 fixture 存在（scripts/fixtures/tool-schemas-baseline.json）', fs.existsSync(baselinePath));
  if (fs.existsSync(baselinePath)) {
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8')) as Record<string, unknown>;
    for (const name of Object.keys(baseline)) {
      check(`4-${name} ${name} 的 parameters 与改造前逐字相同`,
        JSON.stringify(actual[name]) === JSON.stringify(baseline[name]),
        JSON.stringify(actual[name])?.slice(0, 120));
    }
    check('4-count 工具数 21（6 个旧工具基线逐字未变 + todo + memory/record_event/search_events + pull_events + ask + archive + git + git_write + symbols + refs + spawn + task + trash + note_search）', Object.keys(actual).length === 21,
      String(Object.keys(actual).length));
  }
}

/* ── ⑤ 手写取参的动作消失了（源码断言：钉手段，因为行为面已被 ②③⑥ 覆盖）── */

console.log('\n⑤ 源码形状：4 个校验件（定义+调用共 18 处）整体消失；手写 boolean 强转 2 → 1');
{
  const builtinSrc = fs.readFileSync(path.join(ROOT, 'src/tools/builtin.ts'), 'utf-8');
  // 口径：**只数代码行**，剔掉整行注释（`//`、块注释的 `/*` 与 ` * `）。不用"截到第一个 //"
  // 那种粗糙剥法：它会把 description 里 "C:/Users/name/project" 的后半句当注释吃掉，造出假阴性。
  // 但这层剔法**不完整**，别拿它当万能：块注释里折行的续行（builtin.ts 顶部就有：那句散文引用
  // 从上一行折到行首、既不以 `*` 也不以 `//` 开头）剔不掉。所以 5-5 不依赖它，而是按项目既有
  // 手法**先切段再断言**（verify-tools.ts ⑦ 段同一手法；裸扫全文件被注释散文误伤这坑已踩过两次）
  const codeOnly = builtinSrc.split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
  const count = (re: RegExp): number => (codeOnly.match(re) ?? []).length;

  // 钉的是**标识符整体消失**，不是"调用为 0"：下面的正则连函数定义行一起匹配
  // （`function requireString(args...` 也算一处），所以期望 0 的含义是"这四个校验件从 builtin.ts
  // 整体删掉"——留着不用的定义就是死代码。名字里的处数是本轮**实测**的：我早先说的
  // "8 处撬参数"只是 requireString 家族，加上 optionalString / optionalPositiveInt 是 14 处调用 + 4 处定义。
  check('5-1 requireString 整体消失（改前 8 处 = 1 定义 + 7 调用）', count(/\brequireString\(/g) === 0,
    `实际 ${count(/\brequireString\(/g)} 处`);
  check('5-2 requireStringAllowEmpty 整体消失（改前 2 处 = 1 定义 + 1 调用）',
    count(/requireStringAllowEmpty\(/g) === 0, `实际 ${count(/requireStringAllowEmpty\(/g)} 处`);
  check('5-3 optionalString 整体消失（改前 4 处 = 1 定义 + 3 调用）',
    count(/optionalString\(/g) === 0, `实际 ${count(/optionalString\(/g)} 处`);
  check('5-4 optionalPositiveInt 整体消失（改前 4 处 = 1 定义 + 3 调用）',
    count(/optionalPositiveInt\(/g) === 0, `实际 ${count(/optionalPositiveInt\(/g)} 处`);
  // 改前 2 处：handler 里 1 + permissionDetail 里 1。后者拿的是**未经 parse 的原始 args**
  //（权限确认发生在 execute 之前，那时还没校验），消不掉。
  // 切 edit 段、再按第一个 `handler:` 分界，于是断言能**分开**说两件事：handler 区必须 0 处、
  // handler 之前（permissionDetail 区）必须 1 处——比"全文数到 1"更贴名字，也顺手把顶部注释里
  // 那句逐字引用排除在段外（本轮实测：不切段时数到 2，多出的那处是散文，不是代码）
  const editSeg = codeOnly.slice(codeOnly.indexOf("name: 'edit'"), codeOnly.indexOf("name: 'grep'"));
  const atHandler = editSeg.indexOf('handler:');
  const booleans = (s: string): number => (s.match(/String\(args\.replaceAll\)/g) ?? []).length;
  const inDetail = booleans(editSeg.slice(0, atHandler));
  const inHandler = booleans(editSeg.slice(atHandler));
  check('5-5 手写 boolean 强转在 handler 区消失（0 处）、permissionDetail 区保留那 1 处（拿原始 args，消不掉）',
    atHandler > 0 && inHandler === 0 && inDetail === 1,
    `handler 区 ${inHandler} 处 / permissionDetail 区 ${inDetail} 处（切段失败时 atHandler=${atHandler}）`);

  // 'pattern' 的协议性副本，口径是**带引号的字面量 + 行首属性名**（不含 description 文案里的裸词，
  // 那个派生不出来、且写错只会让模型误解不会让代码坏）：改前 3 处 = required 里 1 + requireString 里 1
  // + properties 属性名 1；改后只剩 spec 里的属性名 1 处
  const grepSeg = codeOnly.slice(codeOnly.indexOf("name: 'grep'"), codeOnly.indexOf("name: 'bash'"));
  const protoCopies = (grepSeg.match(/'pattern'/g) ?? []).length + (grepSeg.match(/^\s*pattern:/gm) ?? []).length;
  check('5-6 grep 段里 pattern 的协议性副本从 3 处降到 1 处', protoCopies === 1, `实际 ${protoCopies} 处`);

  // 契约面：parse 是**可选**成员。这条钉的是手段（声明形状），不是编译会不会红——本轮实测：
  // 把它改成必需成员，tsc --noEmit 仍 0 错误。两个原因：全项目只有 defineTool 一处构造
  // ToolDefinition；而 9 处替身实现的是 ToolProvider（parse 不在这个接口上），且 scripts/ 不在
  // tsconfig 的 include 里、根本不受类型检查。所以旧名字里那句"必需成员会打坏 7 处替身"
  // 是从 permissionKey 那轮抄来的，对 parse 不成立，连同数字一起改掉（铁律：改断言连名字一起改）。
  // 可选依然值得钉：真正的代价在以后——必需成员会逼每一个手写工具都编一个恒等 parse
  const coreSrc = fs.readFileSync(path.join(ROOT, 'src/core/tools.ts'), 'utf-8');
  check('5-7 ToolDefinition.parse 声明为**可选**成员（手段断言：实测改成必需 tsc 也 0 错，代价在以后每个手写工具都得编恒等 parse）',
    /parse\?\s*:/.test(coreSrc), '没找到 parse?:');
}

/* ── ⑥ 接线证明：execute 真的会跑 parse（防"支持但未接线"，项目已有三处前科）── */

console.log('\n⑥ 接线证明（parse 写出来却没人调 = 白写；本项目前科：runtime.onInput / tool_calls 持久化 / clear()）');
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsagent-verify-spec-'));
  const registry = new ToolRegistry();
  registerBuiltinTools(registry);
  fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'export const x = 1;\n');

  // execute 现在返回结构化 ToolResult；helper 解包出模型可见文本，下面的断言不动
  const run = async (args: Record<string, unknown>): Promise<string> =>
    (await registry.execute('grep', args)).content;

  check('6-1 缺 pattern 仍报 [INVALID]（改前就绿：handler 里 requireString 拦的；改后必须由 parse 拦）',
    (await run({})).startsWith('[INVALID]'), (await run({})).slice(0, 60));
  check('6-2 传数字当 pattern → [INVALID]（改前是 [NOT_FOUND]/[NO_MATCH]，错误归因在另一层）',
    (await run({ pattern: 123, path: tmpDir })).startsWith('[INVALID]'),
    (await run({ pattern: 123, path: tmpDir })).slice(0, 60));
  check('6-3 多余参数 → [INVALID]（改前静默忽略并返回 [OK]）',
    (await run({ pattern: 'x', pathh: 'typo' })).startsWith('[INVALID]'),
    (await run({ pattern: 'x', pathh: 'typo' })).slice(0, 60));
  const ok = await run({ pattern: 'export const x', path: tmpDir });
  check('6-4 对照组：合法调用照常命中（接线不能把正常路径也拦掉）',
    ok.startsWith('[OK]') && ok.includes('a.ts:1'), ok.slice(0, 80));
  check('6-5 parse 抛的是 ToolInputError 而不是别的（execute 靠它决定报 [INVALID] 还是让异常穿透）',
    demo !== null && (() => { try { S.parseSpec(demo, {}); return false; } catch (e) { return (e as Error).name === 'ToolInputError'; } })(),
    demo === null ? 'spec 未实现' : undefined);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  check('Z1 临时目录已清理', !fs.existsSync(tmpDir));
}

// 结果行的格式是 run-verify.mjs 的**解析契约**（/结果[：:]\s*(\d+)\s*通过.../），不是自由文案
console.log(`\n结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
process.exit(failed > 0 ? 1 : 0);
