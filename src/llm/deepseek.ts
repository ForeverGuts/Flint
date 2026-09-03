/**
 * DeepSeek API 接入实现（OpenAI 兼容格式）。
 * chat() 和 stream() 均委托给通用请求助手，支持结构化工具调用（function calling）。
 */
import type { ChatResult, LLMConfig, LLMMessage, LLMProvider, LLMRequestOptions, LLMStreamEvent, LLMTool } from './types.js';
import { EventStream } from '../runtime/event-stream.js';
import { createChat, createSSEStream } from './stream-helper.js';

export class DeepSeekProvider implements LLMProvider {
  constructor(private config: LLMConfig) {}

  chat(messages: LLMMessage[], tools?: LLMTool[], opts?: LLMRequestOptions): Promise<ChatResult> {
    return createChat(this.config, messages, tools, opts);
  }

  stream(messages: LLMMessage[], tools?: LLMTool[], opts?: LLMRequestOptions): EventStream<LLMStreamEvent> {
    return createSSEStream(this.config, messages, tools, opts);
  }
}
