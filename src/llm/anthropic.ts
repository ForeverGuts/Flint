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
import type { ChatResult, LLMConfig, LLMMessage, LLMProvider, LLMRequestOptions, LLMStreamEvent, LLMTool, LLMToolCall, LLMUsage, ThinkingBlock } from './types.js';
import { EventStream } from '../runtime/event-stream.js';
import { resolveThinkingEnabled } from './stream-helper.js';

/* ── 输出预算常量（thinking 约束：budget_tokens 必须严格小于 max_tokens） ── */
const ANTHROPIC_MAX_TOKENS = 4096;
const THINKING_BUDGET_TOKENS = 2048;

/**
 * 解析本次请求是否开启 extended thinking（阶段 C3 问题1：消费按次判定，不再静默丢弃）。
 * 优先级与 OpenAI 兼容路径同一函数（按次覆盖 > 配置）。
 * 安全阀（阶段 C3 问题3 精确化）：Anthropic 要求带 tool_use 的 assistant 轮回放 thinking 块（验 signature）。
 *   - 历史存在“带 tool_calls 但无 thinkingBlocks”的 assistant 消息 → 无法回放，强制关（防 400）；
 *   - run() 内的 assistant 消息已被挂载 thinkingBlocks → 可回放，正常开启；
 *   - 跨用户轮历史：thinking 开时 runtime.ts 只映射 role + content（承重丢弃），到达这里
 *     不带 tool_calls，无回放义务 → 不拦截。
 *
 * 第三条的成因常被说错：不是“会话存储不存结构化信息”（MessageEntry 有 tool_calls，
 * getMessages() 会还原、runtime.ts 落盘也会写入）。2026-09-12 起跨轮历史按 thinking 开关分叉
 * （方案 B）：开则纯文本（本阀的搭档），关则全量结构化回传——此时本阀第一分支也不会触发
 * （thinking 关，resolveThinkingEnabled 已先行放行 false）。本阀保留作兜底：任何漏网的
 * 无块结构化历史会被它拦下而不是 400。详见 Log/ARCHITECTURE.md 第四节第 9 条。
 */
function resolveAnthropicThinking(config: LLMConfig, opts: LLMRequestOptions | undefined, messages: LLMMessage[]): boolean {
  if (!resolveThinkingEnabled(config, opts)) return false;
  return messages.every((m) =>
    m.role !== 'assistant' || !m.tool_calls?.length || (m.thinkingBlocks?.length ?? 0) > 0,
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   Anthropic Messages API 类型定义
   ════════════════════════════════════════════════════════════════════════════ */

type AnthropicRole = 'user' | 'assistant';

interface AnthropicContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking';
  text?: string;
  /** extended thinking 块（阶段 C3 问题3）：推理文本 + Anthropic 签名，多轮需原样回放 */
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[];
  is_error?: boolean;
  /** 提示词缓存断点（Anthropic 手动声明，缓存"从开头到本块"的前缀） */
  cache_control?: { type: 'ephemeral' };
}

/** Anthropic 工具定义（与 OpenAI 的 {type,function} 格式不同：name + input_schema） */
interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** 缓存断点（在最后一个工具定义后设，工具列表稳定 → 缓存大块前缀） */
  cache_control?: { type: 'ephemeral' };
}

interface AnthropicMessage {
  role: AnthropicRole;
  content: string | AnthropicContentBlock[];
}

interface AnthropicRequest {
  model: string;
  system?: AnthropicContentBlock[];
  messages: AnthropicMessage[];
  max_tokens: number;
  stream?: boolean;
  tools?: AnthropicTool[];
  /** extended thinking（与 OpenAI 的 thinking:{type} 形状不同：必须带 budget_tokens 且 < max_tokens） */
  thinking?: { type: 'enabled'; budget_tokens: number };
}

interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicContentBlock[];
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null;
  stop_sequence: string | null;
  /**
   * 非流式响应的用量（字段缺省按没有处理——不伪报）。缓存明细的口径与流式
   * AnthropicStreamUsage 相同：真实计费输入 = input + cache_creation + cache_read。
   */
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/**
 * Anthropic 流式用量片段——分两处给：
 *   message_start 携 input（本次请求发了多少）
 *   message_delta 携 output（累计值，不是增量）
 *
 * 缓存字段必须算进输入：本项目在 system 分层与 tools 上都设了 cache_control 断点，
 * 命中时 input_tokens 会小到只剩个位数（它只统计"本次新读的非缓存部分"），
 * 只填它就等于伪报"这次几乎没发输入"——真实计费量是三者之和。
 * （缓存命中率的明细本层不单列：LLMUsage 只有三个槽，先把总量报对）
 */
interface AnthropicStreamUsage {
  input_tokens?: number;
  output_tokens?: number;
  /** 本次新建缓存块写进的输入 token */
  cache_creation_input_tokens?: number;
  /** 本次命中缓存复用的输入 token */
  cache_read_input_tokens?: number;
}

/* ════════════════════════════════════════════════════════════════════════════
   消息格式转换
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * 将内部 LLMMessage[] 转换为 Anthropic Messages API 格式。
 *
 * 转换规则：
 *   system → 提取到顶级 system 参数（多条分层消息逐条保留，稳定段设缓存断点）
 *   user   → 映射为 content block 数组；**上一条已是 user 时并入它**（同角色相邻归并）
 *   assistant → 直接映射，content 为文本/tool_use content block
 *   tool   → 转为 tool_result content block（连续 tool 结果合并进同一条 user 消息，
 *            role 设为 user，避免违反 Anthropic 的 user/assistant 交替约束）
 *
 * 关于「同角色相邻归并」：Anthropic 的 messages 要求 user/assistant 交替，而本层收到的
 * 内部序列可能带连续两条 user（来源：runtime 落盘的内层引导，会话历史里是 user,user,assistant）。
 * 官方 API 参考称「连续同角色轮会被服务端合并成一条」，但第三方有大量 roles-must-alternate
 * 的 400 报告，两种说法冲突且本机无法实测（见 Log/ARCHITECTURE.md 第四节第 11 条）。
 * 本地归并让线上形状在**两种世界里都合法**，且是幂等的：服务端本来会合并时它无害，
 * 服务端真的拒绝时它救命。归并放在适配器（而非 runtime 历史映射处）的理由见 DECISION_LOG。
 */
function toAnthropicMessages(msgs: LLMMessage[]): {
  system?: AnthropicContentBlock[];
  messages: AnthropicMessage[];
} {
  const systemParts: string[] = [];
  const messages: AnthropicMessage[] = [];

  for (const msg of msgs) {
    switch (msg.role) {
      case 'system':
        // system 在 Anthropic 中是顶级参数：分层消息逐条收集（不再互相覆盖）
        systemParts.push(msg.content);
        break;

      case 'user': {
        // 同角色相邻归并（与下面 tool 分支同一手法）：上一条已是 user 就把文本块并进去，
        // 而不是再 push 一条 —— 改前这里是无条件 push，是架构债第 11 条点名的那个洞。
        // 触发场景：内层引导落盘后，会话历史里出现 user,user,assistant（runtime.ts 负责写）。
        const block: AnthropicContentBlock = { type: 'text', text: msg.content };
        const prev = messages[messages.length - 1];
        if (prev && prev.role === 'user' && Array.isArray(prev.content)) {
          prev.content.push(block);
        } else {
          messages.push({ role: 'user', content: [block] });
        }
        break;
      }

      case 'assistant': {
        // 解析 tool_calls 或纯文本
        const content: AnthropicContentBlock[] = [];
        // 阶段 C3 问题3：原样回放本轮 thinking 块（置于 text/tool_use 之前，与产出顺序一致；一字不改否则验签失败）
        if (msg.thinkingBlocks && msg.thinkingBlocks.length > 0) {
          for (const tb of msg.thinkingBlocks) {
            content.push({ type: 'thinking', thinking: tb.thinking, signature: tb.signature });
          }
        }
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
        const block: AnthropicContentBlock = {
          type: 'tool_result',
          tool_use_id: msg.tool_call_id ?? '',
          content: msg.content,
          // agent-loop 失败/被拒绝消息以 `[工具 xxx` 开头（正常结果以 `[OK]` 等状态码开头）
          is_error: msg.content.startsWith('[工具'),
        };
        // 连续 tool 结果合并进同一条 user 消息（Anthropic 要求 user/assistant 交替）
        const last = messages[messages.length - 1];
        if (last && last.role === 'user' && Array.isArray(last.content) && last.content[last.content.length - 1]?.type === 'tool_result') {
          (last.content as AnthropicContentBlock[]).push(block);
        } else {
          messages.push({ role: 'user', content: [block] });
        }
        break;
      }
    }
  }

  // system 段设缓存断点：稳定层（core/tools/skills）各一个，最后一段（通常是最新摘要，属变化区）不设
  const system: AnthropicContentBlock[] = systemParts.map((text, i) => ({
    type: 'text',
    text,
    ...(i < systemParts.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
  }));

  return { ...(systemParts.length > 0 ? { system } : {}), messages };
}

/**
 * 将内部 LLMTool[]（OpenAI 格式 {type,function}）转换为 Anthropic tools 参数格式（name + input_schema），
 * 并在最后一个工具定义后设缓存断点（工具列表稳定 → 缓存整块工具前缀）。
 */
function toAnthropicTools(tools: LLMTool[]): AnthropicTool[] {
  return tools.map((t, i) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters as Record<string, unknown>,
    ...(i === tools.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
  }));
}

/**
 * Anthropic 非流式用量 → 内部 LLMUsage。
 * 缓存写入与命中都要加回输入（同流式口径，缺了就严重少报）；total 缺则自加。
 */
function anthropicUsageToLLM(u: NonNullable<AnthropicResponse['usage']>): LLMUsage {
  const promptTokens = (u.input_tokens ?? 0)
    + (u.cache_creation_input_tokens ?? 0)
    + (u.cache_read_input_tokens ?? 0);
  const completionTokens = u.output_tokens ?? 0;
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
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
    ...(response.usage ? { usage: anthropicUsageToLLM(response.usage) } : {}),
  };
}

/* ════════════════════════════════════════════════════════════════════════════
   AnthropicAdapter
   ════════════════════════════════════════════════════════════════════════════ */

export class AnthropicProvider implements LLMProvider {
  constructor(private config: LLMConfig) {}

  /* ── 非流式调用 ── */

  async chat(messages: LLMMessage[], tools?: LLMTool[], opts?: LLMRequestOptions): Promise<ChatResult> {
    const { system, messages: anthropicMsgs } = toAnthropicMessages(messages);

    const body: AnthropicRequest = {
      model: this.config.model,
      messages: anthropicMsgs,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      stream: false,
    };
    if (resolveAnthropicThinking(this.config, opts, messages)) {
      body.thinking = { type: 'enabled', budget_tokens: THINKING_BUDGET_TOKENS };
    }
    if (tools && tools.length > 0) body.tools = toAnthropicTools(tools);
    if (system && system.length > 0) body.system = system;

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

  stream(messages: LLMMessage[], tools?: LLMTool[], opts?: LLMRequestOptions): EventStream<LLMStreamEvent> {
    const eventStream = new EventStream<LLMStreamEvent>(
      (event) => event.type === 'end',
      (event) => event as { type: 'end'; fullText: string },
    );

    (async () => {
      try {
        const { system, messages: anthropicMsgs } = toAnthropicMessages(messages);

        const body: AnthropicRequest = {
          model: this.config.model,
          messages: anthropicMsgs,
          max_tokens: ANTHROPIC_MAX_TOKENS,
          stream: true,
        };
        if (resolveAnthropicThinking(this.config, opts, messages)) {
          body.thinking = { type: 'enabled', budget_tokens: THINKING_BUDGET_TOKENS };
        }
        if (tools && tools.length > 0) body.tools = toAnthropicTools(tools);
        if (system && system.length > 0) body.system = system;

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
        /** 用量累积器：两个事件分别填，都没见到则保持 sawUsage=false（上层报 null） */
        let promptTokens = 0;
        let completionTokens = 0;
        let sawUsage = false;

        // ── 工具调用累积（Anthropic 流式 tool_use） ──
        // content_block_start 携带 tool_use 的 id/name，input 通过 input_json_delta 分片累积
        const toolBlocks: Map<number, { id: string; name: string; input: string }> = new Map();
        // ── thinking 块收集（阶段 C3 问题1 展示 / 问题3 回放） ──
        // reasoning 分片（thinking_delta）推展示事件不进 full（展示不持久）；同时按块累积，
        // 连同 signature_delta 的签名在 content_block_stop 时拼装完整块 → 推 thinking_block 事件供回放
        const thinkingBlocks: Map<number, { thinking: string; signature: string }> = new Map();

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
                delta?: { text?: string; partial_json?: string; thinking?: string; signature?: string };
                content_block?: {
                  type?: string;
                  text?: string;
                  id?: string;
                  name?: string;
                };
                /** message_start 携：本次请求的输入用量（含缓存明细） */
                message?: { usage?: AnthropicStreamUsage };
                /** message_delta 携：累计输出用量 */
                usage?: AnthropicStreamUsage;
              };

              // 用量·输入（message_start）：缓存写入与命中都要加回来，否则严重少报
              if (data.type === 'message_start' && data.message?.usage) {
                const u = data.message.usage;
                promptTokens = (u.input_tokens ?? 0)
                  + (u.cache_creation_input_tokens ?? 0)
                  + (u.cache_read_input_tokens ?? 0);
                completionTokens = u.output_tokens ?? 0;
                sawUsage = true;
              }

              // 用量·输出（message_delta）：给的是累计值，直接覆盖不累加
              if (data.type === 'message_delta' && data.usage) {
                completionTokens = data.usage.output_tokens ?? completionTokens;
                sawUsage = true;
              }

              // thinking 块开始：初始化按块累积器（推理分片将走 reasoning 通道，不进正文）
              if (data.type === 'content_block_start' && data.content_block?.type === 'thinking') {
                thinkingBlocks.set(data.index ?? thinkingBlocks.size, { thinking: '', signature: '' });
              }

              // 推理增量：推展示事件 + 累积入块（展示不持久只针对 full/历史，累积是回放用的协议数据）
              if (data.type === 'content_block_delta' && data.delta?.thinking) {
                const acc = thinkingBlocks.get(data.index ?? -1);
                if (acc) acc.thinking += data.delta.thinking;
                eventStream.push({ type: 'reasoning', text: data.delta.thinking });
                continue;
              }

              // 签名增量：Anthropic 对块的防篡改章，回放必备（阶段 C3 问题3）
              if (data.type === 'content_block_delta' && data.delta?.signature) {
                const acc = thinkingBlocks.get(data.index ?? -1);
                if (acc) acc.signature += data.delta.signature;
                continue;
              }

              // thinking 块结束：拼装完整块 → 推 thinking_block 事件（Agent Loop 挂到本轮 assistant 消息，供下一轮回放）
              if (data.type === 'content_block_stop') {
                const idx = data.index ?? -1;
                const acc = thinkingBlocks.get(idx);
                if (acc) {
                  thinkingBlocks.delete(idx);
                  const block: ThinkingBlock = { type: 'thinking', thinking: acc.thinking, signature: acc.signature };
                  eventStream.push({ type: 'thinking_block', block });
                }
              }

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
        // Anthropic 不给 total，自加；一个用量事件都没见到则不填（不伪报 0）
        const usage: LLMUsage | undefined = sawUsage
          ? { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens }
          : undefined;
        eventStream.push({ type: 'end', fullText: full, ...(usage ? { usage } : {}) });
      } catch (err) {
        // 流异常不吞：暴露真实错误（否则上层只看到空流，无法定位）
        console.error('[AnthropicStream] 流异常:', err);
        eventStream.end();
      }
    })();

    return eventStream;
  }
}
