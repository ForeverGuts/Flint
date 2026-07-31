/**
 * LLM 模块入口 —— Provider 创建工厂。
 * 调用方：runtime.ts
 * 服务于：根据配置中的 provider 字段路由到对应的 Provider 实现
 */
import type { LLMConfig, LLMProvider } from './types.js';
import { DeepSeekProvider } from './deepseek.js';
import { AnthropicProvider } from './anthropic.js';

export type { LLMConfig, LLMMessage, LLMProvider } from './types.js';

/**
 * 根据配置创建 LLM Provider。
 * 通过 config.provider 字段路由到不同实现。
 *
 *    provider 值   | 实现               | API 格式
 *    ──────────────|─────────────────────|────────────────────
 *    deepseek      | DeepSeekProvider    | OpenAI Chat Completions
 *    openai        | DeepSeekProvider    | OpenAI Chat Completions
 *    anthropic     | AnthropicProvider   | Anthropic Messages API
 *    opencode-go   | DeepSeekProvider    | OpenAI Chat Completions（自定义 baseUrl）
 *    (默认/无)     | DeepSeekProvider    | OpenAI Chat Completions（向后兼容）
 */
export function createProvider(config: LLMConfig): LLMProvider {
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicProvider(config);
    case 'opencode-go':
      // OpenCode Go 使用 OpenAI Chat Completions 格式，复用 DeepSeekProvider
    case 'openai':
    case 'deepseek':
      return new DeepSeekProvider(config);
    default:
      return new DeepSeekProvider(config);
  }
}
