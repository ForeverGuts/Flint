/**
 * verify-history-structured.ts —— 跨轮历史结构化接通（2026-09-12 方案 B）
 *
 * 验什么（手段与行为分开钉）：
 *   ① 行为段 A：真 AgentLoopServiceImpl 上交 turnLog —— 中间消息（assistant+tool_calls / tool
 *      结果）按序包含、最终回复不在其中、steer 原地追加如实包含、异常/无工具轮 turnLog 为空
 *   ② 行为段 B：真 Runtime + 真 JsonlSessionStorage —— turnLog 带 extra 真落盘（文件行含
 *      tool_calls / tool_call_id / name 键）、顺序忠实、跨"重开"仍还原（持久化非内存）
 *   ③ 行为段 C：请求侧按 thinking 分叉 —— off/auto(无任务) 全量结构化回传、on 纯文本丢弃
 *      （承重分支），本轮循环内不受分叉影响（始终全结构化）
 *   ④ 源码守护 —— 略（verify-session.ts ⑨ 段 C/D 组已钉，本套件不重复）
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-history-structured.ts
 * 退出码：failed > 0 → 1
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentLoopServiceImpl } from '../src/loop/agent-loop.js';
import { Runtime } from '../src/runtime/runtime.js';
import { PromptEventEmitter } from '../src/runtime/events.js';
import { SpanCollectorImpl } from '../src/runtime/span-collector.js';
import { EventStream } from '../src/runtime/event-stream.js';
import { JsonlSessionStorage } from '../src/session/jsonl-storage.js';
import { CompactionServiceImpl } from '../src/context/compaction.js';
import type { LLMMessage } from '../src/llm/types.js';

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

/* ── 假件工厂：真 AgentLoopServiceImpl + 剧本 LLM（复用 verify-hooks 的模式） ── */

interface TurnFakes {
  llmCalls: LLMMessage[][];
  run: (opts?: { steer?: string | null }) => Promise<{ finalText: string; turnLog: LLMMessage[] }>;
}

function makeTurnFakes(): TurnFakes {
  const llmCalls: LLMMessage[][] = [];
  const toolCallEvent = {
    type: 'tool_call',
    toolCalls: [{ id: 't1', function: { name: 'bash', arguments: JSON.stringify({ cmd: 'ls /tmp' }) } }],
  };
  const endEvent = { type: 'end', fullText: 'done', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  // 剧本：第 1 轮吐工具调用（无文本），第 2 轮吐最终文本
  const script: Array<unknown[]> = [[toolCallEvent], [{ type: 'token', text: 'done' }, endEvent]];
  const llm = {
    stream: (messages: LLMMessage[]) => {
      llmCalls.push(messages);
      const events = script.shift() ?? [endEvent];
      return (async function* () {
        for (const e of events) yield e;
      })();
    },
  };
  const bus: Record<string, unknown> = {
    subscribe: () => () => {},
    on: () => () => {},
    emit: () => {},
  };
  const tools = {
    register: () => {},
    getLLMTools: () => [],
    requiresPermission: () => false,
    execute: () => Promise.resolve({ status: 'ok', content: 'ok-result' }),
  };
  const permission = { isAutoAllowed: () => true, grantAutoAllow: () => {}, clear: () => {} };
  const deps = {
    llm,
    tools,
    permission,
    events: bus,
    onPermission: async () => 'allow' as const,
  };
  return {
    llmCalls,
    run: (opts) =>
      new AgentLoopServiceImpl(deps as never).run([{ role: 'user', content: 'hi' }] as never, undefined, {
        takeSteer: opts?.steer !== undefined ? () => opts.steer ?? null : undefined,
      } as never) as never,
  };
}

/* ════════════════════════════════════════════════════════════════════════
   ① 行为段 A：agent-loop 上交 turnLog
   ════════════════════════════════════════════════════════════════════════ */

console.log('── ① 行为段 A：agent-loop 上交 turnLog ──');

{
  const f = makeTurnFakes();
  const r = await f.run();
  check('A1 turnLog 恰好 2 条（assistant+tool_calls 与 tool 结果）', r.turnLog.length === 2,
    JSON.stringify(r.turnLog.map((m) => m.role)));
  check('A2 第 1 条 assistant 带 tool_calls（id t1 / name bash）',
    r.turnLog[0].role === 'assistant' && r.turnLog[0].tool_calls?.[0]?.id === 't1'
    && r.turnLog[0].tool_calls?.[0]?.function.name === 'bash');
  check('A3 第 2 条 tool 结果带 tool_call_id + name + 真实结果',
    r.turnLog[1].role === 'tool' && r.turnLog[1].tool_call_id === 't1'
    && r.turnLog[1].name === 'bash' && r.turnLog[1].content === 'ok-result');
  check('A4 最终回复不在 turnLog（它由 Runtime 单独落盘）',
    r.turnLog.every((m) => m.content !== 'done') && r.finalText === 'done');
}

{
  const f = makeTurnFakes();
  const r = await f.run({ steer: '先看配置文件' });
  check('A5 steer 原地追加进 tool 结果，turnLog 如实包含（落盘即模型实际所见）',
    r.turnLog[1].content.includes('[用户引导]') && r.turnLog[1].content.includes('先看配置文件'));
}

{
  // 流异常：当轮没产出任何消息 → turnLog 空
  const llm = { stream: () => { throw new Error('boom'); } };
  const bus: Record<string, unknown> = { subscribe: () => () => {}, on: () => () => {}, emit: () => {} };
  const deps = {
    llm,
    tools: { register: () => {}, getLLMTools: () => [], requiresPermission: () => false, execute: () => Promise.resolve({ status: 'ok', content: '' }) },
    permission: { isAutoAllowed: () => true, grantAutoAllow: () => {}, clear: () => {} },
    events: bus,
    onPermission: async () => 'allow' as const,
  };
  const r = await new AgentLoopServiceImpl(deps as never).run([{ role: 'user', content: 'hi' }] as never) as never as { finalText: string; turnLog: LLMMessage[] };
  check('A6 流异常轮 turnLog 为空（没产出就不上交）且 finalText 是兜底文案',
    r.turnLog.length === 0 && r.finalText.includes('❌'));
}

{
  // 无工具调用：直接最终文本 → turnLog 空
  const llm = {
    stream: () => (async function* () {
      yield { type: 'token', text: '直接回答' };
      yield { type: 'end', fullText: '直接回答', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    })(),
  };
  const bus: Record<string, unknown> = { subscribe: () => () => {}, on: () => () => {}, emit: () => {} };
  const deps = {
    llm,
    tools: { register: () => {}, getLLMTools: () => [], requiresPermission: () => false, execute: () => Promise.resolve({ status: 'ok', content: '' }) },
    permission: { isAutoAllowed: () => true, grantAutoAllow: () => {}, clear: () => {} },
    events: bus,
    onPermission: async () => 'allow' as const,
  };
  const r = await new AgentLoopServiceImpl(deps as never).run([{ role: 'user', content: 'hi' }] as never) as never as { finalText: string; turnLog: LLMMessage[] };
  check('A7 无工具轮 turnLog 为空（纯文本回合无需落中间消息）',
    r.turnLog.length === 0 && r.finalText === '直接回答');
}

/* ── 真 Runtime + 真 JsonlSessionStorage 的装配工厂 ── */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-verify-hist-'));

interface RtFakes {
  llmCalls: LLMMessage[][];
  rt: Runtime;
  session: JsonlSessionStorage;
}

async function makeRuntimeFakes(opts: { thinking?: 'on' | 'off' | 'auto'; file?: string }): Promise<RtFakes> {
  const llmCalls: LLMMessage[][] = [];
  const toolCallEvent = {
    type: 'tool_call',
    toolCalls: [{ id: 't1', function: { name: 'bash', arguments: JSON.stringify({ cmd: 'ls /tmp' }) } }],
  };
  const endEvent = { type: 'end', fullText: 'done', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  // 剧本队列：第 1 次 prompt 消耗前两个剧本（工具轮 + 收尾轮），之后的每次 stream 消费一个纯文本剧本
  const script: Array<unknown[]> = [[toolCallEvent], [{ type: 'token', text: 'done' }, endEvent]];
  const llm = {
    chat: async () => ({ content: '' }),
    stream: (messages: LLMMessage[]) => {
      llmCalls.push(messages);
      const events = script.shift() ?? [{ type: 'token', text: '好的' }, { type: 'end', fullText: '好的', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }];
      return (async function* () {
        for (const e of events) yield e;
      })();
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const session = await (JsonlSessionStorage.create(tmpDir, opts.file ?? 'hist.jsonl') as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rt = new Runtime({
    llm,
    session,
    tools: { getLLMTools: () => [], requiresPermission: () => false, execute: async () => ({ status: 'ok', content: 'ok-result' }), register: () => {} },
    permission: { isAutoAllowed: () => true, grantAutoAllow: () => {}, clear: () => {} },
    skills: { load: () => {}, getAll: () => [], get: () => undefined },
    events: new PromptEventEmitter(),
    spanCollector: new SpanCollectorImpl(),
    commandSystem: { register: () => {}, list: () => [], execute: async () => null },
    diagnosticsService: { record: () => {}, getAll: () => [] },
    compaction: new CompactionServiceImpl({ llm }),
    systemPromptService: { build: async () => ({ messages: [{ role: 'system', content: 'sys' }] }) },
    ...(opts.thinking ? { thinking: opts.thinking } : {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  return { llmCalls, rt, session };
}

/* ════════════════════════════════════════════════════════════════════════
   ② 行为段 B：真 Runtime 把 turnLog 带 extra 真落盘
   ════════════════════════════════════════════════════════════════════════ */

console.log('\n── ② 行为段 B：turnLog 真落盘（真 Runtime + 真 JsonlSessionStorage） ──');

{
  const f = await makeRuntimeFakes({ file: 'persist.jsonl' });
  await f.rt.prompt('帮我跑个命令');
  const raw = fs.readFileSync(path.join(tmpDir, 'persist.jsonl'), 'utf8');
  check('B1 落盘的行里真含 tool_calls 键（写侧接通，不是只在内存）', raw.includes('"tool_calls"'));
  check('B2 落盘的行里真含 tool_call_id 与 name 键', raw.includes('"tool_call_id"') && raw.includes('"name"'));
  const msgs = await f.session.getMessages();
  check('B3 顺序忠实：user → assistant(tool_calls) → tool → assistant(final)',
    msgs.length === 4
    && msgs[0].role === 'user' && msgs[0].content === '帮我跑个命令'
    && msgs[1].role === 'assistant' && (msgs[1].tool_calls?.length ?? 0) === 1
    && msgs[2].role === 'tool' && msgs[2].tool_call_id === 't1' && msgs[2].name === 'bash'
    && msgs[3].role === 'assistant' && msgs[3].content === 'done',
    JSON.stringify(msgs.map((m) => m.role)));
  check('B4 getMessages 还原结构化字段（跨轮模型可见性的数据基础）',
    msgs[1].tool_calls?.[0]?.function.name === 'bash' && msgs[2].tool_call_id === 't1');
  // "重启"：重新 open 同一文件，leaf 恢复 + 结构化字段仍在
  const reopened = await JsonlSessionStorage.open(path.join(tmpDir, 'persist.jsonl'));
  const msgs2 = reopened ? await reopened.getMessages() : [];
  check('B5 重开文件后结构化字段仍在（持久化非内存，且 leaf 落盘修复保证不失踪）',
    msgs2.length === 4 && (msgs2[1].tool_calls?.length ?? 0) === 1 && msgs2[2].tool_call_id === 't1',
    `重开后 ${msgs2.length} 条`);
  const stored = f.session.getAllStored?.() ?? [];
  check('B6 getAllStored（/history 视角）看得见 tool 条目',
    stored.some((m) => m.role === 'tool' && m.content === 'ok-result'));
}

/* ════════════════════════════════════════════════════════════════════════
   ③ 行为段 C：请求侧按 thinking 分叉
   ════════════════════════════════════════════════════════════════════════ */

console.log('\n── ③ 行为段 C：请求侧按 thinking 分叉 ──');

{
  // thinking 'off'：第二次 prompt 的请求里，历史段全量结构化回传
  const f = await makeRuntimeFakes({ thinking: 'off', file: 'off.jsonl' });
  await f.rt.prompt('帮我跑个命令'); // 消耗剧本 [工具轮, 收尾轮]，落盘 4 条
  await f.rt.prompt('继续');        // 第 3 次 stream：探针记录带历史的请求
  const req = f.llmCalls[2];
  check('C1 thinking-off：历史里的 assistant 轮带 tool_calls 回传',
    req.some((m) => m.role === 'assistant' && (m.tool_calls?.length ?? 0) > 0
      && m.tool_calls?.[0]?.function.name === 'bash'));
  check('C2 thinking-off：历史里的 tool 结果带 tool_call_id + name 回传',
    req.some((m) => m.role === 'tool' && m.tool_call_id === 't1' && m.name === 'bash'
      && m.content === 'ok-result'));
  check('C3 thinking-off：最新 user 消息仍在末尾（回传不挤掉新输入）',
    req[req.length - 1].role === 'user' && req[req.length - 1].content === '继续');
}

{
  // thinking 'on'：第二次 prompt 的请求里，历史段纯文本（承重丢弃），本轮循环内仍全结构化
  const f = await makeRuntimeFakes({ thinking: 'on', file: 'on.jsonl' });
  await f.rt.prompt('帮我跑个命令');
  await f.rt.prompt('继续');
  const req = f.llmCalls[2];
  check('C4 thinking-on：历史段无任何 tool_calls（无 thinking 块的历史不回传，防安全阀误杀）',
    req.every((m) => !m.tool_calls?.length));
  check('C5 thinking-on：历史段无 tool 角色消息（整段降级，不留孤儿结果）',
    req.every((m) => m.role !== 'tool'));
  check('C5b thinking-on：tool 结果以降级文本进历史（信息不丢，只丢结构）',
    req.some((m) => m.role === 'user' && m.content.includes('[工具 bash 结果] ok-result')));
  check('C6 thinking-on：本轮循环**内**消息仍全结构化（第 2 次 stream 含 tool 结果）',
    JSON.stringify(f.llmCalls[1]).includes('ok-result'));
}

{
  // 'auto' 无任务：清单空 → thinkingOn false → 走结构化回传
  const f = await makeRuntimeFakes({ thinking: 'auto', file: 'auto.jsonl' });
  await f.rt.prompt('帮我跑个命令');
  await f.rt.prompt('继续');
  const req = f.llmCalls[2];
  check('C7 auto（无进行中任务）：与 off 同路，历史结构化回传',
    req.some((m) => m.role === 'assistant' && (m.tool_calls?.length ?? 0) > 0));
}

/* ════════════════════════════════════════════════════════════════════════
   收尾
   ════════════════════════════════════════════════════════════════════════ */

console.log(`\n结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
fs.rmSync(tmpDir, { recursive: true, force: true });
process.exit(failed > 0 ? 1 : 0);
