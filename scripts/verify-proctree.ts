/**
 * verify-proctree.ts —— 子进程整树终止（ROADMAP 10.6.6）
 *
 * 为什么需要它：这条功能修的是一个**看不见**的毛病 —— 超时回执照常发出去、退出码照常
 * 有值、日志里什么异常都没有，只是**命令其实还在跑**。它改盘、占端口、锁目录，而模型已经
 * 被告知"超时了"并且可能已经基于这个判断往下走了。所以验证的重点不是"回执长什么样"，
 * 而是**那些本该停下来的进程到底停了没有** —— 这里只能用真子进程验。
 *
 * 验什么（手段与行为分开钉）：
 *   ① 杀树计划 —— Windows 走 `taskkill /T`、POSIX 走负 pid 进程组；pid 无效返回 null
 *   ② 平台判据 —— 谁要 detached（不 detached 就杀到自己）
 *   ③ 失败分类 —— 起不来 / 超时 / 超缓冲 三者的优先级，且字符串与 postcheck 契约一致
 *   ④ 源码守护 —— 纯策略模块零 import；执行器不硬编码 detached、stdin 继承、用 close 结算、
 *      杀前查存活（防 pid 复用误杀）；builtin 两处都走同一个执行器
 *   ⑤ 行为证明 —— 真跑：正常 / 非零退出 / 命令不存在 / **超时两跳** / **超时三跳** /
 *      超缓冲。超时的判据是"孙进程**没能**写下标记文件"，而不是"回执里写了成功"
 *   ⑥ 收尾 —— 临时目录**一次删净**（改前要重试十次：孙进程攥着目录不放）
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-proctree.ts
 *      （npm run verify 会自动发现本文件，无需登记）
 * 退出码：failed > 0 → 1
 *
 * 环境依赖：⑤ 段要真的 node（起的是 `node xxx.cjs`）。本仓本来就是 Node 项目。
 * ⚠ 已知边界：POSIX 分支**未在本机实测**（开发机是 Windows），见 ④ 段最后一条断言 ——
 *   它把"未实测"这件事本身钉住，将来在 Linux / macOS 上跑绿了才算数。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TREE_KILL_GRACE_MS, classifyChildFailure, describeTreeKill, planTreeKill, spawnDetached,
} from '../src/process/proctree.js';
import { childFailureCode, runChildInTree } from '../src/process/runner.js';

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

const modRaw = fs.readFileSync(path.join(ROOT, 'src/process/proctree.ts'), 'utf-8');
const modCode = stripComments(modRaw);
const runnerRaw = fs.readFileSync(path.join(ROOT, 'src/process/runner.ts'), 'utf-8');
const runnerCode = stripComments(runnerRaw);
const builtinCode = stripComments(fs.readFileSync(path.join(ROOT, 'src/tools/builtin.ts'), 'utf-8'));
const postcheckCode = stripComments(fs.readFileSync(path.join(ROOT, 'src/project/postcheck.ts'), 'utf-8'));

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const j = (v: unknown): string => JSON.stringify(v);

/* ═══════════════════════════════════════════════════════════════════════════════
   ① 杀树计划（纯函数）
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n① 杀树计划（该杀谁、怎么杀）');

check('P1 Windows：taskkill /pid <shell> /T /F —— /T 是"连子孙一起"的唯一开关',
  j(planTreeKill(1234, 'win32')) === j({ kind: 'taskkill', argv: ['/pid', '1234', '/T', '/F'] }),
  j(planTreeKill(1234, 'win32')));
check('P2 POSIX：杀**负** pid —— 负号才是"整组"的意思（正 pid 只杀那一个进程）',
  j(planTreeKill(1234, 'linux')) === j({ kind: 'group', pid: -1234, signal: 'SIGKILL' }),
  j(planTreeKill(1234, 'linux')));
check('P3 macOS 同 POSIX 分支',
  j(planTreeKill(99, 'darwin')) === j({ kind: 'group', pid: -99, signal: 'SIGKILL' }));
check('P4 认不出的平台走 POSIX 分支（不是"认不出就不管"：兜底要朝向"仍然去杀"）',
  j(planTreeKill(7, 'aix')) === j({ kind: 'group', pid: -7, signal: 'SIGKILL' })
  && j(planTreeKill(7, '')) === j({ kind: 'group', pid: -7, signal: 'SIGKILL' }));

check('P5 pid 无效一律 null（没起来就是没起来，不伪造一个"杀过了"的计划）',
  planTreeKill(undefined, 'win32') === null && planTreeKill(null, 'win32') === null
  && planTreeKill(0, 'win32') === null && planTreeKill(-5, 'win32') === null
  && planTreeKill(1.5, 'win32') === null && planTreeKill('123', 'win32') === null
  && planTreeKill(NaN, 'win32') === null && planTreeKill(Infinity, 'win32') === null);
check('P6 pid = 1 是合法 pid（别把正整数一起误杀）', planTreeKill(1, 'win32') !== null);

check('P7 Windows 不 detached（/T 认父子链，与进程组无关；detached 反而会另开控制台）',
  spawnDetached('win32') === false);
check('P8 POSIX **必须** detached —— 不脱离就会与 flint 同组，杀负 pid 把自己一起带走',
  spawnDetached('linux') === true && spawnDetached('darwin') === true && spawnDetached('aix') === true);

/* ═══════════════════════════════════════════════════════════════════════════════
   ② 失败分类（纯函数）—— 字符串是对外契约，与 postcheck.ts 对齐
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n② 失败分类（折成 postcheck 的 errorCode）');

const NONE = { timedOut: false, overflow: false, spawnErrorCode: null };
check('P9 一切正常 → null（退出码才是判据）', classifyChildFailure(NONE) === null);
check('P10 超时 → ETIMEDOUT',
  classifyChildFailure({ ...NONE, timedOut: true }) === 'ETIMEDOUT');
check('P11 输出撑爆 → ENOBUFS',
  classifyChildFailure({ ...NONE, overflow: true }) === 'ENOBUFS');
check('P12 起不来优先于其它（进程根本没跑，谈不上超时或超缓冲）',
  classifyChildFailure({ timedOut: true, overflow: true, spawnErrorCode: 'ENOENT' }) === 'SPAWN_FAILED');
check('P13 两个 errorCode 与 postcheck.ts 的契约**逐字一致**（超时 / 超缓冲被特判；其余走通用分支）',
  postcheckCode.includes("'ETIMEDOUT'") && postcheckCode.includes("'ENOBUFS'")
  && /typeof errorCode === 'string'/.test(postcheckCode));

console.log('\n③ 收尾文案与宽限期');

const winPlan = planTreeKill(4321, 'win32');
const posixPlan = planTreeKill(4321, 'linux');
check('P14 taskkill 的文案点明"按进程树"与 pid',
  winPlan !== null && describeTreeKill(winPlan).includes('进程树') && describeTreeKill(winPlan).includes('4321'));
check('P15 进程组的文案点明"整组"且用绝对值（负号是给系统看的，不该吓到读者）',
  posixPlan !== null && describeTreeKill(posixPlan).includes('进程组')
  && describeTreeKill(posixPlan).includes('4321') && !describeTreeKill(posixPlan).includes('-4321'));
check('P16 宽限期是个有限的短值（0 = 等于没有兜底；几分钟 = 把超时变成卡死）',
  Number.isInteger(TREE_KILL_GRACE_MS) && TREE_KILL_GRACE_MS >= 500 && TREE_KILL_GRACE_MS <= 5000,
  String(TREE_KILL_GRACE_MS));

/* ═══════════════════════════════════════════════════════════════════════════════
   ④ 源码守护（手段）
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n④ 源码守护');

check('P17 proctree.ts 零 import（策略是纯函数，两个平台的分支都能脱离终端验）',
  !/^import /m.test(modCode), modCode.slice(0, 60));
check('P18 proctree.ts 不碰 fs / child_process（起进程与发信号都在执行器里）',
  !/node:(fs|child_process)/.test(modCode) && !/\b(spawn|spawnSync|execSync|kill)\s*\(/.test(modCode));
check('P19 执行器的 detached 由 spawnDetached(platform) 决定，不硬编码',
  /detached:\s*spawnDetached\(platform\)/.test(runnerCode));
check('P20 stdin 继承父进程（对齐 execSync；接成管道会让"等输入"的命令静默挂到超时）',
  /stdio:\s*\['inherit',\s*'pipe',\s*'pipe'\]/.test(runnerCode));
check('P21 用 close 结算而不是 exit（close 才意味着 stdio 也收干净了）',
  /child\.on\('close'/.test(runnerCode) && !/child\.on\('exit'/.test(runnerCode));
check('P22 杀树**之前**先查进程是否已退出（pid 可能已被复用，杀它就是误伤无关进程）',
  /const killTree[\s\S]{0,220}exitCode !== null \|\| child\.signalCode !== null[\s\S]{0,40}return;/.test(runnerCode));
check('P23 杀完不立刻结算，而是挂一条宽限期兜底（close 可能被攥着管道的后代卡住）',
  /\}, TREE_KILL_GRACE_MS\);/.test(runnerCode)
  && /if \(graceTimer !== null \|\| settled\) return;/.test(runnerCode));
check('P23b 兜底真的会结算（不是挂个空定时器）：标 settleForced、销毁流、再用当时的退出码 resolve',
  /settleForced = true;[\s\S]{0,200}finish\(child\.exitCode/.test(runnerCode));
check('P24 输出超限也杀树（不杀的话子进程会一直往管道里灌，内存被吃光）',
  /overflow = true; killTree\(\);/.test(runnerCode));
check('P25 bash 与自检**都**改走同一个执行器（少一处就等于留了一半的老毛病）',
  (builtinCode.match(/await runChildInTree\(/g) ?? []).length === 2);
check('P26 非法参数的 pid 不会传进计划（planTreeKill 自己兜住）—— 执行器不必重复判',
  /planTreeKill\(child\.pid, platform\)/.test(runnerCode));
check('P27 POSIX 分支「未在本机实测」这件事仍写在文件里（将来在 Linux / macOS 跑绿了再改这句）',
  /未在本机实测/.test(modRaw));

/* ═══════════════════════════════════════════════════════════════════════════════
   ⑤ 行为证明（真子进程）—— 判据是"孙进程有没有停下来"，不是"回执写得漂亮不漂亮"
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n⑤ 行为证明（真子进程）');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-proctree-'));
const marker = path.join(tmp, 'marker.txt');
const write = (name: string, body: string): string => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, body);
  return p;
};

// 两跳：shell → node（1.2 秒后写标记）
const slow = write('slow.cjs',
  `setTimeout(() => { require('fs').writeFileSync(${j(marker)}, 'x'); }, 1200);\n`
  + 'setTimeout(() => {}, 6000);\n');
// 三跳：shell → node(spawner) → node(slow)
const spawner = write('spawner.cjs',
  "const { spawn } = require('node:child_process');\n"
  + `spawn(process.execPath, [${j(slow)}], { stdio: 'ignore' });\n`
  + 'setTimeout(() => {}, 6000);\n');
const hello = write('hello.cjs',
  "process.stdout.write('hello-out\\n');\nprocess.stderr.write('hello-err\\n');\n");
const exit3 = write('exit3.cjs', 'process.exit(3);\n');
const big = write('big.cjs', "process.stdout.write('x'.repeat(300000));\n");

const runIt = (cmd: string, timeoutMs: number, maxBuffer = 1024 * 1024): Promise<Awaited<ReturnType<typeof runChildInTree>>> =>
  runChildInTree({ command: cmd, timeoutMs, maxBuffer, cwd: tmp });

const r1 = await runIt(`node "${hello}"`, 10000);
check('T1 正常命令：退出码 0，stdout 与 stderr 分别收到（不再被 execSync 吞掉 stderr）',
  r1.status === 0 && r1.stdout.toString().includes('hello-out') && r1.stderr.toString().includes('hello-err'),
  `status=${r1.status} out=${j(r1.stdout.toString().slice(0, 40))} err=${j(r1.stderr.toString().slice(0, 40))}`);
check('T2 非零退出是**数据**不是异常：status 就是真实退出码，且不算"执行器层面的失败"',
  r1 !== null && (await runIt(`node "${exit3}"`, 10000)).status === 3
  && childFailureCode(await runIt(`node "${exit3}"`, 10000)) === null);

const rMissing = await runIt('definitely-not-a-real-command-xyz', 10000);
check('T3 命令不存在走 shell 的退出码（Windows 实测：cmd 报"不是内部或外部命令"，不是 spawnError）',
  rMissing.spawnError === null && rMissing.status !== 0 && rMissing.stderr.toString().trim() !== '',
  `spawnError=${j(rMissing.spawnError)} status=${rMissing.status}`);

// ── 核心：超时到底停住了谁 ──
fs.rmSync(marker, { force: true });
const t0 = Date.now();
const rSlow = await runIt(`node "${slow}"`, 500);
const elapsed = Date.now() - t0;
check('T4 两跳超时：判定为 ETIMEDOUT 且真的发出了杀树计划',
  rSlow.timedOut && childFailureCode(rSlow) === 'ETIMEDOUT' && rSlow.killPlan !== null,
  `timedOut=${rSlow.timedOut} code=${j(childFailureCode(rSlow))} plan=${j(rSlow.killPlan?.kind)}`);
check('T5 超时**不会卡住**：返回值在"上限 + 宽限 + 余量"之内（否则超时退化成永久等待）',
  elapsed < 500 + TREE_KILL_GRACE_MS + 2000, `${elapsed}ms`);
check('T6 收尾文案与真发生的动作一致',
  rSlow.killPlan !== null && describeTreeKill(rSlow.killPlan).length > 0);
await sleep(1600);
check('T7 ★ 两跳：孙进程**没能**写下标记文件（改前它会照写 —— 这就是本条的验收判据）',
  !fs.existsSync(marker));

fs.rmSync(marker, { force: true });
const rThree = await runIt(`node "${spawner}"`, 500);
await sleep(1600);
check('T8 ★ 三跳：隔了一层的孙子同样没能写下标记文件（/T 是递归的，不是只杀一层）',
  !fs.existsSync(marker), `timedOut=${rThree.timedOut}`);

const rBig = await runIt(`node "${big}"`, 10000, 4096);
check('T9 输出超 maxBuffer：标为 ENOBUFS 且按树终止（不杀的话它会把内存吃光）',
  rBig.overflow && childFailureCode(rBig) === 'ENOBUFS' && rBig.killPlan !== null,
  `overflow=${rBig.overflow} code=${j(childFailureCode(rBig))}`);

check('T10 正常命令的 killPlan 是 null（没杀过就说没杀过）',
  r1.killPlan === null && r1.timedOut === false && r1.overflow === false);

/* ═══════════════════════════════════════════════════════════════════════════════
   ⑥ 收尾：临时目录一次删净（这条本身就是 10.6.6 的效果证明）
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n⑥ 收尾');

let removed = false;
try {
  fs.rmSync(tmp, { recursive: true, force: true });
  removed = true;
} catch { /* 下面的断言会报出来 */ }
check('Z1 临时目录**一次**删净 —— 改前这里要重试十次（孙进程攥着目录不放，EBUSY）', removed);
check('Z2 临时目录确实不在了', !fs.existsSync(tmp));

/* ═══════════════════════════════════════════════════════════════════════════════ */

console.log('');
console.log(`结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
process.exit(failed > 0 ? 1 : 0);
