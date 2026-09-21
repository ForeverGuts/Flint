/**
 * verify-symbols.ts —— 符号定义检索（ROADMAP 10.7.1）
 *
 * 验什么（手段与行为分开钉）：
 *   ① **形状表逐写法打靶** —— 8 个语言族的 50 多种写法，每条给一个真例 + 一个"长得像但不是定义"
 *      的反例。这张表是纯函数的，所以能穷举，不需要磁盘。
 *   ② **注释扫描** —— 行注释 / 块注释跨行 / 同行闭合 / 注释里套注释标记 / 未闭合到文件尾。
 *      这一段的期望值不是"报/不报"，而是"报，且带（注释）标记"（承重④）。
 *   ③ **封闭枚举与语言表** —— kind 只有一处定义；`CODE_EXTS` 的风格值合法；扩展名解析边界。
 *   ④ **渲染** —— 0 命中分支的措辞（"不等于不存在" + 给 grep 出路）与命中分支的截断。
 *   ⑤ **真仓库端到端**（真 ToolRegistry + 真临时目录树）—— 命中 / 与 grep 的子集关系 /
 *      `.gitignore` 与跳过表 / 非代码文件在"走目录"与"点名文件"两条路上的**相反**行为 /
 *      二进制与超大文件 / 命中上限 / 工具状态与权限。
 *   ⑥ 源码守护 —— 判据零 import、遍历器只此一份、builtin 里不再有第二份跳过表、
 *      读类工具不弹窗、也不进计划模式名单。
 *
 * ── 本套最容易写错的三处（写的时候踩过）：
 *   · ④ 段必须断言**工具状态**，不能只断文本：0 命中如果返回 negative（NO_MATCH），
 *     agent-loop 会把它当"有效否定"（= 答案就是没有），而模型会据此**新建一个同名符号**。
 *     这是本条与 grep 最本质的差别，只断文本的话，改成 negative 也可能照绿。
 *   · ⑤ 段的路径断言用 `includes(绝对路径)`：grep 与 symbols 印的都是遍历器给的绝对路径
 *     （Windows 上盘符段带反斜杠、拼进去的段带正斜杠），用正则拼会踩转义。
 *   · 反例必须挑"**看着像定义**"的那种（`foo(bar);` / `if (foo === 1)` / 缩进的局部赋值），
 *     拿"根本不沾边"的串当反例是空转的假绿。
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-symbols.ts
 * 退出码：failed > 0 → 1
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolRegistry } from '../src/tools/registry.js';
import { registerBuiltinTools } from '../src/tools/builtin.js';
import { PLAN_BLOCKED_TOOLS } from '../src/loop/plan-mode.js';
import {
  CODE_EXTS, SYMBOL_BODY_MAX, SYMBOL_KINDS, SYMBOL_MAX_HITS, SYMBOL_SHAPES,
  clipLine, commentStyleOf, extOf, isCodeFile, renderEntry, renderSymbolReport, scanSymbols,
  viewLine,
  type CommentState, type SymbolEntry, type SymbolHit, type SymbolKind,
} from '../src/search/symbols.js';
import { SKIP_DIRS, readForScan, scanPaths } from '../src/search/walk.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
   ① 形状表：逐写法打靶
   ══════════════════════════════════════════════════════════════════════════════ */

console.log('\n① 形状表（每种写法一个真例，每条都属于"常见写法"这一档）');

/** 一行定义 → 期望的种类。`found` helper 断言"恰好命中一行、行号是 1" */
const DEFS: Array<[string, string, string, SymbolKind]> = [
  // TypeScript / JavaScript
  ['a.ts', 'export function alpha() {}', 'alpha', 'function'],
  ['a.ts', 'export default async function alpha() {}', 'alpha', 'function'],
  ['a.ts', 'function* alpha() {}', 'alpha', 'function'],
  ['a.ts', 'export class Alpha {}', 'Alpha', 'class'],
  ['a.ts', 'export abstract class Alpha {}', 'Alpha', 'class'],
  ['a.ts', 'export interface Alpha {}', 'Alpha', 'interface'],
  ['a.ts', 'export type Alpha = string;', 'Alpha', 'type'],
  ['a.ts', 'export const enum Alpha { A }', 'Alpha', 'enum'],
  ['a.ts', 'export enum Alpha { A }', 'Alpha', 'enum'],
  ['a.ts', 'export const alpha = 1;', 'alpha', 'const'],
  ['a.ts', 'export let alpha = 1;', 'alpha', 'var'],
  ['a.ts', 'declare const alpha: number;', 'alpha', 'const'],
  ['a.ts', 'type Alpha<T> = T;', 'Alpha', 'type'],
  ['a.ts', 'namespace Alpha {}', 'Alpha', 'module'],
  ['a.ts', 'const alpha = () => 1', 'alpha', 'const'],
  // 类方法 / 对象方法（缩进也认：它是"定义"而不是"局部变量"）
  ['a.ts', '  alpha() {', 'alpha', 'function'],
  ['a.ts', '  async alpha(): void {', 'alpha', 'function'],
  ['a.ts', '  static alpha() {', 'alpha', 'function'],
  // Python
  ['a.py', 'def alpha(a):\n    pass', 'alpha', 'function'],
  ['a.py', 'async def alpha():\n    pass', 'alpha', 'function'],
  ['a.py', 'class Alpha:', 'Alpha', 'class'],
  ['a.py', 'ALPHA = 1', 'ALPHA', 'const'],
  // Go
  ['a.go', 'func alpha() {}', 'alpha', 'function'],
  ['a.go', 'func (s *Server) alpha() {}', 'alpha', 'function'],
  ['a.go', 'type Alpha struct {', 'Alpha', 'type'],
  ['a.go', 'type Alpha interface {', 'Alpha', 'type'],
  ['a.go', 'var alpha int', 'alpha', 'var'],
  ['a.go', 'func (s *Server) Alpha() {}', 'Alpha', 'function'],
  // Rust
  ['a.rs', 'pub fn alpha() {}', 'alpha', 'function'],
  ['a.rs', 'pub async unsafe fn alpha() {}', 'alpha', 'function'],
  ['a.rs', 'pub struct Alpha;', 'Alpha', 'struct'],
  ['a.rs', 'struct Alpha { x: u8 }', 'Alpha', 'struct'],
  ['a.rs', 'pub enum Alpha { A }', 'Alpha', 'enum'],
  ['a.rs', 'pub trait Alpha {}', 'Alpha', 'trait'],
  ['a.rs', 'pub mod alpha;', 'alpha', 'module'],
  ['a.rs', 'pub const ALPHA: u8 = 1;', 'ALPHA', 'const'],
  ['a.rs', 'static ALPHA: u8 = 1;', 'ALPHA', 'const'],
  ['a.rs', 'pub type Alpha = u8;', 'Alpha', 'type'],
  // Ruby
  ['a.rb', 'def alpha; end', 'alpha', 'function'],
  ['a.rb', 'class Alpha', 'Alpha', 'class'],
  ['a.rb', 'module Alpha', 'Alpha', 'module'],
  // Java / Kotlin / Scala
  ['a.java', 'public class Alpha {', 'Alpha', 'class'],
  ['a.java', 'public interface Alpha {', 'Alpha', 'interface'],
  ['a.java', 'public enum Alpha {', 'Alpha', 'enum'],
  ['a.java', 'public record Alpha(int x) {', 'Alpha', 'class'],
  ['a.kt', 'fun alpha() {}', 'alpha', 'function'],
  ['a.kt', 'object Alpha', 'Alpha', 'class'],
  ['a.kt', 'val ALPHA = 1', 'ALPHA', 'const'],
  ['a.scala', 'def alpha(): Unit = {}', 'alpha', 'function'],
  // C 家族（**只认类型，不认函数** —— 见 symbols.ts 的"刻意不做"）
  ['a.c', 'struct Alpha {', 'Alpha', 'struct'],
  ['a.c', 'union Alpha {', 'Alpha', 'struct'],
  ['a.c', 'enum Alpha {', 'Alpha', 'enum'],
  ['a.c', 'typedef struct Alpha {', 'Alpha', 'struct'],
  ['a.c', 'typedef int Alpha;', 'Alpha', 'type'],
  ['a.c', '#define ALPHA 1', 'ALPHA', 'macro'],
  ['a.cpp', 'class Alpha {', 'Alpha', 'class'],
  // Shell
  ['a.sh', 'alpha() {', 'alpha', 'function'],
  ['a.sh', 'function alpha {', 'alpha', 'function'],
  ['a.sh', '$ALPHA=1', 'ALPHA', 'const'],
];

/** 跑一条用例：内容只有一行时行号必须是 1 */
function hitOnce(file: string, content: string, name: string): SymbolHit | null {
  const hits = scanSymbols(content, file, name);
  return hits.length === 1 ? hits[0] : null;
}

for (const [file, line, name, kind] of DEFS) {
  const h = hitOnce(file, `${line}\n`, name);
  check(`${file} 的 \`${line.trim()}\` → ${kind}`,
    h !== null && h.kind === kind && h.line === 1 && !h.inComment,
    h === null ? '没命中或命中多行' : `得到 ${h.kind}`);
}

console.log('\n①b 反例：长得像定义但不是（这一档比正例更要紧 —— 假阳会让模型去改错地方）');

const NON_DEFS: Array<[string, string, string]> = [
  ['a.ts', 'const alphabeta = 1', 'alpha'],        // 子串不算（grep 最典型的噪音）
  ['a.ts', 'const Alpha = 1', 'alpha'],            // 大小写不同
  ['a.ts', '  const alpha = 1', 'alpha'],          // 缩进的局部变量，**刻意**不收
  ['a.py', '  alpha = 1', 'alpha'],                // 同上（函数体里的赋值）
  ['a.py', 'if alpha == 1:', 'alpha'],             // 比较运算不是定义（`==` 被挡）
  ['a.py', 'alpha != 1', 'alpha'],
  ['a.ts', 'if (alpha === 1) {', 'alpha'],
  ['a.ts', 'alpha(1);', 'alpha'],                  // 带参调用
  ['a.ts', 'alpha.beta = 1', 'alpha'],             // 成员赋值
  ['a.ts', 'return alpha', 'alpha'],
  ['a.ts', '// merge alpha later', 'alpha'],       // 注释里也不是定义（但见 ② 段：那是有标记的一档）
  ['a.go', '  var alpha int', 'alpha'],            // 缩进（函数体内）不收
  ['a.c', 'int alpha(int a) {', 'alpha'],          // C 函数定义**刻意不认**（与调用区分不开）
  ['a.java', 'public void alpha() {', 'alpha'],    // 同上（带返回类型的方法）
];

for (const [file, line, name] of NON_DEFS) {
  const hits = scanSymbols(`${line}\n`, file, name);
  check(`${file} 的 \`${line.trim()}\` 不报 ${name}`, hits.length === 0,
    hits.map((h) => `${h.line}:${h.kind}`).join(','));
}

console.log('\n①c 名字比对与行号');

{
  const src = [
    'export function alpha() {}',              // 1
    'export function alphabeta() {}',          // 2
    '// 上面两个只差后缀',                      // 3
    'export const Alpha = 1;',                 // 4
    '  alpha() {',                             // 5
  ].join('\n');
  const hits = scanSymbols(src, 'a.ts', 'alpha');
  check('精确比对：搜 alpha 命中 2 处（1 行与 5 行），不含 alphabeta 与 Alpha',
    hits.length === 2 && hits[0].line === 1 && hits[1].line === 5,
    hits.map((h) => `${h.line}:${h.name}`).join(','));
  check('行号是 1 起的真行号（不是数组下标）', hits[0].line === 1 && hits[1].line === 5);
  const big = scanSymbols(['x'.repeat(10), '', 'export function Alpha() {}'].join('\n'), 'a.ts', 'Alpha');
  check('大小写不同各算各的：搜 Alpha 拿到第 3 行', big.length === 1 && big[0].line === 3);
  check('一行只报一次（命中即 break，不重复推同一条）',
    scanSymbols('export class alpha {}\n', 'a.ts', 'alpha').length === 1);
  check('maxHits 生效（给 1 就只回 1 条）',
    scanSymbols('export function alpha() {}\nexport const alpha = 1;\n', 'a.ts', 'alpha', 1).length === 1);
  check('maxHits=0 时不回任何东西（调用方据此判断"名额已满"）',
    scanSymbols('export function alpha() {}\n', 'a.ts', 'alpha', 0).length === 0);
}

/* ══════════════════════════════════════════════════════════════════════════════
   ② 注释扫描（承重④：注释里的定义要报，但必须带标记）
   ══════════════════════════════════════════════════════════════════════════════ */

console.log('\n② 注释扫描：行注释 / 块注释 / 嵌套标记 / 未闭合');

{
  // 行注释：报，且带标记
  const h = scanSymbols('// export function alpha() {}\n', 'a.ts', 'alpha');
  check('行注释里的定义照样报（丢掉它会让模型以为"没定义"）', h.length === 1, `${h.length}`);
  check('但带上（注释）标记（当成真的报=谎报，模型会去改废弃代码）', h[0]?.inComment === true);
  check('注释标记剥离后按注释内容识别（不是靠"整行不匹配"蒙对的）', h[0]?.kind === 'function');

  // hash 风格
  const py = scanSymbols('# def alpha():\n', 'a.py', 'alpha');
  check('hash 语言（py）的行注释同样报 + 标记', py.length === 1 && py[0].inComment);

  // 缩进保留：注释里的东西按"它原本在第几列"判定（承重③ 的列 0 判据不能被注释绕过）
  check('缩进的注释行仍按缩进算 —— `  # ALPHA = 1` 不收（它不是模块级定义）',
    scanSymbols('  # ALPHA = 1\n', 'a.py', 'ALPHA').length === 0);
  check('不缩进的注释行照收 —— `# ALPHA = 1` 是（带标记）',
    scanSymbols('# ALPHA = 1\n', 'a.py', 'ALPHA').length === 1);

  // 代码 + 行尾注释：按代码部分判
  check('代码后面跟行尾注释时按代码部分判（`export function alpha() {} // x` 不带标记）',
    scanSymbols('export function alpha() {} // 说明\n', 'a.ts', 'alpha')[0]?.inComment === false);

  // 块注释：同行闭合
  const inline = scanSymbols('/* export function alpha() {} */\n', 'a.ts', 'alpha');
  check('同行闭合的块注释：报 + 标记', inline.length === 1 && inline[0].inComment === true);

  // 块注释：跨行
  const multi = scanSymbols('/*\nexport function alpha() {}\n*/\n', 'a.ts', 'alpha');
  check('跨行块注释的第二行也报 + 标记', multi.length === 1 && multi[0].line === 2 && multi[0].inComment);
  check('块注释收尾之后的行恢复成真代码（不允许"一旦进注释就永久注释"）',
    scanSymbols('/*\nx\n*/\nexport function alpha() {}\n', 'a.ts', 'alpha')[0]?.inComment === false);
  check('JSDoc 那种 `* 内容` 前缀被剥掉（否则形状匹配不上）',
    scanSymbols('/**\n * export function alpha() {}\n */\n', 'a.ts', 'alpha')[0]?.inComment === true);

  // 标记互相嵌套：行注释里的 /* 不该开块
  const nested = scanSymbols('// 这里写 /* 但没闭合\nexport function alpha() {}\n', 'a.ts', 'alpha');
  check('行注释里的 `/*` 不开块注释（否则后面整个文件都被当成注释）',
    nested.length === 1 && nested[0].inComment === false && nested[0].line === 2);

  // 块注释里的 // 只当内容
  check('块注释里的 `//` 只当内容（不会提前结束块）',
    scanSymbols('/*\n// export function alpha() {}\n*/\n', 'a.ts', 'alpha')[0]?.inComment === true);

  // 未闭合到文件尾
  check('未闭合的块注释一直吃到文件尾（第 3 行的定义仍带标记）',
    scanSymbols('/* 开始\n中\n export function alpha() {}\n', 'a.ts', 'alpha')[0]?.inComment === true);

  // 直接打靶 viewLine：状态是逐行传的
  const st: CommentState = { block: false };
  check('viewLine 原样返回代码行（缩进保留，供列 0 判据用）',
    viewLine('  const a = 1', 'slash', st).text === '  const a = 1' && !st.block);
  st.block = false;
  check('viewLine 遇到未闭合的 `/*` 会把状态留给下一行', (() => {
    viewLine('/* 开始', 'slash', st);
    return st.block === true;
  })());
  check('viewLine 在块注释里继续吃内容', viewLine('  里面的字', 'slash', st).inComment === true);
  check('viewLine 遇到 `*/` 之后状态复位', (() => {
    viewLine('*/ 后面', 'slash', st);
    return st.block === false;
  })());

  // 已知边界：不解析字符串字面量
  check('已知边界：`"http://x"` 里的 `//` 被当成注释起点（文档写明的，不是意外）',
    viewLine("const u = 'http://x';", 'slash', { block: false }).text.includes('http:'));
}

/* ══════════════════════════════════════════════════════════════════════════════
   ③ 封闭枚举与语言表
   ══════════════════════════════════════════════════════════════════════════════ */

console.log('\n③ 封闭枚举与语言表');

{
  const kinds = new Set<string>(SYMBOL_KINDS);
  const used = new Set(SYMBOL_SHAPES.map((s) => s.kind));
  check('每条形状的种类都在枚举里（形状表不许造枚举外的 kind）',
    [...used].every((k) => kinds.has(k)), [...used].filter((k) => !kinds.has(k)).join(','));
  check('枚举里每种 kind 都有形状在用（不留空种类）',
    [...kinds].every((k) => used.has(k)), [...kinds].filter((k) => !used.has(k)).join(','));
  check('枚举值无重复', new Set(SYMBOL_KINDS).size === SYMBOL_KINDS.length);
  check('每条形状都带捕获组（名字靠 group 1，不是靠整行匹配）',
    SYMBOL_SHAPES.every((s) => s.re.source.includes('(')));
  check('行首无缩进那几条（topLevel）确实存在，且都锚在 `^`',
    SYMBOL_SHAPES.some((s) => s.topLevel) && SYMBOL_SHAPES.every((s) => s.re.source.startsWith('^')));

  check('CODE_EXTS 的风格值只有两种',
    [...CODE_EXTS.values()].every((v) => v === 'slash' || v === 'hash'));
  check('extOf：常规 / 大写 / 无扩展名 / 以点开头 / 目录里的点',
    extOf('a.ts') === '.ts' && extOf('A.TS') === '.ts' && extOf('Makefile') === ''
    && extOf('.gitignore') === '' && extOf('a.b/c') === '' && extOf('src/x.test.ts') === '.ts');
  check('isCodeFile：代码文件认、非代码不认',
    isCodeFile('a.ts') && isCodeFile('a.py') && isCodeFile('a.go')
    && !isCodeFile('README.md') && !isCodeFile('package.json') && !isCodeFile('Makefile'));
  check('commentStyleOf：认识的给风格，不认识给 null（调用方据此退回默认）',
    commentStyleOf('a.ts') === 'slash' && commentStyleOf('a.py') === 'hash'
    && commentStyleOf('a.md') === null);
}

/* ══════════════════════════════════════════════════════════════════════════════
   ④ 渲染
   ══════════════════════════════════════════════════════════════════════════════ */

console.log('\n④ 渲染（0 命中那一支是本条最要紧的几行）');

const baseReport = {
  name: 'alpha', pathLabel: 'src', scanned: 12, filtered: 3,
  skippedBinary: 1, skippedBig: 0, truncated: false, singleFile: false,
};
const entry = (line: number, kind: SymbolKind, inComment = false): SymbolEntry => ({
  file: 'C:/p/a.ts',
  hit: { line, kind, name: 'alpha', inComment, text: `export function alpha() {}` },
});

{
  const zero = renderSymbolReport({ ...baseReport, hits: [] });
  check('0 命中：明说"不等于这个符号不存在"', zero.includes('不等于') && zero.includes('不存在'));
  check('0 命中：带上"我不是编译器"那句', zero.includes('不是编译器'));
  check('0 命中：**给出替代手段**（让模型改用 grep，而不是自己猜）', zero.includes('grep 搜 "alpha"'));
  check('0 命中：只记一句结论，不抄整封解释（正文要能一屏放下）', zero.split('\n').length <= 12);
  check('0 命中：不出现任何"有效否定"的口径（NO_MATCH / 无匹配结果）',
    !zero.includes('NO_MATCH') && !zero.includes('无匹配结果'));
  check('0 命中：统计照给（模型要能区分"真没有"与"全被过滤了"）',
    zero.includes('已扫 12 个文件') && zero.includes('跳过 3 个非代码文件')
    && zero.includes('跳过 1 个二进制'));

  const one = renderSymbolReport({ ...baseReport, hits: [entry(7, 'function')] });
  check('命中：行是 `路径:行号: 种类 — 原文`（与 grep 的"路径:行号:内容"同形）',
    one.includes('C:/p/a.ts:7: function —'), one.split('\n')[2] ?? '');
  check('命中：抬头报了条数与名字', one.includes('找到 1 处定义: alpha'));
  check('命中：也带上"我不是编译器"那句', one.includes('不是编译器'));
  check('注释命中带（注释）标记', renderEntry(entry(7, 'function', true)).includes('（注释）'));
  check('非注释命中不带标记', !renderEntry(entry(7, 'function', false)).includes('（注释）'));

  const many = renderSymbolReport({
    ...baseReport,
    hits: Array.from({ length: 200 }, (_, i) => entry(i + 1, 'const')),
  });
  check('命中正文超过 SYMBOL_BODY_MAX 时截断且说明',
    many.includes('结果截断') && many.length < SYMBOL_BODY_MAX + 400, `${many.length}`);
  check('截断说明里的字符数按**截断前**的原文算',
    new RegExp(`共 \\d{4,} 字符`).test(many));

  const single = renderSymbolReport({ ...baseReport, hits: [], singleFile: true, filtered: 0 });
  check('点名文件时不提"跳过 N 个非代码文件"（那条路上过滤器根本没生效）',
    !/跳过 \d+ 个非代码文件/.test(single));

  check('clipLine 去掉首尾空白并按上限截断',
    clipLine('   ' + 'x'.repeat(200), 10) === 'xxxxxxxxxx…' && clipLine('  a  ') === 'a');
}

/* ══════════════════════════════════════════════════════════════════════════════
   ⑤ 真仓库端到端（真 ToolRegistry + 真临时目录树）
   ══════════════════════════════════════════════════════════════════════════════ */

console.log('\n⑤ 真仓库端到端');

const registry = new ToolRegistry();
registerBuiltinTools(registry);
const call = async (tool: string, args: Record<string, unknown>) =>
  registry.execute(tool, args);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-verify-sym-'));
const T = tmp.replace(/\\/g, '/');
const write = (rel: string, content: string | Buffer): void => {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
};

write('a.ts', [
  'export function alpha() {}',        // 1
  'export class Alpha {}',             // 2
  '// export function alpha_commented() {}',   // 3
  'export function alphabeta() {}',    // 4
].join('\n'));
write('b.py', 'def alpha():\n    pass\n\nALPHA = 1\n');
write('c.go', 'package p\n\nfunc alpha() {}\n\ntype Holder struct{}\n');
write('d.js', 'const alpha = 1;\n');
write('sub/e.ts', 'export const alpha = 2;\n');
write('node_modules/n.ts', 'export function alpha() {}\n');       // 跳过表
write('.git/g.ts', 'export function alpha() {}\n');              // 跳过表
write('build/h.ts', 'export function alpha() {}\n');             // .gitignore
write('.gitignore', 'build/\n');
write('bin.ts', Buffer.concat([Buffer.from('alpha\x00\x01binary', 'utf-8')]));   // 代码扩展名 + NUL
write('big.ts', 'x'.repeat(2 * 1024 * 1024 + 10) + '\nexport function alpha() {}\n');
write('notes.md', '示例：\n\n```ts\nexport function alpha() {}\n```\n');
write('empty.ts', 'export const zzz = 1;\n');                    // 代码文件、但无命中 → 计入"已扫"
write('h.ts', [
  '// export function alpha() {}',     // 1 注释里的定义：要报，但带标记
  'export function alpha() {}',        // 2 真定义
  '/* export class alpha {} */',       // 3 同行闭合的块注释
].join('\n'));

const sym = async (name: string, p: string) => (await call('symbols', { name, path: p })).content;

/**
 * 命中行的形态断言：`…<分隔符>rel:行号: 种类`。
 * 为什么不用 `includes(绝对路径)`：工具印的是遍历器拼出来的绝对路径（盘符段是反斜杠、
 * 拼进来的段是正斜杠），而 `T` 是归一成正斜杠的写法 —— 直接 includes 一定不匹配。
 * 形态判据只认"末尾那段"，与 verify-tools 里 `A2` 的做法一致。
 */
const hitAt = (content: string, rel: string, line: number, kind: string): boolean =>
  new RegExp(`[\\\\/]${rel.replace(/[.\\/]/g, '\\$&')}:${line}: ${kind}`).test(content);

/** 从回执里抠出所有命中行的 `文件+行号`（路径形态无关；grep 是 `:内容`、symbols 是 `: 种类`） */
const hitKeys = (content: string): Array<{ key: string; line: string }> =>
  content.split('\n')
    .map((l) => /^(.*):(\d+):\s?/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ key: `${m[1]}:${m[2]}`, line: m[0] }));

{
  const r = await call('symbols', { name: 'alpha', path: T });
  check('目录扫描：状态是 ok（不是 negative）', r.status === 'ok', r.status);
  check('目录扫描：正文以 [OK] 开头', r.content.startsWith('[OK]'), r.content.slice(0, 60));
  check('命中 a.ts 的 function（带绝对路径，与 grep 同口径）',
    hitAt(r.content, 'a.ts', 1, 'function'), r.content.split('\n').slice(2, 4).join(' | ').slice(0, 200));
  check('命中 b.py 的 def（跨语言，同一张形状表）', hitAt(r.content, 'b.py', 1, 'function'));
  check('命中 c.go 的 func', hitAt(r.content, 'c.go', 3, 'function'));
  check('命中 d.js 的行首 const', hitAt(r.content, 'd.js', 1, 'const'));
  check('递归进子目录（sub/e.ts）', hitAt(r.content, 'sub/e.ts', 1, 'const'));
  check('跳过 node_modules / .git（跳过表同一份）',
    !r.content.includes('node_modules') && !r.content.includes('/.git/'));
  check('.gitignore 里的 build/ 也跳过（与 grep 共用遍历器的那一半）',
    !r.content.includes('build/h.ts'));
  check('跳过二进制并在统计里报出来', r.content.includes('跳过 1 个二进制'));
  check('跳过超大文件并在统计里报出来', r.content.includes('跳过 1 个超大文件'));
  check('非代码文件（.md）在**走目录**时不读，并计入"跳过 N 个非代码文件"',
    !r.content.includes('notes.md') && r.content.includes('跳过 1 个非代码文件'),
    r.content.split('\n')[0] ?? '');
  check('命中里不含 alphabeta（精确比对）', !r.content.includes('alphabeta'));
  check('注释里的定义报出来了、且带（注释）标记（h.ts 第 1 行）',
    hitAt(r.content, 'h.ts', 1, 'function（注释）'), r.content.split('\n').slice(2, 5).join(' | ').slice(0, 240));
  check('同一文件里紧挨着的真定义不带标记（h.ts 第 2 行）',
    hitAt(r.content, 'h.ts', 2, 'function'));
  check('同行闭合的块注释也带标记（h.ts 第 3 行，kind 是 class）',
    hitAt(r.content, 'h.ts', 3, 'class（注释）'));
  check('注释行的原文照印（模型要看得到那是个 `//`，不能只给"注释"两个字）',
    r.content.includes('// export function alpha() {}'));
  check('统计里报出"已扫 N 个文件"', /已扫 \d+ 个文件/.test(r.content));

  // 与 grep 的子集关系：symbols 报的每一条，grep 必须能在同一文件同一行看到这个名字
  const g = await call('grep', { pattern: 'alpha', path: T });
  const gKeys = new Set(hitKeys(g.content).map((h) => h.key));
  const symHits = hitKeys(r.content);
  const missing = symHits.filter((h) => !gKeys.has(h.key));
  check('symbols 报的每一条，grep 都能在同一文件同一行看到它（两个工具不许互相打架）',
    symHits.length >= 5 && missing.length === 0,
    `共 ${symHits.length} 条，缺 ${missing.length}：${missing.map((h) => h.line).join(' | ').slice(0, 200)}`);
  check('对照：grep 的命中数**多于** symbols（前者含调用、注释与非代码文件，后者只报定义行）',
    Number(g.content.match(/找到 (\d+) 处匹配/)?.[1] ?? '0') > symHits.length,
    `${g.content.split('\n')[0]} / symbols 定义行 ${symHits.length}`);

  // 点名一个非代码文件：照样读（界线④：用户说出来的路径，别替他藏）
  const md = await sym('alpha', `${T}/notes.md`);
  check('点名一个 .md 时照读（走目录不读它、点名要读它 —— 两条路刻意相反）',
    md.includes('notes.md:4: function'), md.split('\n').slice(0, 3).join(' | '));
  check('点名文件时不提"非代码文件"（那条统计在单文件路上无意义）',
    !md.includes('非代码文件'));

  // 点名一个代码文件
  const one = await sym('alpha', `${T}/a.ts`);
  check('点名文件：只搜该文件（不含 b.py 等）',
    one.includes('a.ts:') && !one.includes('b.py'));
  check('点名文件：统计里报"已扫 1 个文件"', one.includes('已扫 1 个文件'));

  // 0 命中
  const none = await call('symbols', { name: 'ZZZ_no_such_symbol', path: T });
  check('0 命中仍是 ok 状态（不是 negative —— 启发式的"没找到"不能当有效否定）',
    none.status === 'ok', none.status);
  check('0 命中正文以 [OK] 开头（模型看到的是"完成了一次检索"）',
    none.content.startsWith('[OK]'), none.content.slice(0, 40));
  check('0 命中正文里给出 grep 出路', none.content.includes('grep 搜 "ZZZ_no_such_symbol"'));

  // 路径不存在
  const nf = await call('symbols', { name: 'alpha', path: `${T}/no-such-dir` });
  check('路径不存在 → NOT_FOUND（这一条是有效否定：那条路真的不在）',
    nf.status === 'negative' && nf.content.startsWith('[NOT_FOUND]'), nf.content.slice(0, 60));

  // 参数校验走 spec
  const bad = await call('symbols', { name: 'alpha', pathth: T });
  check('多余参数 → INVALID（schema 是契约不是建议书）',
    bad.status === 'invalid' && bad.content.includes('未知参数'), bad.content.slice(0, 80));
  const empty = await call('symbols', { name: '   ', path: T });
  check('空名字 → INVALID（空白当缺参）', empty.status === 'invalid', empty.content.slice(0, 60));

  // 命中上限
  const manyDir = path.join(tmp, 'many');
  fs.mkdirSync(manyDir, { recursive: true });
  for (let f = 0; f < 3; f++) {
    fs.writeFileSync(path.join(manyDir, `m${f}.ts`), Array.from(
      { length: 30 }, (_, i) => `export function alpha${f}x${i}() {}\nexport const alpha = ${i};`).join('\n'));
  }
  const capped = await call('symbols', { name: 'alpha', path: manyDir });
  check(`命中撞上限 ${SYMBOL_MAX_HITS} 时明确回一句"命中达上限"`,
    capped.content.includes(`命中达上限 ${SYMBOL_MAX_HITS} 已停止`), capped.content.split('\n')[0] ?? '');
  check(`撞上限时抬头报的就是 ${SYMBOL_MAX_HITS} 条（不是"报满了还继续读"）`,
    capped.content.includes(`找到 ${SYMBOL_MAX_HITS} 处定义`), capped.content.split('\n')[0] ?? '');
}

/* ══════════════════════════════════════════════════════════════════════════════
   ⑥ 遍历器本体 + 源码守护
   ══════════════════════════════════════════════════════════════════════════════ */

console.log('\n⑥ 遍历器本体（grep 与 symbols 共用的那一份）');

{
  check('SKIP_DIRS 仍是三个底线目录', SKIP_DIRS.size === 3 && SKIP_DIRS.has('.git')
    && SKIP_DIRS.has('node_modules') && SKIP_DIRS.has('dist'));

  check('readForScan：读得动就给 Buffer', (() => {
    const r = readForScan(path.join(tmp, 'a.ts'));
    return r.ok && r.buf.length > 0;
  })());
  check('readForScan：含 NUL 的判二进制', (() => {
    const r = readForScan(path.join(tmp, 'bin.ts'));
    return !r.ok && r.reason === 'binary';
  })());
  check('readForScan：超体积的判 big', (() => {
    const r = readForScan(path.join(tmp, 'big.ts'));
    return !r.ok && r.reason === 'big';
  })());
  check('readForScan：不存在 / 是目录 → unreadable（读不动只算这一个文件）', (() => {
    const r = readForScan(path.join(tmp, 'no-such-file'));
    const d = readForScan(tmp);
    return !r.ok && r.reason === 'unreadable' && !d.ok && d.reason === 'unreadable';
  })());
  check('readForScan：体积上限是可传的（口径只有一处，调用方不能各写各的）', (() => {
    const r = readForScan(path.join(tmp, 'a.ts'), 1);
    return !r.ok && r.reason === 'big';
  })());

  // accept 只在目录路上生效 —— 用**独立的小目录**验，别拿上面那棵大树（它的文件数会随
  // 别的用例变，断言"filtered 恰好是 1"就会跟着飘）
  const onlyPy = path.join(tmp, 'onlypy');
  fs.mkdirSync(onlyPy, { recursive: true });
  fs.writeFileSync(path.join(onlyPy, 'a.py'), 'def alpha():\n    pass\n');
  fs.writeFileSync(path.join(onlyPy, 'b.ts'), 'export function alpha() {}\n');
  const seen: string[] = [];
  const stats = scanPaths({
    root: onlyPy, isDir: true, ignoreRules: [],
    accept: (n) => n.endsWith('.py'),
    onFile: (abs) => { seen.push(path.basename(abs)); },
  });
  check('accept 挡掉的文件计入 filtered，不进 scanned', stats.filtered === 1 && seen.length === 1
    && seen[0] === 'a.py', `${seen.join(',')} / filtered=${stats.filtered}`);
  check('scanPaths 报的 scanned 与真读的个数一致', stats.scanned === seen.length);

  const asFile = scanPaths({ root: path.join(tmp, 'notes.md'), isDir: false, onFile: () => {} });
  check('root 是文件时：accept 不参与（点名了就不套过滤）', asFile.scanned === 1 && asFile.filtered === 0);
  check('root 是文件时 stopped 为假（一次读完就收工，不是被 cap 停下的）', asFile.stopped === false);

  const stop = scanPaths({ root: onlyPy, isDir: true, onFile: () => false });
  check('onFile 返回 false 会立刻停止（命中够了的 cap 靠它）',
    stop.stopped === true && stop.scanned === 1, `scanned=${stop.scanned}`);

  const capped2 = scanPaths({ root: onlyPy, isDir: true, maxFiles: 1, onFile: () => {} });
  check('maxFiles 到点即停（防误指向盘根）', capped2.scanned === 1 && capped2.stopped);

  const noAccept = scanPaths({ root: onlyPy, isDir: true, onFile: () => {} });
  check('不给 accept 时不过滤任何文件（grep 的缺省就是"全收"）',
    noAccept.filtered === 0 && noAccept.scanned === 2);
}

console.log('\n⑥ 源码守护（手段钉死：换成等价实现也要知道动了哪）');

{
  const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
  const symSrc = read('src/search/symbols.ts');
  const walkSrc = read('src/search/walk.ts');
  const builtinRaw = read('src/tools/builtin.ts');
  const builtinSrc = stripComments(builtinRaw);

  check('G1 symbols.ts **零 import**（判据能脱离磁盘逐条打靶，全靠 ① 段穷举）',
    !/^import\s/m.test(symSrc) && !/require\(/.test(symSrc));
  check('G2 symbols.ts 不碰 fs、不起进程（它是判据不是探针）',
    !/node:fs|child_process|readFileSync|readdirSync|existsSync/.test(symSrc));
  // 10.7.2 加了 references.ts（引用查找的判据）后这里从两个模块变三个：
  // 判据仍是"碰 fs 的只有 walk.ts 那一份"——模块数是手段，单一探针才是意图
  check('G3 search/ 下三个模块（symbols / references 判据 + walk 探针），且碰 fs 的只有 walk.ts',
    fs.readdirSync(path.join(ROOT, 'src/search')).filter((f) => f.endsWith('.ts')).sort().join(',')
      === 'references.ts,symbols.ts,walk.ts'
    && !/node:fs/.test(symSrc) && /node:fs/.test(walkSrc));
  check('G4 grep 段与 symbols 段都不自己读文件（"读文件 + 体检"只有 walk.ts 那一份）', (() => {
    const blocks = [builtinCode('grep'), builtinCode('symbols')];
    return blocks.every((b) => b !== '' && !/readFileSync\(|readdirSync\(/.test(b))
      && (walkSrc.match(/export function readForScan\(/g) ?? []).length === 1;
  })());

  // 10.7.2 加了第三个消费者 refs —— 数字跟着长是刻意的：这条钉的是"不许各写一份遍历"，
  // 每加一个走内容扫描的工具都必须回到这里把理由写清（同 verify-tools G12 的口径）
  check('G5 grep / symbols / refs **三个** handler 都走同一份 scanPaths（不许各写一份遍历）',
    (builtinSrc.match(/scanPaths\(/g) ?? []).length === 3,
    String((builtinSrc.match(/scanPaths\(/g) ?? []).length));
  check('G6 跳过表字面量只此一处（walk.ts），builtin 里不再抄第二份 —— 10.7.3 那笔旧账',
    !/new Set\(\['\.git'/.test(builtinSrc)
    && /export const SKIP_DIRS[^=]*= new Set\(\['\.git', 'node_modules', 'dist'\]\)/.test(walkSrc));
  check('G7 grep 段不再有 readdirSync（遍历搬去 walk.ts；ls 的"列目录树"仍用它，那件事没动）',
    !/readdirSync\(/.test(builtinCode('grep')) && /readdirSync\(/.test(builtinCode('ls')));
  check('G8 ls 也 import 同一个 SKIP_DIRS（列目录与内容扫描的跳过表同源）',
    /import \{ SKIP_DIRS, scanPaths \} from '\.\.\/search\/walk\.js'/.test(builtinSrc)
    && /SKIP_DIRS\.has\(item\.name\)/.test(builtinSrc));
  check('G9 symbols 工具注册进 builtin（不是只写了个模块没人调）',
    builtinSrc.includes("name: 'symbols',"));
  check('G10 symbols **不要求权限**（读类工具与 ls/read/grep 同取位，弹窗只拦会改东西的动作）', (() => {
    const at = builtinCode('symbols');
    return at !== '' && !/requirePermission/.test(at);
  })());
  // ⚠ 名字里**别写死条数**（2026-09-21 实踩）：这里曾写着"名单里仍是四条"，加 `spawn` 后
  //   整条红 —— 而它真正要钉的只是"symbols 不在名单里"这一件事。条数由 `verify-plan.ts`
  //   的 A1 专有（**一份事实只该有一处判据**），这里重复一遍只会多一处要跟着改的地方。
  check('G11 symbols **不进**计划模式名单（它不改任何东西）',
    !PLAN_BLOCKED_TOOLS.has('symbols'),
    [...PLAN_BLOCKED_TOOLS].join(','));
  check('G12 symbols 的 description 明说"不是编译器"（文案回退会直接误导模型去新建同名符号）',
    builtinRaw.includes('没找到不等于这个符号不存在'));
  check('G13 symbols 的 description 说了"按 .gitignore 跳过"（否则模型以为文件不存在）',
    builtinRaw.includes('项目 .gitignore 里列出的路径'));
  check('G14 symbols 段里 toolNegative 只有一处、且是 NOT_FOUND（0 命中不许走"有效否定"）', (() => {
    const at = builtinCode('symbols');
    return at !== '' && (at.match(/toolNegative\(/g) ?? []).length === 1
      && /toolNegative\('NOT_FOUND'/.test(at);
  })());
  check('G15 模块头工具数改到 19（不是\"悄悄多一个\"）', /共 19 个/.test(builtinRaw));

  /** 切出某个工具的注册段（到下一个 tools.register 为止）—— 与 verify-git-write 同一手法 */
  function builtinCode(tool: string): string {
    const at = builtinSrc.indexOf(`name: '${tool}',`);
    if (at === -1) return '';
    const next = builtinSrc.indexOf('tools.register(', at);
    return builtinSrc.slice(at, next === -1 ? undefined : next);
  }
}

/* ── 清理与汇总 ── */

fs.rmSync(tmp, { recursive: true, force: true });
check('Z1 临时目录已清理（不留垃圾在系统 tmp 里）', !fs.existsSync(tmp));

console.log(`\n结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
process.exit(failed > 0 ? 1 : 0);
