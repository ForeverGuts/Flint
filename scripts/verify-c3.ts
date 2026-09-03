/**
 * 阶段 C3（问题1+2）验证脚本 —— Anthropic thinking 参数消费 + budget 约束 + 推理分流（不消耗真实 API）。
 *
 * 覆盖：
 *   C3-1 opts.thinking=true 且无 assistant 历史 → body.thinking = { type:'enabled', budget_tokens } 且 budget < max_tokens
 *   C3-2 精确安全阀：纯文本 assistant 历史（无工具调用）不拦截开启
 *   C3-3 opts.thinking=false → 不带 thinking 参数（按次覆盖优先）
 *   C3-4 无 opts + config.thinking='on' → 开启（配置兜底，与 OpenAI 路径同一解析函数）
 *   C3-5 无 opts + config.thinking='auto' → 不带（Provider 侧 auto 按关，判定在 Runtime）
 *   C3-6 流式：thinking_delta → reasoning 事件（拼装正确），fullText 只含正文（展示不持久）
 *   C3-7 多轮回放（收集→挂载→回放端到端）：第 2 轮请求原样回放第 1 轮 thinking 块（含 signature、位置最前）
 *   C3-8 挂载语义：工具轮挂块、最终答案轮不落消息（循环 break 前不 push，无块不传键）
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-c3.ts
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AnthropicProvider } from '../src/llm/anthropic.js';
import { AgentLoopServiceImpl } from '../src/loop/agent-loop.js';
import type { LLMConfig, LLMMessage, LLMRequestOptions, LLMStreamEvent, ThinkingBlock } from '../src/llm/types.js';

/* ── 断言 ── */

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`); }
}

/* ══ 假 Anthropic 服务器（捕获请求体；stream 回放预制双块流） ══ */

let lastBody: Record<string, unknown> = {};
type SseFn = (obj: unknown) => void;
/** 流式请求按序回放的脚本：C3-6 thinking+正文 → C3-7 第1轮 thinking(带签名)+工具 → C3-7 第2轮 纯正文 */
const streamScripts: Array<(sse: SseFn) => void> = [
  (sse) => {
    sse({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
    sse({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先想一想，' } });
    sse({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '再作答。' } });
    sse({ type: 'content_block_stop', index: 0 });
    sse({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
    sse({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '正式答案' } });
    sse({ type: 'content_block_stop', index: 1 });
  },
  (sse) => {
    sse({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
    sse({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '工具循环第一轮推理' } });
    sse({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG_ABC123' } });
    sse({ type: 'content_block_stop', index: 0 });
    sse({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read' } });
    sse({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"a.ts"}' } });
    sse({ type: 'content_block_stop', index: 1 });
  },
  (sse) => {
    sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '最终答案' } });
    sse({ type: 'content_block_stop', index: 0 });
  },
];
let streamCount = 0;
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    lastBody = JSON.parse(raw) as Record<string, unknown>;
    if (lastBody.stream === true) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const sse: SseFn = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      streamScripts[streamCount++](sse);
      sse({ type: 'message_stop' });
      res.end();
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_test', type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    }
  });
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address() as AddressInfo;

function provider(thinking?: LLMConfig['thinking']): AnthropicProvider {
  const cfg: LLMConfig = { baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', model: 'm' };
  if (thinking) cfg.thinking = thinking;
  return new AnthropicProvider(cfg);
}
const noHistory: LLMMessage[] = [{ role: 'user', content: '任务' }];
const withHistory: LLMMessage[] = [
  { role: 'user', content: '任务' },
  { role: 'assistant', content: '上一轮答复' },
];

console.log('── C3-1/2/3 chat 请求参数（按次判定 + 安全阀 + budget 约束） ──');

await provider('auto').chat(noHistory, undefined, { thinking: true } satisfies LLMRequestOptions);
const t1 = lastBody.thinking as { type?: string; budget_tokens?: number } | undefined;
assert('覆盖开 + 无历史 → thinking.enabled', t1?.type === 'enabled', JSON.stringify(lastBody.thinking));
assert('budget_tokens < max_tokens（协议硬约束）',
  typeof t1?.budget_tokens === 'number' && t1.budget_tokens < (lastBody.max_tokens as number),
  `budget=${t1?.budget_tokens}, max=${String(lastBody.max_tokens)}`);

await provider('on').chat(withHistory, undefined, { thinking: true });
assert('精确安全阀：纯文本 assistant 历史（无工具调用）不拦截开启',
  (lastBody.thinking as { type?: string })?.type === 'enabled', JSON.stringify(lastBody.thinking));

await provider('on').chat(noHistory, undefined, { thinking: false });
assert('覆盖关 → 不带 thinking（按次覆盖优先于配置）', !('thinking' in lastBody));

console.log('── C3-4/5 配置兜底（与 OpenAI 路径同一解析函数） ──');

await provider('on').chat(noHistory);
assert("config 'on' 无覆盖 → 开启", (lastBody.thinking as { type?: string })?.type === 'enabled');

await provider('auto').chat(noHistory);
assert("config 'auto' 无覆盖 → 不带（Provider 侧按关，判定在 Runtime）", !('thinking' in lastBody));

console.log('── C3-6 流式解析（thinking_delta → reasoning，展示不持久） ──');

const events: LLMStreamEvent[] = [];
for await (const e of provider('auto').stream(noHistory, undefined, { thinking: true })) {
  events.push(e);
}
const reasoning = events.filter((e) => e.type === 'reasoning').map((e) => (e as { text: string }).text).join('');
const end = events.find((e) => e.type === 'end') as { fullText: string } | undefined;
assert('reasoning 事件拼装正确', reasoning === '先想一想，再作答。', `实际: ${reasoning}`);
assert('fullText 只含正文（推理不混入）', end?.fullText === '正式答案', `实际: ${end?.fullText}`);

/* ══ C3-7/8：多轮回放端到端（真实 AgentLoop 驱动：收集→挂载→回放） ══ */

console.log('── C3-7/8 多轮回放端到端（agent-loop 收集→挂载→回放） ──');

const noopEvents = { subscribe: () => () => {}, on: () => () => {}, emit: () => {} };
const loop = new AgentLoopServiceImpl({
  llm: provider('auto'),
  tools: { getLLMTools: () => [], execute: async () => '[OK]', requiresPermission: () => false } as never,
  permission: { isAutoAllowed: () => true, grantAutoAllow: () => {} } as never,
  events: noopEvents as never,
});

const replayMsgs: LLMMessage[] = [{ role: 'user', content: '复杂任务' }];
const result = await loop.run(replayMsgs, undefined, { thinking: true });

// 第 2 轮请求体：必须原样回放第 1 轮的 thinking 块（含 signature、位于内容数组最前）
const reqMsgs = lastBody.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
const replayed = reqMsgs.find((m) => m.role === 'assistant' && Array.isArray(m.content) && m.content[0]?.type === 'thinking');
assert('回放：第 2 轮请求含 thinking 块', replayed !== undefined, JSON.stringify(lastBody.messages));
const rb = replayed?.content[0] as { thinking?: string; signature?: string } | undefined;
assert('回放：推理文本一字不差', rb?.thinking === '工具循环第一轮推理', `实际: ${rb?.thinking}`);
assert('回放：signature 原样携带', rb?.signature === 'SIG_ABC123', `实际: ${rb?.signature}`);
assert('回放：thinking 块在 tool_use 之前（还原产出顺序）',
  replayed !== undefined && replayed.content[1]?.type === 'tool_use', JSON.stringify(replayed?.content.map((b) => b.type)));
assert('精确安全阀：有块可回放时第 2 轮仍开 thinking',
  (lastBody.thinking as { type?: string })?.type === 'enabled', JSON.stringify(lastBody.thinking));
assert('循环正常收尾（finalText = 第 2 轮正文）', result.finalText === '最终答案', `实际: ${result.finalText}`);

// 挂载语义：工具轮挂块；最终答案轮直接 break，不落消息（消息数组里只有 1 条 assistant）
const assistants = replayMsgs.filter((m) => m.role === 'assistant');
const mounted = assistants[0]?.thinkingBlocks?.[0] as ThinkingBlock | undefined;
assert('挂载：工具轮 assistant 携带 thinkingBlocks（且最终答案轮不落消息）',
  assistants.length === 1 && mounted !== undefined,
  `assistants=${assistants.length}, blocks=${JSON.stringify(assistants[0]?.thinkingBlocks)}`);
assert('挂载：块内签名收集完整', mounted?.signature === 'SIG_ABC123');

// 精确安全阀（端到端侧）：带块历史不拦截——旧粗粒度阀（有 assistant 就关）此处会误关
await provider('auto').chat(
  [{ role: 'user', content: '上一轮' }, { role: 'assistant', content: '上一轮纯文本答复' }, { role: 'user', content: '新任务' }],
  undefined, { thinking: true });
assert('精确安全阀：纯文本历史不拦截开启', (lastBody.thinking as { type?: string })?.type === 'enabled');

server.close();
console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
// 延迟退出：等 server.close 完成，避免 Windows 上 close 未完成就 exit 触发 libuv 断言
setTimeout(() => process.exit(failed > 0 ? 1 : 0), 100);
