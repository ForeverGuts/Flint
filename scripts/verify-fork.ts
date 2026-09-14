/**
 * verify-fork.ts —— 分叉点提问机制（`ask` 工具 + 讨论协议）的验证套件。
 *
 * 为什么单独一套：这是本项目第一个"**会改变后续所有代码形态**"的交互能力。权限弹窗
 * 回答"这次调用要不要跑"，答错了顶多跑错一条命令；分叉点回答"这个设计该选哪条路"，
 * 答错了整批代码都建在错误前提上。两件事的值域不同，验证的密度也该不同。
 *
 * 验什么（手段与行为分开钉）：
 *   ① 契约常量 —— 三条讨论问题逐字、哨兵值不与候选撞车、技能名
 *   ② 候选解析 —— 逐形状（分隔符三种、冒号两种、空项、序号连续）
 *   ③ 选项构造 —— 候选在前、「先讨论」永远在最后（默认不选）、标题单行
 *   ④ 分类 —— null / 哨兵 / 序号 / **认不出的值一律按"没做选择"**（不猜）
 *   ⑤ 回话文本 —— 三种结局各自把"下一步做什么"写死
 *   ⑥ 与提示词 / 技能文件交叉比对（两边各存一份迟早分家）
 *   ⑦ **行为**：真 ToolRegistry 跑 `ask` —— 三种结局 + 参数校验 + 事件库留痕 + 写失败不静默
 *   ⑧ **行为**：`createForkAsker` 的 fail-closed —— 非 TTY 时**选择器一次都不许被调用**
 *      （这是本套件最承重的一条：自动替用户在 A/B 之间选一个，比不提供这个功能更糟）
 *   ⑨ 源码守护 —— 工具层不 import io、缺省提问是"问不了"、先判终端再调选择器
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-fork.ts
 * 退出码：failed > 0 → 1
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFER_VALUE,
  DISCUSS_QUESTIONS,
  DISCUSS_SKILL,
  buildChoices,
  buildForkTitle,
  classifyChoice,
  formatCandidates,
  formatForkResult,
  parseCandidates,
  type AskFn,
  type Choice,
} from '../src/project/fork.js';
import { createForkAsker } from '../src/io/ui/fork-prompt.js';
import { registerBuiltinTools } from '../src/tools/builtin.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { TaskStore } from '../src/todo/store.js';
import { MemoryStore } from '../src/memory/store.js';
import { EventStore } from '../src/eventlog/store.js';

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

/* ── ① 契约常量 ── */
console.log('── ① 契约常量 ──');

check('A1 「先讨论」哨兵值非空且是个不像候选的形状',
  DEFER_VALUE.length > 0 && !/^\d+$/.test(DEFER_VALUE), DEFER_VALUE);
check('A2 讨论技能名逐字是 grill-me', DISCUSS_SKILL === 'grill-me', DISCUSS_SKILL);
check('A3 三条讨论问题逐字等于用户原话',
  DISCUSS_QUESTIONS.length === 3
  && DISCUSS_QUESTIONS[0] === '目前遭遇的问题是什么？'
  && DISCUSS_QUESTIONS[1] === '需要思考的矛盾点是什么？'
  && DISCUSS_QUESTIONS[2] === '抉择的对象是什么？',
  DISCUSS_QUESTIONS.join(' | '));
check('A4 候选的取值空间与哨兵不撞（候选值都是 0 基序号）',
  parseCandidates('甲|乙|丙').every((c) => /^\d+$/.test(c.value)) && !parseCandidates('甲|乙').some((c) => c.value === DEFER_VALUE));

/* ── ② 候选解析 ── */
console.log('── ② 候选解析 ──');

check('B1 竖线分隔', parseCandidates('甲|乙|丙').map((c) => c.label).join(',') === '甲,乙,丙');
check('B2 全角竖线也算分隔', parseCandidates('甲｜乙').map((c) => c.label).join(',') === '甲,乙');
check('B3 换行也算分隔', parseCandidates('甲\n乙').map((c) => c.label).join(',') === '甲,乙');
const parsed = parseCandidates('SQLite: 单文件、零依赖|B 每会话一文件: 抗并发');
check('B4 半角冒号拆标签与说明',
  parsed[0]?.label === 'SQLite' && parsed[0]?.description === '单文件、零依赖', JSON.stringify(parsed[0]));
check('B5 全角冒号也认',
  parseCandidates('甲：说明甲')[0]?.description === '说明甲');
check('B6 没有冒号 → 整项当标签',
  parseCandidates('纯标签')[0]?.label === '纯标签' && parseCandidates('纯标签')[0]?.description === '');
check('B7 只按第一个冒号拆（说明里可以再有冒号）',
  parseCandidates('A: 见 x:y')[0]?.label === 'A' && parseCandidates('A: 见 x:y')[0]?.description === '见 x:y');
check('B8 空项被丢弃（连续分隔符 / 首尾分隔符）',
  parseCandidates('|甲||乙|').map((c) => c.label).join(',') === '甲,乙');
check('B9 空标签项被丢弃（":说明" 不是候选）', parseCandidates(': 说明|甲').map((c) => c.label).join(',') === '甲');
check('B10 前后空白被吃掉', parseCandidates('  甲  |  乙  ').map((c) => c.label).join(',') === '甲,乙');
check('B11 序号是连续的 0 基（选择器回传的就是它）',
  parseCandidates('甲|乙|丙').map((c) => c.value).join(',') === '0,1,2');
check('B12 空串 → 零候选', parseCandidates('').length === 0);

/* ── ③ 选项构造 ── */
console.log('── ③ 选项构造 ──');

const cands = parseCandidates('甲: 说明甲|乙');
const choices = buildChoices(cands);
check('C1 候选在前、讨论项在最后', choices.length === 3 && choices[2]?.value === DEFER_VALUE, choices.map((c) => c.value).join(','));
check('C2 讨论项的值是哨兵、标签说明人话',
  choices[2]?.label.includes('讨论') && (choices[2]?.description ?? '').length > 0);
check('C3 有说明的候选带 description，没说明的不带该键',
  choices[0]?.description === '说明甲' && !('description' in (choices[1] as Choice)), JSON.stringify(choices[1]));
check('C4 选项的 value 与候选一一对应（顺序不错位）',
  choices.slice(0, 2).map((c) => c.value).join(',') === '0,1' && choices[0]?.label === '甲' && choices[1]?.label === '乙');
check('C5 标题含问题', buildForkTitle('选哪个？', '').includes('选哪个？'));
check('C6 标题带背景时用分隔符接上', buildForkTitle('选哪个？', '要抗并发').includes('要抗并发'));
check('C7 标题是**单行**（带 \\n 会把选择器的固定行数算错 → 漂移）',
  !buildForkTitle('问\n题', '背\n景').includes('\n'), buildForkTitle('问\n题', '背\n景'));
check('C8 候选纯文本带序号与说明',
  formatCandidates(cands).includes('1. 甲') && formatCandidates(cands).includes('说明甲'));

/* ── ④ 分类 ── */
console.log('── ④ 分类 ──');

check('D1 null（取消 / 问不了）→ unavailable', classifyChoice(null, cands).kind === 'unavailable');
check('D2 哨兵 → discuss', classifyChoice(DEFER_VALUE, cands).kind === 'discuss');
const picked = classifyChoice('1', cands);
check('D3 序号 → decide 且带回正确的候选',
  picked.kind === 'decide' && picked.kind === 'decide' && picked.candidate.label === '乙', JSON.stringify(picked));
check('D4 序号 0 也能认出（0 是假值，别写成 if (!v)）',
  classifyChoice('0', cands).kind === 'decide');
check('D5 认不出的值 → unavailable（**不猜**，不退回第一项）',
  classifyChoice('99', cands).kind === 'unavailable' && classifyChoice('甲', cands).kind === 'unavailable');

/* ── ⑤ 回话文本三态 ── */
console.log('── ⑤ 回话文本三态 ──');

const tDecide = formatForkResult('用哪种存储？', '要抗并发', cands, classifyChoice('0', cands));
check('E1 拍板态点明用户选了哪个', tDecide.includes('用户已拍板') && tDecide.includes('甲'));
check('E2 拍板态给了落地三件事（路线图 / CHARTER / DEVLOG）',
  tDecide.includes('ROADMAP.md') && tDecide.includes('CHARTER.md') && tDecide.includes('DEVLOG.md'));
check('E3 拍板态明说"不要再问第二次"', tDecide.includes('不要再就同一个分叉点问第二次'));
check('E4 拍板态说明留痕是程序做的（不依赖它记得去记）', tDecide.includes('事件库'));

const tDiscuss = formatForkResult('用哪种存储？', '', cands, classifyChoice(DEFER_VALUE, cands));
check('E5 讨论态三条问题逐字都在',
  DISCUSS_QUESTIONS.every((q) => tDiscuss.includes(q)), DISCUSS_QUESTIONS.filter((q) => !tDiscuss.includes(q)).join(','));
check('E6 讨论态指向技能文件', tDiscuss.includes(`skills/${DISCUSS_SKILL}.md`));
check('E7 讨论态禁止继续动手、禁止替用户选',
  tDiscuss.includes('不要') && tDiscuss.includes('继续往下做') && tDiscuss.includes('替用户选'));
check('E8 讨论态要求收口后重抛分叉点', tDiscuss.includes('重新抛给用户'));
check('E9 讨论态给出"你定"的例外条件', tDiscuss.includes('你定'));

const tUnavail = formatForkResult('用哪种存储？', '', cands, classifyChoice(null, cands));
check('E10 问不了态明说**未做任何选择**', tUnavail.includes('未做任何选择'));
check('E11 问不了态要求改用文字提问并停下来等', tUnavail.includes('停下来等'));
check('E12 问不了态禁止替用户选、禁止假装问过',
  tUnavail.includes('不要替他选') && tUnavail.includes('假装问过'));
check('E13 三态都带上候选清单（模型不必回头翻参数）',
  tDecide.includes('甲') && tDiscuss.includes('甲') && tUnavail.includes('甲'));

/* ── ⑥ 交叉比对：提示词与技能文件 ── */
console.log('── ⑥ 交叉比对：提示词与技能文件 ──');

const coreSrc = fs.readFileSync(path.join(ROOT, 'src/context/sections/core-section.ts'), 'utf8');
check('F1 提示词含三条讨论问题逐字',
  DISCUSS_QUESTIONS.every((q) => coreSrc.includes(q)), DISCUSS_QUESTIONS.filter((q) => !coreSrc.includes(q)).join(','));
check('F2 提示词指向技能文件', coreSrc.includes(`skills/${DISCUSS_SKILL}.md`));
check('F3 提示词教了 ask 工具与"截断当前流程"',
  coreSrc.includes('ask 工具') && coreSrc.includes('截断'));
check('F4 提示词讲了"至少两个候选"（否则不是分叉点）', coreSrc.includes('至少两个候选'));
check('F5 提示词讲了非终端时降级为文字提问', coreSrc.includes('问不了'));

const skillPath = path.join(ROOT, `skills/${DISCUSS_SKILL}.md`);
check('F6 技能文件存在', fs.existsSync(skillPath));
const skillSrc = fs.existsSync(skillPath) ? fs.readFileSync(skillPath, 'utf8') : '';
check('F7 技能 frontmatter 的 name 与常量一致',
  new RegExp(`^name:\\s*${DISCUSS_SKILL}\\s*$`, 'm').test(skillSrc), skillSrc.slice(0, 60));
check('F8 技能里写着"一次只问一个问题"与"给出推荐答案"',
  skillSrc.includes('一次只问一个问题') && skillSrc.includes('推荐答案'));

/* ── ⑦ 行为：真 ToolRegistry 跑 ask ── */
console.log('── ⑦ 行为：真 ToolRegistry 跑 ask（含事件库留痕）──');

/** 记录每次提问的入参，返回预设的选择 */
function probeAsk(pick: string | null): { fn: AskFn; calls: Array<{ title: string; values: string[] }> } {
  const calls: Array<{ title: string; values: string[] }> = [];
  return {
    calls,
    fn: async (title, choiceList) => {
      calls.push({ title, values: choiceList.map((c) => c.value) });
      return pick;
    },
  };
}

const cwd0 = process.cwd();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-verify-fork-'));
try {
  process.chdir(tmpDir);   // 事件库落在临时目录（EVENTS_FILE 是相对路径 .flint/events.jsonl）

  const args = { question: '会话存储用哪种方案？', options: 'A 单文件: 最简单|B 每会话一文件: 抗并发', context: '要支持并发写入' };

  {
    const probe = probeAsk('1');
    const evs = new EventStore();
    const reg = new ToolRegistry();
    registerBuiltinTools(reg, new TaskStore(), new MemoryStore(), evs, probe.fn);
    const r = await reg.execute('ask', args);
    check('G1 拍板 → [OK] 且回话含用户选定的那一项',
      r.status === 'ok' && r.content.startsWith('[OK]') && r.content.includes('B 每会话一文件'), r.content.slice(0, 100));
    check('G2 提问真正走到了交互层（探针被调用一次）', probe.calls.length === 1);
    check('G3 标题带问题与背景',
      probe.calls[0]?.title.includes('会话存储用哪种方案？') && probe.calls[0]?.title.includes('要支持并发写入'));
    check('G4 选项 = 两个候选 + 末尾一条「先讨论」',
      probe.calls[0]?.values.join(',') === `0,1,${DEFER_VALUE}`, probe.calls[0]?.values.join(','));
    const all = evs.all();
    check('G5 拍板这件事被**确定性**写进事件库（kind=decision）',
      all.length === 1 && all[0]?.kind === 'decision', JSON.stringify(all.map((e) => e.kind)));
    check('G6 事件库条目标题带分叉点与选定方案',
      (all[0]?.title ?? '').includes('[分叉点]') && (all[0]?.title ?? '').includes('B 每会话一文件'), all[0]?.title);
  }

  {
    const probe = probeAsk(DEFER_VALUE);
    const evs = new EventStore();
    const reg = new ToolRegistry();
    registerBuiltinTools(reg, new TaskStore(), new MemoryStore(), evs, probe.fn);
    const r = await reg.execute('ask', args);
    check('G7 先讨论 → [OK] 且回话给出去读 grill-me 的指令',
      r.status === 'ok' && r.content.includes(`skills/${DISCUSS_SKILL}.md`));
    const all = evs.all();
    check('G8 待讨论也留痕，且标题标出"待讨论"（免得日后被当成已拍板）',
      all.length === 1 && all[0]?.kind === 'decision' && (all[0]?.title ?? '').includes('待讨论'), all[0]?.title);
  }

  {
    // 缺省 askFn（不传第 5 参）= NO_INTERACTION：问不了，且**不写事件库**
    const evs = new EventStore();
    const reg = new ToolRegistry();
    registerBuiltinTools(reg, new TaskStore(), new MemoryStore(), evs);
    const r = await reg.execute('ask', args);
    check('G9 缺省提问实现 = 问不了（fail-closed 的默认一侧）',
      r.status === 'ok' && r.content.includes('未做任何选择'), r.content.slice(0, 80));
    check('G10 问不了时**不写**事件库（没决定就没事实可记）', evs.all().length === 0);
    check('G11 问不了时回话仍把候选列全，让模型能照抄进文字提问',
      r.content.includes('A 单文件') && r.content.includes('B 每会话一文件'));
  }

  {
    // 只有零/一个候选：不是分叉点 → [INVALID]（并计入失败，会触发重复失败保护）
    const probe = probeAsk('0');
    const reg = new ToolRegistry();
    registerBuiltinTools(reg, new TaskStore(), new MemoryStore(), new EventStore(), probe.fn);
    const r1 = await reg.execute('ask', { question: '只有一个方案算分叉点吗？', options: 'A 唯一方案' });
    check('G12 只有一个候选 → [INVALID]', r1.status === 'invalid' && r1.content.startsWith('[INVALID]'), r1.content.slice(0, 80));
    check('G13 一个候选时不弹窗（没分叉就别打扰用户）', probe.calls.length === 0);
    const r2 = await reg.execute('ask', { question: '空？', options: '' });
    check('G14 零候选 → [INVALID]', r2.status === 'invalid');
    const r3 = await reg.execute('ask', { question: '少参数', options: 'A|B' });
    check('G15 缺 context 走默认值，正常出结果（可选参数不挡路）', r3.status === 'ok');
  }

  {
    // 事件库写失败：决定仍有效，但必须在回话里说出来（静默丢一次用户决策最严重）
    const probe = probeAsk('0');
    const brokenEvs = {
      addNarrative: () => ({ entry: {} as never, warn: '派生的假故障' }),
    } as never;
    const reg = new ToolRegistry();
    registerBuiltinTools(reg, new TaskStore(), new MemoryStore(), brokenEvs, probe.fn);
    const r = await reg.execute('ask', args);
    check('G16 事件库写失败时回话带提示（不静默丢决定）',
      r.status === 'ok' && r.content.includes('事件库写入失败'), r.content.slice(-90));
  }
} finally {
  process.chdir(cwd0);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

/* ── ⑧ 行为：createForkAsker 的 fail-closed ── */
console.log('── ⑧ 行为：createForkAsker（非 TTY 绝不替用户选）──');

{
  let selectCalls = 0;
  const spySelect = async (): Promise<string | undefined> => {
    selectCalls++;
    return '0';
  };

  const noTty = createForkAsker(spySelect, () => false);
  const got = await noTty('选哪个？', buildChoices(cands));
  check('H1 非 TTY → 返回 null（没做选择）', got === null, String(got));
  check('H2 非 TTY 时**选择器一次都没被调用**（这条最承重：调了就等于替用户选了）',
    selectCalls === 0, `被调用 ${selectCalls} 次`);

  const yesTty = createForkAsker(spySelect, () => true);
  const got2 = await yesTty('选哪个？', buildChoices(cands));
  check('H3 TTY → 透传选择器的值', got2 === '0', String(got2));
  check('H4 TTY 时才真的调用选择器', selectCalls === 1, `被调用 ${selectCalls} 次`);

  const cancelAsker = createForkAsker(async () => undefined, () => true);
  check('H5 选择器返回 undefined（Ctrl+C 取消）→ null', (await cancelAsker('x', buildChoices(cands))) === null);

  const boomAsker = createForkAsker(async () => { throw new Error('选择器炸了'); }, () => true);
  check('H6 选择器抛异常 → null（当作没问成，**绝不猜一个答案**）',
    (await boomAsker('x', buildChoices(cands))) === null);

  const custom = createForkAsker(undefined, () => false);
  check('H7 不传选择器也走同一道 fail-closed 闸', (await custom('x', buildChoices(cands))) === null);
}

/* ── ⑨ 源码守护 ── */
console.log('── ⑨ 源码守护 ──');

const forkSrc = fs.readFileSync(path.join(ROOT, 'src/project/fork.ts'), 'utf8');
check('I1 fork.ts 零 import（纯函数模块）', !/^import /m.test(forkSrc));
check('I2 fork.ts 不落盘、不碰终端',
  !/writeFileSync|appendFileSync|readFileSync|'node:fs'|process\.stdin|process\.stdout/.test(forkSrc));

const builtinSrc = fs.readFileSync(path.join(ROOT, 'src/tools/builtin.ts'), 'utf8');
check('I3 工具层不 import io 层（否则 UI 层会被拖进 RPC 启动路径）',
  !/from '\.\.\/io\//.test(builtinSrc));
check('I4 缺省提问实现是 NO_INTERACTION（安全的那一侧）',
  builtinSrc.includes('askFn: AskFn = NO_INTERACTION'));
check('I5 ask 工具不带 requirePermission（提问不是写操作，别再套一层弹窗）',
  /name: 'ask',[\s\S]{0,400}?spec: \{/.test(builtinSrc) && !/name: 'ask',[\s\S]{0,200}?requirePermission/.test(builtinSrc));

const promptSrc = fs.readFileSync(path.join(ROOT, 'src/io/ui/fork-prompt.ts'), 'utf8');
check('I6 fork-prompt.ts 先判终端再调选择器（顺序反了就等于替用户选）',
  promptSrc.indexOf('if (!isTty())') >= 0
  && promptSrc.indexOf('if (!isTty())') < promptSrc.indexOf('(select ?? defaultSelect)'),
  `isTty 在 ${promptSrc.indexOf('if (!isTty())')}，调用在 ${promptSrc.indexOf('(select ?? defaultSelect)')}`);
check('I7 缺省终端探测是 process.stdin.isTTY',
  /isTty:\s*\(\)\s*=>\s*boolean\s*=\s*\(\)\s*=>\s*process\.stdin\.isTTY\s*===\s*true/.test(promptSrc));

const mainSrc = fs.readFileSync(path.join(ROOT, 'src/harness/main.ts'), 'utf8');
check('I8 main.ts 注入 createForkAsker 且接的是 runtime.select（走组件树，不被面板刷新盖掉）',
  mainSrc.includes("createForkAsker((items, title) => runtime.select(items, title))"));
check('I9 main.ts 把 asker 传给 registerBuiltinTools 的第 5 参',
  /registerBuiltinTools\(tools,\s*taskStore,\s*memoryStore,\s*eventStore,/.test(mainSrc));

console.log('');
console.log(`结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
process.exit(failed > 0 ? 1 : 0);
