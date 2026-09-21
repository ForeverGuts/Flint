/**
 * 压缩用量回流验证套件（2026-09-12）。
 *
 * 背景：压缩摘要（compaction）是一次真实的 LLM 调用，但过去 chat() 的非流式路径
 * 不返回用量、CompactionResult 不透传、runtime 不入账 —— /usage 合计一直少报这块。
 *
 * 验证四段：
 *   ① CompactionService 透传（真 CompactionServiceImpl + 真存储 + 探针 llm）
 *      —— API 报了用量就带回、没报就缺省、失败路径无、阈值下不调 LLM 无
 *   ② provider 层解析（fetch 替身）：OpenAI 兼容 createChat 与 AnthropicProvider.chat
 *      —— 含缓存字段口径（input + cache_creation + cache_read）、缺 usage 缺省
 *   ③ runtime 接线（真 Runtime + 真存储）：主轮压缩用量入 totalUsage 并广播 usage 事件；
 *      fork 摘要路径（compactNow）同样入账
 *   ④ 源码守护：契约字段与接线点在源码文本上钉住
 *
 * 一条自保（不计项数）：③ 段跑的是**真 Runtime**，压缩一发生 `runtime.ts` 就会调
 * `eventStore.recordCompaction(..., EVENTS_FILE)` —— 而账本是**相对 cwd**的 `.flint/events.jsonl`。
 * 2026-09-19 由 run-verify 的"账本逐套对账"点名（本套件是它抓到的**第三个**污染源）：
 * 不隔离的话，每跑一次就往**本仓库的真账本**里塞一条"对话历史已压缩"。
 * 见 `scripts/lib/sandbox.ts`。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enterSandbox } from './lib/sandbox.js';
import { JsonlSessionStorage } from '../src/session/jsonl-storage.js';
import { CompactionServiceImpl } from '../src/context/compaction.js';
import { Runtime } from '../src/runtime/runtime.js';
import { PromptEventEmitter } from '../src/runtime/events.js';
import { SpanCollectorImpl } from '../src/runtime/span-collector.js';
import { DeepSeekProvider } from '../src/llm/deepseek.js';
import { AnthropicProvider } from '../src/llm/anthropic.js';
import { createChat } from '../src/llm/stream-helper.js';
import * as ts from '../src/types.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ── 自保（不计项数）：全部在 `scripts/lib/sandbox.ts` 里（③ 段会真跑压缩 → 真写账本）── */
enterSandbox('flint-compaction-usage-');

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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsagent-verify-compact-usage-'));

/** 造一个真实存储并写入 n 条 user 消息 */
async function makeStorage(name: string, n: number): Promise<{ storage: JsonlSessionStorage; ids: string[] }> {
  const storage = await JsonlSessionStorage.create(tmpDir, name);
  for (let i = 1; i <= n; i++) await storage.appendMessage('user', `消息 ${i}`);
  return { storage, ids: storage.getAllMsgIds() };
}

/** 探针 LLM：返回固定摘要 + 可选 usage / 可抛异常 */
function makeProbeLlm(opts: { usage?: { promptTokens: number; completionTokens: number; totalTokens: number }; throwOnChat?: boolean } = {}) {
  const chats: Array<Array<{ role: string; content: string }>> = [];
  return {
    chats,
    chat: async (msgs: Array<{ role: string; content: string }>) => {
      chats.push(msgs);
      if (opts.throwOnChat) throw new Error('llm 炸了');
      return {
        content: '这是摘要',
        ...(opts.usage ? { usage: opts.usage } : {}),
      };
    },
    stream: () => { throw new Error('压缩不该走流式'); },
  };
}

const U = { promptTokens: 5, completionTokens: 7, totalTokens: 12 };

/* ════════════ ① CompactionService 透传 ════════════ */
console.log('── ① CompactionService 透传（真 svc + 真存储 + 探针 llm）──');
{
  const { storage } = await makeStorage('pass.jsonl', 25);
  const llm = makeProbeLlm({ usage: U });
  const r = await new CompactionServiceImpl({ llm: llm as never }).compactNow(await storage.getMessages(), storage);
  check('U1 API 报了用量 → CompactionResult.usage 原样带回',
    JSON.stringify(r.usage) === JSON.stringify(U), `实得 ${JSON.stringify(r.usage)}`);
  check('U2 摘要照常入树（用量透传不挤掉压缩本身）', storage.getCompactions().length === 1 && r.summary === '这是摘要');
}
{
  const { storage } = await makeStorage('nouse.jsonl', 25);
  const llm = makeProbeLlm(); // 不带 usage
  const r = await new CompactionServiceImpl({ llm: llm as never }).compactNow(await storage.getMessages(), storage);
  check('U3 API 没报用量 → usage 缺省（不伪报 0）', r.usage === undefined && r.summary === '这是摘要');
}
{
  const { storage } = await makeStorage('fail.jsonl', 25);
  const llm = makeProbeLlm({ usage: U, throwOnChat: true });
  const r = await new CompactionServiceImpl({ llm: llm as never }).compactNow(await storage.getMessages(), storage);
  check('U4 摘要调用失败 → 无摘要无用量（失败兜底口径不变）',
    r.usage === undefined && r.summary === undefined && storage.getCompactions().length === 0);
}
{
  const { storage } = await makeStorage('short.jsonl', 8);
  const llm = makeProbeLlm({ usage: U });
  const r = await new CompactionServiceImpl({ llm: llm as never }).compactNow(await storage.getMessages(), storage);
  check('U5 短前缀不压缩 → 不调 LLM、无用量', llm.chats.length === 0 && r.usage === undefined);
}
{
  const { storage } = await makeStorage('maybe.jsonl', 25);
  const llm = makeProbeLlm({ usage: U });
  const r = await new CompactionServiceImpl({ llm: llm as never }).maybeCompact(await storage.getMessages(), storage);
  check('U6 maybeCompact（25 > 阈值 20）触发压缩并带回用量',
    JSON.stringify(r.usage) === JSON.stringify(U) && r.summary === '这是摘要');
}

/* ════════════ ② provider 层解析（fetch 替身） ════════════ */
console.log('── ② provider 解析（fetch 替身）──');

/** 换上 fetch 替身，跑完恢复。handler 收 (url, init)，返回 json 形状 */
async function withFetchStub<T>(json: unknown, run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  let calledUrl = '';
  globalThis.fetch = (async (url: unknown) => {
    calledUrl = String(url);
    return { ok: true, json: async () => json, text: async () => '' };
  }) as typeof fetch;
  try {
    const r = await run();
    (r as { _calledUrl?: string })._calledUrl = calledUrl;
    return r;
  } finally {
    globalThis.fetch = real;
  }
}

{
  const cfg = { baseUrl: 'https://api.example.com', apiKey: 'k', model: 'm' };
  const r = await withFetchStub(
    {
      choices: [{ message: { content: '非流式回复' } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    },
    () => createChat(cfg as never, [{ role: 'user', content: 'hi' }]),
  );
  check('U7 OpenAI 兼容非流式：ChatResult.usage 解析到位',
    JSON.stringify(r.usage) === JSON.stringify({ promptTokens: 100, completionTokens: 20, totalTokens: 120 }),
    `实得 ${JSON.stringify(r.usage)}`);
  check('U8 内容不受影响', r.content === '非流式回复');
}
{
  const cfg = { baseUrl: 'https://api.example.com', apiKey: 'k', model: 'm' };
  const r = await withFetchStub(
    { choices: [{ message: { content: '没报用量' } }] },
    () => createChat(cfg as never, [{ role: 'user', content: 'hi' }]),
  );
  check('U9 响应无 usage 字段 → ChatResult.usage 缺省', r.usage === undefined);
}
{
  const cfg = { baseUrl: 'https://api.example.com', apiKey: 'k', model: 'm' };
  const r = await withFetchStub(
    {
      choices: [{ message: { content: '经由 provider' } }],
      usage: { prompt_tokens: 10, completion_tokens: 3 }, // total 缺 → 自加
    },
    () => new DeepSeekProvider(cfg as never).chat([{ role: 'user', content: 'hi' }]),
  );
  check('U10 DeepSeekProvider.chat 同路透传（total 缺则自加 13）',
    r.usage?.totalTokens === 13 && r.usage.promptTokens === 10 && r.usage.completionTokens === 3);
}
{
  const cfg = { baseUrl: 'https://api.example.com', apiKey: 'k', model: 'claude-m' };
  const r = await withFetchStub(
    {
      id: 'msg_1', type: 'message', role: 'assistant',
      content: [{ type: 'text', text: 'anthropic 回复' }],
      stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 400 },
    },
    () => new AnthropicProvider(cfg as never).chat([{ role: 'user', content: 'hi' }]),
  );
  check('U11 Anthropic 非流式：输入 = input + cache_creation + cache_read（550 不许少报）',
    r.usage?.promptTokens === 530 && r.usage.completionTokens === 20 && r.usage.totalTokens === 550,
    `实得 ${JSON.stringify(r.usage)}`);
  check('U12 内容不受影响', r.content === 'anthropic 回复');
}
{
  const cfg = { baseUrl: 'https://api.example.com', apiKey: 'k', model: 'claude-m' };
  const r = await withFetchStub(
    {
      id: 'msg_2', type: 'message', role: 'assistant',
      content: [{ type: 'text', text: '无用量' }],
      stop_reason: 'end_turn', stop_sequence: null,
    },
    () => new AnthropicProvider(cfg as never).chat([{ role: 'user', content: 'hi' }]),
  );
  check('U13 Anthropic 响应无 usage → 缺省（类型已改可选，旧替身不炸）', r.usage === undefined);
}

/* ── ③ runtime 接线：真 Runtime + 真存储 ── */

const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tsagent-verify-compact-usage-rt-'));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeRuntime(session: any, compaction: any): any {
  const emitter = new PromptEventEmitter();
  return new Runtime({
    llm: { chat: async () => ({ content: '' }), stream: () => { throw new Error('本脚本不触发 LLM'); } },
    session,
    tools: { getLLMTools: () => [], requiresPermission: () => false, execute: async () => ({ status: 'ok', content: '' }), register: () => {} },
    permission: { isAutoAllowed: () => true, grantAutoAllow: () => {} },
    skills: { load: () => {} },
    events: emitter,
    spanCollector: { collect: () => [], running: () => [] },
    commandSystem: { register: () => {}, list: () => [], execute: () => null },
    diagnosticsService: { record: () => {}, getAll: () => [] },
    compaction,
    systemPromptService: { build: async () => ({ messages: [] }) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

console.log('── ③ runtime 接线（fork 摘要路径入账）──');
{
  const { storage, ids } = await makeStorage('rt-fork.jsonl', 25);
  const compaction = {
    compactNow: async () => ({ history: [], summary: 'fork 摘要', usage: U }),
    maybeCompact: async () => ({ history: [], summary: undefined }),
  };
  const rt = makeRuntime(storage, compaction);
  const usageEvents: Array<{ current: { totalTokens: number }; total: { totalTokens: number } }> = [];
  rt.events.subscribe((e: { type: string }) => { if (e.type === 'usage') usageEvents.push(e as never); });
  await rt.forkSessionWithSummary(ids[20]);
  check('U14 fork 摘要的压缩用量入 totalUsage 合计',
    rt.totalUsage.totalTokens === 12 && rt.totalUsage.promptTokens === 5 && rt.totalUsage.completionTokens === 7,
    `实得 ${JSON.stringify(rt.totalUsage)}`);
  check('U15 usage 事件广播（UI 的 ⚡ 行有数据源）',
    usageEvents.length === 1 && usageEvents[0].current.totalTokens === 12 && usageEvents[0].total.totalTokens === 12,
    `实得 ${usageEvents.length} 个事件`);
}
{
  // 对照组：压缩没报用量 → 合计纹丝不动
  const { storage, ids } = await makeStorage('rt-fork-nouse.jsonl', 25);
  const compaction = {
    compactNow: async () => ({ history: [], summary: 'fork 摘要' }),
    maybeCompact: async () => ({ history: [], summary: undefined }),
  };
  const rt = makeRuntime(storage, compaction);
  await rt.forkSessionWithSummary(ids[20]);
  check('U16 压缩没报用量 → 合计不动（usage 缺省即跳过，不伪报 0）',
    rt.totalUsage.totalTokens === 0, `实得 ${JSON.stringify(rt.totalUsage)}`);
}

/* ── 主轮路径：真 Runtime + 真 CompactionServiceImpl，rt.prompt 走完整一轮 ── */

async function makeRuntimeFakes(file: string, chatUsage?: typeof U): Promise<{ rt: Runtime; usageEvents: Array<{ type: string; current: { totalTokens: number }; total: { totalTokens: number } }> }> {
  const endEvent = { type: 'end', fullText: 'done', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  const llm = {
    chat: async () => ({ content: '这是摘要', ...(chatUsage ? { usage: chatUsage } : {}) }),
    stream: () => (async function* () {
      yield { type: 'token', text: 'done' };
      yield endEvent;
    })(),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const session = await (JsonlSessionStorage.create(tmpDir2, file) as any);
  const rt = new Runtime({
    llm,
    session,
    tools: { getLLMTools: () => [], requiresPermission: () => false, execute: async () => ({ status: 'ok', content: 'ok' }), register: () => {} },
    permission: { isAutoAllowed: () => true, grantAutoAllow: () => {}, clear: () => {} },
    skills: { load: () => {}, getAll: () => [], get: () => undefined },
    events: new PromptEventEmitter(),
    spanCollector: new SpanCollectorImpl(),
    commandSystem: { register: () => {}, list: () => [], execute: async () => null },
    diagnosticsService: { record: () => {}, getAll: () => [] },
    compaction: new CompactionServiceImpl({ llm } as never),
    systemPromptService: { build: async () => ({ messages: [{ role: 'system', content: 'sys' }] }) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  const usageEvents: Array<{ type: string; current: { totalTokens: number }; total: { totalTokens: number } }> = [];
  rt.events.subscribe((e: { type: string }) => { if (e.type === 'usage') usageEvents.push(e); });
  return { rt, usageEvents };
}

console.log('── ③b runtime 接线（主轮 maybeCompact 路径入账）──');
{
  // 21 条历史 > 阈值 20 → 本轮开头触发压缩；压缩用量 {5,7,12} + 主轮 {1,1,2} = {6,8,14}
  const { rt, usageEvents } = await makeRuntimeFakes('rt-main.jsonl', U);
  for (let i = 1; i <= 21; i++) await rt.session.appendMessage('user', `消息 ${i}`);
  await rt.prompt('继续');
  check('U17 主轮：压缩用量并入合计（{5,7,12} + 主轮 {1,1,2}）',
    rt.totalUsage.promptTokens === 6 && rt.totalUsage.completionTokens === 8 && rt.totalUsage.totalTokens === 14,
    `实得 ${JSON.stringify(rt.totalUsage)}`);
  check('U18 本轮广播两次 usage 事件（压缩一次 + 主轮一次）',
    usageEvents.length === 2
    && usageEvents[0].current.totalTokens === 12 && usageEvents[0].total.totalTokens === 12
    && usageEvents[1].current.totalTokens === 2 && usageEvents[1].total.totalTokens === 14,
    `实得 ${usageEvents.map((e) => e.current.totalTokens).join(',')}`);
}
{
  // 对照组：历史不超阈值 → 无压缩调用，合计只有主轮
  const { rt, usageEvents } = await makeRuntimeFakes('rt-main-short.jsonl', U);
  for (let i = 1; i <= 5; i++) await rt.session.appendMessage('user', `消息 ${i}`);
  await rt.prompt('继续');
  check('U19 无压缩轮：合计只有主轮用量（不凭空多账）',
    rt.totalUsage.totalTokens === 2 && usageEvents.length === 1,
    `实得 ${JSON.stringify(rt.totalUsage)}/${usageEvents.length}`);
}

/* ════════════ ④ 源码守护 ════════════ */
console.log('── ④ 源码守护（契约字段 + 接线点钉在源码文本上）──');
{
  const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const typesSrc = read('src/llm/types.ts');
  const streamSrc = read('src/llm/stream-helper.ts');
  const anthropicSrc = read('src/llm/anthropic.ts');
  const coreCompactionSrc = read('src/core/compaction.ts');
  const ctxCompactionSrc = read('src/context/compaction.ts');
  const runtimeSrc = read('src/runtime/runtime.ts');

  check('U20 ChatResult 契约有 usage?: LLMUsage', /tool_calls\?\s*:\s*LLMToolCall\[\];[\s\S]{0,120}usage\?\s*:\s*LLMUsage/.test(typesSrc));
  check('U21 createChat 解析响应 usage 并挂上结果', /data\.usage\s*\?\s*\{\s*usage:\s*toLLMUsage\(data\.usage\)\s*\}/.test(streamSrc));
  check('U22 Anthropic 用量换算函数存在且缓存三项入输入',
    /function anthropicUsageToLLM[\s\S]{0,400}cache_creation_input_tokens[\s\S]{0,120}cache_read_input_tokens/.test(anthropicSrc));
  check('U23 extractChatResult 把 usage 挂进 ChatResult',
    /response\.usage\s*\?\s*\{\s*usage:\s*anthropicUsageToLLM\(response\.usage\)\s*\}/.test(anthropicSrc));
  // ⚠ 别把"两个成员相隔多少字符"写进判据：中间插一个字段（如 10.8.4 的 `aborted?`）就会顶红，
  //   而红的理由与"usage 在不在"毫无关系。改成**在 interface 块内**找，射程才等于这条断言的名字。
  const resultBlock = /export interface CompactionResult \{[\s\S]*?\n\}/.exec(coreCompactionSrc)?.[0] ?? '';
  check('U24 CompactionResult 契约有 usage 成员', /usage\?\s*:\s*LLMUsage/.test(resultBlock), resultBlock.slice(0, 80));
  check('U25 compactTo 从 chat 结果解构并透传 usage',
    /const \{ summary, usage \} = await spanRecorderOf\(events\)\.trace\('compaction'[\s\S]{0,800}usage \? \{ usage \} : \{\}/.test(ctxCompactionSrc));
  check('U25b maybeCompact 合并结果时不丢用量（首跑抓到的真 bug）',
    /if \(r\.usage\) compactionUsage = r\.usage;[\s\S]{0,200}compactionUsage \? \{ usage: compactionUsage \} : \{\}/.test(ctxCompactionSrc));
  check('U26 runtime 主轮压缩点入账', /maybeCompact\(history, this\.compactionStore\(\)\);[\s\S]{0,120}if \(compacted\.usage\) this\.bumpUsage\(compacted\.usage\)/.test(runtimeSrc));
  check('U27 runtime fork 摘要点入账', /compactNow\(history, this\.compactionStore\(\)\);[\s\S]{0,120}if \(result\.usage\) this\.bumpUsage\(result\.usage\)/.test(runtimeSrc));
  check('U28 bumpUsage 是唯一累加点（主轮也走它）',
    /this\.bumpUsage\(usage \?\? estimateTokenUsage\(currentText, finalText\)\)/.test(runtimeSrc)
    && runtimeSrc.split('bumpUsage(').length - 1 >= 3);
  check('U29 usage 仍缺省优先真值、回退估算（estimateTokenUsage 兜底没被删）',
    /estimateTokenUsage/.test(runtimeSrc));
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
setTimeout(() => process.exit(failed > 0 ? 1 : 0), 100);
