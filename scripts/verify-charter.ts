/**
 * verify-charter.ts —— 项目生命周期协议：目标文档的写保护闸（ROADMAP P10.12）
 *
 * 验什么（手段与行为分开钉）：
 *   ① isContractTarget 纯函数 —— 路径判定逐形状（相对/绝对/反斜杠/大小写/`..` 绕法/子目录/非契约文件）
 *   ② guardContractWrite 纯函数 —— 该拦的拦、不该拦的放行；fail-open 边界逐形状喂。
 *      **含 bash 那一支（L1 事前闸）**：命令串里出现契约文件名即拒，不分读还是写；
 *      归一化（大小写 / 反斜杠 / 引号）逐形状钉死
 *   ③ charterLock 状态机 —— 会话级单例的开关与复位
 *   ④ **真 PromptEventEmitter 的钩子链路** —— 核心钩子真被 emitHook 收到并生效；
 *      以及一条承重断言：**核心钩子返回 deny 之后，扩展钩子返回 undefined 不会把它覆盖**
 *      （emitHook 取"最后一个非 undefined"，这条顺序性质是 main.ts 注册时机的前提）
 *   ⑤ /charter 命令 —— 假 runtime 截获注册，直接调 handler 验 unlock/lock/状态/坏参数
 *   ⑥ 源码守护 —— 接线在 main.ts 里存在且**注册在装载扩展之前**；提示词真教了这套流程；
 *      闸走的是自己的状态位（源码里不出现 permission 依赖）；受保护工具名单恰好是 write/edit；
 *      **L2 效果闸真接在 bash 工具里**（不是只写了个纯函数没人调）
 *   ⑦ **行为：bash 的效果闸（L2）** —— 真 `ToolRegistry` 跑真 bash（临时 cwd + 临时脚本，
 *      命令串**故意不提**契约文件名，用来证明 L2 覆盖了 L1 漏掉的绕法）：
 *      锁定期间动了契约 → 回滚 + 报错 + 记账；解锁后不拦；没动就一次 fs 都不写
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-charter.ts
 * 退出码：failed > 0 → 1
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHARTER_FILE,
  CHARTER_REJECTED_FILE,
  DEVLOG_FILE,
  PROJECT_FILE,
  charterLock,
  contractDrifted,
  guardContractWrite,
  isContractTarget,
  mentionsContract,
} from '../src/project/charter.js';
import { PromptEventEmitter } from '../src/runtime/events.js';
import { activate } from '../src/commands/builtin/charter.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { registerBuiltinTools } from '../src/tools/builtin.js';
import { TaskStore } from '../src/todo/store.js';
import { MemoryStore } from '../src/memory/store.js';
import { EventStore } from '../src/eventlog/store.js';
import type { Runtime } from '../src/runtime/runtime.js';

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

const CWD = process.cwd();

/* ── ① isContractTarget 纯函数 ── */
console.log('── ① isContractTarget 路径判定 ──');

check('A1 相对路径命中', isContractTarget('.flint/CHARTER.md') === true);
check('A2 ./ 前缀命中', isContractTarget('./.flint/CHARTER.md') === true);
check('A3 反斜杠命中（Windows 手写路径）', isContractTarget('.flint\\CHARTER.md') === true);
check('A4 大小写不敏感命中', isContractTarget('.FLINT/charter.md') === true);
check('A5 绝对路径命中', isContractTarget(path.join(CWD, '.flint', 'CHARTER.md')) === true);
check('A6 `..` 绕法命中（归一化后是同一文件）', isContractTarget('.flint/../.flint/CHARTER.md') === true);
check('A7 子目录同名文件**不**命中（只管 cwd 下那一个）', isContractTarget('sub/.flint/CHARTER.md') === false);
check('A8 PROJECT.md 不在闸内', isContractTarget(PROJECT_FILE) === false);
check('A9 DEVLOG.md 不在闸内', isContractTarget(DEVLOG_FILE) === false);
check('A10 普通源码文件不命中', isContractTarget('src/index.ts') === false);
check('A11 空串不命中', isContractTarget('') === false);
check('A12 显式 cwd 参数生效（路径基准可注入）', isContractTarget('/proj/.flint/CHARTER.md', '/proj') === true);

/* ── ② guardContractWrite 纯函数 ── */
console.log('── ② guardContractWrite 写保护判定 ──');

const writeCharter = { path: CHARTER_FILE, content: 'x' };
const editCharter = { path: CHARTER_FILE, oldText: 'a', newText: 'b' };

const g1 = guardContractWrite('write', writeCharter, false);
check('B1 write + 命中 + 未锁 → 拦截', g1?.action === 'deny');
check('B2 拦截理由里带解锁指引（可操作）', typeof g1?.reason === 'string' && g1.reason.includes('/charter unlock'));
const g2 = guardContractWrite('write', writeCharter, true);
check('B3 write + 命中 + 已解锁 → 放行', g2 === undefined);
const g3 = guardContractWrite('edit', editCharter, false);
check('B4 edit + 命中 + 未锁 → 拦截（两个写类工具都管）', g3?.action === 'deny');
check('B5 edit 解锁后放行', guardContractWrite('edit', editCharter, true) === undefined);
check('B6 read 命中不拦（只管写类工具）', guardContractWrite('read', { path: CHARTER_FILE }, false) === undefined);

/* ── bash 那一支：L1 事前闸（2026-09-14 补，ROADMAP 10.9.2 第一步）──
   判据是**字面文件名**而不是 shell 语义：分读写要解析 shell，那是"看着拦住了"的假安全感。
   它挡的是常见写法；拼出来的路径由 bash 工具的效果闸（L2，见 ⑦ 行为段）兜底。 */
const bashBash = { command: `echo x > ${CHARTER_FILE}` };
const gb1 = guardContractWrite('bash', bashBash, false);
check('B16 bash + 命令串提到契约 + 未锁 → 拦截（L1 事前闸）', gb1?.action === 'deny');
check('B17 bash 拦截理由给出替代路径（读用 read 工具 / 写要 unlock）',
  typeof gb1?.reason === 'string' && gb1.reason.includes('read 工具') && gb1.reason.includes('/charter unlock'));
check('B18 bash 解锁后放行', guardContractWrite('bash', bashBash, true) === undefined);
check('B19 bash 命令**不含**契约名 → 放行（这道闸不是"banned bash"）',
  guardContractWrite('bash', { command: 'node scripts/run-verify.mjs' }, false) === undefined);
check('B20 bash 参数名写错（给了 cmd 而不是 command）→ fail-open 放行',
  guardContractWrite('bash', { cmd: `echo x > ${CHARTER_FILE}` }, false) === undefined);
check('B21 bash command 非字符串 → fail-open 放行',
  guardContractWrite('bash', { command: 42 }, false) === undefined);
check('B22 bash 命令提到 DEVLOG / PROJECT → 放行（只锁目标文档）',
  guardContractWrite('bash', { command: `echo x > ${DEVLOG_FILE} && echo y > ${PROJECT_FILE}` }, false) === undefined);

check('B23 write 非契约路径放行', guardContractWrite('write', { path: 'src/a.ts' }, false) === undefined);
check('B24 write 命中 PROJECT.md 放行（现状文档不锁）', guardContractWrite('write', { path: PROJECT_FILE }, false) === undefined);
check('B25 args=null → fail-open 放行', guardContractWrite('write', null, false) === undefined);
check('B26 args=字符串 → fail-open 放行', guardContractWrite('write', 'x', false) === undefined);
check('B27 args=数字 → fail-open 放行', guardContractWrite('write', 42, false) === undefined);
check('B28 无 path 字段 → fail-open 放行', guardContractWrite('write', { content: 'x' }, false) === undefined);
check('B29 path 非字符串 → fail-open 放行', guardContractWrite('write', { path: 123 }, false) === undefined);
check('B30 path 纯空白 → fail-open 放行', guardContractWrite('write', { path: '   ' }, false) === undefined);

/* ── mentionsContract（L1 的判据本身）：归一化逐形状钉死 ──
   判据的边界就在这几行里 —— 粗到什么程度、误伤到哪一档，都写死。 */
check('B31 大小写混写命中', mentionsContract('cat .FLINT/Charter.MD') === true);
check('B32 反斜杠写法命中（Windows 手写路径）', mentionsContract('type .flint\\CHARTER.md') === true);
check('B33 双引号包住仍命中', mentionsContract('cat ".flint/CHARTER.md"') === true);
check('B34 单引号包住仍命中', mentionsContract("cat '.flint/CHARTER.md'") === true);
check('B35 只提到"契约"两个字不算命中（认的是文件名不是语义）', mentionsContract('grep -rn 契约 .flint/') === false);
check('B36 同名带后缀（.bak）**也**命中 —— 判据刻意粗，这是可接受的过度拦截',
  mentionsContract('cat .flint/CHARTER.md.bak') === true);
check('B37 提到 DEVLOG / PROJECT 不算命中', mentionsContract(`cat ${DEVLOG_FILE} ${PROJECT_FILE}`) === false);
check('B38 空串不算命中', mentionsContract('') === false);

/* ── contractDrifted（L2 的判据）：null 表示"文件当时不存在" ── */
check('B39 都不存在 → 没变', contractDrifted(null, null) === false);
check('B40 内容一致 → 没变', contractDrifted('a', 'a') === false);
check('B41 内容不同 → 变了', contractDrifted('a', 'b') === true);
check('B42 从无到有 → 变了', contractDrifted(null, 'a') === true);
check('B43 从有到无 → 变了', contractDrifted('a', null) === true);

/* ── ③ charterLock 状态机 ── */
console.log('── ③ charterLock 状态机 ──');

charterLock.reset();
check('C1 初始为锁', charterLock.isUnlocked() === false);
charterLock.unlock();
check('C2 unlock 后打开', charterLock.isUnlocked() === true);
charterLock.lock();
check('C3 lock 后回锁', charterLock.isUnlocked() === false);
charterLock.unlock();
charterLock.reset();
check('C4 reset 抹掉解锁态（供用例之间擦干净单例）', charterLock.isUnlocked() === false);

/* ── ④ 真总线钩子链路 ── */
console.log('── ④ 真 PromptEventEmitter 钩子链路 ──');

/** 与 main.ts 里那段完全同形的接线 */
function registerCoreHook(bus: PromptEventEmitter): void {
  bus.on('before_tool_call', (event) => {
    const e = event as { name?: unknown; args?: unknown };
    return guardContractWrite(
      typeof e.name === 'string' ? e.name : '',
      e.args,
      charterLock.isUnlocked(),
    );
  });
}

const bus = new PromptEventEmitter();
registerCoreHook(bus);
charterLock.reset();

const r1 = await bus.emitHook('before_tool_call', { name: 'write', args: writeCharter });
check('D1 未锁时经总线调用 → 拿到 deny 结论', (r1 as { action?: string })?.action === 'deny');

charterLock.unlock();
const r2 = await bus.emitHook('before_tool_call', { name: 'write', args: writeCharter });
check('D2 解锁后经总线调用 → 放行（undefined）', r2 === undefined);
charterLock.reset();

// 承重顺序断言：扩展钩子在后且返回 undefined，不得覆盖核心钩子的 deny
const bus2 = new PromptEventEmitter();
registerCoreHook(bus2);
bus2.on('before_tool_call', () => undefined);
const r3 = await bus2.emitHook('before_tool_call', { name: 'write', args: writeCharter });
check('D3 后注册的扩展钩子返回 undefined **不覆盖**核心 deny', (r3 as { action?: string })?.action === 'deny');

// 反向：核心放行、扩展拦截 → 扩展生效（证明"不是只管核心那一份"）
const bus3 = new PromptEventEmitter();
registerCoreHook(bus3);
bus3.on('before_tool_call', () => ({ action: 'deny', reason: '扩展拦的' }));
const r4 = await bus3.emitHook('before_tool_call', { name: 'write', args: { path: 'src/a.ts' } });
check('D4 核心放行时扩展仍能拦（两份钩子都在链上）', (r4 as { reason?: string })?.reason === '扩展拦的');

const bus4 = new PromptEventEmitter();
const r5 = await bus4.emitHook('before_tool_call', { name: 'write', args: writeCharter });
check('D5 没有注册任何钩子时返回 undefined（向后兼容）', r5 === undefined);

// 退订后不再生效 —— 证明 on 的返回值真能用
const bus5 = new PromptEventEmitter();
registerCoreHook(bus5);
const off = bus5.on('before_tool_call', () => undefined);
off();
const r6 = await bus5.emitHook('before_tool_call', { name: 'write', args: writeCharter });
check('D6 退订不了的钩子不影响核心闸', (r6 as { action?: string })?.action === 'deny');

// bash 那一支也**真走总线** —— L1 是在钩子上生效的，不是在 bash 工具里（工具里只有 L2）
const rBashDeny = await bus.emitHook('before_tool_call', { name: 'bash', args: bashBash });
check('D7 总线里 bash 提到契约 → 拿到 deny 结论', (rBashDeny as { action?: string })?.action === 'deny');
const bashReason = (rBashDeny as { reason?: string })?.reason ?? '';
check('D8 bash 这条给的是自己的指引（"用 read 工具"），不是复用 write/edit 那段文案',
  bashReason.includes('bash 命令里') && bashReason.includes('read 工具'));
charterLock.unlock();
check('D9 解锁后总线里 bash 放行',
  (await bus.emitHook('before_tool_call', { name: 'bash', args: bashBash })) === undefined);
charterLock.reset();
check('D10 总线里不含契约名的 bash 命令照常放行',
  (await bus.emitHook('before_tool_call', { name: 'bash', args: { command: 'node -v' } })) === undefined);

/* ── ⑤ /charter 命令 ── */
console.log('── ⑤ /charter 命令 ──');

interface Registered {
  name: string;
  desc: string;
  handler: (args: string) => string;
}
const registered: Registered[] = [];
const fakeRuntime = {
  registerCommand(name: string, desc: string, handler: (args: string) => string): void {
    registered.push({ name, desc, handler });
  },
} as unknown as Runtime;

charterLock.reset();
activate(fakeRuntime);
const cmd = registered.find((r) => r.name === 'charter');
check('E1 注册了名为 charter 的命令', cmd !== undefined);

const outUnlock = cmd!.handler('unlock');
check('E2 unlock 后锁真打开', charterLock.isUnlocked() === true);
check('E3 unlock 回执说明"本会话有效"', outUnlock.includes('本会话'));

const outLock = cmd!.handler('lock');
check('E4 lock 后锁真回锁', charterLock.isUnlocked() === false);
check('E5 lock 回执提到已回锁', outLock.includes('已回锁'));

const outShow = cmd!.handler('');
check('E6 无参显示三件套路径', outShow.includes(CHARTER_FILE) && outShow.includes(PROJECT_FILE) && outShow.includes(DEVLOG_FILE));
check('E7 无参显示当前锁状态', outShow.includes('已锁'));
charterLock.unlock();
check('E8 解锁后状态行反映已解锁', cmd!.handler('show').includes('已解锁'));
charterLock.reset();
check('E9 show 与空参同义', cmd!.handler('show').includes(CHARTER_FILE));

const outBad = cmd!.handler('bogus');
check('E10 未知参数给用法而非静默', outBad.includes('未知参数') && outBad.includes('/charter unlock'));

/* ── ⑥ 源码守护 ── */
console.log('── ⑥ 源码守护 ──');

const mainSrc = fs.readFileSync(path.join(ROOT, 'src/harness/main.ts'), 'utf8');
const coreSrc = fs.readFileSync(path.join(ROOT, 'src/context/sections/core-section.ts'), 'utf8');
const charterSrc = fs.readFileSync(path.join(ROOT, 'src/project/charter.ts'), 'utf8');
const builtinSrc = fs.readFileSync(path.join(ROOT, 'src/tools/builtin.ts'), 'utf8');

check('F1 main.ts 注册了 before_tool_call 核心钩子', mainSrc.includes("events.on('before_tool_call'"));
check('F2 main.ts 用的是 guardContractWrite + charterLock.isUnlocked()',
  mainSrc.includes('guardContractWrite(') && mainSrc.includes('charterLock.isUnlocked()'));
check('F3 注册时机在装载扩展**之前**（否则扩展会排在核心之后）',
  mainSrc.indexOf("events.on('before_tool_call'") < mainSrc.indexOf('await loadExtensions('));
check('F4 闸走独立状态位（**import 行**里没有权限子系统——注释里提到它是解释，不算依赖）',
  !/^import .*permission/m.test(charterSrc));
check('F5 受保护工具名单恰好 write/edit',
  /new Set\(\['write', 'edit'\]\)/.test(charterSrc));
check('F6 charter.ts 不写盘（锁刻意不持久化）', !/writeFileSync|appendFileSync/.test(charterSrc));
check('F7 提示词含【项目生命周期】节', coreSrc.includes('【项目生命周期】'));
check('F8 提示词讲了 CHARTER 冻结与解锁路径',
  coreSrc.includes('CHARTER.md') && coreSrc.includes('/charter unlock'));
check('F9 提示词讲了触发判据三阈值',
  coreSrc.includes('跨 ≥2 次会话') && coreSrc.includes('触及 ≥3 个模块'));
check('F10 提示词讲了进场回述三条', coreSrc.includes('先回述三条'));
check('F11 提示词讲了"一两句话定调"的描述规范（改了什么 · 为什么 · 价值）',
  coreSrc.includes('一两句话定调') && coreSrc.includes('带来什么价值') && coreSrc.includes('改变了什么'));

check('F12 bash 工具真接了 L2 效果闸（不是只写了个纯函数没人调）',
  builtinSrc.includes('contractAfterRun(') && builtinSrc.includes('contractDrifted(')
  && builtinSrc.includes('CHARTER_REJECTED_FILE'));
check('F13 效果闸读的是 charterLock 那个状态位（不借权限子系统，否则"本次全部允许"会静默开锁）',
  /const charterLocked = !charterLock\.isUnlocked\(\)/.test(builtinSrc));

/* ── ⑦ 行为：bash 的效果闸（L2）── */
console.log('── ⑦ 行为：bash 的契约效果闸（L2）──');

const cwd0 = process.cwd();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-verify-charter-'));
const tmpCharter = path.join(tmpDir, CHARTER_FILE);
const ORIGINAL_CHARTER = '# 目标\n\n本仓库的目标是：把这件事做完。\n';

/** 摆好 .flint 目录与契约文件；null = 故意让它不存在 */
function seedCharter(text: string | null): void {
  fs.rmSync(path.join(tmpDir, '.flint'), { recursive: true, force: true });
  if (text === null) return;
  fs.mkdirSync(path.join(tmpDir, '.flint'), { recursive: true });
  fs.writeFileSync(tmpCharter, text, 'utf-8');
}
const charterText = (): string =>
  (fs.existsSync(tmpCharter) ? fs.readFileSync(tmpCharter, 'utf-8') : '');
const freshReg = (evs: EventStore): ToolRegistry => {
  const r = new ToolRegistry();
  registerBuiltinTools(r, new TaskStore(), new MemoryStore(), evs);
  return r;
};

// 篡改脚本：**命令串里故意不出现 CHARTER.md 这个名字**（所以 L1 拦不住它），
// 由脚本内部去写 —— 这正是 L2 存在的理由。带 'fail' 参数时写完再以非零码退出，
// 用来钉"命令失败也要过闸"那条 catch 路径。
fs.writeFileSync(path.join(tmpDir, 'tamper.js'), [
  "const fs = require('fs');",
  "fs.writeFileSync('.flint/CHARTER.md', 'TAMPERED');",
  "if (process.argv[2] === 'fail') process.exit(3);",
].join('\n'), 'utf-8');
fs.writeFileSync(path.join(tmpDir, 'noop.js'), '0;\n', 'utf-8');
const runCmd = (script: string, arg = ''): string =>
  `"${process.execPath}" ${script}${arg === '' ? '' : ` ${arg}`}`;

try {
  process.chdir(tmpDir);   // bash 工具按 cwd 解析 .flint/CHARTER.md

  check('I1 夹具自检：篡改命令串**不含**契约文件名（否则测的就不是 L2 了）',
    !mentionsContract(runCmd('tamper.js')));

  {
    seedCharter(ORIGINAL_CHARTER);
    charterLock.reset();
    const evs = new EventStore();
    const r = await freshReg(evs).execute('bash', { command: runCmd('tamper.js') });
    check('I2 锁定期间 bash 改了契约 → 结果报错（不是静默放行）',
      r.status === 'error' && r.content.includes('[契约锁]'), r.content.slice(0, 90));
    check('I3 内容被**逐字**回滚到执行前', charterText() === ORIGINAL_CHARTER);
    check('I4 报错里说明了拦截理由（按效果兜底）与两条恢复路径（旁挂文件 + 事件库）',
      r.content.includes('效果') && r.content.includes(CHARTER_REJECTED_FILE)
      && r.content.includes('search_events'));
    check('I5 被回滚的那一版留了档（旁挂文件里是原文，内容没凭空消失）',
      fs.readFileSync(path.join(tmpDir, CHARTER_REJECTED_FILE), 'utf-8') === 'TAMPERED');
    check('I6 事件库记了一条（标题带 [契约锁]、标签含 rollback）',
      evs.all().length === 1 && String(evs.all()[0]?.title).includes('契约锁')
      && evs.all()[0]?.tags.includes('rollback') === true);
  }

  {
    // 解锁后一切照旧：闸只管锁定态
    seedCharter(ORIGINAL_CHARTER);
    charterLock.unlock();
    const evs = new EventStore();
    const r = await freshReg(evs).execute('bash', { command: runCmd('tamper.js') });
    check('I7 解锁后 bash 写契约 → 不拦（闸只管锁定态）',
      r.status === 'ok' && charterText() === 'TAMPERED');
    check('I8 解锁后不记账（一次 fs 都不写）', evs.all().length === 0);
    charterLock.reset();
  }

  {
    // 命令没碰契约：不该有任何副作用
    seedCharter(ORIGINAL_CHARTER);
    charterLock.reset();
    const evs = new EventStore();
    const r = await freshReg(evs).execute('bash', { command: runCmd('noop.js') });
    check('I9 命令没碰契约 → 照常 OK，不记账、内容未动',
      r.status === 'ok' && evs.all().length === 0 && charterText() === ORIGINAL_CHARTER);
  }

  {
    // 命令**失败**也可能已经改了文件（`写它 && false` 那类），所以 catch 路径也要过闸
    seedCharter(ORIGINAL_CHARTER);
    charterLock.reset();
    const evs = new EventStore();
    const r = await freshReg(evs).execute('bash', { command: runCmd('tamper.js', 'fail') });
    check('I10 命令失败但已改契约 → 照样回滚（catch 路径也过闸）',
      r.status === 'error' && charterText() === ORIGINAL_CHARTER);
    check('I11 报的是契约锁的理由，没被命令的退出码盖过去',
      r.content.includes('[契约锁]'), r.content.slice(0, 90));
  }

  {
    // 跑之前文件**不存在**、命令把它建了出来 → 回滚 = 把它删掉
    seedCharter(null);
    charterLock.reset();
    const evs = new EventStore();
    const r = await freshReg(evs).execute('bash', { command: runCmd('tamper.js') });
    check('I12 契约原本不存在、被命令创建 → 回滚即删除',
      r.status === 'error' && !fs.existsSync(tmpCharter));
  }
} finally {
  process.chdir(cwd0);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('');
console.log(`结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
process.exit(failed > 0 ? 1 : 0);
