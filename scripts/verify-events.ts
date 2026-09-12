/**
 * 事件语义验证脚本 —— 骨架 span 配对守恒 / 总线盖戳 / 便签通道 / trace-log 落盘端到端。
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-events.ts
 *
 * 背景（改造前对外只有 11 个"画面事件"，没有任何行为边界）：
 *   - 一次带 3 个工具的 prompt 实际发生 4 次 LLM 往返，却一个边界事件都没有，
 *     单次 LLM 耗时、首字延迟（TTFT）、真实 token 用量永久算不出来
 *   - tool_execution_end 在 catch 分支漏发 → 任何按 start/end 配对计数的消费者
 *     会永远认为该工具还在执行
 *   - 内存里的事件不带时间戳，只有落盘时才把时间拼进字符串
 *   - 消费端只能拿结果文本做子串猜测（includes('失败')）判断红绿
 *
 * 覆盖：
 *   ① 总线盖戳：at/seq/turnId 由 emit() 统一补，beginTurn 换发并把 seq 归零
 *   ② trace() 自动配对：正常 / 抛错 / 重复关门 / set 并入 / 返回值原样透传
 *   ③ beginSpan 手动配对：跨 return/finally 的场景，fail 之后 end 不再重复发
 *   ④ 真实 AgentLoop：llm_request / tool_call 段配对守恒、无孤儿、TTFT 合法、usage 不伪报
 *   ⑤ L0 回归：工具抛异常时 tool_execution_end 照发且 ok=false
 *   ⑥ 便签通道（路 B）：任意段名 + 自由载荷，加观测点不必改核心类型
 *   ⑦ compaction 段：十几秒的摘要调用不再是黑箱
 *   ⑧ trace-log watcher 端到端：一行一段完整行为，配对靠 spanId 而不是靠名字猜
 *   ⑨ SpanCollector 公共件 + /traces 命令：配对抽出后的两个独立消费者（落盘 / 上屏）
 */
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PromptEventEmitter } from '../src/runtime/events.js';
import { EventStream } from '../src/runtime/event-stream.js';
import { AgentLoopServiceImpl } from '../src/loop/agent-loop.js';
import { CompactionServiceImpl } from '../src/context/compaction.js';
import { SpanCollectorImpl } from '../src/runtime/span-collector.js';
import { activate as activateTraces } from '../src/commands/builtin/traces.js';
import type { LLMProvider, LLMStreamEvent, LLMToolCall } from '../src/llm/types.js';

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

/** 收集事件用的订阅者（事件出总线时已盖好 at/seq/turnId） */
function collector(bus: PromptEventEmitter): Array<Record<string, any>> {
  const got: Array<Record<string, any>> = [];
  bus.subscribe((e) => got.push(e as unknown as Record<string, any>));
  return got;
}

const byType = (got: Array<Record<string, any>>, t: string) => got.filter((e) => e.type === t);

/* ── 脚本化假 LLM：按剧本逐轮返回（若干工具调用 或 若干 token） ── */
type Step = { toolCalls?: LLMToolCall[]; tokens?: string[] };

function makeLlm(script: Step[]): LLMProvider {
  let turn = 0;
  return {
    async chat() {
      return { content: '' };
    },
    stream() {
      const step = script[Math.min(turn, script.length - 1)];
      turn++;
      const es = new EventStream<LLMStreamEvent>(
        (e) => e.type === 'end',
        (e) => e as { type: 'end'; fullText: string },
      );
      queueMicrotask(() => {
        if (step.toolCalls) {
          es.push({ type: 'tool_call', toolCalls: step.toolCalls });
          es.push({ type: 'end', fullText: '' });
        } else {
          const tokens = step.tokens ?? ['done'];
          for (const t of tokens) es.push({ type: 'token', text: t });
          es.push({ type: 'end', fullText: tokens.join('') });
        }
      });
      return es;
    },
  };
}

/** 混合工具：read 正常返回、boom 抛异常（专治"catch 分支漏发 end"） */
const mixedTools = {
  getLLMTools: () => [],
  requiresPermission: () => false,
  execute: async (name: string) => {
    if (name === 'boom') throw new Error('模拟工具崩溃');
    return '[OK] 读取成功';
  },
  register: () => {},
};

const openPermission = { isAutoAllowed: () => true, grantAutoAllow: () => {} };

/** 两个工具调用（一成一崩）+ 一轮纯文本收尾 */
const script: Step[] = [
  {
    toolCalls: [
      { id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"a.ts"}' } },
      { id: 'c2', type: 'function', function: { name: 'boom', arguments: '{}' } },
    ],
  },
  { tokens: ['最终', '答案'] },
];

async function main(): Promise<void> {
  /* ── ① 总线盖戳 ── */
  console.log('① 总线盖戳（at/seq/turnId 由 emit 统一补，生产端零改动）');
  {
    const bus = new PromptEventEmitter();
    const got = collector(bus);
    bus.emit({ type: 'check_start' });
    check('未开回合时 turnId 为空串（启动自检事件不属于任何 prompt）', got[0].turnId === '');
    const t1 = bus.beginTurn();
    bus.emit({ type: 'thinking', phase: 'analyzing' });
    bus.emit({ type: 'thinking', phase: 'streaming' });
    check('beginTurn 后 seq 从 0 重新计（同回合内可据此发现丢事件）', got[1].seq === 0 && got[2].seq === 1);
    check('同一回合的事件共享 turnId（散落的事件能收成一组）', got[1].turnId === t1 && got[2].turnId === t1);
    const t2 = bus.beginTurn();
    bus.emit({ type: 'agent_end' });
    check('再次 beginTurn：换发 turnId 且 seq 归零', got[3].turnId === t2 && t2 !== t1 && got[3].seq === 0);
    check('每条事件都带毫秒时间戳（过去内存里的事件全都没有时间信息）',
      got.every((e) => typeof e.at === 'number' && Math.abs(e.at - Date.now()) < 60_000));
  }

  /* ── ② trace() 自动配对 ── */
  console.log('② trace() 自动配对（进门/出门由结构保证，不靠自觉）');
  {
    const bus = new PromptEventEmitter();
    const got = collector(bus);
    bus.beginTurn();
    const r = await bus.trace('tool_call', { name: 'read', args: {} }, async (span) => {
      span.set({ resultLength: 12 });
      return '业务结果';
    });
    check('trace 原样返回业务结果（不吞不改）', r === '业务结果');
    check('一次 trace = 一条 start + 一条 end',
      byType(got, 'tool_call_start').length === 1 && byType(got, 'tool_call_end').length === 1);
    const end = byType(got, 'tool_call_end')[0];
    check('出门事件自带 status=ok 与 durationMs（耗时由生产端算好）',
      end.status === 'ok' && typeof end.durationMs === 'number' && end.durationMs >= 0);
    check('中途 span.set 的字段并入出门事件', end.resultLength === 12);
    check('start 与 end 的 spanId 相同（消费端靠它配对，不靠段名猜）',
      typeof got[0].spanId === 'string' && got[0].spanId === end.spanId);
  }
  {
    const bus = new PromptEventEmitter();
    const got = collector(bus);
    let thrown: unknown = null;
    try {
      await bus.trace('llm_request', { turn: 0, model: 'm', messageCount: 1, toolCount: 0 }, async () => {
        throw new Error('模拟网络中断');
      });
    } catch (err) { thrown = err; }
    check('trace 不吞异常：原样重抛，兜底策略仍归调用方',
      thrown instanceof Error && thrown.message === '模拟网络中断');
    const end = byType(got, 'llm_request_end')[0];
    check('抛错也关门：status=error + error 文本（配对结构上不可能漏）',
      end?.status === 'error' && String(end?.error).includes('模拟网络中断'));
    check('抛错路径只发一条 end（trace 与业务都关过门也不重复打卡）',
      byType(got, 'llm_request_end').length === 1);
  }

  /* ── ③ beginSpan 手动配对 ── */
  console.log('③ beginSpan 手动配对（跨 return/continue/finally 的场景）');
  {
    const bus = new PromptEventEmitter();
    const got = collector(bus);
    const span = bus.beginSpan('prompt', { input: 'hi' });
    check('beginSpan 进门即发 start', got.length === 1 && got[0].type === 'prompt_start');
    check('未收束时 closed=false', span.closed === false);
    span.end({ reply: 'yo', turns: 1 });
    check('end() 发 prompt_end 且 closed 翻真', got[1].type === 'prompt_end' && span.closed === true);
    span.end({ reply: 'again' });
    span.fail(new Error('迟到异常'));
    check('重复 end / 事后再 fail 都被忽略（一段只关一次门）', byType(got, 'prompt_end').length === 1);
  }
  {
    const bus = new PromptEventEmitter();
    const got = collector(bus);
    bus.beginSpan('compaction', { msgCount: 3 }).fail(new Error('摘要调用超时'));
    const end = byType(got, 'compaction_end')[0];
    check('fail() → status=error + error 文本', end?.status === 'error' && String(end?.error).includes('摘要调用超时'));
  }

  /* ── ④⑤ 真实 AgentLoop：三重循环里的骨架段 + L0 回归 ── */
  console.log('④ 真实 AgentLoop（中层 llm_request / 内层 tool_call 段配对）');
  const bus = new PromptEventEmitter();
  const got = collector(bus);
  bus.beginTurn();
  const loop = new AgentLoopServiceImpl({
    llm: makeLlm(script),
    tools: mixedTools as never,
    permission: openPermission as never,
    events: bus,
  });
  await loop.run([{ role: 'user', content: '任务' }], undefined, { model: 'test-model' });

  const llmStarts = byType(got, 'llm_request_start');
  const llmEnds = byType(got, 'llm_request_end');
  const callStarts = byType(got, 'tool_call_start');
  const callEnds = byType(got, 'tool_call_end');
  check('两次 LLM 往返 → 两段 llm_request（过去 4 次网络往返被压成一个黑盒）',
    llmStarts.length === 2 && llmEnds.length === 2, `start=${llmStarts.length} end=${llmEnds.length}`);
  check('两个工具 → 两段 tool_call，start/end 数量守恒',
    callStarts.length === 2 && callEnds.length === 2, `start=${callStarts.length} end=${callEnds.length}`);

  const startIds = [...llmStarts, ...callStarts].map((e) => e.spanId as string);
  const endIds = [...llmEnds, ...callEnds].map((e) => e.spanId as string);
  check('无孤儿：每个 end 都能找到配对的 start', endIds.every((id) => startIds.includes(id)));
  check('spanId 全局不重复（两个同名 tool_call 段也不会配错对）', new Set(startIds).size === startIds.length);
  check('seq 在同一 turn 内连续无跳号',
    got.every((e, i) => e.seq === i), `共 ${got.length} 条`);
  check('全部事件同属一个 turnId', new Set(got.map((e) => e.turnId)).size === 1);
  check('model 由 Runtime 按次下发（构造快照会在热切换后陈旧）', llmStarts.every((e) => e.model === 'test-model'));
  check('进门载荷带 messageCount / toolCount / turn', llmStarts.every((e) =>
    typeof e.messageCount === 'number' && typeof e.toolCount === 'number' && typeof e.turn === 'number'));

  check('TTFT 由生产端实测：文本轮首字延迟非 null 且不大于整段耗时',
    typeof llmEnds[1].firstTokenMs === 'number' && llmEnds[1].firstTokenMs <= llmEnds[1].durationMs);
  check('工具轮的 TTFT 为 null（一个字都没收到；区别于 0）', llmEnds[0].firstTokenMs === null);
  check('usage 为 null 而非 0（Provider 尚未填槽时不得伪报用量）', llmEnds.every((e) => e.usage === null));
  check('有工具调用的轮不算 empty（工具调用本身就是产出）', llmEnds[0].status === 'ok');
  check('文本轮的出门载荷带 textLength / toolCallCount',
    llmEnds[1].textLength === 4 && llmEnds[1].toolCallCount === 0);

  console.log('⑤ L0 回归：工具抛异常时的 start/end 配对');
  {
    const toolEnds = byType(got, 'tool_execution_end');
    check('抛异常的工具也发了 tool_execution_end（旧实现 catch 分支漏发 → 配对永久断裂）',
      toolEnds.length === 2, `实际 ${toolEnds.length} 条`);
    check('成败由生产端用 ok 字段说（消费端不再子串猜测）',
      toolEnds.some((e) => e.ok === true) && toolEnds.some((e) => e.ok === false));
    check('tool_execution_start 与 end 一一对应', byType(got, 'tool_execution_start').length === toolEnds.length);
    check('抛异常的那段 tool_call_end：status=error + error 文本',
      callEnds.some((e) => e.status === 'error' && String(e.error).includes('模拟工具崩溃')));
    check('软失败与硬失败都算失败：成功那段 status=ok', callEnds.some((e) => e.status === 'ok'));
    const okCall = callEnds.find((e) => e.status === 'ok');
    const errCall = callEnds.find((e) => e.status === 'error');
    check('成功段带结果体量（完整结果文本仍由 tool_execution_end 给 UI）',
      typeof okCall?.resultLength === 'number');
    check('异常段不带 resultLength（工具根本没产出结果，不伪报 0）',
      errCall !== undefined && !('resultLength' in errCall));
  }

  /* ── ⑥ 便签通道（路 B） ── */
  console.log('⑥ 便签通道（任意段名 + 自由载荷，核心零改动）');
  {
    const noteBus = new PromptEventEmitter();
    const noteGot = collector(noteBus);
    await noteBus.traceNote('我自己想看的一段', { anything: 1, nested: { a: true } }, async (span) => {
      span.set({ extra: 'x' });
    });
    check('事件类型固定为 note_start / note_end（加观测点不必改核心联合类型）',
      noteGot[0].type === 'note_start' && noteGot[1].type === 'note_end');
    check('段名降级到 name 字段，可以是任意字符串（无需预先定义）',
      noteGot[0].name === '我自己想看的一段' && noteGot[1].name === '我自己想看的一段');
    check('进门载荷是自由字典', noteGot[0].attrs.anything === 1 && noteGot[0].attrs.nested.a === true);
    check('中途 set 的字段并进出门 attrs', noteGot[1].attrs.extra === 'x' && noteGot[1].attrs.anything === 1);
    check('便签段同样有 spanId / durationMs / status',
      noteGot[0].spanId === noteGot[1].spanId && typeof noteGot[1].durationMs === 'number' && noteGot[1].status === 'ok');
  }

  /* ── ⑦ compaction 段 ── */
  console.log('⑦ compaction 段（十几秒的摘要调用不再是黑箱）');
  {
    const cBus = new PromptEventEmitter();
    const cGot = collector(cBus);
    cBus.beginTurn();
    const ids = Array.from({ length: 25 }, (_, i) => `m${i}`);
    const store = {
      getCompactions: () => [],
      appendCompaction: async () => {},
      getAllMsgIds: () => ids,
      getMsgById: (id: string) => ({ role: 'user', content: `内容 ${id}` }),
    };
    const svc = new CompactionServiceImpl({
      llm: {
        chat: async () => ({ content: '这是摘要' }),
        stream: () => { throw new Error('压缩不该走流式'); },
      } as never,
      events: cBus,
    });
    const history = Array.from({ length: 25 }, (_, i) => ({ role: 'user', content: `c${i}` }));
    const result = await svc.maybeCompact(history, store as never);
    check('compaction 段成对发出', byType(cGot, 'compaction_start').length === 1 && byType(cGot, 'compaction_end').length === 1);
    check('进门带待压缩条数（25 条留最近 10 条 → 压 15 条）', byType(cGot, 'compaction_start')[0].msgCount === 15);
    check('出门带摘要长度与耗时', byType(cGot, 'compaction_end')[0].summaryLength === 4
      && typeof byType(cGot, 'compaction_end')[0].durationMs === 'number');
    check('thinking:compressing 仍照发（UI 行为不变）', cGot.some((e) => e.type === 'thinking' && e.phase === 'compressing'));
    check('压缩功能本身未受影响（历史裁到 10 条 + 摘要独立返回）',
      result.history.length === 10 && result.summary === '这是摘要');
  }

  /* ── ⑧ trace-log watcher 端到端（住在 extensions/watchers/：只订阅不改流程） ── */
  console.log('⑧ trace-log watcher 端到端（一行一段完整行为，落盘）');
  {
    const tmp = join(tmpdir(), `flint-trace-${Date.now()}.jsonl`);
    process.env.FLINT_TRACE = '1';
    process.env.FLINT_TRACE_FILE = tmp;
    const mod = await import('../src/extensions/watchers/trace-log.js');
    const tBus = new PromptEventEmitter();
    mod.registerWatchers({ events: tBus });
    tBus.beginTurn();
    const tLoop = new AgentLoopServiceImpl({
      llm: makeLlm(script),
      tools: mixedTools as never,
      permission: openPermission as never,
      events: tBus,
    });
    await tLoop.run([{ role: 'user', content: '任务' }], undefined, { model: 'test-model' });

    const lines = existsSync(tmp) ? readFileSync(tmp, 'utf-8').trim().split('\n').filter(Boolean) : [];
    const rows = lines.map((l) => JSON.parse(l) as Record<string, any>);
    check('每段一行：2 次 llm_request + 2 次 tool_call = 4 行', rows.length === 4, `实际 ${rows.length} 行`);
    check('每行都是完整记录（name/spanId/startedAt/durationMs/status/input/output 齐全）',
      rows.every((r) => typeof r.name === 'string' && typeof r.spanId === 'string'
        && typeof r.startedAt === 'string' && typeof r.durationMs === 'number'
        && typeof r.status === 'string' && r.input && r.output));
    check('一行里同时有进门载荷与出门载荷（这才叫"一条完整的行为记录"）',
      rows.some((r) => r.name === 'tool_call' && r.input.name === 'read' && typeof r.output.resultLength === 'number'));
    check('抛异常的那段落了 status=error + error 文本',
      rows.some((r) => r.status === 'error' && typeof r.error === 'string'));
    check('durationMs 由 start/end 时间戳差算出，非负', rows.every((r) => r.durationMs >= 0));
    check('全部段落都关上了门（无 unclosed 残留）', rows.every((r) => r.status !== 'unclosed'));
    check('startedAt 是 ISO 时间串（可直接排序、可人读）',
      rows.every((r) => !Number.isNaN(Date.parse(r.startedAt))));
    if (existsSync(tmp)) unlinkSync(tmp);
    delete process.env.FLINT_TRACE;
    delete process.env.FLINT_TRACE_FILE;
  }

  /* ── ⑨ SpanCollector 公共件 + /traces 命令（配对抽出后的两个消费者） ── */
  console.log('');
  console.log('⑨ SpanCollector 公共件 + /traces 命令（同一份配对代码，两个独立实例）');
  {
    const col = new SpanCollectorImpl();
    check('feed 进门事件返回 null（还没成段，只是登记）',
      col.feed({ type: 'llm_request_start', spanId: 's1', at: 1000, seq: 1, turnId: 't', turn: 0, model: 'm', messageCount: 1, toolCount: 0 }) === null);
    const got = col.feed({ type: 'llm_request_end', spanId: 's1', at: 2500, seq: 2, turnId: 't', status: 'ok', durationMs: 1500, firstTokenMs: 900 });
    check('feed 出门事件收束出一段，durationMs 由两条事件的 at 相减得来（1500ms）',
      got !== null && got.name === 'llm_request' && got.durationMs === 1500 && got.status === 'ok');
    check('进门载荷与出门载荷分列 input/output，信封字段已剥掉（不重复出现）',
      got?.input.model === 'm' && got?.output.firstTokenMs === 900
      && !('spanId' in (got?.input ?? {})) && !('durationMs' in (got?.output ?? {})));
    check('无 spanId 的事件被忽略（tool_execution_* 这类 UI 事件不参与配对）',
      col.feed({ type: 'tool_execution_start', at: 3000, seq: 3, turnId: 't' }) === null && col.running().length === 0);
    check('孤儿出门事件返回 null（没有配对的进门，不猜一个出来）',
      col.feed({ type: 'tool_call_end', spanId: 'never-opened', at: 3100, seq: 4, turnId: 't', status: 'ok', durationMs: 5, name: 'x' }) === null);

    const ring = new SpanCollectorImpl({ capacity: 2 });
    for (let i = 0; i < 3; i++) {
      ring.feed({ type: 'note_start', spanId: `n${i}`, name: `n${i}`, at: i, seq: i, turnId: 't', attrs: {} });
      ring.feed({ type: 'note_end', spanId: `n${i}`, name: `n${i}`, at: i + 1, seq: i, turnId: 't', status: 'ok', durationMs: 1, attrs: {} });
    }
    check('环形队列按容量丢最旧的（capacity=2 收 3 段，只留 n1/n2）',
      ring.recent().length === 2 && ring.recent()[0].name === 'n1' && ring.recent()[1].name === 'n2');
    const zero = new SpanCollectorImpl({ capacity: 0 });
    zero.feed({ type: 'note_start', spanId: 'z', name: 'z', at: 0, seq: 0, turnId: 't', attrs: {} });
    const zGot = zero.feed({ type: 'note_end', spanId: 'z', name: 'z', at: 1, seq: 1, turnId: 't', status: 'ok', durationMs: 1, attrs: {} });
    check('capacity=0 时 feed 照常交回成段、但 recent() 不留历史（落盘型消费者只要返回值）',
      zGot !== null && zGot.name === 'z' && zero.recent().length === 0);

    const pend = new SpanCollectorImpl();
    pend.feed({ type: 'compaction_start', spanId: 'c1', at: Date.now() - 5000, seq: 1, turnId: 't', msgCount: 30 });
    const run = pend.running();
    check('running() 报出未关门的段：status=running、durationMs 算到此刻（≥5000ms）',
      run.length === 1 && run[0].status === 'running' && run[0].durationMs >= 5000 && run[0].input.msgCount === 30);
    check('running() 只窥视不清空（再查一次仍在）', pend.running().length === 1);
    const drained = pend.drainUnclosed();
    check('drainUnclosed() 标成 unclosed 并清空（漏关门不再静默）',
      drained.length === 1 && drained[0].status === 'unclosed' && pend.running().length === 0);

    /* attach：挂到真实总线上自动收段（事件形状由生产端决定，这里不手捏） */
    const aBus = new PromptEventEmitter();
    const aCol = new SpanCollectorImpl();
    const off = aCol.attach(aBus);
    aBus.beginTurn();
    await aBus.trace('tool_call', { name: 'read_file', args: {} }, async (sp) => { sp.set({ resultLength: 42 }); });
    check('attach() 后自动收段：真实总线跑一轮 trace 即得一段（含中途 set 的字段）',
      aCol.recent().length === 1 && aCol.recent()[0].name === 'tool_call'
      && aCol.recent()[0].input.name === 'read_file' && aCol.recent()[0].output.resultLength === 42);
    off();
    await aBus.trace('tool_call', { name: 'ls', args: {} }, async () => {});
    check('attach() 返回的退订函数有效（退订后不再收段）', aCol.recent().length === 1);

    /* /traces：假 runtime 只实现命令真正用到的三个方法 */
    const uiBus = new PromptEventEmitter();
    const uiCol = new SpanCollectorImpl();
    uiCol.attach(uiBus);
    uiBus.beginTurn();
    const root = uiBus.beginSpan('prompt', { input: '你好' });
    await uiBus.trace('llm_request', { turn: 0, model: 'deepseek-chat', messageCount: 3, toolCount: 5 },
      async (sp) => { sp.set({ firstTokenMs: 1200, textLength: 88, usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } }); });
    const keep = uiBus.beginSpan('tool_call', { name: 'read_file', args: {} });   // 故意不关门，用来测"正在跑"
    root.end({ reply: '好', turns: 1 });

    const captured = new Map<string, (a: string) => Promise<string>>();
    const fakeRuntime = (c: SpanCollectorImpl) => ({
      registerCommand: (name: string, _desc: string, handler: (a: string) => Promise<string>) => { captured.set(name, handler); },
      getTraces: () => c.recent(),
      getRunningSpans: () => c.running(),
    }) as never;

    await activateTraces(fakeRuntime(uiCol));
    const traces = captured.get('traces');
    check('/traces 已被 activate 注册成可调用的命令', typeof traces === 'function');

    const out = traces ? await traces('') : '';
    check('两段都上了屏，且新收束的排在前面（prompt 最后关门，所以它在前）',
      out.includes('llm_request') && out.includes('prompt') && out.indexOf('prompt') < out.indexOf('llm_request'));
    check('细节列取到模型名、首字延迟与用量（deepseek-chat / 首字 1.2s / 120 tok）',
      out.includes('deepseek-chat') && out.includes('首字 1.2s') && out.includes('120 tok'));
    check('未关门的段单独列进"正在跑"块，不混在已收束的段里',
      out.includes('正在跑') && out.includes('read_file'));

    /* 墙钟合计：段是嵌套的，全加会把同一段时间重复计 —— 手工喂两段已知耗时来精确验 */
    const wCol = new SpanCollectorImpl();
    wCol.feed({ type: 'prompt_start', spanId: 'p', at: 0, seq: 0, turnId: 't', input: 'x' });
    wCol.feed({ type: 'llm_request_start', spanId: 'l', at: 10, seq: 1, turnId: 't', turn: 0, model: 'm', messageCount: 1, toolCount: 0 });
    wCol.feed({ type: 'llm_request_end', spanId: 'l', at: 810, seq: 2, turnId: 't', status: 'ok', durationMs: 800 });
    wCol.feed({ type: 'prompt_end', spanId: 'p', at: 1000, seq: 3, turnId: 't', status: 'ok', durationMs: 1000, turns: 1 });
    await activateTraces(fakeRuntime(wCol));
    const wallOut = await (captured.get('traces') as (a: string) => Promise<string>)('');
    check('墙钟合计只算 prompt 段（1000ms → 1.0s，而不是把嵌套的 800ms 也加进去成 1.8s）',
      wallOut.includes('对话墙钟合计 1.0s') && !wallOut.includes('1.8s'));

    const filtered = await (captured.get('traces') as (a: string) => Promise<string>)('llm');
    check('关键字参数按段名过滤（只剩 llm_request，prompt 不上屏）',
      filtered.includes('段名含 "llm"') && filtered.includes('llm_request') && !filtered.includes('prompt  '));

    /* 过滤必须同时作用于"正在跑"块：uiCol 里 keep 那段 tool_call 还没关门，
       上面 filtered 用的是 wCol（无正在跑的段），所以这条路径当时测不到 */
    await activateTraces(fakeRuntime(uiCol));
    const uiCmd = captured.get('traces') as (a: string) => Promise<string>;
    const onlyLlm = await uiCmd('llm');
    check('说"只看 llm"就不带出未关门的 tool_call（过滤对正在跑同样生效）',
      onlyLlm.includes('llm_request') && !onlyLlm.includes('正在跑') && !onlyLlm.includes('read_file'));
    const onlyTool = await uiCmd('tool');
    check('过滤后已收束为空但有段在跑时，仍列出正在跑并说清是过滤词没命中',
      onlyTool.includes('正在跑') && onlyTool.includes('read_file')
      && onlyTool.includes('已收束的段里没有匹配这个过滤词的'));

    await activateTraces(fakeRuntime(new SpanCollectorImpl()));
    const emptyOut = await (captured.get('traces') as (a: string) => Promise<string>)('');
    check('一段都没收到时给明确提示，而不是打印一个空表头', emptyOut.includes('还没收到任何行为段'));

    keep.fail(new Error('测试用异常：把门关上，不留未收束的段'));
  }

  console.log('');
  console.log(`结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
