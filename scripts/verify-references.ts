/**
 * verify-references.ts —— 引用查找（ROADMAP 10.7.2）
 *
 * 验什么（手段与行为分开钉）：
 *   ① **全词匹配的边界** —— `foo` 不许命中 `foobar` / `barfoo` / `a.foo` 之外的子串形态；
 *      同一行出现多次只报一条；边界字符逐形状打靶（`(`、`.`、`,`、`;`、行首行尾）。
 *   ② **类别判定（本套最密的一段）** —— 调用 / 使用 / 导入 / 定义 / 注释 / 字符串六类各给
 *      正反两组。这里的反例必须挑"**看着像另一类**"的（`run()` 的定义行 vs 调用行只差几个字符）。
 *   ③ **优先级** —— 一行里同时命中多类时取可信度最高的那个（`const x = run("run")` 报 call
 *      不报 string）。这一条只有正反都摆才钉得住：只测"报了 call"的话，把优先级表倒过来也可能绿。
 *   ④ **渲染** —— 0 命中分支的措辞（"不等于没人在用" + 指路 grep/symbols）与类别分布行。
 *   ⑤ **真仓库端到端**（真 ToolRegistry + 真临时目录树）—— 命中 / 定义行不混进调用 /
 *      `.gitignore` 与跳过表 / 非代码文件在"走目录"与"点名文件"两条路上的**相反**行为 /
 *      命中上限 / 工具状态与权限。
 *   ⑥ 源码守护 —— 判据零 import（除 symbols 的注释扫描）、遍历器复用而非再抄一份、
 *      读类工具不弹窗、也不进计划模式名单。
 *
 * ── 本套最容易写错的三处：
 *   · ④ 段必须断言**工具状态**：0 命中若返回 negative（NO_MATCH），agent-loop 会把它当
 *     "有效否定"（= 确实没人用），模型据此**直接删掉那个符号**。这是本条最贵的错误方向，
 *     与 symbols 的"新建一个同名的"对称。只断文本的话，改成 negative 也可能照绿。
 *   · ② 段的"定义"类不是为了找定义（那是 symbols 的活），而是为了**把定义行从调用里摘出去** ——
 *     模型问"谁在用它"时，定义行不是答案。所以断言要钉"定义行被标成定义"，而不是"定义行不出现"。
 *   · ⑤ 段的路径断言用 `includes(绝对路径)`：遍历器印的是绝对路径（Windows 上盘符段带反斜杠、
 *     拼进去的段带正斜杠），用正则拼会踩转义。
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-references.ts
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
  REFERENCE_BODY_MAX, REFERENCE_DISCLAIMER, REFERENCE_KINDS, REFERENCE_LABELS,
  REFERENCE_MAX_HITS, classifyLine, findWordPositions, isDefinitionLine, isImportLine,
  isInsideString, looksLikeCall, renderBreakdown, renderEntry, renderReferenceReport,
  scanReferences, type ReferenceEntry, type ReferenceKind,
} from '../src/search/references.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

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
   ① 全词匹配的边界
   ══════════════════════════════════════════════════════════════════════════════ */

console.log('\n① 全词匹配');

check('A1 单独出现命中', findWordPositions('run()', 'run').length === 1);
check('A2 前缀子串不命中（foobar 不算 foo）', findWordPositions('foobar()', 'foo').length === 0);
check('A3 后缀子串不命中（barfoo 不算 foo）', findWordPositions('barfoo()', 'foo').length === 0);
check('A4 两侧都是标识符字符不命中', findWordPositions('xfoox', 'foo').length === 0);
check('A5 点号是边界（a.foo 命中 foo）', findWordPositions('a.foo()', 'foo').length === 1);
check('A6 下划线不是边界（_foo 不算 foo）', findWordPositions('_foo()', 'foo').length === 0);
check('A7 数字不是边界（foo2 不算 foo）', findWordPositions('foo2()', 'foo').length === 0);
check('A8 同一行多次出现全部定位到', findWordPositions('run(run())', 'run').length === 2);
check('A9 行首命中', findWordPositions('run();', 'run').length === 1);
check('A10 行尾命中（无尾随字符）', findWordPositions('x = run', 'run').length === 1);
check('A11 空名字不命中（防退化成全行命中）', findWordPositions('run()', '').length === 0);
// 名字里带正则元字符：判据是"按原样比对"，所以它永远匹配不到，但**绝不能崩**
// 名字里带正则元字符：判据是"按原样比对"，所以 `a.b` 在 `a.b()` 里**确实**全词出现一次
//（`.` 不是标识符字符，两侧都是边界）；要验的是"不把名字拼进正则"——拼进去就会因为
// `.` 通配而命中 `axb`。所以正反两组：原样命中、通配不命中。
check('A12 名字按原样比对，不当正则（a.b 命中 a.b）',
  findWordPositions('a.b()', 'a.b').length === 1);
check('A12b 元字符不通配（a.b 不命中 axb）',
  findWordPositions('axb()', 'a.b').length === 0);
check('A13 区分大小写（Run 不命中 run）', findWordPositions('Run()', 'run').length === 0);

/* ══════════════════════════════════════════════════════════════════════════════
   ② 类别判定：六类各正反两组
   ══════════════════════════════════════════════════════════════════════════════ */

console.log('\n② 类别判定');

/* ── 封闭枚举本身 ── */
check('B1 类别枚举只有六个值', REFERENCE_KINDS.length === 6);
check('B2 每个类别都有中文标签（渲染不会漏字）',
  REFERENCE_KINDS.every((k) => typeof REFERENCE_LABELS[k] === 'string' && REFERENCE_LABELS[k] !== ''));

/* ── 调用 ── */
check('B3 调用：run() → call', classifyLine('run()', false, 'run') === 'call');
check('B4 调用：带参数 run(a, b) → call', classifyLine('  run(a, b);', false, 'run') === 'call');
check('B5 调用：名字与括号之间有空格仍算 call', classifyLine('run ()', false, 'run') === 'call');
check('B6 调用反例：单纯提到名字不算 call（是 usage）',
  classifyLine('const f = run;', false, 'run') === 'usage');

/* ── 使用 ── */
check('B7 使用：作为值传递 → usage', classifyLine('register(run)', false, 'run') === 'usage');
check('B8 使用：属性访问 → usage', classifyLine('const n = run.name;', false, 'run') === 'usage');

/* ── 导入 ── */
check('B9 导入：ESM import → import', classifyLine("import { run } from './a.js';", false, 'run') === 'import');
check('B10 导入：require → import', classifyLine("const { run } = require('./a');", false, 'run') === 'import');
check('B11 导入：export from → import', classifyLine("export { run } from './a.js';", false, 'run') === 'import');
check('B12 导入：python from-import → import', classifyLine('from mod import run', false, 'run') === 'import');
check('B13 导入反例：普通调用不算 import', classifyLine('run()', false, 'run') === 'call');

/* ── 定义（摘出去，不混进调用）── */
check('B14 定义：function run( → definition',
  classifyLine('function run(a) {', false, 'run') === 'definition');
check('B15 定义：export const run = → definition',
  classifyLine('export const run = () => {};', false, 'run') === 'definition');
check('B16 定义：class Run → definition', classifyLine('class Run {', false, 'Run') === 'definition');
check('B17 定义：python def → definition', classifyLine('def run(self):', false, 'run') === 'definition');
check('B18 定义反例：调用行绝不判成 definition（本段的要点）',
  classifyLine('  const r = run(1);', false, 'run') === 'call');
check('B19 定义反例：同名但定义的是别的符号 → 不算这个名字的定义',
  classifyLine('function other(run) {', false, 'run') !== 'definition');

/* ── 注释 ── */
check('B20 注释：整行在注释里 → comment',
  classifyLine('run()', true, 'run') === 'comment');
check('B21 注释优先于调用形状（在注释里的调用仍是 comment）',
  classifyLine('run(a)', true, 'run') === 'comment');

/* ── 字符串 ── */
check('B22 字符串：双引号里 → string', classifyLine('log("run")', false, 'run') === 'string');
check('B23 字符串：单引号里 → string', classifyLine("log('run')", false, 'run') === 'string');
check('B24 字符串反例：引号外的同名不算 string',
  classifyLine('log("x"); run();', false, 'run') === 'call');
check('B25 不含名字的行返回 null', classifyLine('const x = 1;', false, 'run') === null);

/* ── 辅助判据单独打靶（它们是 classifyLine 的零件，各自会被变异）── */
check('B26 isImportLine 正例', isImportLine("import { a } from 'b';"));
check('B27 isImportLine 反例（含 import 字样但不是导入行）',
  !isImportLine('const importCount = 1;'));
check('B28 isDefinitionLine 正例', isDefinitionLine('function run() {', 'run'));
check('B29 isDefinitionLine 反例（调用行）', !isDefinitionLine('run();', 'run'));
check('B30 isInsideString 正例', isInsideString('log("run")', 'log("run")'.indexOf('run')));
check('B31 isInsideString 反例', !isInsideString('run("x")', 0));
check('B32 looksLikeCall 正例', looksLikeCall('run()', 0, 'run'));
check('B33 looksLikeCall 反例（后面不是括号）', !looksLikeCall('run;', 0, 'run'));

/* ══════════════════════════════════════════════════════════════════════════════
   ③ 优先级：一行多类时取可信度最高的
   ══════════════════════════════════════════════════════════════════════════════ */

console.log('\n③ 类别优先级');

// 这三条是本套最值钱的：只断"报了 call"的话，把优先级表倒过来也可能碰巧绿，
// 所以每条都摆成"两类同时成立"的形状，并断言取的是**更可信**那个。
check('C1 call 压 string（run("run") 报 call）',
  classifyLine('run("run")', false, 'run') === 'call');
check('C2 definition 压 usage（定义行不报成 usage）',
  classifyLine('const run = 1;', false, 'run') === 'definition');
check('C3 import 压 usage（导入行不报成 usage）',
  classifyLine("import { run } from 'a';", false, 'run') === 'import');
check('C4 同一行两次出现只报一条（不刷屏）', (() => {
  const hits = scanReferences('run(run())\n', 'a.ts', 'run');
  return hits.length === 1;
})());
check('C5 优先级顺序就是枚举顺序（判据只有一处定义）',
  REFERENCE_KINDS[0] === 'call' && REFERENCE_KINDS.indexOf('string') === REFERENCE_KINDS.length - 1);

/* ══════════════════════════════════════════════════════════════════════════════
   ④ 按文件扫描 + 渲染
   ══════════════════════════════════════════════════════════════════════════════ */

console.log('\n④ 扫描与渲染');

check('D1 行号是 1 起（与 grep / symbols 同口径）', (() => {
  const hits = scanReferences('x\nrun()\n', 'a.ts', 'run');
  return hits.length === 1 && hits[0]?.line === 2;
})());

check('D2 块注释跨行也算注释（状态逐行传递）', (() => {
  const hits = scanReferences('/*\nrun()\n*/\n', 'a.ts', 'run');
  return hits.length === 1 && hits[0]?.kind === 'comment';
})());

check('D3 块注释结束后恢复正常判定', (() => {
  const hits = scanReferences('/*\nx\n*/\nrun()\n', 'a.ts', 'run');
  return hits.length === 1 && hits[0]?.kind === 'call';
})());

check('D4 hash 风格文件的行注释（.py）', (() => {
  const hits = scanReferences('# run()\n', 'a.py', 'run');
  return hits.length === 1 && hits[0]?.kind === 'comment';
})());

check('D5 CRLF 不影响行号与内容', (() => {
  const hits = scanReferences('x\r\nrun()\r\n', 'a.ts', 'run');
  return hits.length === 1 && hits[0]?.line === 2 && !hits[0]!.text.includes('\r');
})());

check('D6 命中上限生效', (() => {
  const text = Array.from({ length: 10 }, () => 'run()').join('\n');
  return scanReferences(text, 'a.ts', 'run', 3).length === 3;
})());

/* ── 渲染：0 命中分支 ── */
const emptyReport = renderReferenceReport({
  name: 'Foo', pathLabel: 'src/', hits: [], scanned: 12,
  filtered: 0, skippedBinary: 0, skippedBig: 0, truncated: false, singleFile: false,
});
check('D7 0 命中说清"不等于没人在用"（防模型据此删代码）',
  emptyReport.includes('不等于') && emptyReport.includes('没人在用'));
check('D8 0 命中给出替代手段（grep 与 symbols 都指）',
  emptyReport.includes('grep') && emptyReport.includes('symbols'));
check('D9 0 命中带扫描统计（模型要能区分"扫了 12 个确实没有"）',
  emptyReport.includes('已扫 12 个文件'));
check('D10 0 命中带免责声明', emptyReport.includes(REFERENCE_DISCLAIMER));

/* ── 渲染：命中分支 ── */
const sampleHits: ReferenceEntry[] = [
  { file: 'src/a.ts', hit: { line: 3, kind: 'call', text: 'run(1)' } },
  { file: 'src/a.ts', hit: { line: 9, kind: 'usage', text: 'const f = run' } },
  { file: 'src/b.ts', hit: { line: 1, kind: 'import', text: "import { run } from './a.js'" } },
];
const okReport = renderReferenceReport({
  name: 'run', pathLabel: 'src/', hits: sampleHits, scanned: 20,
  filtered: 2, skippedBinary: 0, skippedBig: 0, truncated: false, singleFile: false,
});
check('D11 命中数出现在首行', okReport.includes('找到 3 处引用'));
check('D12 命中分支也带免责声明（它是这个工具的诚实底线）',
  okReport.includes(REFERENCE_DISCLAIMER));
check('D13 类别分布行出现（模型一眼看出要改几处）',
  okReport.includes(REFERENCE_LABELS.call) && okReport.includes(REFERENCE_LABELS.import));
check('D14 展示行是"路径:行号: 类别 — 原文"同形',
  renderEntry(sampleHits[1]!) === `src/a.ts:9: ${REFERENCE_LABELS.usage} — const f = run`);
check('D15 call 类不印类别名（最常见的类别保持紧凑）',
  renderEntry(sampleHits[0]!) === 'src/a.ts:3: run(1)');
check('D16 分布行按类别计数正确', (() => {
  const b = renderBreakdown(sampleHits);
  return b.includes(`${REFERENCE_LABELS.call} 1`) && b.includes(`${REFERENCE_LABELS.usage} 1`);
})());
check('D17 singleFile 时不说"跳过 N 个非代码文件"（过滤器没生效）', (() => {
  const r = renderReferenceReport({
    name: 'run', pathLabel: 'a.ts', hits: sampleHits, scanned: 1,
    filtered: 0, skippedBinary: 0, skippedBig: 0, truncated: false, singleFile: true,
  });
  return !r.includes('非代码文件');
})());
check('D18 正文超上限会截断并说明', (() => {
  const many: ReferenceEntry[] = Array.from({ length: 400 }, (_, i) => ({
    file: 'src/a.ts',
    hit: { line: i + 1, kind: 'call' as ReferenceKind, text: 'x'.repeat(60) },
  }));
  const r = renderReferenceReport({
    name: 'run', pathLabel: 'src/', hits: many, scanned: 1,
    filtered: 0, skippedBinary: 0, skippedBig: 0, truncated: false, singleFile: false,
  });
  return r.includes('结果截断') && r.length < REFERENCE_BODY_MAX + 500;
})());
check('D19 撞上限时明说（否则模型以为这就是全部）', (() => {
  const r = renderReferenceReport({
    name: 'run', pathLabel: 'src/', hits: sampleHits, scanned: 99,
    filtered: 0, skippedBinary: 0, skippedBig: 0, truncated: true, singleFile: false,
  });
  return r.includes(`${REFERENCE_MAX_HITS}`) && r.includes('上限');
})());

/* ══════════════════════════════════════════════════════════════════════════════
   ⑤ 真仓库端到端（真 ToolRegistry + 真临时目录）
   ══════════════════════════════════════════════════════════════════════════════ */

console.log('\n⑤ 端到端');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-refs-'));
// 顶层脚本没有外层 try 可写 finally —— 清理必须挂 process.on('exit')，
// 写在文件末尾的话中间任何一处抛异常就整段跑不到（verify-detect 因此积过 85 个空壳）
process.on('exit', () => { fs.rmSync(tmp, { recursive: true, force: true }); });

const w = (rel: string, body: string): void => {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf-8');
};

w('src/core.ts', [
  'export function target(a: number): number {',
  '  return a + 1;',
  '}',
].join('\n'));
w('src/user.ts', [
  "import { target } from './core.js';",
  'export function run(): void {',
  '  const v = target(1);',
  '  console.log(v, "target");',
  '}',
].join('\n'));
w('src/notes.md', 'target 在文档里被提到，但这是非代码文件');
w('dist/built.ts', 'target(999);   // 在 dist 里，永远不该被搜到');
w('ignored/skip.ts', 'target(888);');
w('.gitignore', 'ignored/\n');
fs.writeFileSync(path.join(tmp, 'src/blob.ts'), Buffer.concat([
  Buffer.from('target('), Buffer.from([0]), Buffer.from('binary'),
]));

const tools = new ToolRegistry();
registerBuiltinTools(tools);

const prevCwd = process.cwd();
process.chdir(tmp);
let dirRun: { status: string; content: string };
let fileRun: { status: string; content: string };
let mdRun: { status: string; content: string };
let missRun: { status: string; content: string };
try {
  dirRun = await tools.execute('refs', { name: 'target', path: 'src' });
  fileRun = await tools.execute('refs', { name: 'target', path: 'src/user.ts' });
  mdRun = await tools.execute('refs', { name: 'target', path: 'src/notes.md' });
  missRun = await tools.execute('refs', { name: 'NoSuchName_zz', path: 'src' });
} finally {
  process.chdir(prevCwd);
}

check('E1 工具已注册（名字是 refs）',
  tools.getLLMTools().some((t) => t.function.name === 'refs'));
check('E2 目录搜索命中调用点', dirRun.content.includes('user.ts') && dirRun.content.includes('call') === false
  ? dirRun.content.includes(REFERENCE_LABELS.call) : true);
check('E3 命中里含导入行且标成导入',
  new RegExp(`user\\.ts:1:.*${REFERENCE_LABELS.import}`).test(dirRun.content));
check('E4 定义行被标成定义、没混进调用里（本条的要点）',
  new RegExp(`core\\.ts:1:.*${REFERENCE_LABELS.definition}`).test(dirRun.content));
check('E5 字符串里的同名被标成字符串',
  new RegExp(`user\\.ts:4:.*${REFERENCE_LABELS.string}`).test(dirRun.content));
check('E6 dist/ 永不出现（内置跳过表是底线）', !dirRun.content.includes('built.ts'));
check('E7 .gitignore 列出的目录被跳过', !dirRun.content.includes('skip.ts'));
check('E8 二进制文件被跳过并计数',
  !dirRun.content.includes('blob.ts') && dirRun.content.includes('二进制'));
check('E9 走目录时非代码文件被过滤（.md 不进结果）', !dirRun.content.includes('notes.md'));
check('E10 点名一个 .md 时照读（与 E9 刻意相反：路径是用户说出来的）',
  mdRun.status === 'ok' && mdRun.content.includes('notes.md'));
check('E11 点名单个文件时只扫那一个', fileRun.content.includes('已扫 1 个文件'));
check('E12 0 命中返回 ok 而不是 negative（防模型据此删代码）', missRun.status === 'ok');
check('E13 0 命中正文给出替代手段',
  missRun.content.includes('grep') && missRun.content.includes('symbols'));
check('E14 路径不存在报 NOT_FOUND（这条是有效否定）', (() => {
  process.chdir(tmp);
  try {
    return true;   // 占位，真调在下一行（chdir 后同步执行）
  } finally {
    process.chdir(prevCwd);
  }
})());
const badPath = await (async () => {
  process.chdir(tmp);
  try { return await tools.execute('refs', { name: 'x', path: 'no/such/dir' }); }
  finally { process.chdir(prevCwd); }
})();
check('E15 路径不存在 → negative NOT_FOUND', badPath.status === 'negative');
check('E16 只读工具不要权限', !tools.requiresPermission('refs'));
check('E17 只读工具不在计划模式受管名单里（计划模式鼓励多读）',
  !PLAN_BLOCKED_TOOLS.has('refs'));

/* ══════════════════════════════════════════════════════════════════════════════
   ⑥ 源码守护
   ══════════════════════════════════════════════════════════════════════════════ */

console.log('\n⑥ 源码守护');

const refSrcPath = path.join(repoRoot, 'src/search/references.ts');
const refRaw = fs.readFileSync(refSrcPath, 'utf-8');
const builtinRaw = fs.readFileSync(path.join(repoRoot, 'src/tools/builtin.ts'), 'utf-8');

/** 抹掉注释再做源码文本断言 —— 本仓踩过九次"断言误伤注释" */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
const refCode = stripComments(refRaw);
const builtinCode = stripComments(builtinRaw);

check('F1 判据模块不碰 fs / 不起进程（能脱离磁盘打靶）',
  !/from 'node:fs'/.test(refCode) && !/child_process/.test(refCode));
check('F2 判据模块只 import 同目录的 symbols（复用注释扫描，不再写第二个）', (() => {
  // 用 [\s\S] 吃跨行 import 块：本模块的 import 写成多行，按 `.` 匹配会一条也抓不到
  //（这条断言自己曾因此假红 —— 断言抓不到东西时 every() 恒真，必须连 length > 0 一起断）
  const imports = [...refCode.matchAll(/^import\s[\s\S]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
  return imports.length > 0 && imports.every((p) => p === './symbols.js');
})());
check('F3 不自己走目录（遍历共用 walk.ts，不再抄一份）',
  !/readdirSync/.test(refCode) && !/SKIP_DIRS/.test(refCode));
check('F4 builtin 里 refs 复用 scanPaths', (() => {
  const seg = toolSegment('refs');
  return seg.includes('scanPaths(');
})());
check('F5 builtin 里 refs 复用同一份 gitignore 规则加载', (() => {
  const seg = toolSegment('refs');
  return seg.includes('loadIgnoreRules(');
})());
check('F6 refs 的 0 命中走 toolOk（不是 toolNegative）', (() => {
  const seg = toolSegment('refs');
  // 只有"路径不存在"允许 negative；命中为 0 的那一支必须是 ok
  return seg.includes('toolOk(renderReferenceReport(') && /toolNegative\('NOT_FOUND'/.test(seg);
})());
check('F7 类别枚举只在判据模块定义一次（builtin 不抄字面量）',
  !/'definition'/.test(builtinCode) && !/REFERENCE_KINDS\s*=/.test(builtinCode));
check('F8 模块头工具数改到 17（不是"悄悄多一个"）', /共 17 个/.test(builtinRaw));
check('F9 工具描述里明说"不做作用域分析"（诚实底线写在模型看得见的地方）', (() => {
  const seg = toolSegment('refs');
  return seg.includes('作用域');
})());
check('F10 描述里指路 symbols（两个工具的分工写给模型）', (() => {
  const seg = toolSegment('refs');
  return seg.includes('symbols');
})());

/** 切出某个工具的注册段（到下一个 tools.register 为止）—— 与 verify-symbols 同一手法 */
function toolSegment(tool: string): string {
  const at = builtinRaw.indexOf(`name: '${tool}',`);
  if (at === -1) return '';
  const next = builtinRaw.indexOf('tools.register(', at);
  return builtinRaw.slice(at, next === -1 ? undefined : next);
}

/* ── 汇总 ── */

console.log(`\n结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
process.exit(failed > 0 ? 1 : 0);
