/**
 * 缓存命中率明细验证 —— LLMUsage.cacheReadTokens / cacheCreationTokens 全链路（不消耗真实 API）。
 *
 * 覆盖：
 *   ① Anthropic 流式：message_start 携缓存明细 → end.usage 单列；promptTokens 三者和口径不变
 *   ② Anthropic 非流式：chat() 的 usage 明细单列；字段缺省不伪报 0
 *   ③ OpenAI 兼容流式：prompt_tokens_details.cached_tokens → cacheReadTokens；prompt_tokens 已含缓存不动
 *   ④ OpenAI 兼容非流式：同上
 *   ⑤ Agent Loop 合计：逐轮有报就累加，全程无报缺省
 *   ⑥ Runtime 接线：bumpUsage 累加 + usage 事件 total 带明细（真 Runtime + 真存储）
 *   ⑦ /usage 命令展示：报了才显示（含占比），没报不显示
 *   ⑧ 源码守护：契约字段 / 解析点 / 累加点 / 展示条件钉在源码文本上
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-cache-usage.ts
 */
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { AnthropicProvider } from '../src/llm/anthropic.js';
import { DeepSeekProvider } from '../src/llm/deepseek.js';
import { createChat } from '../src/llm/stream-helper.js';
import { AgentLoopServiceImpl } from '../src/loop/agent-loop.js';
import { Runtime } from '../src/runtime/runtime.js';
import { PromptEventEmitter } from '../src/runtime/events.js';
import { JsonlSessionStorage } from '../src/session/jsonl-storage.js';
import { activate as usageActivate } from '../src/commands/builtin/usage.js';
import type { EventStream } from '../src/runtime/event-stream.js';
import type { LLMConfig, LLMMessage, LLMProvider, LLMStreamEvent, LLMUsage } from '../src/llm/types.js';

const ROOT = path.join(import.meta.dirname, '..');

/* ── 断言 ── */
let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`); }
}

/** 缓存明细逐一比对：总量三值 + 明细两值（want 里有才比，没有则要求 actual 也不带键） */
function sameUsage(actual: LLMUsage | undefined, want: LLMUsage): boolean {
  if (!actual) return false;
  const base = actual.promptTokens === want.promptTokens
    && actual.completionTokens === want.completionTokens
    && actual.totalTokens === want.totalTokens;
  const rd = want.cacheReadTokens === undefined
    ? actual.cacheReadTokens === undefined
    : actual.cacheReadTokens === want.cacheReadTokens;
  const wr = want.cacheCreationTokens === undefined
    ? actual.cacheCreationTokens === undefined
    : actual.cacheCreationTokens === want.cacheCreationTokens;
  return base && rd && wr;
}

/* ══ 假服务器：一台机器同时演两种协议（模式同 verify-usage） ══ */

type Responder = (res: http.ServerResponse) => void;
const oaQueue: Responder[] = [];
const anQueue: Responder[] = [];

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const anthropic = req.url === '/v1/messages';
    const next = (anthropic ? anQueue : oaQueue).shift();
    if (!next) { res.writeHead(500); res.end('no script'); return; }
    next(res);
  });
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const oaCfg: LLMConfig = { baseUrl: `${base}/v1`, apiKey: 'k', model: 'm' };
const anCfg: LLMConfig = { baseUrl: base, apiKey: 'k', model: 'm' };
const msgs: LLMMessage[] = [{ role: 'user', content: '任务' }];

function oaSse(res: http.ServerResponse): (obj: unknown) => void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  return (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
}
function anSse(res: http.ServerResponse): (obj: Record<string, unknown>) => void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  return (obj) => {
    if (typeof obj.type === 'string') res.write(`event: ${obj.type}\n`);
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };
}

/** OpenAI 兼容流：正文分片 →（可选）用量 chunk → [DONE]。usage 形状放开，允许带 prompt_tokens_details */
function oaStream(texts: string[], usage?: Record<string, unknown>): Responder {
  return (res) => {
    const sse = oaSse(res);
    for (const t of texts) sse({ choices: [{ delta: { content: t } }] });
    if (usage) sse({ choices: [], usage });
    res.write('data: [DONE]\n\n');
    res.end();
  };
}
/** OpenAI 兼容流：带一次工具调用（arguments 分两片，驱动 Agent Loop 进第二轮） */
function oaToolStream(name: string, argsJson: string, usage?: Record<string, unknown>): Responder {
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

/** Anthropic 流脚本：startUsage（message_start 携输入用量含缓存明细）+ deltaUsages（累计输出） */
function anStream(s: { texts?: string[]; startUsage?: Record<string, number>; deltaUsages?: Array<Record<string, number>> }): Responder {
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

type EndEvent = { type: 'end'; fullText: string; usage?: LLMUsage };

async function collect(stream: EventStream<LLMStreamEvent>): Promise<LLMStreamEvent[]> {
  const out: LLMStreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}
function endOf(events: LLMStreamEvent[]): EndEvent | undefined {
  return events.find((e) => e.type === 'end') as EndEvent | undefined;
}

/** fetch 替身（非流式路径用） */
async function withFetchStub<T>(json: unknown, run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, json: async () => json, text: async () => '' })) as typeof fetch;
  try { return await run(); } finally { globalThis.fetch = real; }
}

/* ══════════════ ① Anthropic 流式 ══════════════ */

console.log('── ① Anthropic 流式：message_start 缓存明细单列 ──');
{
  anQueue.push(anStream({
    texts: ['答案'],
    startUsage: { input_tokens: 4, cache_creation_input_tokens: 100, cache_read_input_tokens: 2000, output_tokens: 1 },
    deltaUsages: [{ output_tokens: 9 }],
  }));
  const end = endOf(await collect(new AnthropicProvider(anCfg).stream(msgs)));
  check('C1 明细单列：cacheRead=2000 / cacheCreation=100，promptTokens 三者和 2104 不变',
    sameUsage(end?.usage, {
      promptTokens: 2104, completionTokens: 9, totalTokens: 2113,
      cacheReadTokens: 2000, cacheCreationTokens: 100,
    }), JSON.stringify(end?.usage));
}
{
  anQueue.push(anStream({
    texts: ['答案'],
    startUsage: { input_tokens: 10, output_tokens: 1 },
    deltaUsages: [{ output_tokens: 5 }],
  }));
  const end = endOf(await collect(new AnthropicProvider(anCfg).stream(msgs)));
  check('C2 message_start 没带缓存字段 → usage 不带明细键（不伪报 0）',
    end?.usage !== undefined
    && !('cacheReadTokens' in end.usage)
    && !('cacheCreationTokens' in end.usage)
    && end.usage.promptTokens === 10, JSON.stringify(end?.usage));
}
{
  anQueue.push(anStream({ texts: ['纯正文'] }));
  const end = endOf(await collect(new AnthropicProvider(anCfg).stream(msgs)));
  check('C3 整条流没用量 → 不带 usage 键（口径不变的回归钉）',
    end !== undefined && !('usage' in end), JSON.stringify(end?.usage));
}

/* ══════════════ ② Anthropic 非流式 ══════════════ */

console.log('── ② Anthropic 非流式：chat() 明细单列 ──');
{
  const r = await withFetchStub(
    {
      id: 'msg_1', type: 'message', role: 'assistant',
      content: [{ type: 'text', text: '回复' }],
      stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 400 },
    },
    () => new AnthropicProvider({ baseUrl: 'https://x', apiKey: 'k', model: 'm' } as never).chat(msgs),
  );
  check('C4 明细单列：cacheRead=400 / cacheCreation=30，promptTokens=530 三者和不变',
    sameUsage(r.usage, {
      promptTokens: 530, completionTokens: 20, totalTokens: 550,
      cacheReadTokens: 400, cacheCreationTokens: 30,
    }), JSON.stringify(r.usage));
}
{
  const r = await withFetchStub(
    {
      id: 'msg_2', type: 'message', role: 'assistant',
      content: [{ type: 'text', text: '回复' }],
      stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 2 },
    },
    () => new AnthropicProvider({ baseUrl: 'https://x', apiKey: 'k', model: 'm' } as never).chat(msgs),
  );
  check('C5 无缓存字段 → usage 不带明细键',
    r.usage !== undefined && !('cacheReadTokens' in r.usage) && !('cacheCreationTokens' in r.usage),
    JSON.stringify(r.usage));
}

/* ══════════════ ③④ OpenAI 兼容 ══════════════ */

console.log('── ③ OpenAI 兼容流式：cached_tokens → cacheReadTokens ──');
{
  oaQueue.push(oaStream(['答案'], {
    prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020,
    prompt_tokens_details: { cached_tokens: 800 },
  }));
  const end = endOf(await collect(new DeepSeekProvider(oaCfg).stream(msgs)));
  check('C6 cacheRead=800 单列；promptTokens 原样 1000（OpenAI 的 prompt_tokens 已含缓存，不动）',
    sameUsage(end?.usage, { promptTokens: 1000, completionTokens: 20, totalTokens: 1020, cacheReadTokens: 800 }),
    JSON.stringify(end?.usage));
}
{
  oaQueue.push(oaStream(['答案'], { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }));
  const end = endOf(await collect(new DeepSeekProvider(oaCfg).stream(msgs)));
  check('C7 没带 prompt_tokens_details → usage 不带 cacheReadTokens 键',
    end?.usage !== undefined && !('cacheReadTokens' in end.usage), JSON.stringify(end?.usage));
}

console.log('── ④ OpenAI 兼容非流式 ──');
{
  const r = await withFetchStub(
    {
      choices: [{ message: { content: '回复' } }],
      usage: {
        prompt_tokens: 500, completion_tokens: 10, total_tokens: 510,
        prompt_tokens_details: { cached_tokens: 320 },
      },
    },
    () => createChat({ baseUrl: 'https://x', apiKey: 'k', model: 'm' } as never, msgs),
  );
  check('C8 非流式同路：cacheRead=320 单列，总量三值不变',
    sameUsage(r.usage, { promptTokens: 500, completionTokens: 10, totalTokens: 510, cacheReadTokens: 320 }),
    JSON.stringify(r.usage));
}
{
  const r = await withFetchStub(
    { choices: [{ message: { content: '回复' } }], usage: { prompt_tokens: 10, completion_tokens: 1 } },
    () => createChat({ baseUrl: 'https://x', apiKey: 'k', model: 'm' } as never, msgs),
  );
  check('C9 无明细 → 不带键（且 total 缺省自加 11）',
    r.usage?.totalTokens === 11 && !('cacheReadTokens' in r.usage), JSON.stringify(r.usage));
}

/* ══════════════ ⑤ Agent Loop 合计 ══════════════ */

console.log('── ⑤ Agent Loop：逐轮有报就累加，全程无报缺省 ──');

function loopWith(llm: LLMProvider): AgentLoopServiceImpl {
  return new AgentLoopServiceImpl({
    llm,
    tools: { getLLMTools: () => [], execute: async () => ({ status: 'ok', content: '[OK]' }), requiresPermission: () => false } as never,
    permission: { isAutoAllowed: () => true, grantAutoAllow: () => {} } as never,
    events: { subscribe: () => () => {}, on: () => () => {}, emit: () => {} } as never,
  });
}
{
  oaQueue.push(
    oaToolStream('read', '{"path":"a.ts"}', {
      prompt_tokens: 100, completion_tokens: 5, total_tokens: 105,
      prompt_tokens_details: { cached_tokens: 30 },
    }),
    oaStream(['最终答案'], {
      prompt_tokens: 120, completion_tokens: 8, total_tokens: 128,
      prompt_tokens_details: { cached_tokens: 50 },
    }),
  );
  const r = await loopWith(new DeepSeekProvider(oaCfg)).run([{ role: 'user', content: '两步' }]);
  check('C10 两轮都有明细 → cacheRead 相加 30+50=80',
    r.usage?.cacheReadTokens === 80, JSON.stringify(r.usage));
}
{
  oaQueue.push(
    oaToolStream('read', '{"path":"b.ts"}', {
      prompt_tokens: 100, completion_tokens: 5, total_tokens: 105,
      prompt_tokens_details: { cached_tokens: 30 },
    }),
    oaStream(['最终答案'], { prompt_tokens: 120, completion_tokens: 8, total_tokens: 128 }),
  );
  const r = await loopWith(new DeepSeekProvider(oaCfg)).run([{ role: 'user', content: '两步' }]);
  check('C11 首轮报二轮没报 → cacheRead=30（有报就累加，缺省轮不炸）',
    r.usage?.cacheReadTokens === 30, JSON.stringify(r.usage));
}
{
  oaQueue.push(
    oaToolStream('read', '{"path":"c.ts"}', { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 }),
    oaStream(['最终答案'], { prompt_tokens: 120, completion_tokens: 8, total_tokens: 128 }),
  );
  const r = await loopWith(new DeepSeekProvider(oaCfg)).run([{ role: 'user', content: '两步' }]);
  check('C12 全程无报 → cacheReadTokens 缺省（不伪报 0）',
    r.usage !== null && !('cacheReadTokens' in r.usage), JSON.stringify(r.usage));
}

/* ══════════════ ⑥ Runtime 接线（真 Runtime + 真存储） ══════════════ */

console.log('── ⑥ Runtime：bumpUsage 累加 + usage 事件带明细 ──');
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsagent-verify-cache-usage-rt-'));
  const session = await (JsonlSessionStorage.create(tmpDir, 'cache-rt.jsonl') as never);
  const endUsage = {
    promptTokens: 100, completionTokens: 10, totalTokens: 110,
    cacheReadTokens: 90, cacheCreationTokens: 5,
  };
  const llm = {
    chat: async () => ({ content: '' }),
    stream: () => (async function* () {
      yield { type: 'token', text: 'done' };
      yield { type: 'end', fullText: 'done', usage: { ...endUsage } };
    })(),
  };
  const rt = new Runtime({
    llm,
    session,
    tools: { getLLMTools: () => [], requiresPermission: () => false, execute: async () => ({ status: 'ok', content: 'ok' }), register: () => {} },
    permission: { isAutoAllowed: () => true, grantAutoAllow: () => {}, clear: () => {} },
    skills: { load: () => {}, getAll: () => [], get: () => undefined },
    events: new PromptEventEmitter(),
    spanCollector: { collect: () => [], running: () => [] },
    commandSystem: { register: () => {}, list: () => [], execute: async () => null },
    diagnosticsService: { record: () => {}, getAll: () => [] },
    compaction: { maybeCompact: async () => ({ history: [], summary: undefined }) },
    systemPromptService: { build: async () => ({ messages: [{ role: 'system', content: 'sys' }] }) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  const usageEvents: Array<{ current: LLMUsage; total: LLMUsage }> = [];
  rt.events.subscribe((e: { type: string }) => { if (e.type === 'usage') usageEvents.push(e as never); });
  await rt.prompt('第一问');
  await rt.prompt('第二问');
  check('C13 两次 prompt → totalUsage 明细累加 90+90=180 / 5+5=10',
    rt.totalUsage.cacheReadTokens === 180 && rt.totalUsage.cacheCreationTokens === 10,
    JSON.stringify(rt.totalUsage));
  check('C14 usage 事件 total 带明细（UI ⚡ 行的数据源）',
    usageEvents.length === 2 && usageEvents[1].total.cacheReadTokens === 180,
    JSON.stringify(usageEvents.map((e) => e.total)));
}

/* ══════════════ ⑦ /usage 命令展示 ══════════════ */

console.log('── ⑦ /usage 命令：报了才显示，没报不显示 ──');
{
  const handlers: Record<string, () => string> = {};
  const fakeRt = {
    registerCommand: (name: string, _desc: string, h: () => string) => { handlers[name] = h; },
    totalUsage: {
      promptTokens: 11000, completionTokens: 500, totalTokens: 11500, cacheReadTokens: 9000,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  usageActivate(fakeRt);
  const out = handlers['usage']();
  check('C15 有明细 → 显示"缓存命中"行且占比 82%',
    out.includes('缓存命中') && out.includes('82%'), out);
}
{
  const handlers: Record<string, () => string> = {};
  const fakeRt = {
    registerCommand: (name: string, _desc: string, h: () => string) => { handlers[name] = h; },
    totalUsage: { promptTokens: 100, completionTokens: 5, totalTokens: 105 },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  usageActivate(fakeRt);
  const out = handlers['usage']();
  check('C16 无明细 → 输出不出现缓存行（不显示 0）',
    !out.includes('缓存'), out);
}

/* ══════════════ ⑧ 源码守护 ══════════════ */

console.log('── ⑧ 源码守护 ──');
{
  const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const typesSrc = read('src/llm/types.ts');
  const streamSrc = read('src/llm/stream-helper.ts');
  const anthropicSrc = read('src/llm/anthropic.ts');
  const loopSrc = read('src/loop/agent-loop.ts');
  const runtimeSrc = read('src/runtime/runtime.ts');
  const usageSrc = read('src/commands/builtin/usage.ts');

  check('G1 LLMUsage 契约带两个可选明细字段（缺省语义写在注释里）',
    typesSrc.includes('cacheReadTokens?: number') && typesSrc.includes('cacheCreationTokens?: number'));
  check('G2 OpenAI 解析点吃 prompt_tokens_details.cached_tokens',
    streamSrc.includes('prompt_tokens_details') && streamSrc.includes('cached_tokens'));
  check('G3 Anthropic 流式 message_start 捕获两个缓存字段',
    /cache_read_input_tokens !== undefined\) cacheRead/.test(anthropicSrc)
    && /cache_creation_input_tokens !== undefined\) cacheCreation/.test(anthropicSrc));
  check('G4 两个累加点都有"有报就累加"守卫（agent-loop + runtime）',
    loopSrc.includes('(usageTotal.cacheReadTokens ?? 0)')
    && runtimeSrc.includes('(this.totalUsage.cacheReadTokens ?? 0)'));
  check('G5 /usage 展示条件是 !== undefined（不是 > 0 —— 展示伪报 0 的门在这）',
    usageSrc.includes('cacheReadTokens !== undefined') && usageSrc.includes('cacheCreationTokens !== undefined'));
}

server.close();
console.log(`\n结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
setTimeout(() => process.exit(failed > 0 ? 1 : 0), 100);
