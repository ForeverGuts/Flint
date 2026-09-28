/**
 * verify-test-report.ts —— 验证结果结构化·测试器那一半（ROADMAP 10.6.3）
 *
 * 为什么需要它：这条功能的价值全在「改完文件那一瞬间，回执里有没有『哪个用例挂了、挂在哪』」。
 * 三个容易悄悄失效的位置，本套件逐个钉死：
 *   ① **认形** —— TAP 里「一行」不等于「一个用例」：名字在 `not ok` 行、位置在下面好几行的
 *      `location:` 里。认错形态的后果不是报错，是**回执里什么都没多出来**（静默退回按行摘要）。
 *   ② **认不出就别认** —— vitest / jest 那类形态本机没装、拿不到样本。凭印象写正则，认错一个
 *      文件就是「回执里挂着一条根本不存在的失败」。所以必须有一条断言钉住：**没实测过的形态
 *      返回空，不许猜**。
 *   ③ **条数要对得上** —— 摘要说「3 个用例中 2 个失败」，模型会照着这个数去找。TODO 指令、
 *      嵌套父子这两处实测形态处理错一步，条数就对不上测试器自报的 `# fail`。
 *
 * 验什么（手段与行为分开钉）：
 *   ① 解析形态 —— 单条 / 多条顺序 / 嵌套父子 / TODO·SKIP 指令 / 无位置 / 引号 / CRLF / stderr
 *   ② 认不出即空 —— vitest 形态 / 非字符串输入 / 纯编译器输出（**不许猜**）
 *   ③ 数量统计 —— 三项齐全才算 / 缺一项即 null / 带缩进 / 非数字
 *   ④ 身份键 —— 组成 / 去重 / 行号漂移不影响
 *   ⑤ 渲染 —— 位置回显 / 无位置 / 分母 / 超上限截断 / 条数以实认为准
 *   ⑥ 与 postcheck 接线 —— 两路并列 · 测试优先 · 基线过滤 · 键前缀一致 · 旧行为未变
 *   ⑦ 源码守护 —— 纯模块零 import · 不碰 fs/子进程 · 两处前缀是同一个常量
 *   ⑧ 行为证明 —— 真跑 `node --test`：**解析出的条数 = 测试器自报的 `# fail`**（恒等式）
 *
 * 样本从哪来：① 段的文本是 2026-09-28 探针实测抓下来的（WorkBuddy_Test/probe-test*.mjs），
 *   不是照着文档推的；⑧ 段每次跑都现起一个真 `node --test`，拿官方统计当 oracle。
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-test-report.ts
 *      （npm run verify 会自动发现本文件，无需登记）
 * 退出码：failed > 0 → 1
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeChildOutput, runChildInTree } from '../src/process/runner.js';
import {
  collectTestFailureKeys,
  parseTestCounts,
  parseTestFailures,
  renderTestFailure,
  summarizeTestFailures,
  testFailureKey,
  TEST_MAX_FAILURES,
} from '../src/project/test-report.js';
import {
  collectRunKeys,
  countStructured,
  describePostcheck,
  filterStructured,
  parseStructured,
  POSTCHECK_TAG,
  summarizeByDiagnostics,
  summarizePostcheckOutput,
  summarizeStructured,
  TEST_KEY_PREFIX,
  type PostcheckRun,
} from '../src/project/postcheck.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

/** 抹掉注释再查（本仓已多次踩「源码文本断言被自己的说明文字喂饱」） */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* ══════════════════════════ 样本（2026-09-28 探针实测） ══════════════════════════ */

/** 真路径 —— 回执里**应该**长这样（`C:\Users\me\probe-test.mjs`） */
const WIN_REAL = 'C:\\Users\\me\\probe-test.mjs';
/**
 * 同一个路径在 `node --test` 的 TAP 输出里的样子：**每个反斜杠写了两遍**
 * （2026-09-28 Windows 实测：`location: 'C:\\Users\\me\\probe-test.mjs:3:1'`）。
 * 样本一律用这个形态 —— 用真路径写样本，那条「折回一遍」的判据就会因为样本失真而恒绿。
 */
const WIN = 'C:\\\\Users\\\\me\\\\probe-test.mjs';

/** 一条失败 + 一条通过：`node --test probe-test.mjs`（非 TTY → TAP） */
const TAP_ONE = [
  'TAP version 13',
  '# Subtest: should fail on purpose',
  'not ok 1 - should fail on purpose',
  '  ---',
  '  duration_ms: 1.107',
  "  location: '" + WIN + ":3:1'",
  "  failureType: 'testCodeFailure'",
  '  error: |-\n    one is not two',
  '  ...',
  '# Subtest: a passing one',
  'ok 2 - a passing one',
  '  ---',
  '  ...',
  '1..2',
  '# tests 2',
  '# pass 1',
  '# fail 1',
].join('\n');

/** 两条失败（探针抓的真实顺序：先 3 行那条、再 6 行那条） */
const TAP_TWO = [
  'not ok 1 - should fail on purpose',
  '  ---',
  "  location: '" + WIN + ":3:1'",
  '  ...',
  'not ok 2 - second failing case',
  '  ---',
  "  location: '" + WIN + ":6:1'",
  '  ...',
  '# tests 3',
  '# pass 1',
  '# fail 2',
].join('\n');

/** 嵌套：内层先报，外层再报一条 `subtestsFailed`（**官方把它算进 `# fail`**） */
const TAP_NESTED = [
  '# Subtest: outer',
  '    # Subtest: inner broken',
  '    not ok 1 - inner broken',
  '      ---',
  "      location: '" + WIN + ":4:11'",
  "      failureType: 'testCodeFailure'",
  '      ...',
  '    1..1',
  'not ok 1 - outer',
  '  ---',
  "  location: '" + WIN + ":3:1'",
  "  failureType: 'subtestsFailed'",
  "  error: '1 subtest failed'",
  '  ...',
  '# tests 4',
  '# pass 0',
  '# fail 2',
].join('\n');

/** TODO 指令：`not ok` 但**不**进 `# fail` 计数 */
const TAP_TODO = [
  'not ok 1 - real broken',
  '  ---',
  "  location: '" + WIN + ":3:1'",
  '  ...',
  'not ok 2 - known broken # TODO 等上游修',
  '  ---',
  "  location: '" + WIN + ":6:1'",
  '  ...',
  'ok 3 - skipped one # SKIP',
  '  ---',
  '  ...',
  '# tests 3',
  '# pass 0',
  '# fail 1',
  '# todo 1',
  '# skipped 1',
].join('\n');

/** 认不出位置的失败：名字还在，位置两字段留空（名字本身也能定位） */
const TAP_NO_LOCATION = [
  'not ok 1 - mystery case',
  '  ---',
  "  failureType: 'testCodeFailure'",
  '  ...',
].join('\n');

/** 编译器诊断（tsc 非 pretty）—— 不属于本模块，用来钉「两路互不串味」 */
const TSC_OUT = [
  "src/a.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.",
  'Found 1 error in src/a.ts:1',
].join('\n');

/** vitest / jest 那类形态 —— **本机没装、没实测过**，必须返回空而不是猜 */
const VITEST_LIKE = [
  'FAIL  src/x.test.ts > suite > case',
  'AssertionError: expected 1 to be 2',
  '    at Object.<anonymous> (src/x.test.ts:12:34)',
  'Test Files  1 failed (1)',
  '     Tests  1 failed (1)',
].join('\n');

/* ══════════════════════════════ ① 解析形态 ══════════════════════════════ */

console.log('\n① 解析形态（样本来自探针实测）');

const one = parseTestFailures(TAP_ONE, '');
check('A1 一条失败用例被认出来', one.length === 1, `实得 ${one.length}`);
check('A2 用例名取 `-` 之后那一段', one[0]?.name === 'should fail on purpose', one[0]?.name);
check('A3 Windows 绝对路径的盘符冒号没被误切', one[0]?.file === WIN_REAL, one[0]?.file);
check('A3b TAP 里写成两遍的反斜杠折回一遍（回执里的路径跟真路径长得一样）',
  one[0]?.file === WIN_REAL && !one[0]?.file.includes('\\\\'), one[0]?.file);
check('A4 行号取倒数第二组数字（列号在最后）', one[0]?.line === 3, String(one[0]?.line));
check('A5 raw 是去缩进的原始行', one[0]?.raw === 'not ok 1 - should fail on purpose', one[0]?.raw);
check('A6 通过的用例不算失败', one.length === 1 && !one.some((f) => f.name === 'a passing one'));

const two = parseTestFailures(TAP_TWO, '');
check('A7 两条失败都认出来', two.length === 2, `实得 ${two.length}`);
check('A8 顺序保持原文顺序（不去重、不排序）',
  two[0]?.name === 'should fail on purpose' && two[1]?.name === 'second failing case');
check('A9 两条各自拿到自己的位置', two[0]?.line === 3 && two[1]?.line === 6);

const nested = parseTestFailures(TAP_NESTED, '');
check('A10 嵌套：父子两条都收（与官方 `# fail` 对齐）', nested.length === 2, `实得 ${nested.length}`);
check('A11 内层在前、外层在后（原文顺序）',
  nested[0]?.name === 'inner broken' && nested[1]?.name === 'outer');
check('A12 缩进四空格的 `not ok` 也认', nested[0]?.line === 4, String(nested[0]?.line));
check('A13 外层 `subtestsFailed` 不被丢弃（丢了就对不上官方计数）',
  nested.some((f) => f.name === 'outer'));

const todo = parseTestFailures(TAP_TODO, '');
check('A14 `# TODO` 指令的 `not ok` 不算失败', todo.length === 1, `实得 ${todo.length}`);
check('A15 留下的那条是真失败', todo[0]?.name === 'real broken', todo[0]?.name);
check('A16 用例名里的 `# TODO …` 尾巴被削掉（所以上面那条不会误收）',
  !todo.some((f) => f.name.includes('#')));
check('A17 `ok … # SKIP` 不算失败', !todo.some((f) => f.name.includes('skipped')));

const noLoc = parseTestFailures(TAP_NO_LOCATION, '');
check('A18 认不出位置时**仍收这条**（名字本身就能定位）', noLoc.length === 1);
check('A19 认不出位置时 file 为空串、line 为 0',
  noLoc[0]?.file === '' && noLoc[0]?.line === 0);

check('A20 location 用双引号包也认',
  parseTestFailures(`not ok 1 - q\n  location: "${WIN}:9:2"\n  ...`, '')[0]?.line === 9);
check('A21 CRLF 输出照样认',
  parseTestFailures(`not ok 1 - crlf\r\n  location: '${WIN}:3:1'\r\n  ...\r\n`, '').length === 1);
check('A22 输出在 stderr 里也认（stdout 在前、stderr 在后合并）',
  parseTestFailures('', TAP_ONE).length === 1);
check('A23 块没闭合（缺 `...`）也收（末尾兜底 flush）',
  parseTestFailures("not ok 1 - unclosed\n  location: '" + WIN + ":7:1'", '').length === 1);
check('A24 空名的 `not ok 1 -` 也收（名字空不是不收的理由）',
  parseTestFailures('not ok 1 - \n  ...', '').length === 1);
check('A25 名字里的 `-` 不被切掉（`not ok 1 - a - b` 取到 `a - b`）',
  parseTestFailures('not ok 1 - a - b\n  ...', '')[0]?.name === 'a - b');

/* ══════════════════ ② 认不出即空（不许猜，这是本条的命门） ══════════════════ */

console.log('\n② 认不出即空 —— 没实测过的形态不许凭印象认');

check('B1 vitest / jest 那类形态一律不认（本机没装、拿不到样本）',
  parseTestFailures(VITEST_LIKE, '').length === 0);
check('B2 纯编译器输出不认（那是诊断路的事，两路不串味）',
  parseTestFailures(TSC_OUT, '').length === 0);
check('B3 非字符串输入（null / undefined）返回空',
  parseTestFailures(null, undefined).length === 0);
check('B4 非字符串输入（数字 / 对象）返回空',
  parseTestFailures(0 as unknown as string, {} as unknown as string).length === 0);
check('B5 空串返回空', parseTestFailures('', '').length === 0);
check('B6 只有 `ok` 行（全通过）返回空',
  parseTestFailures('ok 1 - a\nok 2 - b\n# fail 0', '').length === 0);
check('B7 npm 的 `> test` 横幅不会伪造出一条失败',
  parseTestFailures('> test\n> node --test x.mjs\n\nok 1 - a', '').length === 0);

/* ══════════════════════════════ ③ 数量统计 ══════════════════════════════ */

console.log('\n③ 数量统计（三项齐全才算，半句话比不给更坏）');

const c1 = parseTestCounts(TAP_ONE, '');
check('C1 三项齐全时读出来', c1?.total === 2 && c1?.pass === 1 && c1?.fail === 1, JSON.stringify(c1));
check('C2 缺 `# fail` 返回 null（不知道失败了几个就别报）',
  parseTestCounts('# tests 2\n# pass 1', '') === null);
check('C3 缺 `# tests` 返回 null', parseTestCounts('# pass 1\n# fail 1', '') === null);
check('C4 缺 `# pass` 返回 null', parseTestCounts('# tests 2\n# fail 1', '') === null);
check('C5 完全没有统计行返回 null', parseTestCounts('nothing here', '') === null);
check('C6 统计行带缩进也认（嵌套块里的计数）',
  parseTestCounts('  # tests 4\n  # pass 0\n  # fail 2', '')?.total === 4);
check('C7 统计值不是纯数字时不认（`# fail x`）',
  parseTestCounts('# tests 2\n# pass 1\n# fail x', '') === null);
check('C8 stderr 里的统计也认', parseTestCounts('', '# tests 2\n# pass 1\n# fail 1')?.fail === 1);

/* ══════════════════════════════ ④ 身份键 ══════════════════════════════ */

console.log('\n④ 身份键（基线比对用；与诊断键同理不含行号）');

check('D1 键 = 文件 + 用例名', testFailureKey({ name: 'n', file: 'f.ts', line: 1, raw: '' }) === 'f.ts|n');
check('D2 同一条失败出现两次只留一个键',
  collectTestFailureKeys(parseTestFailures(TAP_TWO + '\n' + TAP_TWO, '')).length === 2);
check('D3 行号漂移不改变键（往文件里插一行不该把旧失败洗成新的）',
  testFailureKey({ name: 'n', file: 'f.ts', line: 1, raw: '' })
  === testFailureKey({ name: 'n', file: 'f.ts', line: 99, raw: '' }));
check('D4 不同用例名是不同的键',
  testFailureKey({ name: 'a', file: 'f.ts', line: 1, raw: '' })
  !== testFailureKey({ name: 'b', file: 'f.ts', line: 1, raw: '' }));

/* ══════════════════════════════ ⑤ 渲染 ══════════════════════════════ */

console.log('\n⑤ 渲染（给人看的摘要）');

check('E1 单条回显带位置', renderTestFailure({ name: 'n', file: 'f.ts', line: 12, raw: '' }) === '✗ n（f.ts:12）');
check('E2 认不出位置时只给名字（不编一个位置出来）',
  renderTestFailure({ name: 'n', file: '', line: 0, raw: '' }) === '✗ n');
const s2 = summarizeTestFailures(two, parseTestCounts(TAP_TWO, ''));
check('E3 有统计时报「分母」', s2.startsWith('3 个用例中 2 个失败：'), s2.split('\n')[0]);
check('E4 没统计时报条数', summarizeTestFailures(two, null).startsWith('2 个失败用例：'));
check('E5 一行一条用例', s2.split('\n').length === 3, String(s2.split('\n').length));
check('E6 超出上限时说清还差几条（不静默吞掉）',
  summarizeTestFailures(two, null, 1).includes('还有 1 条未列出'));
const capped0 = summarizeTestFailures(two, null, 0);
check('E7 上限被写成 0 时至少列一条（不产出空摘要）',
  capped0 !== '' && capped0.includes('✗') && capped0.split('\n').length === 3, capped0);
check('E8 条数以**实际认出的**为准，不自报的 `counts.fail` 顶替',
  summarizeTestFailures(two, { total: 10, pass: 0, fail: 9 }).includes('10 个用例中 2 个失败'));
check('E9 空集合返回空串（调用方据此退回按行摘要）', summarizeTestFailures([], null) === '');
check('E10 默认上限就是导出的常量', summarizeTestFailures(two, null).split('\n').length - 1 <= TEST_MAX_FAILURES);

/* ══════════════════════════ ⑥ 与 postcheck 接线 ══════════════ */

console.log('\n⑥ 与自检回执的接线（两路并列 · 测试优先 · 旧行为未变）');

const mixed = parseStructured(TSC_OUT, TAP_TWO);
check('F1 结构化同时收两类（编译器诊断 + 测试失败）',
  mixed.diagnostics.length === 1 && mixed.failures.length === 2);
check('F2 条目总数是两类之和', countStructured(mixed) === 3);

const bothWays = summarizePostcheckOutput(TSC_OUT, TAP_TWO);
check('F3 两类都有时**测试优先**（先答「哪个用例挂了」）',
  bothWays.includes('✗') && !bothWays.includes('TS2322'), bothWays.split('\n')[0]);

const tscOnly = summarizePostcheckOutput(TSC_OUT, '');
check('F4 只有编译器诊断时走诊断路径（与接本功能前逐字一致）',
  tscOnly === summarizeByDiagnostics(mixed.diagnostics), tscOnly);

const tapOnly = summarizePostcheckOutput('', TAP_TWO);
check('F5 纯测试器输出不再退回「掐头留尾」（原来会只剩 `# duration_ms` 那种尾行）',
  tapOnly.includes('✗') && !tapOnly.includes('# fail 2'), tapOnly.split('\n')[0]);
check('F6 两类都认不出时仍退回按行摘要（fail-safe 朝多给噪音倒）',
  summarizePostcheckOutput('x\ny\nz', '') === 'x\ny\nz');

const fAll = parseStructured('', TAP_TWO);
const fFiltered = filterStructured(fAll, [TEST_KEY_PREFIX + `${WIN_REAL}|should fail on purpose`]);
check('F7 基线能挡掉「启动前就挂着」的失败用例', fFiltered.failures.length === 1);
check('F8 剩下的那条是新增的', fFiltered.failures[0]?.name === 'second failing case');
check('F9 基线里只有**诊断键**时，测试失败不被误挡',
  filterStructured(fAll, ['src/a.ts|TS2322|x']).failures.length === 2);
check('F10 基线为 null（没采过）时原样返回', filterStructured(fAll, null).failures.length === 2);
check('F11 两类加起来都被挡掉时才算「没新增」', countStructured(filterStructured(fAll, [
  TEST_KEY_PREFIX + `${WIN_REAL}|should fail on purpose`,
  TEST_KEY_PREFIX + `${WIN_REAL}|second failing case`,
])) === 0);

const run: PostcheckRun = {
  command: 'npm test', timeoutMs: 60_000, status: 1, signal: null,
  stdout: '', stderr: TAP_TWO,
};
const keys = collectRunKeys([run]);
check('F12 基线键里收了测试失败，且带 `test|` 前缀',
  keys.some((k) => k.startsWith(TEST_KEY_PREFIX)));
check('F13 同一个失败跑两遍不产生两条键（去重）',
  collectRunKeys([run, run]).filter((k) => k.startsWith(TEST_KEY_PREFIX)).length === 2);
check('F14 诊断键与测试键共存于同一份基线',
  collectRunKeys([{ ...run, stdout: TSC_OUT }]).length === 3);

const desc = describePostcheck(run, null);
check('F15 回执里点明未通过 + 列出失败用例',
  desc.includes(POSTCHECK_TAG) && desc.includes('未通过') && desc.includes('✗'), desc.split('\n')[0]);
check('F16 回执里那句「改动已落盘」还在（否则模型会以为没写成功、重写一遍）',
  desc.includes('改动已落盘'));
check('F17 每条失败都带位置（模型下一步要 read 它）',
  desc.includes('probe-test.mjs:3') && desc.includes('probe-test.mjs:6'));

const descOld = describePostcheck(run, [
  TEST_KEY_PREFIX + `${WIN_REAL}|should fail on purpose`,
  TEST_KEY_PREFIX + `${WIN_REAL}|second failing case`,
]);
check('F18 全是旧失败时说「没有新增问题」并给出条数',
  descOld.includes('没有新增问题') && descOld.includes('那 2 条'), descOld);
check('F19 部分新增时报「共 N 条，其中 M 条是本次新增」',
  describePostcheck(run, [TEST_KEY_PREFIX + `${WIN_REAL}|should fail on purpose`])
    .includes('共 2 条，其中 1 条是本次新增'));
check('F20 退出码 0 时只说通过（不受新增解析影响）',
  describePostcheck({ ...run, status: 0 }, null) === `${POSTCHECK_TAG} 通过（npm test）`);
check('F21 无基线的正常失败回执不含「本次新增」那种半句话',
  !desc.includes('本次新增'));

/* ══════════════════════════════ ⑦ 源码守护 ══════════════════════════════ */

console.log('\n⑦ 源码守护');

const trSrc = stripComments(fs.readFileSync(path.join(ROOT, 'src/project/test-report.ts'), 'utf-8'));
const pcSrc = stripComments(fs.readFileSync(path.join(ROOT, 'src/project/postcheck.ts'), 'utf-8'));

check('G1 新模块零 import（同 postcheck / gitignore 的纯函数形态）',
  !/^import\s/m.test(trSrc));
check('G2 新模块不碰 fs / 子进程',
  !/\b(readFileSync|spawnSync|execSync|spawn|child_process)\b/.test(trSrc));
check('G3 postcheck 真的接了测试器那一路（不是只写了个纯函数没人调）',
  /parseTestFailures/.test(pcSrc) && /summarizeTestFailures/.test(pcSrc));
/** 取某个导出函数后面那一小段（按结构切块，不数字符距离 —— 插一个字段就红那种断言没用） */
const blockOf = (src: string, head: string): string => {
  const i = src.indexOf(head);
  return i < 0 ? '' : src.slice(i, src.indexOf('\n}', i) + 2);
};
check('G4 键前缀两处用的是同一个常量（collectRunKeys 与 filterStructured 各一处）',
  blockOf(pcSrc, 'export function collectRunKeys').includes('TEST_KEY_PREFIX')
  && blockOf(pcSrc, 'export function filterStructured').includes('TEST_KEY_PREFIX'));
// 次序断言必须**在函数体内**比 —— 全文里 summarizeByDiagnostics 先出现（它定义在前面），
// 直接比全文下标会得到一条恒真的断言（本轮变异就是这么被放过去的）。
const ssBlock = blockOf(pcSrc, 'export function summarizeStructured');
check('G5 摘要次序写在代码里：先测试、后诊断（次序即优先级）',
  ssBlock.indexOf('summarizeTestFailures') >= 0
  && ssBlock.indexOf('summarizeByDiagnostics') >= 0
  && ssBlock.indexOf('summarizeTestFailures') < ssBlock.indexOf('summarizeByDiagnostics'),
  '次序反了，或某一路压根没进这个函数');
check('G6 新模块里写明「没实测的形态不支持」（不装糊涂）',
  /vitest|jest/.test(fs.readFileSync(path.join(ROOT, 'src/project/test-report.ts'), 'utf-8')));

/* ══════════════════ ⑧ 行为证明：真跑 node --test（官方统计当 oracle） ══════════════════ */

console.log('\n⑧ 行为证明 —— 真跑 node --test，解析条数 == 自报 # fail');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-test-report-'));

const write = (name: string, body: string): string => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, body);
  return p;
};

/**
 * 真跑用的执行器 = **项目自己的 `runChildInTree`**（自检与 bash 都走它，ROADMAP 10.6.6）。
 * 不另起一套 `spawnSync` 有两个理由：① 本套件验的是「接进回执的那条路」，拿另一套写法跑
 * 出来的输出不算证据；② 同步 `spawnSync` 在部分受限环境里直接 EBUSY（本机实测），
 * 异步那条不会 —— 套件不该因为「跑它的方式」而红。
 */
async function runTest(file: string): Promise<{ out: string; status: number | null }> {
  const r = await runChildInTree({
    command: `"${process.execPath}" --test "${file}"`,
    timeoutMs: 30_000,
    maxBuffer: 1024 * 1024,
    cwd: tmp,
  });
  return {
    out: `${decodeChildOutput(r.stdout)}\n${decodeChildOutput(r.stderr)}`,
    status: r.status,
  };
}

void (async () => {
  try {
    const f1 = write('a.test.mjs', "import { test } from 'node:test';\n"
      + "import assert from 'node:assert/strict';\n"
      + "test('broken', () => { assert.equal(1, 2); });\n"
      + "test('fine', () => { assert.equal(1, 1); });\n");
    const r1 = await runTest(f1);
    const p1 = parseTestFailures(r1.out, '');
    const c1r = parseTestCounts(r1.out, '');
    check('H1 真跑：退出码非 0（测试器确实报失败）', r1.status !== 0, String(r1.status));
    check('H2 真跑：解析出的条数 == 自报 # fail（恒等式，对不上就是形态认错了）',
      c1r !== null && p1.length === c1r.fail, `解析 ${p1.length} / 自报 ${c1r?.fail}`);
    check('H3 真跑：拿到的是真文件名与真行号',
      p1[0]?.name === 'broken' && p1[0]?.file.endsWith('a.test.mjs') && p1[0]?.line === 3,
      JSON.stringify(p1[0]));
    // 最强的一条：路径必须**真能用**。TAP 里写两遍的反斜杠在 Windows 上侥幸也能 existsSync
    // （系统会折叠），但模型把它带进 shell / git 参数时会被再解释一次 —— 那种错不报错，
    // 只会静默指向别处。所以拿真机路径做严格相等，而不是"看着像"。
    check('H3b 真跑：回执里的路径与真路径**逐字符相同**（不是 TAP 里写两遍的那种）',
      p1[0]?.file === f1 && fs.existsSync(p1[0]?.file ?? ''), p1[0]?.file);

    const f2 = write('b.test.mjs', "import { test } from 'node:test';\n"
      + "import assert from 'node:assert/strict';\n"
      + "test('fine', () => { assert.equal(1, 1); });\n");
    const r2 = await runTest(f2);
    check('H4 真跑：全通过时 0 条失败、退出码 0',
      r2.status === 0 && parseTestFailures(r2.out, '').length === 0);

    const f3 = write('c.test.mjs', "import { test } from 'node:test';\n"
      + "import assert from 'node:assert/strict';\n"
      + "test('known', { todo: true }, () => { assert.equal(1, 2); });\n"
      + "test('real', () => { assert.equal(1, 2); });\n");
    const r3 = await runTest(f3);
    const p3 = parseTestFailures(r3.out, '');
    const c3 = parseTestCounts(r3.out, '');
    check('H5 真跑：TODO 不计入失败（条数仍等于自报 # fail）',
      c3 !== null && p3.length === c3.fail && !p3.some((f) => f.name === 'known'),
      `解析 ${p3.map((f) => f.name).join(',')} / 自报 ${c3?.fail}`);

    const f4 = write('d.test.mjs', "import { test } from 'node:test';\n"
      + "import assert from 'node:assert/strict';\n"
      + "test('outer', async (t) => { await t.test('inner', () => { assert.equal(1, 2); }); });\n");
    const r4 = await runTest(f4);
    const p4 = parseTestFailures(r4.out, '');
    const c4 = parseTestCounts(r4.out, '');
    check('H6 真跑：嵌套父子条数 == 自报 # fail（父的 subtestsFailed 没被丢）',
      c4 !== null && p4.length === c4.fail && p4.length > 1,
      `解析 ${p4.length} / 自报 ${c4?.fail}`);
    check('H7 真跑：摘要行数不超上限（回执塞得下）',
      summarizeTestFailures(p4, c4).split('\n').length <= TEST_MAX_FAILURES + 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('');
    console.log(`结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
    process.exit(failed > 0 ? 1 : 0);
  }
})();
