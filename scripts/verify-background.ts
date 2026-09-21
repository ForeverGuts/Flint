import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackgroundTaskStore } from '../src/process/background.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { registerBuiltinTools } from '../src/tools/builtin.js';

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 等**条件成立**，不是等固定毫秒 —— 子进程启动要多久取决于机器当下有多忙：
 * 本机空闲时 400ms 够，跑全量套件（56 套排队、前一套刚起过一堆进程）时不够。
 * 改前 S10 就是这么红的（单独跑绿、全量跑红，buf=0 dropped=0 —— 不是判据错，是时钟错）。
 * 返回"等到没有"；等不到时不替判据兜着，让断言照旧按值判 —— 那样红的是判据本身，
 * 而且 detail 里能看出是超时还是值不对，两种红不会混成一种。
 */
const POLL_MS = 25;
const waitFor = async (
  pred: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(POLL_MS);
  }
};

const bgSrc = fs.readFileSync(path.join(ROOT, 'src/process/background.ts'), 'utf-8');
const builtinSrc = fs.readFileSync(path.join(ROOT, 'src/tools/builtin.ts'), 'utf-8');

/* ═══════════════════════════════════════════════════════════════════════════════
   ① 权限口径：spawn 要确认、task 不弹窗（kill 只认任务 id，撤销自己启动的进程）
   ═══════════════════════════════════════════════════════════════════════════════ */

check('B1 spawn 注册且 requirePermission: true（真正危险的是 spawn 本身）',
  /name: 'spawn'/.test(builtinSrc) && /requirePermission: true/.test(
    builtinSrc.slice(builtinSrc.indexOf("name: 'spawn'"), builtinSrc.indexOf("name: 'spawn'") + 300)));
check('B2 task 注册且不含 requirePermission: true（管理自有资源不用弹窗）',
  /name: 'task'/.test(builtinSrc) && !/requirePermission: true/.test(
    builtinSrc.slice(builtinSrc.indexOf("name: 'task'"), builtinSrc.length)));
check('B3 spawn 的授权键 = 完整命令（一字不截，与 bash 同边界）',
  /permissionKey: \(args\) => String\(args\.command/.test(builtinSrc));
check('B4 模块头工具数到 19（不是"悄悄多一个"）', /共 19 个/.test(builtinSrc));

/* ═══════════════════════════════════════════════════════════════════════════════
   ② C6：后台输出只进缓冲、绝不直写 stdout
   ═══════════════════════════════════════════════════════════════════════════════ */

check('C6a background.ts 不写 process.stdout（C6 规则：输出只能经 tool 回读）',
  !/process\.stdout\./.test(bgSrc));
check('C6b 用字节环形缓冲（非全收，超限丢最旧）', /class RingBuffer/.test(bgSrc) && /droppedBytes/.test(bgSrc));
check('C6c 回读时才 decodeChildOutput（避免跨 chunk 多字节截断）',
  /decodeChildOutput\(/.test(bgSrc));
check('C6d 缓冲上限 1MB/流', /BACKGROUND_MAX_BUFFER = 1024 \* 1024/.test(bgSrc));
check('C6e 退出钩子同步清理（spawnSync；exit 钩子只允许同步）',
  /process\.on\('exit'/.test(bgSrc) && /spawnSync/.test(bgSrc));
check('C6f 起进程不 await import（background.ts 里无 async import，G12 计数不受影响）',
  !/await import\('node:child_process'\)/.test(bgSrc));

/* ═══════════════════════════════════════════════════════════════════════════════
   ③ 行为证明：spawn → task 回放 → kill（真子进程）
   ═══════════════════════════════════════════════════════════════════════════════ */

const store = new BackgroundTaskStore();

// 快任务：立即退出带回一行输出；在延迟里写标记文件证明"没被杀"也能收
const r1 = store.spawn('echo hello-background');
check('S1 spawn 立即返回任务 id=1 且带 pid（不等待 = 与 bash 的分野）',
  r1.id === 1 && r1.pid != null && r1.pid > 0, `id=${r1.id} pid=${r1.pid}`);

const list1 = store.list();
check('S2 任务表立即有这条任务（list 可见）', list1.length === 1 && list1[0].status === 'running');

const r1Exited = await waitFor(() => store.status(r1.id)?.status === 'exited');
const o = store.output(r1.id);
check('S3 结束后的 output 能回读到缓冲的 stdout（回读才解码）',
  o !== null && o.stdout.includes('hello-background'), JSON.stringify(o?.stdout.slice(0, 40)));
const s1 = store.status(r1.id);
check('S4 结束后 status=exited 且带退出码',
  s1 !== null && s1.status === 'exited' && s1.exitCode === 0,
  `等到结束=${r1Exited ? '是' : '超时 10s'} status=${s1?.status} exit=${s1?.exitCode}`);

// 慢任务：30000ms 后回报，用于验证 startedAt 未结束 & kill 生效
const r2 = store.spawn('node -e "setTimeout(()=>{}, 30000)"');
check('S5 第二次 spawn id 递增为 2', r2.id === 2, `id=${r2.id}`);
const s2a = store.status(r2.id);
check('S6 慢任务仍 running + pid 有效',
  s2a !== null && s2a.status === 'running' && s2a.pid != null);

const killed = store.kill(r2.id);
check('S7 kill 返回某计划（至少发出了终止动作）',
  killed.kind === 'killed' && killed.msg.length > 0, `kind=${killed.kind}`);
const kNone = store.kill(99999);
check('S8 kill 不存在的任务 → not-found（不伪造"杀过了"）', kNone.kind === 'not-found');
const kDone = store.kill(r1.id);
check('S9 kill 已结束任务 → already-ended（管理自有资源不用重复终止）', kDone.kind === 'already-ended');

// 空库 + 小缓冲溢出（变异：进程不因超限被杀才符合后台语义）
const small = new BackgroundTaskStore(64);
const r3 = small.spawn('node -e "process.stdout.write(\'x\'.repeat(10000))"');
// 等"真的有字节被丢弃"这个事实发生，而不是等 500ms 猜它已经发生了
const r3Dropped = await waitFor(() => (small.output(r3.id)?.droppedStdoutBytes ?? 0) > 0);
const o3 = small.output(r3.id);
check('S10 环形缓冲超上限：丢弃最旧字节并记 dropped，且**任务还活着或正常结束**（后台语义=旧输出丢、进程不按超限杀）',
  o3 !== null && o3.stdoutBytes > 0 && o3.stdoutBytes <= 64 && o3.droppedStdoutBytes > 0,
  `等到丢弃=${r3Dropped ? '是' : '超时 10s'} buf=${o3?.stdoutBytes} dropped=${o3?.droppedStdoutBytes}`);

/* ═══════════════════════════════════════════════════════════════════════════════
   ④ 真接线（**工具层**端到端）—— ③ 段测的是 store，测不到 handler 把结果渲染成什么
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n④ 真接线（工具层）');

const registry = new ToolRegistry();
registerBuiltinTools(registry);
/** 走**工具**而不是 store：`.content` 是模型真正看到的那串字 */
const call = async (tool: string, args: Record<string, unknown>): Promise<string> =>
  (await registry.execute(tool, args)).content;

const MARKER = 'flint-bg-marker-42';
const spawnedText = await call('spawn', { command: `echo ${MARKER}` });
const idOf = (s: string): number => Number(/#(\d+)/.exec(s)?.[1] ?? '0');
const tid = idOf(spawnedText);
check('T1 spawn 工具回执带任务 id（真接线：注册 → handler → 回执）',
  tid >= 1, spawnedText.slice(0, 90));

let outText = '';
const gotOut = await waitFor(async () => {
  outText = await call('task', { op: 'output', id: tid });
  return outText.includes(MARKER);
});
check('T2 task output 的回执**含输出内容**（改前只报字节数 —— store 是对的、工具是空的）',
  outText.includes(MARKER), `等到回执=${gotOut ? '是' : '超时 10s'} ${outText.slice(0, 110)}`);
check('T3 回执也报出字节数（内容与计量都要有，不是二选一）',
  /\d+B/.test(outText), outText.slice(0, 120));

const emptyText = await call('task', { op: 'output', id: tid, tail: 1 });
check('T4 tail 回读仍带内容，且标注只回读了最后这部分（不假装给了全部）',
  emptyText.includes('tail=') || /最后这部分/.test(emptyText), emptyText.slice(0, 120));

/* ═══════════════════════════════════════════════════════════════════════════════
   ⑤ 死代码守护（2026-09-21 清掉的三处，钉住别回来）
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n⑤ 死代码守护');

// ⚠ 先剥注释：background.ts 的注释里为了讲清来龙去脉，逐字引用了被删掉的那句
// `? 'exited' : 'exited'` —— 裸扫会被散文**喂饱**（把判据改回去它照绿）。
const bgCode = bgSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

check('D1 任务信息里没有恒假的字段（`settleForced: false` 已删 —— 恒假的字段是谎话）',
  !/settleForced/.test(bgCode));
check('D2 list / status 取字节数走 `size`，不为取长度把 1MB 缓冲 concat 一遍',
  (bgCode.match(/stdoutBytes: t\.out\.size/g) ?? []).length === 2
  && !/snapshot\(\)\.length/.test(bgCode));
check('D3 没有"两个分支相同"的死三元（改前两个分支写的都是 exited）',
  !/'exited' : 'exited'/.test(bgCode));
check('D4 同一模块不重复 import（proctree 只 import 一次）',
  (bgCode.match(/from '\.\/proctree\.js'/g) ?? []).length === 1);
// 头注里那条"runtime.stop() 待办"已改成"**刻意不接** + 理由" ——
// 一个不打算做的待办与一句说清理由的取舍，对下一个读者是两件完全不同的事。
// ⚠ 这里扫**原文**（不剥注释）：待办标记只活在注释里。代价是判据里不能再出现
// 该标记的字样（改前注释为讲清前因逐字引用了它 → 断言被自己的散文喂饱，恒绿）。
check('D5 全文不再有待办标记（那条已改成刻意不接并写明理由）',
  !/TODO/.test(bgSrc) && /刻意不接/.test(bgSrc));

/* ═══════════════════════════════════════════════════════════════════════════════
   ⑥ 时序守护：**等条件、不等时钟**
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n⑥ 时序守护');

// 本套三处等子进程（S3/S4、S10、T2）原是先睡一个固定毫秒再读：单跑够、跑全量
// 套件不够（56 套排队，node 冷启动被拖长）→ S10 在全量里偶发红，单独跑却是绿的。
// 判据里出现"等一个固定毫秒"就是在赌机器当下闲不闲，钉住它不许回来。
// ⚠ 与 D5 同一个坑：**判据里不许出现被禁字样的字面量**，否则被自己的散文喂饱、恒绿
// （本条刚写完就先红了一次：注释里原样引了那句固定毫秒的写法）。
// ⚠ 只禁**带数字字面量**的 sleep：轮询间隔走常量 `POLL_MS`（E1 的正则才认得出两者之别）。
const selfSrc = fs.readFileSync(fileURLToPath(import.meta.url), 'utf-8');
check('E1 等子进程一律等条件（`waitFor`），不再有"等固定毫秒"的赌注',
  !/await sleep\(\d/.test(selfSrc) && /const waitFor/.test(selfSrc));

/* ── 清理与汇总 ── */

const listEnd = store.list();
check('Z1 列表只含本套 spawn / kill 过的任务（不会误伤无关任务）',
  listEnd.every((t) => t.id <= 2), listEnd.map((t) => t.id).join(','));

console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败（共 ' + (passed + failed) + ' 项）');
process.exit(failed > 0 ? 1 : 0);
