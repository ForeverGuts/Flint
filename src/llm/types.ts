/**
 * LLM Provider 抽象 —— 屏蔽不同 API 厂商的差异。
 * 调用方：runtime.ts（通过 LLMProvider 接口调用，不依赖具体实现）
 * 服务于：定义 LLM 调用的契约，后续可接入 Anthropic / Ollama / 自定义协议
 */

/** 单条对话消息 */
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** LLM Provider 配置（读取自 config/api.json） */
export interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * LLM Provider 接口。
 * 每种接入方式（DeepSeek / Anthropic / Ollama / 自定义）实现此接口。
 */
export interface LLMProvider {
  /** 发送消息列表，返回模型回复文本 */
  chat(messages: LLMMessage[]): Promise<string>;

  // TODO: 流式输出 stream(messages): AsyncIterable<string>
  // TODO: 模型列表获取 listModels(): Promise<string[]>
}
