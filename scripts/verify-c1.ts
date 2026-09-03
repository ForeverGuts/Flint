/**
 * 阶段 C1 验证脚本 —— thinking 开关 + 思维链流解析（不消耗真实 API）。
 *
 * 方式：本地起假 OpenAI 兼容服务器（捕获请求体 + 回放预制 SSE/JSON），
 *       直接用 createSSEStream / createChat 打，断言请求参数与事件流行为。
 *
 * 覆盖：
 *   C1-1 thinking:'on'    → 请求体 thinking.type === 'enabled'
 *   C1-2 thinking:'off'   → 请求体 thinking.type === 'disabled'
 *   C1-3 thinking:'auto'  → C1 语义：Provider 侧按关闭处理（'disabled'）
 *   C1-4 thinking 缺省    → 'disabled'（向后兼容，原行为不变）
 *   C1-5 流式解析：reasoning_content → reasoning 事件（拼装正确），不进 fullText
 *   C1-6 非流式 chat：正文正确返回（reasoning_content 不污染 content）
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-c1.ts
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createChat, createSSEStream } from '../src/llm/stream-helper.js';
import type { LLMConfig } from '../src/llm/types.js';

/* ── 假服务器：记录最后一次请求体，按 stream 标志回放预制响应 ── */

let lastBody: Record<string, unknown> = {};

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    lastBody = JSON.parse(raw) as Record<string, unknown>;
    if (lastBody.stream === true) {
      // SSE：先推理两片，再正文两片（模拟 thinking 开启的真实流序）
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"reasoning_content":"先推理一，"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"reasoning_content":"再推理二。"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"正式"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"回复"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: '非流式回复', reasoning_content: '被忽略的推理' } }],
      }));
    }
  });
});

/* ── 断言 ── */

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`); }
}

function makeConfig(thinking?: LLMConfig['thinking'], baseUrl = ''): LLMConfig {
  return {
    baseUrl,
    apiKey: 'test-key',
    model: 'test-model',
    ...(thinking ? { thinking } : {}),
  };
}

async function collectStream(cfg: LLMConfig): Promise<{ reasoning: string; fullText: string }> {
  let reasoning = '';
  let fullText = '';
  const stream = createSSEStream(cfg, [{ role: 'user', content: '你好' }]);
  for await (const event of stream) {
    if (event.type === 'reasoning') reasoning += event.text;
    else if (event.type === 'end') fullText = event.fullText;
  }
  return { reasoning, fullText };
}

/* ── 主流程 ── */

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address() as AddressInfo;
const baseUrl = `http://127.0.0.1:${port}/v1`;

console.log('── C1 请求参数（thinking 开关三态 + 缺省） ──');

await collectStream(makeConfig('on', baseUrl));
assert('C1-1 thinking:on → enabled', (lastBody.thinking as { type: string })?.type === 'enabled',
  `实际: ${JSON.stringify(lastBody.thinking)}`);

await collectStream(makeConfig('off', baseUrl));
assert('C1-2 thinking:off → disabled', (lastBody.thinking as { type: string })?.type === 'disabled',
  `实际: ${JSON.stringify(lastBody.thinking)}`);

await collectStream(makeConfig('auto', baseUrl));
assert('C1-3 thinking:auto → C1 按关闭处理', (lastBody.thinking as { type: string })?.type === 'disabled',
  `实际: ${JSON.stringify(lastBody.thinking)}`);

await collectStream(makeConfig(undefined, baseUrl));
assert('C1-4 缺省 → disabled（向后兼容）', (lastBody.thinking as { type: string })?.type === 'disabled',
  `实际: ${JSON.stringify(lastBody.thinking)}`);

console.log('── C1 流式解析（reasoning 与正文分流） ──');

const { reasoning, fullText } = await collectStream(makeConfig('on', baseUrl));
assert('C1-5a reasoning 事件拼装正确', reasoning === '先推理一，再推理二。', `实际: "${reasoning}"`);
assert('C1-5b fullText 只含正文', fullText === '正式回复', `实际: "${fullText}"`);
assert('C1-5c 推理未混入 fullText', !fullText.includes('推理'), `实际: "${fullText}"`);

console.log('── C1 非流式 chat ──');

const chatResult = await createChat(makeConfig('off', baseUrl), [{ role: 'user', content: '你好' }]);
assert('C1-6 chat 正文正确（推理不污染）', chatResult.content === '非流式回复', `实际: "${chatResult.content}"`);

server.close();
console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
// 延迟退出：等 server.close 完成，避免 Windows 上 close 未完成就 exit 触发 libuv 断言
setTimeout(() => process.exit(failed > 0 ? 1 : 0), 100);
