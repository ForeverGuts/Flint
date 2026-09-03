/**
 * L3 验证脚本 —— 两条流式协议的真实 usage 打通（假 SSE 回放，不消耗真实 API）。
 *
 * 覆盖：
 *   U1  OpenAI 兼容：请求体带 stream_options.include_usage（不显式索取，流式默认不给用量）
 *   U2  OpenAI 兼容：末尾 choices=[] 的用量 chunk → end.usage 三值原样交出，且不污染正文
 *   U3  OpenAI 兼容：total_tokens 缺省时自加（部分代理端只给前两个）
 *   U4  OpenAI 兼容：端点没给用量 chunk → end 不带 usage 键（不伪报 0）
 *   U5  Anthropic：promptTokens = input_tokens + cache_creation + cache_read
 *   U6  Anthropic：message_delta 的 output_tokens 是累计值 → 覆盖而非累加
 *   U7  Anthropic：整条流没有用量事件 → end 不带 usage 键
 *   U8  Agent Loop：多轮真值逐轮相加
 *   U9  Agent Loop：任一轮缺失 → run().usage 整体为 null（不给少报的"真值"）
 *   U10 Agent Loop：真实用量进 llm_request_end 载荷（消费端一行不改就能拿到）
 *   U11 降级边界：与 stream_options 无关的 400 原样抛出（不误吞真错误）
 *   U12 降级：端点因 stream_options 报 400 → 同一次调用内静默重试，用户看不到失败
 *   U13 降级后：本进程内不再索取（开关永久关闭，不白跑一趟）
 *
 * 顺序有讲究：U12/U13 会把 stream-helper 的进程级开关永久关掉，
 * 必须排在所有"OpenAI 路径能拿到用量"的断言之后，否则前面的断言全成了假绿。
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-usage.ts
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AnthropicProvider } from '../src/llm/anthropic.js';
import { DeepSeekProvider } from '../src/llm/deepseek.js';
import { AgentLoopServiceImpl } from '../src/loop/agent-loop.js';
import { PromptEventEmitter } from '../src/runtime/events.js';
import type { RuntimeEvent } from '../src/runtime/events.js';
import type { EventStream } from '../src/runtime/event-stream.js';
import type { LLMConfig, LLMMessage, LLMProvider, LLMStreamEvent, LLMUsage } from '../src/llm/types.js';

/* ── 断言 ── */

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`); }
}

/** 用量三值逐一比对（缺一个都不算通过） */
function sameUsage(actual: LLMUsage | undefined, want: LLMUsage): boolean {
  return actual?.promptTokens === want.promptTokens
    && actual?.completionTokens === want.completionTokens
    && actual?.totalTokens === want.totalTokens;
}

/* ══ 假服务器：一台机器同时演两种协议（按 URL 分流，各自排队回放） ══ */

type Responder = (res: http.ServerResponse) => void;
const oaQueue: Responder[] = [];   // OpenAI 兼容（/v1/chat/completions）
const anQueue: Responder[] = [];   // Anthropic（/v1/messages）
let lastBody: Record<string, unknown> = {};
/** 请求计数：降级重试会多打一次，靠它证明"确实原地重试了" */
let oaCalls = 0;

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    lastBody = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    const anthropic = req.url === '/v1/messages';
    const next = (anthropic ? anQueue : oaQueue).shift();
    if (!anthropic) oaCalls++;
    if (!next) { res.writeHead(500); res.end('no script'); return; }
    next(res);
  });
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

/* ── 两个 Provider：同一台假服务器，baseUrl 差一段前缀 ── */

const oaCfg: LLMConfig = { baseUrl: `${base}/v1`, apiKey: 'k', model: 'm' };
const anCfg: LLMConfig = { baseUrl: base, apiKey: 'k', model: 'm' };
const oa = (): DeepSeekProvider => new DeepSeekProvider(oaCfg);
const an = (): AnthropicProvider => new AnthropicProvider(anCfg);
const msgs: LLMMessage[] = [{ role: 'user', content: '任务' }];

/* ── SSE 回放构造 ── */

/** OpenAI 兼容 SSE：只有 data: 行 */
function oaSse(res: http.ServerResponse): (obj: unknown) => void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  return (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

/** Anthropic SSE：event: 行 + data: 行（解析端只吃 data:，event 行照真实协议写上） */
function anSse(res: http.ServerResponse): (obj: Record<string, unknown>) => void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  return (obj) => {
    if (typeof obj.type === 'string') res.write(`event: ${obj.type}\n`);
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };
}

/** OpenAI 兼容流：正文分片 →（可选）用量 chunk → [DONE] */
function oaStream(texts: string[], usage?: Record<string, number>): Responder {
  return (res) => {
    const sse = oaSse(res);
    for (const t of texts) sse({ choices: [{ delta: { content: t } }] });
    // 真实 API 的用量 chunk 长这样：choices 是空数组、只带 usage，位于 [DONE] 之前
    if (usage) sse({ choices: [], usage });
    res.write('data: [DONE]\n\n');
    res.end();
  };
}

/** OpenAI 兼容流：带一次工具调用（arguments 分两片到达，驱动 Agent Loop 进第二轮） */
function oaToolStream(name: string, argsJson: string, usage?: Record<string, number>): Responder {
  return (res) => {
    const sse = oaSse(res);
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name } }] } }] });
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: argsJson.slice(0, 8) } }] } }] });
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: argsJson.slice(8) } }] } }] });
    if (usage) sse({ choices: [], usage });
    res.write('data: [DONE]\n\n');
    res.end();
  };
}

/** Anthropic 流的脚本形状：两段用量分别由 message_start / message_delta 携带 */
interface AnScript {
  texts?: string[];
  /** message_start 携的输入用量（含缓存明细）；不给 = 这条流没有输入用量 */
  startUsage?: Record<string, number>;
  /** message_delta 依次携的输出用量（真实协议给的是累计值，不是增量） */
  deltaUsages?: Array<Record<string, number>>;
}

function anStream(s: AnScript): Responder {
  return (res) => {
    const sse = anSse(res);
    sse({ type: 'message_start', message: { ...(s.startUsage ? { usage: s.startUsage } : {}) } });
    for (const t of s.texts ?? []) {
      sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } });
      sse({ type: 'content_block_stop', index: 0 });
    }
    for (const u of s.deltaUsages ?? []) sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: u });
    sse({ type: 'message_stop' });
    res.end();
  };
}

/* ── 流消费 ── */

type EndEvent = { type: 'end'; fullText: string; usage?: LLMUsage };

async function collect(stream: EventStream<LLMStreamEvent>): Promise<LLMStreamEvent[]> {
  const out: LLMStreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}
function endOf(events: LLMStreamEvent[]): EndEvent | undefined {
  return events.find((e) => e.type === 'end') as EndEvent | undefined;
}

/** Agent Loop 测试替身：工具一律秒回 [OK]，权限一律自动放行 */
function loopWith(llm: LLMProvider, events?: unknown): AgentLoopServiceImpl {
  return new AgentLoopServiceImpl({
    llm,
    tools: { getLLMTools: () => [], execute: async () => '[OK]', requiresPermission: () => false } as never,
    permission: { isAutoAllowed: () => true, grantAutoAllow: () => {} } as never,
    events: (events ?? { subscribe: () => () => {}, on: () => () => {}, emit: () => {} }) as never,
  });
}

/* ══════════════ U1-U4：OpenAI 兼容路径 ══════════════ */

console.log('── U1/2 OpenAI 兼容：显式索取 + 解析末尾用量 chunk ──');

oaQueue.push(oaStream(['你好', '，世界'], { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }));
const oaEnd1 = endOf(await collect(oa().stream(msgs)));
const so = lastBody.stream_options as { include_usage?: boolean } | undefined;
assert('请求体带 stream_options.include_usage（不索取则流式默认不给用量）',
  so?.include_usage === true, JSON.stringify(lastBody.stream_options));
assert('末尾用量 chunk → end.usage 三值原样交出',
  sameUsage(oaEnd1?.usage, { promptTokens: 11, completionTokens: 7, totalTokens: 18 }), JSON.stringify(oaEnd1?.usage));
assert('用量 chunk 不污染正文（那片 choices 是空的，没有 delta）',
  oaEnd1?.fullText === '你好，世界', `实际: ${oaEnd1?.fullText}`);

console.log('── U3/4 OpenAI 兼容：字段缺省的两种处理 ──');

oaQueue.push(oaStream(['x'], { prompt_tokens: 5, completion_tokens: 3 }));
const oaEnd2 = endOf(await collect(oa().stream(msgs)));
assert('total_tokens 缺省时自加（部分代理端只给前两个）',
  oaEnd2?.usage?.totalTokens === 8, `实际: ${String(oaEnd2?.usage?.totalTokens)}`);

oaQueue.push(oaStream(['纯正文']));
const oaEnd3 = endOf(await collect(oa().stream(msgs)));
assert('端点忽略索取、没给用量 chunk → end 不带 usage 键（不伪报 0）',
  oaEnd3 !== undefined && !('usage' in oaEnd3), JSON.stringify(oaEnd3?.usage));

/* ══════════════ U5-U7：Anthropic 路径 ══════════════ */

console.log('── U5 Anthropic：输入用量必须把缓存两项加回来 ──');

anQueue.push(anStream({
  texts: ['答案'],
  // 缓存全命中时的真实形状：input_tokens 只剩个位数，大头在 cache_read
  startUsage: { input_tokens: 4, cache_creation_input_tokens: 100, cache_read_input_tokens: 2000, output_tokens: 1 },
  deltaUsages: [{ output_tokens: 9 }],
}));
const anEnd1 = endOf(await collect(an().stream(msgs)));
assert('promptTokens = input + 缓存写入 + 缓存命中（只填 input_tokens 会少报三个数量级）',
  anEnd1?.usage?.promptTokens === 2104, `实际: ${String(anEnd1?.usage?.promptTokens)}`);
assert('completionTokens 取 message_delta 的输出用量',
  anEnd1?.usage?.completionTokens === 9, `实际: ${String(anEnd1?.usage?.completionTokens)}`);
assert('totalTokens 自加（协议不给这个字段）',
  anEnd1?.usage?.totalTokens === 2113, `实际: ${String(anEnd1?.usage?.totalTokens)}`);

console.log('── U6/7 Anthropic：累计值语义 + 完全没用量 ──');

anQueue.push(anStream({
  texts: ['a', 'b'],
  startUsage: { input_tokens: 10, output_tokens: 1 },
  deltaUsages: [{ output_tokens: 5 }, { output_tokens: 12 }],
}));
const anEnd2 = endOf(await collect(an().stream(msgs)));
assert('多个 message_delta 覆盖不累加（给的是累计值：1+5+12 与 12 只能对一个）',
  anEnd2?.usage?.completionTokens === 12, `实际: ${String(anEnd2?.usage?.completionTokens)}`);

anQueue.push(anStream({ texts: ['纯正文'] }));
const anEnd3 = endOf(await collect(an().stream(msgs)));
assert('整条流没有用量事件 → end 不带 usage 键（不伪报 0）',
  anEnd3 !== undefined && !('usage' in anEnd3), JSON.stringify(anEnd3?.usage));
assert('没用量不影响正文本身', anEnd3?.fullText === '纯正文', `实际: ${anEnd3?.fullText}`);

/* ══════════════ U8-U10：Agent Loop 合计与上送 ══════════════ */

console.log('── U8/9 Agent Loop：多轮合计与"任一轮缺失即整体 null" ──');

oaQueue.push(
  oaToolStream('read', '{"path":"a.ts"}', { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 }),
  oaStream(['最终答案'], { prompt_tokens: 120, completion_tokens: 8, total_tokens: 128 }),
);
const r1 = await loopWith(oa()).run([{ role: 'user', content: '两步任务' }]);
assert('两轮都有真值 → 逐轮相加（100+120 / 5+8 / 105+128）',
  sameUsage(r1.usage ?? undefined, { promptTokens: 220, completionTokens: 13, totalTokens: 233 }), JSON.stringify(r1.usage));
assert('合计不影响回复本身', r1.finalText === '最终答案', `实际: ${r1.finalText}`);

oaQueue.push(
  oaToolStream('read', '{"path":"b.ts"}', { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 }),
  oaStream(['最终答案']),   // 第二轮端点没给用量
);
const r2 = await loopWith(oa()).run([{ role: 'user', content: '两步任务' }]);
assert('任一轮缺失 → 整体 null（少报的"真值"比估算值更误导）',
  r2.usage === null, JSON.stringify(r2.usage));
assert('缺失只影响用量，不影响回复', r2.finalText === '最终答案', `实际: ${r2.finalText}`);

console.log('── U10 真实用量进 llm_request_end（消费端一行不改） ──');

const bus = new PromptEventEmitter();
const seen: RuntimeEvent[] = [];
bus.subscribe((e) => { seen.push(e); });
oaQueue.push(oaStream(['答案'], { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 }));
await loopWith(oa(), bus).run([{ role: 'user', content: '任务' }]);
const reqEnd = seen.find((e) => e.type === 'llm_request_end') as { usage?: LLMUsage | null } | undefined;
assert('llm_request_end 出门载荷带上了真实 usage',
  sameUsage(reqEnd?.usage ?? undefined, { promptTokens: 30, completionTokens: 12, totalTokens: 42 }),
  JSON.stringify(reqEnd?.usage));

/* ══════════════ U11-U13：降级机制（会永久关掉开关，必须最后跑） ══════════════ */

console.log('── U11 降级边界：别的 400 不能被误吞 ──');

oaCalls = 0;
oaQueue.push((res) => {
  res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end('{"error":{"message":"invalid api key"}}');
});
// 这条断言的就是"错误会照常暴露"，provider 的 console.error 属预期噪声，临时静音只为输出干净
const realError = console.error;
console.error = () => {};
const evBad = await collect(oa().stream(msgs));
console.error = realError;
assert('与 stream_options 无关的 400 → 不重试、不静默、原样抛出',
  oaCalls === 1 && evBad.length === 0, `calls=${oaCalls}, events=${evBad.length}`);

console.log('── U12/13 不兼容端点自动降级（进程级开关，跑完就永久关） ──');

oaCalls = 0;
oaQueue.push(
  (res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(`{"error":{"message":"Unknown parameter: 'stream_options' is not supported"}}`);
  },
  oaStream(['降级后的正文']),
);
const evDegrade = await collect(oa().stream(msgs));
const endDegrade = endOf(evDegrade);
assert('撞上不认这个参数的端点 → 同一次调用内静默重试（共 2 次请求）',
  oaCalls === 2, `calls=${oaCalls}`);
assert('重试那次不再带 stream_options', !('stream_options' in lastBody), JSON.stringify(lastBody.stream_options));
assert('用户看不到失败：流正常收尾、正文完整',
  endDegrade?.fullText === '降级后的正文', `实际: ${endDegrade?.fullText}`);
assert('这轮没有用量可言：end 不带 usage 键（不伪报 0）',
  endDegrade !== undefined && !('usage' in endDegrade), JSON.stringify(endDegrade?.usage));

oaCalls = 0;
oaQueue.push(oaStream(['后续请求']));
await collect(oa().stream(msgs));
assert('开关永久关闭：后续请求不再白跑一趟（直接不带 stream_options）',
  oaCalls === 1 && !('stream_options' in lastBody), `calls=${oaCalls}`);

server.close();
console.log(`\n结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
// 延迟退出：等 server.close 完成，避免 Windows 上 close 未完成就 exit 触发 libuv 断言
setTimeout(() => process.exit(failed > 0 ? 1 : 0), 100);
