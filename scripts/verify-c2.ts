/**
 * 阶段 C2 验证脚本 —— thinking auto 判定下发 + 全勾选清理（不消耗真实 API）。
 *
 * 覆盖：
 *   C2-1 Agent Loop 把 opts.thinking 按次传给 llm.stream（判定结果能下发）
 *   C2-2 stream-helper 覆盖优先级：opts.thinking > config.thinking（auto+覆盖开 / on+覆盖关）
 *   C2-3 hasUncheckedTask 检测：未勾选/全勾选/星号/缩进/[>]进行中变体
 *   （原 C2-4「loadTaskMemory 全勾选即删」已随 C 方案迁进 TaskStore —— 见 verify-todo.ts ④段）
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-c2.ts
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSSEStream } from '../src/llm/stream-helper.js';
import type { LLMConfig, LLMMessage, LLMProvider, LLMRequestOptions, LLMStreamEvent, LLMTool, ChatResult } from '../src/llm/types.js';
import { EventStream } from '../src/runtime/event-stream.js';
import { AgentLoopServiceImpl } from '../src/loop/agent-loop.js';
import { hasUncheckedTask } from '../src/context/system-prompt.js';

/* ── 断言 ── */

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`); }
}

/* ══ C2-1/C2-2：假 SSE 服务器（捕获请求体） ══ */

let lastBody: Record<string, unknown> = {};
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    lastBody = JSON.parse(raw) as Record<string, unknown>;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address() as AddressInfo;
const baseUrl = `http://127.0.0.1:${port}/v1`;

function cfg(thinking?: LLMConfig['thinking']): LLMConfig {
  return { baseUrl, apiKey: 'k', model: 'm', ...(thinking ? { thinking } : {}) };
}
async function drain(cfg: LLMConfig, opts?: LLMRequestOptions): Promise<void> {
  for await (const _e of createSSEStream(cfg, [{ role: 'user', content: 'hi' }], undefined, opts)) { /* 消费完 */ }
}

console.log('── C2-2 按次覆盖优先级（opts.thinking > config.thinking） ──');

await drain(cfg('auto'), { thinking: true });
assert('auto + 覆盖开 → enabled（Runtime 判定下发生效）',
  (lastBody.thinking as { type: string })?.type === 'enabled', JSON.stringify(lastBody.thinking));

await drain(cfg('on'), { thinking: false });
assert('on + 覆盖关 → disabled（覆盖优先于配置）',
  (lastBody.thinking as { type: string })?.type === 'disabled', JSON.stringify(lastBody.thinking));

await drain(cfg('auto'));
assert('auto 无覆盖 → disabled（无任务时的 auto 语义）',
  (lastBody.thinking as { type: string })?.type === 'disabled', JSON.stringify(lastBody.thinking));

/* ══ C2-1：Agent Loop 透传 opts.thinking ══ */

console.log('── C2-1 Agent Loop 判定结果下发到 llm.stream ──');

/** 假 LLM：记录收到的 opts，返回无工具调用的纯文本流（一轮即止） */
class FakeLLM implements LLMProvider {
  received: LLMRequestOptions | undefined;
  async chat(): Promise<ChatResult> { return { content: '' }; }
  stream(_m: LLMMessage[], _t?: LLMTool[], opts?: LLMRequestOptions): EventStream<LLMStreamEvent> {
    this.received = opts;
    const es = new EventStream<LLMStreamEvent>(
      (e) => e.type === 'end',
      (e) => e as { type: 'end'; fullText: string },
    );
    queueMicrotask(() => {
      es.push({ type: 'token', text: '答复' });
      es.push({ type: 'end', fullText: '答复' });
    });
    return es;
  }
}
const noTool = {
  getLLMTools: () => [] as LLMTool[],
  execute: async () => '[OK]',
  requiresPermission: () => false,
};
const noopEvents = { subscribe: () => () => {}, on: () => () => {}, emit: () => {} };

const fakeLlm = new FakeLLM();
const loop = new AgentLoopServiceImpl({
  llm: fakeLlm,
  tools: noTool as never,
  permission: { isAutoAllowed: () => true, grantAutoAllow: () => {} } as never,
  events: noopEvents as never,
});

await loop.run([{ role: 'user', content: '任务' }], undefined, { thinking: true });
assert('opts.thinking=true 透传到 llm.stream', fakeLlm.received?.thinking === true,
  `实际: ${JSON.stringify(fakeLlm.received)}`);

await loop.run([{ role: 'user', content: '闲聊' }]);
assert('缺省不下发（跟配置走，向后兼容）', fakeLlm.received?.thinking === undefined,
  `实际: ${JSON.stringify(fakeLlm.received)}`);

/* ══ C2-3：hasUncheckedTask 检测标准 ══ */

console.log('── C2-3 复选框检测（提示词层与工程侧共享） ──');

assert('未勾选 → true', hasUncheckedTask('目标\n- [ ] 步骤一') === true);
assert('全勾选 → false', hasUncheckedTask('- [x] 步骤一\n- [x] 步骤二') === false);
assert('星号变体 * [ ] → true', hasUncheckedTask('* [ ] 步骤') === true);
assert('缩进变体 → true', hasUncheckedTask('  - [ ] 步骤') === true);
assert('无复选框内容 → false', hasUncheckedTask('纯文本没有清单') === false);

/* ══ C2-4：[>] 进行中也算未完成 ══
   （C 方案后 TaskStore 渲染的清单用 [>] 表示进行中；hasUncheckedTask 必须认它，
    否则 system-prompt 的续传提示会在"只剩进行中项"时静默不出现） */

console.log('── C2-4 hasUncheckedTask 认 [>]（进行中） ──');

assert('[>] 进行中 → true', hasUncheckedTask('- [>] 步骤') === true);
assert('混合：有 [>] 且有 [x] → true', hasUncheckedTask('- [x] done\n- [>] doing') === true);
assert('全 [x] → false', hasUncheckedTask('- [x] a\n- [x] b') === false);
assert('空文本 → false', hasUncheckedTask('') === false);

server.close();
console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
// 延迟退出：等 server.close 完成，避免 Windows 上 close 未完成就 exit 触发 libuv 断言
setTimeout(() => process.exit(failed > 0 ? 1 : 0), 100);
