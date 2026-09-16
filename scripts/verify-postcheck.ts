/**
 * verify-postcheck.ts —— 改完自检（ROADMAP 10.6.2）
 *
 * 为什么需要它：这条功能的价值全在「**改动之后**那一瞬间，模型眼前有没有那句结论」。
 * 而它有三个容易悄悄失效的位置，本套件逐个钉死：
 *   ① 配置解析 —— 「声明即授权」的前提是**读不懂就不跑**。放宽一处（比如把坏 timeoutMs
 *      兜回默认）就等于用一条用户没写全的配置去执行命令，方向刚好反了。
 *   ② 摘要截断 —— 自检输出上不封顶（一个 tsc 能吐几千行）。不截断就会把上下文灌爆，
 *      而这是**静默**发生的：工具照常回 [OK]，模型与用户都看不出字被吃了。
 *   ③ 接线位置 —— 结果必须落在 write / edit 的**工具 handler** 里。落在 after_tool_call
 *      钩子里代码照样能跑、日志照样有，但返回值没人消费 → 是一道**永远不生效的假防线**。
 *
 * 验什么（手段与行为分开钉）：
 *   ① 配置解析 —— 逐形状（缺字段 / 错类型 / 越界 / 非 JSON / 非对象 / 空白）
 *   ② 输出摘要 —— 空 / 单行 / 恰好等于上限 / 超一行 / 差量计数 / stdout 先 stderr 后
 *   ③ 结论渲染 —— 通过 / 未通过（含退出码与摘要）/ 超时 / 输出超缓冲 / 起不来 / 被信号中止
 *   ④ 内存单例 —— set / get / clear（测试卫生：模块级单例会跨套件残留）
 *   ⑤ 源码守护 —— 纯模块零 import；main.ts **只读一次**（运行期不回读）；两个 handler 都接；
 *      追加用空行分隔
 *   ⑥ 行为证明 —— 真起子进程跑成功 / 失败 / 命令不存在 / 超时四种结局；
 *      以及端到端：用真 write 工具写文件，断言结果里带不带 [项目自检]，
 *      且**没登记时与没接此功能时逐字一致**（默认态零行为变化）
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-postcheck.ts
 *      （npm run verify 会自动发现本文件，无需登记）
 * 退出码：failed > 0 → 1
 *
 * 环境依赖：⑥ 段要真的 node（跑的是 `node xxx.mjs`）。这是本仓的硬前提（本来就是 Node 项目）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolRegistry } from '../src/tools/registry.js';
import { registerBuiltinTools } from '../src/tools/builtin.js';
import {
  DEFAULT_POSTCHECK_TIMEOUT_MS, POSTCHECK_FILE, POSTCHECK_MAX_LINES, POSTCHECK_TAG,
  POSTCHECK_TAIL_LINES, POSTCHECK_TIMEOUT_MAX_MS, POSTCHECK_TIMEOUT_MIN_MS,
  POSTCHECK_MAX_COMMANDS, POSTCHECK_MAX_DIAGNOSTICS,
  collectDiagnosticKeys, collectRunKeys, describePostcheck, describePostcheckAll,
  diagnosticKey, isRunPassed, parseDiagnosticLine, parseDiagnostics, parsePostcheckConfig,
  postcheckBaseline, postcheckRegistry, summarizeByDiagnostics, summarizePostcheckOutput,
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

/** 抹掉注释再查（本仓已多次踩"源码文本断言被自己的说明文字判红"） */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const ok = (text: string): string => JSON.stringify(text.slice(0, 90));

/* ═══════════════════════════════════════════════════════════════════════════════
   ① 配置解析：严格 —— 读不懂就不启用
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n① 配置解析（严格：存疑一律不启用 = 没授权）');

check('A1 合法配置 → 命令与显式超时都取到',
  JSON.stringify(parsePostcheckConfig('{"command":"npm run typecheck","timeoutMs":30000}'))
  === JSON.stringify({
    commands: ['npm run typecheck'],
    timeoutMs: 30000,
    totalTimeoutMs: 30000,
  }));
check('A2 省略 timeoutMs → 用默认值',
  parsePostcheckConfig('{"command":"npm test"}')?.timeoutMs === DEFAULT_POSTCHECK_TIMEOUT_MS);
check('A3 command 前后空白被 trim（宽容的两处之一）',
  parsePostcheckConfig('{"command":"  npm test  "}')?.commands?.[0] === 'npm test');
check('A4 额外字段被忽略（宽容的两处之二）',
  parsePostcheckConfig('{"command":"npm test","note":"hello"}')?.commands?.[0] === 'npm test');

check('A5 不是字符串（undefined）→ null', parsePostcheckConfig(undefined) === null);
check('A6 空串 / 纯空白 → null',
  parsePostcheckConfig('') === null && parsePostcheckConfig('   \n ') === null);
check('A7 非 JSON → null（不是把原文当命令用）', parsePostcheckConfig('npm test') === null);
check('A8 JSON 数组 → null', parsePostcheckConfig('["npm test"]') === null);
check('A9 JSON 字符串 → null', parsePostcheckConfig('"npm test"') === null);
check('A10 JSON null → null', parsePostcheckConfig('null') === null);
check('A11 裸对象 {} → null（缺 command）', parsePostcheckConfig('{}') === null);
check('A12 command 是空串 → null', parsePostcheckConfig('{"command":""}') === null);
check('A13 command 是纯空白 → null', parsePostcheckConfig('{"command":"   "}') === null);
check('A14 command 不是字符串（数字）→ null', parsePostcheckConfig('{"command":123}') === null);

check('A15 timeoutMs 不是数字（字符串）→ null（**不兜回默认**：存疑即不跑）',
  parsePostcheckConfig('{"command":"npm test","timeoutMs":"30000"}') === null);
check('A16 timeoutMs 是小数 → null（只收整数毫秒）',
  parsePostcheckConfig('{"command":"npm test","timeoutMs":1500.5}') === null);
check('A17 timeoutMs 低于下界 → null',
  parsePostcheckConfig(`{"command":"npm test","timeoutMs":${POSTCHECK_TIMEOUT_MIN_MS - 1}}`) === null);
check('A18 timeoutMs 高于上界 → null',
  parsePostcheckConfig(`{"command":"npm test","timeoutMs":${POSTCHECK_TIMEOUT_MAX_MS + 1}}`) === null);
check('A19 timeoutMs 恰在下界 / 上界 → 接受（边界是闭区间）',
  parsePostcheckConfig(`{"command":"npm test","timeoutMs":${POSTCHECK_TIMEOUT_MIN_MS}}`)?.timeoutMs
    === POSTCHECK_TIMEOUT_MIN_MS
  && parsePostcheckConfig(`{"command":"npm test","timeoutMs":${POSTCHECK_TIMEOUT_MAX_MS}}`)?.timeoutMs
    === POSTCHECK_TIMEOUT_MAX_MS);
check('A20 timeoutMs 是 null → null（不是"没给"）',
  parsePostcheckConfig('{"command":"npm test","timeoutMs":null}') === null);
check('A21 登记表文件名是 .flint/postcheck.json（项目级、与三件套同处）',
  POSTCHECK_FILE === '.flint/postcheck.json');

/* ═══════════════════════════════════════════════════════════════════════════════
   ② 输出摘要：掐头留尾 + 硬截断
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n② 输出摘要（掐头留尾，尾 3 行留给"共 N 个错误"这类结论）');

check('B1 完全没输出 → 一句人话，不是空串',
  summarizePostcheckOutput('', '') === '（命令没有任何输出）');
check('B2 只有空白与空行 → 同上',
  summarizePostcheckOutput('  \n\n\t\n', '') === '（命令没有任何输出）');
check('B3 单行 → 原样（不留尾随换行）', summarizePostcheckOutput('all good\n', '') === 'all good');
check('B4 CRLF 归一（Windows 构建器输出不该带 \\r）',
  summarizePostcheckOutput('a\r\nb\r\n', '') === 'a\nb');
check('B5 stdout 在前、stderr 在后（关键内容在前的工具更多）',
  summarizePostcheckOutput('OUT', 'ERR') === 'OUT\nERR');
check('B6 中间空行被丢掉',
  summarizePostcheckOutput('a\n\n\nb', '') === 'a\nb');
check('B7 行尾空白被裁（编译器常留一堆尾空格）',
  summarizePostcheckOutput('a   \nb\t', '') === 'a\nb');

const mk = (n: number): string => Array.from({ length: n }, (_, i) => `L${i + 1}`).join('\n');
const exact = summarizePostcheckOutput(mk(POSTCHECK_MAX_LINES), '');
check('B8 恰好等于上限 → 全给，不加省略行',
  exact.split('\n').length === POSTCHECK_MAX_LINES && !exact.includes('省略'));

const over = summarizePostcheckOutput(mk(POSTCHECK_MAX_LINES + 1), '');
const overLines = over.split('\n');
// 2026-09-16 改过一次语义：省略标记**占一个位置**（总行数 = 上限），不再额外突破 1 行。
// 旧实现输出 cap+1 行，与 POSTCHECK_MAX_LINES 注释里「含尾部的省略行」自相矛盾。
check('B9 超一行 → 出现省略标记，且省略行数算得对',
  over.includes(`……（中间省略 2 行）`), ok(over));
check('B10 超一行 → 总行数 = 上限（省略标记占一个位置，不额外突破），且首尾都在',
  overLines.length === POSTCHECK_MAX_LINES
  && overLines[0] === 'L1' && overLines[overLines.length - 1] === `L${POSTCHECK_MAX_LINES + 1}`);
check('B11 尾部保留的正是最后 N 行（结论行不丢）',
  overLines.slice(-POSTCHECK_TAIL_LINES).join(',')
    === [`L${POSTCHECK_MAX_LINES - 1}`, `L${POSTCHECK_MAX_LINES}`, `L${POSTCHECK_MAX_LINES + 1}`].join(','));

const small = summarizePostcheckOutput(mk(10), '', 5);
check('B12 自定义上限：总行数 = 上限，且省略计数 = 没被保留的那些行',
  small.includes('……（中间省略 6 行）') && small.split('\n').length === 5, ok(small));
check('B13 上限被设得比"尾部保留数"还小 → 不崩，且仍保留头尾',
  summarizePostcheckOutput(mk(10), '', 2).includes('……（中间省略 7 行）'));
check('B14 超长单行不会被折断（只按行切，不按字符切）',
  summarizePostcheckOutput('x'.repeat(5000), '') === 'x'.repeat(5000));
check('B15 上限常量是 30、尾保留 3（TESTING 与文档引用的就是这两个数）',
  POSTCHECK_MAX_LINES === 30 && POSTCHECK_TAIL_LINES === 3);

/* ═══════════════════════════════════════════════════════════════════════════════
   ③ 结论渲染：六种结局
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n③ 结论渲染（退出码 / error.code 两条判据的优先级）');

const run = (patch: Partial<PostcheckRun>): PostcheckRun => ({
  command: 'npm run typecheck', timeoutMs: 60000, status: 0, signal: null,
  stdout: '', stderr: '', ...patch,
});

const pass = describePostcheck(run({}));
check('C1 退出码 0 → 「通过」且带命令名',
  pass === `${POSTCHECK_TAG} 通过（npm run typecheck）`, ok(pass));

const fail = describePostcheck(run({ status: 2, stdout: 'src/a.ts(3,1): error TS1005' }));
check('C2 非零退出 → 「未通过」+ 退出码 + 摘要',
  fail.startsWith(`${POSTCHECK_TAG} 未通过（npm run typecheck，退出码 2）：`)
  && fail.includes('error TS1005'), ok(fail));
check('C3 失败时**必须明说改动已落盘**（否则模型会以为写入失败、原样重写一遍）',
  fail.includes('改动已落盘'));
check('C4 失败时给出下一步（并说明会自动重跑）',
  fail.includes('下一次写文件会自动重跑'));

const timedOut = describePostcheck(run({ status: null, signal: 'SIGTERM', errorCode: 'ETIMEDOUT' }));
check('C5 ETIMEDOUT → 「超时未完成」且报出上限毫秒',
  timedOut.includes('超时未完成') && timedOut.includes('60000ms'), ok(timedOut));
check('C6 超时也要说明改动已落盘（落盘与自检是两件事）', timedOut.includes('改动已落盘'));
check('C7 超时不会被误报成「未通过」（error.code 优先于退出码）',
  !timedOut.includes('未通过'));

const noBuf = describePostcheck(run({
  status: null, signal: 'SIGTERM', errorCode: 'ENOBUFS', stdout: 'partial output',
}));
check('C8 ENOBUFS → 「输出超过缓冲上限」且仍附上看到的开头',
  noBuf.includes('输出超过缓冲上限') && noBuf.includes('partial output'), ok(noBuf));

const spawnFail = describePostcheck(run({
  status: null, errorCode: 'SPAWN_FAILED', errorMessage: 'spawn ENOENT',
}));
check('C9 其它 error → 「没能执行」+ 原始信息',
  spawnFail.includes('没能执行') && spawnFail.includes('spawn ENOENT'), ok(spawnFail));

const killed = describePostcheck(run({ status: null, signal: 'SIGTERM' }));
check('C10 status=null 且无 error → 「没跑完」+ 信号名',
  killed.includes('没跑完') && killed.includes('SIGTERM'), ok(killed));

check('C11 每一路都带统一标记（模型与人都能一眼认出这段不是工具状态）',
  [pass, fail, timedOut, noBuf, spawnFail, killed].every((t) => t.startsWith(POSTCHECK_TAG)));
check('C12 标记不是工具状态前缀（不与 [OK] / [ERROR] 混淆，也不含 ASCII 方括号）',
  POSTCHECK_TAG === '[项目自检]');
check('C13 未通过时摘要为空也有兜底（不会出现冒号后空无一物）',
  describePostcheck(run({ status: 1 })).includes('（命令没有任何输出）'));

/* ═══════════════════════════════════════════════════════════════════════════════
   ④ 内存单例
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n④ 内存单例（运行期唯一真相源）');

check('D1 初值为 null（没登记 = 什么都不跑）', postcheckRegistry.get() === null);
postcheckRegistry.set({ commands: ['npm test'], timeoutMs: 5000, totalTimeoutMs: 5000 });
check('D2 set 后 get 取到同一份', postcheckRegistry.get()?.commands?.[0] === 'npm test');
postcheckRegistry.clear();
check('D3 clear 后回到 null', postcheckRegistry.get() === null);
postcheckRegistry.set(null);
check('D4 set(null) 与 clear 等价（harness 播种失败时就走这条路）',
  postcheckRegistry.get() === null);

/* ═══════════════════════════════════════════════════════════════════════════════
   ⑤ 源码守护：位置比实现更容易错
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n⑤ 源码守护（接线位置 + 只读一次）');

const moduleSrc = fs.readFileSync(path.join(ROOT, 'src/project/postcheck.ts'), 'utf8');
const moduleCode = stripComments(moduleSrc);
const mainCode = stripComments(fs.readFileSync(path.join(ROOT, 'src/harness/main.ts'), 'utf8'));
const builtinCode = stripComments(fs.readFileSync(path.join(ROOT, 'src/tools/builtin.ts'), 'utf8'));

check('E1 postcheck.ts 零 import（纯函数模块，解析渲染能脱离终端验）',
  !/^import /m.test(moduleCode), ok(moduleCode.slice(0, 60)));
check('E2 postcheck.ts 不碰 fs / 不起子进程（读写与起进程都在调用层）',
  !/node:(fs|child_process)/.test(moduleCode) && !/\b(spawnSync|execSync|readFileSync)\b/.test(moduleCode));
check('E3 main.ts 在启动时读了登记表',
  mainCode.includes('existsSync(POSTCHECK_FILE)') && mainCode.includes('parsePostcheckConfig('));
check('E4 main.ts 把结果播进单例',
  mainCode.includes('postcheckRegistry.set('));
check('E5 **运行期不回读**：读登记表这件事在 main.ts 里只出现一次',
  (mainCode.match(/readFileSync\(POSTCHECK_FILE/g) ?? []).length === 1);
check('E6 write 与 edit **两个** handler 都接了（`await withPostcheck(` 出现 2 次；少一个就有一半改动没自检）',
  (builtinCode.match(/await withPostcheck\(/g) ?? []).length === 2);
check('E7 追加以空行分隔（结论自成一段，不与工具正文黏在一起）',
  /`\$\{base\}\\n\\n\$\{note\}`/.test(builtinCode), ok(builtinCode.match(/withPostcheck[\s\S]{0,120}/)?.[0] ?? ''));
check('E8 自检走 spawnSync 且带 timeout（同步执行没有上限会把会话顶死）',
  builtinCode.includes('spawnSync(') && /timeout:\s*budget/.test(builtinCode));
check('E8b 每条的额度是「单条上限与总闸余额取小」—— 最后一条不会把总闸撞穿',
  /const budget = Math\.min\(config\.timeoutMs, left\)/.test(builtinCode));
check('E9 自检的 stdout/stderr 交给 decodeChildOutput（Windows 上 cmd.exe 报错是 GBK，硬解 utf-8 会乱码）',
  /asText[\s\S]{0,160}decodeChildOutput\(/.test(builtinCode));
check('E10 没登记时一字不追加（返回 null 的短路在最前面）',
  /if \(!config\) return \[\];/.test(builtinCode)
  && /if \(runs\.length === 0\) return null;/.test(builtinCode));

/* ═══════════════════════════════════════════════════════════════════════════════
   ⑥ 行为证明：真起进程 + 真用 write 工具写文件
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n⑥ 行为证明（真子进程 + 真 write 工具）');

const cwd0 = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-postcheck-'));

/** 造一个临时项目：三个检查脚本 + 一份登记表（与真实项目同形） */
fs.writeFileSync(path.join(tmp, 'pass.mjs'),
  'import fs from "node:fs";\nfs.writeFileSync("ran.marker", "ran");\nconsole.log("all good");\n');
fs.writeFileSync(path.join(tmp, 'fail.mjs'),
  'for (let i = 1; i <= 40; i++) console.log(`error line ${i}`);\nprocess.exit(2);\n');
fs.writeFileSync(path.join(tmp, 'slow.mjs'), 'setTimeout(() => {}, 2000);\n');

const registry = new ToolRegistry();
registerBuiltinTools(registry);

try {
  process.chdir(tmp);

  // ── 没登记：默认态必须**逐字**不变 ──
  postcheckRegistry.clear();
  const baseline = await registry.execute('write', { path: 'a.txt', content: 'hello\n' });
  check('F1 没登记时，write 结果里没有自检段（默认态零行为变化）',
    !baseline.content.includes(POSTCHECK_TAG), ok(baseline.content));
  check('F2 没登记时状态仍是 ok', baseline.status === 'ok');
  check('F3 没登记时正文与接此功能前逐字一致',
    baseline.content === '[OK] 写入成功: a.txt (6 字符, 2 行)', ok(baseline.content));

  // ── 登记成功命令 ──
  postcheckRegistry.set({ commands: ['node pass.mjs'], timeoutMs: 60000, totalTimeoutMs: 60000 });
  const okRes = await registry.execute('write', { path: 'a.txt', content: 'hello\n' });
  check('F4 登记后 write 结果末尾追加了自检段',
    okRes.content.includes(POSTCHECK_TAG), ok(okRes.content));
  check('F5 通过时是「通过」+ 命令名',
    okRes.content.includes(`${POSTCHECK_TAG} 通过（node pass.mjs）`), ok(okRes.content));
  check('F6 真跑到了子进程（不是凭空报通过）—— 脚本自己写了标记文件',
    fs.existsSync(path.join(tmp, 'ran.marker')), ok(String(fs.existsSync(path.join(tmp, 'ran.marker')))));
  check('F7 自检结论**不改**工具状态（落盘成功就是 ok，自检是附加情报）',
    okRes.status === 'ok', okRes.status);
  check('F8 自检段在正文之后、以空行分隔',
    okRes.content.startsWith('[OK] 写入成功: a.txt') && okRes.content.includes('\n\n' + POSTCHECK_TAG));

  // ── 登记失败命令 ──
  postcheckRegistry.set({ commands: ['node fail.mjs'], timeoutMs: 60000, totalTimeoutMs: 60000 });
  const failRes = await registry.execute('write', { path: 'b.txt', content: 'x\n' });
  check('F9 失败命令 → 「未通过」+ 真实退出码 2',
    failRes.content.includes(`${POSTCHECK_TAG} 未通过（node fail.mjs，退出码 2）`), ok(failRes.content));
  check('F10 40 行的输出被截断（不会把上下文灌爆）',
    !failRes.content.includes('error line 30') && failRes.content.includes('中间省略'),
    ok(failRes.content.slice(-160)));
  check('F11 尾部结论行被保留（第 40 行还在）',
    failRes.content.includes('error line 40'));
  check('F12 失败也不改状态（写入本身是成功的）', failRes.status === 'ok');

  // ── 命令不存在 ──
  postcheckRegistry.set({ commands: ['definitely_not_a_command_xyz --version'], timeoutMs: 60000, totalTimeoutMs: 60000 });
  const missing = await registry.execute('write', { path: 'c.txt', content: 'x\n' });
  check('F13 命令不存在 → 报「未通过」并带上 shell 的报错（不抛异常、不静默）',
    missing.content.includes(`${POSTCHECK_TAG} 未通过（definitely_not_a_command_xyz --version，退出码`)
    && missing.status === 'ok', ok(missing.content.slice(-200)));

  // ── 超时 ──
  postcheckRegistry.set({ commands: ['node slow.mjs'], timeoutMs: 1000, totalTimeoutMs: 1000 });
  const slow = await registry.execute('write', { path: 'd.txt', content: 'x\n' });
  check('F14 超时 → 「超时未完成」+ 上限 1000ms（同步执行不会把会话顶死）',
    slow.content.includes(`${POSTCHECK_TAG} 超时未完成（node slow.mjs，上限 1000ms）`), ok(slow.content.slice(-200)));
  check('F15 超时同样不改状态（写入确实成功了）', slow.status === 'ok');

  // ── edit 也接上了 ──
  postcheckRegistry.set({ commands: ['node fail.mjs'], timeoutMs: 60000, totalTimeoutMs: 60000 });
  const editRes = await registry.execute('edit', {
    path: 'a.txt', oldText: 'hello', newText: 'hello (edited)',
  });
  check('F16 edit 成功路径也追加自检段（两个写类工具都覆盖）',
    editRes.content.includes(`${POSTCHECK_TAG} 未通过`), ok(editRes.content));
  check('F17 edit 的正文仍在前（追加不覆盖原结果）',
    editRes.content.startsWith('[OK] 已替换 1 处: a.txt'));

  // ── 失败路径不跑自检（没改动就没必要验） ──
  const editFail = await registry.execute('edit', {
    path: 'a.txt', oldText: '这段原文根本不存在', newText: 'x',
  });
  check('F18 edit 定位失败（0 命中）不跑自检，且状态仍是 error',
    !editFail.content.includes(POSTCHECK_TAG) && editFail.status === 'error', ok(editFail.content.slice(0, 80)));

  const deepWrite = await registry.execute('write', { path: 'sub/dir/f.txt', content: 'x' });
  check('F19 write 到多层新目录照样自检（父目录自动创建这条路径也覆盖）',
    deepWrite.status === 'ok' && deepWrite.content.includes(POSTCHECK_TAG)
    && fs.existsSync(path.join(tmp, 'sub/dir/f.txt')), ok(deepWrite.content.slice(-90)));

  // ── 复位后立即恢复"不追加"（证明单例是唯一开关） ──
  postcheckRegistry.clear();
  const after = await registry.execute('write', { path: 'e.txt', content: 'x\n' });
  check('F20 复位登记表后立刻回到"不追加"（开关就是这个单例，没有第二处）',
    !after.content.includes(POSTCHECK_TAG) && after.content === '[OK] 写入成功: e.txt (2 字符, 2 行)',
    ok(after.content));
} finally {
  postcheckRegistry.clear();
  process.chdir(cwd0);
  // 清理要重试：**这不是测试写错了**，是 2026-09-15 探针实测到的一处平台边界 ——
  // Windows 上 spawnSync 的超时只杀掉 shell（cmd.exe），真正的孙进程还在跑，
  // 临时目录因此被锁住（EBUSY）。详见 src/project/postcheck.ts 头注的「已知边界」。
  const sleepSync = (ms: number): void => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  };
  for (let i = 0; i < 10; i++) {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
      break;
    } catch {
      sleepSync(300);
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════════════════
   ⑦ 诊断条目解析（2026-09-16 三项增强共用的地基）
   期望值全部来自 2026-09-16 的实测探针：同一份坏文件分别用默认与 --pretty 跑 tsc
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n⑦ 诊断条目解析');

const STD_LINE = 'src/a.ts(10,5): error TS2322: Type \'string\' is not assignable to type \'number\'.';
const PRETTY_LINE = "src/a.ts:10:5 - error TS2322: Type 'string' is not assignable to type 'number'.";

const dStd = parseDiagnosticLine(STD_LINE);
check('G1 认 tsc 默认格式（file / code / message 三样都取到）',
  dStd?.file === 'src/a.ts' && dStd?.code === 'TS2322'
  && dStd?.message.startsWith("Type 'string'"), JSON.stringify(dStd));

const dPretty = parseDiagnosticLine(PRETTY_LINE);
check('G2 认 tsc --pretty 格式（冒号 + 空格横杠，与默认形态不同）',
  dPretty?.file === 'src/a.ts' && dPretty?.code === 'TS2322', JSON.stringify(dPretty));

check('G3 pretty 与非 pretty 是**同一个错**（同一份代码换 TTY 不该被判成新错）',
  !!dStd && !!dPretty && diagnosticKey(dStd) === diagnosticKey(dPretty));

const dMoved = parseDiagnosticLine("src/a.ts(42,9): error TS2322: Type 'string' is not assignable to type 'number'.");
check('G4 行列号变了但错还是那个错 → 键相同（**抗行号漂移**，基线对比的承重）',
  !!dStd && !!dMoved && diagnosticKey(dStd) === diagnosticKey(dMoved));

const dOtherCode = parseDiagnosticLine("src/a.ts(10,5): error TS1000: Type 'string' is not assignable to type 'number'.");
check('G5 错误码不同 → 键不同', !!dStd && !!dOtherCode && diagnosticKey(dStd) !== diagnosticKey(dOtherCode));

const dOtherFile = parseDiagnosticLine("src/b.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.");
check('G6 文件不同 → 键不同', !!dStd && !!dOtherFile && diagnosticKey(dStd) !== diagnosticKey(dOtherFile));

check('G7 npm 的横幅行不是诊断', parseDiagnosticLine('> flint@0.1.0 typecheck') === null);
check('G8 pretty 模式回显的源码行不是诊断', parseDiagnosticLine('10 export const n: number = "x";') === null);
check('G9 pretty 模式的波浪线不是诊断', parseDiagnosticLine('                 ~') === null);
check('G10 「Found 2 errors」这类结论行不是诊断',
  parseDiagnosticLine('Found 2 errors in the same file, starting at: src/a.ts:1') === null);
check('G11 warning 不认（自检关心的是过不过得去，警告不该让它变红）',
  parseDiagnosticLine('src/a.ts(1,1): warning TS1000: whatever') === null);
check('G12 空行不是诊断', parseDiagnosticLine('   ') === null);

const prettyBlock = [
  PRETTY_LINE,
  '',
  '10 export const n: number = "x";',
  '                 ~',
  '',
  'Found 1 error.',
].join('\n');
check('G13 pretty 的六行里只挑出**一条**诊断（一坨文本 ≠ 一个错）',
  parseDiagnostics(prettyBlock, '').length === 1);

check('G14 同一条错重复出现 → 身份去重后只剩一个',
  collectDiagnosticKeys(parseDiagnostics(`${STD_LINE}\n${STD_LINE}`, '')).length === 1);
check('G15 两条不同的错 → 身份有两个',
  collectDiagnosticKeys(parseDiagnostics(`${STD_LINE}\n${STD_LINE.replace('TS2322', 'TS1000')}`, '')).length === 2);

console.log('\n⑧ 按条目摘要（错误不再被尾部结论行挤掉）');

const manyErrs = Array.from({ length: 25 }, (_, i) => `src/f${i}.ts(1,1): error TS1000: bad ${i}`);
const manyOut = `${manyErrs.join('\n')}\nFound 25 errors.`;
const sumMany = summarizePostcheckOutput(manyOut, '');
check('H1 认得出诊断时按**条目**回显（一行一个错）', sumMany.includes('bad 0'));
check('H2 报错多时不会只剩结论行 —— 按行截断时「Found 25 errors」会把真错误挤没',
  sumMany.includes('bad 19') && !sumMany.includes('Found 25 errors'));
check('H3 超出上限就说清还有几条（不静默吞掉）', sumMany.includes('还有 5 条未列出'));
check('H4 上限恰好够时不多话',
  summarizePostcheckOutput(manyErrs.slice(0, 3).join('\n'), '').includes('bad 2')
  && !summarizePostcheckOutput(manyErrs.slice(0, 3).join('\n'), '').includes('未列出'));
check('H5 一条诊断都认不出 → 退回按行摘要（fail-safe 朝「多给」倒）',
  summarizePostcheckOutput('plain line one\nplain line two', '').includes('plain line one'));
check('H6 按行兜底仍会截断（上限没被绕过）',
  summarizePostcheckOutput(Array.from({ length: 80 }, (_, i) => `L${i}`).join('\n'), '')
    .split('\n').length <= POSTCHECK_MAX_LINES);
check('H7 条目上限退化到 0 时也至少给一条（不返回空串让人以为没错）',
  summarizeByDiagnostics(parseDiagnostics(STD_LINE, ''), 0).includes('TS2322'));

console.log('\n⑨ 基线对比（只报新增的错）');

const OLD_ERR = "src/old.ts(1,1): error TS1000: 这是启动前就有的错";
const NEW_ERR = "src/new.ts(2,2): error TS2000: 这是我刚写出来的错";
const baseKeys = collectDiagnosticKeys(parseDiagnostics(OLD_ERR, ''));

const mkRun = (stdout: string, over: Partial<PostcheckRun> = {}): PostcheckRun => ({
  command: 'npm run typecheck', timeoutMs: 1000, status: 2, signal: null,
  stdout, stderr: '', ...over,
});

const onlyOld = describePostcheck(mkRun(OLD_ERR), baseKeys);
check('I1 报出来的全是旧错 → 明说「没有新增问题」（模型就不会跑去改它们）',
  onlyOld.includes('没有新增问题'), onlyOld);
check('I2 且点明是启动前就有的那几条', onlyOld.includes('启动前就有的那 1 条'));

const mixed = describePostcheck(mkRun(`${OLD_ERR}\n${NEW_ERR}`), baseKeys);
check('I3 只列**新增**的那条，旧错不刷屏',
  mixed.includes('TS2000') && !mixed.includes('TS1000'), mixed);
check('I4 说清共几条、其中几条是新增',
  mixed.includes('共 2 条') && mixed.includes('1 条是本次新增'));

check('I5 没基线（null）→ 不过滤（与接入前逐字一致）',
  describePostcheck(mkRun(`${OLD_ERR}\n${NEW_ERR}`), null).includes('TS1000'));
check('I6 基线是空的（启动前项目干净）→ 全算新增',
  describePostcheck(mkRun(NEW_ERR), []).includes('TS2000'));
check('I7 认不出诊断时**不过滤**（绝不静默吞掉看不懂的输出）',
  describePostcheck(mkRun('some unknown output'), baseKeys).includes('some unknown output'));

console.log('\n⑩ 多命令槽位');

check('J1 commands 数组 → 几条就几条',
  JSON.stringify(parsePostcheckConfig('{"commands":["npm run a","npm run b"]}')?.commands)
  === JSON.stringify(['npm run a', 'npm run b']));
check('J2 commands 只有一个元素也成立（不必为了一条去用数组）',
  parsePostcheckConfig('{"commands":["npm run a"]}')?.commands?.length === 1);
check('J3 use 也支持数组（与 command 侧对称）',
  JSON.stringify(parsePostcheckConfig('{"use":["a","b"]}', [
    { name: 'a', run: 'npm run a' }, { name: 'b', run: 'npm run b' },
  ])?.commands) === JSON.stringify(['npm run a', 'npm run b']));
check('J4 use 数组里有一个查不到 → 整份不启用（引用不到 = 没声明好）',
  parsePostcheckConfig('{"use":["a","zzz"]}', [{ name: 'a', run: 'npm run a' }]) === null);
check('J5 command 与 commands 同写 → null（不知道该听谁的）',
  parsePostcheckConfig('{"command":"a","commands":["b"]}') === null);
check('J6 command 与 use 同写 → null',
  parsePostcheckConfig('{"command":"a","use":"b"}') === null);
check('J7 三种写法都写 → null',
  parsePostcheckConfig('{"command":"a","commands":["b"],"use":"c"}') === null);
check('J8 三种写法都不写 → null（等于没声明）',
  parsePostcheckConfig('{"timeoutMs":5000}') === null);
check(`J9 超过上限 ${POSTCHECK_MAX_COMMANDS} 条 → null（再多就不是自检了）`,
  parsePostcheckConfig(`{"commands":["a","b","c","d","e","f"]}`) === null);
check('J10 空数组 → null', parsePostcheckConfig('{"commands":[]}') === null);
check('J11 数组里有空串 → null', parsePostcheckConfig('{"commands":["a",""]}') === null);
check('J12 数组里有非字符串 → null', parsePostcheckConfig('{"commands":["a",123]}') === null);
check('J13 总闸小于单条上限 → null（第一条都跑不完，配置自相矛盾）',
  parsePostcheckConfig('{"command":"a","timeoutMs":10000,"totalTimeoutMs":5000}') === null);
check('J14 总闸越界 → null',
  parsePostcheckConfig('{"command":"a","totalTimeoutMs":99999999}') === null);
check('J15 总闸非整数 → null',
  parsePostcheckConfig('{"command":"a","totalTimeoutMs":1.5}') === null);
check('J16 没配总闸 → 默认 = 条数 × 单条上限',
  parsePostcheckConfig('{"commands":["a","b"],"timeoutMs":10000}')?.totalTimeoutMs === 20000);
check('J17 默认总闸也不超过总上限（5 条 × 600s 不该配出 3000s）',
  parsePostcheckConfig(`{"commands":["a","b","c","d","e"],"timeoutMs":600000}`)?.totalTimeoutMs
  === 600000);
check('J18 单条时默认总闸正好等于单条上限（不额外放宽）',
  parsePostcheckConfig('{"command":"a","timeoutMs":30000}')?.totalTimeoutMs === 30000);

console.log('\n⑪ 多命令渲染与总闸');

const okRun = mkRun('', { status: 0 });
check('K1 单条时汇总 == 单条渲染（只登记一条的用户看到的和以前**逐字一致**）',
  describePostcheckAll([okRun], null) === describePostcheck(okRun, null));
check('K2 多条全过 → 一句「全部通过」并列出来',
  describePostcheckAll([okRun, mkRun('', { status: 0, command: 'npm run lint' })], null)
    .includes('全部通过（2 条'));
const mixRuns = describePostcheckAll([okRun, mkRun(NEW_ERR, { command: 'npm run typecheck' })], null);
check('K3 多条里有失败 → 点明「几条中几条未通过」', mixRuns.includes('2 条中 1 条未通过'), mixRuns);
check('K4 失败的那条带上真实退出码', mixRuns.includes('退出码 2'));
check('K5 退出码 0 才算过', isRunPassed(okRun) === true);
check('K6 非空退出码不算过', isRunPassed(mkRun(NEW_ERR)) === false);
check('K7 被总闸跳过（根本没跑）不算过',
  isRunPassed({ ...okRun, status: null, skipped: true }) === false);
check('K8 超时不算过', isRunPassed({ ...okRun, status: null, errorCode: 'ETIMEDOUT' }) === false);
check('K9 总闸用尽的渲染：说清「未执行」而不是「未通过」（它压根没跑）',
  describePostcheck({ ...okRun, status: null, skipped: true }, null).includes('未执行'));
check('K10 collectRunKeys 汇总多条的全部诊断',
  collectRunKeys([mkRun(OLD_ERR), mkRun(NEW_ERR)]).length === 2);

/** 「整轮收尾句」在一段渲染里出现了几次 */
const tailCount = (s: string): number => s.split('改动已落盘；先处理这些').length - 1;
const twoFail = describePostcheckAll([
  mkRun(NEW_ERR, { command: 'npm run typecheck' }),
  mkRun(NEW_ERR, { command: 'npm run lint' }),
], null);
check('K11 两条命令都失败 → 收尾句**只说一次**（曾按单条各附一遍，同一句话重复 N 次）',
  tailCount(twoFail) === 1, `出现 ${tailCount(twoFail)} 次：\n${twoFail}`);
check('K12 两条命令都失败 → 两条正文都在（修复没把谁吞掉）',
  twoFail.includes('npm run typecheck') && twoFail.includes('npm run lint'));
check('K13 单条渲染仍带收尾句（tail 默认 true，只登记一条的用户看到的没变）',
  describePostcheck(mkRun(NEW_ERR), null).includes('改动已落盘；先处理这些'));
const skippedAll = describePostcheckAll([
  mkRun(NEW_ERR, { command: 'npm run typecheck' }),
  { ...okRun, status: null, skipped: true, command: 'npm run lint' },
], null);
check('K14 总闸跳过的那条在多命令里仍说「未执行」（不是「未通过」），且不重复尾句',
  skippedAll.includes('未执行') && tailCount(skippedAll) === 1, skippedAll);

console.log('\n⑫ 源码守护（三项增强的接线）');

const mainSrc = fs.readFileSync(path.join(ROOT, 'src/harness/main.ts'), 'utf-8');
const pcSrc = fs.readFileSync(path.join(ROOT, 'src/project/postcheck.ts'), 'utf-8');
check('L1 启动时播种基线（main.ts 里调了 seedPostcheckBaseline）',
  /await seedPostcheckBaseline\(\)/.test(mainSrc));
check('L2 播种失败不影响启动（它是附加情报，不是启动的前置条件）',
  /try \{\s*await seedPostcheckBaseline\(\);?\s*\} catch/.test(mainSrc));
check('L3 注册表没登记就不采基线（没登记 = 什么都不跑）',
  /if \(!postcheckRegistry\.get\(\)\) return;/.test(builtinCode));
check('L4 builtin 里串行跑每一条（for...of，不是并发）',
  /for \(const command of config\.commands\)/.test(builtinCode));
check('L5 纯模块仍然零 import（新增的三个能力没破坏这条）',
  !/^import .*from/m.test(pcSrc.replace(/^import type .*$/gm, '')));
check('L6 基线的键**不含行列号**（含了就会因行号漂移全部误判成新错）',
  /return `\$\{d\.file\}\|\$\{d\.code\}\|\$\{d\.message\}`/.test(pcSrc));

/* ═══════════════════════════════════════════════════════════════════════════════ */

console.log('');
console.log(`结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
process.exit(failed > 0 ? 1 : 0);
