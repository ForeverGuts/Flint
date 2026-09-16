/**
 * grep 与 bash 两个工具的功能专套 —— 它们返回给模型的文本，是不是真的。
 *
 * 背景：TESTING.md 第七节长期记着"ls/read/write/grep/bash 五个工具无直接断言"。
 *       verify-permission.ts 只问它们"授权键是什么、弹窗文案是什么"，不问干活对不对。
 *       本轮真去问了一遍，查出两个**当前就在发生**的缺陷（都在中文 Windows 上实测）：
 *
 *   ① grep 完全不可用，而且它撒谎。改前拼的是 POSIX 串
 *      `grep -rn --binary-files=without-match ... 2>/dev/null | head -50`，
 *      而 Windows 上 execSync 走 cmd.exe：grep 不存在、2>/dev/null 被当成路径。
 *      实测搜一个**确实存在**的符号与搜一个绝不存在的串，返回**一模一样**的
 *      [NO_MATCH]。而 agent-loop 把 NO_MATCH 归为"有效否定（不计失败）"，
 *      于是模型会据此认为"这个项目里没有 permissionKey"，且收不到任何警告、
 *      不触发重复失败保护。这比乱码严重：它让模型对代码库形成错误认知。
 *
 *   ② bash 硬编码 GBK 解码，对外部程序的中文输出全乱码。进程之间传的是字节，
 *      字节不带"我是谁的编码"这个属性，而**谁产生的输出决定编码**：cmd.exe 内建
 *      命令走控制台代码页（中文 Windows = 936/GBK），外部程序（node/npm/git/tsc）
 *      走自己的编码（通常 UTF-8）。实测 `node -e "console.log('编译通过')"`
 *      改前返回"缂栬瘧閫氳繃"——而模型正是靠这段文本判断编译结果的。
 *
 * 三段承重设计（改代码前请先读，别"顺手修好"）：
 *   ① 失败分类是契约，不是文案。agent-loop 把 [ERROR]/[VERIFY_FAILED]/[INVALID] 记作失败
 *      （2026-09-05 起 [INVALID] 也计入：参数不合法时原样重试必然再错），
 *      NOT_FOUND/NO_MATCH/EMPTY 属"有效否定"不计失败。所以"命令跑不起来"必须报
 *      [ERROR]，报成 [NO_MATCH] 等于关掉重复失败保护（⑥ 段有双向源码断言钉住）。
 *   ② 解码顺序不能反：必须先 UTF-8 严格解（fatal: true）、失败再退代码页。
 *      反过来先试 GBK 的话，因为 GBK 字符集覆盖面极大（几乎所有双字节组合都"合法"），
 *      UTF-8 的中文字节会被 GBK 静默解成另一串合法汉字——不报错、只是错。
 *   ③ 行数与字符数一律按**截断前**的原文算。改前 bash 的 lineCount 取截断后的串、
 *      而"共 N 字符"取截断前的数，同一句话里两个数一前一后自相矛盾，
 *      输出一万行被截到 4000 字符时标签显示"(50 行输出)"。
 *
 * 平台说明：④ 段的 GBK 分支只在 win32 有意义（cmd.exe 内建命令才走代码页），
 *           非 Windows 下走 else 分支断言 POSIX 侧的对应事实，两分支项数相同，
 *           所以本套的总项数与平台无关。
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-tools.ts
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

/* ── 真件：用生产用的 ToolRegistry，不打桩 ── */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsagent-verify-tools-'));
const registry = new ToolRegistry();
registerBuiltinTools(registry);

// execute 现在返回结构化 ToolResult；本地 helper 统一解包出模型可见文本，断言不动
const grep = async (args: Record<string, unknown>): Promise<string> =>
  (await registry.execute('grep', args)).content;
const bash = async (args: Record<string, unknown>): Promise<string> =>
  (await registry.execute('bash', args)).content;
const IS_WIN = process.platform === 'win32';

const builtinSrc = fs.readFileSync(path.join(ROOT, 'src/tools/builtin.ts'), 'utf-8');
const loopSrc = fs.readFileSync(path.join(ROOT, 'src/loop/agent-loop.ts'), 'utf-8');
const coreSrc = fs.readFileSync(path.join(ROOT, 'src/core/tools.ts'), 'utf-8');

/* ── 测试用的真目录树 ── */

fs.mkdirSync(path.join(tmpDir, 'sub'), { recursive: true });
fs.mkdirSync(path.join(tmpDir, 'node_modules'), { recursive: true });
fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });

// 正斜杠路径：grep 内部会把 \ 归一成 /，断言按归一化后的形态比
const T = tmpDir.replace(/\\/g, '/');

fs.writeFileSync(path.join(tmpDir, 'a.ts'), [
  'export const permissionKey = 1;',   // 第 1 行
  '// 中文注释一行',                    // 第 2 行
  'const permissionDetail = 2;',       // 第 3 行
].join('\n'));
fs.writeFileSync(path.join(tmpDir, 'b.js'), 'var permissionKey = 3;\n');
fs.writeFileSync(path.join(tmpDir, 'c.txt'), '第一行\npermissionKey 在第二行\n第三行\n');
fs.writeFileSync(path.join(tmpDir, 'sub', 'd.ts'), 'sub permissionKey\n');
fs.writeFileSync(path.join(tmpDir, 'node_modules', 'e.ts'), 'SHOULD_BE_SKIPPED permissionKey\n');
fs.writeFileSync(path.join(tmpDir, '.git', 'f.ts'), 'SHOULD_BE_SKIPPED permissionKey\n');
// 二进制：含 NUL，且故意也含目标串——若不跳过它会贡献一条乱码命中
fs.writeFileSync(path.join(tmpDir, 'bin.dat'), Buffer.concat([
  Buffer.from('permissionKey\x00\x01\x02binary', 'utf-8'),
]));
// 超大文件：>2MB，且含目标串——若不跳过会拖慢搜索
fs.writeFileSync(path.join(tmpDir, 'big.ts'), 'x'.repeat(2 * 1024 * 1024 + 10) + '\npermissionKey\n');
// 命中上限：60 行，每行都含目标串
fs.writeFileSync(path.join(tmpDir, 'many.ts'), Array.from({ length: 60 }, (_, i) => `HITCAP line ${i}`).join('\n'));

// bash 用的辅助脚本：不靠 shell 引号传递代码，避免 cmd.exe / sh 的引号规则差异
const emit = path.join(tmpDir, 'emit.js');
fs.writeFileSync(emit, [
  "const a = process.argv[2];",
  "if (a === 'cn') console.log('编译通过');",
  "if (a === 'lines') { for (let i = 0; i < 1000; i++) console.log('line' + i); }",
  "if (a === 'big') process.stdout.write('x'.repeat(5 * 1024 * 1024));",
  "if (a === 'fail') { console.error('这是标准错误输出'); process.exit(3); }",
  "if (a === 'cwd') console.log(process.cwd());",
  "if (a === 'quiet') { /* 刻意无输出 */ }",
].join('\n'));
const run = (arg: string): Promise<string> => bash({ command: `node "${emit}" ${arg}` });

/* ══════════════════════════════════════════════════════════════════════════
   ① grep：真遍历、真行号、真跨平台
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n① grep 跨平台真遍历（改前在 Windows 上任何调用都失败）');
{
  const ok = await grep({ pattern: 'permissionKey', path: T });
  check('A1 搜一个确实存在的串返回 [OK]（改前返回 [NO_MATCH]）', ok.startsWith('[OK]'), ok.slice(0, 120));
  check('A2 命中格式是 路径:行号:内容，模型能直接定位', /a\.ts:1:export const permissionKey/.test(ok), ok.slice(0, 200));
  // 行号要单独搜一个只出现一次、且不在首行的串才验得出来：
  // 搜 permissionKey 时 a.ts 命中的是第 1 行，报 1 与"恒报 1"分不开
  const lineNo = await grep({ pattern: 'permissionDetail', path: `${T}/a.ts` });
  check('A3 行号是真的（permissionDetail 在第 3 行就报 3，不是从 0 数也不是恒为 1）',
    /a\.ts:3:const permissionDetail = 2;/.test(lineNo), lineNo.slice(0, 140));
  check('A4 递归进子目录（sub/d.ts 也命中）', /sub\/d\.ts:1:/.test(ok));
  check('A5 命中数与实际相符（a.ts×2 + b.js + c.txt + sub/d.ts + many? 不含 = 4 处）',
    /找到 4 处匹配/.test(ok), ok.split('\n')[0]);
  check('A6 跳过 node_modules（那条命中不出现）', !ok.includes('SHOULD_BE_SKIPPED'));
  check('A7 跳过 .git（同上）', !ok.includes('/.git/'));
  check('A8 跳过二进制文件，且统计里写明跳过了几个', /跳过 1 个二进制/.test(ok), ok.split('\n')[0]);
  check('A9 跳过 >2MB 的超大文件，且统计里写明', /跳过 1 个超大文件/.test(ok));
  check('A10 统计里报出真扫了几个文件（模型据此区分"确实没有"与"全被过滤了"）',
    /已扫 \d+ 个文件/.test(ok));

  const cn = await grep({ pattern: '中文注释', path: T });
  check('A11 中文内容搜得到、且不乱码', /a\.ts:2:\/\/ 中文注释一行/.test(cn), cn.slice(0, 160));

  const single = await grep({ pattern: 'permissionKey', path: `${T}/b.js` });
  check('A12 path 指向单个文件时只搜该文件', single.startsWith('[OK]') && !single.includes('a.ts'), single.slice(0, 140));

  const bs = await grep({ pattern: 'permissionKey', path: tmpDir });
  check('A13 反斜杠路径也能用（Windows 习惯写法，内部归一化）', bs.startsWith('[OK]') && /a\.ts:1:/.test(bs));
}

/* ══════════════════════════════════════════════════════════════════════════
   ② grep 诚实性：跑不起来 / 真没有 / 我写错了 —— 三者必须分开
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n② grep 诚实性（改前把三者全报成 [NO_MATCH]）');
{
  const none = await grep({ pattern: 'ZZZ_绝不存在的串_ZZZ', path: T });
  check('B1 真没有匹配时报 [NO_MATCH]', none.startsWith('[NO_MATCH]'), none.slice(0, 100));
  check('B2 [NO_MATCH] 里带上扫了多少文件（否则模型无法区分"没有"与"没搜到"）',
    /已扫 \d+ 个文件/.test(none));
  check('B3 [NO_MATCH] 里回显了模式与范围', none.includes('ZZZ_绝不存在的串_ZZZ') && none.includes('a.ts') === false);

  const bad = await grep({ pattern: 'function\\s+((((', path: T });
  check('B4 坏正则报 [INVALID]（"我写错了"）', bad.startsWith('[INVALID]'), bad.slice(0, 120));
  check('B5 坏正则**不**冒充 [NO_MATCH]（改前正是这个洞：模型会以为项目里没有）',
    !bad.startsWith('[NO_MATCH]'));
  check('B6 坏正则的报错里带上编译失败的原因，模型能自己改对', /正则无法编译/.test(bad) && bad.length > 30);

  const noPath = await grep({ pattern: 'permissionKey', path: `${T}/不存在的目录` });
  check('B7 路径不存在报 [NOT_FOUND]', noPath.startsWith('[NOT_FOUND]'), noPath.slice(0, 100));
  check('B8 路径不存在也**不**冒充 [NO_MATCH]', !noPath.startsWith('[NO_MATCH]'));

  const noPattern = await grep({ path: T });
  check('B9 缺 pattern 报 [INVALID]', noPattern.startsWith('[INVALID]'));
  const emptyPattern = await grep({ pattern: '   ', path: T });
  check('B10 pattern 是空白也报 [INVALID]（不当成"匹配一切"）', emptyPattern.startsWith('[INVALID]'));

  const badGlob = await grep({ pattern: 'permissionKey', path: T, include: '*.{ts,' });
  check('B11 坏 include 报 [INVALID]，而不是静默当成"不过滤"', badGlob.startsWith('[INVALID]'), badGlob.slice(0, 120));
}

/* ══════════════════════════════════════════════════════════════════════════
   ③ grep 过滤、正则能力与上限
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n③ grep 过滤 / 正则能力 / 命中上限');
{
  const ts = await grep({ pattern: 'permissionKey', path: T, include: '*.ts' });
  check('C1 include "*.ts" 只返回 .ts（b.js 与 c.txt 的命中不出现）',
    ts.startsWith('[OK]') && !ts.includes('b.js') && !ts.includes('c.txt'), ts.slice(0, 200));
  check('C2 include "*.ts" 仍递归到子目录', /sub\/d\.ts:1:/.test(ts));

  const both = await grep({ pattern: 'permissionKey', path: T, include: '*.{ts,js}' });
  check('C3 include "*.{ts,js}" 两者都返回', both.includes('a.ts') && both.includes('b.js'));
  check('C4 include "*.{ts,js}" 排除 .txt', !both.includes('c.txt'));

  const alt = await grep({ pattern: 'permission(Key|Detail)', path: `${T}/a.ts` });
  check('C5 分组与择一真生效（JS 正则，不是 findstr 的弱化正则）',
    /找到 2 处匹配/.test(alt), alt.slice(0, 160));

  const ws = await grep({ pattern: 'const\\s+permissionDetail', path: `${T}/a.ts` });
  check('C6 \\s+ 这类字符类真生效', ws.startsWith('[OK]') && /a\.ts:3:/.test(ws));

  const cap = await grep({ pattern: 'HITCAP', path: T });
  const capN = Number(/找到 (\d+) 处匹配/.exec(cap)?.[1] ?? 0);
  check('C7 命中数封顶在 50（造了 60 行命中）', capN === 50, `实际 ${capN}`);
  check('C8 封顶时明说"已停止"，不让模型以为总共就 50 处', /命中达上限 50 已停止/.test(cap), cap.split('\n')[0]);

  const long = await grep({ pattern: 'x', path: `${T}/big.ts` });
  check('C9 单独指定超大文件时仍按上限跳过（不因为显式点名就读进来）',
    long.startsWith('[NO_MATCH]') && /跳过 1 个超大文件/.test(long), long.slice(0, 120));
}

/* ══════════════════════════════════════════════════════════════════════════
   ④ bash 解码：本轮修的主洞
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n④ bash 子进程输出解码（外部程序 UTF-8 / 内建命令代码页）');
{
  // 核心回归：外部程序输出中文。改前硬编码 GBK → "缂栬瘧閫氳繃"
  const cn = await run('cn');
  check('D1 外部程序（node）输出的中文逐字正确（改前是"缂栬瘧閫氳繃"）',
    cn.includes('编译通过'), JSON.stringify(cn.slice(0, 120)));
  check('D2 返回值里没有 U+FFFD 替换字符（乱码的指纹）', !cn.includes('\uFFFD'));
  check('D3 返回值里没有 GBK 误解的典型产物', !/缂栬|娴嬭|绮惧噯/.test(cn));

  if (IS_WIN) {
    // cmd.exe 内建命令走控制台代码页 936：实测 `echo 中文测试` → d6d0cec4b2e2cad4
    const gbk = await bash({ command: 'echo 中文测试' });
    check('D4 cmd.exe 内建命令的中文仍正确（UTF-8 严格解失败后回退代码页）',
      gbk.includes('中文测试'), JSON.stringify(gbk.slice(0, 120)));
    check('D5 该回退不报 [ERROR]（解码器出问题不能伪装成"命令执行失败"）', gbk.startsWith('[OK]'));
    check('D6 无 U+FFFD（回退解码真的解对了，不是"解不出来就算了"）', !gbk.includes('\uFFFD'));
  } else {
    // POSIX 侧没有代码页概念：外部程序一律 UTF-8，printf 造的非法字节不该让 handler 崩
    const inv = await bash({ command: `printf '\\xd6\\xd0\\xce\\xc4'` });
    check('D4 非法 UTF-8 字节不让 handler 抛异常（仍返回带前缀的文本）',
      inv.startsWith('[OK]') || inv.startsWith('[ERROR]'), JSON.stringify(inv.slice(0, 80)));
    check('D5 合法 UTF-8 输出优先按 UTF-8 解（与 win32 同一策略）', inv.length > 0);
    check('D6 解码策略不依赖平台硬编码（见 ⑦ 段源码断言）', /decodeChildOutput/.test(builtinSrc));
  }

  check('D7 解码走的是"先 UTF-8 严格解、失败再退代码页"（顺序不能反）',
    /new TextDecoder\('utf-8', \{ fatal: true \}\)/.test(builtinSrc));
  check('D8 回退解码器本身不可用时还有最后一层兜底，不冒到 handler 的 catch',
    /return raw\.toString\('utf-8'\);/.test(builtinSrc));
}

/* ══════════════════════════════════════════════════════════════════════════
   ⑤ bash 前缀、成败判定与执行环境
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n⑤ bash 返回前缀与成败判定（前缀是契约不是文案）');
{
  const okOut = await run('cn');
  check('E1 成功以 [OK] 开头', okOut.startsWith('[OK]'));

  const failOut = await run('fail');
  check('E2 非零退出以 [ERROR] 开头（不抛异常、不用软前缀）', failOut.startsWith('[ERROR]'), failOut.slice(0, 120));
  check('E3 stderr 出现在返回文本里（模型靠它排查，提示词【铁律】"读错误→定位→修复"的输入）',
    failOut.includes('这是标准错误输出'), JSON.stringify(failOut.slice(0, 160)));
  check('E4 stderr 的中文也不乱码（走同一条解码路径）', !failOut.includes('\uFFFD'));

  check('E5 缺 command 报 [INVALID]', (await bash({})).startsWith('[INVALID]'));
  check('E6 command 是空白也报 [INVALID]', (await bash({ command: '   ' })).startsWith('[INVALID]'));

  const quiet = await run('quiet');
  check('E7 无输出走"（无输出）"分支', quiet.includes('（无输出）'), quiet.slice(0, 120));
  check('E8 无输出时回显命令（截到 100 字符）', quiet.includes('emit.js'));

  const cwd = await run('cwd');
  check('E9 cwd 继承 process.cwd()（描述写着"命令在当前工作目录执行"，此前从无断言）',
    cwd.includes(process.cwd().replace(/\\/g, '/')) || cwd.includes(process.cwd()), cwd.slice(0, 140));

  const big = await run('big');
  check('E10 输出超 maxBuffer(4MB) 报 [ERROR] 而不是崩掉', big.startsWith('[ERROR]'), big.slice(0, 100));

  // 双向源码断言（结构化返回值后重钉，2026-09-12）：分类不再解析前缀文本，
  // 钉"判定式唯一 + 名单精确"——core 的 toolStatusFails 名单恰好三个，agent-loop 只调它。
  const failsDef = coreSrc.match(/export function toolStatusFails[\s\S]*?\n}/)?.[0] ?? '';
  const failsList = [...failsDef.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  check('E11 计失败的状态恰好是 invalid / error / verify_failed 三个，agent-loop 只调唯一判定式',
    failsList.join(',') === 'invalid,error,verify_failed'
    && /failed = toolStatusFails\(result\.status\)/.test(loopSrc),
    `实际=${JSON.stringify(failsList)}`);
  check('E12 bash 的失败路径用的正是同一个 error 状态（toolError）',
    /return toolError\(`命令执行失败:/.test(builtinSrc));
}

/* ══════════════════════════════════════════════════════════════════════════
   ⑥ bash 截断与计数（行数按截断前算）
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n⑥ bash 截断与计数（改前两个数一前一后自相矛盾）');
{
  const many = await run('lines');   // 1000 行、约 9000 字符，必然触发截断
  check('F1 超 4000 字符时截断并明说', many.includes('输出截断'), many.slice(0, 140));
  check('F2 标签里的行数是**截断前**的真实行数 1000（改前会显示成几十行）',
    /\(1000 行输出/.test(many), many.split('\n')[0]);
  check('F3 截断提示里的字符数也是截断前的原文长度', /共 \d{4,} 字符、1000 行/.test(many), many.slice(0, 200));
  check('F4 标签里的字符数与提示里的一致（不再一前一后矛盾）', (() => {
    const head = /(\d+) 行输出，(\d+) 字符/.exec(many);
    const note = /共 (\d+) 字符、(\d+) 行/.exec(many);
    return !!head && !!note && head[2] === note[1] && head[1] === note[2];
  })());
  check('F5 正文确实被截到 4000 字符量级（没有假装截断其实全给）',
    many.length < 5000 && many.length > 4000, `实际 ${many.length}`);

  const short = await run('cn');
  check('F6 未超限时不出现"输出截断"', !short.includes('输出截断'));
  check('F7 未超限时行数照实报（1 行）', /\(1 行输出/.test(short), short.split('\n')[0]);
}

/* ══════════════════════════════════════════════════════════════════════════
   ⑦ 源码文本断言：把"改前的写法别再回来"钉死
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n⑦ 源码文本断言（防回退）');
{
  // 先切出 grep 那一段再断言：拿字面串扫全文件会被散文误伤——本轮就踩了，
  // 解释"改前为什么坏"的注释里写着那串 `grep -rn ... 2>/dev/null | head -50`，
  // 于是三条断言全红，而代码其实已经对了。**断言代码行为时**要钉调用形态、不要钉散文里的用词；
  // 但下面 G3/G4/G5 是防文案回退的，天生只能钉用词，代价是改一个字就红（2026-09-05 补注）
  const grepBlock = builtinSrc.slice(builtinSrc.indexOf("name: 'grep'"), builtinSrc.indexOf('/* ── Bash'));
  check('G0 切片本身有效（否则下面三条是空转的假绿）',
    grepBlock.length > 500 && !grepBlock.includes("name: 'bash'"), `切到 ${grepBlock.length} 字符`);
  // 断言用**调用形态**（带括号）而非裸标识符：解释性注释里会写"Windows 上 execSync 走
  // cmd.exe"这种散文，裸标识符会被它误伤（本条第一版就是这么红的，而代码当时已经对了）
  check('G1 grep 段内不再调 execSync、不再 import child_process（彻底不 shell 出去，不再依赖系统装没装 grep）。**这条钉的是手段**：正则读源码文本，换成任何等价的纯 Node 实现都会红——"搜得到/搜不到"的行为面由 ①②③ 段钉',
    !/execSync\(/.test(grepBlock) && !/node:child_process/.test(grepBlock));
  check('G2 grep 段内不再拼任何 shell 命令串', !/const cmd =/.test(grepBlock));
  check('G3 grep 段内保留了"改前为什么坏"的解释（防后人当噪音删掉，然后又 shell 出去）',
    /改前拼的是/.test(grepBlock));
  check('G4 grep 的 description 不再声称"基于 ripgrep (rg) 或系统 grep"（改前代码里两者都没有）',
    !builtinSrc.includes('基于 ripgrep'));
  check('G5 grep 的失败路径报 error（toolError），不再有"搜索失败或无匹配"这种混合前缀',
    !builtinSrc.includes('搜索失败或无匹配') && /return toolError\(`搜索失败:/.test(builtinSrc));
  check('G6 bash 不再内联硬编码单一编码', !/const encoding = process\.platform === 'win32' \? 'gbk' : 'utf-8';\n\s*const output = new TextDecoder\(encoding/.test(builtinSrc));
  // 2026-09-16（ROADMAP 10.6.6）更新：bash 把起进程交给 process/runner.ts 之后变量不再叫 raw。
  // 顺手收紧成"两处都过解码器"—— 改前这条正则实际匹配到的是 **grep 段**的同名变量，
  // 也就是说它早就不在钉 bash 了（断言还绿，目标已经漂了）。
  check('G7 bash 的 stdout / stderr 都过 decodeChildOutput（Windows 上 cmd.exe 报错是 GBK）',
    /decodeChildOutput\(r\.stdout\)/.test(builtinSrc) && /decodeChildOutput\(r\.stderr\)/.test(builtinSrc));
  check('G8 windowsHide: true 仍在（删了会在 Windows 上弹黑框）', /windowsHide: true/.test(builtinSrc));
  // 2026-09-16（ROADMAP 10.6.6）：两个数从内联字面量提成常量（bash 不再是唯一用它的地方），
  // **值没动**。那次一并关掉了 G9 原先记的缺口 —— 超时路径现在**真能测**了：
  // 改前起进程的是同步 API，要触发超时只能真等满 30 秒；换成异步执行器后可以用小上限触发，
  // 见新增的 scripts/verify-proctree.ts（真起三跳子进程，超时后确认孙进程没能写标记文件）。
  check('G9 bash 的超时仍是 30 秒（提成 BASH_TIMEOUT_MS，值不变）',
    /const BASH_TIMEOUT_MS = 30000;/.test(builtinSrc));
  check('G10 bash 的 maxBuffer 仍是 4MB', /const BASH_MAX_BUFFER = 4096 \* 1024;/.test(builtinSrc));
  // 口径更新（2026-09-15，ROADMAP 10.7.3 `.gitignore` 感知；必有这一步写在 **⚠C10**：
  // "属必然要改的既有断言，不算破坏设计"）。跳过表不再是"只有硬编码清单"，而是
  // **内置默认 ∪ `.gitignore`**。内置默认必须一直在 —— 哪怕用户在自己的 .gitignore 里
  // 把它们放回来，`.git` / `node_modules` / `dist` 也不进结果（安全底线不交给人手填空话）。
  // 所以这条从"只有清单"改成"清单 ∪ 规则"两半都钉。（两侧**一致**这件事由
  // `verify-gitignore.ts` 的 D5 单独钉，这里不重复。）
  check('G11 grep 的跳过表 = 内置默认（.git/node_modules/dist）∪ .gitignore（两半都在，缺一不可）',
    /const SKIP_DIRS = new Set\(\['\.git', 'node_modules', 'dist'\]\);/.test(builtinSrc)
    && /isIgnoredByGitignore\(childRel, item\.isDirectory\(\), ignoreRules\)/.test(builtinSrc));
  // 口径更新（2026-09-14 git 工具；2026-09-15 改完自检；**2026-09-16 ROADMAP 10.6.6**）：
  // 起进程这件事**收拢**了 —— bash 与自检原先各自直连 child_process，现在都改走
  // process/runner.ts（异步 spawn + 超时**按进程树**杀）。builtin.ts 里只剩 git 一处。
  // 判据因此从"在 builtin 里数到三"变成"点两个模块的名字"：多出第三个模块，就说明又有
  // 人绕开了受控执行器 —— 而"各自直连、各自只杀 shell"正是 10.6.6 要根治的老毛病。
  // 这条**会随正当用途增加而红**，那是刻意的：每次加一处都必须回来把理由写在这里。
  const runnerSrc = fs.readFileSync(path.join(ROOT, 'src/process/runner.ts'), 'utf-8');
  check('G12 起子进程只有两个模块：builtin.ts（git，argv 不经 shell）与 process/runner.ts（bash 与自检共用）',
    (builtinSrc.match(/await import\('node:child_process'\)/g) ?? []).length === 1
    && (runnerSrc.match(/await import\('node:child_process'\)/g) ?? []).length === 1);
  check('G12b builtin.ts 里不再直接 spawnSync / execSync（那等于退回"只杀 shell、孙进程照跑"）',
    !/\b(spawnSync|execSync)\(/.test(builtinSrc));
}

/* ── 清理与汇总 ── */

fs.rmSync(tmpDir, { recursive: true, force: true });
check('Z1 临时目录已清理（不留垃圾在系统 tmp 里）', !fs.existsSync(tmpDir));

// 结果行的格式是 run-verify.mjs 的**解析契约**（/结果[：:]\s*(\d+)\s*通过.../），不是自由文案：
// 写成 "verify-tools: N 通过" 会被判为"结果行没解析出来"，本套项数就不计入合计。
// 防线还在（run-verify 照实报了未解析、不静默当成通过），但总数会长期少算
console.log(`\n结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
process.exit(failed > 0 ? 1 : 0);
