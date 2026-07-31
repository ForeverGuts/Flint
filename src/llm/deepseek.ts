/**
 * DeepSeek API 接入实现（OpenAI 兼容格式）。
 * chat() 和 stream() 均委托给通用请求助手。
 */
import type { LLMConfig, LLMMessage, LLMProvider, LLMStreamEvent } from './types.js';
import { EventStream } from '../runtime/event-stream.js';
import { createChat, createSSEStream } from './stream-helper.js';

export class DeepSeekProvider implements LLMProvider {
  constructor(private config: LLMConfig) {}

  chat(messages: LLMMessage[]): Promise<string> {
    return createChat(this.config, messages);
  }

  stream(messages: LLMMessage[]): EventStream<LLMStreamEvent> {
    return createSSEStream(this.config, messages);
  }
}
