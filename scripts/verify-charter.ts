/**
 * verify-charter.ts —— 项目生命周期协议：目标文档的写保护闸（ROADMAP P10.12）
 *
 * 验什么（手段与行为分开钉）：
 *   ① isContractTarget 纯函数 —— 路径判定逐形状（相对/绝对/反斜杠/大小写/`..` 绕法/子目录/非契约文件）
 *   ② guardContractWrite 纯函数 —— 该拦的拦、不该拦的放行；fail-open 边界逐形状喂
 *   ③ charterLock 状态机 —— 会话级单例的开关与复位
 *   ④ **真 PromptEventEmitter 的钩子链路** —— 核心钩子真被 emitHook 收到并生效；
 *      以及一条承重断言：**核心钩子返回 deny 之后，扩展钩子返回 undefined 不会把它覆盖**
 *      （emitHook 取"最后一个非 undefined"，这条顺序性质是 main.ts 注册时机的前提）
 *   ⑤ /charter 命令 —— 假 runtime 截获注册，直接调 handler 验 unlock/lock/状态/坏参数
 *   ⑥ 源码守护 —— 接线在 main.ts 里存在且**注册在装载扩展之前**；提示词真教了这套流程；
 *      闸走的是自己的状态位（源码里不出现 permission 依赖）；受保护工具名单恰好是 write/edit
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-charter.ts
 * 退出码：failed > 0 → 1
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHARTER_FILE,
  DEVLOG_FILE,
  PROJECT_FILE,
  charterLock,
  guardContractWrite,
  isContractTarget,
} from '../src/project/charter.js';
import { PromptEventEmitter } from '../src/runtime/events.js';
import { activate } from '../src/commands/builtin/charter.js';
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
check('B7 bash 不拦（已知边界：命令串语义解析归 10.9.2）', guardContractWrite('bash', { cmd: `echo x > ${CHARTER_FILE}` }, false) === undefined);
check('B8 write 非契约路径放行', guardContractWrite('write', { path: 'src/a.ts' }, false) === undefined);
check('B9 write 命中 PROJECT.md 放行（现状文档不锁）', guardContractWrite('write', { path: PROJECT_FILE }, false) === undefined);
check('B10 args=null → fail-open 放行', guardContractWrite('write', null, false) === undefined);
check('B11 args=字符串 → fail-open 放行', guardContractWrite('write', 'x', false) === undefined);
check('B12 args=数字 → fail-open 放行', guardContractWrite('write', 42, false) === undefined);
check('B13 无 path 字段 → fail-open 放行', guardContractWrite('write', { content: 'x' }, false) === undefined);
check('B14 path 非字符串 → fail-open 放行', guardContractWrite('write', { path: 123 }, false) === undefined);
check('B15 path 纯空白 → fail-open 放行', guardContractWrite('write', { path: '   ' }, false) === undefined);

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

console.log('');
console.log(`结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
process.exit(failed > 0 ? 1 : 0);
