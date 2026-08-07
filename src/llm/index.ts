/**
 * LLM 模块入口 —— Provider 创建工厂。
 * 调用方：runtime.ts、config/manager.ts、commands/model.ts
 * 服务于：按协议类型创建 LLM Provider（两种协议：OpenAI 兼容 / Anthropic）
 */
import type { LLMConfig, LLMProvider } from './types.js';
import { DeepSeekProvider } from './deepseek.js';
import { AnthropicProvider } from './anthropic.js';

export type { LLMConfig, LLMMessage, LLMProvider } from './types.js';
export type { Provider, ProviderModel, ProviderConfigJson, ProviderDeps } from './provider.js';

/**
 * 根据配置创建 LLM Provider（按协议类型路由）。
 *
 *    type 值      | 实现               | API 格式
 *    ─────────────|─────────────────────|────────────────────
 *    anthropic    | AnthropicProvider   | Anthropic Messages API
 *    (其他)       | DeepSeekProvider    | OpenAI Chat Completions（兼容 deepseek/openai/opencode-go/自定义）
 */
export function createProvider(config: LLMConfig): LLMProvider {
  return config.provider === 'anthropic'
    ? new AnthropicProvider(config)
    : new DeepSeekProvider(config);
}
