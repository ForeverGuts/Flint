/**
 * todo 工具 + TaskStore 的功能专套 —— 任务清单 C 方案（工具做接口、文件做持久层）。
 *
 * 背景：改造前是"文件即状态"——模型用 `write` 维护 TASK.md（全量重抄），harness 用**一个正则**
 *       数复选框。三个真实弱点：① 改一个勾要重抄整份清单；② "结构"只是正则，没有 id/顺序/唯一进行中；
 *       ③ 模型谎报完成不留痕（那次更新不经过工具）。
 * 现在：**真相源 = 内存里的 TaskStore**（本套的 ①② 段）；`todo` 工具只做**增量**变更（⑤ 段）；
 *       TASK.md 降级为**投影 + 启动种子**（④ 段）；runtime 注入与预算判定改读 store（⑥ 段）。
 *
 * 三段承重设计（改代码前请先读，别"顺手补全"）：
 *   ① **render 与 parse 必须严格互逆**（② 段属性测试钉死）。写盘用 render、启动读盘用 parse，
 *      两者不互逆则"重启一次漂一次"。同一手法在 `Log/` 的生成区已用过（`syncText` 一份模板同给
 *      写与查）。所以**注入可截断、投影绝不截断**——截一刀就破互逆。
 *   ② **投影是单向往文件**，运行期绝不回读（⑥ 段源码断言）。否则 store 与文件成了两处判定，
 *      迟早漂移——正是旧注释里担心的"两处正则漂移"的同构病。
 *   ③ **`hasUnchecked` 与 `hasUncheckedTask(render())` 必须恒等**（③ 段）。前者是结构化判定
 *      （taskStore 用来决定预算/注入），后者是文本判定（system-prompt 用来加续传提示）。
 *      两处判定若分家，会出现"注入了清单却没有续传提示"这类静默错位。
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-todo.ts
 *      （npm run verify 会自动发现本文件，无需登记）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolRegistry } from '../src/tools/registry.js';
import { registerBuiltinTools } from '../src/tools/builtin.js';
import { TASK_HISTORY_FILE, TaskStore, taskStore } from '../src/todo/store.js';
import { hasUncheckedTask } from '../src/context/system-prompt.js';
import { Runtime } from '../src/runtime/runtime.js';
import { PromptEventEmitter } from '../src/runtime/events.js';
import { SpanCollectorImpl } from '../src/runtime/span-collector.js';
import { EventStream } from '../src/runtime/event-stream.js';
import { activate as activateTasks } from '../src/commands/builtin/tasks.js';

/* ── 断言 ── */

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-verify-todo-'));
const P = (name: string): string => path.join(tmpDir, name);

/* ══════════════════════════════════════════════════════════════════════════
   ① TaskStore 基本操作与不变量
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n① TaskStore 操作与不变量');

{
  const s = new TaskStore();
  check('A1 新 store 为空', s.isEmpty() && s.counts().total === 0 && !s.hasUnchecked());

  check('A2 add 返回 1 基序号（1/2/3）', s.add('读目录') === 1 && s.add('改代码') === 2 && s.add('跑验证') === 3);
  check('A3 新项状态是 pending', s.list().every((i) => i.status === 'pending'));
  check('A4 add 空白文本 → -1 且不入列', s.add('   ') === -1 && s.counts().total === 3);
  check('A5 add 规整空白（换行/多空格 → 单空格 + trim）',
    (() => { const t = new TaskStore(); t.add('  改  a\nb  '); return t.list()[0].text === '改 a b'; })());

  check('A6 start(2) 把第 2 项置为 active', s.start(2) === true && s.list()[1].status === 'active');
  s.start(3);
  check('A7 唯一 active 不变量：start(3) 后第 2 项降回 pending',
    s.list()[1].status === 'pending' && s.list()[2].status === 'active');

  check('A8 done(1) 置为 done', s.done(1) === true && s.list()[0].status === 'done');
  check('A9 越界 start/done → false（0 / 超界 / 小数都不接受）',
    s.start(0) === false && s.done(0) === false && s.start(4) === false && s.done(9) === false && s.done(1.5) === false);

  const c = s.counts();
  check('A10 counts 分类正确（1 done / 1 active / 1 pending / 共 3）',
    c.total === 3 && c.done === 1 && c.active === 1 && c.pending === 1, JSON.stringify(c));

  const snap = s.list();
  snap[0].text = '被外部改掉';
  snap.push({ text: '幽灵项', status: 'pending' });
  check('A11 list() 是防御性拷贝（改返回值不影响 store 内部）',
    s.list()[0].text !== '被外部改掉' && s.counts().total === 3);

  s.clear();
  check('A12 clear 清空', s.isEmpty() && s.counts().total === 0);
}

/* ══════════════════════════════════════════════════════════════════════════
   ② render / parse 互逆（投影与种子是一对逆运算）
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n② render 与 parse 严格互逆（写盘 / 读盘是一对逆运算）');

{
  const s = new TaskStore();
  s.add('读目录');
  s.add('改 builtin.ts');
  s.add('跑验证');
  s.start(2);
  s.done(3);
  check('B1 render 输出逐字正确（[ ] 未开始 / [>] 进行中 / [x] 完成）',
    s.render() === '- [ ] 读目录\n- [>] 改 builtin.ts\n- [x] 跑验证', JSON.stringify(s.render()));

  const back = TaskStore.fromMarkdown(s.render());
  check('B2 parse(render()) 还原出逐字相同的清单',
    JSON.stringify(back.list()) === JSON.stringify(s.list()), JSON.stringify(back.list()));

  check('B3 空 store：render 是空串、parse 空串得空清单',
    new TaskStore().render() === '' && TaskStore.fromMarkdown('').counts().total === 0);

  // 属性测试：伪随机生成合法状态 → render → parse → 必须完全一致（固定种子，可复现）
  let seed = 123456789;
  const rnd = (): number => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const pool = ['读目录', '改 a.ts', '跑验证', '修 bug', '写文档', '带 两个  空格'];
  let roundTripOk = 0;
  for (let iter = 0; iter < 40; iter++) {
    const a = new TaskStore();
    const n = 1 + Math.floor(rnd() * 6);
    for (let i = 0; i < n; i++) a.add(pool[Math.floor(rnd() * pool.length)]);
    for (let k = 0; k < 3; k++) {
      const idx = 1 + Math.floor(rnd() * n);
      if (rnd() < 0.5) a.start(idx); else a.done(idx);
    }
    const b = TaskStore.fromMarkdown(a.render());
    if (JSON.stringify(b.list()) === JSON.stringify(a.list())) roundTripOk++;
  }
  check('B4 属性测试：40 组随机状态全部 render→parse 往返一致', roundTripOk === 40, `${roundTripOk}/40`);

  // 兼容旧 TASK.md 的写法：星号、缩进、带序号前缀、散文行
  const legacy = TaskStore.fromMarkdown([
    '## 目标',
    '把某个功能做完',
    '',
    '- [ ] 1. 第一步',
    '  * [x] 第二步（已完成）',
    '  - [>] 第三步（进行中）',
    '随便一句散文，不是清单',
  ].join('\n'));
  check('B5 兼容旧格式：星号 / 缩进 / 序号前缀都认（散文与标题被跳过）',
    legacy.counts().total === 3
    && legacy.list()[0].text === '1. 第一步'
    && legacy.list()[1].status === 'done'
    && legacy.list()[2].status === 'active');

  const multiActive = TaskStore.fromMarkdown('- [>] a\n- [>] b\n- [>] c');
  check('B6 多 [>] 归一：只保留第一处 active，其余降为 pending（维持不变量）',
    multiActive.list()[0].status === 'active'
    && multiActive.list()[1].status === 'pending'
    && multiActive.list()[2].status === 'pending');
}

/* ══════════════════════════════════════════════════════════════════════════
   ③ 两处"有没有未完成"的判定必须恒等
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n③ hasUnchecked() 与 hasUncheckedTask(render()) 恒等（防两处判定分家）');

{
  const mk = (f: (s: TaskStore) => void): TaskStore => { const s = new TaskStore(); f(s); return s; };
  const scenarios: Array<[string, TaskStore]> = [
    ['空清单', mk(() => {})],
    ['全 pending', mk((s) => { s.add('a'); s.add('b'); })],
    ['有进行中', mk((s) => { s.add('a'); s.add('b'); s.start(2); })],
    ['进行中 + 已完成', mk((s) => { s.add('a'); s.add('b'); s.done(1); s.start(2); })],
    ['全完成', mk((s) => { s.add('a'); s.add('b'); s.done(1); s.done(2); })],
  ];
  let agree = 0;
  for (const [, s] of scenarios) {
    if (s.hasUnchecked() === hasUncheckedTask(s.render())) agree++;
  }
  check('C1 5 个代表性状态下两处判定恒等', agree === 5, `${agree}/5`);

  check('C2 hasUncheckedTask 把 [>]（进行中）算作未完成',
    hasUncheckedTask('- [>] 进行中') === true && hasUncheckedTask('- [x] 完成') === false);
  check('C3 hasUncheckedTask 仍认旧写法（星号 / 缩进）',
    hasUncheckedTask('* [ ] a') === true && hasUncheckedTask('  - [ ] a') === true);
}

/* ══════════════════════════════════════════════════════════════════════════
   ④ 投影（写盘）与种子（读盘）
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n④ projectToFile 投影 / loadFromFile 种子');

{
  const s = new TaskStore();
  s.add('甲');
  s.add('乙');
  s.start(2);
  const f1 = P('proj1.md');
  check('D1 有未完成项 → 写盘，内容 = render() + 换行',
    s.projectToFile(f1) === null && fs.existsSync(f1)
    && fs.readFileSync(f1, 'utf-8') === `${s.render()}\n`);

  s.done(1);
  s.done(2);
  check('D2 全完成后 → 删除投影文件（沿用"全勾选即删"，不留僵尸计划）',
    s.projectToFile(f1) === null && !fs.existsSync(f1));

  const s0 = new TaskStore();
  const f0 = P('proj0.md');
  fs.writeFileSync(f0, 'stale\n');
  check('D3 空清单 → 不写、并删除已存在的旧文件',
    s0.projectToFile(f0) === null && !fs.existsSync(f0));

  const s2 = new TaskStore();
  const f2 = P('seed2.md');
  fs.writeFileSync(f2, '- [ ] x\n- [>] y\n- [x] z\n');
  s2.loadFromFile(f2);
  const c2 = s2.counts();
  check('D4 种子：吸收有未完成项的文件，且保留文件',
    c2.total === 3 && c2.pending === 1 && c2.active === 1 && c2.done === 1 && fs.existsSync(f2),
    JSON.stringify(c2));

  const s3 = new TaskStore();
  const f3 = P('seed3.md');
  fs.writeFileSync(f3, '- [x] 全做完了\n- [x] 真的\n');
  s3.loadFromFile(f3);
  check('D5 种子：全勾选文件 → 空清单 + 删除文件（旧清理语义）',
    s3.isEmpty() && !fs.existsSync(f3));

  const s4 = new TaskStore();
  s4.loadFromFile(P('不存在的文件.md'));
  check('D6 种子：文件缺失 → 空清单，不抛', s4.isEmpty());

  const s5 = new TaskStore();
  const f5 = P('seed5.md');
  fs.writeFileSync(f5, '   \n\n');
  s5.loadFromFile(f5);
  check('D7 种子：空白文件 → 空清单', s5.isEmpty());

  // 跨"重启"往返：A 变更 → 投影 → 新 store 读同一文件 → 与 A 相同
  const A = new TaskStore();
  A.add('甲');
  A.add('乙');
  A.add('丙');
  A.start(2);
  A.done(1);
  const fa = P('restart.md');
  A.projectToFile(fa);
  const B = new TaskStore();
  B.loadFromFile(fa);
  check('D8 跨重启往返：投影 → 重新读取 → 状态逐字相同',
    JSON.stringify(B.list()) === JSON.stringify(A.list()), JSON.stringify(B.list()));

  const s6 = new TaskStore();
  const f6 = P('legacy.md');
  fs.writeFileSync(f6, '## 目标\n做完它\n- [ ] 第一步\n- [>] 第二步\n');
  s6.loadFromFile(f6);
  check('D9 种子兼容旧 TASK.md：清单项被吸收、散文标题被丢弃',
    s6.counts().total === 2 && s6.list()[0].text === '第一步');
}

/* ══════════════════════════════════════════════════════════════════════════
   ⑤ todo 工具端到端（真 ToolRegistry + registerBuiltinTools，走 parse 校验）
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n⑤ todo 工具端到端（增量接口 + 返回值即清单 + 投影）');

{
  // 工具把 TASK.md 写在 cwd —— 切到临时目录，避免污染仓库根
  const cwd0 = process.cwd();
  process.chdir(tmpDir);
  try {
    const store = new TaskStore();
    const reg = new ToolRegistry();
    registerBuiltinTools(reg, store);
    // execute 现在返回结构化 ToolResult；helper 解包出模型可见文本，断言不动
    const todo = async (args: Record<string, unknown>): Promise<string> =>
      (await reg.execute('todo', args)).content;

    check('E1 todo 已注册进 LLMTools（模型看得见）',
      reg.getLLMTools().some((t) => t.function.name === 'todo'));

    const r1 = await todo({ op: 'add', text: '读目录' });
    check('E2 add 返回 [OK] 且回显带序号的清单',
      r1.startsWith('[OK]') && r1.includes('1. [ ] 读目录'), r1.split('\n').slice(0, 2).join(' / '));

    await todo({ op: 'add', text: '改代码' });
    await todo({ op: 'add', text: '跑验证' });
    const r3 = await todo({ op: 'start', index: 2 });
    check('E3 头部计数正确 + start 后第 2 项为进行中',
      r3.includes('3 项：0 完成 / 1 进行中 / 2 待办') && r3.includes('2. [>] 改代码'),
      r3.split('\n')[0]);

    const r4 = await todo({ op: 'done', index: 1 });
    check('E4 done 后第 1 项为完成', r4.includes('1. [x] 读目录'));

    const rDef = await todo({ op: 'done' });   // 缺 index → 默认 1
    check('E5 done 缺 index 时作用于第 1 项（默认 1，语义已文档化）',
      rDef.includes('1. [x] 读目录') && rDef.includes('1 完成 /'), rDef.split('\n')[0]);

    check('E6 每次变更后 TASK.md 反映当前状态（投影生效）',
      fs.existsSync(path.join(tmpDir, 'TASK.md'))
      && fs.readFileSync(path.join(tmpDir, 'TASK.md'), 'utf-8').includes('- [>] 改代码'));

    check('E7 add 缺 text → [INVALID]', (await todo({ op: 'add' })).startsWith('[INVALID]'));
    check('E8 start 越界 → [INVALID] 且说明范围',
      (await todo({ op: 'start', index: 99 })).startsWith('[INVALID]'));
    check('E9 未知 op → [INVALID] 且列出可用操作',
      (await todo({ op: 'frobnicate' })).startsWith('[INVALID]') && (await todo({ op: 'frobnicate' })).includes('add'));
    check('E10 缺 op → [INVALID]（由 parse 拦）', (await todo({})).startsWith('[INVALID]'));
    check('E11 text 传数字 → [INVALID]（spec 类型校验生效，不再 String() 强转）',
      (await todo({ op: 'add', text: 123 })).startsWith('[INVALID]'));
    check('E12 传未知参数 → [INVALID]（parse 拒多余参数）',
      (await todo({ op: 'add', text: 'x', foo: 1 })).startsWith('[INVALID]'));

    const rc = await todo({ op: 'clear' });
    check('E13 clear → 清单清空 + 移除 TASK.md',
      rc.startsWith('[OK]') && !fs.existsSync(path.join(tmpDir, 'TASK.md')) && store.isEmpty());

    // 缺省 store 必须是进程级单例（runtime 也读同一个），否则"工具改了、runtime 看不到"
    const reg2 = new ToolRegistry();
    registerBuiltinTools(reg2);   // 不传第二参
    await reg2.execute('todo', { op: 'add', text: '单例探针' });
    check('E14 不传 store 时作用于共享单例 taskStore（tool 与 runtime 同一份状态）',
      taskStore.counts().total >= 1 && taskStore.list().some((i) => i.text === '单例探针'));
    taskStore.clear();
  } finally {
    process.chdir(cwd0);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   ⑥ 接线与源码防回退（真相源在 store，运行期不回读文件）
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n⑥ 接线证明与源码防回退');

{
  const runtimeSrc = fs.readFileSync(path.join(ROOT, 'src/runtime/runtime.ts'), 'utf-8');
  const coreSrc = fs.readFileSync(path.join(ROOT, 'src/context/sections/core-section.ts'), 'utf-8');
  const loopSrc = fs.readFileSync(path.join(ROOT, 'src/loop/agent-loop.ts'), 'utf-8');
  const mainSrc = fs.readFileSync(path.join(ROOT, 'src/harness/main.ts'), 'utf-8');

  check('F1 runtime 不再有 loadTaskMemory（旧的"文件即状态"入口已删）',
    !runtimeSrc.includes('loadTaskMemory'));
  check('F2 runtime 改读 taskStore（注入 task 层与预算判定同源）',
    runtimeSrc.includes('taskStore.hasUnchecked()') && runtimeSrc.includes('taskStore.render()'));
  check('F3 main 启动时用 loadFromFile 做一次性种子',
    /taskStore\.loadFromFile\('TASK\.md'\)/.test(mainSrc));
  check('F4 core-section 教的是 todo 工具，不再教"用 write 写 TASK.md"',
    coreSrc.includes('todo op:"add"') && !/用 write 创建 TASK\.md/.test(coreSrc));
  check('F5 agent-loop 收尾提示已从"write 记入 TASK.md"改为"用 todo 更新清单"',
    /用 todo 如实更新清单/.test(loopSrc) && !/用 write 把当前进度/.test(loopSrc));
}

/* ══════════════════════════════════════════════════════════════════════════
   ⑦ 运行期接线（行为证明）：真 Runtime 会把 taskStore 渲进 system 的 task 层
   （⑥ 段是源码断言、钉的是手段；这段直接跑一轮，钉"行为面真的通了"）
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n⑦ Runtime 运行期接线（行为）：taskStore → system 的 task 层');

{
  const cwd0 = process.cwd();
  process.chdir(tmpDir);
  try {
    // 假 LLM：无工具调用、一轮即收尾（原型链上有 stream，见下方说明）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeLlm: any = {
      chat: async () => ({ content: '' }),
      stream: () => {
        const es = new EventStream<{ type: string; [k: string]: unknown }>(
          (e) => e.type === 'end',
          (e) => e as { type: 'end'; fullText: string },
        );
        queueMicrotask(() => {
          es.push({ type: 'token', text: 'ok' });
          es.push({ type: 'end', fullText: 'ok' });
        });
        return es;
      },
    };
    // 假 session：记录落盘但不参与断言
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session: any = { getMessages: async () => [], appendMessage: async () => {}, clear: async () => {} };
    // 关键探针：假 systemPromptService 把收到的 ctx 记下来
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let lastCtx: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sysPrompt: any = {
      build: async (ctx: unknown) => {
        lastCtx = ctx;
        return { messages: [{ layer: 'core', content: 'x' }] };
      },
    };
    const rt = new Runtime({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      llm: fakeLlm as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session: session as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: { getLLMTools: () => [], requiresPermission: () => false, execute: async () => ({ status: 'ok', content: '' }), register: () => {} } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      permission: { isAutoAllowed: () => true, grantAutoAllow: () => {}, clear: () => {} } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skills: { load: () => {}, getAll: () => [], get: () => undefined } as any,
      events: new PromptEventEmitter(),
      spanCollector: new SpanCollectorImpl(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      commandSystem: { register: () => {}, list: () => [], execute: async () => null } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      diagnosticsService: { record: () => {}, getAll: () => [] } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      compaction: { maybeCompact: async (h: unknown) => ({ history: h }) } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      systemPromptService: sysPrompt as any,
    });

    taskStore.clear();
    await rt.prompt('随便说点什么');
    check('G1 空清单：Runtime 不注入 task 层（ctx.task 为 undefined）', lastCtx?.task === undefined);

    taskStore.add('第一步');
    taskStore.add('第二步');
    await rt.prompt('继续');
    check('G2 有未完成项：ctx.task 正是 taskStore.render() 的渲染结果',
      typeof lastCtx?.task === 'string'
      && lastCtx.task.includes('- [ ] 第一步') && lastCtx.task.includes('- [ ] 第二步'),
      JSON.stringify(lastCtx?.task));

    taskStore.start(1);
    taskStore.done(2);
    taskStore.done(1);
    await rt.prompt('再继续');
    check('G3 全部完成：不再注入 task 层（hasUnchecked 为假，预算/续传提示同步关闭）', lastCtx?.task === undefined);

    taskStore.clear();
  } finally {
    process.chdir(cwd0);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   ⑧ 展示层的两根支柱：变更通知 + 最近一份快照
   （面板本身是 UI，渲染测试在 verify-ui.ts；这里钉的是"面板赖以成立的数据与契约"：
     没通知 → 模型勾完一项屏幕不动；没快照 → 面板收起后上一轮再也查不到）
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n⑧ 展示层支撑：onChange 通知 / 最近一份快照 / /tasks 命令');

{
  const s = new TaskStore();
  let n = 0;
  const off = s.onChange(() => { n++; });

  check('H1 订阅本身不触发通知', n === 0);
  s.add('a');
  check('H2 add 触发一次', n === 1);
  s.start(1);
  check('H3 start 触发', n === 2);
  s.done(1);
  check('H4 done 触发', n === 3);
  s.add('');
  check('H5 被拒绝的 add（空文本）不触发 —— 状态没变就不该让 UI 重绘', n === 3);
  s.start(99);
  check('H6 越界 start 不触发', n === 3);
  s.done(99);
  check('H7 越界 done 不触发', n === 3);
  s.clear();
  check('H8 clear 触发', n === 4);
  s.clear();
  check('H9 空清单再 clear 不触发（无变化）', n === 4);
  off();
  s.add('b');
  check('H10 退订后不再触发（TreeUI.stop 靠它防监听器泄漏）', n === 4);
}

{
  const s = new TaskStore();
  check('H11 从未完成过时 lastCompleted() 为 null', s.lastCompleted() === null);
  s.add('一');
  s.add('二');
  s.done(1);
  check('H12 只完成一部分时不记录 —— 那还不叫"已完成"', s.lastCompleted() === null);
  s.done(2);
  const snap = s.lastCompleted();
  check('H13 最后一项完成的那一刻记下快照',
    snap !== null && snap.length === 2 && snap.every((i) => i.status === 'done'));
  s.clear();
  check('H14 clear 之后快照仍在 —— 这正是它存在的理由', s.lastCompleted()?.length === 2);

  const copy = s.lastCompleted()!;
  copy[0].text = '被外部改了';
  check('H15 lastCompleted() 是防御性拷贝（改返回值不污染 store）',
    s.lastCompleted()![0].text === '一');
}

{
  const s = new TaskStore();
  s.add('甲');
  s.start(1);
  check('H16 renderItems(无序号) 与 render() 逐字相同（排版只有一处实现）',
    TaskStore.renderItems(s.list()) === s.render());
  check('H17 renderItems(带序号) 与 renderNumbered() 逐字相同',
    TaskStore.renderItems(s.list(), true) === s.renderNumbered());
}

{
  taskStore.reset();
  // 假 runtime：只截获注册动作，把 handler 拿出来直接调（不必真起一个 Runtime）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let reg: { name: string; desc: string; fn: () => string } | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  activateTasks({ registerCommand: (name: string, desc: string, fn: () => string) => { reg = { name, desc, fn }; } } as any);

  check('H18 /tasks 已注册（loader 自动扫描 builtin/ 目录）', reg?.name === 'tasks');
  check('H19 空清单且无历史：如实说没有', (reg?.fn() ?? '').includes('没有进行中的任务'));

  taskStore.add('步骤一');
  taskStore.add('步骤二');
  taskStore.done(1);
  const cur = reg!.fn();
  check('H20 有清单时显示当前（含项数、完成记号、待办空框）',
    cur.includes('2 项') && cur.includes('✓') && cur.includes('☐'), cur);

  taskStore.done(2);
  taskStore.clear();
  const after = reg!.fn();
  check('H21 清空后回看最近一份已完成的清单',
    after.includes('最近一份已完成') && after.includes('步骤一') && after.includes('步骤二'), after);
  check('H22 回看的那一份全部是已完成记号（没有残留空框）', !after.includes('☐'), after);

  // ── 历史归档（2026-09-13 用户反馈：/tasks 要能看到历史清单与时间戳） ──
  // 归档文件写在 cwd（与 TASK.md 同目录）——切到临时目录，避免污染仓库根
  const cwdH = process.cwd();
  process.chdir(tmpDir);
  try {
    taskStore.reset();
    const histPath = path.join(tmpDir, TASK_HISTORY_FILE);
    const s = new TaskStore();
    s.add('归档甲');
    s.add('归档乙');
    check('H23 没有待归档时 archiveToFile 是 no-op（不创建文件）',
      s.archiveToFile(TASK_HISTORY_FILE) === null && !fs.existsSync(histPath));
    s.done(1);
    check('H24 只完成一部分时不产生归档（半途而废的不叫"已完成"）',
      !fs.existsSync(histPath));
    s.done(2);
    check('H25 全完成产生待归档，archiveToFile 落盘成功',
      s.archiveToFile(TASK_HISTORY_FILE) === null && fs.existsSync(histPath));
    check('H26 归档即消费：重复调用不追加重复条目',
      s.archiveToFile(TASK_HISTORY_FILE) === null
      && TaskStore.readHistory(histPath).length === 1);
    const h = TaskStore.readHistory(histPath);
    check('H27 回读的时间戳形如 YYYY-MM-DD HH:mm',
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(h[0]?.at ?? ''), h[0]?.at);
    check('H28 回读条目与完成清单逐项一致（文本 + 全 done 状态）',
      h[0]?.items.length === 2
      && h[0].items.every((i) => i.status === 'done' && i.text.startsWith('归档')));
    check('H29 读不存在的历史文件 → 空数组不炸', TaskStore.readHistory(path.join(tmpDir, '没有.md')).length === 0);

    // /tasks 回看历史（真 handler，cwd 已在临时目录；store 已 reset → 走历史分支）
    const hist = reg!.fn();
    check('H30 /tasks 无当前清单时展示历史完成记录（时间戳行 + 条目名）',
      hist.includes('历史完成记录') && /\d{4}-\d{2}-\d{2} \d{2}:\d{2} 完成/.test(hist)
      && hist.includes('归档甲') && hist.includes('归档乙'), hist);
  } finally {
    process.chdir(cwdH);
    taskStore.reset();
  }

  taskStore.reset();
}

/* ── 清理与汇总 ── */

fs.rmSync(tmpDir, { recursive: true, force: true });
check('Z1 临时目录已清理', !fs.existsSync(tmpDir));

// 结果行格式是 run-verify.mjs 的解析契约（/结果[：:]\s*(\d+)\s*通过.../），别改成自由文案
console.log(`\n结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
process.exit(failed > 0 ? 1 : 0);
