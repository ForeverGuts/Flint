/**
 * LLM 模块入口 —— Provider 创建工厂。
 * 调用方：runtime.ts
 * 服务于：根据配置创建对应 Provider 实例
 */
import type { LLMConfig, LLMProvider } from './types.js';
import { DeepSeekProvider } from './deepseek.js';

export type { LLMConfig, LLMMessage, LLMProvider } from './types.js';

/**
 * 根据配置创建 LLM Provider。
 * 后续添加新接入方式时在此扩展（Anthropic / Ollama 等）。
 */
export function createProvider(config: LLMConfig): LLMProvider {
  // TODO: 根据 config.provider 字段路由到不同实现
  //   switch (config.provider) {
  //     case 'anthropic' → return new AnthropicProvider(config)
  //     case 'ollama'    → return new OllamaProvider(config)
  //   }
  return new DeepSeekProvider(config);
}
