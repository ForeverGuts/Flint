/**
 * LLM Provider 抽象 —— 屏蔽不同 API 厂商的差异。
 * 调用方：runtime.ts（通过 LLMProvider 接口调用，不依赖具体实现）
 * 服务于：定义 LLM 调用的契约，后续可接入 Anthropic / Ollama / 自定义协议
 */

/** 单条对话消息 */
export interface LLMMessage {
  /** 消息角色：系统 / 用户 / 助手 / 工具结果 */
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** 消息文本内容 */
  content: string;
  /** 工具调用信息（仅 assistant 角色携带） */
  tool_calls?: LLMToolCall[];
  /** 工具调用结果名称（仅 tool 角色携带） */
  name?: string;
  /** 工具调用结果 ID（仅 tool 角色携带） */
  tool_call_id?: string;
}

/** Tool Calling 工具定义（LLM 可见） */
export interface LLMTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** LLM 返回的工具调用 */
export interface LLMToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** LLM Provider 配置（读取自 config/active-config.json，当前激活配置） */
export interface LLMConfig {
  /** 厂商标识：deepseek / openai / anthropic / ollama */
  provider?: string;
  /** API 地址（如 https://api.deepseek.com） */
  baseUrl: string;
  /** API 密钥 */
  apiKey: string;
  /** 模型名（如 deepseek-v4-flash） */
  model: string;
}

/** Token 用量统计（来自 API 响应） */
export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** LLM 事件流中的事件类型 */
export type LLMStreamEvent =
  | { type: 'token'; text: string }
  | { type: 'end'; fullText: string; usage?: LLMUsage };

/**
 * LLM Provider 接口。
 * 每种接入方式（DeepSeek / Anthropic / Ollama / 自定义）实现此接口。
 */
export interface LLMProvider {
  /** 发送消息列表，返回完整回复文本（非流式，可带工具定义） */
  chat(messages: LLMMessage[], tools?: LLMTool[]): Promise<string>;

  /** 流式调用，返回 EventStream 推拉通道 */
  stream(messages: LLMMessage[], tools?: LLMTool[]): import('../runtime/event-stream.js').EventStream<LLMStreamEvent>;
}
