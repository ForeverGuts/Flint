/**
 * verify-plan.ts —— 计划模式（ROADMAP 10.4.1）
 *
 * 这条功能最典型的失效方式**不是报错**，而是三种静默：
 *   · **名单漏了一个** —— 少拦一条通道，闸看起来还在、其实已经能被一句话绕过；
 *   · **该拦的没拦 / 不该拦的拦了** —— 前者让用户失去保护（却以为有），后者让人把模式关掉；
 *   · **模型自己关得掉** —— 闸的开关若有一条非用户的通路，整个设计就塌了。
 * 所以本套件的重心是"**边界恰好落在哪**"与"**谁能碰这个开关**"，不是文案好不好看。
 *
 * 验什么（判据 / 注入 / 接线 三层分开钉）：
 *   ① 被拦工具的**名单** —— 封闭枚举（现为 write / edit / bash / git_write）；只读与"记自己的账"都不在内
 *   ② `guardPlanMode` —— 模式 × 工具 × **参数形状**（后者刻意全不影响结论）
 *   ③ 两段文案 —— 拒因与横幅：出路方向**不能给错**（别的闸的出路在计划模式下走不通）
 *   ④ `planMode` 会话级单例 —— enter / exit / 幂等 / reset
 *   ⑤ `/plan` 命令三态 —— 真跑 `activate` 拿假 runtime：状态 / 进入 / 退出 / 未知参数，
 *      以及"**只在真正切换时**记审计"
 *   ⑥ 系统提示词注入层 —— 真跑 `SystemPromptServiceImpl`：横幅折进 **task 层**、
 *      与任务清单同一条消息且排在后面、两者都无则整层缺席、**层序仍是七层**
 *   ⑦ 真钩子链 `coreBeforeToolCall` —— 生产接线：模式开 → 拒；关（含缺省参数）→ 放行
 *   ⑧ 源码守护 —— 判据零项目依赖且不碰 fs；开关**只有命令层能碰**（模型关不掉）；
 *      装配处传的是 `planMode.isOn()`；`seedProjectContext` **不动**这个模式
 *
 * ── 一条自保（写在最前面）──
 * ⑤ 段真跑 `/plan` 命令 → `recordPlanMode` → 往账本（相对路径 `.flint/events.jsonl`）写条目；
 * ⑦ 段真跑 `coreBeforeToolCall` → `recordGateDeny` → 同上。不搬 cwd 就会把测试产物塞进
 * 本仓库的真实事件库（2026-09-19 那次 123 条污染的同一个缺口）。故先 `enterSandbox`。
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-plan.ts
 * 退出码：failed > 0 → 1
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PLAN_BLOCKED_TOOLS,
  PLAN_MARK,
  guardPlanMode,
  isPlanBlockedTool,
  planMode,
  renderPlanBanner,
  renderPlanReason,
} from '../src/loop/plan-mode.js';
import { activate as activatePlan } from '../src/commands/builtin/plan.js';
import { coreBeforeToolCall } from '../src/harness/main.js';
import { SystemPromptServiceImpl } from '../src/context/system-prompt.js';
import { eventStore } from '../src/eventlog/store.js';
import { enterSandbox } from './lib/sandbox.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

enterSandbox('flint-plan-');

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

const readSrc = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf-8');
/** 剥注释 —— 本仓"源码文本断言误伤注释"已记到第八次形态（见 verify-workspace G13/G14） */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* ═══ ① 被拦工具的名单 ═══ */
console.log('── ① 被拦工具的名单（封闭枚举：恰好五条改东西的通道）──');

// 2026-09-21 补 `spawn`（ROADMAP 10.10.1）：后台起一条 shell 命令，改文件的能力与 bash
// 等价、只是不等待结束。改前名单没有它 ⇒ 计划模式"先对齐再动手"这条纪律一换工具就绕过
// （10.4.1 判定 bash 进名单的原话：不堵的代价是"留一句 > file 就能绕开整道闸"）。
check('A1 名单恰好是 write / edit / bash / git_write / spawn（多一个少一个都当场红）',
  [...PLAN_BLOCKED_TOOLS].sort().join(',') === 'bash,edit,git_write,spawn,write',
  [...PLAN_BLOCKED_TOOLS].sort().join(','));
check('A2 write / edit / bash / git_write / spawn 都判为被拦',
  isPlanBlockedTool('write') && isPlanBlockedTool('edit') && isPlanBlockedTool('bash')
  && isPlanBlockedTool('git_write') && isPlanBlockedTool('spawn'));
// 真接线：guardPlanMode 真的把 spawn 拒掉（A1/A2 只测名单与 isPlanBlockedTool，
// 若哪天闸改判 `PLAN_BLOCKED_TOOLS.has` 之外的地方，这两条照绿 —— 所以补一条走上闸本身的）
check('A2b guardPlanMode 真的拒下 spawn（不是只在名单里挂着）',
  guardPlanMode('spawn', true)?.action === 'deny'
  && (guardPlanMode('spawn', true)?.reason ?? '').includes('spawn'));
// `task` 刻意不进：只管本会话 spawn 建的任务（list/status/output/kill），改的是进程状态
// 不是用户文件，与 todo / memory 同性质；计划模式下没有 spawn 建的任务，堵掉它收益为零。
check('A2c task 刻意不在名单（管自有进程 ≈ 记自己的账，不是改用户文件）',
  !isPlanBlockedTool('task'));
check('A3 只读工具不在名单：ls / read / grep / git / ask',
  !isPlanBlockedTool('ls') && !isPlanBlockedTool('read') && !isPlanBlockedTool('grep')
  && !isPlanBlockedTool('git') && !isPlanBlockedTool('ask'));
// 这一条是**设计判断**，不是遗漏：它们写的是 TASK.md / .flint/ 下 Agent 自己的笔记本，
// 不是用户的项目代码；而"写方案、记结论"正是计划模式要求它做的事。
// 反过来说，如果哪天要把它们也拦掉，那是一个**新的取舍**，得重新论证 —— 不该悄悄改名单。
check('A4 "记自己的账"不在名单：todo / memory / record_event / archive / search_events / pull_events',
  ['todo', 'memory', 'record_event', 'archive', 'search_events', 'pull_events']
    .every((n) => !isPlanBlockedTool(n)));
check('A5 未知工具名不在名单（不误拦将来新增的只读工具）', !isPlanBlockedTool('some_future_tool'));
check('A6 空串工具名不在名单（同其余各闸的 fail-open 口径）', !isPlanBlockedTool(''));

/* ═══ ② guardPlanMode：模式 × 工具 × 参数形状 ═══ */
console.log('\n── ② guardPlanMode（参数形状刻意全不影响结论）──');

check('B1 模式关 + write → 放行（零扰动）', guardPlanMode('write', false) === undefined);
check('B2 模式开 + write → 拒', guardPlanMode('write', true)?.action === 'deny');
check('B3 模式开 + edit → 拒', guardPlanMode('edit', true)?.action === 'deny');
check('B4 模式开 + bash → 拒（含只读命令 —— 留着它就是一条一句话绕过的洞）',
  guardPlanMode('bash', true)?.action === 'deny');
check('B5 模式开 + read → 放行', guardPlanMode('read', true) === undefined);
check('B6 模式开 + todo → 放行（计划模式下它仍需要记账）', guardPlanMode('todo', true) === undefined);
check('B7 模式开 + git → 放行（只读 op 白名单在 git 工具自己那里）', guardPlanMode('git', true) === undefined);
check('B8 模式开 + 空工具名 → 放行', guardPlanMode('', true) === undefined);
check('B9 模式开 + 未知工具 → 放行', guardPlanMode('some_future_tool', true) === undefined);
check('B10 拒的形状是 { action: "deny", reason 非空 }',
  guardPlanMode('write', true)?.action === 'deny'
  && (guardPlanMode('write', true)?.reason ?? '').length > 0);
check('B11 模式开 + bash 的拒因里报的是 bash（不是别的工具名）',
  (guardPlanMode('bash', true)?.reason ?? '').includes('bash'));

/* ═══ ③ 文案：出路方向不能给错 ═══ */
console.log('\n── ③ 两段文案 ──');

const reason = renderPlanReason('write');
check('C1 拒因带 PLAN_MARK 前缀', reason.startsWith(PLAN_MARK));
check('C2 拒因明说这条**没有被执行**', reason.includes('没有被执行'));
check('C3 拒因报出被拦的工具名', renderPlanReason('edit').includes('edit'));
check('C4 拒因给出的出路是"先出方案"', reason.includes('方案'));
check('C5 拒因点明退出动作是 /plan off 且**只有用户能做**',
  reason.includes('/plan off') && reason.includes('只有用户能做'));
check('C6 拒因把 ask 指成不受限的提问通道', reason.includes('ask'));
check('C7 拒因自认边界（不是沙箱）', reason.includes('不是沙箱'));
// ⚠ 这一条是本质的：其余各闸的出路在计划模式下**走不通**（解锁 / 放行之后照样被本闸拦），
// 所以文案里一个字都不该出现它们 —— "方向给错比不给更坏"。
check('C8 拒因**不出现**其它闸的出路（/charter unlock、/workspace allow）——方向给错比不给更坏',
  !reason.includes('charter unlock') && !reason.includes('/workspace allow'),
  reason.split('\n').filter((l) => l.includes('unlock') || l.includes('workspace')).join(' | '));

const banner = renderPlanBanner();
// ⚠ 断在**首行**，不是整段（2026-09-20 变异 M11 逮到）：整段里"只读"还出现在第三行的
//   "用只读工具…"，于是把首行那句"只读、先出方案"整句删掉**照样全绿** —— 那条断言的射程
//   比它的名字宽，等于没钉住横幅的**主旨**。首行才是横幅对外的一句话结论。
const bannerHead = banner.split('\n')[0] ?? '';
check('C9 横幅首行点明"只读、先出方案"（首行是主旨句，不是正文里随便出现"只读"二字）',
  banner.startsWith(PLAN_MARK) && bannerHead.includes('只读') && bannerHead.includes('方案'),
  `首行=${bannerHead}`);
check('C10 横幅报出名单里的**每一个**工具名（从名单派生 —— 名单改了、文案没改，是最容易漏的那半步）',
  [...PLAN_BLOCKED_TOOLS].every((t) => banner.includes(t)), banner);
check('C11 横幅说出怎么退出（/plan off）', banner.includes('/plan off'));
check('C12 横幅同样不出现其它闸的出路',
  !banner.includes('charter unlock') && !banner.includes('/workspace allow'));

/* ═══ ④ 会话级单例 ═══ */
console.log('\n── ④ planMode 单例（会话级、刻意不持久化）──');

planMode.reset();
check('D1 复位后是关的', planMode.isOn() === false);
planMode.enter();
check('D2 enter → 开', planMode.isOn() === true);
planMode.enter();
check('D3 enter 幂等（连开两次仍是开，不翻转）', planMode.isOn() === true);
planMode.exit();
check('D4 exit → 关', planMode.isOn() === false);
planMode.exit();
check('D5 exit 幂等（连关两次仍是关，不翻转）', planMode.isOn() === false);
planMode.enter();
planMode.reset();
check('D6 reset 把状态擦回关（验证脚本用例之间用）', planMode.isOn() === false);

/* ═══ ⑤ /plan 命令三态 ═══ */
console.log('\n── ⑤ /plan 命令（真跑 activate，含"只在真正切换时记审计"）──');

let reg: { fn: (a: string) => string } | null = null;
activatePlan({
  registerCommand: (_n: string, _d: string, f: (a: string) => string) => { reg = { fn: f }; },
} as never);
const cmd = (a: string): string => reg!.fn(a);
/**
 * 两次快照之间新增的**审计**条目。
 * `count()` 是 `all()` 的长度，而 slice 发生在**新条目已入列之后** —— 于是"旧长度"正好
 * 是新增段的起点（与 verify-audit 的 `auditsSince` 同一手法）。
 */
const auditsSince = (mark: number): Array<{ title: string; tags: string[]; outcome?: string }> =>
  eventStore.all().slice(mark).filter((e) => e.tags.includes('audit'));

planMode.reset();

let m = eventStore.count();
const outShow = cmd('');
check('E1 无参数 → 看状态（默认行为是最无害的那个：不改任何东西）',
  outShow.includes('当前状态') && planMode.isOn() === false);
check('E2 仅仅看状态**不记**审计', auditsSince(m).length === 0);

m = eventStore.count();
const outOn = cmd('on');
let recs = auditsSince(m);
check('E3 `on` → 模式真的开了', planMode.isOn() === true);
check('E4 `on` 的回执报出被拦的工具名单',
  outOn.includes('write') && outOn.includes('edit') && outOn.includes('bash'));
check('E5 `on` 的回执交代边界（不是沙箱 / bash 一并被拦）',
  outOn.includes('不是沙箱') && outOn.includes('bash'));
check('E6 `on` 记一条审计：tag=plan、source=进入', recs.length === 1
  && recs[0]!.tags.includes('plan') === true && recs[0]!.title.includes('进入'), JSON.stringify(recs[0]));

m = eventStore.count();
const outOn2 = cmd('on');
check('E7 已经在模式里再敲 `on` → 回执说明"本次没有变化"', outOn2.includes('没有变化'));
check('E8 没有变化就**不记**审计（与"一次什么都没撤销的 clear 不记"同一条）',
  auditsSince(m).length === 0);

m = eventStore.count();
const outOff = cmd('off');
recs = auditsSince(m);
check('E9 `off` → 模式真的关了', planMode.isOn() === false);
check('E10 `off` 的回执说恢复了哪三个工具', outOff.includes('write'));
check('E11 `off` 记一条审计：tag=plan、source=退出', recs.length === 1
  && recs[0]!.tags.includes('plan') === true && recs[0]!.title.includes('退出'), JSON.stringify(recs[0]));

m = eventStore.count();
cmd('off');
check('E12 本来就没开时敲 `off` → 不记审计', auditsSince(m).length === 0);

const outBad = cmd('nonsense');
check('E13 未知参数 → 回执带用法，不崩', outBad.includes('未知参数') && outBad.includes('用法'));
check('E14 `show` 与空参数等价（同义词）', cmd('show').includes('当前状态'));
// C8 的"当场说清"：用户最可能的误解是"RPC / 非 TTY 下这模式是不是就废了"。
// 回执必须**主动**回答它，而不是等用户来问。
check('E15 状态回执主动交代"不需要人工确认，故非 TTY / RPC 下不会被自动放行"',
  cmd('').includes('人工确认') && cmd('').includes('RPC'));

/* ═══ ⑥ 系统提示词注入层 ═══ */
console.log('\n── ⑥ 注入层（真跑 SystemPromptServiceImpl：折进 task 层）──');

const sps = new SystemPromptServiceImpl({
  core: [() => 'CORE段'],
  tools: [() => 'TOOLS段'],
  skills: [() => 'SKILLS段'],
  fallback: 'FB',
}, {} as never);

/** build 的最小 ctx —— 只填这条用例关心的那几格 */
const mkCtx = (over: Record<string, unknown>): never => ({
  tools: [], skills: [], skillDeps: {}, model: 'm', historyCount: 0, ...over,
} as never);

const layersOf = (msgs: Array<{ layer: string; content: string }>): string[] => msgs.map((x) => x.layer);

const rOnlyPlan = await sps.build(mkCtx({ plan: 'BANNER' }));
const taskLayerOnlyPlan = rOnlyPlan.messages.find((x) => x.layer === 'task');
check('F1 只有横幅（没有任务清单）→ task 层**照旧出现**',
  taskLayerOnlyPlan !== undefined, layersOf(rOnlyPlan.messages).join(','));
check('F2 那条消息的正文就是横幅（不套"当前任务"的空壳标题）',
  taskLayerOnlyPlan?.content === 'BANNER', String(taskLayerOnlyPlan?.content));

const rBoth = await sps.build(mkCtx({ task: '- [ ] 干活', plan: 'BANNER' }));
const taskBoth = rBoth.messages.find((x) => x.layer === 'task');
check('F3 清单与横幅**同一条消息**（不新开一层 / 不多一条消息）',
  rBoth.messages.filter((x) => x.layer === 'task').length === 1);
check('F4 同一条消息里：清单在前、横幅在后',
  (taskBoth?.content.indexOf('## 当前任务') ?? -1) >= 0
  && (taskBoth?.content.indexOf('BANNER') ?? -1) > (taskBoth?.content.indexOf('## 当前任务') ?? -1),
  String(taskBoth?.content));
check('F5 清单有未完成项时续传提示仍在（横幅没有把它挤掉）',
  (taskBoth?.content.includes('[续传提示]') ?? false));

const rNeither = await sps.build(mkCtx({}));
check('F6 两者都没有 → 整层缺席（维持"没有就不注入"的纪律）',
  !layersOf(rNeither.messages).includes('task'), layersOf(rNeither.messages).join(','));
// 层序是承重的：加这一节**没有**动它（也就没有动 union 与两套逐字断言）。
check('F7 层序仍是 core → tools → skills → project → memory → task → summary（没新开层）',
  layersOf((await sps.build(mkCtx({
    project: 'P', rules: 'R', memory: 'M', task: '- [ ] x', plan: 'BANNER', summary: 'S',
  }))).messages).join(' → ')
  === 'core → tools → skills → project → memory → task → summary',
  layersOf(rNeither.messages).join(','));
check('F8 加了横幅之后 task 层的 layer 名**没有变**（仍叫 task）',
  taskLayerOnlyPlan?.layer === 'task');

/* ═══ ⑦ 真钩子链（生产接线）═══ */
console.log('\n── ⑦ 真钩子链 coreBeforeToolCall ──');

const gOn = coreBeforeToolCall({ name: 'write', args: { path: 'src/a.ts' } }, false, true);
check('G1 模式开 → write 被真钩子链拒，且拒因是计划模式那段',
  gOn?.action === 'deny' && (gOn.reason ?? '').startsWith(PLAN_MARK));
check('G2 模式开 → bash 同样被拒',
  coreBeforeToolCall({ name: 'bash', args: { command: 'ls' } }, false, true) !== undefined);
check('G3 模式开 → read 放行（模式只挡住"改"）',
  coreBeforeToolCall({ name: 'read', args: { path: 'src/a.ts' } }, false, true) === undefined);
check('G4 模式开 → todo 放行（它还写得动自己的笔记本）',
  coreBeforeToolCall({ name: 'todo', args: { op: 'add' } }, false, true) === undefined);
// "加一步"而不"换判据"：既有调用点全是两参的，缺省必须逐字退回改动前的行为。
check('G5 缺省第三参（两参调用）→ 不启用模式闸，write 照旧放行',
  coreBeforeToolCall({ name: 'write', args: { path: 'src/a.ts' } }, false) === undefined);
check('G6 模式显式关 + write → 照旧放行',
  coreBeforeToolCall({ name: 'write', args: { path: 'src/a.ts' } }, false, false) === undefined);
// 模式闸排最前：契约文件在计划模式下也**只能**拿到计划模式那条拒因 ——
// 否则模型会去请用户 /charter unlock，用户照做之后它照样被拦（方向给错）。
const gFront = coreBeforeToolCall({ name: 'write', args: { path: '.flint/CHARTER.md' } }, false, true);
check('G7 模式闸排最前：契约文件在计划模式下拿到的也是计划模式拒因',
  (gFront?.reason ?? '').startsWith(PLAN_MARK), String(gFront?.reason).slice(0, 40));

/* ═══ ⑧ 源码守护 ═══ */
console.log('\n── ⑧ 源码守护（判据纯、开关只有用户能碰、接线真的接了）──');

const planSrc = readSrc('src/loop/plan-mode.ts');
const planCode = stripComments(planSrc);
check('H1 判据零**项目**依赖（import 只指向钩子契约类型）',
  (planSrc.match(/^import .*from '([^']+)'/gm) ?? [])
    .every((line) => /from '\.\/tool-hooks\.js'/.test(line)),
  (planSrc.match(/^import .*from '([^']+)'/gm) ?? []).join(' | '));
check('H2 判据不碰 fs、不起进程（模式是纯内存状态）',
  !/node:fs|child_process|readFileSync|writeFileSync|existsSync/.test(planCode));
check('H3 判据不落盘（会话级、刻意不持久化：一次临时意愿不许放大成长期默认）',
  !/persist|saveFile|JSON\.stringify/.test(planCode));
check('H4 四个导出各只出现一处实现',
  ['guardPlanMode', 'renderPlanReason', 'renderPlanBanner', 'isPlanBlockedTool']
    .every((f) => (planSrc.match(new RegExp(`export function ${f}`, 'g')) ?? []).length === 1)
  && (planSrc.match(/export const planMode/g) ?? []).length === 1
  && (planSrc.match(/export const PLAN_BLOCKED_TOOLS/g) ?? []).length === 1);

const srcFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) out.push(...srcFiles(rel));
    else if (e.name.endsWith('.ts')) out.push(rel);
  }
  return out;
};
const allSrc = srcFiles('src');
// ⚠ 承重：`enter` / `exit` 的**唯一**调用方必须是命令层。若 src 别处也能翻这个开关，
//   "模型自己关掉闸再动手"就成立了 —— 那整个设计就塌了。
const enterExitCallers = allSrc.filter((f) => f !== 'src/loop/plan-mode.ts'
  && /planMode\.(enter|exit)\(/.test(stripComments(readSrc(f))));
check('H5 开关（enter / exit）的 src 内唯一调用方是命令层 —— 模型自己关不掉',
  enterExitCallers.length === 1 && enterExitCallers[0] === 'src/commands/builtin/plan.ts',
  enterExitCallers.join(','));
const toolFiles = allSrc.filter((f) => f.startsWith('src/tools/'));
check('H6 src/tools/ 下没有任何文件引用 planMode（模型手里没有能碰开关的工具）',
  toolFiles.every((f) => !/planMode/.test(readSrc(f))), toolFiles.filter((f) => /planMode/.test(readSrc(f))).join(','));

const mainSrc = readSrc('src/harness/main.ts');
check('H7 main.ts 接了模式闸，且排在契约闸**之前**',
  mainSrc.includes('guardPlanMode(')
  && mainSrc.indexOf('guardPlanMode(') < mainSrc.indexOf('guardContractWrite('));
check('H8 main.ts 注册钩子时传的是 planMode.isOn()（每次调用现取，不是启动时快照）',
  /coreBeforeToolCall\(event, charterLock\.isUnlocked\(\), planMode\.isOn\(\)\)/.test(mainSrc));
check('H9 main.ts 不自己拼审计条目（仍走统一落点）',
  !stripComments(mainSrc).includes('recordAudit(') && mainSrc.includes('recordGateDeny('));

const rtSrc = readSrc('src/runtime/runtime.ts');
check('H10 runtime.ts 渲染了横幅并传进 ctx.plan',
  rtSrc.includes('renderPlanBanner') && /plan:\s*planBanner/.test(rtSrc));
const cmdSrc = readSrc('src/commands/builtin/plan.ts');
check('H11 命令层走统一审计落点（不自己拼条目）',
  !stripComments(cmdSrc).includes('recordAudit(') && cmdSrc.includes('recordPlanMode('));
// ⚠ 设计判断，不是遗漏：切项目**不该**动这个模式（用户开着计划模式去切了个项目，
//   仍然在规划阶段）。要改这条得先论证"切项目会自动退出计划模式"的理由。
const seedSrc = readSrc('src/harness/project-context.ts');
check('H12 seedProjectContext **不动** planMode（切项目不退出计划模式）',
  !/planMode/.test(stripComments(seedSrc)));

console.log(`\n结果：${passed} 通过，${failed} 失败（共 ${passed + failed} 项）`);
process.exit(failed > 0 ? 1 : 0);
