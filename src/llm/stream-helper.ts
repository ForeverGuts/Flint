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
import type { ChatResult, LLMConfig, LLMMessage, LLMRequestOptions, LLMStreamEvent, LLMTool, LLMToolCall, LLMUsage } from './types.js';
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
   thinking 开关解析（思维链强化·阶段 C1/C2）
     优先级：按次覆盖（opts.thinking，Runtime 的 auto 判定结果） > 配置（config.thinking）
     配置侧：'on' → 开启；'off'/'auto'/缺省 → 关闭（'auto' 由 Runtime 判定后按次下发）
   ════════════════════════════════════════════════════════════════════════════ */

export function resolveThinkingEnabled(config: LLMConfig, opts?: LLMRequestOptions): boolean {
  return opts?.thinking ?? config.thinking === 'on';
}

/* ════════════════════════════════════════════════════════════════════════════
   流式用量索取（stream_options.include_usage）
     OpenAI 兼容端默认不在流式响应里给用量，必须显式索取：带上该参数后，
     API 会在 data: [DONE] 之前追加一个 choices=[] 的 chunk 专门携带 usage。
     兼容风险：严格校验未知字段的代理端会直接 400——为了一个统计参数把用户的
     对话搞挂不值得，所以首次撞上就在本进程内永久关掉，并在同一次调用里
     静默重试（用户看不到失败，只是 usage 继续为 null）。
   ════════════════════════════════════════════════════════════════════════════ */

/** 本进程内是否还尝试索取流式用量（撞上不兼容端点后永久关闭，不再白跑一趟） */
let streamUsageSupported = true;

/** OpenAI 兼容用量 → 内部 LLMUsage（缺字段按 0；total 缺则自加） */
function toLLMUsage(u: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }): LLMUsage {
  const promptTokens = u.prompt_tokens ?? 0;
  const completionTokens = u.completion_tokens ?? 0;
  return { promptTokens, completionTokens, totalTokens: u.total_tokens ?? promptTokens + completionTokens };
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
  opts?: LLMRequestOptions,
): Promise<ChatResult> {
  const body: Record<string, unknown> = {
    messages, stream: false,
    thinking: { type: resolveThinkingEnabled(config, opts) ? 'enabled' : 'disabled' },
  };
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
  opts?: LLMRequestOptions,
): EventStream<LLMStreamEvent> {
  const eventStream = new EventStream<LLMStreamEvent>(
    (event) => event.type === 'end',
    (event) => event as { type: 'end'; fullText: string },
  );

  (async () => {
    try {
      const body: Record<string, unknown> = {
        messages, stream: true,
        thinking: { type: resolveThinkingEnabled(config, opts) ? 'enabled' : 'disabled' },
      };
      if (tools && tools.length > 0) body.tools = tools;
      const url = `${config.baseUrl}/chat/completions`;

      // 索取用量：不兼容的端点会 400，此时关掉开关并原地重试一次（不带 stream_options）
      let res: Response;
      if (streamUsageSupported) {
        res = await fetch(url, buildRequest(config, { ...body, stream_options: { include_usage: true } }));
        if (!res.ok && res.status === 400) {
          const detail = await res.text();
          if (!/stream_options/i.test(detail)) throw new Error(`API error: 400 ${detail}`);
          streamUsageSupported = false;
          res = await fetch(url, buildRequest(config, body));
        }
      } else {
        res = await fetch(url, buildRequest(config, body));
      }
      if (!res.ok) throw new Error(`API error: ${res.status} ${await res.text()}`);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let full = '';
      /** API 报的真实用量（未索取到则保持 undefined，上层报 null 而不伪报 0） */
      let usage: LLMUsage | undefined;

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
              choices?: Array<{ delta: { content?: string; reasoning_content?: string; tool_calls?: StreamToolCallDelta[] } }>;
              /** include_usage 索取到的用量（末尾那个 choices=[] 的 chunk 专带） */
              usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
            };
            const delta = json.choices?.[0]?.delta;

            // 用量 chunk：choices 为空、只有 usage（记下随 end 事件交出）
            if (json.usage) usage = toLLMUsage(json.usage);

            // 思维链推理片段（thinking 开启时先于正文到达）：只推展示事件，
            // 不进 full —— finalText/会话历史/兜底回溯只拿正式答案（展示不持久）
            if (delta?.reasoning_content) {
              eventStream.push({ type: 'reasoning', text: delta.reasoning_content });
            }

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
      eventStream.push({ type: 'end', fullText: full, ...(usage ? { usage } : {}) });
    } catch (err) {
      // 流异常不吞：暴露真实错误（否则上层只看到空流，无法定位）
      console.error('[SSEStream] 流异常:', err);
      eventStream.end();
    }
  })();

  return eventStream;
}
