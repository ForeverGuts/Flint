/**
 * 历史事件库（EventStore）+ record_event / search_events 工具 + /events 命令的功能专套。
 *
 * 结构沿用 verify-todo / verify-memory 的三段承重纪律：
 *   ① store 操作与不变量（id/time 生成、空段缺省不写键、追加落盘、写失败返回 warn）
 *   ② search 检索（kind/tag/keyword/limit、最新在前、大小写不敏感）
 *   ③ loadFromFile 种子（坏行跳过 / 缺文件 / 跨"重启"往返）
 *   ④ recordToolCall（打卡自动捕获的映射：CollectedSpan → 事件条目）
 *   ⑤ 自动捕获行为证明（真总线 + 真 SpanCollector 配对，tool_call 才记、prompt 不记）
 *   ⑥ record_event / search_events 工具端到端（真 ToolRegistry，走 parse 校验）
 *   ⑦ /events 命令（kind=/tag=/q=/limit= 参数解析）
 *   ⑧ 源码防回退（追加型纪律 / 双消费者共用排版 / 打卡接线 / core-section 教学）
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-eventlog.ts
 *      （npm run verify 会自动发现本文件，无需登记）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolRegistry } from '../src/tools/registry.js';
import { registerBuiltinTools } from '../src/tools/builtin.js';
import { EVENTS_FILE, EventStore, eventStore, formatEvent } from '../src/eventlog/store.js';
import { TaskStore } from '../src/todo/store.js';
import { MemoryStore } from '../src/memory/store.js';
import { PromptEventEmitter } from '../src/runtime/events.js';
import { SpanCollectorImpl } from '../src/runtime/span-collector.js';
import type { CollectedSpan } from '../src/core/events.js';
import { activate as activateEventsCmd } from '../src/commands/builtin/events.js';

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
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-verify-eventlog-'));
const P = (name: string): string => path.join(tmpDir, name);

/* ══════════════════════════════════════════════════════════════════════════
   ① EventStore 操作与不变量
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n① EventStore 操作与追加落盘');

{
  const s = new EventStore();
  const f = P('ev1.jsonl');
  check('A1 新 store 为空', s.count() === 0);

  const r1 = s.addNarrative({
    kind: 'decision', title: 'edit 多命中时拒绝',
    context: '旧实现猜第一处', decision: '拒绝并回报候选行号',
    reason: '猜会静默改错地方', outcome: '误伤清零', tags: ['edit', '安全'],
  }, f);
  check('A2 addNarrative 生成 id / ISO 时间 / kind / title',
    r1.entry.id.startsWith('ev_') && !Number.isNaN(Date.parse(r1.entry.time))
    && r1.entry.kind === 'decision' && r1.entry.title === 'edit 多命中时拒绝');

  check('A3 空段缺省不写键（只有 title 的条目没有 context 键）',
    (() => {
      const { entry } = s.addNarrative({ kind: 'experience', title: '只有标题' }, f);
      return !('context' in entry) && !('decision' in entry) && entry.tags.length === 0;
    })());

  check('A4 叙事段规整空白并裁剪（换行压空格）',
    (() => {
      const { entry } = s.addNarrative({ kind: 'incident', title: '  带  空格  ', context: 'a\nb' }, f);
      return entry.title === '带 空格' && entry.context === 'a b';
    })());

  check('A5 追加落盘：行数 == 条数，每行一个 JSON 且可解析回来',
    fs.readFileSync(f, 'utf-8').split('\n').filter((l) => l.trim()).length === s.count()
    && JSON.parse(fs.readFileSync(f, 'utf-8').trim().split('\n')[0]).title === 'edit 多命中时拒绝');

  check('A6 all() 是防御性拷贝（改 tags 不污染内部）',
    (() => {
      const snap = s.all();
      snap[0].tags.push('幽灵');
      snap[0].title = '被外部改掉';
      return s.all()[0].tags.length === 2 && s.all()[0].title !== '被外部改掉';
    })());

  // 落盘失败不抛、返回 warn（用目录当文件路径制造 EISDIR/EPERM）
  fs.mkdirSync(P('一个目录'));
  const bad = s.addNarrative({ kind: 'experience', title: '写不进去' }, P('一个目录'));
  check('A7 落盘失败 → 返回 warn，内存索引仍然有效（不炸调用方）',
    typeof bad.warn === 'string' && bad.warn.length > 0 && s.count() === 4);
}

/* ══════════════════════════════════════════════════════════════════════════
   ② search 检索
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n② search 检索（kind / tag / keyword / limit）');

{
  const s = new EventStore();
  const f = P('ev2.jsonl');
  s.addNarrative({ kind: 'decision', title: '权限弹窗改走组件树', tags: ['ui', '权限'], reason: '结构性消灭抢屏' }, f);
  s.addNarrative({ kind: 'incident', title: 'CRLF 导致 edit 零命中', tags: ['edit', '编码'], outcome: '归一化副本上匹配' }, f);
  s.addNarrative({ kind: 'experience', title: '先读原文再改', tags: ['edit'] }, f);
  s.addNarrative({ kind: 'decision', title: 'todo 用内存真相源', tags: ['todo', '架构'] }, f);

  check('B1 不过滤：全部命中且**最新在前**',
    (() => {
      const hits = s.search({});
      return hits.length === 4 && hits[0].title === 'todo 用内存真相源' && hits[3].title === '权限弹窗改走组件树';
    })());

  check('B2 按 kind 过滤',
    s.search({ kind: 'decision' }).length === 2 && s.search({ kind: 'incident' }).length === 1);
  check('B3 按 tag 精确匹配（一个标签就行，不要求全中）',
    s.search({ tag: 'edit' }).length === 2 && s.search({ tag: '架构' }).length === 1);
  check('B4 按 keyword 子串过滤（命中标题/段落/标签）',
    s.search({ keyword: '抢屏' }).length === 1 && s.search({ keyword: 'EDIT' }).length === 2);
  check('B5 keyword 不区分大小写', s.search({ keyword: 'CRLF' }).length === 1);
  check('B6 limit 截断（取最新的 N 条）',
    s.search({ limit: 2 }).length === 2 && s.search({ limit: 2 })[0].title === 'todo 用内存真相源');
  check('B7 组合过滤（kind + keyword）',
    s.search({ kind: 'decision', keyword: '组件树' }).length === 1
    && s.search({ kind: 'incident', keyword: '组件树' }).length === 0);
  check('B8 命中结果也是防御性拷贝',
    (() => { const h = s.search({ tag: 'edit' }); h[0].tags.push('幽灵'); return s.search({ tag: 'edit' })[0].tags.length === 1; })());
}

/* ══════════════════════════════════════════════════════════════════════════
   ③ loadFromFile 种子（坏行跳过 / 缺文件 / 跨"重启"往返）
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n③ loadFromFile 种子');

{
  const f = P('seed-ev.jsonl');
  const good1 = JSON.stringify({ id: 'ev_1', time: '2026-09-13T08:00:00.000Z', kind: 'decision', title: '甲', tags: ['x'] });
  const good2 = JSON.stringify({ id: 'ev_2', time: '2026-09-13T09:00:00.000Z', kind: 'tool_call', title: '工具 bash 调用', tags: ['tool', 'bash'], turnId: 't1' });
  fs.writeFileSync(f, [good1, '这行不是 JSON', good2, '', '{"kind":42}'].join('\n'));

  const s = new EventStore();
  s.loadFromFile(f);
  check('C1 好行全收、坏行跳过；旧文件里的 tool_call 行**路由进流水索引**（不回写不搬家）',
    s.count() === 1 && s.all()[0].title === '甲'
    && s.countCalls() === 1 && s.allCalls()[0].kind === 'tool_call' && s.allCalls()[0].turnId === 't1');
  check('C2 缺 tags 字段的行归一为空数组（不炸后续检索）',
    s.all().every((e) => Array.isArray(e.tags)) && s.allCalls().every((e) => Array.isArray(e.tags)));

  // 拆分后的检索口径与流水种子
  const sc = new EventStore();
  sc.loadFromFile(f);
  sc.loadCallsFile(P('不存在的流水.jsonl'));
  check('C5 search 缺省只查叙事库（流水是噪音，不混进无过滤结果）',
    sc.search({}).length === 1 && sc.search({}).every((e) => e.kind !== 'tool_call'));
  check('C6 kind=tool_call 改查流水索引（历史流水照旧能查到）',
    sc.search({ kind: 'tool_call' }).length === 1 && sc.search({ kind: 'tool_call' })[0].title === '工具 bash 调用');

  const s0 = new EventStore();
  s0.loadFromFile(P('不存在的.jsonl'));
  check('C3 文件缺失 → 空索引，不抛', s0.count() === 0);

  // 跨"重启"往返：A 逐条追加 → 新 store 读同一文件 → 条目集合一致
  const A = new EventStore();
  const fa = P('restart-ev.jsonl');
  A.addNarrative({ kind: 'decision', title: '第一条', tags: ['a'] }, fa);
  A.addNarrative({ kind: 'incident', title: '第二条', outcome: '已修复' }, fa);
  const B = new EventStore();
  B.loadFromFile(fa);
  check('C4 跨重启往返：重新载入后 title/kind/tags 逐条一致',
    B.count() === 2
    && JSON.stringify(B.all().map((e) => [e.kind, e.title, e.tags]))
      === JSON.stringify(A.all().map((e) => [e.kind, e.title, e.tags])));
}

/* ══════════════════════════════════════════════════════════════════════════
   ④ 机器自动补记（recordToolCall 打卡映射 + recordTaskArchive/recordCompaction 确定性钩子）
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n④ 机器自动补记：recordToolCall / recordTaskArchive / recordCompaction');

{
  const s = new EventStore();
  const f = P('ev4.jsonl');

  const span: CollectedSpan = {
    name: 'tool_call',
    spanId: 's1',
    turnId: 't42',
    seq: 7,
    startedAt: Date.UTC(2026, 8, 13, 8, 0, 0),
    durationMs: 512,
    status: 'ok',
    input: { name: 'bash', args: { command: 'node build.js' } },
    output: { name: 'bash', resultLength: 42 },
  };
  s.recordToolCall(span, f);

  check('D1 kind=tool_call 进**流水索引**（不占叙事库），标题带上工具名，turnId 从 span 带入',
    s.count() === 0 && s.countCalls() === 1
    && s.allCalls()[0].kind === 'tool_call' && s.allCalls()[0].title === '工具 bash 调用'
    && s.allCalls()[0].turnId === 't42');
  const e = s.allCalls()[0];
  check('D2 参数进 context（裁剪到 200 字符内），结果状态进 outcome',
    (e.context ?? '').startsWith('参数:') && e.context?.includes('node build.js')
    && (e.outcome ?? '').includes('status=ok') && (e.outcome ?? '').includes('512ms')
    && (e.outcome ?? '').includes('42 字符'));
  check('D3 tags 固定为 [tool, 工具名]（按工具名检索就是查它）',
    JSON.stringify(e.tags) === JSON.stringify(['tool', 'bash']));
  check('D4 time 取 span 的进门时刻（不是处理时刻）',
    e.time === '2026-09-13T08:00:00.000Z', e.time);

  check('D5 空参数 {} → 不写 context 键（行保持紧凑）',
    (() => {
      s.recordToolCall({ ...span, spanId: 's2', input: { name: 'todo', args: {} }, output: {} }, f);
      const last = s.allCalls()[s.countCalls() - 1];
      return !('context' in last) && (last.outcome ?? '').includes('status=ok');
    })());

  check('D6 流水档案行数与条数一致（tool-calls.jsonl 只装流水）',
    fs.readFileSync(f, 'utf-8').trim().split('\n').length === s.countCalls());

  // 拆分守护：流水进 calls 索引后，search 缺省结果里不该出现它
  check('D7 recordToolCall 后 search 缺省不含流水（叙事库不被淹没）',
    s.search({}).length === 0 && s.search({ kind: 'tool_call' }).length === 2);

  // ── 确定性钩子的两个自动补记方法（与 recordToolCall 同类：机器写 / kind=system / 旁路静默） ──
  check('D7 recordTaskArchive：kind=system，标题带项数与任务名，tags=[task,archive]，落盘',
    (() => {
      const s2 = new EventStore();
      const f2 = P('ev4b.jsonl');
      s2.recordTaskArchive([{ text: '实现功能' }, { text: '跑绿测试' }], f2);
      const e = s2.all()[0];
      return e.kind === 'system' && e.title === '任务清单全完成（2 项）：实现功能、跑绿测试'
        && JSON.stringify(e.tags) === JSON.stringify(['task', 'archive'])
        && (e.outcome ?? '').startsWith('完成清单：')
        && fs.existsSync(f2) && fs.readFileSync(f2, 'utf-8').includes('任务清单全完成');
    })());

  check('D8 recordCompaction：kind=system，摘要快照进 context，tags=[compaction]',
    (() => {
      const s2 = new EventStore();
      const f2 = P('ev4c.jsonl');
      s2.recordCompaction('早前对话要点：用户要求 X，方案 Y 已确认', f2);
      const e = s2.all()[0];
      return e.kind === 'system' && e.title.includes('已压缩')
        && (e.context ?? '').startsWith('摘要快照: ') && (e.context ?? '').includes('方案 Y')
        && JSON.stringify(e.tags) === JSON.stringify(['compaction']) && fs.existsSync(f2);
    })());
}

/* ══════════════════════════════════════════════════════════════════════════
   ⑤ 自动捕获行为证明（真总线 + 真 SpanCollector，与 main.ts 同一接线）
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n⑤ 总线自动捕获（行为）：tool_call span → 事件库');

{
  const s = new EventStore();
  const f = P('ev5.jsonl');
  // 与 main.ts 逐字同一接线的最小复刻
  const bus = new PromptEventEmitter();
  const collector = new SpanCollectorImpl({ capacity: 0 });
  bus.subscribe((raw) => {
    const span = collector.feed(raw);
    if (span && span.name === 'tool_call') s.recordToolCall(span, f);
  });

  // 开一个真回合：总线在 emit 时统一盖 at/seq/turnId（覆盖草稿里的同名草稿字段）——
  // 所以条目里的 turnId 应等于总线当前的 turnId，而不是 start 事件里手写的那个
  const turn = bus.beginTurn();

  // 一段非 tool_call 的骨架 span（prompt）：配对成功但不该进事件库
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (bus as any).emit({ type: 'prompt_start', spanId: 'p1', turnId: turn, seq: 0, at: 900 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (bus as any).emit({ type: 'prompt_end', spanId: 'p1', at: 1000, status: 'ok' });
  check('E1 prompt span 不进事件库（只有工具调用才记）', s.count() === 0 && s.countCalls() === 0);

  // 一段完整 tool_call span：start + end 配对成段 → 自动落流水库
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (bus as any).emit({ type: 'tool_call_start', spanId: 's1', turnId: turn, seq: 3, at: 1000, name: 'grep', args: { pattern: 'TODO', path: 'src/' } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (bus as any).emit({ type: 'tool_call_end', spanId: 's1', at: 1400, status: 'ok', name: 'grep', resultLength: 120 });
  check('E2 完整配对的 tool_call span → 自动追加一条流水（turnId 是总线盖的章，叙事库不动）',
    s.countCalls() === 1 && s.count() === 0 && s.allCalls()[0].title === '工具 grep 调用'
    && s.allCalls()[0].turnId === turn && (s.allCalls()[0].context ?? '').includes('TODO'));

  // 孤儿 end（没有配对的进门）：collector 忽略，事件库不记（与 trace-log 同一规则）
  bus.emit({ type: 'tool_call_end', spanId: '孤儿', at: 1500, status: 'ok' });
  check('E3 孤儿 end 不产生条目（配对规则零重复，直接复用 span-collector）', s.countCalls() === 1);

  check('E4 自动捕获真的落了盘', fs.existsSync(f) && fs.readFileSync(f, 'utf-8').includes('工具 grep 调用'));
}

/* ══════════════════════════════════════════════════════════════════════════
   ⑥ record_event / search_events 工具端到端
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n⑥ record_event / search_events 工具端到端');

{
  const cwd0 = process.cwd();
  process.chdir(tmpDir);
  try {
    const evs = new EventStore();
    const reg = new ToolRegistry();
    registerBuiltinTools(reg, new TaskStore(), new MemoryStore(), evs);
    const record = async (args: Record<string, unknown>): Promise<string> =>
      (await reg.execute('record_event', args)).content;
    const search = async (args: Record<string, unknown>): Promise<string> =>
      (await reg.execute('search_events', args)).content;

    check('F1 两个工具都已注册进 LLMTools',
      reg.getLLMTools().some((t) => t.function.name === 'record_event')
      && reg.getLLMTools().some((t) => t.function.name === 'search_events'));

    const r1 = await record({
      kind: 'incident', title: 'rpc stdout 被污染整条流报废',
      context: 'console.log 混进 stdout', decision: 'rpc 路径禁用 console.log',
      reason: '污染走传输层', outcome: '守护断言上线', tags: 'rpc, stdout，纪律',
    });
    check('F2 record_event 返回 [OK]、带 id 与计数、回显排版',
      r1.startsWith('[OK]') && r1.includes('事件已存档 (ev_') && r1.includes('事件库现有 1 条')
      && r1.includes('[incident]') && r1.includes('背景: console.log'), r1.split('\n').slice(0, 3).join(' / '));

    check('F3 tags 中英文逗号都认（拆成 3 个标签）',
      evs.all()[0].tags.length === 3 && evs.all()[0].tags.includes('纪律'));

    check('F4 kind=tool_call 拒绝（机器流水由打卡自动写，不接受手写）',
      (await record({ kind: 'tool_call', title: 'x' })).startsWith('[INVALID]'));
    check('F5 未知 kind → [INVALID] 且列出可用类型',
      (await record({ kind: 'story', title: 'x' })).startsWith('[INVALID]'));
    check('F6 缺 title / 缺 kind → [INVALID]（由 parse 拦）',
      (await record({ kind: 'decision' })).startsWith('[INVALID]')
      && (await record({ title: 'x' })).startsWith('[INVALID]'));
    check('F7 传未知参数 → [INVALID]',
      (await record({ kind: 'decision', title: 'x', foo: 1 })).startsWith('[INVALID]'));

    await record({ kind: 'decision', title: '权限弹窗改走组件树', tags: 'ui,权限' });
    check('F8 每次追加都落盘（.flint/events.jsonl 行数 == 条数）',
      fs.existsSync(path.join(tmpDir, '.flint/events.jsonl'))
      && fs.readFileSync(path.join(tmpDir, '.flint/events.jsonl'), 'utf-8').trim().split('\n').length === evs.count());

    const s1 = await search({});
    check('F9 无过滤检索：[OK]、最新在前、带序号',
      s1.startsWith('[OK]') && s1.includes('命中 2 条') && s1.indexOf('权限弹窗') < s1.indexOf('stdout'), s1.split('\n')[0]);

    const s2 = await search({ kind: 'incident' });
    check('F10 按 kind 检索只出命中', s2.includes('命中 1 条') && s2.includes('stdout') && !s2.includes('组件树'));
    const s3 = await search({ tag: 'ui' });
    check('F11 按 tag 检索', s3.includes('命中 1 条') && s3.includes('组件树'));
    const s4 = await search({ keyword: 'CONSOLE' });
    check('F12 keyword 不分大小写', s4.includes('命中 1 条') && s4.includes('stdout'));
    const s5 = await search({ keyword: '不存在' });
    check('F13 无命中 → [NO_MATCH]（有效否定，不计失败）并附总数提示',
      s5.startsWith('[NO_MATCH]') && s5.includes('共 2 条'));
    const s6 = await search({ limit: 1 });
    check('F14 limit 截断（最新 1 条）', s6.includes('命中 1 条') && s6.includes('权限弹窗'));

    // 确定性钩子端到端：todo 工具走完整流程，归档时刻自动补记（不经模型）
    const base = evs.count();
    const ts = new TaskStore();
    const reg3 = new ToolRegistry();
    registerBuiltinTools(reg3, ts, new MemoryStore(), evs);
    await reg3.execute('todo', { op: 'add', text: '任务甲' });
    await reg3.execute('todo', { op: 'add', text: '任务乙' });
    await reg3.execute('todo', { op: 'done', index: 1 });
    check('F15 部分完成不触发归档补记（整单走完才补一条，单项过程归 tool_call 流水）',
      evs.count() === base);
    await reg3.execute('todo', { op: 'done', index: 2 });
    const arch = evs.all()[evs.count() - 1];
    check('F16 整单全完成 → 自动补一条 system 事件（标题带项数与任务名，tags 带 archive）',
      evs.count() === base + 1 && arch.kind === 'system'
      && arch.title.includes('2 项') && arch.title.includes('任务甲')
      && arch.tags.includes('task') && arch.tags.includes('archive'));

    // 缺省单例接线：不传第三参时作用于 eventStore（runtime / 命令读同一份）。
    // 单例是进程级共享物：先记下现场，测完原样恢复（测别人的东西不留自己的脚印）。
    const savedSingleton = eventStore.all();
    const reg2 = new ToolRegistry();
    registerBuiltinTools(reg2);   // 全部走缺省单例
    await reg2.execute('record_event', { kind: 'experience', title: '单例探针' });
    check('F17 不传 store 时作用于共享单例 eventStore', eventStore.all().some((e) => e.title === '单例探针'));
    const rf0 = P('restore-f.jsonl');
    fs.writeFileSync(rf0, savedSingleton.map((e) => JSON.stringify(e)).join('\n') + (savedSingleton.length ? '\n' : ''));
    eventStore.loadFromFile(rf0);
  } finally {
    process.chdir(cwd0);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   ⑥b pull_events 跨项目拉取（用户许可闸 + 注册表解析 + 流水不外带）
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n⑥b pull_events 跨项目拉取');

{
  // 造一个"别的项目"：叙事 + system + 一行旧 tool_call（验证流水不外带）
  const foreignDir = path.join(tmpDir, 'foreign-project');
  fs.mkdirSync(path.join(foreignDir, '.flint'), { recursive: true });
  fs.writeFileSync(path.join(foreignDir, '.flint', 'events.jsonl'), [
    JSON.stringify({ id: 'ev_f1', time: '2026-09-13T08:00:00.000Z', kind: 'incident', title: '外项目踩坑', context: '权限弹窗', tags: ['坑'] }),
    JSON.stringify({ id: 'ev_f2', time: '2026-09-13T09:00:00.000Z', kind: 'system', title: '任务清单全完成', tags: ['task', 'archive'] }),
    JSON.stringify({ id: 'ev_f3', time: '2026-09-13T10:00:00.000Z', kind: 'tool_call', title: '工具 write 调用', tags: ['tool', 'write'] }),
  ].join('\n'));

  const reg = new ToolRegistry();
  registerBuiltinTools(reg, new TaskStore(), new MemoryStore(), new EventStore());
  const pull = async (args: Record<string, unknown>): Promise<string> =>
    (await reg.execute('pull_events', args)).content;

  check('I1 pull_events 已注册且 requirePermission: true（跨项目读取必须过用户许可闸）',
    reg.getLLMTools().some((t) => t.function.name === 'pull_events') && reg.requiresPermission('pull_events'));
  check('I2 授权键 = 目标项目路径（"本次全部允许"的粒度是这个项目，不是所有项目）',
    reg.permissionKey('pull_events', { project: 'C:\\a\\b' }) === 'C:/a/b');

  const ok1 = await pull({ project: foreignDir });
  check('I3 按路径拉取：[OK]、命中叙事与 system、报出来源路径',
    ok1.startsWith('[OK]') && ok1.includes('外项目踩坑') && ok1.includes('任务清单全完成')
    && ok1.includes('foreign-project'), ok1.split('\n')[0]);
  check('I4 流水不跨项目：旧 events.jsonl 里的 tool_call 行被路由走，不出现在拉取结果',
    !ok1.includes('工具 write 调用'));

  check('I5 无命中 → [NO_MATCH]（有效否定）',
    (await pull({ project: foreignDir, keyword: '不存在的词' })).startsWith('[NO_MATCH]'));
  check('I6 kind=tool_call 拒绝（流水留在各项目本地）',
    (await pull({ project: foreignDir, kind: 'tool_call' })).startsWith('[INVALID]'));
  check('I7 未知短名 → [INVALID]（短名走注册表解析，解析不到如实报错）',
    (await pull({ project: '根本不存在的项目名' })).startsWith('[INVALID]'));
  check('I8 路径解析不要求已登记：存在但无事件库的目录 → [NO_MATCH]',
    (await pull({ project: path.join(tmpDir, 'empty-project') })).startsWith('[NO_MATCH]'));
}

/* ══════════════════════════════════════════════════════════════════════════
   ⑦ /events 命令（kind=/tag=/q=/limit= 参数解析）
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n⑦ /events 命令');

{
  // 空库：用临时单例状态（eventStore 是进程级单例，先记下现场再恢复）
  const saved = eventStore.all();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let reg: { name: string; desc: string; fn: (args: string) => string } | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  activateEventsCmd({ registerCommand: (name: string, desc: string, fn: (args: string) => string) => { reg = { name, desc, fn }; } } as any);

  check('G1 /events 已注册（loader 自动扫描 builtin/ 目录）', reg?.name === 'events');

  // 造数据：直接走 addNarrative 会写盘——用 recordToolCall? 也要写盘。
  // → /events 读的是 eventStore 单例；用 loadFromFile 把内存索引灌进去，不写仓库文件
  const f = P('events-cmd.jsonl');
  const mk = (n: number, kind: string, title: string, tags: string[]): string =>
    JSON.stringify({ id: `ev_${n}`, time: `2026-09-13T0${n}:00:00.000Z`, kind, title, tags });
  fs.writeFileSync(f, [
    mk(1, 'decision', '决策一', ['ui']),
    mk(2, 'incident', '事故二', ['rpc']),
    mk(3, 'experience', '经验三', ['ui', 'edit']),
    mk(4, 'tool_call', '工具 bash 调用', ['tool', 'bash']),
  ].join('\n'));
  eventStore.loadFromFile(f);

  const all = reg!.fn('');
  check('G2 无参数：只显叙事+system（tool_call 行已被路由进流水索引）、最新在前、带排版',
    all.includes('显示 3/3 条') && !all.includes('工具 bash 调用')
    && all.includes('[decision]') && all.includes('标签: ui'), all);
  check('G2b kind=tool_call 从流水索引出（历史流水照旧能查）',
    reg!.fn('kind=tool_call').includes('工具 bash 调用') && reg!.fn('kind=tool_call').includes('tool-calls.jsonl'));

  check('G3 kind= 过滤', reg!.fn('kind=incident').includes('事故二') && !reg!.fn('kind=incident').includes('决策一'));
  check('G4 tag= 过滤', reg!.fn('tag=rpc').includes('事故二') && !reg!.fn('tag=rpc').includes('经验三'));
  check('G5 q= 关键词过滤', reg!.fn('q=经验').includes('经验三') && !reg!.fn('q=经验').includes('事故二'));
  check('G6 未识别的词当关键词（q= 与裸词等价）',
    reg!.fn('经验').includes('经验三') && reg!.fn('经验').includes('q=经验'));
  check('G7 limit= 截断', reg!.fn('limit=2').includes('显示 2/3 条'));
  check('G8 limit 非数字回退默认（不炸）',
    reg!.fn('limit=abc').includes('显示 3/3 条'));
  check('G9 kind= 过滤只出该类型', reg!.fn('kind=decision').includes('决策一') && !reg!.fn('kind=decision').includes('事故二'));
  const combo = reg!.fn('tag=ui q=三');
  check('G10 tag+q 组合只出交集', combo.includes('经验三') && !combo.includes('决策一'), combo);
  check('G11 无命中：如实说没有并提示检查过滤词',
    reg!.fn('q=不存在词').includes('无匹配事件'));

  // 恢复单例现场（测试前有内容就灌回去，没有就清空）
  const restore = new EventStore();
  const rf = P('restore-ev.jsonl');
  fs.writeFileSync(rf, saved.map((e) => JSON.stringify(e)).join('\n') + (saved.length ? '\n' : ''));
  eventStore.loadFromFile(rf);
}

/* ══════════════════════════════════════════════════════════════════════════
   ⑧ 源码防回退
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n⑧ 源码防回退');

{
  const mainSrc = fs.readFileSync(path.join(ROOT, 'src/harness/main.ts'), 'utf-8');
  const builtinSrc = fs.readFileSync(path.join(ROOT, 'src/tools/builtin.ts'), 'utf-8');
  const storeSrc = fs.readFileSync(path.join(ROOT, 'src/eventlog/store.ts'), 'utf-8');
  const cmdSrc = fs.readFileSync(path.join(ROOT, 'src/commands/builtin/events.ts'), 'utf-8');
  const coreSectionSrc = fs.readFileSync(path.join(ROOT, 'src/context/sections/core-section.ts'), 'utf-8');

  check('H1 main 复用 SpanCollectorImpl（capacity 0 落盘型）做自动捕获',
    /new SpanCollectorImpl\(\{ capacity: 0 \}\)/.test(mainSrc));
  check('H2 自动捕获只认 tool_call 段 + 落 CALLS_FILE 流水档案（配对逻辑零重复）',
    mainSrc.includes("span.name === 'tool_call'") && mainSrc.includes('eventStore.recordToolCall(span, CALLS_FILE)'));
  check('H3 main 启动时给事件库做一次性种子（叙事 + 流水两份）',
    /eventStore\.loadFromFile\(EVENTS_FILE\)/.test(mainSrc) && mainSrc.includes('eventStore.loadCallsFile(CALLS_FILE)'));
  check('H4 builtin 注册了 record_event / search_events',
    builtinSrc.includes("name: 'record_event'") && builtinSrc.includes("name: 'search_events'"));
  check('H5 record_event 用 NARRATIVE_KINDS 校验 kind（tool_call 手写被拒）',
    builtinSrc.includes('NARRATIVE_KINDS'));
  check('H6 事件库是**追加型**：store 只用 appendFileSync，绝不 writeFileSync（历史条目冻死）',
    storeSrc.includes('appendFileSync') && !storeSrc.includes('writeFileSync'));
  check('H7 终端与工具共用 formatEvent（排版只有一处实现）',
    cmdSrc.includes('formatEvent') && builtinSrc.includes('formatEvent'));
  check('H8 /events 读内存索引（不回读文件——运行期单一真相源纪律）',
    cmdSrc.includes('eventStore.search') && !cmdSrc.includes('readFileSync'));
  check('H9 core-section 教模型 record_event 与 search_events（与工具面对暗号）',
    coreSectionSrc.includes('record_event') && coreSectionSrc.includes('search_events'));

  // ── 确定性钩子的两处接线（自动补记不经模型，接线点唯一性由源码守护） ──
  const runtimeSrc = fs.readFileSync(path.join(ROOT, 'src/runtime/runtime.ts'), 'utf-8');
  check('H10 压缩自动补记接线：runtime 在 compacted.summary 存在时调 recordCompaction',
    runtimeSrc.includes('if (compacted.summary) eventStore.recordCompaction(compacted.summary, EVENTS_FILE)'));
  check('H11 归档自动补记接线：builtin 在归档真正消费快照的那次才调 recordTaskArchive（写失败不记，防双记）',
    builtinSrc.includes('store.hasPendingArchive()') && builtinSrc.includes('evs.recordTaskArchive(done, EVENTS_FILE)'));

  // ── 拆分与跨项目拉取的接线（2026-09-13 深夜） ──
  const registrySrc = fs.readFileSync(path.join(ROOT, 'src/eventlog/registry.ts'), 'utf-8');
  check('H12 store 有独立流水落点 CALLS_FILE，recordToolCall 入 calls 索引',
    storeSrc.includes("CALLS_FILE = '.flint/tool-calls.jsonl'")
    && /recordToolCall[\s\S]*?this\.calls\.push/.test(storeSrc));
  check('H13 注册表也是追加型（appendFileSync，绝不 writeFileSync），路径归一在位',
    registrySrc.includes('appendFileSync') && !registrySrc.includes('writeFileSync')
    && registrySrc.includes('function normalize'));
  check('H14 main 启动时把 cwd 登记进项目注册表',
    mainSrc.includes('projectRegistry.ensure(process.cwd())'));
  check('H15 pull_events 的许可闸与授权键（跨项目读取必须过用户，键 = 项目路径）',
    /name: 'pull_events'[\s\S]*?requirePermission: true/.test(builtinSrc)
    && /name: 'pull_events'[\s\S]*?permissionKey: \(args\) => String\(args\.project/.test(builtinSrc));
  check('H16 pull_events 复用 EventStore.loadFromFile 读目标项目（不另造读取器）',
    /pull_events[\s\S]*?new EventStore\(\)[\s\S]*?loadFromFile\(`\$\{resolved\}\/\.flint\/events\.jsonl`\)/.test(builtinSrc));
}

/* ── 清理与汇总 ── */

fs.rmSync(tmpDir, { recursive: true, force: true });
check('Z1 临时目录已清理', !fs.existsSync(tmpDir));

// 结果行格式是 run-verify.mjs 的解析契约（/结果[：:]\s*(\d+)\s*通过.../），别改成自由文案
console.log(`\n结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
process.exit(failed > 0 ? 1 : 0);
