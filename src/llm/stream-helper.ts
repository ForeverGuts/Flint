/**
 * 通用请求助手 —— 抽离 fetch 逻辑，避免 chat/stream 重复。
 * 调用方：DeepSeekProvider（OpenAI 兼容格式）
 * 服务于：统一 OpenAI 兼容格式的 HTTP 请求与流式解析，支持结构化工具调用（function calling）
 *
 * 工具调用：
 *   - 请求 body 增加 tools 数组（LLMTool[]），告知模型可用工具
 *   - 流式响应中，工具调用出现在 delta.tool_calls（与 delta.content 并行）
 *     function.arguments 是 JSON 字符串，会分片到达，需按 index 累积后 JSON.parse
 *   - 非流式响应中，工具调用出现在 message.tool_calls（结构化）
 */
import type { ChatResult, LLMConfig, LLMMessage, LLMStreamEvent, LLMTool, LLMToolCall } from './types.js';
import { EventStream } from '../runtime/event-stream.js';

/* ════════════════════════════════════════════════════════════════════════════
   通用 fetch 构造（非流式 + 流式共用）
     需要：config.baseUrl → API 地址
           config.apiKey  → 认证密钥
           config.model   → 模型名
           body           → 请求参数（messages, stream 等）
   过程：拼接 URL → 注入 Authorization header → 序列化 JSON body
   ════════════════════════════════════════════════════════════════════════════ */

function buildRequest(config: LLMConfig, body: Record<string, unknown>): RequestInit {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({ ...body, model: config.model }),
  };
}

/* ════════════════════════════════════════════════════════════════════════════
   非流式请求（chat）
     需要：config.baseUrl → API 地址
           messages       → 对话消息列表 [{role, content}, ...]
           tools          → 工具定义（可选，开启 function calling）
   返回：ChatResult { content, tool_calls }
   ════════════════════════════════════════════════════════════════════════════ */

export async function createChat(
  config: LLMConfig,
  messages: LLMMessage[],
  tools?: LLMTool[],
): Promise<ChatResult> {
  const body: Record<string, unknown> = { messages, stream: false, thinking: { type: 'disabled' } };
  if (tools && tools.length > 0) body.tools = tools;
  const res = await fetch(`${config.baseUrl}/chat/completions`, buildRequest(config, body));
  if (!res.ok) throw new Error(`API error: ${res.status} ${await res.text()}`);
  const data = await res.json() as {
    choices: Array<{ message: { content: string | null; tool_calls?: LLMToolCall[] } }>;
  };
  const message = data.choices[0]?.message;
  return {
    content: message?.content ?? '',
    ...(message?.tool_calls && message.tool_calls.length > 0
      ? { tool_calls: message.tool_calls }
      : {}),
  };
}

/* ════════════════════════════════════════════════════════════════════════════
   流式请求（stream）
     需要：config.baseUrl → API 地址
           messages       → 对话消息列表
           tools          → 工具定义（可选，开启 function calling）
           EventStream    → 推拉通道，生产者 push，消费者 for await...of
   过程：
     ① 发起 fetch + stream:true（告诉 API 我要流式）
     ② 获取 reader（ReadableStream，逐块读取 HTTP 响应体）
     ③ 粘包/半包处理（buffer 拼合 → 按行切分 → 完整行解析 → 半截放回）
     ④ 遍历完整行，解析 SSE data JSON：
        - delta.content → 推 token 事件（文本）
        - delta.tool_calls → 按 index 累积（arguments 分片拼接）
     ⑤ 流结束 → 若有累积的 tool_calls 推 tool_call 事件，再推 end 事件
   ════════════════════════════════════════════════════════════════════════════ */

/** OpenAI 兼容格式的流式 tool_calls 片段 */
interface StreamToolCallDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

export function createSSEStream(
  config: LLMConfig,
  messages: LLMMessage[],
  tools?: LLMTool[],
): EventStream<LLMStreamEvent> {
  const eventStream = new EventStream<LLMStreamEvent>(
    (event) => event.type === 'end',
    (event) => event as { type: 'end'; fullText: string },
  );

  (async () => {
    try {
      const body: Record<string, unknown> = { messages, stream: true, thinking: { type: 'disabled' } };
      if (tools && tools.length > 0) body.tools = tools;
      const res = await fetch(`${config.baseUrl}/chat/completions`, buildRequest(config, body));
      if (!res.ok) throw new Error(`API error: ${res.status} ${await res.text()}`);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let full = '';

      // ── 工具调用累积：按 index 分组，arguments 分片拼接 ──
      // 流式里一个工具调用的 name 只出现在第一片，arguments 是 JSON 字符串切成多片
      const toolCallAcc: Map<number, { id: string; name: string; args: string }> = new Map();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;
          if (!trimmed.startsWith('data: ')) continue;

          try {
            const json = JSON.parse(trimmed.slice(6)) as {
              choices?: Array<{ delta: { content?: string; tool_calls?: StreamToolCallDelta[] } }>;
            };
            const delta = json.choices?.[0]?.delta;

            // 文本 token
            if (delta?.content) {
              full += delta.content;
              eventStream.push({ type: 'token', text: delta.content });
            }

            // 结构化工具调用（分片）
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const acc = toolCallAcc.get(tc.index) ?? { id: '', name: '', args: '' };
                if (tc.id) acc.id = tc.id;
                if (tc.function?.name) acc.name += tc.function.name;
                if (tc.function?.arguments) acc.args += tc.function.arguments;
                toolCallAcc.set(tc.index, acc);
              }
            }
          } catch {
            // 跳过无法解析的 SSE 行
          }
        }
      }

      // 流结束：先推累积的工具调用（若有）
      if (toolCallAcc.size > 0) {
        const toolCalls: LLMToolCall[] = [...toolCallAcc.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([index, acc]) => ({
            id: acc.id || `call_${index}`,
            type: 'function' as const,
            function: { name: acc.name, arguments: acc.args || '{}' },
          }));
        eventStream.push({ type: 'tool_call', toolCalls });
      }
      eventStream.push({ type: 'end', fullText: full });
    } catch {
      eventStream.end();
    }
  })();

  return eventStream;
}
