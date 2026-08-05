/**
 * Anthropic API 适配器 —— 将 Anthropic Messages API 格式转换为内部调用。
 * 调用方：runtime.ts（通过 LLMProvider 接口调用）
 * 服务于：使 `config.provider = "anthropic"` 时能正常调用 Anthropic API
 *
 * 设计说明：
 *   内部格式 LLMMessage 与 Anthropic Messages API 的对应关系：
 *
 *   LLMMessage          →   Anthropic API
 *   ─────────────────────────────────────
 *   { role: "system" }  →   system 参数（顶级字段）
 *   { role: "user" }    →   { role: "user", content: [...] }
 *   { role: "assistant" }→  { role: "assistant", content: [...] }
 *   { role: "tool" }    →   { role: "user", content: [tool_result块] }
 *
 *   注意事项：
 *   - Anthropic 的 system prompt 是顶级参数，不是 messages 数组的一部分
 *   - Tool Call 在 Anthropic 中是 content 内的 tool_use/tool_result 块，
 *     而非 OpenAI 的 tool_calls 顶级字段
 *   - 流式 SSE 格式不同：Anthropic 用 event: 行前缀，OpenAI 用 data: 行前缀
 */
import type { ChatResult, LLMConfig, LLMMessage, LLMProvider, LLMStreamEvent, LLMTool, LLMToolCall } from './types.js';
import { EventStream } from '../runtime/event-stream.js';

/* ════════════════════════════════════════════════════════════════════════════
   Anthropic Messages API 类型定义
   ════════════════════════════════════════════════════════════════════════════ */

type AnthropicRole = 'user' | 'assistant';

interface AnthropicContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[];
  is_error?: boolean;
}

interface AnthropicMessage {
  role: AnthropicRole;
  content: string | AnthropicContentBlock[];
}

interface AnthropicRequest {
  model: string;
  system?: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  stream?: boolean;
}

interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicContentBlock[];
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

/* ════════════════════════════════════════════════════════════════════════════
   消息格式转换
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * 将内部 LLMMessage[] 转换为 Anthropic Messages API 格式。
 *
 * 转换规则：
 *   system → 提取到顶级 system 参数，不出现在 messages 数组中
 *   user   → 直接映射，content 包装为 content block 数组
 *   assistant → 直接映射，content 为文本字符串（简化处理）
 *   tool   → 转为 tool_result content block，role 设为 user
 */
function toAnthropicMessages(msgs: LLMMessage[]): {
  system?: string;
  messages: AnthropicMessage[];
} {
  let systemPrompt: string | undefined;
  const messages: AnthropicMessage[] = [];

  for (const msg of msgs) {
    switch (msg.role) {
      case 'system':
        // system 在 Anthropic 中是顶级参数
        systemPrompt = msg.content;
        break;

      case 'user':
        messages.push({
          role: 'user',
          content: [{ type: 'text', text: msg.content }],
        });
        break;

      case 'assistant': {
        // 解析 tool_calls 或纯文本
        const content: AnthropicContentBlock[] = [];
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          // 如果有工具调用，文本和 tool_use 平行放在 content 里
          if (msg.content) {
            content.push({ type: 'text', text: msg.content });
          }
          for (const tc of msg.tool_calls) {
            content.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input: JSON.parse(tc.function.arguments),
            });
          }
        } else {
          content.push({ type: 'text', text: msg.content });
        }
        messages.push({ role: 'assistant', content });
        break;
      }

      case 'tool': {
        // tool 结果 → tool_result content block
        messages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: msg.tool_call_id ?? '',
              content: msg.content,
              is_error: false,
            },
          ],
        });
        break;
      }
    }
  }

  return { ...(systemPrompt ? { system: systemPrompt } : {}), messages };
}

/**
 * 从 Anthropic 响应 content 块解析出 ChatResult（文本 + tool_use 块转 LLMToolCall[]）。
 * Anthropic 的工具调用是 content 里的 tool_use 块（OpenAI 是顶级 tool_calls 字段）。
 */
function extractChatResult(response: AnthropicResponse): ChatResult {
  let content = '';
  const toolCalls: LLMToolCall[] = [];
  for (const block of response.content) {
    if (block.type === 'text' && block.text) {
      content += block.text;
    } else if (block.type === 'tool_use' && block.id && block.name) {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }
  return {
    content,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

/* ════════════════════════════════════════════════════════════════════════════
   AnthropicAdapter
   ════════════════════════════════════════════════════════════════════════════ */

export class AnthropicProvider implements LLMProvider {
  constructor(private config: LLMConfig) {}

  /* ── 非流式调用 ── */

  async chat(messages: LLMMessage[], tools?: LLMTool[]): Promise<ChatResult> {
    const { system, messages: anthropicMsgs } = toAnthropicMessages(messages);

    const body: AnthropicRequest & { tools?: LLMTool[] } = {
      model: this.config.model,
      messages: anthropicMsgs,
      max_tokens: 4096,
      stream: false,
    };
    if (tools && tools.length > 0) body.tools = tools;
    if (system) body.system = system;

    const res = await fetch(`${this.config.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as AnthropicResponse;
    return extractChatResult(data);
  }

  /* ── 流式调用 ── */

  stream(messages: LLMMessage[], tools?: LLMTool[]): EventStream<LLMStreamEvent> {
    const eventStream = new EventStream<LLMStreamEvent>(
      (event) => event.type === 'end',
      (event) => event as { type: 'end'; fullText: string },
    );

    (async () => {
      try {
        const { system, messages: anthropicMsgs } = toAnthropicMessages(messages);

        const body: AnthropicRequest & { tools?: LLMTool[] } = {
          model: this.config.model,
          messages: anthropicMsgs,
          max_tokens: 4096,
          stream: true,
        };
        if (tools && tools.length > 0) body.tools = tools;
        if (system) body.system = system;

        const res = await fetch(`${this.config.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.config.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
        }

        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let full = '';

        // ── 工具调用累积（Anthropic 流式 tool_use） ──
        // content_block_start 携带 tool_use 的 id/name，input 通过 input_json_delta 分片累积
        const toolBlocks: Map<number, { id: string; name: string; input: string }> = new Map();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            // Anthropic SSE 格式：event: type\ndata: {...}\n\n
            // 取 data: 行的 JSON
            if (trimmed.startsWith('event: ')) continue;
            if (!trimmed.startsWith('data: ')) continue;

            try {
              const data = JSON.parse(trimmed.slice(6)) as {
                type?: string;
                index?: number;
                delta?: { text?: string; partial_json?: string };
                content_block?: {
                  type?: string;
                  text?: string;
                  id?: string;
                  name?: string;
                };
              };

              // 文本增量
              if (data.type === 'content_block_delta' && data.delta?.text) {
                const text = data.delta.text;
                full += text;
                eventStream.push({ type: 'token', text });
              }

              // tool_use 块开始：记录 id + name
              if (data.type === 'content_block_start' && data.content_block?.type === 'tool_use') {
                toolBlocks.set(data.index ?? toolBlocks.size, {
                  id: data.content_block.id ?? '',
                  name: data.content_block.name ?? '',
                  input: '',
                });
              }

              // tool_use 的 input 分片累积
              if (data.type === 'content_block_delta' && data.delta?.partial_json !== undefined) {
                const block = toolBlocks.get(data.index ?? -1);
                if (block) {
                  block.input += data.delta.partial_json;
                }
              }
            } catch {
              // 跳过解析失败的行
            }
          }
        }

        // 流结束：先推累积的工具调用（若有）
        if (toolBlocks.size > 0) {
          const toolCalls: LLMToolCall[] = [...toolBlocks.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, b]) => ({
              id: b.id,
              type: 'function' as const,
              function: { name: b.name, arguments: b.input || '{}' },
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
}
