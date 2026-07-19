/**
 * DeepSeek API 接入实现（OpenAI 兼容格式）。
 * 调用方：llm/index.ts（通过 createProvider 工厂函数创建）
 * 服务于：提供 LLMProvider 的 DeepSeek 实现
 */
import type { LLMConfig, LLMMessage, LLMProvider } from './types.js';

export class DeepSeekProvider implements LLMProvider {
  constructor(private config: LLMConfig) {}

  async chat(messages: LLMMessage[]): Promise<string> {
    const res = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
      }),
    });

    if (!res.ok) {
      throw new Error(`DeepSeek API error: ${res.status} ${await res.text()}`);
    }

    const data = await res.json() as {
      choices: Array<{ message: { content: string } }>;
    };
    return data.choices[0].message.content;
  }
}
